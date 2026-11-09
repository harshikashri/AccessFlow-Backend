import mongoose from 'mongoose';
import Department from '../../models/Department.js';
import Organization from '../../models/Organization.js';
import User from '../../models/User.js';
import Role from '../../models/Role.js';
import UserRoleAssignment from '../../models/UserRoleAssignment.js';
import AuditLog from '../../models/AuditLog.js';
import { AppError } from '../../utils/AppError.js';
import { withTransaction } from '../../utils/transaction.js';
import { DEPARTMENT_ACTIONS } from './department.constants.js';
import { escapeRegex, getScopedDepartmentIds, toPublicDepartment, toPublicDepartmentUser } from './department.utils.js';

const writeAuditLog = async (session, { organizationId, actorId, action, departmentId, changes }) => {
	await AuditLog.create(
		[
			{
				organizationId,
				actorId,
				action,
				resourceType: 'Department',
				resourceId: departmentId,
				changes,
				timestamp: new Date(),
			},
		],
		{ session }
	);
};

const assertActiveOrganization = async (organizationId, session) => {
	const query = Organization.findById(organizationId).select('status');
	if (session) query.session(session);
	const organization = await query;
	if (!organization) {
		throw new AppError('Organization not found.', 404, 'ORGANIZATION_NOT_FOUND');
	}
	if (organization.status !== 'ACTIVE') {
		throw new AppError('This organization is inactive.', 403, 'ORGANIZATION_INACTIVE');
	}
	return organization;
};

const assertDepartmentAccess = (departmentId, organizationId, access, permission, session) => {
	const organizationAllowed = access?.organizationPermissions.has(permission) || false;
	const scopedIds = getScopedDepartmentIds(access, permission);
	const filter = { _id: departmentId, organizationId };
	if (!organizationAllowed) {
		if (!scopedIds.includes(String(departmentId))) {
			throw new AppError('You do not have access to this department.', 403, 'FORBIDDEN');
		}
		filter._id = { $in: scopedIds };
	}

	let query = Department.findOne({ ...filter, _id: departmentId });
	if (session) query = query.session(session);
	return query;
};

const getDepartmentForMutation = async ({ departmentId, organizationId, access, session }) => {
	const department = await assertDepartmentAccess(
		departmentId,
		organizationId,
		access,
		'departments.edit',
		session
	);
	if (!department) {
		throw new AppError('Department not found.', 404, 'DEPARTMENT_NOT_FOUND');
	}
	return department;
};

const assertDepartmentActive = (department) => {
	if (department.status !== 'ACTIVE') {
		throw new AppError('This department is inactive.', 403, 'DEPARTMENT_INACTIVE');
	}
};

const mapDuplicateError = (error) => {
	if (error?.code !== 11000) return error;
	const fields = Object.keys(error.keyPattern || error.keyValue || {});
	if (fields.includes('name') && fields.includes('organizationId')) {
		return new AppError(
			'A department with this name already exists in the organization.',
			409,
			'DEPARTMENT_NAME_EXISTS'
		);
	}
	return error;
};

const validateActiveOrganizationMemberships = async ({ userIds, organizationId, session }) => {
	const query = User.find({
		_id: { $in: userIds },
		accountStatus: 'ACTIVE',
		organizationMemberships: {
			$elemMatch: { organizationId, status: 'ACTIVE' },
		},
	}).select('name email accountStatus organizationMemberships');
	if (session) query.session(session);
	const users = await query;
	const usersById = new Map(users.map((user) => [String(user._id), user]));
	const unavailableIds = userIds.filter((id) => !usersById.has(String(id)));
	if (unavailableIds.length) {
		throw new AppError(
			'Every user must have an active account and membership in this organization.',
			400,
			'INVALID_ORGANIZATION_USERS',
			{ userIds: unavailableIds }
		);
	}
	return usersById;
};

const canManageDepartment = (assignment, departmentId, organizationId) => {
	const role = assignment.roleId;
	if (
		!role ||
		role.status !== 'ACTIVE' ||
		String(role.organizationId) !== String(organizationId) ||
		!(role.permissions || []).includes('departments.edit')
	) {
		return false;
	}
	if (assignment.scopeType === 'ORGANIZATION') {
		return assignment.departmentId == null;
	}
	return (
		assignment.scopeType === 'DEPARTMENT' &&
		String(assignment.departmentId) === String(departmentId)
	);
};

const assertManagerEligibility = async ({ userIds, departmentId, organizationId, session }) => {
	if (userIds.length === 0) return;
	const assignmentsQuery = UserRoleAssignment.find({
		userId: { $in: userIds },
		organizationId,
		status: 'ACTIVE',
		$or: [
			{ scopeType: 'ORGANIZATION', departmentId: null },
			{ scopeType: 'DEPARTMENT', departmentId },
		],
	}).populate({ path: 'roleId', select: 'organizationId status permissions' });
	if (session) assignmentsQuery.session(session);
	const assignments = await assignmentsQuery;
	const eligibleUserIds = new Set(
		assignments
			.filter((assignment) => canManageDepartment(assignment, departmentId, organizationId))
			.map((assignment) => String(assignment.userId))
	);
	const ineligibleIds = userIds.filter((id) => !eligibleUserIds.has(String(id)));
	if (ineligibleIds.length) {
		throw new AppError(
			'Each manager must have an active role assignment with departments.edit permission for this organization or department.',
			403,
			'MANAGER_NOT_ELIGIBLE',
			{ userIds: ineligibleIds }
		);
	}
};

const departmentCountsPipeline = (organizationId) => [
	{
		$lookup: {
			from: 'users',
			let: { departmentId: '$_id', scopedOrganizationId: '$organizationId' },
			pipeline: [
				{ $unwind: '$organizationMemberships' },
				{
					$match: {
						accountStatus: 'ACTIVE',
						$expr: {
							$and: [
								{ $eq: ['$organizationMemberships.organizationId', '$$scopedOrganizationId'] },
								{ $eq: ['$organizationMemberships.departmentId', '$$departmentId'] },
								{ $eq: ['$organizationMemberships.status', 'ACTIVE'] },
							],
						},
					},
				},
				{ $count: 'count' },
			],
			as: 'memberStats',
		},
	},
	{
		$addFields: {
			managerCount: { $size: { $ifNull: ['$managerIds', []] } },
			memberCount: { $ifNull: [{ $arrayElemAt: ['$memberStats.count', 0] }, 0] },
		},
	},
	{
		$project: {
			_id: 1,
			organizationId: 1,
			name: 1,
			description: 1,
			status: 1,
			createdAt: 1,
			updatedAt: 1,
			managerCount: 1,
			memberCount: 1,
		},
	},
];

export const createDepartment = async ({ organizationId, actorId, access, name, description }) => {
	try {
		return await withTransaction(async (session) => {
			await assertActiveOrganization(organizationId, session);
			const [department] = await Department.create(
				[{ organizationId, name, description, managerIds: [], status: 'ACTIVE' }],
				{ session }
			);
			await writeAuditLog(session, {
				organizationId,
				actorId,
				action: DEPARTMENT_ACTIONS.CREATED,
				departmentId: department._id,
				changes: { name, description, status: 'ACTIVE' },
			});
			return toPublicDepartment(department);
		});
	} catch (error) {
		throw mapDuplicateError(error);
	}
};

export const listDepartments = async ({ organizationId, access, page, limit, search, status, sortBy, sortOrder }) => {
	await assertActiveOrganization(organizationId);
	const filter = { organizationId: new mongoose.Types.ObjectId(organizationId) };
	if (status) filter.status = status;
	if (search) filter.name = { $regex: escapeRegex(search), $options: 'i' };

	const organizationCanView = access.organizationPermissions.has('departments.view');
	if (!organizationCanView) {
		const departmentIds = getScopedDepartmentIds(access, 'departments.view').map(
			(departmentId) => new mongoose.Types.ObjectId(departmentId)
		);
		filter._id = { $in: departmentIds };
	}

	const pipeline = [
		{ $match: filter },
		{
			$facet: {
				metadata: [{ $count: 'total' }],
				items: [
					{ $sort: { [sortBy]: sortOrder === 'asc' ? 1 : -1, _id: 1 } },
					{ $skip: (page - 1) * limit },
					{ $limit: limit },
					...departmentCountsPipeline(organizationId),
				],
			},
		},
	];
	const [result = { metadata: [], items: [] }] = await Department.aggregate(pipeline);
	const total = result.metadata[0]?.total || 0;
	const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

	return {
		items: result.items.map((department) =>
			toPublicDepartment(department, {
				managerCount: department.managerCount,
				memberCount: department.memberCount,
			})
		),
		pagination: {
			page,
			limit,
			total,
			totalPages,
			hasNextPage: page < totalPages,
			hasPreviousPage: page > 1,
		},
	};
};

export const getDepartmentById = async ({ departmentId, organizationId, access }) => {
	await assertActiveOrganization(organizationId);
	const department = await assertDepartmentAccess(
		departmentId,
		organizationId,
		access,
		'departments.view'
	);
	if (!department) {
		throw new AppError('Department not found.', 404, 'DEPARTMENT_NOT_FOUND');
	}

	const [managers, members] = await Promise.all([
		User.find({
			_id: { $in: department.managerIds },
			'organizationMemberships.organizationId': organizationId,
		})
			.select('name email accountStatus organizationMemberships')
			.lean(),
		User.find({
			accountStatus: 'ACTIVE',
			organizationMemberships: {
				$elemMatch: {
					organizationId,
					departmentId: department._id,
					status: 'ACTIVE',
				},
			},
		})
			.select('name email accountStatus organizationMemberships')
			.lean(),
	]);

	return {
		department: toPublicDepartment(department, {
			managerCount: department.managerIds.length,
			memberCount: members.length,
		}),
		managers: managers.map((user) => toPublicDepartmentUser(user, organizationId, department._id)),
		members: members.map((user) => toPublicDepartmentUser(user, organizationId, department._id)),
		summary: { managerCount: department.managerIds.length, memberCount: members.length },
	};
};

export const updateDepartment = async ({ departmentId, organizationId, actorId, access, input }) => {
	try {
		return await withTransaction(async (session) => {
			await assertActiveOrganization(organizationId, session);
			const department = await getDepartmentForMutation({
				departmentId,
				organizationId,
				access,
				session,
			});
			assertDepartmentActive(department);

			const changes = {};
			for (const [field, nextValue] of Object.entries(input)) {
				const previousValue = department[field];
				if (previousValue !== nextValue) {
					changes[field] = { from: previousValue, to: nextValue };
					department[field] = nextValue;
				}
			}
			if (Object.keys(changes).length === 0) return toPublicDepartment(department);

			await department.save({ session });
			await writeAuditLog(session, {
				organizationId,
				actorId,
				action: DEPARTMENT_ACTIONS.UPDATED,
				departmentId: department._id,
				changes,
			});
			return toPublicDepartment(department);
		});
	} catch (error) {
		throw mapDuplicateError(error);
	}
};

export const replaceDepartmentManagers = async ({ departmentId, organizationId, actorId, access, managerIds }) =>
	withTransaction(async (session) => {
		await assertActiveOrganization(organizationId, session);
		const department = await getDepartmentForMutation({
			departmentId,
			organizationId,
			access,
			session,
		});
		assertDepartmentActive(department);

		const normalizedIds = managerIds.map((id) => new mongoose.Types.ObjectId(id));
		await validateActiveOrganizationMemberships({
			userIds: normalizedIds,
			organizationId,
			session,
		});
		await assertManagerEligibility({
			userIds: normalizedIds,
			departmentId,
			organizationId,
			session,
		});

		const previousIds = department.managerIds.map(String);
		const nextIds = normalizedIds.map(String);
		const added = nextIds.filter((id) => !previousIds.includes(id));
		const removed = previousIds.filter((id) => !nextIds.includes(id));
		if (added.length === 0 && removed.length === 0) {
			return toPublicDepartment(department, { managerCount: nextIds.length });
		}

		department.managerIds = normalizedIds;
		await department.save({ session });
		for (const userId of added) {
			await writeAuditLog(session, {
				organizationId,
				actorId,
				action: DEPARTMENT_ACTIONS.MANAGER_ASSIGNED,
				departmentId: department._id,
				changes: { userId, managerIds: { from: previousIds, to: nextIds } },
			});
		}
		for (const userId of removed) {
			await writeAuditLog(session, {
				organizationId,
				actorId,
				action: DEPARTMENT_ACTIONS.MANAGER_REMOVED,
				departmentId: department._id,
				changes: { userId, managerIds: { from: previousIds, to: nextIds } },
			});
		}
		return toPublicDepartment(department, { managerCount: nextIds.length });
	});

export const addDepartmentMembers = async ({ departmentId, organizationId, actorId, access, userIds }) =>
	withTransaction(async (session) => {
		await assertActiveOrganization(organizationId, session);
		const department = await getDepartmentForMutation({
			departmentId,
			organizationId,
			access,
			session,
		});
		assertDepartmentActive(department);

		const usersById = await validateActiveOrganizationMemberships({
			userIds,
			organizationId,
			session,
		});

		for (const userId of userIds) {
			const user = usersById.get(String(userId));
			const membership = user.organizationMemberships.find(
				(item) => String(item.organizationId) === String(organizationId) && item.status === 'ACTIVE'
			);
			if (membership.departmentId) {
				throw new AppError(
					String(membership.departmentId) === String(departmentId)
						? 'The user is already assigned to this department.'
						: 'The user is already assigned to another department in this organization.',
					409,
					String(membership.departmentId) === String(departmentId)
						? 'MEMBER_ALREADY_ASSIGNED'
						: 'MEMBER_IN_ANOTHER_DEPARTMENT',
					{ userId: String(userId), departmentId: String(membership.departmentId) }
				);
			}
			membership.departmentId = department._id;
			await user.save({ session });
			await writeAuditLog(session, {
				organizationId,
				actorId,
				action: DEPARTMENT_ACTIONS.MEMBER_ADDED,
				departmentId: department._id,
				changes: { userId: String(userId), departmentId: String(department._id) },
			});
		}

		return { departmentId: String(department._id), addedUserIds: userIds.map(String) };
	});

export const removeDepartmentMember = async ({ departmentId, userId, organizationId, actorId, access }) =>
	withTransaction(async (session) => {
		await assertActiveOrganization(organizationId, session);
		const department = await getDepartmentForMutation({
			departmentId,
			organizationId,
			access,
			session,
		});
		assertDepartmentActive(department);

		const user = await User.findById(userId).session(session);
		if (!user) {
			throw new AppError('User not found.', 404, 'USER_NOT_FOUND');
		}
		const membership = user.organizationMemberships.find(
			(item) => String(item.organizationId) === String(organizationId)
		);
		if (!membership || membership.status !== 'ACTIVE') {
			throw new AppError('User does not have an active membership in this organization.', 404, 'USER_NOT_IN_ORGANIZATION');
		}
		if (String(membership.departmentId || '') !== String(department._id)) {
			throw new AppError('User is not assigned to this department.', 409, 'MEMBER_NOT_ASSIGNED');
		}

		membership.departmentId = null;
		await user.save({ session });
		await writeAuditLog(session, {
			organizationId,
			actorId,
			action: DEPARTMENT_ACTIONS.MEMBER_REMOVED,
			departmentId: department._id,
			changes: { userId: String(user._id), departmentId: String(department._id), toDepartmentId: null },
		});
		return { departmentId: String(department._id), userId: String(user._id), removed: true };
	});

export const setDepartmentStatus = async ({ departmentId, organizationId, actorId, access, status }) =>
	withTransaction(async (session) => {
		await assertActiveOrganization(organizationId, session);
		const department = await getDepartmentForMutation({
			departmentId,
			organizationId,
			access,
			session,
		});
		const previousStatus = department.status;
		if (previousStatus === status) return toPublicDepartment(department);

		department.status = status;
		await department.save({ session });
		await writeAuditLog(session, {
			organizationId,
			actorId,
			action: status === 'ACTIVE' ? DEPARTMENT_ACTIONS.ACTIVATED : DEPARTMENT_ACTIONS.DEACTIVATED,
			departmentId: department._id,
			changes: { status: { from: previousStatus, to: status } },
		});
		return toPublicDepartment(department, { managerCount: department.managerIds.length });
	});

export default {
	createDepartment,
	listDepartments,
	getDepartmentById,
	updateDepartment,
	replaceDepartmentManagers,
	addDepartmentMembers,
	removeDepartmentMember,
	setDepartmentStatus,
};

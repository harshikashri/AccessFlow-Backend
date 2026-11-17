import crypto from 'crypto';
import mongoose from 'mongoose';
import User from '../../models/User.js';
import Organization from '../../models/Organization.js';
import Department from '../../models/Department.js';
import Role from '../../models/Role.js';
import UserRoleAssignment from '../../models/UserRoleAssignment.js';
import ApprovalStep from '../../models/ApprovalStep.js';
import Request from '../../models/Request.js';
import Session from '../../models/Session.js';
import AuditLog from '../../models/AuditLog.js';
import { AppError } from '../../utils/AppError.js';
import { hashPassword } from '../../utils/password.js';
import { hashToken } from '../../utils/token.js';
import { withTransaction } from '../../utils/transaction.js';
import { ORGANIZATION_ADMIN_ROLE_NAME } from '../../config/constants.js';
import { REQUIRED_ADMIN_PERMISSIONS } from '../roles/role.constants.js';
import { sendInitialSetupInstructions, issueAccountSetupToken, issuePasswordResetToken } from '../auth/password-reset.service.js';
import { USER_SETUP_TOKEN_TTL_MS, USER_ACTIONS } from './user.constants.js';
import { escapeRegex, getScopedDepartmentIds, toPublicUser } from './user.utils.js';
import {
	getBuiltInRole,
	ensureEmployeeDepartmentAssignment,
	persistRoleAssignments,
	prepareRoleAssignments,
} from '../roles/role.assignment.service.js';

const writeAuditLog = async (session, { organizationId, actorId, action, userId, changes = {} }) => {
	await AuditLog.create(
		[{
			organizationId,
			actorId,
			action,
			resourceType: 'User',
			resourceId: userId,
			changes,
			timestamp: new Date(),
		}],
		{ session }
	);
};

const assertActiveOrganization = async (organizationId, session) => {
	const query = Organization.findById(organizationId).select('name status');
	if (session) query.session(session);
	const organization = await query;
	if (!organization) throw new AppError('Organization not found.', 404, 'ORGANIZATION_NOT_FOUND');
	if (organization.status !== 'ACTIVE') {
		throw new AppError('This organization is inactive.', 403, 'ORGANIZATION_INACTIVE');
	}
	return organization;
};

const getMembership = (user, organizationId) =>
	user.organizationMemberships.find((membership) => String(membership.organizationId) === String(organizationId));

const assertUserScope = (user, organizationId, access, permission) => {
	const membership = getMembership(user, organizationId);
	if (!membership) throw new AppError('User not found.', 404, 'USER_NOT_FOUND');
	if (access.organizationPermissions.has(permission)) return membership;
	const allowedDepartments = getScopedDepartmentIds(access, permission);
	if (!membership.departmentId || !allowedDepartments.includes(String(membership.departmentId))) {
		throw new AppError('User not found.', 404, 'USER_NOT_FOUND');
	}
	return membership;
};

const getDepartmentMemberDepartmentIds = (access) => {
	const assignments = access?.assignments || [];
	if (assignments.some(({ roleId }) => roleId?.roleType === 'CUSTOM')) return [];
	return [
		...new Set(
			assignments
				.filter(({ roleId, scopeType, departmentId }) =>
					roleId?.roleType === 'EMPLOYEE' && scopeType === 'DEPARTMENT' && departmentId
				)
				.map(({ departmentId }) => String(departmentId))
		),
	];
};

const emptyUserList = (page, limit) => ({
	users: [],
	pagination: { page, limit, total: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: page > 1 },
});

const assertDepartmentScope = (access, permission, departmentId) => {
	if (access.organizationPermissions.has(permission)) return true;
	if (departmentId && getScopedDepartmentIds(access, permission).includes(String(departmentId))) return true;
	throw new AppError('You do not have access to this department.', 403, 'FORBIDDEN');
};

const makePublicProfile = async (user, organizationId, membership, roleAssignments = []) => {
	let department = null;
	if (membership.departmentId) {
		department = await Department.findOne({ _id: membership.departmentId, organizationId })
			.select('name status')
			.lean();
	}
	const organization = await Organization.findById(organizationId).select('status').lean();
	return toPublicUser(
		user,
		{ ...membership.toObject?.() || membership, organizationStatus: organization?.status || null },
		department,
		roleAssignments
	);
};

const getRoleAssignments = async (userIds, organizationId) => {
	if (userIds.length === 0) return new Map();
	const assignments = await UserRoleAssignment.find({
		userId: { $in: userIds },
		organizationId,
		status: 'ACTIVE',
	})
		.populate({ path: 'roleId', select: 'name status roleType rolePurpose assignmentScope assignmentScopes' })
		.lean();
	const byUser = new Map();
	for (const assignment of assignments) {
		const key = String(assignment.userId);
		if (!byUser.has(key)) byUser.set(key, []);
		byUser.get(key).push(assignment);
	}
	return byUser;
};

const mapDuplicateError = (error) => {
	if (error?.code === 11000 && (error.keyPattern?.email || error.keyValue?.email)) {
		return new AppError('A user with this email already exists.', 409, 'EMAIL_EXISTS');
	}
	return error;
};

const getUserInOrganization = async ({ userId, organizationId, session }) => {
	let query = User.findOne({ _id: userId, 'organizationMemberships.organizationId': organizationId })
		.select('name email accountStatus passwordSetupRequired organizationMemberships approvalDelegations createdAt updatedAt');
	if (session) query = query.session(session);
	return query;
};

const ensureDepartmentIsActive = async ({ departmentId, organizationId, session }) => {
	if (!departmentId) return null;
	let query = Department.findOne({ _id: departmentId, organizationId, status: 'ACTIVE' }).select('_id');
	if (session) query = query.session(session);
	const department = await query;
	if (!department) {
		throw new AppError('Department must be active and belong to this organization.', 400, 'INVALID_DEPARTMENT');
	}
	return department;
};

export const createUser = async ({
	organizationId,
	actorId,
	access,
	input,
	includeDefaultMemberRole = true,
}) => {
	const rawSetupToken = crypto.randomBytes(32).toString('base64url');
	const setupTokenHash = hashToken(rawSetupToken);
	const setupTokenExpiresAt = new Date(Date.now() + USER_SETUP_TOKEN_TTL_MS);
	const placeholderPassword = `Aa1!${crypto.randomBytes(36).toString('base64url')}`;
	const placeholderHash = await hashPassword(placeholderPassword);

	let result;
	try {
		result = await withTransaction(async (session) => {
			const organization = await assertActiveOrganization(organizationId, session);
			await ensureDepartmentIsActive({ departmentId: input.departmentId, organizationId, session });
			let requestedAssignments = [...input.roleAssignments];
			if (input.departmentId && includeDefaultMemberRole) {
				const requestedRoleIds = requestedAssignments.map((assignment) => assignment.roleId);
				const managerRoleRequested = requestedRoleIds.length > 0 && await Role.exists({
					_id: { $in: requestedRoleIds },
					organizationId,
					roleType: 'DEPARTMENT_MANAGER',
				}).session(session);
				if (!managerRoleRequested) {
					const memberRole = await getBuiltInRole({ organizationId, roleType: 'EMPLOYEE', session });
					const alreadyRequested = requestedAssignments.some(
						(assignment) => String(assignment.roleId) === String(memberRole._id) &&
							assignment.scopeType === 'DEPARTMENT' &&
							String(assignment.departmentId) === String(input.departmentId)
					);
					if (!alreadyRequested) {
						requestedAssignments.push({
							roleId: memberRole._id,
							scopeType: 'DEPARTMENT',
							departmentId: input.departmentId,
						});
					}
				}
			}
			const roleAssignments = await prepareRoleAssignments({
				assignments: requestedAssignments,
				organizationId,
				access,
				session,
			});

			const [user] = await User.create(
				[{
					name: input.name,
					email: input.email,
					passwordHash: placeholderHash,
					passwordSetupRequired: true,
					passwordSetupTokenHash: setupTokenHash,
					passwordSetupTokenExpiresAt: setupTokenExpiresAt,
					accountStatus: 'INACTIVE',
					platformRole: null,
					organizationMemberships: [{
						membershipId: new mongoose.Types.ObjectId(),
						organizationId,
						departmentId: input.departmentId,
						status: 'ACTIVE',
					}],
				}],
				{ session }
			);

			if (roleAssignments.length) {
				await persistRoleAssignments({
					assignments: roleAssignments,
					userId: user._id,
					organizationId,
					actorId,
					session,
				});
			}

			await writeAuditLog(session, {
				organizationId,
				actorId,
				action: USER_ACTIONS.CREATED,
				userId: user._id,
				changes: {
					name: user.name,
					email: user.email,
					accountStatus: user.accountStatus,
					departmentId: input.departmentId ? String(input.departmentId) : null,
					passwordSetupRequired: true,
				},
			});
			for (const assignment of roleAssignments) {
				await writeAuditLog(session, {
					organizationId,
					actorId,
					action: USER_ACTIONS.ROLE_ASSIGNED,
					userId: user._id,
					changes: {
						roleId: String(assignment.roleId),
						departmentId: assignment.departmentId ? String(assignment.departmentId) : null,
						scopeType: assignment.scopeType,
					},
				});
			}

			return {
				user,
				membership: getMembership(user, organizationId),
				organizationName: organization.name,
			};
		});
	} catch (error) {
		throw mapDuplicateError(error);
	}

	try {
		await sendInitialSetupInstructions({
			user: result.user,
			organizationName: result.organizationName,
			token: rawSetupToken,
		});
	} catch {
		throw new AppError(
			'The user was created but the setup email could not be delivered. Retry through the admin password-reset endpoint.',
			502,
			'USER_CREATED_EMAIL_FAILED',
			{ userId: String(result.user._id) }
		);
	}

	const profile = await makePublicProfile(result.user, organizationId, result.membership);
	return { ...profile, passwordSetupRequired: true };
};

export const getUserById = async ({ userId, organizationId, access }) => {
	await assertActiveOrganization(organizationId);
	if (getDepartmentMemberDepartmentIds(access).length) {
		throw new AppError('User not found.', 404, 'USER_NOT_FOUND');
	}
	const user = await getUserInOrganization({ userId, organizationId });
	if (!user) throw new AppError('User not found.', 404, 'USER_NOT_FOUND');
	const membership = assertUserScope(user, organizationId, access, 'users.view');
	const assignments = await getRoleAssignments([user._id], organizationId);
	return makePublicProfile(user, organizationId, membership, assignments.get(String(user._id)) || []);
};

export const listUsers = async ({ organizationId, access, page, limit, search, status, departmentId, roleId, sortBy, sortOrder }) => {
	await assertActiveOrganization(organizationId);
	const organizationObjectId = new mongoose.Types.ObjectId(organizationId);
	const membershipFilter = { organizationId: organizationObjectId };
	const requestedDepartmentId = departmentId === null ? null : departmentId ? new mongoose.Types.ObjectId(departmentId) : undefined;

	const organizationCanView = access.organizationPermissions.has('users.view');
	const scopedIds = getScopedDepartmentIds(access, 'users.view');
	const departmentMemberDepartmentIds = getDepartmentMemberDepartmentIds(access);
	const departmentMemberAccess = departmentMemberDepartmentIds.length > 0;
	let organizationRoleIds = [];
	let organizationRoleUserIds = [];
	let roleOptions = [];

	if (departmentMemberAccess) {
		if (
			requestedDepartmentId &&
			!departmentMemberDepartmentIds.includes(String(requestedDepartmentId))
		) {
			return emptyUserList(page, limit);
		}

		organizationRoleIds = await Role.find({
			organizationId: organizationObjectId,
			status: 'ACTIVE',
			$or: [
				{ roleType: 'ORGANIZATION_ADMIN' },
				{ name: ORGANIZATION_ADMIN_ROLE_NAME },
				{ roleType: 'CUSTOM' },
			],
		}).distinct('_id');
		if (organizationRoleIds.length) {
			organizationRoleUserIds = await UserRoleAssignment.distinct('userId', {
				organizationId: organizationObjectId,
				roleId: { $in: organizationRoleIds },
				scopeType: 'ORGANIZATION',
				departmentId: null,
				status: 'ACTIVE',
			});
		}
		const departmentMemberUserIds = await User.distinct('_id', {
			platformRole: { $ne: 'SUPER_ADMIN' },
			organizationMemberships: {
				$elemMatch: {
					organizationId: organizationObjectId,
					status: 'ACTIVE',
					departmentId: {
						$in: departmentMemberDepartmentIds.map((id) => new mongoose.Types.ObjectId(id)),
					},
				},
			},
		});
		const [departmentRoleIds, assignedOrganizationRoleIds] = await Promise.all([
			departmentMemberUserIds.length
				? UserRoleAssignment.distinct('roleId', {
						organizationId: organizationObjectId,
						userId: { $in: departmentMemberUserIds },
						scopeType: 'DEPARTMENT',
						departmentId: {
							$in: departmentMemberDepartmentIds.map((id) => new mongoose.Types.ObjectId(id)),
						},
						status: 'ACTIVE',
					})
				: [],
			organizationRoleUserIds.length
				? UserRoleAssignment.distinct('roleId', {
						organizationId: organizationObjectId,
						userId: { $in: organizationRoleUserIds },
						roleId: { $in: organizationRoleIds },
						scopeType: 'ORGANIZATION',
						departmentId: null,
						status: 'ACTIVE',
					})
				: [],
		]);
		const roleIds = [...new Set([...departmentRoleIds, ...assignedOrganizationRoleIds].map(String))]
			.map((id) => new mongoose.Types.ObjectId(id));
		if (roleIds.length) {
			roleOptions = await Role.find({
				_id: { $in: roleIds },
				organizationId: organizationObjectId,
				status: 'ACTIVE',
			})
				.select('_id name')
				.sort({ name: 1 })
				.lean()
				.then((roles) => roles.map((role) => ({ id: String(role._id), name: role.name })));
		}
	} else if (!organizationCanView) {
		if (requestedDepartmentId === null || (requestedDepartmentId && !scopedIds.includes(String(requestedDepartmentId)))) {
			return emptyUserList(page, limit);
		}
		membershipFilter.departmentId = { $in: scopedIds.map((id) => new mongoose.Types.ObjectId(id)) };
	}
	if (departmentId !== undefined) membershipFilter.departmentId = requestedDepartmentId;

	const match = departmentMemberAccess
		? {
				$and: [
					{ platformRole: { $ne: 'SUPER_ADMIN' } },
					{
						$or: [
							{
								organizationMemberships: {
									$elemMatch: {
										organizationId: organizationObjectId,
										status: 'ACTIVE',
										departmentId:
											requestedDepartmentId === null
												? { $in: [] }
												: requestedDepartmentId || {
														$in: departmentMemberDepartmentIds.map(
															(id) => new mongoose.Types.ObjectId(id)
														),
													},
									},
								},
							},
							...(organizationRoleUserIds.length
								? [
										{
											_id: { $in: organizationRoleUserIds },
											organizationMemberships: {
												$elemMatch: {
													organizationId: organizationObjectId,
													status: 'ACTIVE',
													...(departmentId !== undefined
														? { departmentId: requestedDepartmentId }
														: {}),
												},
											},
										},
									]
								: []),
						],
					},
				],
			}
		: { organizationMemberships: { $elemMatch: membershipFilter } };
	if (status) match.accountStatus = status;
	if (search) {
		const expression = { $regex: escapeRegex(search), $options: 'i' };
		if (departmentMemberAccess) {
			match.$and.push({ $or: [{ name: expression }, { email: expression }] });
		} else {
			match.$or = [{ name: expression }, { email: expression }];
		}
	}

	const pipeline = [{ $match: match }];
	if (roleId) {
		const permittedScopeMatch = departmentMemberAccess
			? {
					$or: [
						{
							$and: [
								{ $eq: ['$scopeType', 'DEPARTMENT'] },
								{
									$in: [
										'$departmentId',
										departmentMemberDepartmentIds.map(
											(id) => new mongoose.Types.ObjectId(id)
										),
									],
								},
							],
						},
						{
							$and: [
								{ $eq: ['$scopeType', 'ORGANIZATION'] },
								{ $in: ['$roleId', organizationRoleIds] },
							],
						},
					],
				}
			: null;
		pipeline.push(
			{
				$lookup: {
					from: 'userRoleAssignments',
					let: { targetUserId: '$_id' },
					pipeline: [{
						$match: {
							$expr: {
								$and: [
									{ $eq: ['$userId', '$$targetUserId'] },
									{ $eq: ['$organizationId', organizationObjectId] },
									{ $eq: ['$roleId', new mongoose.Types.ObjectId(roleId)] },
									{ $eq: ['$status', 'ACTIVE'] },
									...(permittedScopeMatch ? [permittedScopeMatch] : []),
								],
							},
						},
					}, { $limit: 1 }],
					as: 'matchingRoleAssignment',
				},
			},
			{ $match: { 'matchingRoleAssignment.0': { $exists: true } } }
		);
	}

	pipeline.push({
		$facet: {
			metadata: [{ $count: 'total' }],
			users: [
				{ $sort: { [sortBy]: sortOrder === 'asc' ? 1 : -1, _id: 1 } },
				{ $skip: (page - 1) * limit },
				{ $limit: limit },
				{
					$addFields: {
						membership: {
							$first: {
								$filter: {
									input: '$organizationMemberships',
									as: 'membership',
									cond: { $eq: ['$$membership.organizationId', organizationObjectId] },
								},
							},
						},
					},
				},
				{ $project: { _id: 1, name: 1, email: 1, accountStatus: 1, passwordSetupRequired: 1, createdAt: 1, updatedAt: 1, membership: 1 } },
			],
		},
	});

	const [result = { metadata: [], users: [] }] = await User.aggregate(pipeline);
	const total = result.metadata[0]?.total || 0;
	const userIds = result.users.map((user) => user._id);
	const roleAssignments = await getRoleAssignments(userIds, organizationObjectId);
	const users = await Promise.all(result.users.map(async (user) => {
		const assignments = roleAssignments.get(String(user._id)) || [];
		const visibleAssignments = departmentMemberAccess
			? assignments.filter((assignment) =>
					(assignment.scopeType === 'DEPARTMENT' &&
						departmentMemberDepartmentIds.includes(String(assignment.departmentId))) ||
					(assignment.scopeType === 'ORGANIZATION' &&
						!assignment.departmentId &&
						organizationRoleIds.some(
							(roleId) => String(roleId) === String(assignment.roleId?._id || assignment.roleId)
						))
				)
			: assignments;
		const profile = await makePublicProfile(
			user,
			organizationId,
			user.membership,
			visibleAssignments
		);
		return { ...profile, passwordSetupRequired: user.passwordSetupRequired };
	}));
	const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
	const response = {
		users,
		pagination: {
			page,
			limit,
			total,
			totalPages,
			hasNextPage: page < totalPages,
			hasPreviousPage: page > 1,
		},
	};
	if (departmentMemberAccess) response.roleOptions = roleOptions;
	return response;
};

export const updateUser = async ({ userId, organizationId, actorId, access, input }) => {
	try {
		return await withTransaction(async (session) => {
			await assertActiveOrganization(organizationId, session);
			const user = await getUserInOrganization({ userId, organizationId, session });
			if (!user) throw new AppError('User not found.', 404, 'USER_NOT_FOUND');
			const membership = assertUserScope(user, organizationId, access, 'users.edit');
			const changes = {};
			for (const [field, nextValue] of Object.entries(input)) {
				const previousValue = user[field];
				if (previousValue !== nextValue) {
					changes[field] = { from: previousValue, to: nextValue };
					user[field] = nextValue;
				}
			}
			if (Object.keys(changes).length === 0) return makePublicProfile(user, organizationId, membership);
			await user.save({ session });
			await writeAuditLog(session, { organizationId, actorId, action: USER_ACTIONS.UPDATED, userId: user._id, changes });
			if (changes.email) {
				await Session.updateMany(
					{ userId: user._id, revokedAt: null },
					{ $set: { revokedAt: new Date() } },
					{ session }
				);
			}
			return makePublicProfile(user, organizationId, membership);
		});
	} catch (error) {
		throw mapDuplicateError(error);
	}
};

export const assignUserDepartment = async ({ userId, organizationId, actorId, access, departmentId }) =>
	withTransaction(async (session) => {
		await assertActiveOrganization(organizationId, session);
		const user = await getUserInOrganization({ userId, organizationId, session });
		if (!user) throw new AppError('User not found.', 404, 'USER_NOT_FOUND');
		const membership = assertUserScope(user, organizationId, access, 'users.edit');
		if (membership.status !== 'ACTIVE') {
			throw new AppError('User membership in this organization is inactive.', 403, 'MEMBERSHIP_INACTIVE');
		}

		const previousDepartmentId = membership.departmentId ? String(membership.departmentId) : null;
		const nextDepartmentId = departmentId ? String(departmentId) : null;
		if (previousDepartmentId === nextDepartmentId) {
			return makePublicProfile(user, organizationId, membership);
		}
		if (previousDepartmentId) assertDepartmentScope(access, 'users.edit', previousDepartmentId);
		if (nextDepartmentId) assertDepartmentScope(access, 'users.edit', nextDepartmentId);
		await ensureDepartmentIsActive({ departmentId, organizationId, session });

		membership.departmentId = departmentId;
		await user.save({ session });
		const memberRole = await getBuiltInRole({ organizationId, roleType: 'EMPLOYEE', session });
		if (previousDepartmentId) {
			const previousAssignment = await UserRoleAssignment.findOne({
				userId: user._id,
				organizationId,
				roleId: memberRole._id,
				scopeType: 'DEPARTMENT',
				departmentId: previousDepartmentId,
				status: 'ACTIVE',
			}).session(session);
			if (previousAssignment) {
				previousAssignment.status = 'INACTIVE';
				await previousAssignment.save({ session });
			}
		}
		if (departmentId) {
			await ensureEmployeeDepartmentAssignment({
				userId: user._id,
				organizationId,
				departmentId,
				role: memberRole,
				actorId,
				access,
				session,
			});
		}
		await writeAuditLog(session, {
			organizationId,
			actorId,
			action: departmentId ? USER_ACTIONS.DEPARTMENT_ASSIGNED : USER_ACTIONS.DEPARTMENT_REMOVED,
			userId: user._id,
			changes: { departmentId: { from: previousDepartmentId, to: nextDepartmentId } },
		});
		return makePublicProfile(user, organizationId, membership);
	});

const getOrganizationAdminRoleIds = async ({ organizationId, session }) => {
	const roleQuery = Role.find({ organizationId, status: 'ACTIVE' }).select('_id name roleType permissions');
	if (session) roleQuery.session(session);
	const roles = await roleQuery;
	return roles
		.filter((role) =>
			(role.roleType === 'ORGANIZATION_ADMIN' || role.name === ORGANIZATION_ADMIN_ROLE_NAME) &&
			REQUIRED_ADMIN_PERMISSIONS.every((permission) => (role.permissions || []).includes(permission))
		)
		.map((role) => role._id);
};

const countActiveOrganizationAdmins = async ({ organizationId, session }) => {
	const adminRoleIds = await getOrganizationAdminRoleIds({ organizationId, session });
	if (adminRoleIds.length === 0) return 0;

	const assignmentQuery = UserRoleAssignment.find({
		organizationId,
		roleId: { $in: adminRoleIds },
		scopeType: 'ORGANIZATION',
		departmentId: null,
		status: 'ACTIVE',
	}).distinct('userId');
	if (session) assignmentQuery.session(session);
	const userIds = await assignmentQuery;
	const countQuery = User.countDocuments({
		_id: { $in: userIds },
		accountStatus: 'ACTIVE',
		organizationMemberships: { $elemMatch: { organizationId, status: 'ACTIVE' } },
	});
	if (session) countQuery.session(session);
	return countQuery;
};

const assertNoPendingApprovalResponsibilities = async ({ user, organizationId, session }) => {
	const pendingStatuses = ['PENDING', 'ACTIVE', 'CLAIMED'];
	const now = new Date();
	const activeDelegation = user.approvalDelegations?.some((delegation) =>
		String(delegation.organizationId) === String(organizationId) &&
		delegation.status === 'ACTIVE' &&
		new Date(delegation.endsAt) > now
	);
	if (activeDelegation) {
		throw new AppError(
			'Active approval delegations must be revoked before this user can be deactivated.',
			409,
			'ACTIVE_APPROVAL_DELEGATION'
		);
	}

	const delegateQuery = User.exists({
		approvalDelegations: {
			$elemMatch: {
				organizationId,
				delegateId: user._id,
				status: 'ACTIVE',
				endsAt: { $gt: now },
			},
		},
	});
	const directResponsibilityQuery = ApprovalStep.exists({
		organizationId,
		status: { $in: pendingStatuses },
		$or: [{ approverId: user._id }, { claimedBy: user._id }],
	});
	const [isActiveDelegate, hasDirectResponsibility] = await Promise.all([
		session ? delegateQuery.session(session) : delegateQuery,
		session ? directResponsibilityQuery.session(session) : directResponsibilityQuery,
	]);
	if (isActiveDelegate) {
		throw new AppError(
			'Active approval delegations naming this user must be revoked before deactivation.',
			409,
			'ACTIVE_APPROVAL_DELEGATION'
		);
	}
	if (hasDirectResponsibility) {
		throw new AppError(
			'Pending or claimed approval responsibilities must be reassigned before this user can be deactivated.',
			409,
			'PENDING_APPROVAL_RESPONSIBILITY'
		);
	}

	const assignmentQuery = UserRoleAssignment.find({
		userId: user._id,
		organizationId,
		status: 'ACTIVE',
	}).distinct('roleId');
	if (session) assignmentQuery.session(session);
	const roleIds = (await assignmentQuery).map(String);
	const adminRoleIds = await getOrganizationAdminRoleIds({ organizationId, session });
	const hasOrganizationAdminAssignment = roleIds.some((roleId) =>
		adminRoleIds.some((adminRoleId) => String(adminRoleId) === roleId)
	);
	const roleObjectIds = [...new Set(roleIds)].map((roleId) => new mongoose.Types.ObjectId(roleId));
	const indirectConditions = [];
	if (roleObjectIds.length) indirectConditions.push({ approverType: 'ROLE', roleId: { $in: roleObjectIds } });
	if (hasOrganizationAdminAssignment) indirectConditions.push({ approverType: 'ORGANIZATION_ADMIN' });
	const indirectRoleResponsibility = indirectConditions.length
		? ApprovalStep.exists({
			organizationId,
			status: { $in: pendingStatuses },
			$or: indirectConditions,
		})
		: Promise.resolve(false);

	const memberships = user.organizationMemberships.filter(
		(membership) => String(membership.organizationId) === String(organizationId)
	);
	const departmentIds = memberships.map((membership) => membership.departmentId).filter(Boolean);
	const managerDepartmentsQuery = Department.find({
		organizationId,
		managerIds: user._id,
		status: 'ACTIVE',
	}).distinct('_id');
	if (session) managerDepartmentsQuery.session(session);
	const managerDepartmentIds = await managerDepartmentsQuery;
	const allDepartmentIds = [...new Set([...departmentIds, ...managerDepartmentIds].map(String))]
		.map((departmentId) => new mongoose.Types.ObjectId(departmentId));
	let managerResponsibility = Promise.resolve(false);
	if (allDepartmentIds.length) {
		const requestsQuery = Request.find({
			organizationId,
			status: 'PENDING_APPROVAL',
			departmentId: { $in: allDepartmentIds },
		}).distinct('_id');
		if (session) requestsQuery.session(session);
		const requestIds = await requestsQuery;
		if (requestIds.length) {
			managerResponsibility = ApprovalStep.exists({
				organizationId,
				requestId: { $in: requestIds },
				approverType: 'DEPARTMENT_MANAGER',
				status: { $in: pendingStatuses },
			});
		}
	}
	const [hasRoleResponsibility, hasManagerResponsibility] = await Promise.all([
		session ? indirectRoleResponsibility.session?.(session) || indirectRoleResponsibility : indirectRoleResponsibility,
		session ? managerResponsibility.session?.(session) || managerResponsibility : managerResponsibility,
	]);
	if (hasRoleResponsibility || hasManagerResponsibility) {
		throw new AppError(
			'Pending workflow approvals depend on this user or their current role; reassign them before deactivation.',
			409,
			'PENDING_APPROVAL_RESPONSIBILITY'
		);
	}
};

export const activateUser = async ({
	userId,
	organizationId,
	actorId,
	access,
	returnOutcome = false,
}) =>
	withTransaction(async (session) => {
		await assertActiveOrganization(organizationId, session);
		const user = await getUserInOrganization({ userId, organizationId, session });
		if (!user) throw new AppError('User not found.', 404, 'USER_NOT_FOUND');
		const membership = assertUserScope(user, organizationId, access, 'users.deactivate');
		if (membership.status === 'ACTIVE') {
			const profile = await makePublicProfile(user, organizationId, membership);
			return returnOutcome ? { profile, changed: false } : profile;
		}

		membership.status = 'ACTIVE';
		await user.save({ session });
		await writeAuditLog(session, {
			organizationId,
			actorId,
			action: USER_ACTIONS.ACTIVATED,
			userId: user._id,
			changes: { membershipStatus: { from: 'INACTIVE', to: 'ACTIVE' } },
		});
		const profile = await makePublicProfile(user, organizationId, membership);
		return returnOutcome ? { profile, changed: true } : profile;
	});

export const deactivateUser = async ({ userId, organizationId, actorId, access, returnOutcome = false }) =>
	withTransaction(async (session) => {
		await assertActiveOrganization(organizationId, session);
		if (String(userId) === String(actorId)) {
			throw new AppError('You cannot deactivate your own organization membership.', 403, 'SELF_DEACTIVATION_FORBIDDEN');
		}
		const user = await getUserInOrganization({ userId, organizationId, session });
		if (!user) throw new AppError('User not found.', 404, 'USER_NOT_FOUND');
		const membership = assertUserScope(user, organizationId, access, 'users.deactivate');
		if (membership.status === 'INACTIVE') {
			const profile = await makePublicProfile(user, organizationId, membership);
			return returnOutcome ? { profile, changed: false } : profile;
		}

		const organizationWrite = await Organization.updateOne(
			{ _id: organizationId, status: 'ACTIVE' },
			{ $inc: { __v: 1 } },
			{ session }
		);
		if (organizationWrite.matchedCount !== 1) {
			throw new AppError('This organization is inactive.', 403, 'ORGANIZATION_INACTIVE');
		}

		await assertNoPendingApprovalResponsibilities({ user, organizationId, session });

		const organizationAdminRoleIds = await getOrganizationAdminRoleIds({ organizationId, session });
		if (organizationAdminRoleIds.length) {
			const isOrganizationAdmin = await UserRoleAssignment.exists({
				userId: user._id,
				roleId: { $in: organizationAdminRoleIds },
				organizationId,
				scopeType: 'ORGANIZATION',
				departmentId: null,
				status: 'ACTIVE',
			}).session(session);
			if (isOrganizationAdmin && await countActiveOrganizationAdmins({ organizationId, session }) <= 1) {
				throw new AppError('The last active Organization Admin cannot be deactivated.', 409, 'LAST_ORGANIZATION_ADMIN');
			}
		}

		const previousStatus = membership.status;
		membership.status = 'INACTIVE';
		await user.save({ session });
		await Session.updateMany(
			{ userId: user._id, organizationId, revokedAt: null },
			{ $set: { revokedAt: new Date() } },
			{ session }
		);
		await writeAuditLog(session, {
			organizationId,
			actorId,
			action: USER_ACTIONS.DEACTIVATED,
			userId: user._id,
			changes: { membershipStatus: { from: previousStatus, to: 'INACTIVE' }, sessionsRevokedForOrganization: true },
		});
		const profile = await makePublicProfile(user, organizationId, membership);
		return returnOutcome ? { profile, changed: true } : profile;
	});

export const initiateAdminPasswordReset = async ({ userId, organizationId, actorId, access }) => {
	await assertActiveOrganization(organizationId);
	const user = await getUserInOrganization({ userId, organizationId });
	if (!user) throw new AppError('User not found.', 404, 'USER_NOT_FOUND');
	assertUserScope(user, organizationId, access, 'users.edit');

	if (user.passwordSetupRequired) {
		return issueAccountSetupToken({ userId, organizationId, actorId });
	}
	return issuePasswordResetToken({ userId, organizationId, actorId });
};

export default {
	createUser,
	getUserById,
	listUsers,
	updateUser,
	assignUserDepartment,
	activateUser,
	deactivateUser,
	initiateAdminPasswordReset,
};

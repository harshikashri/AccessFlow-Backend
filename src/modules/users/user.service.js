import crypto from 'crypto';
import mongoose from 'mongoose';
import User from '../../models/User.js';
import Organization from '../../models/Organization.js';
import Department from '../../models/Department.js';
import Role from '../../models/Role.js';
import UserRoleAssignment from '../../models/UserRoleAssignment.js';
import Session from '../../models/Session.js';
import AuditLog from '../../models/AuditLog.js';
import { AppError } from '../../utils/AppError.js';
import { hashPassword } from '../../utils/password.js';
import { hashToken } from '../../utils/token.js';
import { withTransaction } from '../../utils/transaction.js';
import { ORGANIZATION_ADMIN_ROLE_NAME } from '../../config/constants.js';
import { sendInitialSetupInstructions, issueAccountSetupToken, issuePasswordResetToken } from '../auth/password-reset.service.js';
import { USER_SETUP_TOKEN_TTL_MS, USER_ACTIONS } from './user.constants.js';
import { escapeRegex, getScopedDepartmentIds, toPublicUser } from './user.utils.js';
import { getBuiltInRole, persistRoleAssignments, prepareRoleAssignments } from '../roles/role.assignment.service.js';

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
		.populate({ path: 'roleId', select: 'name status' })
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
		.select('name email accountStatus passwordSetupRequired organizationMemberships createdAt updatedAt');
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

export const createUser = async ({ organizationId, actorId, access, input }) => {
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
			if (input.departmentId) {
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
	if (!organizationCanView) {
		if (requestedDepartmentId === null || (requestedDepartmentId && !scopedIds.includes(String(requestedDepartmentId)))) {
			return {
				users: [],
				pagination: { page, limit, total: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: page > 1 },
			};
		}
		membershipFilter.departmentId = { $in: scopedIds.map((id) => new mongoose.Types.ObjectId(id)) };
	}
	if (departmentId !== undefined) membershipFilter.departmentId = requestedDepartmentId;

	const match = { organizationMemberships: { $elemMatch: membershipFilter } };
	if (status) match.accountStatus = status;
	if (search) {
		const expression = { $regex: escapeRegex(search), $options: 'i' };
		match.$or = [{ name: expression }, { email: expression }];
	}

	const pipeline = [{ $match: match }];
	if (roleId) {
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
		const profile = await makePublicProfile(
			user,
			organizationId,
			user.membership,
			roleAssignments.get(String(user._id)) || []
		);
		return { ...profile, passwordSetupRequired: user.passwordSetupRequired };
	}));
	const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
	return {
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
			const prepared = await prepareRoleAssignments({
				assignments: [{ roleId: memberRole._id, scopeType: 'DEPARTMENT', departmentId }],
				organizationId,
				access,
				session,
				userId: user._id,
			});
			await persistRoleAssignments({
				assignments: prepared,
				userId: user._id,
				organizationId,
				actorId,
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
	const roleQuery = Role.find({ organizationId }).select('_id name roleType');
	if (session) roleQuery.session(session);
	const roles = await roleQuery;
	return roles
		.filter((role) => role.roleType === 'ORGANIZATION_ADMIN' || role.name === ORGANIZATION_ADMIN_ROLE_NAME)
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

export const activateUser = async ({ userId, organizationId, actorId, access }) =>
	withTransaction(async (session) => {
		await assertActiveOrganization(organizationId, session);
		const user = await getUserInOrganization({ userId, organizationId, session });
		if (!user) throw new AppError('User not found.', 404, 'USER_NOT_FOUND');
		const membership = assertUserScope(user, organizationId, access, 'users.deactivate');
		if (user.passwordSetupRequired) {
			throw new AppError('User must complete password setup before activation.', 409, 'PASSWORD_SETUP_REQUIRED');
		}
		if (user.accountStatus !== 'ACTIVE') {
			throw new AppError('The global account is inactive and cannot be activated by an organization.', 403, 'ACCOUNT_INACTIVE');
		}
		if (membership.status === 'ACTIVE') return makePublicProfile(user, organizationId, membership);

		membership.status = 'ACTIVE';
		await user.save({ session });
		await writeAuditLog(session, {
			organizationId,
			actorId,
			action: USER_ACTIONS.ACTIVATED,
			userId: user._id,
			changes: { membershipStatus: { from: 'INACTIVE', to: 'ACTIVE' } },
		});
		return makePublicProfile(user, organizationId, membership);
	});

export const deactivateUser = async ({ userId, organizationId, actorId, access }) =>
	withTransaction(async (session) => {
		await assertActiveOrganization(organizationId, session);
		if (String(userId) === String(actorId)) {
			throw new AppError('You cannot deactivate your own organization membership.', 403, 'SELF_DEACTIVATION_FORBIDDEN');
		}
		const user = await getUserInOrganization({ userId, organizationId, session });
		if (!user) throw new AppError('User not found.', 404, 'USER_NOT_FOUND');
		const membership = assertUserScope(user, organizationId, access, 'users.deactivate');
		if (membership.status === 'INACTIVE') return makePublicProfile(user, organizationId, membership);

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
		return makePublicProfile(user, organizationId, membership);
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

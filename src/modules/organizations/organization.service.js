import mongoose from 'mongoose';
import Organization from '../../models/Organization.js';
import User from '../../models/User.js';
import Role from '../../models/Role.js';
import UserRoleAssignment from '../../models/UserRoleAssignment.js';
import AuditLog from '../../models/AuditLog.js';
import Department from '../../models/Department.js';
import { AppError } from '../../utils/AppError.js';
import { hashPassword } from '../../utils/password.js';
import { withTransaction } from '../../utils/transaction.js';
import {
  AUDIT_ACTIONS,
  AUDIT_RESOURCE_TYPES,
  ORGANIZATION_ADMIN_PERMISSIONS,
  ORGANIZATION_ADMIN_ROLE_NAME,
  DEPARTMENT_MANAGER_PERMISSIONS,
  DEPARTMENT_MANAGER_ROLE_NAME,
  DEPARTMENT_MEMBER_PERMISSIONS,
  DEPARTMENT_MEMBER_ROLE_NAME,
} from '../../config/constants.js';
import { escapeRegex, toPublicAdminUser, toPublicOrganization } from './organization.utils.js';
import WorkflowDefinition from '../../models/WorkflowDefinition.js';
import { DEFAULT_REQUEST_TYPES } from '../requests/requestType.defaults.js';
import { initializeDefaultApprovalWorkflow } from '../requests/approvalWorkflow.service.js';

const writeAuditLog = async (session, payload) => {
  await AuditLog.create(
    [
      {
        organizationId: payload.organizationId,
        actorId: payload.actorId,
        action: payload.action,
        resourceType: payload.resourceType,
        resourceId: payload.resourceId,
        changes: payload.changes || {},
        timestamp: new Date(),
      },
    ],
    { session }
  );
};

const ensureBuiltInRole = async ({ session, organizationId, actorId, name, roleType, permissions, description }) => {
  const existing = await Role.findOne({ organizationId, roleType }).session(session);
  if (existing) return existing;
  const [role] = await Role.create([{
    organizationId,
    name,
    roleType,
    description,
    permissions,
    status: 'ACTIVE',
    createdBy: actorId,
  }], { session });
  return role;
};

const ensureDefaultRequestTypes = async ({ session, organizationId, actorId }) => {
  for (const definition of DEFAULT_REQUEST_TYPES) {
    const existing = await WorkflowDefinition.findOne({
      organizationId,
      definitionType: 'REQUEST_TYPE',
      codeNormalized: definition.code.toLocaleLowerCase('en-US'),
    }).session(session);
    if (existing) continue;
    await WorkflowDefinition.create([{
      ...definition,
      definitionType: 'REQUEST_TYPE',
      organizationId,
      codeNormalized: definition.code.toLocaleLowerCase('en-US'),
      stages: [],
      version: 1,
      isActive: true,
      createdBy: actorId,
      updatedBy: actorId,
    }], { session });
  }
};

const throwDuplicateError = (error) => {
  if (error?.code !== 11000) {
    return error;
  }

  const fields = Object.keys(error.keyPattern || error.keyValue || {});
  if (fields.includes('email')) {
    return new AppError('A user with this email already exists.', 409, 'EMAIL_EXISTS');
  }
  if (fields.length === 1 && fields[0] === 'name') {
    return new AppError(
      'An organization with this name already exists.',
      409,
      'ORGANIZATION_NAME_EXISTS'
    );
  }
  return new AppError('A record with the same unique value already exists.', 409, 'DUPLICATE_KEY');
};

export const createOrganization = async ({ name, admin, actorId }) => {
  try {
    return await withTransaction(async (session) => {
      const [organization] = await Organization.create(
        [
          {
            name,
            status: 'ACTIVE',
            createdBy: actorId,
          },
        ],
        { session }
      );

      const passwordHash = await hashPassword(admin.password);

      const [adminUser] = await User.create(
        [
          {
            name: admin.name,
            email: admin.email,
            passwordHash,
            accountStatus: 'ACTIVE',
            platformRole: null,
            organizationMemberships: [
              {
                membershipId: new mongoose.Types.ObjectId(),
                organizationId: organization._id,
                departmentId: null,
                status: 'ACTIVE',
              },
            ],
          },
        ],
        { session }
      );

      const adminRole = await ensureBuiltInRole({
        session, organizationId: organization._id, actorId,
        name: ORGANIZATION_ADMIN_ROLE_NAME, roleType: 'ORGANIZATION_ADMIN',
        permissions: ORGANIZATION_ADMIN_PERMISSIONS,
        description: 'Default organization administrator role.',
      });
      await ensureBuiltInRole({
        session, organizationId: organization._id, actorId,
        name: DEPARTMENT_MANAGER_ROLE_NAME, roleType: 'DEPARTMENT_MANAGER',
        permissions: DEPARTMENT_MANAGER_PERMISSIONS,
        description: 'Default department manager role.',
      });
      await ensureBuiltInRole({
        session, organizationId: organization._id, actorId,
        name: DEPARTMENT_MEMBER_ROLE_NAME, roleType: 'EMPLOYEE',
        permissions: DEPARTMENT_MEMBER_PERMISSIONS,
        description: 'Default department member role.',
      });

      await UserRoleAssignment.create(
        [
          {
            userId: adminUser._id,
            roleId: adminRole._id,
            organizationId: organization._id,
            departmentId: null,
            scopeType: 'ORGANIZATION',
            status: 'ACTIVE',
            assignedBy: actorId,
            assignedAt: new Date(),
          },
        ],
        { session }
      );
      await ensureDefaultRequestTypes({ session, organizationId: organization._id, actorId: adminUser._id });
      await initializeDefaultApprovalWorkflow({ session, organizationId: organization._id, actorId: adminUser._id });

      await writeAuditLog(session, {
        organizationId: organization._id,
        actorId,
        action: AUDIT_ACTIONS.ORGANIZATION_CREATED,
        resourceType: AUDIT_RESOURCE_TYPES.ORGANIZATION,
        resourceId: organization._id,
        changes: {
          name: organization.name,
          status: organization.status,
        },
      });

      await writeAuditLog(session, {
        organizationId: organization._id,
        actorId,
        action: AUDIT_ACTIONS.ORGANIZATION_ADMIN_CREATED,
        resourceType: AUDIT_RESOURCE_TYPES.USER,
        resourceId: adminUser._id,
        changes: {
          name: adminUser.name,
          email: adminUser.email,
          roleName: ORGANIZATION_ADMIN_ROLE_NAME,
          roleId: String(adminRole._id),
        },
      });

      return {
        organization: toPublicOrganization(organization),
        admin: toPublicAdminUser(adminUser, organization._id),
        role: {
          id: String(adminRole._id),
          name: adminRole.name,
        },
      };
    });
  } catch (error) {
    throw throwDuplicateError(error);
  }
};

export const listOrganizations = async ({ page, limit, search, status, sortBy, sortOrder }) => {
  const filter = {};
  if (status) {
    filter.status = status;
  }
  if (search) {
    filter.name = { $regex: escapeRegex(search), $options: 'i' };
  }

  const skip = (page - 1) * limit;
  const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

  const [items, total] = await Promise.all([
    Organization.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    Organization.countDocuments(filter),
  ]);

  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

  return {
    items: items.map(toPublicOrganization),
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1 && total > 0,
    },
  };
};

export const getOrganizationById = async (organizationId) => {
  const organization = await Organization.findById(organizationId);
  if (!organization) {
    throw new AppError('Organization not found.', 404, 'ORGANIZATION_NOT_FOUND');
  }

  const [memberCount, activeMemberCount, departmentCount] = await Promise.all([
    User.countDocuments({ 'organizationMemberships.organizationId': organization._id }),
    User.countDocuments({
      organizationMemberships: {
        $elemMatch: {
          organizationId: organization._id,
          status: 'ACTIVE',
        },
      },
    }),
    Department.countDocuments({ organizationId: organization._id }),
  ]);

  return {
    organization: toPublicOrganization(organization),
    summary: {
      memberCount,
      activeMemberCount,
      departmentCount,
    },
  };
};

export const updateOrganizationName = async ({ organizationId, name, actorId }) => {
  try {
    return await withTransaction(async (session) => {
      const organization = await Organization.findById(organizationId).session(session);
      if (!organization) {
        throw new AppError('Organization not found.', 404, 'ORGANIZATION_NOT_FOUND');
      }

      const previousName = organization.name;
      if (previousName === name) {
        return toPublicOrganization(organization);
      }

      organization.name = name;
      await organization.save({ session });

      await writeAuditLog(session, {
        organizationId: organization._id,
        actorId,
        action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
        resourceType: AUDIT_RESOURCE_TYPES.ORGANIZATION,
        resourceId: organization._id,
        changes: {
          name: {
            from: previousName,
            to: name,
          },
        },
      });

      return toPublicOrganization(organization);
    });
  } catch (error) {
    throw throwDuplicateError(error);
  }
};

export const setOrganizationStatus = async ({ organizationId, status, actorId }) => {
  return withTransaction(async (session) => {
    const organization = await Organization.findById(organizationId).session(session);
    if (!organization) {
      throw new AppError('Organization not found.', 404, 'ORGANIZATION_NOT_FOUND');
    }

    const previousStatus = organization.status;
    if (previousStatus === status) {
      return toPublicOrganization(organization);
    }

    organization.status = status;
    await organization.save({ session });

    await writeAuditLog(session, {
      organizationId: organization._id,
      actorId,
      action:
        status === 'ACTIVE'
          ? AUDIT_ACTIONS.ORGANIZATION_ACTIVATED
          : AUDIT_ACTIONS.ORGANIZATION_DEACTIVATED,
      resourceType: AUDIT_RESOURCE_TYPES.ORGANIZATION,
      resourceId: organization._id,
      changes: {
        status: {
          from: previousStatus,
          to: status,
        },
      },
    });

    return toPublicOrganization(organization);
  });
};

export default {
  createOrganization,
  listOrganizations,
  getOrganizationById,
  updateOrganizationName,
  setOrganizationStatus,
};

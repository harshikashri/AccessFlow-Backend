import mongoose from 'mongoose';
import Department from '../../models/Department.js';
import Role from '../../models/Role.js';
import User from '../../models/User.js';
import Organization from '../../models/Organization.js';
import AuditLog from '../../models/AuditLog.js';
import { AppError } from '../../utils/AppError.js';
import { getRoleType } from '../roles/role-compatibility.js';
import { getSupportedRoleScopes } from '../roles/role.scope.js';
import { prepareRoleAssignments } from '../roles/role.assignment.service.js';
import { activateUser, createUser, deactivateUser } from './user.service.js';
import {
  BULK_USER_CSV_MAX_BYTES,
  BULK_USER_CSV_MAX_ROWS,
  makeBulkUserCsvTemplate,
  makeBulkUserErrorReport,
  parseBulkUserCsv,
} from './bulk-user-import.csv.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROFILE_FIELDS = ['firstName', 'lastName', 'employeeId', 'designation', 'phone'];
const FAILURE_STATUSES = new Set(['INVALID', 'DUPLICATE', 'FAILED', 'INVITATION_FAILED']);

const normalize = (value) => String(value || '').trim();
const normalizeKey = (value) => normalize(value).toLocaleLowerCase('en-US');

const addError = (row, message, status = 'INVALID') => {
  row.errors.push(message);
  if (status === 'DUPLICATE') row.duplicate = true;
};

const getRowsAndGroups = (inputRows) => {
  const rows = inputRows.map((input) => ({
    ...input,
    email: normalize(input.email).toLocaleLowerCase('en-US'),
    firstName: normalize(input.firstName),
    lastName: normalize(input.lastName),
    employeeId: normalize(input.employeeId),
    department: normalize(input.department),
    role: normalize(input.role),
    scope: normalize(input.scope),
    designation: normalize(input.designation),
    phone: normalize(input.phone),
    errors: [],
    status: 'INVALID',
    assignment: null,
  }));
  const groups = new Map();

  for (const row of rows) {
    if (!row.firstName) addError(row, 'First name is required.');
    if (!row.lastName) addError(row, 'Last name is required.');
    if (!row.email || row.email.length > 320 || !EMAIL_PATTERN.test(row.email)) {
      addError(row, 'A valid email address is required.');
    }
    if (!row.role) addError(row, 'Role is required.');
    const fullName = `${row.firstName} ${row.lastName}`.trim();
    if (fullName.length > 200) addError(row, 'Combined first and last name cannot exceed 200 characters.');

    for (const field of ['employeeId', 'designation', 'phone']) {
      if (row[field]) {
        addError(row, `${field} is not stored by the current user profile schema; leave it blank to avoid losing data.`);
      }
    }
    if (row.phone && !/^[+()\d.\-\s]{7,30}$/.test(row.phone)) addError(row, 'Phone must use a supported phone-number format.');

    const key = row.email || `invalid-row-${row.rowNumber}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const field of PROFILE_FIELDS) {
      const values = new Set(group.map((row) => normalizeKey(row[field])));
      if (values.size > 1) {
        group.forEach((row) => addError(row, `Rows for this email contain conflicting ${field} values.`));
      }
    }
    const departments = new Set(group.map((row) => normalizeKey(row.department)).filter(Boolean));
    if (departments.size > 1) {
      group.forEach((row) => addError(row, 'Rows for this email use conflicting department assignments.'));
    }
  }
  return { rows, groups };
};

const rowView = (row) => ({
  rowNumber: row.rowNumber,
  firstName: row.firstName,
  lastName: row.lastName,
  email: row.email,
  department: row.department,
  role: row.role,
  scopeType: row.scopeType || null,
  status: row.status,
  errors: [...row.errors],
});

const assertRequiredCreatePermission = (access) => {
  if (!access?.organizationPermissions?.has('users.create')) {
    throw new AppError('Organization-wide permission users.create is required for bulk import.', 403, 'FORBIDDEN');
  }
};

const assertActiveOrganization = async (organizationId) => {
  const organization = await Organization.findById(organizationId).select('status');
  if (!organization) throw new AppError('Organization not found.', 404, 'ORGANIZATION_NOT_FOUND');
  if (organization.status !== 'ACTIVE') {
    throw new AppError('This organization is inactive.', 403, 'ORGANIZATION_INACTIVE');
  }
};

export const validateBulkUserImport = async ({ organizationId, access, csv }) => {
  await assertActiveOrganization(organizationId);
  const parsedRows = parseBulkUserCsv(csv);
  const { rows, groups } = getRowsAndGroups(parsedRows);
  const [roles, departments] = await Promise.all([
    Role.find({ organizationId }),
    Department.find({ organizationId }),
  ]);
  const roleGroups = new Map();
  for (const role of roles) {
    const key = normalizeKey(role.name);
    if (!roleGroups.has(key)) roleGroups.set(key, []);
    roleGroups.get(key).push(role);
  }
  const departmentGroups = new Map();
  for (const department of departments) {
    const key = normalizeKey(department.name);
    if (!departmentGroups.has(key)) departmentGroups.set(key, []);
    departmentGroups.get(key).push(department);
  }

  for (const group of groups.values()) {
    const assignmentKeys = new Set();
    const assignments = [];
    for (const row of group) {
      const matchingRoles = roleGroups.get(normalizeKey(row.role)) || [];
      if (matchingRoles.length === 0) {
        addError(row, 'Role is not found or available in this organization.');
        continue;
      }
      if (matchingRoles.length !== 1) {
        addError(row, 'Role name is ambiguous in this organization.');
        continue;
      }
      const role = matchingRoles[0];
      if (role.status !== 'ACTIVE') {
        addError(row, 'Role is inactive in this organization.');
        continue;
      }
      const supportedScopes = getSupportedRoleScopes(role);
      if (!supportedScopes.length) {
        addError(row, 'This role has no configured assignment scope. Configure its supported scopes before bulk import.');
        continue;
      }
      let scopeType = null;
      if (row.scope) {
        const requestedScope = row.scope.toLocaleUpperCase('en-US');
        if (!['ORGANIZATION', 'DEPARTMENT'].includes(requestedScope)) {
          addError(row, 'Scope must be ORGANIZATION or DEPARTMENT.');
          continue;
        }
        if (!supportedScopes.includes(requestedScope)) {
          addError(row, `This role does not support ${requestedScope} assignments.`);
          continue;
        }
        scopeType = requestedScope;
      } else if (supportedScopes.length === 1) {
        [scopeType] = supportedScopes;
      } else if (getRoleType(role) === 'EMPLOYEE') {
        scopeType = 'DEPARTMENT';
      } else {
        addError(row, 'This role supports both scopes; specify ORGANIZATION or DEPARTMENT in the scope column.');
        continue;
      }
      row.scopeType = scopeType;

      let department = null;
      if (scopeType === 'ORGANIZATION' && row.department) {
        addError(row, 'Organization-scoped roles require an empty department.');
        continue;
      }
      if (scopeType === 'DEPARTMENT') {
        if (!row.department) {
          addError(row, 'Department-scoped roles require a department.');
          continue;
        }
        const matchingDepartments = departmentGroups.get(normalizeKey(row.department)) || [];
        if (matchingDepartments.length === 0) {
          addError(row, 'Department is not found or available in this organization.');
          continue;
        }
        if (matchingDepartments.length !== 1) {
          addError(row, 'Department name is ambiguous in this organization.');
          continue;
        }
        if (matchingDepartments[0].status !== 'ACTIVE') {
          addError(row, 'Department is inactive in this organization.');
          continue;
        }
        [department] = matchingDepartments;
      }

      const assignment = {
        roleId: role._id,
        scopeType,
        departmentId: department?._id || null,
      };
      const assignmentKey = `${role._id}:${scopeType}:${department?._id || ''}`;
      if (assignmentKeys.has(assignmentKey)) {
        addError(row, 'This role assignment is duplicated for the same user and scope.', 'DUPLICATE');
        continue;
      }
      assignmentKeys.add(assignmentKey);
      row.assignment = assignment;
      assignments.push(assignment);
    }

    if (assignments.length && group.every((row) => row.errors.length === 0)) {
      try {
        await prepareRoleAssignments({ assignments, organizationId, access });
      } catch (error) {
        const message = error instanceof AppError
          ? error.message
          : 'One or more role assignments could not be validated.';
        group.forEach((row) => addError(row, message));
      }
    }
  }

  const emails = [...groups.keys()].filter((email) => !email.startsWith('invalid-row-'));
  const existingUsers = emails.length
    ? await User.find({ email: { $in: emails } }).select('email organizationMemberships').lean()
    : [];
  const existingByEmail = new Map(existingUsers.map((user) => [user.email.toLocaleLowerCase('en-US'), user]));
  const existingGroups = new Set();

  for (const [email, group] of groups) {
    if (group.some((row) => row.errors.length)) {
      group.forEach((row) => {
        if (row.errors.length) row.status = row.duplicate ? 'DUPLICATE' : 'INVALID';
        else {
          row.status = 'INVALID';
          addError(row, 'This user group will be skipped because another row for the email is invalid.');
        }
      });
      continue;
    }
    const existing = existingByEmail.get(email);
    if (existing) {
      const hasMembership = existing.organizationMemberships.some(
        (membership) => String(membership.organizationId) === String(organizationId)
      );
      if (!hasMembership) {
        group.forEach((row) => {
          row.status = 'INVALID';
          addError(row, 'Unable to import this email because it is already registered and cannot be added through this operation.');
        });
      } else {
        existingGroups.add(email);
        group.forEach((row) => {
          row.status = 'EXISTING';
          row.errors.push('Existing user will be skipped; profile and role assignments will not be changed.');
        });
      }
      continue;
    }
    group.forEach((row) => { row.status = 'VALID'; });
  }

  const summary = {
    totalRows: rows.length,
    validUsers: [...groups.entries()].filter(([email, group]) => !email.startsWith('invalid-row-') && group.every((row) => row.status === 'VALID')).length,
    existingUsers: existingGroups.size,
    invalidUsers: [...groups.values()].filter((group) => group.some((row) => ['INVALID', 'DUPLICATE'].includes(row.status))).length,
    validAssignments: rows.filter((row) => row.status === 'VALID' && row.assignment).length,
    invalidRows: rows.filter((row) => ['INVALID', 'DUPLICATE'].includes(row.status)).length,
    duplicateRows: rows.filter((row) => row.status === 'DUPLICATE').length,
  };
  return {
    summary,
    rows,
    groups,
  };
};

export const getBulkUserImportTemplate = () => makeBulkUserCsvTemplate();

const writeImportAudit = async ({ organizationId, actorId, importId, action, metadata }) => {
  await AuditLog.create({
    organizationId,
    actorId,
    action,
    resourceType: 'BulkUserImport',
    resourceId: importId,
    metadata: { correlationId: String(importId), ...metadata },
    timestamp: new Date(),
  });
};

const getGroupDepartmentId = (group) => {
  const row = group.find((item) => item.assignment?.scopeType === 'DEPARTMENT');
  return row?.assignment?.departmentId || null;
};

const buildImportReportRows = (rows, resultsByEmail) => rows
  .filter((row) => FAILURE_STATUSES.has(row.status) || ['FAILED', 'INVITATION_FAILED'].includes(resultsByEmail.get(row.email)?.status))
  .map((row) => {
    const result = resultsByEmail.get(row.email);
    return {
      ...rowView(row),
      errors: result?.errors?.length ? result.errors : row.errors,
    };
  });

export const confirmBulkUserImport = async ({ organizationId, actorId, access, csv }) => {
  assertRequiredCreatePermission(access);
  const importId = new mongoose.Types.ObjectId();
  await writeImportAudit({
    organizationId,
    actorId,
    importId,
    action: 'BULK_USER_IMPORT_INITIATED',
    metadata: {},
  });

  let usersCreated = 0;
  let assignmentsCreated = 0;
  let totalRows = 0;
  let existingUsersSkipped = 0;
  let invalidUsersSkipped = 0;
  let failedUsers = 0;
  let failedAssignments = 0;
  let invitationsSent = 0;
  let invitationsFailed = 0;
  try {
    const validation = await validateBulkUserImport({ organizationId, access, csv });
    totalRows = validation.summary.totalRows;
    existingUsersSkipped = validation.summary.existingUsers;
    invalidUsersSkipped = validation.summary.invalidUsers;
    const resultsByEmail = new Map();

    for (const [email, group] of validation.groups) {
      const first = group[0];
      if (group.every((row) => row.status === 'EXISTING')) {
        resultsByEmail.set(email, { status: 'EXISTING', errors: [] });
        continue;
      }
      if (group.some((row) => row.status !== 'VALID')) {
        resultsByEmail.set(email, {
          status: 'INVALID',
          errors: group.flatMap((row) => row.errors),
        });
        continue;
      }

      const roleAssignments = group.map((row) => row.assignment);
      try {
        await createUser({
          organizationId,
          actorId,
          access,
          includeDefaultMemberRole: false,
          input: {
            name: `${first.firstName} ${first.lastName}`.trim(),
            email,
            departmentId: getGroupDepartmentId(group),
            roleAssignments,
          },
        });
        usersCreated += 1;
        assignmentsCreated += roleAssignments.length;
        invitationsSent += 1;
        resultsByEmail.set(email, { status: 'IMPORTED', errors: [] });
      } catch (error) {
        if (error?.code === 'USER_CREATED_EMAIL_FAILED' && error.details?.userId) {
          usersCreated += 1;
          assignmentsCreated += roleAssignments.length;
          invitationsFailed += 1;
          resultsByEmail.set(email, {
            status: 'INVITATION_FAILED',
            errors: ['User and role assignments were saved, but the setup invitation was not accepted by the email provider. Retry the existing account setup email action.'],
          });
          continue;
        }
        if (error?.code === 'EMAIL_EXISTS') {
          existingUsersSkipped += 1;
          resultsByEmail.set(email, {
            status: 'EXISTING',
            errors: ['Existing user was skipped; profile and role assignments were not changed.'],
          });
          continue;
        }
        failedUsers += 1;
        failedAssignments += roleAssignments.length;
        const safeMessage = error instanceof AppError
          ? error.message
          : 'User could not be imported due to an internal processing error.';
        resultsByEmail.set(email, { status: 'FAILED', errors: [safeMessage] });
      }
    }

    const rowResults = validation.rows.map((row) => {
      const result = resultsByEmail.get(row.email);
      if (!result) return rowView(row);
      return { ...rowView(row), status: result.status, errors: result.errors };
    });
    const reportRows = buildImportReportRows(validation.rows, resultsByEmail);
    const errorReport = {
      filename: `accessflow-bulk-import-${String(importId)}-errors.csv`,
      contentType: 'text/csv',
      csv: makeBulkUserErrorReport(reportRows),
    };
    const summary = {
      totalRows,
      usersCreated,
      assignmentsCreated,
      existingUsersSkipped,
      invalidUsersSkipped,
      failedUsers,
      failedAssignments,
      invitations: { sent: invitationsSent, failed: invitationsFailed },
    };
    const completedWithFailures = invalidUsersSkipped > 0 || failedUsers > 0 || invitationsFailed > 0;
    await writeImportAudit({
      organizationId,
      actorId,
      importId,
      action: completedWithFailures
        ? 'BULK_USER_IMPORT_COMPLETED_WITH_FAILURES'
        : 'BULK_USER_IMPORT_COMPLETED',
      metadata: summary,
    });

    return { importId: String(importId), summary, rows: rowResults, errorReport };
  } catch (error) {
    const errorCode = typeof error?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code)
      ? error.code
      : 'IMPORT_CONFIRMATION_FAILED';
    try {
      await writeImportAudit({
        organizationId,
        actorId,
        importId,
        action: 'BULK_USER_IMPORT_FAILED',
        metadata: {
          totalRows,
          usersCreated,
          assignmentsCreated,
          existingUsersSkipped,
          invalidUsersSkipped,
          failedUsers,
          failedAssignments,
          invitationsSent,
          invitationsFailed,
          errorCode,
        },
      });
    } catch {
      // Keep the original confirmation error if writing the failure audit also fails.
    }
    throw error;
  }
};

export const getBulkUserFailedReport = async ({ organizationId, access, csv }) => {
  const validation = await validateBulkUserImport({ organizationId, access, csv });
  const failedRows = validation.rows
    .filter((row) => FAILURE_STATUSES.has(row.status))
    .map(rowView);
  return {
    filename: 'accessflow-bulk-import-errors.csv',
    contentType: 'text/csv',
    csv: makeBulkUserErrorReport(failedRows),
  };
};

const writeDeactivationAudit = async ({ organizationId, actorId, action, resourceId, metadata }) => {
  await AuditLog.create({
    organizationId,
    actorId,
    action,
    resourceType: 'UserBulkDeactivation',
    resourceId,
    metadata,
    timestamp: new Date(),
  });
};

const writeMembershipStatusAudit = async ({ organizationId, actorId, action, resourceId, metadata }) => {
  await AuditLog.create({
    organizationId,
    actorId,
    action,
    resourceType: 'UserBulkMembershipStatus',
    resourceId,
    metadata,
    timestamp: new Date(),
  });
};

export const bulkSetMembershipStatus = async ({ organizationId, actorId, access, userIds, status }) => {
  const operationId = new mongoose.Types.ObjectId();
  await writeMembershipStatusAudit({
    organizationId,
    actorId,
    action: 'BULK_USER_MEMBERSHIP_STATUS_INITIATED',
    resourceId: operationId,
    metadata: { requested: userIds.length, status },
  });
  const results = [];

  for (const userId of userIds) {
    try {
      const membershipResult = status === 'ACTIVE'
        ? await activateUser({ userId, organizationId, actorId, access, returnOutcome: true })
        : await deactivateUser({ userId, organizationId, actorId, access, returnOutcome: true });
      const resultStatus = status === 'ACTIVE'
        ? membershipResult.changed ? 'ACTIVATED' : 'ALREADY_ACTIVE'
        : membershipResult.changed ? 'DEACTIVATED' : 'ALREADY_INACTIVE';
      results.push({
        userId: String(userId),
        status: resultStatus,
        message: resultStatus === 'ACTIVATED'
          ? 'Membership reactivated.'
          : resultStatus === 'DEACTIVATED'
            ? 'Membership deactivated.'
            : resultStatus === 'ALREADY_ACTIVE'
              ? 'Membership was already active.'
              : 'Membership was already inactive.',
      });
    } catch (error) {
      const message = error instanceof AppError
        ? error.message
        : 'Membership status could not be changed.';
      const code = error instanceof AppError ? error.code : 'MEMBERSHIP_STATUS_CHANGE_FAILED';
      const isTargetInOrganization = await User.exists({
        _id: userId,
        'organizationMemberships.organizationId': organizationId,
      });
      if (isTargetInOrganization) {
        await writeMembershipStatusAudit({
          organizationId,
          actorId,
          action: 'BULK_USER_MEMBERSHIP_STATUS_FAILED',
          resourceId: userId,
          metadata: { code, status },
        });
      }
      results.push({
        userId: String(userId),
        status: 'FAILED',
        code,
        message: code === 'USER_NOT_FOUND'
          ? 'User was not found in the active organization.'
          : message,
      });
    }
  }

  const activated = results.filter((result) => result.status === 'ACTIVATED').length;
  const deactivated = results.filter((result) => result.status === 'DEACTIVATED').length;
  const failed = results.filter((result) => result.status === 'FAILED').length;
  await writeMembershipStatusAudit({
    organizationId,
    actorId,
    action: 'BULK_USER_MEMBERSHIP_STATUS_COMPLETED',
    resourceId: operationId,
    metadata: { requested: userIds.length, activated, deactivated, failed, status },
  });
  return {
    summary: { requested: userIds.length, activated, deactivated, failed },
    results,
  };
};

export const bulkDeactivateUsers = async ({ organizationId, actorId, access, userIds }) => {
  const operationId = new mongoose.Types.ObjectId();
  await writeDeactivationAudit({
    organizationId,
    actorId,
    action: 'BULK_USER_DEACTIVATION_INITIATED',
    resourceId: operationId,
    metadata: { requested: userIds.length },
  });
  const results = [];

  for (const userId of userIds) {
    try {
      const { changed } = await deactivateUser({
        userId,
        organizationId,
        actorId,
        access,
        returnOutcome: true,
      });
      const status = changed ? 'DEACTIVATED' : 'ALREADY_INACTIVE';
      results.push({
        userId: String(userId),
        status,
        message: status === 'ALREADY_INACTIVE' ? 'User was already inactive.' : 'User deactivated.',
      });
    } catch (error) {
      const message = error instanceof AppError
        ? error.message
        : 'User could not be deactivated.';
      const code = error instanceof AppError ? error.code : 'DEACTIVATION_FAILED';
      const isTargetInOrganization = await User.exists({
        _id: userId,
        'organizationMemberships.organizationId': organizationId,
      });
      if (isTargetInOrganization) {
        await writeDeactivationAudit({
          organizationId,
          actorId,
          action: 'BULK_USER_DEACTIVATION_FAILED',
          resourceId: userId,
          metadata: { code },
        });
      }
      results.push({
        userId: String(userId),
        status: 'FAILED',
        code,
        message: code === 'USER_NOT_FOUND'
          ? 'User was not found in the active organization.'
          : message,
      });
    }
  }

  const deactivated = results.filter((result) => result.status === 'DEACTIVATED').length;
  const failed = results.filter((result) => result.status === 'FAILED').length;
  await writeDeactivationAudit({
    organizationId,
    actorId,
    action: 'BULK_USER_DEACTIVATION_COMPLETED',
    resourceId: operationId,
    metadata: { requested: userIds.length, deactivated, failed },
  });
  return {
    summary: { requested: userIds.length, deactivated, failed },
    results,
  };
};

export const bulkImportLimits = () => ({
  maxBytes: BULK_USER_CSV_MAX_BYTES,
  maxRows: BULK_USER_CSV_MAX_ROWS,
});

export default {
  validateBulkUserImport,
  confirmBulkUserImport,
  getBulkUserImportTemplate,
  getBulkUserFailedReport,
  bulkDeactivateUsers,
  bulkSetMembershipStatus,
  bulkImportLimits,
};

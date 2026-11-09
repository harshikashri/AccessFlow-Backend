import { ORGANIZATION_ADMIN_ROLE_NAME } from '../../config/constants.js';
import { AppError } from '../../utils/AppError.js';

export const getRoleType = (role) => {
  if (role?.roleType && role.roleType !== 'CUSTOM') return role.roleType;
  if (role?.name === ORGANIZATION_ADMIN_ROLE_NAME) return 'ORGANIZATION_ADMIN';
  return role?.roleType || 'CUSTOM';
};

const isIncompatiblePair = (leftType, rightType) => {
  const pair = new Set([leftType, rightType]);
  return (
    (pair.has('EMPLOYEE') && pair.has('ORGANIZATION_ADMIN')) ||
    (pair.has('EMPLOYEE') && pair.has('DEPARTMENT_MANAGER'))
  );
};

const scopesOverlap = (left, right) =>
  left.scopeType === 'ORGANIZATION' ||
  right.scopeType === 'ORGANIZATION' ||
  String(left.departmentId || '') === String(right.departmentId || '');

const scopesConflict = (left, right, leftType, rightType) => {
  const managerAndCustom =
    (leftType === 'DEPARTMENT_MANAGER' && rightType === 'CUSTOM') ||
    (rightType === 'DEPARTMENT_MANAGER' && leftType === 'CUSTOM');
  if (!managerAndCustom || left.scopeType === 'ORGANIZATION' || right.scopeType === 'ORGANIZATION') {
    return false;
  }
  return String(left.departmentId || '') !== String(right.departmentId || '');
};

export const findRoleCompatibilityConflict = (existing, candidates) => {
  const priorCandidates = [];
  for (const candidate of candidates) {
    const candidateType = getRoleType(candidate.role);
    for (const current of [...existing, ...priorCandidates]) {
      if (String(current.role._id) === String(candidate.role._id) &&
        current.scopeType === candidate.scopeType &&
        String(current.departmentId || '') === String(candidate.departmentId || '')) {
        continue;
      }

      const currentType = getRoleType(current.role);
      if (isIncompatiblePair(candidateType, currentType) && scopesOverlap(candidate, current)) {
        return { candidate, conflicting: current };
      }
      if (scopesConflict(candidate, current, candidateType, currentType)) {
        return { candidate, conflicting: current, scopeConflict: true };
      }
    }
    priorCandidates.push(candidate);
  }
  return null;
};

export const assertRoleCompatibility = (existing, candidates) => {
  const conflict = findRoleCompatibilityConflict(existing, candidates);
  if (!conflict) return;
  const conflictingRole = conflict.conflicting.role;
  const candidateRole = conflict.candidate.role;
  const message = conflict.scopeConflict
    ? `${candidateRole.name} and ${conflictingRole.name} must use compatible department scopes.`
    : `${candidateRole.name} conflicts with ${conflictingRole.name} for this user in the organization.`;
  throw new AppError(message, 409, 'ROLE_COMPATIBILITY_CONFLICT', {
    roleId: String(candidateRole._id),
    conflictingRoleId: String(conflictingRole._id),
  });
};

export default { getRoleType, findRoleCompatibilityConflict, assertRoleCompatibility };
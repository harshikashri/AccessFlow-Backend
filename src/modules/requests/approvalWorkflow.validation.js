import mongoose from 'mongoose';
import { AppError } from '../../utils/AppError.js';
import { validateCondition } from './request.conditions.js';

const fail = (message, details) => {
  throw new AppError(message, 400, 'VALIDATION_ERROR', details);
};

const id = (value, name) => {
  if (typeof value !== 'string' || !mongoose.Types.ObjectId.isValid(value)) fail(`Invalid ${name}.`);
  return new mongoose.Types.ObjectId(value).toString();
};

const text = (value, name, max) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`${name} is invalid.`);
  return value.trim();
};

const validateDuration = (value, label, key = 'duration') => {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || !Number.isInteger(value[key]) || value[key] < 1 ||
      !['MINUTES', 'HOURS', 'DAYS'].includes(value.unit || 'HOURS')) {
    fail(`${label} must contain a positive duration and valid unit.`);
  }
  return { [key]: value[key], unit: value.unit || 'HOURS' };
};

const validateStageTiming = (stage) => {
  const sla = validateDuration(stage.sla, 'Stage SLA');
  if (!sla) return { sla: null };
  const reminders = (stage.sla.reminders || []).map((reminder) => {
    const normalized = validateDuration(reminder, 'Reminder schedule', 'after');
    return normalized;
  });
  if (reminders.some((reminder) => !reminder)) fail('Reminder schedules require valid durations.');
  const durationMinutes = (value) => value.after * { MINUTES: 1, HOURS: 60, DAYS: 1440 }[value.unit];
  if (reminders.some((reminder, index) => index > 0 &&
      durationMinutes(reminder) <= durationMinutes(reminders[index - 1]))) {
    fail('Reminder schedules must be in strictly increasing order.');
  }
  const escalation = stage.sla.escalation || {};
  const escalationTiming = escalation.enabled === true && escalation.after !== undefined && escalation.after !== null
    ? validateDuration(escalation, 'Escalation', 'after')
    : null;
  const escalationLevels = escalation.levels === undefined ? [] : escalation.levels;
  if (!Array.isArray(escalationLevels)) fail('Escalation levels must be an array.');
  const levels = escalationLevels.map((level) => {
    const timing = validateDuration(level, 'Escalation level', 'after');
    if (!timing || !['USER', 'ROLE'].includes(level.targetType)) {
      fail('Each escalation level requires a threshold and USER or ROLE target.');
    }
    return {
      ...timing,
      targetType: level.targetType,
      targetId: id(level.targetId, 'escalation target'),
    };
  });
  if (levels.some((level, index) => index > 0 &&
      durationMinutes({ after: level.after, unit: level.unit }) <=
      durationMinutes({ after: levels[index - 1].after, unit: levels[index - 1].unit }))) {
    fail('Escalation levels must be in strictly increasing order.');
  }
  if (escalation.enabled === true && !escalationTiming && !levels.length) {
    fail('Escalation requires a valid threshold.');
  }
  const escalationConfig = escalation.enabled === true ? {
    enabled: true,
    ...(escalationTiming || { after: null, unit: 'HOURS' }),
    targetType: escalation.targetType || null,
    targetId: escalation.targetId ? id(escalation.targetId, 'escalation target') : null,
    levels,
  } : {
    enabled: false,
    after: null,
    unit: 'HOURS',
    targetType: null,
    targetId: null,
    levels: [],
  };
  if (escalationConfig.enabled && !levels.length &&
      (!['USER', 'ROLE'].includes(escalationConfig.targetType) || !escalationConfig.targetId)) {
    fail('Escalation requires a USER or ROLE target.');
  }
  const claimExpiry = validateDuration(stage.sla.claimExpiry, 'Claim expiry');
  return { sla: { ...sla, reminders, escalation: escalationConfig, claimExpiry } };
};

const validateAssignment = (stage) => {
  const assignment = stage.assignment || {};
  const type = stage.approverType || assignment.type;
  const resolution = assignment.resolution || (type === 'USER' ? 'DIRECT' : 'CLAIM_ONE');
  if (!['DEPARTMENT_MANAGER', 'ROLE', 'USER', 'ORGANIZATION_ADMIN'].includes(type)) {
    fail('Invalid approval stage assignment type.');
  }
  if (!['DIRECT', 'CLAIM_ONE'].includes(resolution)) fail('Invalid approval stage resolution.');
  if (resolution === 'CLAIM_ONE' && stage.approvalMode === 'ALL') {
    fail('CLAIM_ONE cannot be combined with ALL approval mode.');
  }
  if (type === 'ROLE' && !assignment.roleId) fail('Role approval stages require roleId.');
  if (type === 'USER' && !assignment.userId) fail('User approval stages require userId.');
  return {
    type,
    resolution,
    roleId: type === 'ROLE' ? id(assignment.roleId, 'roleId') : null,
    userId: type === 'USER' ? id(assignment.userId, 'userId') : null,
  };
};

export const validateApprovalWorkflow = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Workflow body must be an object.');
  const allowed = ['name', 'description', 'requestTypeId', 'stages'];
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) fail('Unsupported workflow fields.', unknown);
  if (!Array.isArray(body.stages) || body.stages.length === 0) fail('At least one workflow stage is required.');

  const seenIds = new Set();
  const seenOrders = new Set();
  const stages = body.stages.map((stage, index) => {
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) fail('Each workflow stage must be an object.');
    if (stage.isMandatory !== undefined && typeof stage.isMandatory !== 'boolean') fail('Stage isMandatory must be boolean.');
    if (stage.isConfigurable !== undefined && typeof stage.isConfigurable !== 'boolean') fail('Stage isConfigurable must be boolean.');
    if (stage.assignment?.type && stage.approverType && stage.assignment.type !== stage.approverType) {
      fail('Stage assignment type and approverType must match.');
    }
    const stageId = text(stage.stageId, `Stage ${index + 1} identifier`, 100);
    if (seenIds.has(stageId)) fail('Workflow stage identifiers must be unique.');
    seenIds.add(stageId);
    const sequence = stage.sequence ?? stage.stageOrder;
    if (!Number.isInteger(sequence) || sequence < 1 || seenOrders.has(sequence)) fail('Workflow stage order must be unique positive integers.');
    seenOrders.add(sequence);
    const approvalMode = stage.approvalMode || 'ANY';
    if (!['ANY', 'ALL'].includes(approvalMode)) fail('Invalid approval mode.');
    const assignment = validateAssignment({ ...stage, approvalMode });
    const timing = validateStageTiming(stage);
    if (stage.condition !== undefined && stage.condition !== null &&
      (!stage.condition || typeof stage.condition !== 'object')) fail('Stage condition must be an object.');
    if (assignment.type === 'DEPARTMENT_MANAGER' &&
      (stage.condition || stage.isConfigurable === true)) {
      fail('The mandatory Department Manager stage cannot be conditional or configurable.');
    }
    return {
      stageId,
      sequence,
      name: text(stage.name, `Stage ${index + 1} name`, 200),
      description: stage.description === undefined ? '' : (stage.description === '' ? '' : text(stage.description, `Stage ${index + 1} description`, 1000)),
      approverType: assignment.type,
      assignment,
      roleId: assignment.roleId,
      approvalMode,
      condition: stage.condition || null,
      sla: timing.sla,
      isMandatory: stage.isMandatory === true,
      isConfigurable: assignment.type === 'DEPARTMENT_MANAGER' ? false : stage.isConfigurable !== false,
    };
  });

  const managerStages = stages.filter((stage) => stage.approverType === 'DEPARTMENT_MANAGER' && stage.isMandatory);
  if (managerStages.length !== 1) fail('Exactly one mandatory Department Manager stage is required.');
  if (managerStages[0].assignment.resolution !== 'CLAIM_ONE' || managerStages[0].approvalMode !== 'ANY') {
    fail('The mandatory Department Manager stage must use CLAIM_ONE and ANY.');
  }

  return {
    name: text(body.name, 'Workflow name', 200),
    description: body.description === undefined ? '' : (body.description === '' ? '' : text(body.description, 'Workflow description', 1000)),
    requestTypeId: body.requestTypeId === undefined || body.requestTypeId === null
      ? null
      : id(body.requestTypeId, 'requestTypeId'),
    stages: stages.sort((left, right) => left.sequence - right.sequence),
  };
};

export const validateWorkflowCondition = (condition, fields) => {
  if (!condition) return;
  validateCondition(condition, fields, '__workflow_stage__');
};

export const validateWorkflowId = (value) => id(value, 'workflowId');

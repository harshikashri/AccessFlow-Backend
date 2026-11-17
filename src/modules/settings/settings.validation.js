import { AppError } from '../../utils/AppError.js';
import mongoose from 'mongoose';

const objectBody = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('Request body must be an object.', 400, 'VALIDATION_ERROR');
  }
};

const booleanFields = [
  'approvalTasks',
  'requestUpdates',
  'delegationUpdates',
  'slaReminders',
  'overdueAlerts',
  'escalationAlerts',
  'email',
  'inApp',
];

export const validateProfileUpdate = (body) => {
  objectBody(body);
  const keys = Object.keys(body);
  if (keys.some((key) => key !== 'name')) throw new AppError('Only name can be updated in profile settings.', 400, 'VALIDATION_ERROR');
  if (typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.trim().length > 200) {
    throw new AppError('Name must be between 2 and 200 characters.', 400, 'VALIDATION_ERROR');
  }
  return { name: body.name.trim() };
};

export const validatePreferencesUpdate = (body) => {
  objectBody(body);
  const allowed = ['language', 'timezone', 'dateFormat', 'timeFormat'];
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new AppError('Unsupported preference.', 400, 'VALIDATION_ERROR');
  if (body.language !== undefined && (typeof body.language !== 'string' || body.language.length > 20)) throw new AppError('Invalid language.', 400, 'VALIDATION_ERROR');
  if (body.timezone !== undefined && (typeof body.timezone !== 'string' || body.timezone.length > 100)) throw new AppError('Invalid timezone.', 400, 'VALIDATION_ERROR');
  if (body.dateFormat !== undefined && (typeof body.dateFormat !== 'string' || body.dateFormat.length > 30)) throw new AppError('Invalid date format.', 400, 'VALIDATION_ERROR');
  if (body.timeFormat !== undefined && !['12h', '24h'].includes(body.timeFormat)) throw new AppError('Invalid time format.', 400, 'VALIDATION_ERROR');
  return body;
};

export const validateNotificationPreferencesUpdate = (body) => {
  objectBody(body);
  if (Object.keys(body).some((key) => !booleanFields.includes(key))) throw new AppError('Unsupported notification preference.', 400, 'VALIDATION_ERROR');
  if (Object.values(body).some((value) => typeof value !== 'boolean')) throw new AppError('Notification preferences must be boolean.', 400, 'VALIDATION_ERROR');
  return body;
};

export const validateSessionId = (value) => {
  if (!mongoose.Types.ObjectId.isValid(value)) throw new AppError('Invalid sessionId.', 400, 'VALIDATION_ERROR');
  return String(value);
};

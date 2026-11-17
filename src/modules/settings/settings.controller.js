import * as settingsService from './settings.service.js';
import {
  validateNotificationPreferencesUpdate,
  validatePreferencesUpdate,
  validateProfileUpdate,
  validateSessionId,
} from './settings.validation.js';

export const getProfile = async (req, res) => res.json({ success: true, data: await settingsService.getProfile({ userId: req.auth.userId, organizationId: req.auth.organizationId }) });
export const updateProfile = async (req, res) => res.json({ success: true, data: await settingsService.updateProfile({ userId: req.auth.userId, organizationId: req.auth.organizationId, input: validateProfileUpdate(req.body) }) });
export const getPreferences = async (req, res) => res.json({ success: true, data: await settingsService.getPreferences({ userId: req.auth.userId }) });
export const updatePreferences = async (req, res) => res.json({ success: true, data: await settingsService.updatePreferences({ userId: req.auth.userId, organizationId: req.auth.organizationId, input: validatePreferencesUpdate(req.body) }) });
export const getNotificationPreferences = async (req, res) => res.json({ success: true, data: await settingsService.getNotificationPreferences({ userId: req.auth.userId }) });
export const updateNotificationPreferences = async (req, res) => res.json({ success: true, data: await settingsService.updateNotificationPreferences({ userId: req.auth.userId, organizationId: req.auth.organizationId, input: validateNotificationPreferencesUpdate(req.body) }) });
export const listSessions = async (req, res) => res.json({ success: true, data: { items: await settingsService.listSessions({ userId: req.auth.userId, sessionId: req.auth.sessionId }) } });
export const revokeSession = async (req, res) => res.json({ success: true, data: await settingsService.revokeSession({ userId: req.auth.userId, organizationId: req.auth.organizationId, sessionId: req.auth.sessionId, targetSessionId: validateSessionId(req.params.sessionId) }) });
export const getOrganizationSettings = async (req, res) => res.json({ success: true, data: await settingsService.getOrganizationSettings({ organizationId: req.auth.organizationId }) });

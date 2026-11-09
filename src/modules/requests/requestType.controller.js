import * as requestService from './request.service.js';
import {
  validateRequestType,
  validateRequestTypeId,
  validateRequestTypeUpdate,
} from './request.validation.js';

export const createRequestType = async (req, res) => {
  const data = await requestService.createRequestType({
    organizationId: req.auth.organizationId,
    actorId: req.auth.userId,
    input: validateRequestType(req.body),
  });
  return res.status(201).json({ success: true, message: 'Request type created successfully.', data });
};

export const listRequestTypes = async (req, res) => {
  const data = await requestService.listRequestTypes({
    organizationId: req.auth.organizationId,
    access: req.requestAccess,
    includeInactive: req.query.includeInactive === 'true',
  });
  return res.status(200).json({ success: true, message: 'Request types retrieved successfully.', data });
};

export const getRequestType = async (req, res) => {
  const data = await requestService.getRequestTypeById({
    organizationId: req.auth.organizationId,
    access: req.requestAccess,
    requestTypeId: validateRequestTypeId(req.params.requestTypeId),
  });
  return res.status(200).json({ success: true, message: 'Request type retrieved successfully.', data });
};

export const updateRequestType = async (req, res) => {
  const data = await requestService.updateRequestType({
    organizationId: req.auth.organizationId,
    actorId: req.auth.userId,
    requestTypeId: validateRequestTypeId(req.params.requestTypeId),
    input: validateRequestTypeUpdate(req.body),
  });
  return res.status(200).json({ success: true, message: 'Request type updated successfully.', data });
};

export const activateRequestType = async (req, res) => {
  const data = await requestService.setRequestTypeStatus({
    organizationId: req.auth.organizationId,
    actorId: req.auth.userId,
    requestTypeId: validateRequestTypeId(req.params.requestTypeId),
    isActive: true,
  });
  return res.status(200).json({ success: true, message: 'Request type activated successfully.', data });
};

export const deactivateRequestType = async (req, res) => {
  const data = await requestService.setRequestTypeStatus({
    organizationId: req.auth.organizationId,
    actorId: req.auth.userId,
    requestTypeId: validateRequestTypeId(req.params.requestTypeId),
    isActive: false,
  });
  return res.status(200).json({ success: true, message: 'Request type deactivated successfully.', data });
};

export default { createRequestType, listRequestTypes, getRequestType, updateRequestType, activateRequestType, deactivateRequestType };

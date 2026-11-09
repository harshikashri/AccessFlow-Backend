import * as requestService from './request.service.js';
import {
  validateCancellation,
  validateCreateRequest,
  validateRequestId,
  validateRequestListQuery,
  validateRequestSearchQuery,
  validateRequestTypeId,
  validateUpdateRequest,
} from './request.validation.js';

export const createRequest = async (req, res) => {
  const data = await requestService.createRequest({
    organizationId: req.auth.organizationId,
    actorId: req.auth.userId,
    access: req.requestAccess,
    input: validateCreateRequest(req.body),
  });
  return res.status(201).json({ success: true, message: 'Request created successfully.', data });
};

export const listRequests = async (req, res) => {
  const data = await requestService.listRequests({
    organizationId: req.auth.organizationId,
    actorId: req.auth.userId,
    access: req.requestAccess,
    query: validateRequestListQuery(req.query),
  });
  return res.status(200).json({ success: true, message: 'Requests retrieved successfully.', data });
};

export const searchRequests = async (req, res) => {
  const data = await requestService.searchRequests({
    organizationId: req.auth.organizationId,
    actorId: req.auth.userId,
    access: req.requestAccess,
    query: validateRequestSearchQuery(req.query),
  });
  return res.status(200).json({ success: true, message: 'Requests retrieved successfully.', data });
};

export const getRequest = async (req, res) => {
  const data = await requestService.getRequestById({
    organizationId: req.auth.organizationId,
    actorId: req.auth.userId,
    access: req.requestAccess,
    requestId: validateRequestId(req.params.requestId),
  });
  return res.status(200).json({ success: true, message: 'Request retrieved successfully.', data });
};

export const updateRequest = async (req, res) => {
  const data = await requestService.updateRequest({
    organizationId: req.auth.organizationId,
    actorId: req.auth.userId,
    access: req.requestAccess,
    requestId: validateRequestId(req.params.requestId),
    input: validateUpdateRequest(req.body),
  });
  return res.status(200).json({ success: true, message: 'Request updated successfully.', data });
};

export const submitRequest = async (req, res) => {
  const data = await requestService.submitRequest({
    organizationId: req.auth.organizationId,
    actorId: req.auth.userId,
    access: req.requestAccess,
    requestId: validateRequestId(req.params.requestId),
  });
  return res.status(200).json({ success: true, message: 'Request submitted successfully.', data });
};

export const cancelRequest = async (req, res) => {
  const { cancellationReason } = validateCancellation(req.body);
  const data = await requestService.cancelRequest({
    organizationId: req.auth.organizationId,
    actorId: req.auth.userId,
    access: req.requestAccess,
    requestId: validateRequestId(req.params.requestId),
    cancellationReason,
  });
  return res.status(200).json({ success: true, message: 'Request cancelled successfully.', data });
};

export default { createRequest, listRequests, searchRequests, getRequest, updateRequest, submitRequest, cancelRequest };
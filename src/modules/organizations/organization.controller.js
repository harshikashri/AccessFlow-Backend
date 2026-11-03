import * as organizationService from './organization.service.js';
import {
  validateCreateOrganization,
  validateObjectIdParam,
  validateOrganizationListQuery,
  validateUpdateOrganization,
} from './organization.validation.js';

export const createOrganization = async (req, res) => {
  const input = validateCreateOrganization(req.body);
  const result = await organizationService.createOrganization({
    name: input.name,
    admin: input.admin,
    actorId: req.auth.userId,
  });

  return res.status(201).json({
    success: true,
    message: 'Organization created successfully.',
    data: result,
  });
};

export const listOrganizations = async (req, res) => {
  const query = validateOrganizationListQuery(req.query);
  const result = await organizationService.listOrganizations(query);

  return res.status(200).json({
    success: true,
    message: 'Organizations retrieved successfully.',
    data: result,
  });
};

export const getOrganization = async (req, res) => {
  const organizationId = validateObjectIdParam(req.params.organizationId);
  const result = await organizationService.getOrganizationById(organizationId);

  return res.status(200).json({
    success: true,
    message: 'Organization details retrieved successfully.',
    data: result,
  });
};

export const updateOrganization = async (req, res) => {
  const organizationId = validateObjectIdParam(req.params.organizationId);
  const { name } = validateUpdateOrganization(req.body);
  const result = await organizationService.updateOrganizationName({
    organizationId,
    name,
    actorId: req.auth.userId,
  });

  return res.status(200).json({
    success: true,
    message: 'Organization updated successfully.',
    data: result,
  });
};

export const activateOrganization = async (req, res) => {
  const organizationId = validateObjectIdParam(req.params.organizationId);
  const result = await organizationService.setOrganizationStatus({
    organizationId,
    status: 'ACTIVE',
    actorId: req.auth.userId,
  });

  return res.status(200).json({
    success: true,
    message: 'Organization activated successfully.',
    data: result,
  });
};

export const deactivateOrganization = async (req, res) => {
  const organizationId = validateObjectIdParam(req.params.organizationId);
  const result = await organizationService.setOrganizationStatus({
    organizationId,
    status: 'INACTIVE',
    actorId: req.auth.userId,
  });

  return res.status(200).json({
    success: true,
    message: 'Organization deactivated successfully.',
    data: result,
  });
};

export default {
  createOrganization,
  listOrganizations,
  getOrganization,
  updateOrganization,
  activateOrganization,
  deactivateOrganization,
};

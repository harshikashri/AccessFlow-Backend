export const normalizeCode = (value) => value.trim().toLocaleLowerCase('en-US');

export const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const toPublicRequestType = (definition) => ({
  id: String(definition._id),
  organizationId: String(definition.organizationId),
  definitionType: definition.definitionType,
  name: definition.name,
  code: definition.code,
  description: definition.description || '',
  fields: definition.fields || [],
  isActive: definition.isActive,
  createdBy: definition.createdBy ? String(definition.createdBy) : null,
  updatedBy: definition.updatedBy ? String(definition.updatedBy) : null,
  createdAt: definition.createdAt,
  updatedAt: definition.updatedAt,
});

export const toPublicRequest = (request) => ({
  id: String(request._id),
  organizationId: String(request.organizationId),
  requestNumber: request.requestNumber,
  requesterId: String(request.requesterId),
  departmentId: String(request.departmentId),
  requestTypeId: request.requestTypeId ? String(request.requestTypeId) : null,
  requestType: request.requestType,
  requestTypeCode: request.requestTypeCode,
  requestTypeName: request.requestTypeName,
  title: request.title,
  description: request.description,
  priority: request.priority,
  amount: request.amount,
  details: request.details || {},
  attachments: request.attachments || [],
  status: request.status,
  workflowDefinitionId: request.workflowDefinitionId ? String(request.workflowDefinitionId) : null,
  currentSequence: request.currentSequence,
  submittedAt: request.submittedAt,
  cancelledAt: request.cancelledAt,
  cancelledBy: request.cancelledBy ? String(request.cancelledBy) : null,
  cancellationReason: request.cancellationReason,
  returnedAt: request.returnedAt,
  returnedBy: request.returnedBy ? String(request.returnedBy) : null,
  returnReason: request.returnReason,
  createdAt: request.createdAt,
  updatedAt: request.updatedAt,
});

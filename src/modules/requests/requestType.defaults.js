const text = (key, label, type, required, validation = {}, conditions = {}) => ({
  key, label, type, required, validation, ...conditions,
});

const select = (key, label, options) => ({
  key, label, type: 'SELECT', required: true, options, validation: {},
});

const number = (key, label, validation = {}, semantic = null) => ({
  key, label, type: 'NUMBER', required: true, validation, semantic,
});

const date = (key, label, required = true, validation = {}, conditions = {}) => ({
  key, label, type: 'DATE', required, validation, ...conditions,
});

export const DEFAULT_REQUEST_TYPES = [
  {
    name: 'Purchase Request',
    code: 'PURCHASE',
    description: 'Used by employees to request the purchase of equipment, products, software, office supplies or other business-related items.',
    fields: [
      text('itemName', 'Item Name', 'TEXT', true, { minLength: 2, maxLength: 100 }),
      select('purchaseCategory', 'Purchase Category', ['Laptop', 'Desktop', 'Monitor', 'Mobile Phone', 'Software', 'Office Supplies', 'Furniture', 'Other']),
      number('quantity', 'Quantity', { min: 1, max: 1000, integer: true }),
      number('estimatedCost', 'Estimated Cost', { min: 1, max: 5000000 }, 'AMOUNT'),
      text('justification', 'Business Justification', 'TEXTAREA', true, { minLength: 10, maxLength: 1000 }, {
        requiredWhen: { field: 'estimatedCost', operator: 'GREATER_THAN', value: 50000 },
      }),
      text('laptopSpecifications', 'Laptop Specifications', 'TEXTAREA', false, { maxLength: 1000 }, {
        visibleWhen: { field: 'purchaseCategory', operator: 'EQUALS', value: 'Laptop' },
      }),
      text('softwareDetails', 'Software Details', 'TEXTAREA', false, { maxLength: 1000 }, {
        visibleWhen: { field: 'purchaseCategory', operator: 'EQUALS', value: 'Software' },
      }),
      date('requiredBy', 'Required By', true, { notPast: true }),
    ],
  },
  {
    name: 'Leave Request',
    code: 'LEAVE',
    description: 'Used by employees to request planned or unplanned leave.',
    fields: [
      select('leaveType', 'Leave Type', ['Casual Leave', 'Sick Leave', 'Earned Leave', 'Privilege Leave', 'Unpaid Leave', 'Other']),
      date('startDate', 'Start Date', true, { notPast: true }),
      date('endDate', 'End Date', true, { notPast: true, gteField: 'startDate' }),
      number('leaveDuration', 'Leave Duration', { min: 1 }),
      text('reason', 'Reason for Leave', 'TEXTAREA', true, { minLength: 5, maxLength: 1000 }),
      text('additionalExplanation', 'Additional Explanation', 'TEXTAREA', false, { maxLength: 1000 }),
      text('medicalCertificateDetails', 'Medical Certificate Details', 'TEXTAREA', false, { maxLength: 1000 }, {
        visibleWhen: { field: 'leaveType', operator: 'EQUALS', value: 'Sick Leave' },
      }),
      text('otherLeaveExplanation', 'Other Leave Explanation', 'TEXTAREA', false, { maxLength: 1000 }, {
        visibleWhen: { field: 'leaveType', operator: 'EQUALS', value: 'Other' },
      }),
    ],
  },
  {
    name: 'Access Request',
    code: 'ACCESS',
    description: 'Used by employees to request access to applications, systems, platforms or organizational resources.',
    fields: [
      text('applicationName', 'Application / Resource Name', 'TEXT', true, { minLength: 2, maxLength: 150 }),
      select('accessLevel', 'Access Level', ['Read Only', 'Read and Write', 'Editor', 'Administrator', 'Custom']),
      select('accessDuration', 'Access Duration', ['Temporary', 'Permanent']),
      date('accessEndDate', 'Access End Date', false, { notPast: true }, {
        visibleWhen: { field: 'accessDuration', operator: 'EQUALS', value: 'Temporary' },
        requiredWhen: { field: 'accessDuration', operator: 'EQUALS', value: 'Temporary' },
      }),
      text('justification', 'Business Justification', 'TEXTAREA', true, { minLength: 10, maxLength: 1000 }),
      text('additionalDetails', 'Additional Details', 'TEXTAREA', false, { maxLength: 1000 }),
      text('adminJustification', 'Administrator Access Justification', 'TEXTAREA', false, { maxLength: 1000 }, {
        visibleWhen: { field: 'accessLevel', operator: 'EQUALS', value: 'Administrator' },
        requiredWhen: { field: 'accessLevel', operator: 'EQUALS', value: 'Administrator' },
      }),
    ],
  },
  {
    name: 'Resource Request',
    code: 'RESOURCE',
    description: 'Used by employees to request organizational resources such as meeting rooms, vehicles, equipment or other shared resources.',
    fields: [
      select('resourceType', 'Resource Type', ['Meeting Room', 'Company Vehicle', 'Projector', 'Conference Equipment', 'Other']),
      text('resourceName', 'Resource Name', 'TEXT', true, { minLength: 2, maxLength: 150 }),
      number('quantity', 'Quantity', { min: 1, max: 100 }),
      date('requiredFrom', 'Required From', true, { notPast: true }),
      date('requiredUntil', 'Required Until', true, { notPast: true, gteField: 'requiredFrom' }),
      text('purpose', 'Purpose', 'TEXTAREA', true, { minLength: 10, maxLength: 1000 }),
      text('meetingRoomRequirements', 'Meeting Room Requirements', 'TEXTAREA', false, { maxLength: 1000 }, {
        visibleWhen: { field: 'resourceType', operator: 'EQUALS', value: 'Meeting Room' },
      }),
      text('vehicleRequirements', 'Vehicle Requirements', 'TEXTAREA', false, { maxLength: 1000 }, {
        visibleWhen: { field: 'resourceType', operator: 'EQUALS', value: 'Company Vehicle' },
      }),
    ],
  },
  {
    name: 'General Request',
    code: 'GENERAL',
    description: 'Used by employees for miscellaneous organizational requests that do not belong to the predefined categories.',
    fields: [
      text('subject', 'Subject', 'TEXT', true, { minLength: 3, maxLength: 150 }),
      select('requestCategory', 'Request Category', ['Administrative', 'HR', 'Finance', 'IT Support', 'Facilities', 'Other']),
      text('description', 'Description', 'TEXTAREA', true, { minLength: 10, maxLength: 2000 }),
      select('priority', 'Priority', ['Low', 'Medium', 'High', 'Urgent']),
      date('requiredBy', 'Required By', false, { notPast: true }),
      text('hrDetails', 'HR Details', 'TEXTAREA', false, { maxLength: 1500 }, {
        visibleWhen: { field: 'requestCategory', operator: 'EQUALS', value: 'HR' },
      }),
      text('itSupportDetails', 'IT Support Details', 'TEXTAREA', false, { maxLength: 1500 }, {
        visibleWhen: { field: 'requestCategory', operator: 'EQUALS', value: 'IT Support' },
      }),
    ],
  },
];

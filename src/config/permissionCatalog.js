export const PERMISSION_MODULES = [
  {
    id: 'users',
    name: 'User Management',
    permissions: [
      { id: 'users.view', name: 'View users', description: 'View user profiles within the assigned scope.' },
      { id: 'users.create', name: 'Create users', description: 'Create users and assign authorized existing roles.' },
      { id: 'users.edit', name: 'Edit users', description: 'Update user profiles and department assignments.' },
      { id: 'users.deactivate', name: 'Manage user status', description: 'Activate or deactivate organization memberships.' },
    ],
  },
  {
    id: 'departments',
    name: 'Department Management',
    permissions: [
      { id: 'departments.view', name: 'View departments', description: 'View departments within the assigned scope.' },
      { id: 'departments.create', name: 'Create departments', description: 'Create departments in the organization.' },
      { id: 'departments.edit', name: 'Manage departments', description: 'Edit departments and manage their users and managers.' },
    ],
  },
  {
    id: 'roles',
    name: 'Role Management',
    permissions: [
      { id: 'roles.view', name: 'View roles', description: 'View role definitions and assignments.' },
      { id: 'roles.create', name: 'Create roles', description: 'Create custom organization roles.' },
      { id: 'roles.edit', name: 'Manage roles', description: 'Configure permissions and role assignments.' },
    ],
  },
  {
    id: 'requests',
    name: 'Request Management',
    permissions: [
      { id: 'requests.view', name: 'View requests', description: 'View requests within the assigned scope.' },
      { id: 'requests.create', name: 'Create requests', description: 'Create access and workflow requests.' },
      { id: 'requests.edit_own_draft', name: 'Edit own draft requests', description: 'Edit draft requests created by the current user.' },
      { id: 'requests.submit', name: 'Submit own requests', description: 'Submit draft requests created by the current user.' },
      { id: 'requests.cancel_own', name: 'Cancel own requests', description: 'Cancel draft or submitted requests created by the current user.' },
      { id: 'requests.approve', name: 'Approve requests', description: 'Approve or reject requests within the assigned scope.' },
    ],
  },
  {
    id: 'requestTypes',
    name: 'Request Type Management',
    permissions: [
      { id: 'requestTypes.manage', name: 'Manage request types', description: 'Create and manage organization request types.' },
    ],
  },
  {
    id: 'workflows',
    name: 'Workflow Management',
    permissions: [
      { id: 'workflows.view', name: 'View workflows', description: 'View workflow definitions.' },
      { id: 'workflows.manage', name: 'Manage workflows', description: 'Create and update workflow definitions.' },
    ],
  },
  {
    id: 'audit_logs',
    name: 'Audit Logs',
    permissions: [
      { id: 'audit_logs.view', name: 'View audit logs', description: 'Read audit history within the assigned scope.' },
    ],
  },
  {
    id: 'dashboard',
    name: 'Dashboard',
    permissions: [
      { id: 'dashboard.view', name: 'View dashboard', description: 'View dashboard summaries.' },
    ],
  },
];

export const PERMISSION_CATALOG = PERMISSION_MODULES.flatMap((module) =>
  module.permissions.map((permission) => permission.id)
);

export default { PERMISSION_MODULES, PERMISSION_CATALOG };
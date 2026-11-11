import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import authRoutes from './modules/auth/auth.routes.js';
import organizationRoutes from './modules/organizations/organization.routes.js';
import departmentRoutes from './modules/departments/department.routes.js';
import userRoutes from './modules/users/user.routes.js';
import roleRoutes from './modules/roles/role.routes.js';
import requestRoutes from './modules/requests/request.routes.js';
import requestTypeRoutes from './modules/requests/requestType.routes.js';
import approvalWorkflowRoutes from './modules/requests/approvalWorkflow.routes.js';
import approvalRuntimeRoutes from './modules/requests/approvalRuntime.routes.js';
import approvalDelegationRoutes from './modules/requests/approvalDelegation.routes.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

const app = express();

app.set('trust proxy', 1);

app.use(
  cors({
    origin: env.CLIENT_URL,
    credentials: true,
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'accessflow-backend',
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/organizations', organizationRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/users', userRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/request-types', requestTypeRoutes);
app.use('/api/approval-workflows', approvalWorkflowRoutes);
app.use('/api/approvals', approvalRuntimeRoutes);
app.use('/api/approval-delegations', approvalDelegationRoutes);
app.use('/api/requests', requestRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;

import { env } from '../../config/env.js';
import { processApprovalMaintenance } from './approvalMaintenance.service.js';

let timer = null;
let currentRun = null;
export const startApprovalMaintenanceWorker = () => {
  if (!env.APPROVAL_WORKER_ENABLED || timer) return false;
  timer = setInterval(() => {
    if (currentRun) return;
    currentRun = processApprovalMaintenance()
      .catch((error) => console.error('Approval maintenance failed:', error.message))
      .finally(() => { currentRun = null; });
  }, env.APPROVAL_WORKER_INTERVAL_MS);
  timer.unref?.();
  return true;
};

export const stopApprovalMaintenanceWorker = async () => {
  if (timer) clearInterval(timer);
  timer = null;
  if (currentRun) await currentRun;
};

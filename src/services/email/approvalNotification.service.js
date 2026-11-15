import { sendEmail } from './email.service.js';
import User from '../../models/User.js';

const preferenceForEvent = {
  assigned: 'approvalTasks',
  request_submitted: 'requestUpdates',
  approved: 'requestUpdates',
  rejected: 'requestUpdates',
  returned: 'requestUpdates',
  cancelled: 'requestUpdates',
  request_approved: 'requestUpdates',
  delegated_action: 'delegationUpdates',
  claim_expired: 'approvalTasks',
  reminder: 'slaReminders',
  overdue: 'overdueAlerts',
  escalated: 'escalationAlerts',
};

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

export const sendApprovalNotification = async ({ recipient, subject, event, request, step }) => {
  if (!recipient?.email) return;
  const preferences = recipient.preferences || (
    recipient._id
      ? (await User.findById(recipient._id).select('preferences').lean())?.preferences
      : null
  );
  const eventPreference = preferenceForEvent[event];
  if (preferences?.notifications?.email === false ||
      (eventPreference && preferences?.notifications?.[eventPreference] === false)) return;
  const requestNumber = request?.requestNumber || 'Unknown request';
  const requestType = request?.requestTypeName || request?.requestType || '';
  const stageName = step?.stageName || 'Approval stage';
  const dueText = step?.slaDueAt ? new Date(step.slaDueAt).toISOString() : 'Not configured';
  const text = [
    `AccessFlow approval ${event}.`,
    `Request: ${requestNumber}`,
    `Request type: ${requestType}`,
    `Stage: ${stageName}`,
    `Due: ${dueText}`,
  ].join('\n');
  await sendEmail({
    to: recipient.email,
    subject,
    text,
    html: `<p>AccessFlow approval ${escape(event)}.</p><p>Request: ${escape(requestNumber)}<br>Stage: ${escape(stageName)}<br>Due: ${escape(dueText)}</p>`,
  });
};

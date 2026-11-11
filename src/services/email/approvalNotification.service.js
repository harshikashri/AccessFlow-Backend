import { sendEmail } from './email.service.js';

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

export const sendApprovalNotification = async ({ recipient, subject, event, request, step }) => {
  if (!recipient?.email) return;
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

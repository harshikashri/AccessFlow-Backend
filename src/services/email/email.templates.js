const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (character) => {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return entities[character];
  });

const renderEmail = ({ heading, name, email, organizationName, link, action, expiryMinutes }) => {
  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const safeOrganization = escapeHtml(organizationName);
  const safeLink = escapeHtml(link);
  const subject = heading;
  const text = `${heading}\n\nHello ${name},\n${action}\n\nAccount: ${email}\nOrganization: ${organizationName}\n\nOpen this link within ${expiryMinutes} minutes:\n${link}\n\nIf you did not expect this message, you can ignore it.`;
  const html = `<!doctype html><html><body><main style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#17212b"><h1 style="font-size:22px">AccessFlow</h1><h2 style="font-size:18px">${escapeHtml(heading)}</h2><p>Hello ${safeName},</p><p>${escapeHtml(action)}</p><p><strong>Account:</strong> ${safeEmail}<br><strong>Organization:</strong> ${safeOrganization}</p><p><a href="${safeLink}" style="display:inline-block;padding:12px 18px;background:#156a58;color:#fff;text-decoration:none">${escapeHtml(heading)}</a></p><p>This link expires in ${expiryMinutes} minutes. If you did not expect this message, ignore it.</p></main></body></html>`;
  return { subject, html, text };
};

export const accountSetupEmail = (input) =>
  renderEmail({
    ...input,
    heading: 'Your AccessFlow account has been created',
    action: 'Your account is ready. Set a password to activate it and sign in.',
  });

export const firstTimeSetupEmail = (input) =>
  renderEmail({
    ...input,
    heading: 'Set your AccessFlow password',
    action: 'Use this secure link to set your initial password.',
  });

export const passwordResetEmail = (input) =>
  renderEmail({
    ...input,
    heading: 'Reset your AccessFlow password',
    action: 'A password reset was requested for your account.',
  });

export default { accountSetupEmail, firstTimeSetupEmail, passwordResetEmail };
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const { env } = require('../config/env');

const toNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const smtpConfig = {
  host: process.env.SMTP_HOST || process.env.EMAIL_HOST || null,
  port: toNumber(process.env.SMTP_PORT, 587),
  secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
  auth: {
    user: process.env.SMTP_USER || process.env.EMAIL_USER || null,
    pass: process.env.SMTP_PASS || process.env.EMAIL_PASS || null,
  },
};

const hasValidTransport =
  Boolean(smtpConfig.host)
  && Boolean(smtpConfig.auth.user)
  && Boolean(smtpConfig.auth.pass);

const transporter = hasValidTransport ? nodemailer.createTransport(smtpConfig) : null;

const ensureMailLog = () => {
  const logPath = path.join(env.dataDir, 'mail.log');
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return logPath;
};

const logResetEmail = (to, resetUrl, extra = {}) => {
  try {
    const logPath = ensureMailLog();
    const payload = [
      `[${new Date().toISOString()}] Password Reset`,
      `To: ${to || 'unknown'}`,
      `URL: ${resetUrl}`,
      extra.error ? `Error: ${extra.error}` : '',
      '',
    ]
      .filter(Boolean)
      .join('\n');
    fs.appendFileSync(logPath, `${payload}\n`);
  } catch {
    // Swallow log failures; password reset should remain best-effort.
  }
};

const buildResetUrl = (token) => {
  const base = (env.frontendBaseUrl || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/reset-password?token=${token}`;
};

const FROM_ADDRESS = process.env.MAIL_FROM || '"PepPro" <support@peppro.net>';

const normalizeEmailAddress = (value) => {
  if (!value) return null;
  const normalized = String(value).trim();
  return normalized && normalized.includes('@') ? normalized : null;
};

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const logPaymentInstructionsEmail = (to, meta = {}) => {
  try {
    const logPath = ensureMailLog();
    const payload = [
      `[${new Date().toISOString()}] Payment Instructions`,
      `To: ${to || 'unknown'}`,
      meta.orderId ? `Order: ${meta.orderId}` : '',
      meta.wooOrderNumber ? `Woo Order: ${meta.wooOrderNumber}` : '',
      Number.isFinite(meta.total) ? `Total: $${Number(meta.total).toFixed(2)}` : '',
      meta.note ? `Note: ${meta.note}` : '',
      meta.error ? `Error: ${meta.error}` : '',
      '',
    ]
      .filter(Boolean)
      .join('\n');
    fs.appendFileSync(logPath, `${payload}\n`);
  } catch {
    // Swallow log failures; checkout should remain best-effort.
  }
};

const sendPasswordResetEmail = async (to, token) => {
  const resetUrl = buildResetUrl(token);
  const templatePath = path.join(__dirname, '..', 'templates', 'passwordReset.html');
  const htmlTemplate = fs.readFileSync(templatePath, 'utf8');
  const html = htmlTemplate.replace('{{resetUrl}}', resetUrl);

  const mailOptions = {
    from: FROM_ADDRESS,
    to,
    subject: 'Password Reset Request',
    html,
  };

  if (!transporter) {
    logResetEmail(to, resetUrl, { note: 'SMTP transport unavailable; logged reset link locally.' });
    return;
  }

  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logResetEmail(to, resetUrl, { error: error instanceof Error ? error.message : String(error) });
    if (env.nodeEnv === 'production') {
      throw error;
    }
  }
};

const buildPaymentInstructionsSections = () => {
  const supportEmail = normalizeEmailAddress(process.env.SUPPORT_EMAIL) || 'support@peppro.net';
  const zelleRecipient = String(process.env.PAYMENT_ZELLE_RECIPIENT || '').trim();
  const zelleEmail = normalizeEmailAddress(process.env.PAYMENT_ZELLE_EMAIL);
  const zellePhone = String(process.env.PAYMENT_ZELLE_PHONE || '').trim();

  const bankName = String(process.env.PAYMENT_BANK_NAME || '').trim();
  const bankAccountName = String(process.env.PAYMENT_BANK_ACCOUNT_NAME || '').trim();
  const bankRoutingNumber = String(process.env.PAYMENT_BANK_ROUTING_NUMBER || '').trim();
  const bankAccountNumber = String(process.env.PAYMENT_BANK_ACCOUNT_NUMBER || '').trim();
  const bankAccountType = String(process.env.PAYMENT_BANK_ACCOUNT_TYPE || '').trim();

  const zelleLines = [];
  if (zelleRecipient) zelleLines.push(`<li><strong>Recipient</strong>: ${escapeHtml(zelleRecipient)}</li>`);
  if (zelleEmail) zelleLines.push(`<li><strong>Zelle email</strong>: ${escapeHtml(zelleEmail)}</li>`);
  if (zellePhone) zelleLines.push(`<li><strong>Zelle phone</strong>: ${escapeHtml(zellePhone)}</li>`);

  const bankLines = [];
  if (bankName) bankLines.push(`<li><strong>Bank</strong>: ${escapeHtml(bankName)}</li>`);
  if (bankAccountName) bankLines.push(`<li><strong>Account name</strong>: ${escapeHtml(bankAccountName)}</li>`);
  if (bankRoutingNumber) bankLines.push(`<li><strong>Routing number</strong>: ${escapeHtml(bankRoutingNumber)}</li>`);
  if (bankAccountNumber) bankLines.push(`<li><strong>Account number</strong>: ${escapeHtml(bankAccountNumber)}</li>`);
  if (bankAccountType) bankLines.push(`<li><strong>Account type</strong>: ${escapeHtml(bankAccountType)}</li>`);

  const zelleSection = zelleLines.length
    ? `
      <h3 style="margin: 18px 0 8px; font-size: 16px; color: #0f172a;">Option A: Pay with Zelle</h3>
      <p style="margin: 8px 0 0; color: #334155; line-height: 1.6;">
        Use Zelle in your bank app and send the <strong>Amount to send</strong> shown above to:
      </p>
      <ul style="margin: 8px 0 0 18px; padding: 0; color: #334155; line-height: 1.6;">
        ${zelleLines.join('\n')}
      </ul>
      <ol style="margin: 10px 0 0 18px; padding: 0; color: #334155; line-height: 1.6;">
        <li>Send the exact amount shown above.</li>
        <li>Set the memo/notes to the exact value shown above.</li>
        <li>Once received, we’ll begin processing your order.</li>
      </ol>
    `
    : `
      <h3 style="margin: 18px 0 8px; font-size: 16px; color: #0f172a;">Option A: Pay with Zelle</h3>
      <p style="margin: 8px 0 0; color: #334155; line-height: 1.6;">
        Reply to this email or contact <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a> for Zelle instructions.
      </p>
    `;

  const bankSection = bankLines.length
    ? `
      <h3 style="margin: 18px 0 8px; font-size: 16px; color: #0f172a;">Option B: Direct Bank Transfer</h3>
      <p style="margin: 8px 0 0; color: #334155; line-height: 1.6;">
        Initiate an ACH/bank transfer for the <strong>Amount to send</strong> shown above using:
      </p>
      <ul style="margin: 8px 0 0 18px; padding: 0; color: #334155; line-height: 1.6;">
        ${bankLines.join('\n')}
      </ul>
      <ol style="margin: 10px 0 0 18px; padding: 0; color: #334155; line-height: 1.6;">
        <li>Send the exact amount shown above.</li>
        <li>Include the memo/notes shown above (if your bank allows).</li>
        <li>Once received, we’ll begin processing your order.</li>
      </ol>
    `
    : `
      <h3 style="margin: 18px 0 8px; font-size: 16px; color: #0f172a;">Option B: Direct Bank Transfer</h3>
      <p style="margin: 8px 0 0; color: #334155; line-height: 1.6;">
        Reply to this email or contact <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a> for bank transfer instructions.
      </p>
    `;

  return { supportEmail, zelleSection, bankSection };
};

const sendOrderPaymentInstructionsEmail = async ({
  to,
  customerName,
  orderId,
  wooOrderNumber,
  total,
}) => {
  const recipient = normalizeEmailAddress(to);
  if (!recipient) {
    return;
  }

  const templatePath = path.join(__dirname, '..', 'templates', 'paymentInstructions.html');
  const htmlTemplate = fs.readFileSync(templatePath, 'utf8');
  const displayOrderNumber = (wooOrderNumber || orderId || '').trim();
  const displayName = String(customerName || 'PepPro Customer').trim() || 'PepPro Customer';
  const formattedTotal = Number.isFinite(Number(total)) ? `$${Number(total).toFixed(2)}` : '';
  const { supportEmail, zelleSection, bankSection } = buildPaymentInstructionsSections();

  const html = htmlTemplate
    .replaceAll('{{customerName}}', escapeHtml(displayName))
    .replaceAll('{{orderNumber}}', escapeHtml(displayOrderNumber || ''))
    .replaceAll('{{orderTotal}}', escapeHtml(formattedTotal))
    .replaceAll('{{supportEmail}}', escapeHtml(supportEmail))
    .replaceAll('{{zelleSection}}', zelleSection)
    .replaceAll('{{bankTransferSection}}', bankSection);

  const subjectBase = process.env.PAYMENT_INSTRUCTIONS_SUBJECT || 'PepPro payment instructions';
  const subject = displayOrderNumber ? `${subjectBase} — Order ${displayOrderNumber}` : subjectBase;
  const bcc = normalizeEmailAddress(process.env.PAYMENT_INSTRUCTIONS_BCC);

  const mailOptions = {
    from: FROM_ADDRESS,
    to: recipient,
    ...(bcc ? { bcc } : {}),
    subject,
    html,
  };

  if (!transporter) {
    logPaymentInstructionsEmail(recipient, {
      orderId: orderId || null,
      wooOrderNumber: wooOrderNumber || null,
      total: Number.isFinite(Number(total)) ? Number(total) : null,
      note: 'SMTP transport unavailable; payment instructions not sent.',
    });
    return;
  }

  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logPaymentInstructionsEmail(recipient, {
      orderId: orderId || null,
      wooOrderNumber: wooOrderNumber || null,
      total: Number.isFinite(Number(total)) ? Number(total) : null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const logManualRefundReviewEmail = (to, meta = {}) => {
  try {
    const logPath = ensureMailLog();
    const payload = [
      `[${new Date().toISOString()}] Manual Refund Review`,
      `To: ${to || 'unknown'}`,
      meta.orderId ? `Order: ${meta.orderId}` : '',
      meta.wooOrderNumber ? `Woo Order: ${meta.wooOrderNumber}` : '',
      meta.customerEmail ? `Customer: ${meta.customerEmail}` : '',
      meta.paymentMethod ? `Payment: ${meta.paymentMethod}` : '',
      Number.isFinite(meta.total) ? `Total: $${Number(meta.total).toFixed(2)}` : '',
      meta.reason ? `Reason: ${meta.reason}` : '',
      meta.note ? `Note: ${meta.note}` : '',
      meta.error ? `Error: ${meta.error}` : '',
      '',
    ]
      .filter(Boolean)
      .join('\n');
    fs.appendFileSync(logPath, `${payload}\n`);
  } catch {
    // Best-effort: refund review notifications should not block cancellation.
  }
};

const parseRecipientList = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return [];
  return raw
    .split(/[;,]/g)
    .map((entry) => normalizeEmailAddress(entry))
    .filter(Boolean);
};

const sendManualRefundReviewEmail = async ({
  orderId,
  wooOrderNumber,
  customerName,
  customerEmail,
  paymentMethod,
  total,
  reason,
}) => {
  const recipients = parseRecipientList(process.env.REFUND_NOTIFICATION_EMAILS);
  const supportEmail = normalizeEmailAddress(process.env.SUPPORT_EMAIL);
  const to = recipients.length > 0 ? recipients : (supportEmail ? [supportEmail] : []);
  if (to.length === 0) {
    return;
  }

  const displayOrderNumber = (wooOrderNumber || orderId || '').trim();
  const formattedTotal = Number.isFinite(Number(total)) ? `$${Number(total).toFixed(2)}` : '';
  const displayName = String(customerName || '').trim();
  const displayEmail = String(customerEmail || '').trim();
  const displayPayment = String(paymentMethod || 'Manual payment').trim();

  const subjectBase = process.env.REFUND_NOTIFICATION_SUBJECT || 'PepPro manual refund review';
  const subject = displayOrderNumber ? `${subjectBase} — Order ${displayOrderNumber}` : subjectBase;

  const html = `
    <div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; line-height: 1.45; color: #0f172a;">
      <h2 style="margin: 0 0 12px; font-size: 18px;">Manual refund review needed</h2>
      <p style="margin: 0 0 10px; color: #334155;">
        A customer cancelled an order that used a manual payment method (Zelle / bank transfer). If payment was already received, please refund manually and record the refund.
      </p>
      <table style="border-collapse: collapse; width: 100%; max-width: 640px;">
        <tr><td style="padding: 6px 0; color: #64748b; width: 160px;">Order</td><td style="padding: 6px 0;"><strong>${escapeHtml(displayOrderNumber || orderId || '')}</strong></td></tr>
        <tr><td style="padding: 6px 0; color: #64748b;">Amount</td><td style="padding: 6px 0;">${escapeHtml(formattedTotal)}</td></tr>
        <tr><td style="padding: 6px 0; color: #64748b;">Payment</td><td style="padding: 6px 0;">${escapeHtml(displayPayment)}</td></tr>
        <tr><td style="padding: 6px 0; color: #64748b;">Customer</td><td style="padding: 6px 0;">${escapeHtml([displayName, displayEmail].filter(Boolean).join(' — ') || displayEmail || '—')}</td></tr>
        <tr><td style="padding: 6px 0; color: #64748b;">Reason</td><td style="padding: 6px 0;">${escapeHtml(reason || 'Cancelled via account portal')}</td></tr>
      </table>
      <p style="margin: 12px 0 0; color: #64748b; font-size: 12px;">
        Note: Woo order status was set to <strong>Cancelled</strong>. Refunds for manual payments are handled outside of Stripe.
      </p>
    </div>
  `;

  const mailOptions = {
    from: FROM_ADDRESS,
    to: to.join(', '),
    subject,
    html,
  };

  if (!transporter) {
    logManualRefundReviewEmail(to.join(', '), {
      orderId: orderId || null,
      wooOrderNumber: wooOrderNumber || null,
      customerEmail: customerEmail || null,
      paymentMethod: paymentMethod || null,
      total: Number.isFinite(Number(total)) ? Number(total) : null,
      reason: reason || null,
      note: 'SMTP transport unavailable; refund review email not sent.',
    });
    return;
  }

  try {
    await transporter.sendMail(mailOptions);
  } catch (error) {
    logManualRefundReviewEmail(to.join(', '), {
      orderId: orderId || null,
      wooOrderNumber: wooOrderNumber || null,
      customerEmail: customerEmail || null,
      paymentMethod: paymentMethod || null,
      total: Number.isFinite(Number(total)) ? Number(total) : null,
      reason: reason || null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

module.exports = {
  sendPasswordResetEmail,
  sendOrderPaymentInstructionsEmail,
  sendManualRefundReviewEmail,
};

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

module.exports = {
  sendPasswordResetEmail,
};

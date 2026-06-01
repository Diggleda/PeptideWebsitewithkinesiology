const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Router } = require('express');
const { authenticate } = require('../middleware/authenticate');
const env = require('../config/env');
const userRepository = require('../repositories/userRepository');
const salesRepRepository = require('../repositories/salesRepRepository');
const { parseMultipartSingleFile } = require('../utils/multipart');

const router = Router();
const repoRoot = path.resolve(__dirname, '..', '..');
const manifestPath = path.join(repoRoot, 'python_backend', 'email_templates_manifest.json');
const templateRoot = path.join(repoRoot, 'python_backend', 'email_templates');
const uploadedImageAssetRoot = path.join(env.dataDir, 'uploads', 'email-center-images');
const uploadedImageAssetPattern = /^email_img_[a-f0-9]{24}\.(?:png|jpe?g|gif|webp)$/i;
const maxUploadedImageAssetBytes = 8 * 1024 * 1024;

const EMAIL_TYPE_OPTIONS = [
  { id: 'survey', label: 'Survey' },
  { id: 'announcement', label: 'Announcement' },
  { id: 'invitation', label: 'Invitation' },
  { id: 'legal_update', label: 'Legal Update' },
  { id: 'product_update', label: 'Product Update' },
  { id: 'research_network_invite', label: 'Research Network Invite' },
  { id: 'manual', label: 'Manual / Custom' },
];

const SAMPLE_VARIABLES = {
  doctor_name: 'Dr. Jane Example',
  clinic_name: 'Example Clinic',
  delegate_links_url: 'https://trufusionlabs.com/account?tab=delegate-links',
  unsubscribe_url: 'https://trufusionlabs.com/api/admin/email/unsubscribe?preview=1',
  survey_link: 'https://trufusionlabs.com/surveys/example',
  invite_link: 'https://trufusionlabs.com/invitations/example',
  message_body: 'This safe text field is controlled by an approved template.',
  support_email: 'support@trufusionlabs.com',
};

const ASSET_MAP = {
  'trufusion-logo': {
    file: 'FullLogo_Transparent_NoBuffer (18).png',
    mimeType: 'image/png',
  },
  'trufusion-leaf': {
    file: 'leafTexture.jpg',
    mimeType: 'image/jpeg',
  },
  'delegate-white-label-sessions': {
    file: 'delegate-links-white-label-email.png',
    mimeType: 'image/png',
  },
  'delegate-links-proposal-session': {
    file: 'PatientLinks4.png',
    mimeType: 'image/png',
  },
  'delegate-links-create-dialog': {
    file: 'PatientLinks3.png',
    mimeType: 'image/png',
  },
};

const normalizeRole = (role) => String(role || '')
  .trim()
  .toLowerCase()
  .replace(/[\s-]+/g, '_');

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const firstText = (...values) => values
  .map((value) => String(value || '').trim())
  .find(Boolean) || '';

const recipientName = (record) => firstText(
  record?.name,
  [record?.firstName || record?.first_name, record?.lastName || record?.last_name].filter(Boolean).join(' '),
  record?.npiProviderName,
  record?.npi_provider_name,
  record?.npiVerification?.name,
  record?.npi_verification?.name,
);

const recipientClinicName = (record) => firstText(
  record?.clinicName,
  record?.clinic_name,
  record?.officeName,
  record?.office_name,
  record?.practiceName,
  record?.practice_name,
  record?.companyName,
  record?.company_name,
  record?.company,
  record?.npiClinicName,
  record?.npi_clinic_name,
  record?.npiVerification?.organizationName,
  record?.npi_verification?.organizationName,
  record?.npiVerification?.basic?.organization_name,
  record?.npi_verification?.basic?.organization_name,
);

const recipientPreviewVariables = (recipient) => {
  const email = normalizeEmail(recipient?.email || recipient?.recipient_email);
  const type = String(recipient?.type || recipient?.recipient_type || '').trim().toLowerCase();
  const name = recipientName(recipient);
  const defaultName = type === 'physician' || type === 'doctor' ? 'Doctor' : 'there';
  return {
    doctor_name: name || defaultName,
    clinic_name: recipientClinicName(recipient) || 'your practice',
    delegate_links_url: SAMPLE_VARIABLES.delegate_links_url,
    unsubscribe_url: email
      ? `${SAMPLE_VARIABLES.unsubscribe_url}&email=${encodeURIComponent(email)}`
      : SAMPLE_VARIABLES.unsubscribe_url,
  };
};

const isVerifiedPhysician = (user) => {
  if (String(user?.role || '').trim().toLowerCase() !== 'doctor') return false;
  return !['disabled', 'inactive', 'deleted'].includes(String(user?.status || 'active').trim().toLowerCase());
};

const dedupeRecipients = (recipients) => {
  const seen = new Set();
  const result = [];
  recipients.forEach((recipient) => {
    const email = normalizeEmail(recipient?.email || recipient?.recipient_email);
    if (!email || seen.has(email)) return;
    seen.add(email);
    result.push({
      ...recipient,
      email,
      name: String(recipient?.name || recipient?.recipient_name || '').trim(),
      type: String(recipient?.type || recipient?.recipient_type || 'custom').trim() || 'custom',
    });
  });
  return result;
};

const customEmailsFromText = (value) => String(value || '')
  .split(/[\s,;]+/)
  .map(normalizeEmail)
  .filter(Boolean);

const requireEmail = (value, message) => {
  const email = normalizeEmail(value);
  if (!email) {
    const error = new Error(message || 'A recipient email is required');
    error.status = 400;
    throw error;
  }
  return email;
};

const resolveRecipients = (selection) => {
  const selected = selection && typeof selection === 'object' ? selection : {};
  const mode = String(selected.mode || 'test').trim();
  let recipients = [];
  if (mode === 'test') {
    const email = requireEmail(selected.testEmail || selected.email, 'A test recipient email is required');
    recipients = [{ email, name: 'Test Recipient', type: 'test' }];
  } else if (mode === 'selected_physician') {
    const email = requireEmail(
      selected.selectedPhysicianEmail || selected.email,
      'A selected physician email is required',
    );
    const user = userRepository.findByEmail(email);
    if (!user) {
      const error = new Error('Selected physician was not found');
      error.status = 404;
      throw error;
    }
    recipients = [{ ...user, email, name: recipientName(user), type: 'physician' }];
  } else if (mode === 'all_verified_physicians') {
    recipients = userRepository
      .getAll()
      .filter(isVerifiedPhysician)
      .map((user) => ({ ...user, email: user.email, name: recipientName(user), type: 'physician' }));
  } else if (mode === 'sales_reps') {
    recipients = salesRepRepository
      .getAll()
      .filter((rep) => !['disabled', 'inactive', 'deleted'].includes(String(rep?.status || 'active').trim().toLowerCase()))
      .map((rep) => ({ ...rep, email: rep.email, name: recipientName(rep), type: 'sales_rep' }));
  } else if (mode === 'custom') {
    const emails = Array.isArray(selected.emails)
      ? selected.emails.map(normalizeEmail)
      : customEmailsFromText(selected.customEmails || selected.emailList);
    recipients = emails.filter(Boolean).map((email) => ({ email, name: '', type: 'custom' }));
  } else {
    const error = new Error('Unsupported recipient selection');
    error.status = 400;
    throw error;
  }
  return dedupeRecipients(recipients);
};

const recipientToPreviewPayload = (recipient) => {
  const variables = recipientPreviewVariables(recipient);
  return {
    email: recipient.email,
    name: recipient.name || '',
    type: recipient.type || '',
    clinicName: variables.clinic_name || '',
    variables,
  };
};

const requireAdmin = (req, res, next) => {
  const currentUser = req.currentUser || req.user || null;
  const userId = currentUser?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const user = currentUser?.role ? currentUser : userRepository.findById(userId);
  if (normalizeRole(user?.role || currentUser?.role) !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  req.currentUser = user;
  return next();
};

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')
  .replace(/\n/g, '<br />');

const loadManifest = () => {
  const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Email template manifest must be an object');
  }
  return data;
};

const listTemplates = () => {
  const manifest = loadManifest();
  const templates = [];
  Object.entries(manifest).forEach(([category, entries]) => {
    if (!Array.isArray(entries)) return;
    entries.forEach((entry) => {
      templates.push({
        ...entry,
        category,
        variables: Array.isArray(entry.variables) ? entry.variables.map(String) : [],
      });
    });
  });
  return templates;
};

const getTemplate = (templateId) => {
  const template = listTemplates().find((entry) => String(entry.id) === String(templateId));
  if (!template) {
    const error = new Error('Email template not found');
    error.status = 404;
    throw error;
  }
  return template;
};

const loadTemplateHtml = (template) => {
  const templatePath = path.resolve(templateRoot, String(template.file || ''));
  const root = `${path.resolve(templateRoot)}${path.sep}`;
  if (!templatePath.startsWith(root)) {
    throw new Error('Invalid email template path');
  }
  return fs.readFileSync(templatePath, 'utf8');
};

const normalizeVariables = (template, suppliedVariables) => {
  const supplied = suppliedVariables && typeof suppliedVariables === 'object' ? suppliedVariables : {};
  const variables = {};
  (template.variables || []).forEach((variableName) => {
    const key = String(variableName);
    const suppliedValue = supplied[key];
    variables[key] = suppliedValue == null || String(suppliedValue).trim() === ''
      ? (SAMPLE_VARIABLES[key] || '')
      : String(suppliedValue);
  });
  return variables;
};

const restoreVariablePlaceholders = (htmlValue, template, variables) => {
  let restored = String(htmlValue || '');
  (template.variables || []).forEach((variableName) => {
    const key = String(variableName);
    const value = String(variables?.[key] || SAMPLE_VARIABLES[key] || '');
    if (!value) return;
    const placeholder = `{{ ${key} }}`;
    const candidates = Array.from(new Set([value, escapeHtml(value)]))
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    candidates.forEach((candidate) => {
      restored = restored.split(candidate).join(placeholder);
    });
  });
  return restored;
};

const normalizeCustomHtml = (value, template, variables) => {
  if (typeof value !== 'string') return '';
  const normalized = value
    .trim()
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b(?=[^>]*data-email-center-preview-(?:containment|editor-style))[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<meta\b(?=[^>]*data-email-center-preview-containment)[^>]*>/gi, '')
    .replace(/\sdata-email-center-(?:edit-target|editing|image-uploading)(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '')
    .replace(/\scontenteditable(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '')
    .replace(
      /<span\b(?=[^>]*\bdata-email-center-variable=(["']?)([a-zA-Z0-9_]+)\1)[^>]*>[\s\S]*?<\/span>/gi,
      (_match, _quote, variableName) => `{{ ${variableName} }}`,
    );
  return template ? restoreVariablePlaceholders(normalized, template, variables) : normalized;
};

const renderEmailTemplate = (templateId, suppliedVariables, customHtml) => {
  const template = getTemplate(templateId);
  const variables = normalizeVariables(template, suppliedVariables);
  const normalizedCustomHtml = normalizeCustomHtml(customHtml, template, variables);
  const source = normalizedCustomHtml || loadTemplateHtml(template);
  const html = source.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, variableName) => {
    if (!Object.prototype.hasOwnProperty.call(variables, variableName)) return '';
    return escapeHtml(variables[variableName]);
  });
  return {
    template,
    html,
    customHtml: normalizedCustomHtml || null,
    variables,
  };
};

const getAssetBaseUrl = (req) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${protocol}://${req.get('host')}/api/admin/email/assets`;
};

const getUploadedAssetBaseUrl = (req) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${protocol}://${req.get('host')}/api/admin/email`;
};

const detectUploadedImageType = (buffer, suppliedMimeType = '') => {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: 'image/png', extension: '.png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: '.jpg' };
  }
  const prefix = buffer.subarray(0, 6).toString('ascii');
  if (prefix === 'GIF87a' || prefix === 'GIF89a') {
    return { mimeType: 'image/gif', extension: '.gif' };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mimeType: 'image/webp', extension: '.webp' };
  }
  const supplied = String(suppliedMimeType || '').trim().toLowerCase();
  const error = new Error(
    ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'].includes(supplied)
      ? 'Uploaded image data does not match its file type'
      : 'Upload a PNG, JPEG, GIF, or WebP image',
  );
  error.status = 415;
  throw error;
};

const saveUploadedImageAsset = async ({ buffer, filename, mimeType, req }) => {
  if (!buffer || buffer.length === 0) {
    const error = new Error('Image file is required');
    error.status = 400;
    throw error;
  }
  if (buffer.length > maxUploadedImageAssetBytes) {
    const error = new Error(`Image file is too large (max ${Math.round((maxUploadedImageAssetBytes / (1024 * 1024)) * 10) / 10} MB)`);
    error.status = 413;
    throw error;
  }
  const detected = detectUploadedImageType(buffer, mimeType);
  await fs.promises.mkdir(uploadedImageAssetRoot, { recursive: true });
  let assetId = '';
  let assetPath = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assetId = `email_img_${crypto.randomBytes(12).toString('hex')}${detected.extension}`;
    assetPath = path.join(uploadedImageAssetRoot, assetId);
    if (!fs.existsSync(assetPath)) break;
  }
  await fs.promises.writeFile(assetPath, buffer, { flag: 'wx' });
  return {
    assetId,
    url: `${getUploadedAssetBaseUrl(req)}/uploaded-assets/${encodeURIComponent(assetId)}`,
    mimeType: detected.mimeType,
    filename: String(filename || '').trim() || assetId,
    bytes: buffer.length,
  };
};

const renderPreviewHtml = (html, req) => {
  let rewritten = String(html || '');
  const assetUrls = {};
  const baseUrl = getAssetBaseUrl(req);
  Object.keys(ASSET_MAP).forEach((contentId) => {
    const cid = `cid:${contentId}`;
    if (!rewritten.includes(cid)) return;
    const assetUrl = `${baseUrl}/${encodeURIComponent(contentId)}?preview=1`;
    assetUrls[contentId] = assetUrl;
    rewritten = rewritten.split(cid).join(escapeHtml(assetUrl));
  });
  return { html: rewritten, assetUrls };
};

router.get('/assets/:contentId', (req, res, next) => {
  try {
    const asset = ASSET_MAP[String(req.params.contentId || '')];
    if (!asset) {
      return res.status(404).json({ error: 'Email preview asset not found' });
    }
    const filePath = path.join(repoRoot, 'public', asset.file);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Email preview asset missing' });
    }
    res.setHeader('Content-Type', asset.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    return next(error);
  }
});

router.get('/uploaded-assets/:assetId', (req, res, next) => {
  try {
    const assetId = String(req.params.assetId || '').trim();
    if (!uploadedImageAssetPattern.test(assetId)) {
      return res.status(404).json({ error: 'Email image asset not found' });
    }
    const root = path.resolve(uploadedImageAssetRoot);
    const assetPath = path.resolve(root, assetId);
    if (!assetPath.startsWith(`${root}${path.sep}`) || !fs.existsSync(assetPath)) {
      return res.status(404).json({ error: 'Email image asset not found' });
    }
    const buffer = fs.readFileSync(assetPath);
    const detected = detectUploadedImageType(buffer);
    res.setHeader('Content-Type', detected.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Disposition', `inline; filename="${assetId}"`);
    return res.send(buffer);
  } catch (error) {
    return next(error);
  }
});

router.use(authenticate, requireAdmin);

router.post('/assets/upload', async (req, res, next) => {
  try {
    const parsed = await parseMultipartSingleFile(req, {
      fieldName: 'file',
      maxBytes: maxUploadedImageAssetBytes + 1024,
    });
    const asset = await saveUploadedImageAsset({
      buffer: parsed.buffer,
      filename: parsed.filename,
      mimeType: parsed.mimeType,
      req,
    });
    return res.status(201).json(asset);
  } catch (error) {
    return next(error);
  }
});

router.get('/templates', (_req, res, next) => {
  try {
    res.json({
      templates: listTemplates(),
      emailTypes: EMAIL_TYPE_OPTIONS,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/templates/:templateId/preview', (req, res, next) => {
  try {
    const rendered = renderEmailTemplate(req.params.templateId, req.query || {});
    const preview = renderPreviewHtml(rendered.html, req);
    res.json({
      ...rendered,
      html: preview.html,
      previewAssetUrls: preview.assetUrls,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/templates/:templateId/preview', (req, res, next) => {
  try {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const variables = payload.variables && typeof payload.variables === 'object' ? payload.variables : {};
    const rendered = renderEmailTemplate(req.params.templateId, variables, payload.customHtml || payload.custom_html);
    const preview = renderPreviewHtml(rendered.html, req);
    res.json({
      ...rendered,
      html: preview.html,
      previewAssetUrls: preview.assetUrls,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/recipients/estimate', (req, res, next) => {
  try {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const selection = payload.recipientSelection && typeof payload.recipientSelection === 'object'
      ? payload.recipientSelection
      : { mode: payload.mode || 'test' };
    const mode = String(selection.mode || 'test').trim();
    const templateId = String(payload.templateId || payload.template_id || '').trim();
    if (templateId) {
      const template = getTemplate(templateId);
      const allowed = new Set(template.allowed_recipient_groups || []);
      const modeToGroup = {
        test: 'test',
        selected_physician: 'physicians',
        all_verified_physicians: 'physicians',
        sales_reps: 'sales_reps',
        custom: 'custom',
      };
      const group = modeToGroup[mode];
      if (group && allowed.size > 0 && !allowed.has(group)) {
        const error = new Error('This template is not approved for the selected recipient group');
        error.status = 400;
        throw error;
      }
    }
    const recipients = resolveRecipients(selection);
    res.json({
      mode,
      recipientCount: recipients.length,
      recipients: recipients.map(recipientToPreviewPayload),
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
module.exports.__test__ = {
  listTemplates,
  renderEmailTemplate,
  renderPreviewHtml,
  resolveRecipients,
};

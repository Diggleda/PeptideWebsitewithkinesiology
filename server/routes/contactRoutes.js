const express = require('express');
const mysqlClient = require('../database/mysqlClient');
const { logger } = require('../config/logger');
const { ensureAdmin } = require('../middleware/auth');
const salesRepRepository = require('../repositories/salesRepRepository');
const salesProspectRepository = require('../repositories/salesProspectRepository');
const { verifyDoctorNpi } = require('../services/npiService');
const { computeBlindIndex, decryptText, encryptText } = require('../utils/cryptoEnvelope');

const router = express.Router();

const CONTACT_FORM_SOURCE_ALIASES = new Map([
  ['question', 'question'],
  ['questions', 'question'],
  ['footer', 'question'],
  ['footer_question', 'question'],
  ['contact', 'question'],
  ['contact_form', 'question'],
  ['join', 'join_network'],
  ['join_network', 'join_network'],
  ['join_the_network', 'join_network'],
  ['join_physician_network', 'join_network'],
  ['network', 'join_network'],
  ['main_landing', 'join_network'],
  ['landing', 'join_network'],
  ['landing_join', 'join_network'],
  ['landing_join_network', 'join_network'],
  ['partner', 'partner_application'],
  ['partner_application', 'partner_application'],
  ['partner_applications', 'partner_application'],
  ['partner_with_trufusionlabs', 'partner_application'],
  ['partnership', 'partner_application'],
  ['application', 'partner_application'],
]);

const CONTACT_FORM_MESSAGE_FIELDS = {
  question: {
    key: 'question',
    label: 'Type your question here:',
  },
  join_network: {
    key: 'heard_about_us',
    label: 'How did you hear about us?',
  },
  partner_application: {
    key: 'partnership_fit',
    label: 'How can we help each other?',
  },
};

const sourceToken = (value) => String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');

const normalizeContactFormSource = (value) => CONTACT_FORM_SOURCE_ALIASES.get(sourceToken(value)) || 'question';

const normalizeNpiNumber = (value) => String(value || '').replace(/[^0-9]/g, '').slice(0, 10);

const normalizeOptionalText = (value, maxLength = 255) => {
  const text = String(value || '').trim();
  return text ? text.slice(0, maxLength) : null;
};

const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

const normalizeWebsiteUrl = (value) => {
  const text = String(value || '').trim();
  if (!text) return null;
  const candidate = URL_SCHEME_PATTERN.test(text) ? text : `https://${text}`;
  if (/\s/.test(candidate)) {
    const error = new Error('INVALID_WEBSITE_URL');
    error.status = 400;
    throw error;
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    const error = new Error('INVALID_WEBSITE_URL');
    error.status = 400;
    throw error;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    const error = new Error('INVALID_WEBSITE_URL');
    error.status = 400;
    throw error;
  }
  const normalized = parsed.toString();
  if (normalized.length > 500) {
    const error = new Error('WEBSITE_URL_TOO_LONG');
    error.status = 400;
    throw error;
  }
  return normalized;
};

const normalizeHumanName = (value = '') =>
  String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

const HONORIFIC_TOKENS = new Set(['mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'sir', 'madam']);
const SUFFIX_TOKENS = new Set([
  'jr', 'sr', 'ii', 'iii', 'iv', 'v',
  'md', 'do', 'pa', 'pac', 'np', 'fnp', 'aprn', 'crnp', 'dnp',
  'phd', 'psyd', 'dds', 'dmd', 'rn', 'msn', 'lpn',
  'lcsw', 'lmsw', 'msw', 'lpc', 'lcpc', 'lmft', 'mft',
  'pharmd', 'rph', 'od', 'dc', 'dpt', 'pt', 'ot', 'cns', 'cnm', 'crna',
]);

const tokenizeName = (value = '') =>
  normalizeHumanName(value)
    .split(' ')
    .map((token) => token.replace(/[^a-z0-9]/g, ''))
    .filter((token) => token && !HONORIFIC_TOKENS.has(token) && !SUFFIX_TOKENS.has(token));

const middleNameTokensMatch = (a = [], b = []) => {
  if (!a.length || !b.length) return true;
  if (a.length !== b.length) return false;
  return a.every((token, index) => {
    const other = b[index];
    return token === other || token[0] === other || other[0] === token;
  });
};

const namesRoughlyMatch = (a = '', b = '') => {
  const tokensA = tokenizeName(a);
  const tokensB = tokenizeName(b);
  if (!tokensA.length || !tokensB.length) return false;
  if (tokensA.join(' ') === tokensB.join(' ')) return true;
  const firstA = tokensA[0];
  const lastA = tokensA[tokensA.length - 1];
  const firstB = tokensB[0];
  const lastB = tokensB[tokensB.length - 1];
  if (!firstA || !lastA || !firstB || !lastB) return false;
  if (firstA !== firstB || lastA !== lastB) return false;
  return middleNameTokensMatch(tokensA.slice(1, -1), tokensB.slice(1, -1));
};

const npiRegistryNameCandidates = (verification = {}) => {
  const candidates = [];
  const add = (value) => {
    const text = normalizeOptionalText(value);
    if (text && !candidates.some((candidate) => candidate.toLowerCase() === text.toLowerCase())) {
      candidates.push(text);
    }
  };
  const rawCandidates = verification?.nameCandidates || verification?.name_candidates;
  if (Array.isArray(rawCandidates)) {
    rawCandidates.forEach(add);
  }
  add(verification?.registryName);
  add(verification?.providerName);
  add(verification?.name);
  add(verification?.organizationName);
  return candidates;
};

const extractSalesCode = (body, rawSource) => {
  const explicit = body?.salesCode || body?.sales_code || body?.referralSource || body?.referral_source;
  const salesCode = String(explicit || '').trim();
  if (salesCode) return salesCode;

  const rawSourceText = String(rawSource || '').trim();
  if (rawSourceText && !CONTACT_FORM_SOURCE_ALIASES.has(sourceToken(rawSourceText))) {
    return rawSourceText;
  }
  return '';
};

const readContactField = (row, field) => {
  const decrypted = decryptText(row?.[field], { aad: { table: 'contact_forms', field } });
  if (typeof decrypted === 'string' && decrypted.trim()) {
    const text = decrypted.trim();
    if (text !== '[ENCRYPTED]') {
      return text;
    }
  }
  const legacy = decryptText(row?.[`${field}_encrypted`], { aad: { table: 'contact_forms', field } });
  if (typeof legacy === 'string' && legacy.trim()) {
    return legacy.trim();
  }
  const value = row?.[field];
  if (value == null) {
    return null;
  }
  const text = String(value).trim();
  return text && text !== '[ENCRYPTED]' ? text : null;
};

router.get('/', ensureAdmin, async (req, res) => {
  if (!mysqlClient.isEnabled()) {
    return res.status(503).json({ error: 'Contact form storage requires MySQL to be enabled.' });
  }

  try {
    const submissions = await mysqlClient.fetchAll(
      `
        SELECT id, name, email, phone, website_url, message, message_field_key, message_label, source,
               npi_number, npi_provider_name, npi_verification_status, created_at
        FROM contact_forms
        ORDER BY created_at DESC
      `,
    );
    return res.status(200).json(
      (submissions || []).map((row) => ({
        ...row,
        name: readContactField(row, 'name'),
        email: readContactField(row, 'email'),
        phone: readContactField(row, 'phone'),
        websiteUrl: row.website_url || null,
        message: readContactField(row, 'message'),
      })),
    );
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch contact forms');
    return res.status(500).json({ error: 'Unable to fetch contact forms. Please try again later.' });
  }
});

router.post('/', async (req, res) => {
  const {
    name = '',
    email = '',
    phone = '',
    message = '',
    details = '',
    note = '',
    source = '',
  } = req.body || {};
  const formSource = normalizeContactFormSource(source);
  const messageField = CONTACT_FORM_MESSAGE_FIELDS[formSource] || CONTACT_FORM_MESSAGE_FIELDS.question;
  const salesCode = extractSalesCode(req.body || {}, source);
  let websiteUrl;
  try {
    websiteUrl = normalizeWebsiteUrl(
      req.body?.websiteUrl || req.body?.website_url || req.body?.website,
    );
  } catch (error) {
    return res.status(Number(error?.status) || 400).json({ error: error?.message || 'INVALID_WEBSITE_URL' });
  }
  const npiNumber = normalizeNpiNumber(req.body?.npiNumber || req.body?.npi_number);
  const npiProviderName = normalizeOptionalText(
    req.body?.npiProviderName ||
    req.body?.npi_provider_name ||
    req.body?.npiName ||
    req.body?.npi_name,
  );
  const npiVerificationStatus = normalizeOptionalText(
    req.body?.npiVerificationStatus || req.body?.npi_verification_status,
    32,
  );
  const trimmed = {
    name: String(name).trim(),
    email: String(email).trim(),
    phone: String(phone).trim(),
    message: String(message || details || note || '').trim(),
    messageFieldKey: messageField.key,
    messageLabel: messageField.label,
    source: formSource,
    websiteUrl,
    npiNumber: npiNumber || null,
    npiProviderName,
    npiVerificationStatus,
  };

  if (formSource === 'join_network' && !/^\d{10}$/.test(npiNumber)) {
    return res.status(400).json({ error: 'NPI number is required for physician network requests.' });
  }

  if (!mysqlClient.isEnabled()) {
    return res.status(503).json({ error: 'Contact form storage requires MySQL to be enabled.' });
  }

  if (formSource === 'join_network') {
    let npiVerification;
    try {
      npiVerification = await verifyDoctorNpi(npiNumber);
    } catch (error) {
      const status = Number(error?.status) || 502;
      return res.status(status).json({ error: error?.message || 'NPI_LOOKUP_FAILED' });
    }
    const registryNames = npiRegistryNameCandidates(npiVerification);
    if (!registryNames.length) {
      return res.status(422).json({ error: 'NPI_NAME_UNAVAILABLE' });
    }
    if (!registryNames.some((registryName) => namesRoughlyMatch(trimmed.name, registryName))) {
      return res.status(422).json({ error: 'NPI_NAME_MISMATCH' });
    }
    trimmed.npiProviderName = registryNames[0];
    trimmed.npiVerificationStatus = 'verified';
  }

  try {
    const result = await mysqlClient.execute(
      `
        INSERT INTO contact_forms (
          name, email, phone, website_url, message, message_field_key, message_label, email_blind_index, source,
          npi_number, npi_provider_name, npi_verification_status
        )
        VALUES (
          :name, :email, :phone, :websiteUrl, :message, :messageFieldKey, :messageLabel, :emailBlindIndex, :source,
          :npiNumber, :npiProviderName, :npiVerificationStatus
        )
      `,
      {
        ...trimmed,
        name: encryptText(trimmed.name, { aad: { table: 'contact_forms', field: 'name' } }),
        email: encryptText(trimmed.email, { aad: { table: 'contact_forms', field: 'email' } }),
        phone: trimmed.phone
          ? encryptText(trimmed.phone, { aad: { table: 'contact_forms', field: 'phone' } })
          : null,
        message: trimmed.message
          ? encryptText(trimmed.message, { aad: { table: 'contact_forms', field: 'message' } })
          : null,
        emailBlindIndex: computeBlindIndex(trimmed.email.toLowerCase(), {
          label: 'contact_forms.email',
          normalizer: (value) => value.trim().toLowerCase(),
        }),
        websiteUrl: trimmed.websiteUrl,
        npiNumber: trimmed.npiNumber,
        npiProviderName: trimmed.npiProviderName,
        npiVerificationStatus: trimmed.npiVerificationStatus,
      },
    );

    try {
      const normalizedSource = salesCode.trim().toUpperCase();
      const rep = normalizedSource
        ? salesRepRepository
            .getAll()
            .find((candidate) => String(candidate?.salesCode || '').trim().toUpperCase() === normalizedSource)
        : null;

      const insertId = result && typeof result.insertId !== 'undefined' ? result.insertId : null;
      if (rep && insertId) {
        await salesProspectRepository.upsert({
          id: `contact_form:${insertId}`,
          salesRepId: String(rep.id || rep.salesRepId),
          contactFormId: String(insertId),
          sourceSystem: 'contact_form',
          sourceExternalId: String(insertId),
          sourcePayloadJson: {
            contactFormId: String(insertId),
            source: trimmed.source || null,
            submittedAt: new Date().toISOString(),
            contactName: trimmed.name,
            contactEmail: trimmed.email,
            contactPhone: trimmed.phone || null,
            websiteUrl: trimmed.websiteUrl,
            message: trimmed.message || null,
            messageFieldKey: trimmed.messageFieldKey,
            messageLabel: trimmed.messageLabel,
            npiNumber: trimmed.npiNumber,
            npiProviderName: trimmed.npiProviderName,
            npiVerificationStatus: trimmed.npiVerificationStatus,
          },
          status: 'contact_form',
          isManual: false,
          contactName: null,
          contactEmail: null,
          contactPhone: null,
          notes: null,
        });
      }
    } catch (error) {
      logger.warn({ err: error }, 'Failed to upsert sales prospect for contact form submission');
    }

    return res.status(200).json({ status: 'ok' });
  } catch (error) {
    logger.error({ err: error }, 'Failed to persist contact form');
    return res.status(500).json({ error: 'Unable to save your request. Please try again later.' });
  }
});

module.exports = router;

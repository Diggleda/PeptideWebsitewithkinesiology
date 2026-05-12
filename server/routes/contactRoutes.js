const express = require('express');
const mysqlClient = require('../database/mysqlClient');
const { logger } = require('../config/logger');
const { ensureAdmin } = require('../middleware/auth');
const salesRepRepository = require('../repositories/salesRepRepository');
const salesProspectRepository = require('../repositories/salesProspectRepository');
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
        SELECT id, name, email, phone, message, message_field_key, message_label, source, created_at
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
  const trimmed = {
    name: String(name).trim(),
    email: String(email).trim(),
    phone: String(phone).trim(),
    message: String(message || details || note || '').trim(),
    messageFieldKey: messageField.key,
    messageLabel: messageField.label,
    source: formSource,
  };

  if (!mysqlClient.isEnabled()) {
    return res.status(503).json({ error: 'Contact form storage requires MySQL to be enabled.' });
  }

  try {
    const result = await mysqlClient.execute(
      `
        INSERT INTO contact_forms (
          name, email, phone, message, message_field_key, message_label, email_blind_index, source
        )
        VALUES (
          :name, :email, :phone, :message, :messageFieldKey, :messageLabel, :emailBlindIndex, :source
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
            message: trimmed.message || null,
            messageFieldKey: trimmed.messageFieldKey,
            messageLabel: trimmed.messageLabel,
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

const express = require('express');
const mysqlClient = require('../database/mysqlClient');
const { logger } = require('../config/logger');
const { ensureAdmin } = require('../middleware/auth');
const salesRepRepository = require('../repositories/salesRepRepository');
const salesProspectRepository = require('../repositories/salesProspectRepository');
const { computeBlindIndex, decryptText, encryptText } = require('../utils/cryptoEnvelope');

const router = express.Router();
const ENCRYPTED_PLACEHOLDER = '[ENCRYPTED]';

router.get('/', ensureAdmin, async (req, res) => {
  if (!mysqlClient.isEnabled()) {
    return res.status(503).json({ error: 'Contact form storage requires MySQL to be enabled.' });
  }

  try {
    const submissions = await mysqlClient.fetchAll(
      `
        SELECT id, name, email, phone, name_encrypted, email_encrypted, phone_encrypted, source, created_at
        FROM contact_forms
        ORDER BY created_at DESC
      `,
    );
    return res.status(200).json(
      (submissions || []).map((row) => ({
        ...row,
        name: decryptText(row.name_encrypted) || row.name || null,
        email: decryptText(row.email_encrypted) || row.email || null,
        phone: decryptText(row.phone_encrypted) || row.phone || null,
      })),
    );
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch contact forms');
    return res.status(500).json({ error: 'Unable to fetch contact forms. Please try again later.' });
  }
});

router.post('/', async (req, res) => {
  const { name = '', email = '', phone = '', source = '' } = req.body || {};
  const trimmed = {
    name: String(name).trim(),
    email: String(email).trim(),
    phone: String(phone).trim(),
    source: String(source).trim(),
  };

  if (!mysqlClient.isEnabled()) {
    return res.status(503).json({ error: 'Contact form storage requires MySQL to be enabled.' });
  }

  try {
    const result = await mysqlClient.execute(
      `
        INSERT INTO contact_forms (
          name, email, phone, name_encrypted, email_encrypted, phone_encrypted, email_blind_index, source
        )
        VALUES (
          :name, :email, :phone, :nameEncrypted, :emailEncrypted, :phoneEncrypted, :emailBlindIndex, :source
        )
      `,
      {
        ...trimmed,
        name: ENCRYPTED_PLACEHOLDER,
        email: ENCRYPTED_PLACEHOLDER,
        phone: null,
        nameEncrypted: encryptText(trimmed.name, { aad: { table: 'contact_forms', field: 'name' } }),
        emailEncrypted: encryptText(trimmed.email, { aad: { table: 'contact_forms', field: 'email' } }),
        phoneEncrypted: trimmed.phone
          ? encryptText(trimmed.phone, { aad: { table: 'contact_forms', field: 'phone' } })
          : null,
        emailBlindIndex: computeBlindIndex(trimmed.email.toLowerCase(), {
          label: 'contact_forms.email',
          normalizer: (value) => value.trim().toLowerCase(),
        }),
      },
    );

    try {
      const normalizedSource = trimmed.source.trim().toUpperCase();
      const rep = salesRepRepository
        .getAll()
        .find((candidate) => String(candidate?.salesCode || '').trim().toUpperCase() === normalizedSource);

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

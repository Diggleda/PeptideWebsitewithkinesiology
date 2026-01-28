const express = require('express');
const mysqlClient = require('../database/mysqlClient');
const { logger } = require('../config/logger');

const router = express.Router();

router.post('/', async (req, res) => {
  const { name = '', email = '', phone = '', source = '' } = req.body || {};
  const trimmed = {
    name: String(name).trim(),
    email: String(email).trim(),
    phone: String(phone).trim(),
    source: String(source).trim(),
  };

  if (!trimmed.name || !trimmed.email) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }

  if (!mysqlClient.isEnabled()) {
    return res.status(503).json({ error: 'Contact form storage requires MySQL to be enabled.' });
  }

  try {
    await mysqlClient.execute(
      `
        INSERT INTO contact_forms (name, email, phone, source)
        VALUES (:name, :email, :phone, :source)
      `,
      trimmed,
    );
    return res.status(200).json({ status: 'ok' });
  } catch (error) {
    logger.error({ err: error }, 'Failed to persist contact form');
    return res.status(500).json({ error: 'Unable to save your request. Please try again later.' });
  }
});

module.exports = router;

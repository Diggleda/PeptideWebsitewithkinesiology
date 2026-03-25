const express = require('express');
const mysqlClient = require('../database/mysqlClient');
const { logger } = require('../config/logger');
const { authenticateOptional } = require('../middleware/authenticate');
const { encryptText } = require('../utils/cryptoEnvelope');

const router = express.Router();

router.options('/', (_req, res) => {
  res.sendStatus(204);
});

router.post('/', authenticateOptional, async (req, res) => {
  const report = String(req.body?.report || '').trim();
  if (!report) {
    return res.status(400).json({ error: 'Bug report is required.' });
  }

  if (!mysqlClient.isEnabled()) {
    return res.status(503).json({ error: 'Bug report storage requires MySQL to be enabled.' });
  }

  const userId = req.user?.id ? String(req.user.id).trim() : null;
  const name = req.user?.name ? String(req.user.name).trim() : null;
  const email = req.user?.email ? String(req.user.email).trim() : null;

  try {
    await mysqlClient.execute(
      `
        INSERT INTO bugs_reported (
          user_id, name, email, report
        )
        VALUES (
          :userId, :name, :email, :report
        )
      `,
      {
        userId,
        name: name
          ? encryptText(name, { aad: { table: 'bugs_reported', field: 'name' } })
          : null,
        email: email
          ? encryptText(email, { aad: { table: 'bugs_reported', field: 'email' } })
          : null,
        report: encryptText(report, { aad: { table: 'bugs_reported', field: 'report' } }),
      },
    );
    return res.status(200).json({ status: 'ok' });
  } catch (error) {
    logger.error({ err: error }, 'Failed to persist bug report');
    return res.status(500).json({ error: 'Unable to submit bug report. Please try again later.' });
  }
});

module.exports = router;

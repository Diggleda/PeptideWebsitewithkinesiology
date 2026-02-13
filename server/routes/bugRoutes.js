const express = require('express');
const mysqlClient = require('../database/mysqlClient');
const { logger } = require('../config/logger');

const router = express.Router();

router.options('/', (_req, res) => {
  res.sendStatus(204);
});

router.post('/', async (req, res) => {
  const report = String(req.body?.report || '').trim();
  if (!report) {
    return res.status(400).json({ error: 'Bug report is required.' });
  }

  if (!mysqlClient.isEnabled()) {
    return res.status(503).json({ error: 'Bug report storage requires MySQL to be enabled.' });
  }

  try {
    await mysqlClient.execute(
      `
        INSERT INTO bugs_reported (report)
        VALUES (:report)
      `,
      { report },
    );
    return res.status(200).json({ status: 'ok' });
  } catch (error) {
    logger.error({ err: error }, 'Failed to persist bug report');
    return res.status(500).json({ error: 'Unable to submit bug report. Please try again later.' });
  }
});

module.exports = router;

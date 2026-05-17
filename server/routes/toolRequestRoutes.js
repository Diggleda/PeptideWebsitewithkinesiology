const crypto = require('crypto');
const express = require('express');
const mysqlClient = require('../database/mysqlClient');
const { logger } = require('../config/logger');
const { authenticateOptional } = require('../middleware/authenticate');
const { encryptText } = require('../utils/cryptoEnvelope');
const { JsonStore } = require('../storage/jsonStore');
const { env } = require('../config/env');

const router = express.Router();
const toolRequestStore = new JsonStore(env.dataDir, 'tool-requests.json', []);
toolRequestStore.init();

const normalizeToolRequestSource = (value) => {
  const raw = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (raw === 'research' || raw === 'research_tab' || raw === 'account_research') {
    return 'research_tab';
  }
  return 'research_tab';
};

const makeToolRequestId = () => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
};

router.options('/', (_req, res) => {
  res.sendStatus(204);
});

router.post('/', authenticateOptional, async (req, res) => {
  const report = String(req.body?.report || req.body?.request || '').trim();
  const source = normalizeToolRequestSource(req.body?.source);
  if (!report) {
    return res.status(400).json({ error: 'Tool request is required.' });
  }

  const userId = req.user?.id ? String(req.user.id).trim() : null;
  const name = req.user?.name ? String(req.user.name).trim() : null;
  const email = req.user?.email ? String(req.user.email).trim() : null;

  try {
    if (!mysqlClient.isEnabled()) {
      const now = new Date().toISOString();
      const requests = toolRequestStore.read();
      const nextRequests = Array.isArray(requests) ? requests : [];
      const record = {
        id: makeToolRequestId(),
        userId,
        name,
        email,
        report,
        source,
        createdAt: now,
      };
      nextRequests.push(record);
      toolRequestStore.write(nextRequests);
      return res.status(200).json({ status: 'ok', id: record.id });
    }

    await mysqlClient.execute(
      `
        INSERT INTO tool_requests (
          user_id, name, email, report, source
        )
        VALUES (
          :userId, :name, :email, :report, :source
        )
      `,
      {
        userId,
        name: name
          ? encryptText(name, { aad: { table: 'tool_requests', field: 'name' } })
          : null,
        email: email
          ? encryptText(email, { aad: { table: 'tool_requests', field: 'email' } })
          : null,
        report: encryptText(report, { aad: { table: 'tool_requests', field: 'report' } }),
        source,
      },
    );
    return res.status(200).json({ status: 'ok' });
  } catch (error) {
    logger.error({ err: error }, 'Failed to persist tool request');
    return res.status(500).json({ error: 'Unable to submit tool request. Please try again later.' });
  }
});

module.exports = router;

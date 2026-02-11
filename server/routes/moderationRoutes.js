const { Router } = require('express');
const axios = require('axios');
const { authenticate } = require('../middleware/authenticate');
const { logger } = require('../config/logger');

const router = Router();

router.post('/image', authenticate, async (req, res) => {
  const startedAt = Date.now();
  const dataUrl = typeof req.body?.dataUrl === 'string' ? req.body.dataUrl : '';
  const purpose = typeof req.body?.purpose === 'string' ? req.body.purpose : null;

  const checked = Boolean(dataUrl && (dataUrl.startsWith('data:image/') || /^https?:\/\//i.test(dataUrl)));

  // Soft gate: if no API key, skip so uploads continue to work.
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    if ((process.env.MODERATION_DEBUG || '').trim()) {
      logger.info(
        { purpose, checked, userId: req.user?.id || null },
        'moderation.image.skipped missing OPENAI_API_KEY',
      );
    }
    return res.json({
      status: 'skipped',
      flagged: false,
      purpose,
      checked,
      provider: null,
      model: null,
      categories: null,
    });
  }

  if (!checked) {
    if ((process.env.MODERATION_DEBUG || '').trim()) {
      logger.warn(
        { purpose, userId: req.user?.id || null },
        'moderation.image.invalid_payload',
      );
    }
    return res.status(400).json({
      error: 'Invalid image payload; expected a data URL or http(s) URL.',
      code: 'INVALID_IMAGE',
    });
  }

  try {
    const endpoint = (process.env.OPENAI_MODERATION_URL || 'https://api.openai.com/v1/moderations').trim();

    const response = await axios.post(
      endpoint,
      {
        model: 'omni-moderation-latest',
        input: [
          {
            type: 'image_url',
            image_url: { url: dataUrl },
          },
        ],
      },
      {
        timeout: Number(process.env.OPENAI_TIMEOUT_MS || 15000),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      },
    );

    const results = Array.isArray(response.data?.results) ? response.data.results : [];
    const flagged = results.some((r) => Boolean(r && r.flagged));
    const categories = results[0]?.categories && typeof results[0].categories === 'object' ? results[0].categories : null;

    if ((process.env.MODERATION_DEBUG || '').trim()) {
      const flaggedCategories = categories
        ? Object.entries(categories)
          .filter(([, value]) => Boolean(value))
          .map(([key]) => key)
        : null;
      logger.info(
        {
          purpose,
          userId: req.user?.id || null,
          flagged,
          flaggedCategories,
          durationMs: Date.now() - startedAt,
        },
        'moderation.image.ok',
      );
    }

    return res.json({
      status: 'ok',
      flagged,
      purpose,
      checked,
      provider: 'openai',
      model: 'omni-moderation-latest',
      categories,
    });
  } catch (err) {
    // Fail-open: do not block uploads if moderation is unavailable.
    if ((process.env.MODERATION_DEBUG || '').trim()) {
      logger.warn(
        { err, purpose, userId: req.user?.id || null, durationMs: Date.now() - startedAt },
        'moderation.image.error',
      );
    }
    return res.json({
      status: 'error',
      flagged: false,
      purpose,
      checked,
      provider: 'openai',
      model: 'omni-moderation-latest',
      categories: null,
    });
  }
});

module.exports = router;

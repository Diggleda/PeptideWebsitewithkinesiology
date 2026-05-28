const { Router } = require('express');
const { authenticate, authenticateOptional } = require('../middleware/authenticate');
const resourceVersionService = require('../services/resourceVersionService');

const router = Router();

const POLL_MS = 2000;
const HEARTBEAT_MS = 20000;

const nowIso = () => new Date().toISOString();

const eventPayload = (row) => {
  const payload = {
    resource: row?.resource,
    version: Number(row?.version || 0),
    updatedAt: row?.updatedAt || nowIso(),
  };
  return `event: ${payload.resource}.changed\ndata: ${JSON.stringify(payload)}\n\n`;
};

router.get('/resource-versions', authenticate, async (req, res, next) => {
  try {
    const resources = resourceVersionService.parseResourcesParam(req.query?.resources);
    const versions = await resourceVersionService.getVersions(resources);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      resources: versions,
      fetchedAt: nowIso(),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/events', authenticateOptional, async (req, res, next) => {
  try {
    const resources = resourceVersionService.parseResourcesParam(req.query?.resources);
    let lastVersions = await resourceVersionService.getVersions(resources);
    let lastHeartbeat = Date.now();

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }
    res.write(': connected\n\n');

    const interval = setInterval(async () => {
      if (res.writableEnded || res.destroyed) {
        return;
      }

      const now = Date.now();
      if (now - lastHeartbeat >= HEARTBEAT_MS) {
        lastHeartbeat = now;
        res.write(`: heartbeat ${nowIso()}\n\n`);
      }

      let currentVersions;
      try {
        currentVersions = await resourceVersionService.getVersions(resources);
      } catch {
        currentVersions = lastVersions;
      }

      const names = Object.keys(currentVersions).sort();
      for (const name of names) {
        const previousVersion = Number(lastVersions?.[name]?.version || 0);
        const currentVersion = Number(currentVersions?.[name]?.version || 0);
        if (currentVersion > previousVersion) {
          res.write(eventPayload(currentVersions[name]));
        }
      }
      lastVersions = currentVersions;
    }, POLL_MS);

    req.on('close', () => {
      clearInterval(interval);
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

module.exports.__test__ = {
  eventPayload,
};

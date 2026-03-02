const { env } = require('../config/env');
const { logger } = require('../config/logger');
const userRepository = require('../repositories/userRepository');
const crmSeamlessService = require('../services/crmSeamlessService');
const seamlessRepository = require('../repositories/seamlessRepository');

const normalizeRole = (role) =>
  String(role || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

const ensureSalesLeadOrAdmin = (req, context = 'seamless') => {
  const userId = req.user?.id;
  if (!userId) {
    const error = new Error('Unauthorized');
    error.status = 401;
    throw error;
  }
  const user = userRepository.findById(userId);
  const role = normalizeRole(user?.role || req.user?.role);
  if (role !== 'admin' && role !== 'sales_lead' && role !== 'saleslead') {
    logger.warn({ context, userId, role }, 'Sales lead or admin access required');
    const error = new Error('Sales lead or admin access required');
    error.status = 403;
    throw error;
  }
  return user || req.user;
};

const ensureSalesRole = (req, context = 'seamless') => {
  const userId = req.user?.id;
  if (!userId) {
    const error = new Error('Unauthorized');
    error.status = 401;
    throw error;
  }
  const user = userRepository.findById(userId);
  const role = normalizeRole(user?.role || req.user?.role);
  const isSalesRep =
    role === 'sales_rep'
    || role === 'rep'
    || role === 'sales_lead'
    || role === 'saleslead'
    || role === 'admin';
  if (!isSalesRep) {
    logger.warn({ context, userId, role }, 'Sales role access required');
    const error = new Error('Sales role access required');
    error.status = 403;
    throw error;
  }
  return user || req.user;
};

const ensureFeatureEnabled = () => {
  if (env.crm?.seamlessEnabled) {
    return;
  }
  const error = new Error('CRM Seamless integration is disabled');
  error.status = 503;
  throw error;
};

const ingestWebhook = async (req, res, next) => {
  try {
    ensureFeatureEnabled();
    const payload = req.body || {};
    const result = await crmSeamlessService.ingestPayload(payload, {
      actorId: 'seamless:webhook',
      trigger: 'webhook',
    });
    return res.status(202).json({
      ok: true,
      sourceSystem: 'seamless',
      ...result,
    });
  } catch (error) {
    return next(error);
  }
};

const runBackfill = async (req, res, next) => {
  try {
    ensureFeatureEnabled();
    const user = ensureSalesLeadOrAdmin(req, 'seamless.backfill');
    const payload = req.body?.payload || req.body?.data || req.body?.leads || null;
    const result = await crmSeamlessService.runBackfill({
      actorId: user?.id || null,
      payload,
      trigger: 'manual_backfill',
    });
    return res.json({
      ok: true,
      sourceSystem: 'seamless',
      ...result,
    });
  } catch (error) {
    return next(error);
  }
};

const getHealth = async (req, res, next) => {
  try {
    ensureSalesLeadOrAdmin(req, 'seamless.health');
    const health = await crmSeamlessService.getHealth();
    return res.json({
      ok: true,
      ...health,
    });
  } catch (error) {
    return next(error);
  }
};

const getRawPayloads = async (req, res, next) => {
  try {
    ensureFeatureEnabled();
    ensureSalesRole(req, 'seamless.raw');
    const limit = Number(req.query?.limit);
    const entries = await seamlessRepository.listRawPayloads({ limit });
    return res.json({
      ok: true,
      sourceSystem: 'seamless',
      count: entries.length,
      entries,
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  ingestWebhook,
  runBackfill,
  getHealth,
  getRawPayloads,
};

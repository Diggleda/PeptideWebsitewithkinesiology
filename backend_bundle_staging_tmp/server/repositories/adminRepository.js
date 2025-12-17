const fs = require('fs');
const path = require('path');
const { logger } = require('../config/logger');

const ADMIN_CONFIG_PATH = path.resolve(process.cwd(), 'admin.json');

const normalizeEmail = (value) => (value ? String(value).trim().toLowerCase() : '');

const normalizeRecord = (record) => {
  if (!record || typeof record !== 'object') {
    return null;
  }
  const email = normalizeEmail(record.email);
  if (!email) {
    return null;
  }
  const referralCode = record.referralCode ? String(record.referralCode).trim().toUpperCase() : null;
  return { ...record, email, referralCode };
};

let cachedAdmins = null;
let cachedMtime = null;

const loadAdmins = () => {
  try {
    const stats = fs.statSync(ADMIN_CONFIG_PATH);
    if (cachedAdmins && cachedMtime && cachedMtime >= stats.mtimeMs) {
      return cachedAdmins;
    }
    const raw = fs.readFileSync(ADMIN_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const admins = Array.isArray(parsed?.admins) ? parsed.admins : [];
    const normalized = admins
      .map(normalizeRecord)
      .filter(Boolean);
    cachedAdmins = normalized;
    cachedMtime = stats.mtimeMs;
    return normalized;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn({ err: error }, 'Failed to load admin.json; defaulting to no admins');
    }
    cachedAdmins = [];
    cachedMtime = Date.now();
    return cachedAdmins;
  }
};

const findByEmail = (email) => {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const admins = loadAdmins();
  return admins.find((admin) => admin.email === normalized) || null;
};

module.exports = {
  findByEmail,
  loadAdmins,
};

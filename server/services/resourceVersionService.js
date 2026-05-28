const mysqlClient = require('../database/mysqlClient');
const { logger } = require('../config/logger');

const RESOURCE_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const memoryVersions = new Map();

const nowIso = () => new Date().toISOString();

const normalizeResourceName = (value) => {
  const name = String(value || '').trim().toLowerCase();
  if (!name || !RESOURCE_RE.test(name)) {
    throw new Error('Invalid resource name');
  }
  return name;
};

const normalizeResourceNames = (values) => {
  if (!values) return [];
  const result = [];
  const seen = new Set();
  for (const value of values) {
    try {
      const name = normalizeResourceName(value);
      if (!seen.has(name)) {
        seen.add(name);
        result.push(name);
      }
    } catch {
      // Ignore malformed resource filters; callers get valid resources only.
    }
  }
  return result;
};

const parseResourcesParam = (value) => {
  if (value == null) return [];
  const rawValues = Array.isArray(value) ? value : String(value || '').split(',');
  return normalizeResourceNames(rawValues);
};

const metadataJson = (metadata) => {
  if (!metadata || typeof metadata !== 'object') return null;
  try {
    return JSON.stringify(metadata);
  } catch {
    return null;
  }
};

const serializeRow = (row) => {
  const updatedAt = row?.updated_at ?? row?.updatedAt;
  const updatedIso = updatedAt instanceof Date
    ? updatedAt.toISOString()
    : (updatedAt ? String(updatedAt) : nowIso());
  return {
    resource: String(row?.resource_name ?? row?.resource ?? ''),
    version: Number(row?.version || 0),
    updatedAt: updatedIso,
  };
};

const memoryBump = (resourceName, metadata) => {
  const current = memoryVersions.get(resourceName) || {
    resource: resourceName,
    version: 0,
    updatedAt: nowIso(),
  };
  const next = {
    resource: resourceName,
    version: Number(current.version || 0) + 1,
    updatedAt: nowIso(),
  };
  if (metadata && typeof metadata === 'object') {
    next.metadata = { ...metadata };
  }
  memoryVersions.set(resourceName, next);
  return { ...next };
};

const memoryGet = (resources) => {
  const names = resources.length > 0 ? resources : Array.from(memoryVersions.keys()).sort();
  const rows = {};
  for (const name of names) {
    const row = memoryVersions.get(name);
    if (!row) continue;
    rows[name] = {
      resource: name,
      version: Number(row.version || 0),
      updatedAt: row.updatedAt || nowIso(),
    };
  }
  return rows;
};

const bump = async (resourceName, { metadata } = {}) => {
  const name = normalizeResourceName(resourceName);
  if (!mysqlClient.isEnabled()) {
    return memoryBump(name, metadata);
  }

  try {
    await mysqlClient.execute(
      `
        INSERT INTO resource_versions (resource_name, version, updated_at, metadata_json)
        VALUES (:resourceName, 1, UTC_TIMESTAMP(), :metadataJson)
        ON DUPLICATE KEY UPDATE
          version = version + 1,
          updated_at = UTC_TIMESTAMP(),
          metadata_json = COALESCE(VALUES(metadata_json), metadata_json)
      `,
      {
        resourceName: name,
        metadataJson: metadataJson(metadata),
      },
    );
    const row = await mysqlClient.fetchOne(
      `
        SELECT resource_name, version, updated_at
        FROM resource_versions
        WHERE resource_name = :resourceName
      `,
      { resourceName: name },
    );
    return serializeRow(row || { resource_name: name, version: 1 });
  } catch (error) {
    logger.warn({ err: error, resource: name }, 'Failed to bump resource version');
    return memoryBump(name, metadata);
  }
};

const bumpMany = async (resources, { metadata } = {}) => {
  const rows = {};
  for (const name of normalizeResourceNames(resources)) {
    rows[name] = await bump(name, { metadata });
  }
  return rows;
};

const bumpSafe = async (resourceName, options = {}) => {
  try {
    await bump(resourceName, options);
  } catch (error) {
    logger.warn({ err: error, resource: resourceName }, 'Resource version bump skipped');
  }
};

const bumpManySafe = async (resources, options = {}) => {
  try {
    await bumpMany(resources, options);
  } catch (error) {
    logger.warn({ err: error }, 'Resource version bump batch skipped');
  }
};

const getVersions = async (resources) => {
  const names = normalizeResourceNames(resources);
  if (!mysqlClient.isEnabled()) {
    return memoryGet(names);
  }

  try {
    const params = {};
    let where = '';
    if (names.length > 0) {
      const placeholders = names.map((name, index) => {
        const key = `resource${index}`;
        params[key] = name;
        return `:${key}`;
      });
      where = `WHERE resource_name IN (${placeholders.join(', ')})`;
    }
    const rows = await mysqlClient.fetchAll(
      `
        SELECT resource_name, version, updated_at
        FROM resource_versions
        ${where}
        ORDER BY resource_name ASC
      `,
      params,
    );
    const result = {};
    for (const row of rows || []) {
      const serialized = serializeRow(row);
      if (serialized.resource) {
        result[serialized.resource] = serialized;
      }
    }
    return result;
  } catch (error) {
    logger.warn({ err: error }, 'Failed to read resource versions');
    return memoryGet(names);
  }
};

module.exports = {
  bump,
  bumpMany,
  bumpSafe,
  bumpManySafe,
  getVersions,
  normalizeResourceName,
  normalizeResourceNames,
  parseResourcesParam,
  __test__: {
    memoryVersions,
  },
};

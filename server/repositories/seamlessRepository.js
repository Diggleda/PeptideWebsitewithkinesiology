const mysqlClient = require('../database/mysqlClient');
const { seamlessStore } = require('../storage');

const nowIso = () => new Date().toISOString();

const parseJsonMaybe = (value, fallback = null) => {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
};

const toIsoOrNull = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const normalizeEntry = (row) => {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id == null ? null : String(row.id),
    sourceSystem: String(row.sourceSystem || row.source_system || 'seamless').trim().toLowerCase() || 'seamless',
    trigger: String(row.trigger || 'webhook').trim().toLowerCase() || 'webhook',
    actorId: row.actorId == null && row.actor_id == null
      ? null
      : String(row.actorId ?? row.actor_id ?? '').trim() || null,
    payload: parseJsonMaybe(row.payload ?? row.payload_json, null),
    receivedAt: toIsoOrNull(row.receivedAt || row.received_at) || nowIso(),
    createdAt: toIsoOrNull(row.createdAt || row.created_at) || nowIso(),
  };
};

const insertRawPayload = async ({
  sourceSystem = 'seamless',
  trigger = 'webhook',
  actorId = null,
  payload,
  receivedAt = null,
}) => {
  const normalized = normalizeEntry({
    sourceSystem,
    trigger,
    actorId,
    payload,
    receivedAt: receivedAt || nowIso(),
    createdAt: nowIso(),
  });
  if (!normalized) return null;

  if (mysqlClient.isEnabled()) {
    const result = await mysqlClient.execute(
      `
        INSERT INTO seamless (
          source_system,
          trigger,
          actor_id,
          payload_json,
          received_at
        ) VALUES (
          :sourceSystem,
          :trigger,
          :actorId,
          :payloadJson,
          :receivedAt
        )
      `,
      {
        sourceSystem: normalized.sourceSystem,
        trigger: normalized.trigger,
        actorId: normalized.actorId,
        payloadJson: JSON.stringify(payload == null ? null : payload),
        receivedAt: new Date(normalized.receivedAt),
      },
    );
    const insertedId = result?.insertId != null ? String(result.insertId) : null;
    if (!insertedId) {
      return normalized;
    }
    const row = await mysqlClient.fetchOne(
      `
        SELECT
          id,
          source_system,
          trigger,
          actor_id,
          payload_json,
          received_at,
          created_at
        FROM seamless
        WHERE id = :id
        LIMIT 1
      `,
      { id: insertedId },
    );
    return normalizeEntry(row) || { ...normalized, id: insertedId };
  }

  const entries = seamlessStore.read();
  const list = Array.isArray(entries) ? entries : [];
  const maxId = list.reduce((acc, row) => {
    const next = Number(row?.id);
    return Number.isFinite(next) ? Math.max(acc, next) : acc;
  }, 0);
  const next = {
    ...normalized,
    id: String(maxId + 1),
  };
  list.push(next);
  seamlessStore.write(list);
  return next;
};

const listRawPayloads = async ({ limit = 20 } = {}) => {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 200));

  if (mysqlClient.isEnabled()) {
    const rows = await mysqlClient.fetchAll(
      `
        SELECT
          id,
          source_system,
          trigger,
          actor_id,
          payload_json,
          received_at,
          created_at
        FROM seamless
        ORDER BY created_at DESC, id DESC
        LIMIT ${safeLimit}
      `,
    );
    return (rows || []).map(normalizeEntry).filter(Boolean);
  }

  const entries = seamlessStore.read();
  const list = Array.isArray(entries) ? entries : [];
  return list
    .map(normalizeEntry)
    .filter(Boolean)
    .sort((a, b) => {
      const aMs = Date.parse(String(a.createdAt || a.receivedAt || '')) || 0;
      const bMs = Date.parse(String(b.createdAt || b.receivedAt || '')) || 0;
      if (aMs !== bMs) return bMs - aMs;
      return Number(b.id || 0) - Number(a.id || 0);
    })
    .slice(0, safeLimit);
};

module.exports = {
  insertRawPayload,
  listRawPayloads,
};


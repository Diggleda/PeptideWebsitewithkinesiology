const crypto = require('crypto');
const mysqlClient = require('../database/mysqlClient');
const { salesProspectQuoteStore } = require('../storage');
const { decryptJson, encryptJson } = require('../utils/cryptoEnvelope');

const normalizeId = (value) => {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
};

const toIsoString = (value) => {
  if (!value) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
};

const toMoney = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round((numeric + Number.EPSILON) * 100) / 100;
};

const nowIso = () => new Date().toISOString();

const ensureDefaults = (record) => {
  if (!record || typeof record !== 'object') {
    return record;
  }

  const id = normalizeId(record.id);
  const createdAt = toIsoString(record.createdAt || record.created_at) || nowIso();
  const updatedAt = toIsoString(record.updatedAt || record.updated_at) || createdAt;
  const exportedAt = toIsoString(record.exportedAt || record.exported_at);
  const encryptedPayload = record.quote_payload_encrypted || null;
  const rawPayload = record.quotePayloadJson || record.quote_payload_json || null;
  const payload = (() => {
    const aad = {
      table: 'sales_prospect_quotes',
      record_ref: id || 'pending',
      field: 'quote_payload_json',
    };
    const decryptedInline = decryptJson(rawPayload, { aad });
    if (decryptedInline && typeof decryptedInline === 'object') {
      return decryptedInline;
    }
    const decryptedLegacy = decryptJson(encryptedPayload, { aad });
    if (decryptedLegacy && typeof decryptedLegacy === 'object') {
      return decryptedLegacy;
    }
    if (rawPayload && typeof rawPayload === 'object') {
      return rawPayload;
    }
    if (typeof rawPayload === 'string') {
      try {
        return JSON.parse(rawPayload);
      } catch {
        return null;
      }
    }
    return null;
  })();

  return {
    id,
    prospectId: normalizeId(record.prospectId || record.prospect_id),
    salesRepId: normalizeId(record.salesRepId || record.sales_rep_id),
    revisionNumber: Math.max(1, Math.floor(Number(record.revisionNumber || record.revision_number) || 1)),
    status: String(record.status || 'draft').trim().toLowerCase() || 'draft',
    title: normalizeId(record.title) || 'Quote',
    currency: String(record.currency || 'USD').trim().toUpperCase() || 'USD',
    subtotal: toMoney(record.subtotal),
    quotePayloadJson: payload,
    createdAt,
    updatedAt,
    exportedAt,
  };
};

const rowToRecord = (row) => (row ? ensureDefaults(row) : null);

const toDbParams = (record) => ({
  id: record.id,
  prospectId: record.prospectId,
  salesRepId: record.salesRepId,
  revisionNumber: record.revisionNumber,
  status: record.status,
  title: record.title,
  currency: record.currency,
  subtotal: toMoney(record.subtotal),
  quotePayloadJson:
    record.quotePayloadJson && typeof record.quotePayloadJson === 'object'
      ? encryptJson(record.quotePayloadJson, {
        aad: {
          table: 'sales_prospect_quotes',
          record_ref: record.id,
          field: 'quote_payload_json',
        },
      })
      : null,
  createdAt: record.createdAt ? new Date(record.createdAt) : new Date(),
  updatedAt: record.updatedAt ? new Date(record.updatedAt) : new Date(),
  exportedAt: record.exportedAt ? new Date(record.exportedAt) : null,
});

const readStoreRecords = () => {
  const records = typeof salesProspectQuoteStore.readCached === 'function'
    ? salesProspectQuoteStore.readCached()
    : salesProspectQuoteStore.read();
  return Array.isArray(records) ? records : [];
};

const sortQuotesDescending = (records) => [...records].sort((a, b) => {
  const revisionDelta = (Number(b?.revisionNumber) || 0) - (Number(a?.revisionNumber) || 0);
  if (revisionDelta !== 0) return revisionDelta;
  const bTime = Date.parse(String(b?.createdAt || '')) || 0;
  const aTime = Date.parse(String(a?.createdAt || '')) || 0;
  if (bTime !== aTime) return bTime - aTime;
  return String(b?.id || '').localeCompare(String(a?.id || ''));
});

const getAll = async () => {
  if (mysqlClient.isEnabled()) {
    const rows = await mysqlClient.fetchAll('SELECT * FROM sales_prospect_quotes');
    return (rows || []).map(rowToRecord).filter(Boolean);
  }
  return readStoreRecords().map(ensureDefaults).filter(Boolean);
};

const findById = async (id) => {
  const target = normalizeId(id);
  if (!target) return null;
  if (mysqlClient.isEnabled()) {
    const row = await mysqlClient.fetchOne(
      'SELECT * FROM sales_prospect_quotes WHERE id = :id LIMIT 1',
      { id: target },
    );
    return rowToRecord(row);
  }
  return readStoreRecords().map(ensureDefaults).find((record) => record.id === target) || null;
};

const listByProspectId = async (prospectId) => {
  const target = normalizeId(prospectId);
  if (!target) return [];
  if (mysqlClient.isEnabled()) {
    const rows = await mysqlClient.fetchAll(
      `
        SELECT * FROM sales_prospect_quotes
        WHERE prospect_id = :prospectId
        ORDER BY revision_number DESC, created_at DESC
      `,
      { prospectId: target },
    );
    return sortQuotesDescending((rows || []).map(rowToRecord).filter(Boolean));
  }
  return sortQuotesDescending(
    readStoreRecords()
      .map(ensureDefaults)
      .filter((record) => record.prospectId === target),
  );
};

const findActiveDraftByProspectId = async (prospectId) => {
  const records = await listByProspectId(prospectId);
  return records.find((record) => record.status === 'draft') || null;
};

const deleteById = async (id) => {
  const target = normalizeId(id);
  if (!target) return false;

  if (mysqlClient.isEnabled()) {
    const result = await mysqlClient.execute(
      'DELETE FROM sales_prospect_quotes WHERE id = :id',
      { id: target },
    );
    if (typeof result === 'number') {
      return result > 0;
    }
    if (result && typeof result.affectedRows === 'number') {
      return result.affectedRows > 0;
    }
    return Boolean(result);
  }

  const records = salesProspectQuoteStore.read();
  const next = Array.isArray(records) ? records : [];
  const filtered = next.filter((record) => normalizeId(record?.id) !== target);
  if (filtered.length === next.length) {
    return false;
  }
  salesProspectQuoteStore.write(filtered);
  return true;
};

const upsert = async (quote) => {
  const incoming = quote && typeof quote === 'object' ? quote : {};
  const existing = incoming.id ? await findById(incoming.id) : null;
  const normalized = ensureDefaults({
    ...(existing || {}),
    ...incoming,
    id: normalizeId(incoming.id) || normalizeId(existing?.id) || crypto.randomUUID(),
    createdAt: existing?.createdAt || incoming.createdAt || nowIso(),
    updatedAt: incoming.updatedAt || nowIso(),
  });

  if (!normalized.id) {
    const error = new Error('Quote id is required');
    error.status = 400;
    throw error;
  }
  if (!normalized.prospectId) {
    const error = new Error('prospectId is required');
    error.status = 400;
    throw error;
  }
  if (!normalized.salesRepId) {
    const error = new Error('salesRepId is required');
    error.status = 400;
    throw error;
  }

  if (mysqlClient.isEnabled()) {
    const params = toDbParams(normalized);
    await mysqlClient.execute(
      `
        INSERT INTO sales_prospect_quotes (
          id,
          prospect_id,
          sales_rep_id,
          revision_number,
          status,
          title,
          currency,
          subtotal,
          quote_payload_json,
          created_at,
          updated_at,
          exported_at
        ) VALUES (
          :id,
          :prospectId,
          :salesRepId,
          :revisionNumber,
          :status,
          :title,
          :currency,
          :subtotal,
          :quotePayloadJson,
          :createdAt,
          :updatedAt,
          :exportedAt
        )
        ON DUPLICATE KEY UPDATE
          prospect_id = VALUES(prospect_id),
          sales_rep_id = VALUES(sales_rep_id),
          revision_number = VALUES(revision_number),
          status = VALUES(status),
          title = VALUES(title),
          currency = VALUES(currency),
          subtotal = VALUES(subtotal),
          quote_payload_json = VALUES(quote_payload_json),
          updated_at = VALUES(updated_at),
          exported_at = VALUES(exported_at)
      `,
      params,
    );
    return findById(normalized.id);
  }

  const records = salesProspectQuoteStore.read();
  const next = Array.isArray(records) ? records : [];
  const index = next.findIndex((record) => normalizeId(record?.id) === normalized.id);
  if (index >= 0) {
    next[index] = normalized;
  } else {
    next.push(normalized);
  }
  salesProspectQuoteStore.write(next);
  return normalized;
};

module.exports = {
  getAll,
  findById,
  listByProspectId,
  findActiveDraftByProspectId,
  deleteById,
  upsert,
};

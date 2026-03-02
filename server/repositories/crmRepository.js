const crypto = require('crypto');
const mysqlClient = require('../database/mysqlClient');
const {
  crmLeadActivityStore,
  crmAssignmentRulesStore,
  crmSyncCheckpointStore,
} = require('../storage');

const normalizeId = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
};

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

const toIso = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const normalizeRule = (rule, index = 0) => {
  const createdAt = toIso(rule?.createdAt || rule?.created_at) || nowIso();
  const updatedAt = toIso(rule?.updatedAt || rule?.updated_at) || createdAt;
  const priorityRaw = Number(rule?.priority);
  return {
    id: normalizeId(rule?.id) || crypto.randomUUID(),
    name: String(rule?.name || '').trim() || `Rule ${index + 1}`,
    enabled: rule?.enabled !== false,
    priority: Number.isFinite(priorityRaw) ? priorityRaw : index + 1,
    conditions: parseJsonMaybe(rule?.conditions ?? rule?.conditions_json, {}),
    assigneeSalesRepId: normalizeId(rule?.assigneeSalesRepId || rule?.assignee_sales_rep_id),
    createdAt,
    updatedAt,
  };
};

const normalizeActivity = (row) => {
  if (!row || typeof row !== 'object') return null;
  return {
    id: normalizeId(row.id) || crypto.randomUUID(),
    prospectId: normalizeId(row.prospectId || row.prospect_id),
    actorId: normalizeId(row.actorId || row.actor_id),
    eventType: String(row.eventType || row.event_type || '').trim() || 'unknown',
    eventPayload: parseJsonMaybe(row.eventPayload ?? row.event_payload_json, {}),
    createdAt: toIso(row.createdAt || row.created_at) || nowIso(),
  };
};

const normalizeCheckpoint = (row) => {
  if (!row || typeof row !== 'object') return null;
  return {
    sourceSystem: String(row.sourceSystem || row.source_system || '').trim().toLowerCase() || null,
    checkpointKey: String(row.checkpointKey || row.checkpoint_key || 'default').trim() || 'default',
    cursorValue:
      row.cursorValue == null && row.cursor_value == null
        ? null
        : String(row.cursorValue ?? row.cursor_value ?? '').trim() || null,
    cursorTimestamp: toIso(row.cursorTimestamp || row.cursor_timestamp),
    updatedAt: toIso(row.updatedAt || row.updated_at) || nowIso(),
  };
};

const listAssignmentRules = async () => {
  if (mysqlClient.isEnabled()) {
    const rows = await mysqlClient.fetchAll(
      `
        SELECT *
        FROM crm_assignment_rules
        ORDER BY priority ASC, created_at ASC
      `,
    );
    return (rows || []).map((row, index) => normalizeRule(row, index)).filter(Boolean);
  }
  const rules = crmAssignmentRulesStore.read();
  const normalized = Array.isArray(rules) ? rules.map((row, index) => normalizeRule(row, index)) : [];
  normalized.sort((a, b) => a.priority - b.priority);
  return normalized;
};

const replaceAssignmentRules = async (rules) => {
  const list = Array.isArray(rules) ? rules : [];
  const now = nowIso();
  const normalized = list.map((rule, index) => normalizeRule({
    ...rule,
    createdAt: toIso(rule?.createdAt || rule?.created_at) || now,
    updatedAt: now,
  }, index));

  if (mysqlClient.isEnabled()) {
    await mysqlClient.execute('DELETE FROM crm_assignment_rules');
    for (const rule of normalized) {
      // eslint-disable-next-line no-await-in-loop
      await mysqlClient.execute(
        `
          INSERT INTO crm_assignment_rules (
            id,
            name,
            enabled,
            priority,
            conditions_json,
            assignee_sales_rep_id,
            created_at,
            updated_at
          ) VALUES (
            :id,
            :name,
            :enabled,
            :priority,
            :conditionsJson,
            :assigneeSalesRepId,
            :createdAt,
            :updatedAt
          )
        `,
        {
          id: rule.id,
          name: rule.name,
          enabled: rule.enabled ? 1 : 0,
          priority: rule.priority,
          conditionsJson: JSON.stringify(rule.conditions || {}),
          assigneeSalesRepId: rule.assigneeSalesRepId,
          createdAt: new Date(rule.createdAt),
          updatedAt: new Date(rule.updatedAt),
        },
      );
    }
    return listAssignmentRules();
  }

  crmAssignmentRulesStore.write(normalized);
  return normalized;
};

const appendLeadActivity = async ({
  prospectId,
  actorId = null,
  eventType,
  eventPayload = {},
  createdAt = null,
}) => {
  const normalized = normalizeActivity({
    id: crypto.randomUUID(),
    prospectId,
    actorId,
    eventType,
    eventPayload,
    createdAt: createdAt || nowIso(),
  });
  if (!normalized?.prospectId) {
    return null;
  }

  if (mysqlClient.isEnabled()) {
    await mysqlClient.execute(
      `
        INSERT INTO crm_lead_activity (
          id,
          prospect_id,
          actor_id,
          event_type,
          event_payload_json,
          created_at
        ) VALUES (
          :id,
          :prospectId,
          :actorId,
          :eventType,
          :eventPayloadJson,
          :createdAt
        )
      `,
      {
        id: normalized.id,
        prospectId: normalized.prospectId,
        actorId: normalized.actorId,
        eventType: normalized.eventType,
        eventPayloadJson: JSON.stringify(normalized.eventPayload || {}),
        createdAt: new Date(normalized.createdAt),
      },
    );
    return normalized;
  }

  const existing = crmLeadActivityStore.read();
  const list = Array.isArray(existing) ? existing : [];
  list.push(normalized);
  crmLeadActivityStore.write(list);
  return normalized;
};

const listLeadActivityByProspectId = async (prospectId, { limit = 200 } = {}) => {
  const target = normalizeId(prospectId);
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  if (!target) return [];

  if (mysqlClient.isEnabled()) {
    const rows = await mysqlClient.fetchAll(
      `
        SELECT *
        FROM crm_lead_activity
        WHERE prospect_id = :prospectId
        ORDER BY created_at ASC
        LIMIT ${safeLimit}
      `,
      { prospectId: target },
    );
    return (rows || []).map(normalizeActivity).filter(Boolean);
  }

  const existing = crmLeadActivityStore.read();
  const list = Array.isArray(existing) ? existing : [];
  return list
    .map(normalizeActivity)
    .filter((entry) => entry && entry.prospectId === target)
    .sort((a, b) => {
      const aMs = Date.parse(String(a.createdAt || '')) || 0;
      const bMs = Date.parse(String(b.createdAt || '')) || 0;
      return aMs - bMs;
    })
    .slice(0, safeLimit);
};

const getSyncCheckpoint = async (sourceSystem, checkpointKey = 'default') => {
  const source = String(sourceSystem || '').trim().toLowerCase();
  const key = String(checkpointKey || 'default').trim() || 'default';
  if (!source) return null;

  if (mysqlClient.isEnabled()) {
    const row = await mysqlClient.fetchOne(
      `
        SELECT *
        FROM crm_sync_checkpoint
        WHERE source_system = :sourceSystem
          AND checkpoint_key = :checkpointKey
        LIMIT 1
      `,
      { sourceSystem: source, checkpointKey: key },
    );
    return normalizeCheckpoint(row);
  }

  const existing = crmSyncCheckpointStore.read();
  const list = Array.isArray(existing) ? existing : [];
  const found = list.find((row) => {
    const normalized = normalizeCheckpoint(row);
    return normalized?.sourceSystem === source && normalized?.checkpointKey === key;
  });
  return normalizeCheckpoint(found);
};

const setSyncCheckpoint = async ({
  sourceSystem,
  checkpointKey = 'default',
  cursorValue = null,
  cursorTimestamp = null,
}) => {
  const source = String(sourceSystem || '').trim().toLowerCase();
  const key = String(checkpointKey || 'default').trim() || 'default';
  if (!source) return null;

  const normalizedCursorValue =
    cursorValue == null ? null : String(cursorValue).trim() || null;
  const normalizedCursorTimestamp = toIso(cursorTimestamp);
  const now = nowIso();

  if (mysqlClient.isEnabled()) {
    await mysqlClient.execute(
      `
        INSERT INTO crm_sync_checkpoint (
          source_system,
          checkpoint_key,
          cursor_value,
          cursor_timestamp,
          updated_at
        ) VALUES (
          :sourceSystem,
          :checkpointKey,
          :cursorValue,
          :cursorTimestamp,
          :updatedAt
        )
        ON DUPLICATE KEY UPDATE
          cursor_value = VALUES(cursor_value),
          cursor_timestamp = VALUES(cursor_timestamp),
          updated_at = VALUES(updated_at)
      `,
      {
        sourceSystem: source,
        checkpointKey: key,
        cursorValue: normalizedCursorValue,
        cursorTimestamp: normalizedCursorTimestamp ? new Date(normalizedCursorTimestamp) : null,
        updatedAt: new Date(now),
      },
    );
    return getSyncCheckpoint(source, key);
  }

  const existing = crmSyncCheckpointStore.read();
  const list = Array.isArray(existing) ? existing : [];
  const index = list.findIndex((row) => {
    const normalized = normalizeCheckpoint(row);
    return normalized?.sourceSystem === source && normalized?.checkpointKey === key;
  });
  const next = {
    sourceSystem: source,
    checkpointKey: key,
    cursorValue: normalizedCursorValue,
    cursorTimestamp: normalizedCursorTimestamp,
    updatedAt: now,
  };
  if (index >= 0) {
    list[index] = next;
  } else {
    list.push(next);
  }
  crmSyncCheckpointStore.write(list);
  return next;
};

module.exports = {
  listAssignmentRules,
  replaceAssignmentRules,
  appendLeadActivity,
  listLeadActivityByProspectId,
  getSyncCheckpoint,
  setSyncCheckpoint,
};

const axios = require('axios');
const crypto = require('crypto');
const { env } = require('../config/env');
const { logger } = require('../config/logger');
const salesProspectRepository = require('../repositories/salesProspectRepository');
const salesRepRepository = require('../repositories/salesRepRepository');
const userRepository = require('../repositories/userRepository');
const crmRepository = require('../repositories/crmRepository');
const seamlessRepository = require('../repositories/seamlessRepository');

const SOURCE_SYSTEM = 'seamless';
const UNASSIGNED_SALES_REP_ID = 'unassigned';

const normalizeText = (value) => {
  if (value == null) return '';
  return String(value).trim();
};

const normalizeEmail = (value) => normalizeText(value).toLowerCase();

const normalizePhoneDigits = (value) => {
  if (value == null) return '';
  return String(value).replace(/[^0-9]/g, '');
};

const normalizeRole = (role) =>
  String(role || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

const nowIso = () => new Date().toISOString();
const toIsoOrNull = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const INTERNAL_STATUSES = new Set([
  'pending',
  'contacted',
  'verified',
  'account_created',
  'converted',
  'nuture',
  'contact_form',
]);

const normalizeStatus = (value) => {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return 'pending';
  if (normalized === 'new' || normalized === 'fresh') return 'pending';
  if (normalized === 'qualified' || normalized === 'verifying') return 'verified';
  if (normalized === 'nurture' || normalized === 'nurturing' || normalized === 'nuturing') return 'nuture';
  if (
    normalized === 'account created'
    || normalized === 'account-created'
    || normalized === 'accountcreated'
  ) {
    return 'account_created';
  }
  return INTERNAL_STATUSES.has(normalized) ? normalized : 'pending';
};

const pickFirst = (...values) => {
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized) return normalized;
  }
  return '';
};

const pickEmail = (...values) => {
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const candidate = normalizeEmail(item?.email || item?.address || item?.value || item);
        if (candidate) return candidate;
      }
      continue;
    }
    const candidate = normalizeEmail(value);
    if (candidate) return candidate;
  }
  return '';
};

const pickPhone = (...values) => {
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const candidate = normalizeText(item?.phone || item?.number || item?.value || item);
        if (candidate) return candidate;
      }
      continue;
    }
    const candidate = normalizeText(value);
    if (candidate) return candidate;
  }
  return '';
};

const getObjectValue = (objectValue, path) => {
  if (!objectValue || typeof objectValue !== 'object') return null;
  const segments = String(path || '')
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) return null;
  let current = objectValue;
  for (const segment of segments) {
    if (!current || typeof current !== 'object') {
      return null;
    }
    current = current[segment];
  }
  return current;
};

const pickEmailFromObjectPaths = (record, paths) => {
  for (const path of paths) {
    const value = getObjectValue(record, path);
    const email = pickEmail(value);
    if (email) return email;
  }
  return '';
};

const trimPayloadValue = (value, depth = 0) => {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > 1000 ? `${value.slice(0, 1000)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (depth >= 5) {
    return '[truncated]';
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => trimPayloadValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const output = {};
    Object.entries(value)
      .slice(0, 80)
      .forEach(([key, val]) => {
        if (typeof key === 'string' && /(image|photo|avatar|binary|blob|html)/i.test(key)) {
          return;
        }
        output[key] = trimPayloadValue(val, depth + 1);
      });
    return output;
  }
  return String(value);
};

const extractLeadRecords = (payload) => {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;

  const candidates = [
    payload?.leads,
    payload?.records,
    payload?.items,
    payload?.results,
    payload?.people,
    payload?.persons,
    payload?.data,
    payload?.data?.leads,
    payload?.data?.records,
    payload?.data?.items,
    payload?.data?.results,
    payload?.data?.contacts,
    payload?.data?.companies,
    payload?.data?.payload,
    payload?.data?.payload?.results,
    payload?.payload?.results,
    payload?.payload?.data,
    payload?.result,
    payload?.response?.data,
    payload?.event?.data,
    payload?.event?.payload?.data,
    payload?.event?.payload?.results,
    payload?.event?.lead,
    payload?.event?.contact,
    payload?.event?.company,
    payload?.lead,
    payload?.contact,
    payload?.company,
    payload?.person,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  const single = payload?.lead
    || payload?.contact
    || payload?.company
    || payload?.person
    || payload?.data;
  if (single && typeof single === 'object' && !Array.isArray(single)) {
    if (Array.isArray(single.results)) {
      return single.results;
    }
    if (Array.isArray(single.items)) {
      return single.items;
    }
    return [single];
  }

  return [];
};

const normalizeSeamlessLead = (record) => {
  const assignedRepEmail = pickEmail(
    record?.assignedRepEmail,
    record?.assigned_rep_email,
    record?.assignedEmail,
    record?.assigned_email,
    record?.assignedToEmail,
    record?.assigned_to_email,
    record?.ownerEmail,
    record?.owner_email,
    record?.assigneeEmail,
    record?.assignee_email,
    pickEmailFromObjectPaths(record, [
      'owner.email',
      'owner.workEmail',
      'assignee.email',
      'assignee.workEmail',
      'assignedTo.email',
      'assignedTo.workEmail',
      'assignedUser.email',
      'assignedUser.workEmail',
      'salesRep.email',
      'sales_rep.email',
      'user.email',
      'contact.ownerEmail',
      'contact.assigneeEmail',
    ]),
    record?.ownerEmails,
    record?.assigneeEmails,
    record?.owners,
    record?.assignees,
  );

  const assignedRepId = pickFirst(
    record?.assignedRepId,
    record?.assigned_rep_id,
    record?.ownerId,
    record?.owner_id,
    record?.assigneeId,
    record?.assignee_id,
    record?.assignedToId,
    record?.assigned_to_id,
    record?.salesRepId,
    record?.sales_rep_id,
    getObjectValue(record, 'owner.id'),
    getObjectValue(record, 'assignee.id'),
    getObjectValue(record, 'assignedTo.id'),
    getObjectValue(record, 'salesRep.id'),
  );

  const externalId = pickFirst(
    record?.apiResearchId,
    record?.api_research_id,
    record?.contactId,
    record?.contact_id,
    record?.companyId,
    record?.company_id,
    record?.requestId,
    record?.request_id,
    record?.id,
    record?.leadId,
    record?.lead_id,
    record?.personId,
    record?.person_id,
    record?.prospectId,
    record?.prospect_id,
    record?.seamlessId,
    record?.seamless_id,
    record?.resultId,
    record?.result_id,
  );

  const firstName = pickFirst(
    record?.firstName,
    record?.first_name,
    record?.contact?.firstName,
    record?.contact?.first_name,
  );
  const lastName = pickFirst(
    record?.lastName,
    record?.last_name,
    record?.contact?.lastName,
    record?.contact?.last_name,
  );
  const fullName = pickFirst(
    record?.name,
    record?.fullName,
    record?.full_name,
    record?.contactName,
    record?.contact_name,
    record?.contact?.name,
    record?.contact?.fullName,
    `${firstName} ${lastName}`.trim(),
  );

  const companyName = pickFirst(
    record?.companyName,
    record?.company_name,
    record?.companyLegalName,
    record?.company_legal_name,
    record?.organizationName,
    record?.organization_name,
    record?.accountName,
    record?.account_name,
    record?.company?.companyName,
    record?.company?.name,
    record?.company,
    record?.employer,
  );

  const email = pickEmail(
    record?.email,
    record?.personalEmail,
    record?.personal_email,
    record?.businessEmail,
    record?.business_email,
    record?.verifiedEmail,
    record?.verified_email,
    record?.workEmail,
    record?.work_email,
    record?.primaryEmail,
    record?.primary_email,
    record?.contact?.email,
    record?.person?.email,
    record?.emails,
  );

  const phone = pickPhone(
    record?.phone,
    record?.directPhone,
    record?.direct_phone,
    record?.mobile,
    record?.mobilePhone,
    record?.mobile_phone,
    record?.officePhone,
    record?.office_phone,
    record?.workPhone,
    record?.work_phone,
    record?.directDial,
    record?.direct_dial,
    record?.contact?.phone,
    record?.person?.phone,
    record?.phones,
  );

  const statusRaw = pickFirst(
    record?.status,
    record?.stage,
    record?.leadStatus,
    record?.lead_status,
    record?.pipelineStage,
    record?.pipeline_stage,
    record?.researchStatus,
    record?.research_status,
  );

  const lead = {
    externalId: externalId || null,
    contactName: fullName || companyName || null,
    contactEmail: email || null,
    contactPhone: phone || null,
    company: companyName || null,
    title: pickFirst(
      record?.title,
      record?.jobTitle,
      record?.job_title,
      record?.position,
      record?.contact?.title,
      record?.contact?.jobTitle,
    ) || null,
    status: normalizeStatus(statusRaw),
    notes: pickFirst(record?.notes, record?.description, record?.summary, record?.reason) || null,
    assignedRepEmail: assignedRepEmail || null,
    assignedRepId: assignedRepId || null,
    updatedAt: pickFirst(
      record?.updatedAt,
      record?.updated_at,
      record?.lastUpdated,
      record?.researchedAt,
      record?.researched_at,
      record?.completedAt,
      record?.completed_at,
      record?.createdAt,
      record?.created_at,
    ) || null,
    payload: trimPayloadValue(record),
  };

  return lead;
};

const computeSyncHash = (lead) =>
  crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        externalId: lead.externalId || null,
        contactName: lead.contactName || null,
        contactEmail: lead.contactEmail || null,
        contactPhone: normalizePhoneDigits(lead.contactPhone),
        company: lead.company || null,
        title: lead.title || null,
        status: lead.status || 'pending',
        notes: lead.notes || null,
      }),
      'utf8',
    )
    .digest('hex');

const asArray = (value) => {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
};

const valueMatches = (candidate, required) => {
  const left = normalizeText(candidate).toLowerCase();
  const right = normalizeText(required).toLowerCase();
  return left && right && left === right;
};

const textIncludesAny = (candidate, requiredList) => {
  const haystack = normalizeText(candidate).toLowerCase();
  if (!haystack) return false;
  return asArray(requiredList).some((entry) => {
    const needle = normalizeText(entry).toLowerCase();
    return needle && haystack.includes(needle);
  });
};

const isKnownAssignee = (assigneeSalesRepId) => {
  const normalized = normalizeText(assigneeSalesRepId);
  if (!normalized) return false;

  if (salesRepRepository.findById(normalized)) {
    return true;
  }
  const user = userRepository.findById(normalized);
  if (!user) return false;
  const role = normalizeRole(user.role);
  return role === 'sales_rep' || role === 'sales_partner' || role === 'test_rep' || role === 'rep' || role === 'sales_lead' || role === 'saleslead';
};

const resolveAssigneeByEmail = (email) => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  const rep = salesRepRepository.findByEmail(normalizedEmail);
  if (rep?.id) {
    return String(rep.id);
  }

  const users = userRepository.getAll();
  const matched = (users || []).find((candidate) => {
    const candidateEmail = normalizeEmail(candidate?.email);
    if (!candidateEmail || candidateEmail !== normalizedEmail) {
      return false;
    }
    const role = normalizeRole(candidate?.role);
    return role === 'sales_rep' || role === 'sales_partner' || role === 'test_rep' || role === 'rep' || role === 'sales_lead' || role === 'saleslead';
  });
  if (!matched) {
    return null;
  }
  return String(matched.salesRepId || matched.id || '').trim() || null;
};

const ruleMatchesLead = (rule, lead) => {
  if (!rule || rule.enabled === false) return false;
  const conditions = rule.conditions && typeof rule.conditions === 'object' ? rule.conditions : {};
  const keys = Object.keys(conditions);
  if (keys.length === 0) return true;

  const emailDomain = (() => {
    const email = normalizeEmail(lead.contactEmail);
    const at = email.lastIndexOf('@');
    return at > -1 ? email.slice(at + 1) : '';
  })();

  if (conditions.sourceSystem && !asArray(conditions.sourceSystem).some((entry) => valueMatches(SOURCE_SYSTEM, entry))) {
    return false;
  }
  if (conditions.emailDomain && !asArray(conditions.emailDomain).some((entry) => valueMatches(emailDomain, entry))) {
    return false;
  }
  if (conditions.companyIncludes && !textIncludesAny(lead.company, conditions.companyIncludes)) {
    return false;
  }
  if (conditions.titleIncludes && !textIncludesAny(lead.title, conditions.titleIncludes)) {
    return false;
  }
  if (conditions.nameIncludes && !textIncludesAny(lead.contactName, conditions.nameIncludes)) {
    return false;
  }
  if (conditions.phonePrefix) {
    const phone = normalizePhoneDigits(lead.contactPhone);
    const required = asArray(conditions.phonePrefix).map((entry) => normalizePhoneDigits(entry)).filter(Boolean);
    if (required.length > 0 && !required.some((prefix) => phone.startsWith(prefix))) {
      return false;
    }
  }
  if (conditions.equals && typeof conditions.equals === 'object') {
    const flat = {
      sourceSystem: SOURCE_SYSTEM,
      contactName: lead.contactName || '',
      contactEmail: lead.contactEmail || '',
      contactPhone: lead.contactPhone || '',
      company: lead.company || '',
      title: lead.title || '',
      status: lead.status || '',
    };
    const mismatched = Object.entries(conditions.equals).some(([key, expected]) => {
      if (!(key in flat)) return false;
      return !valueMatches(flat[key], expected);
    });
    if (mismatched) return false;
  }

  return true;
};

const resolveAssignment = (rules, lead) => {
  if (lead?.assignedRepId && isKnownAssignee(lead.assignedRepId)) {
    return {
      assignedSalesRepId: String(lead.assignedRepId),
      ruleId: 'seamless_assignee_id',
    };
  }

  if (lead?.assignedRepEmail) {
    const resolvedByEmail = resolveAssigneeByEmail(lead.assignedRepEmail);
    if (resolvedByEmail) {
      return {
        assignedSalesRepId: resolvedByEmail,
        ruleId: 'seamless_assignee_email',
      };
    }
  }

  const ordered = [...(Array.isArray(rules) ? rules : [])]
    .filter((rule) => rule && rule.enabled !== false)
    .sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0));

  for (const rule of ordered) {
    if (!ruleMatchesLead(rule, lead)) continue;
    if (!isKnownAssignee(rule.assigneeSalesRepId)) continue;
    return {
      assignedSalesRepId: String(rule.assigneeSalesRepId),
      ruleId: String(rule.id || ''),
    };
  }

  return {
    assignedSalesRepId: UNASSIGNED_SALES_REP_ID,
    ruleId: null,
  };
};

const ingestNormalizedLead = async ({
  lead,
  rules,
  actorId = null,
  trigger = 'webhook',
}) => {
  const now = nowIso();
  const syncHash = computeSyncHash(lead);
  const dedupe = { matchedBy: null, existingProspectId: null };

  let existing = null;
  if (lead.externalId) {
    existing = await salesProspectRepository.findBySourceExternalId(SOURCE_SYSTEM, lead.externalId);
    if (existing) dedupe.matchedBy = 'source_external_id';
  }
  if (!existing && lead.contactEmail) {
    existing = await salesProspectRepository.findByContactEmail(lead.contactEmail);
    if (existing) dedupe.matchedBy = 'email';
  }
  if (!existing && lead.contactPhone) {
    existing = await salesProspectRepository.findByContactPhone(lead.contactPhone);
    if (existing) dedupe.matchedBy = 'phone';
  }
  if (existing) {
    dedupe.existingProspectId = existing.id || null;
  }

  const assignment = resolveAssignment(rules, lead);
  const resolvedId = (() => {
    if (existing?.id) return String(existing.id);
    if (lead.externalId) return `seamless:${lead.externalId}`;
    const fallbackSeed = [
      lead.contactEmail || '',
      normalizePhoneDigits(lead.contactPhone),
      lead.contactName || '',
      lead.company || '',
      now,
    ].join('|');
    const hash = crypto.createHash('sha1').update(fallbackSeed, 'utf8').digest('hex').slice(0, 20);
    return `seamless:${hash}`;
  })();

  const saved = await salesProspectRepository.upsert({
    id: resolvedId,
    salesRepId: assignment.assignedSalesRepId,
    status: lead.status || 'pending',
    notes: lead.notes || null,
    isManual: false,
    contactName: lead.contactName || null,
    contactEmail: lead.contactEmail || null,
    contactPhone: lead.contactPhone || null,
    sourceSystem: SOURCE_SYSTEM,
    sourceExternalId: lead.externalId || null,
    sourcePayloadJson: lead.payload || null,
    assignedByRuleId: assignment.ruleId,
    assignedAt: assignment.ruleId ? now : null,
    lastSyncedAt: now,
    syncHash,
  });

  const previousStatus = existing?.status ? String(existing.status) : null;
  const currentStatus = saved?.status ? String(saved.status) : null;
  const previousOwner = existing?.salesRepId ? String(existing.salesRepId) : null;
  const currentOwner = saved?.salesRepId ? String(saved.salesRepId) : null;

  if (!existing || existing.syncHash !== syncHash) {
    await crmRepository.appendLeadActivity({
      prospectId: saved.id,
      actorId,
      eventType: 'ingested',
      eventPayload: {
        trigger,
        sourceSystem: SOURCE_SYSTEM,
        externalId: lead.externalId || null,
      },
      createdAt: now,
    });
  }

  if (dedupe.matchedBy) {
    await crmRepository.appendLeadActivity({
      prospectId: saved.id,
      actorId,
      eventType: 'deduped',
      eventPayload: {
        matchedBy: dedupe.matchedBy,
        existingProspectId: dedupe.existingProspectId,
      },
      createdAt: now,
    });
  }

  if (previousOwner !== currentOwner) {
    await crmRepository.appendLeadActivity({
      prospectId: saved.id,
      actorId,
      eventType: 'assigned',
      eventPayload: {
        from: previousOwner,
        to: currentOwner,
        ruleId: assignment.ruleId,
        unassigned: currentOwner === UNASSIGNED_SALES_REP_ID,
      },
      createdAt: now,
    });
  }

  if (previousStatus && currentStatus && previousStatus !== currentStatus) {
    await crmRepository.appendLeadActivity({
      prospectId: saved.id,
      actorId,
      eventType: 'stage_changed',
      eventPayload: {
        from: previousStatus,
        to: currentStatus,
      },
      createdAt: now,
    });
  }

  if (lead.notes && lead.notes !== existing?.notes) {
    await crmRepository.appendLeadActivity({
      prospectId: saved.id,
      actorId,
      eventType: 'note_added',
      eventPayload: {
        notePreview: String(lead.notes).slice(0, 280),
      },
      createdAt: now,
    });
  }

  return { saved, dedupe };
};

const ingestPayload = async (payload, { actorId = null, trigger = 'webhook' } = {}) => {
  let rawPayloadRecordId = null;
  try {
    const rawRecord = await seamlessRepository.insertRawPayload({
      sourceSystem: SOURCE_SYSTEM,
      trigger,
      actorId,
      payload,
      receivedAt: nowIso(),
    });
    rawPayloadRecordId = rawRecord?.id ? String(rawRecord.id) : null;
  } catch (error) {
    logger.warn({ err: error }, 'Failed to persist raw Seamless payload');
  }

  const records = extractLeadRecords(payload);
  const rules = await crmRepository.listAssignmentRules();
  const ingestedAt = nowIso();
  const stats = {
    received: records.length,
    processed: 0,
    created: 0,
    updated: 0,
    deduped: 0,
    assigned: 0,
    unassigned: 0,
    errors: 0,
  };

  const details = [];
  for (const raw of records) {
    const lead = normalizeSeamlessLead(raw);
    if (!lead.externalId && !lead.contactEmail && !lead.contactPhone) {
      stats.errors += 1;
      details.push({ ok: false, reason: 'missing_identifier' });
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await ingestNormalizedLead({ lead, rules, actorId, trigger });
      stats.processed += 1;
      if (result?.dedupe?.matchedBy) {
        stats.deduped += 1;
      }
      if (result?.saved?.salesRepId === UNASSIGNED_SALES_REP_ID) {
        stats.unassigned += 1;
      } else {
        stats.assigned += 1;
      }
      if (result?.dedupe?.existingProspectId) {
        stats.updated += 1;
      } else {
        stats.created += 1;
      }
      details.push({
        ok: true,
        prospectId: result?.saved?.id || null,
        dedupedBy: result?.dedupe?.matchedBy || null,
      });
    } catch (error) {
      stats.errors += 1;
      details.push({
        ok: false,
        reason: error?.message || 'ingest_failed',
      });
      logger.warn({ err: error }, 'Failed to ingest Seamless lead');
    }
  }

  await crmRepository.setSyncCheckpoint({
    sourceSystem: SOURCE_SYSTEM,
    checkpointKey: 'default',
    cursorValue: null,
    cursorTimestamp: ingestedAt,
  });

  return {
    sourceSystem: SOURCE_SYSTEM,
    trigger,
    rawPayloadRecordId,
    ingestedAt,
    stats,
    details,
  };
};

const formatDateYmd = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 10);
};

const buildSeamlessAuthHeaders = () => {
  const apiKey = normalizeText(env.seamless?.apiKey || '');
  const oauthAccessToken = normalizeText(env.seamless?.oauthAccessToken || '');
  const headers = { Accept: 'application/json' };
  if (apiKey) {
    headers.Token = apiKey;
    headers['X-API-Key'] = apiKey;
  }
  if (oauthAccessToken) {
    headers.Authorization = `Bearer ${oauthAccessToken}`;
  }
  return headers;
};

const resolveBackfillWindow = (checkpoint) => {
  const lookbackHours = Math.max(1, Number(env.seamless?.backfillLookbackHours) || 24);
  const fallbackStart = new Date(Date.now() - (lookbackHours * 60 * 60 * 1000));
  const checkpointStart = checkpoint?.cursorTimestamp ? new Date(checkpoint.cursorTimestamp) : null;
  const windowStart =
    checkpointStart && !Number.isNaN(checkpointStart.getTime()) ? checkpointStart : fallbackStart;
  const windowEnd = new Date();
  if (windowStart.getTime() > windowEnd.getTime()) {
    return {
      windowStart: fallbackStart,
      windowEnd,
    };
  }
  return { windowStart, windowEnd };
};

const fetchEndpointBackfill = async ({
  endpointPath,
  headers,
  timeoutMs,
  windowStart,
  windowEnd,
  limit,
  maxPages,
}) => {
  const path = normalizeText(endpointPath || '');
  if (!path) {
    return { records: [], pagesFetched: 0 };
  }

  const baseUrl = normalizeText(env.seamless?.apiBaseUrl || '').replace(/\/+$/, '');
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const startDate = formatDateYmd(windowStart);
  const endDate = formatDateYmd(windowEnd);
  if (!startDate || !endDate) {
    return { records: [], pagesFetched: 0 };
  }

  const records = [];
  let page = 1;
  let pagesFetched = 0;
  while (page <= maxPages) {
    // eslint-disable-next-line no-await-in-loop
    const response = await axios.get(url, {
      timeout: timeoutMs,
      headers,
      params: {
        page,
        limit,
        startDate,
        endDate,
      },
    });

    const payload = response?.data || {};
    const batch = extractLeadRecords(payload).map((item) => {
      if (!item || typeof item !== 'object') {
        return item;
      }
      return {
        ...item,
        _sourceEndpoint: path,
      };
    });
    pagesFetched += 1;
    if (batch.length === 0) {
      break;
    }

    records.push(...batch);
    const hasMoreFlag = payload?.supplementalData?.isMore;
    if (typeof hasMoreFlag === 'boolean') {
      if (!hasMoreFlag) {
        break;
      }
      page += 1;
      continue;
    }
    if (batch.length < limit) {
      break;
    }
    page += 1;
  }
  return { records, pagesFetched };
};

const fetchBackfillFromSeamlessApi = async (checkpoint) => {
  const baseUrl = normalizeText(env.seamless?.apiBaseUrl || '').replace(/\/+$/, '');
  const headers = buildSeamlessAuthHeaders();
  const hasAuth = Boolean(headers.Token || headers.Authorization);
  if (!baseUrl || !hasAuth) {
    const error = new Error('Seamless API credentials are not configured');
    error.status = 503;
    throw error;
  }

  const timeoutMs = Number(env.seamless?.requestTimeoutMs) || 15000;
  const limit = Math.max(1, Number(env.seamless?.backfillLimit) || 100);
  const maxPages = Math.max(1, Number(env.seamless?.backfillMaxPages) || 10);
  const contactsPath = normalizeText(env.seamless?.contactsPath || env.seamless?.backfillPath || '/contacts');
  const companiesPath = normalizeText(env.seamless?.companiesPath || '/companies');
  const includeCompanies = Boolean(env.seamless?.includeCompaniesBackfill);
  const { windowStart, windowEnd } = resolveBackfillWindow(checkpoint);

  const contactsResult = await fetchEndpointBackfill({
    endpointPath: contactsPath,
    headers,
    timeoutMs,
    windowStart,
    windowEnd,
    limit,
    maxPages,
  });

  const companiesResult = includeCompanies
    ? await fetchEndpointBackfill({
      endpointPath: companiesPath,
      headers,
      timeoutMs,
      windowStart,
      windowEnd,
      limit,
      maxPages,
    })
    : { records: [], pagesFetched: 0 };

  return {
    data: [...contactsResult.records, ...companiesResult.records],
    supplementalData: {
      sourceSystem: SOURCE_SYSTEM,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      backfillMode: includeCompanies ? 'contacts_and_companies' : 'contacts',
      pagesFetched: {
        contacts: contactsResult.pagesFetched,
        companies: companiesResult.pagesFetched,
      },
    },
  };
};

const runBackfill = async ({ actorId = null, payload = null, trigger = 'backfill' } = {}) => {
  const checkpoint = await crmRepository.getSyncCheckpoint(SOURCE_SYSTEM, 'default');
  const backfillPayload = payload || await fetchBackfillFromSeamlessApi(checkpoint);
  const result = await ingestPayload(backfillPayload, { actorId, trigger });

  const windowEnd = toIsoOrNull(backfillPayload?.supplementalData?.windowEnd) || result.ingestedAt;
  const pages = backfillPayload?.supplementalData?.pagesFetched || {};
  const nextCursor = [
    `contacts:${Number(pages?.contacts) || 0}`,
    `companies:${Number(pages?.companies) || 0}`,
    `windowEnd:${windowEnd}`,
  ].join('|').slice(0, 255);

  await crmRepository.setSyncCheckpoint({
    sourceSystem: SOURCE_SYSTEM,
    checkpointKey: 'default',
    cursorValue: nextCursor,
    cursorTimestamp: windowEnd,
  });

  return {
    ...result,
    fetchedWindow: {
      start: toIsoOrNull(backfillPayload?.supplementalData?.windowStart),
      end: windowEnd,
    },
    checkpoint: await crmRepository.getSyncCheckpoint(SOURCE_SYSTEM, 'default'),
  };
};

const getHealth = async () => {
  const checkpoint = await crmRepository.getSyncCheckpoint(SOURCE_SYSTEM, 'default');
  const rules = await crmRepository.listAssignmentRules();
  const baseUrl = normalizeText(env.seamless?.apiBaseUrl || '');
  const apiKey = normalizeText(env.seamless?.apiKey || '');
  const oauthAccessToken = normalizeText(env.seamless?.oauthAccessToken || '');
  const webhookSecret = normalizeText(env.seamless?.webhookSecret || '');

  return {
    sourceSystem: SOURCE_SYSTEM,
    enabled: Boolean(env.crm?.seamlessEnabled),
    apiConfigured: Boolean(baseUrl && (apiKey || oauthAccessToken)),
    authMode: (() => {
      if (apiKey && oauthAccessToken) return 'oauth_and_api_key';
      if (oauthAccessToken) return 'oauth';
      if (apiKey) return 'api_key';
      return 'none';
    })(),
    webhookSecretConfigured: Boolean(webhookSecret),
    reconciliationIntervalMs: Number(env.crm?.seamlessReconciliationIntervalMs) || 15 * 60 * 1000,
    checkpoint,
    assignmentRulesCount: rules.length,
  };
};

let seamlessReconciliationTimer = null;
let seamlessReconciliationInFlight = false;

const startSeamlessReconciliationJob = () => {
  if (seamlessReconciliationTimer) {
    return;
  }
  if (!env.crm?.seamlessEnabled) {
    logger.info('CRM Seamless reconciliation job disabled by feature flag');
    return;
  }
  const intervalMs = Math.max(
    60 * 1000,
    Number(env.crm?.seamlessReconciliationIntervalMs) || 15 * 60 * 1000,
  );

  seamlessReconciliationTimer = setInterval(async () => {
    if (seamlessReconciliationInFlight) return;
    seamlessReconciliationInFlight = true;
    try {
      await runBackfill({ actorId: 'system:seamless-job', trigger: 'scheduler' });
    } catch (error) {
      logger.warn({ err: error }, 'CRM Seamless reconciliation job failed');
    } finally {
      seamlessReconciliationInFlight = false;
    }
  }, intervalMs);

  if (typeof seamlessReconciliationTimer.unref === 'function') {
    seamlessReconciliationTimer.unref();
  }
  logger.info({ intervalMs }, 'CRM Seamless reconciliation job started');
};

module.exports = {
  SOURCE_SYSTEM,
  UNASSIGNED_SALES_REP_ID,
  ingestPayload,
  runBackfill,
  getHealth,
  startSeamlessReconciliationJob,
};

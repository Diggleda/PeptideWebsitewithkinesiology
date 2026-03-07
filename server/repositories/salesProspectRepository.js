const mysqlClient = require('../database/mysqlClient');
const { salesProspectStore } = require('../storage');
const { logger } = require('../config/logger');

const normalizeId = (value) => {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length > 0 ? str : null;
};

const normalizeEmail = (value) => {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
};

const normalizePhoneDigits = (value) => {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[^0-9]/g, '');
};

const isDoctorLinked = (record) => Boolean(normalizeId(record?.doctorId || record?.doctor_id));

const nowIso = () => new Date().toISOString();

const ensureDefaults = (record) => {
  if (!record || typeof record !== 'object') {
    return record;
  }
  const createdAt = record.createdAt || record.created_at || null;
  const updatedAt = record.updatedAt || record.updated_at || createdAt || null;
  const resellerPermitUploadedAt =
    record.resellerPermitUploadedAt || record.reseller_permit_uploaded_at || null;
  const sourcePayloadJson = record.sourcePayloadJson || record.source_payload_json || null;
  const assignedAt = record.assignedAt || record.assigned_at || null;
  const lastSyncedAt = record.lastSyncedAt || record.last_synced_at || null;
  return {
    id: normalizeId(record.id),
    salesRepId: normalizeId(record.salesRepId || record.sales_rep_id),
    doctorId: normalizeId(record.doctorId || record.doctor_id),
    referralId: normalizeId(record.referralId || record.referral_id),
    contactFormId: normalizeId(record.contactFormId || record.contact_form_id),
    sourceSystem: normalizeId(record.sourceSystem || record.source_system),
    sourceExternalId: normalizeId(record.sourceExternalId || record.source_external_id),
    sourcePayloadJson:
      sourcePayloadJson == null
        ? null
        : typeof sourcePayloadJson === 'object'
          ? sourcePayloadJson
          : (() => {
            try {
              return JSON.parse(String(sourcePayloadJson));
            } catch {
              return null;
            }
          })(),
    assignedByRuleId: normalizeId(record.assignedByRuleId || record.assigned_by_rule_id),
    assignedAt: assignedAt ? new Date(assignedAt).toISOString() : null,
    lastSyncedAt: lastSyncedAt ? new Date(lastSyncedAt).toISOString() : null,
    syncHash: normalizeId(record.syncHash || record.sync_hash),
    status: (record.status || 'pending').toString().trim().toLowerCase() || 'pending',
    notes: record.notes == null ? null : String(record.notes),
    isManual: Boolean(record.isManual) || Boolean(record.is_manual),
    contactName: record.contactName || record.contact_name || null,
    contactEmail: record.contactEmail || record.contact_email || null,
    contactPhone: record.contactPhone || record.contact_phone || null,
    resellerPermitExempt: Boolean(
      record.resellerPermitExempt || record.reseller_permit_exempt,
    ),
    resellerPermitFilePath:
      record.resellerPermitFilePath || record.reseller_permit_file_path || null,
    resellerPermitFileName:
      record.resellerPermitFileName || record.reseller_permit_file_name || null,
    resellerPermitUploadedAt: resellerPermitUploadedAt
      ? new Date(resellerPermitUploadedAt).toISOString()
      : null,
    createdAt: createdAt ? new Date(createdAt).toISOString() : nowIso(),
    updatedAt: updatedAt ? new Date(updatedAt).toISOString() : nowIso(),
  };
};

const rowToRecord = (row) => (row ? ensureDefaults(row) : null);

const toDbParams = (record) => {
  const createdAt = record.createdAt ? new Date(record.createdAt) : null;
  const updatedAt = record.updatedAt ? new Date(record.updatedAt) : null;
  const resellerPermitUploadedAt = record.resellerPermitUploadedAt
    ? new Date(record.resellerPermitUploadedAt)
    : null;
  const assignedAt = record.assignedAt ? new Date(record.assignedAt) : null;
  const lastSyncedAt = record.lastSyncedAt ? new Date(record.lastSyncedAt) : null;
  return {
    id: record.id,
    salesRepId: record.salesRepId,
    doctorId: record.doctorId,
    referralId: record.referralId,
    contactFormId: record.contactFormId,
    sourceSystem: record.sourceSystem || null,
    sourceExternalId: record.sourceExternalId || null,
    sourcePayloadJson:
      record.sourcePayloadJson && typeof record.sourcePayloadJson === 'object'
        ? JSON.stringify(record.sourcePayloadJson)
        : null,
    assignedByRuleId: record.assignedByRuleId || null,
    assignedAt,
    lastSyncedAt,
    syncHash: record.syncHash || null,
    status: record.status,
    notes: record.notes,
    isManual: record.isManual ? 1 : 0,
    contactName: record.contactName,
    contactEmail: record.contactEmail,
    contactPhone: record.contactPhone,
    resellerPermitExempt: record.resellerPermitExempt ? 1 : 0,
    resellerPermitFilePath: record.resellerPermitFilePath || null,
    resellerPermitFileName: record.resellerPermitFileName || null,
    resellerPermitUploadedAt,
    createdAt,
    updatedAt,
  };
};

const readStoreRecords = () => {
  const records = typeof salesProspectStore.readCached === 'function'
    ? salesProspectStore.readCached()
    : salesProspectStore.read();
  return Array.isArray(records) ? records : [];
};

const getAll = async () => {
  if (mysqlClient.isEnabled()) {
    const rows = await mysqlClient.fetchAll('SELECT * FROM sales_prospects');
    return (rows || []).map(rowToRecord).filter(Boolean);
  }
  return readStoreRecords().map(ensureDefaults).filter(Boolean);
};

const findById = async (id) => {
  const target = normalizeId(id);
  if (!target) return null;
  if (mysqlClient.isEnabled()) {
    const row = await mysqlClient.fetchOne(
      'SELECT * FROM sales_prospects WHERE id = :id LIMIT 1',
      { id: target },
    );
    return rowToRecord(row);
  }
  const list = readStoreRecords();
  return list.map(ensureDefaults).find((item) => item.id === target) || null;
};

const findBySalesRepAndDoctorId = async (salesRepId, doctorId) => {
  const rep = normalizeId(salesRepId);
  const doc = normalizeId(doctorId);
  if (!rep || !doc) return null;
  if (mysqlClient.isEnabled()) {
    const row = await mysqlClient.fetchOne(
      `
        SELECT * FROM sales_prospects
        WHERE sales_rep_id = :salesRepId
          AND doctor_id = :doctorId
        LIMIT 1
      `,
      { salesRepId: rep, doctorId: doc },
    );
    return rowToRecord(row);
  }
  const list = readStoreRecords();
  return list
    .map(ensureDefaults)
    .find((item) => item.salesRepId === rep && item.doctorId === doc) || null;
};

const findByDoctorId = async (doctorId) => {
  const doc = normalizeId(doctorId);
  if (!doc) return null;
  const canonicalId = `doctor:${doc}`;
  if (mysqlClient.isEnabled()) {
    const row = await mysqlClient.fetchOne(
      `
        SELECT * FROM sales_prospects
        WHERE doctor_id = :doctorId
        ORDER BY (id = :canonicalId) DESC, COALESCE(updated_at, created_at) DESC
        LIMIT 1
      `,
      { doctorId: doc, canonicalId },
    );
    return rowToRecord(row);
  }
  const list = readStoreRecords();
  const matches = list
    .map(ensureDefaults)
    .filter((item) => normalizeId(item.doctorId) === doc);
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const aCanonical = normalizeId(a.id) === canonicalId ? 1 : 0;
    const bCanonical = normalizeId(b.id) === canonicalId ? 1 : 0;
    if (aCanonical !== bCanonical) {
      return bCanonical - aCanonical;
    }
    const aMs = Date.parse(String(a.updatedAt || a.createdAt || '')) || 0;
    const bMs = Date.parse(String(b.updatedAt || b.createdAt || '')) || 0;
    return bMs - aMs;
  });
  return matches[0] || null;
};

const findBySalesRepAndReferralId = async (salesRepId, referralId) => {
  const rep = normalizeId(salesRepId);
  const ref = normalizeId(referralId);
  if (!rep || !ref) return null;
  if (mysqlClient.isEnabled()) {
    const row = await mysqlClient.fetchOne(
      `
        SELECT * FROM sales_prospects
        WHERE sales_rep_id = :salesRepId
          AND referral_id = :referralId
        LIMIT 1
      `,
      { salesRepId: rep, referralId: ref },
    );
    return rowToRecord(row);
  }
  const list = readStoreRecords();
  return list
    .map(ensureDefaults)
    .find((item) => item.salesRepId === rep && item.referralId === ref) || null;
};

const findBySalesRepAndContactFormId = async (salesRepId, contactFormId) => {
  const rep = normalizeId(salesRepId);
  const form = normalizeId(contactFormId);
  if (!rep || !form) return null;
  if (mysqlClient.isEnabled()) {
    const row = await mysqlClient.fetchOne(
      `
        SELECT * FROM sales_prospects
        WHERE sales_rep_id = :salesRepId
          AND contact_form_id = :contactFormId
        LIMIT 1
      `,
      { salesRepId: rep, contactFormId: form },
    );
    return rowToRecord(row);
  }
  const list = readStoreRecords();
  return list
    .map(ensureDefaults)
    .find((item) => item.salesRepId === rep && item.contactFormId === form) || null;
};

const findBySalesRepAndContactEmail = async (salesRepId, contactEmail) => {
  const rep = normalizeId(salesRepId);
  const email = normalizeEmail(contactEmail);
  if (!rep || !email) return null;
  if (mysqlClient.isEnabled()) {
    const row = await mysqlClient.fetchOne(
      `
        SELECT * FROM sales_prospects
        WHERE sales_rep_id = :salesRepId
          AND contact_email_normalized = :contactEmail
        ORDER BY COALESCE(updated_at, created_at) DESC
        LIMIT 1
      `,
      { salesRepId: rep, contactEmail: email },
    );
    return rowToRecord(row);
  }
  const list = readStoreRecords();
  const matches = list
    .map(ensureDefaults)
    .filter((item) => item.salesRepId === rep && normalizeEmail(item.contactEmail) === email);
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const aMs = Date.parse(String(a.updatedAt || a.createdAt || '')) || 0;
    const bMs = Date.parse(String(b.updatedAt || b.createdAt || '')) || 0;
    return bMs - aMs;
  });
  return matches[0] || null;
};

const findBySourceExternalId = async (sourceSystem, sourceExternalId) => {
  const source = normalizeId(sourceSystem);
  const externalId = normalizeId(sourceExternalId);
  if (!source || !externalId) return null;
  if (mysqlClient.isEnabled()) {
    const row = await mysqlClient.fetchOne(
      `
        SELECT * FROM sales_prospects
        WHERE source_system = :sourceSystem
          AND source_external_id = :sourceExternalId
        ORDER BY COALESCE(updated_at, created_at) DESC
        LIMIT 1
      `,
      { sourceSystem: source, sourceExternalId: externalId },
    );
    return rowToRecord(row);
  }
  const list = readStoreRecords();
  return list
    .map(ensureDefaults)
    .find(
      (item) =>
        normalizeId(item.sourceSystem) === source
        && normalizeId(item.sourceExternalId) === externalId,
    ) || null;
};

const findByContactEmail = async (contactEmail) => {
  const email = normalizeEmail(contactEmail);
  if (!email) return null;
  if (mysqlClient.isEnabled()) {
    const row = await mysqlClient.fetchOne(
      `
        SELECT * FROM sales_prospects
        WHERE contact_email_normalized = :contactEmail
        ORDER BY COALESCE(updated_at, created_at) DESC
        LIMIT 1
      `,
      { contactEmail: email },
    );
    return rowToRecord(row);
  }
  const list = readStoreRecords();
  const matches = list
    .map(ensureDefaults)
    .filter((item) => normalizeEmail(item.contactEmail) === email);
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const aMs = Date.parse(String(a.updatedAt || a.createdAt || '')) || 0;
    const bMs = Date.parse(String(b.updatedAt || b.createdAt || '')) || 0;
    return bMs - aMs;
  });
  return matches[0] || null;
};

const findByContactPhone = async (contactPhone) => {
  const phone = normalizePhoneDigits(contactPhone);
  if (!phone) return null;
  const matchesByPhone = (records) => (records || [])
    .map(ensureDefaults)
    .filter((item) => normalizePhoneDigits(item.contactPhone) === phone)
    .sort((a, b) => {
      const aMs = Date.parse(String(a.updatedAt || a.createdAt || '')) || 0;
      const bMs = Date.parse(String(b.updatedAt || b.createdAt || '')) || 0;
      return bMs - aMs;
    });

  if (mysqlClient.isEnabled()) {
    const rows = await mysqlClient.fetchAll(
      `
        SELECT *
        FROM sales_prospects
        WHERE contact_phone IS NOT NULL
      `,
    );
    const matches = matchesByPhone(rows);
    return matches.length > 0 ? matches[0] : null;
  }

  const list = readStoreRecords();
  const matches = matchesByPhone(list);
  return matches.length > 0 ? matches[0] : null;
};

const findAllByReferralId = async (referralId) => {
  const target = normalizeId(referralId);
  if (!target) return [];
  if (mysqlClient.isEnabled()) {
    const rows = await mysqlClient.fetchAll(
      `
        SELECT * FROM sales_prospects
        WHERE referral_id = :referralId
           OR id = :referralId
      `,
      { referralId: target },
    );
    return Array.isArray(rows) ? rows.map(rowToRecord).filter(Boolean) : [];
  }
  return readStoreRecords()
    .map(ensureDefaults)
    .filter((item) => item.id === target || item.referralId === target);
};

const upsert = async (prospect) => {
  const incoming = prospect && typeof prospect === 'object' ? prospect : {};
  const id = normalizeId(incoming.id);
  const salesRepId = normalizeId(incoming.salesRepId);
  const doctorId = normalizeId(incoming.doctorId);

  let existing = null;
  if (id) {
    existing = await findById(id);
  }
  if (
    !existing
    && normalizeId(incoming.sourceSystem)
    && normalizeId(incoming.sourceExternalId)
  ) {
    existing = await findBySourceExternalId(incoming.sourceSystem, incoming.sourceExternalId);
  }
  if (!existing && normalizeEmail(incoming.contactEmail)) {
    existing = await findByContactEmail(incoming.contactEmail);
  }
  if (!existing && normalizePhoneDigits(incoming.contactPhone)) {
    existing = await findByContactPhone(incoming.contactPhone);
  }
  if (!existing && doctorId) {
    existing = await findByDoctorId(doctorId);
  }
  if (!existing && salesRepId && doctorId) {
    existing = await findBySalesRepAndDoctorId(salesRepId, doctorId);
  }
  if (!existing && salesRepId && normalizeId(incoming.referralId)) {
    existing = await findBySalesRepAndReferralId(salesRepId, incoming.referralId);
  }
  if (!existing && salesRepId && normalizeId(incoming.contactFormId)) {
    existing = await findBySalesRepAndContactFormId(salesRepId, incoming.contactFormId);
  }

  const resolvedId = id || normalizeId(existing?.id);
  const lockedDoctorSalesRepId = isDoctorLinked(existing) ? normalizeId(existing?.salesRepId) : null;
  if (lockedDoctorSalesRepId && salesRepId && salesRepId !== lockedDoctorSalesRepId) {
    logger.warn(
      {
        prospectId: resolvedId || null,
        doctorId: normalizeId(existing?.doctorId),
        attemptedSalesRepId: salesRepId,
        retainedSalesRepId: lockedDoctorSalesRepId,
      },
      'Blocked doctor prospect salesRepId overwrite',
    );
  }
  const resolvedSalesRepId = lockedDoctorSalesRepId || salesRepId || normalizeId(existing?.salesRepId);
  const normalized = ensureDefaults({
    ...(existing || {}),
    ...incoming,
    id: resolvedId,
    salesRepId: resolvedSalesRepId,
    updatedAt: nowIso(),
    createdAt: existing?.createdAt || incoming.createdAt || nowIso(),
  });

  if (!normalized.id) {
    const error = new Error('Prospect id is required');
    error.status = 400;
    throw error;
  }
  if (!normalized.salesRepId) {
    const identifier = String(normalized.id || '');
    if (!(identifier.startsWith('contact_form:') && normalizeId(normalized.contactFormId))) {
      const error = new Error('salesRepId is required');
      error.status = 400;
      throw error;
    }
  }

  if (mysqlClient.isEnabled()) {
    const params = toDbParams(normalized);
	    await mysqlClient.execute(
	      `
	        INSERT INTO sales_prospects (
	          id,
	          sales_rep_id,
	          doctor_id,
	          referral_id,
	          contact_form_id,
	          source_system,
	          source_external_id,
	          source_payload_json,
	          assigned_by_rule_id,
	          assigned_at,
	          last_synced_at,
	          sync_hash,
	          status,
	          notes,
	          is_manual,
	          contact_name,
	          contact_email,
	          contact_phone,
	          reseller_permit_exempt,
	          reseller_permit_file_path,
	          reseller_permit_file_name,
	          reseller_permit_uploaded_at,
	          created_at,
	          updated_at
	        ) VALUES (
	          :id,
	          :salesRepId,
	          :doctorId,
	          :referralId,
	          :contactFormId,
	          :sourceSystem,
	          :sourceExternalId,
	          :sourcePayloadJson,
	          :assignedByRuleId,
	          :assignedAt,
	          :lastSyncedAt,
	          :syncHash,
	          :status,
	          :notes,
	          :isManual,
	          :contactName,
	          :contactEmail,
	          :contactPhone,
	          :resellerPermitExempt,
	          :resellerPermitFilePath,
	          :resellerPermitFileName,
	          :resellerPermitUploadedAt,
	          :createdAt,
	          :updatedAt
	        )
	        ON DUPLICATE KEY UPDATE
	          sales_rep_id = CASE
	            WHEN sales_prospects.doctor_id IS NOT NULL AND TRIM(sales_prospects.doctor_id) <> '' THEN sales_prospects.sales_rep_id
	            ELSE VALUES(sales_rep_id)
	          END,
	          doctor_id = VALUES(doctor_id),
	          referral_id = VALUES(referral_id),
	          contact_form_id = VALUES(contact_form_id),
	          source_system = VALUES(source_system),
	          source_external_id = VALUES(source_external_id),
	          source_payload_json = VALUES(source_payload_json),
	          assigned_by_rule_id = VALUES(assigned_by_rule_id),
	          assigned_at = VALUES(assigned_at),
	          last_synced_at = VALUES(last_synced_at),
	          sync_hash = VALUES(sync_hash),
	          status = VALUES(status),
	          notes = VALUES(notes),
	          is_manual = VALUES(is_manual),
	          contact_name = VALUES(contact_name),
	          contact_email = VALUES(contact_email),
	          contact_phone = VALUES(contact_phone),
	          reseller_permit_exempt = VALUES(reseller_permit_exempt),
	          reseller_permit_file_path = VALUES(reseller_permit_file_path),
	          reseller_permit_file_name = VALUES(reseller_permit_file_name),
	          reseller_permit_uploaded_at = VALUES(reseller_permit_uploaded_at),
	          updated_at = VALUES(updated_at)
	      `,
	      params,
	    );
    return findById(normalized.id);
  }

  const baseRecords = salesProspectStore.read();
  const records = Array.isArray(baseRecords) ? baseRecords : [];
  const index = records.findIndex((item) => normalizeId(item.id) === normalized.id);
  if (index >= 0) {
    records[index] = normalized;
  } else {
    records.push(normalized);
  }
  salesProspectStore.write(records);
  return normalized;
};

const remove = async (id) => {
  const target = normalizeId(id);
  if (!target) return false;
  if (mysqlClient.isEnabled()) {
    try {
      await mysqlClient.execute('DELETE FROM sales_prospects WHERE id = :id', { id: target });
      return true;
    } catch (error) {
      logger.error({ err: error, id: target }, 'Failed to delete sales prospect');
      return false;
    }
  }
  const baseRecords = salesProspectStore.read();
  const records = Array.isArray(baseRecords) ? baseRecords : [];
  const next = records.filter((item) => normalizeId(item.id) !== target);
  salesProspectStore.write(next);
  return next.length !== records.length;
};

const removeByReferralId = async (referralId) => {
  const target = normalizeId(referralId);
  if (!target) return false;
  if (mysqlClient.isEnabled()) {
    try {
      const result = await mysqlClient.execute(
        'DELETE FROM sales_prospects WHERE referral_id = :referralId OR id = :referralId',
        { referralId: target },
      );
      return Boolean(result && typeof result.affectedRows === 'number' ? result.affectedRows > 0 : true);
    } catch (error) {
      logger.error({ err: error, referralId: target }, 'Failed to delete sales prospect by referralId');
      return false;
    }
  }
  const baseRecords = salesProspectStore.read();
  const records = Array.isArray(baseRecords) ? baseRecords : [];
  const next = records.filter((item) => {
    const id = normalizeId(item?.id);
    const refId = normalizeId(item?.referralId || item?.referral_id);
    return id !== target && refId !== target;
  });
  salesProspectStore.write(next);
  return next.length !== records.length;
};

module.exports = {
  getAll,
  findById,
  findByDoctorId,
  findBySalesRepAndDoctorId,
  findBySalesRepAndReferralId,
  findBySalesRepAndContactFormId,
  findBySalesRepAndContactEmail,
  findBySourceExternalId,
  findByContactEmail,
  findByContactPhone,
  findAllByReferralId,
  upsert,
  remove,
  removeByReferralId,
};

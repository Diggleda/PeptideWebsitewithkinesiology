const { logger } = require('../config/logger');
const mysqlClient = require('../database/mysqlClient');
const userRepository = require('../repositories/userRepository');
const {
  orderStore,
  referralStore,
  referralCodeStore,
  salesRepStore,
  salesProspectStore,
  creditLedgerStore,
  peptideForumStore,
} = require('../storage');
const { DELETED_USER_ID } = require('../constants/deletedUser');

const IGNORED_MYSQL_CODES = new Set(['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR']);

const normalizeId = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
};

const replaceIdDeep = (value, targetId, replacementId) => {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const [replaced, replacedChanged] = replaceIdDeep(entry, targetId, replacementId);
      changed = changed || replacedChanged;
      return replaced;
    });
    return [changed ? next : value, changed];
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next = {};
    Object.entries(value).forEach(([key, entry]) => {
      const [replaced, replacedChanged] = replaceIdDeep(entry, targetId, replacementId);
      const nextKey = key.includes(targetId)
        ? key.split(targetId).join(replacementId)
        : key;
      changed = changed || replacedChanged || nextKey !== key;
      next[nextKey] = replaced;
    });
    return [changed ? next : value, changed];
  }
  if (typeof value === 'string') {
    if (!value.includes(targetId)) {
      return [value, false];
    }
    return [value.split(targetId).join(replacementId), true];
  }
  if (typeof value === 'number' && String(value) === targetId) {
    return [replacementId, true];
  }
  return [value, false];
};

const rewriteStoreReferences = (store, label, targetId, replacementId) => {
  const current = store.read();
  const [updated, changed] = replaceIdDeep(current, targetId, replacementId);
  if (changed) {
    store.write(updated);
  }
  return { label, changed };
};

const rewriteSalesProspectStoreReferences = (targetId, replacementId) => {
  const current = salesProspectStore.read();
  if (!Array.isArray(current)) {
    return rewriteStoreReferences(salesProspectStore, 'sales-prospects.json', targetId, replacementId);
  }

  let changed = false;
  const next = current.map((entry) => {
    const [replaced, replacedChanged] = replaceIdDeep(entry, targetId, replacementId);
    const hasDoctorId = Boolean(normalizeId(entry?.doctorId || entry?.doctor_id));
    if (!hasDoctorId || !replaced || typeof replaced !== 'object') {
      changed = changed || replacedChanged;
      return replaced;
    }

    const restored = { ...replaced };
    if (Object.prototype.hasOwnProperty.call(entry, 'salesRepId')) {
      restored.salesRepId = entry.salesRepId;
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'sales_rep_id')) {
      restored.sales_rep_id = entry.sales_rep_id;
    }
    changed = changed || replacedChanged;
    return restored;
  });

  if (changed) {
    salesProspectStore.write(next);
  }
  return { label: 'sales-prospects.json', changed };
};

const executeMysql = async (query, params, label) => {
  try {
    const result = await mysqlClient.execute(query, params);
    return {
      label,
      ok: true,
      affectedRows: Number(result?.affectedRows || 0),
    };
  } catch (error) {
    if (error && IGNORED_MYSQL_CODES.has(error.code)) {
      return {
        label,
        ok: true,
        affectedRows: 0,
      };
    }
    throw error;
  }
};

const rewriteMysqlReferences = async (targetId, replacementId) => {
  if (!mysqlClient.isEnabled()) {
    return [];
  }

  const statements = [
    {
      label: 'peppro_orders.user_id',
      query: 'UPDATE peppro_orders SET user_id = :replacementId WHERE user_id = :targetId',
      params: { targetId, replacementId },
    },
    {
      label: 'orders.user_id',
      query: 'UPDATE orders SET user_id = :replacementId WHERE user_id = :targetId',
      params: { targetId, replacementId },
    },
    {
      label: 'peppro_orders.payload',
      query: 'UPDATE peppro_orders SET payload = REPLACE(payload, :targetId, :replacementId) WHERE payload LIKE :needle',
      params: { targetId, replacementId, needle: `%${targetId}%` },
    },
    {
      label: 'orders.payload',
      query: 'UPDATE orders SET payload = REPLACE(payload, :targetId, :replacementId) WHERE payload LIKE :needle',
      params: { targetId, replacementId, needle: `%${targetId}%` },
    },
    {
      label: 'sales_prospects.doctor_id',
      query: 'UPDATE sales_prospects SET doctor_id = :replacementId WHERE doctor_id = :targetId',
      params: { targetId, replacementId },
    },
    {
      label: 'sales_prospects.id',
      query: 'UPDATE sales_prospects SET id = REPLACE(id, :targetId, :replacementId) WHERE id LIKE :needle',
      params: { targetId, replacementId, needle: `%${targetId}%` },
    },
    {
      label: 'sales_prospects.sales_rep_id',
      query: 'UPDATE sales_prospects SET sales_rep_id = :replacementId WHERE sales_rep_id = :targetId AND (doctor_id IS NULL OR TRIM(doctor_id) = \'\')',
      params: { targetId, replacementId },
    },
    {
      label: 'user_passkeys.user_id',
      query: 'DELETE FROM user_passkeys WHERE user_id = :targetId',
      params: { targetId },
    },
    {
      label: 'users.id',
      query: 'DELETE FROM users WHERE id = :targetId',
      params: { targetId },
    },
  ];

  const results = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const statement of statements) {
    // eslint-disable-next-line no-await-in-loop
    const result = await executeMysql(statement.query, statement.params, statement.label);
    results.push(result);
  }
  return results;
};

const deleteAccountAndRewriteReferences = async ({
  userId,
  replacementUserId = DELETED_USER_ID,
}) => {
  const targetId = normalizeId(userId);
  const replacementId = normalizeId(replacementUserId) || DELETED_USER_ID;
  if (!targetId) {
    const error = new Error('USER_ID_REQUIRED');
    error.status = 400;
    throw error;
  }
  if (targetId === replacementId) {
    const error = new Error('INVALID_DELETE_TARGET');
    error.status = 400;
    throw error;
  }

  const existing = userRepository.findById(targetId);
  if (!existing) {
    const error = new Error('USER_NOT_FOUND');
    error.status = 404;
    throw error;
  }

  const localRewriteResults = [
    rewriteStoreReferences(orderStore, 'orders.json', targetId, replacementId),
    rewriteStoreReferences(referralStore, 'referrals.json', targetId, replacementId),
    rewriteStoreReferences(referralCodeStore, 'referral-codes.json', targetId, replacementId),
    rewriteStoreReferences(salesRepStore, 'sales-reps.json', targetId, replacementId),
    rewriteSalesProspectStoreReferences(targetId, replacementId),
    rewriteStoreReferences(creditLedgerStore, 'credit-ledger.json', targetId, replacementId),
    rewriteStoreReferences(peptideForumStore, 'the-peptide-forum.json', targetId, replacementId),
  ];

  userRepository.removeById(targetId);
  const mysqlResults = await rewriteMysqlReferences(targetId, replacementId);

  logger.info(
    {
      deletedUserId: targetId,
      replacementUserId: replacementId,
      localRewrites: localRewriteResults,
      mysqlResults,
    },
    'Account deleted and user references rewritten',
  );

  return {
    deletedUserId: targetId,
    replacementUserId: replacementId,
    localRewrites: localRewriteResults,
    mysqlResults,
  };
};

module.exports = {
  DELETED_USER_ID,
  deleteAccountAndRewriteReferences,
};

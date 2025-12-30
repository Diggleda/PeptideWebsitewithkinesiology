const { env } = require('../config/env');
const mysqlClient = require('../database/mysqlClient');

const isEnabled = () => Boolean(env.mysql?.enabled) && mysqlClient.isEnabled();

const listForUser = async (userId, fallback = []) => {
  if (!isEnabled() || !userId) {
    return Array.isArray(fallback) ? fallback : [];
  }
  const rows = await mysqlClient.fetchAll(
    `
      SELECT *
      FROM user_passkeys
      WHERE user_id = :userId
      ORDER BY created_at ASC, id ASC
    `,
    { userId },
  );
  return rows.map(rowToPasskey);
};

const replaceForUser = async (userId, passkeys = []) => {
  if (!isEnabled() || !userId) {
    return;
  }
  await mysqlClient.execute('DELETE FROM user_passkeys WHERE user_id = :userId', { userId });
  for (const entry of passkeys || []) {
    const params = passkeyToParams(userId, entry);
    await mysqlClient.execute(
      `
        INSERT INTO user_passkeys (
          id,
          user_id,
          credential_id,
          public_key,
          counter,
          transports,
          device_type,
          backed_up,
          label,
          created_at,
          updated_at,
          last_used_at
        ) VALUES (
          :id,
          :userId,
          :credentialId,
          :publicKey,
          :counter,
          :transports,
          :deviceType,
          :backedUp,
          :label,
          :createdAt,
          :updatedAt,
          :lastUsedAt
        )
        ON DUPLICATE KEY UPDATE
          public_key = VALUES(public_key),
          counter = VALUES(counter),
          transports = VALUES(transports),
          device_type = VALUES(device_type),
          backed_up = VALUES(backed_up),
          label = VALUES(label),
          created_at = VALUES(created_at),
          updated_at = VALUES(updated_at),
          last_used_at = VALUES(last_used_at)
      `,
      params,
    );
  }
};

const findOwnerByCredentialId = async (credentialId) => {
  if (!isEnabled() || !credentialId) {
    return null;
  }
  const row = await mysqlClient.fetchOne(
    'SELECT * FROM user_passkeys WHERE credential_id = :credentialId',
    { credentialId },
  );
  if (!row) {
    return null;
  }
  return {
    userId: row.user_id,
    passkey: rowToPasskey(row),
  };
};

const rowToPasskey = (row) => ({
  id: row.id,
  credentialID: row.credential_id,
  publicKey: row.public_key,
  counter: Number(row.counter || 0),
  transports: parseTransports(row.transports),
  deviceType: row.device_type,
  backedUp: Boolean(row.backed_up),
  label: row.label,
  createdAt: formatDate(row.created_at),
  updatedAt: formatDate(row.updated_at),
  lastUsedAt: formatDate(row.last_used_at),
});

const passkeyToParams = (userId, passkey) => {
  const credentialID = (passkey?.credentialID || '').trim();
  const publicKey = (passkey?.publicKey || '').trim();
  if (!credentialID || !publicKey) {
    throw new Error('Passkey requires credentialID and publicKey');
  }
  const transports = Array.isArray(passkey?.transports)
    ? passkey.transports.filter((item) => typeof item === 'string' && item)
    : [];
  return {
    id: passkey?.id || generateId(),
    userId,
    credentialId: credentialID,
    publicKey,
    counter: Number(passkey?.counter || 0),
    transports: transports.length ? JSON.stringify(transports) : null,
    deviceType: passkey?.deviceType || null,
    backedUp: passkey?.backedUp ? 1 : 0,
    label: passkey?.label || null,
    createdAt: normalizeDate(passkey?.createdAt),
    updatedAt: normalizeDate(passkey?.updatedAt || passkey?.createdAt),
    lastUsedAt: normalizeDate(passkey?.lastUsedAt),
  };
};

const parseTransports = (raw) => {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((item) => typeof item === 'string' && item);
    }
  } catch {
    return [];
  }
  return [];
};

const normalizeDate = (value) => {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 19).replace('T', ' ');
};

const formatDate = (value) => {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
};

const generateId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

module.exports = {
  isEnabled,
  listForUser,
  replaceForUser,
  findOwnerByCredentialId,
};

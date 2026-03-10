const { userStore } = require('../storage');
const mysqlClient = require('../database/mysqlClient');
const { logger } = require('../config/logger');

const normalizeNpiNumber = (value) => {
  if (!value) {
    return '';
  }
  return String(value).replace(/[^0-9]/g, '').slice(0, 10);
};

const DIRECT_SHIPPING_FIELDS = [
  'officeAddressLine1',
  'officeAddressLine2',
  'officeCity',
  'officeState',
  'officePostalCode',
];

const normalizeOptionalString = (value) => {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'string') {
    return String(value).trim() || null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeIdentifier = (value) => {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
};

const lockSalesRepIdIfAssigned = (existingUser, candidateUser) => {
  if (!existingUser || !candidateUser) {
    return candidateUser;
  }
  const existingSalesRepId = normalizeIdentifier(existingUser.salesRepId);
  if (!existingSalesRepId) {
    return candidateUser;
  }
  return {
    ...candidateUser,
    salesRepId: existingSalesRepId,
  };
};

const normalizeBooleanFlag = (value) => {
  if (value === true || value === false) return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1'
      || normalized === 'true'
      || normalized === 'yes'
      || normalized === 'on';
  }
  return false;
};

const normalizeCartItems = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const quantity = Math.max(1, Math.floor(Number(item.quantity) || 0));
      const productId = normalizeOptionalString(item.productId);
      if (!productId || quantity <= 0) {
        return null;
      }
      return {
        productId,
        productWooId: Number.isFinite(Number(item.productWooId)) ? Number(item.productWooId) : null,
        variantId: normalizeOptionalString(item.variantId),
        variantWooId: Number.isFinite(Number(item.variantWooId)) ? Number(item.variantWooId) : null,
        quantity,
        note: normalizeOptionalString(item.note),
      };
    })
    .filter(Boolean);
};

const syncDirectShippingToSql = (user) => {
  if (!mysqlClient.isEnabled()) {
    logger.warn(
      {
        userId: user.id,
        mysqlEnabled: mysqlClient.isEnabled(),
        envMysqlEnabled: process.env.MYSQL_ENABLED,
      },
      'MySQL not enabled, skipping direct shipping/profile sync',
    );
    return;
  }
  const profileImageBytes = user.profileImageUrl
    ? Buffer.byteLength(String(user.profileImageUrl), 'utf8')
    : 0;
  const params = {
    id: user.id,
    email: user.email || null,
    name: user.name || null,
    phone: user.phone || null,
    password: user.password || null,
    role: user.role || null,
    addressLine1: user.officeAddressLine1,
    addressLine2: user.officeAddressLine2,
    city: user.officeCity,
    state: user.officeState,
    postalCode: user.officePostalCode,
    profileImageUrl: user.profileImageUrl,
    npiNumber: user.npiNumber || null,
    npiProviderName: user.npiVerification?.name || null,
    npiClinicName: user.npiVerification?.organizationName || null,
    npiVerificationStatus: user.npiVerificationStatus || (user.npiVerification ? 'VALID' : null),
    npiVerifiedAt: user.npiLastVerifiedAt || null,
    isTaxExempt: user.isTaxExempt ? 1 : 0,
    taxExemptSource: user.taxExemptSource || null,
    taxExemptReason: user.taxExemptReason || null,
    devCommission: user.devCommission ? 1 : 0,
    receiveClientOrderUpdateEmails: user.receiveClientOrderUpdateEmails ? 1 : 0,
    handDelivered: user.handDelivered ? 1 : 0,
    cartJson: JSON.stringify(normalizeCartItems(user.cart)),
  };
  logger.info(
    {
      userId: user.id,
      hasProfileImage: Boolean(params.profileImageUrl),
      profileImageBytes,
      email: params.email,
    },
    'Upserting user record into MySQL (includes profile image)',
  );
  logger.debug(
    { userId: user.id, profileImageUrl: params.profileImageUrl, profileImageBytes },
    'Syncing direct shipping info to MySQL (includes profile image)',
  );
  const startedAt = Date.now();
  mysqlClient
    .execute(
      `
        INSERT INTO users (
          id,
          email,
          name,
          phone,
          password,
          role,
          office_address_line1,
          office_address_line2,
          office_city,
          office_state,
          office_postal_code,
          profile_image_url,
          npi_number,
          npi_provider_name,
          npi_clinic_name,
          npi_verification_status,
          npi_verified_at,
          is_tax_exempt,
          tax_exempt_source,
          tax_exempt_reason,
          dev_commission,
          receive_client_order_update_emails,
          hand_delivered,
          cart
        ) VALUES (
          :id,
          :email,
          :name,
          :phone,
          :password,
          :role,
          :addressLine1,
          :addressLine2,
          :city,
          :state,
          :postalCode,
          :profileImageUrl,
          :npiNumber,
          :npiProviderName,
          :npiClinicName,
          :npiVerificationStatus,
          :npiVerifiedAt,
          :isTaxExempt,
          :taxExemptSource,
          :taxExemptReason,
          :devCommission,
          :receiveClientOrderUpdateEmails,
          :handDelivered,
          CAST(:cartJson AS JSON)
        )
        ON DUPLICATE KEY UPDATE
          email = COALESCE(VALUES(email), email),
          name = COALESCE(VALUES(name), name),
          phone = COALESCE(VALUES(phone), phone),
          password = COALESCE(VALUES(password), password),
          role = COALESCE(VALUES(role), role),
          office_address_line1 = VALUES(office_address_line1),
          office_address_line2 = VALUES(office_address_line2),
          office_city = VALUES(office_city),
          office_state = VALUES(office_state),
          office_postal_code = VALUES(office_postal_code),
          profile_image_url = VALUES(profile_image_url),
          npi_number = VALUES(npi_number),
          npi_provider_name = VALUES(npi_provider_name),
          npi_clinic_name = VALUES(npi_clinic_name),
          npi_verification_status = VALUES(npi_verification_status),
          npi_verified_at = VALUES(npi_verified_at),
          is_tax_exempt = VALUES(is_tax_exempt),
          tax_exempt_source = VALUES(tax_exempt_source),
          tax_exempt_reason = VALUES(tax_exempt_reason),
          dev_commission = VALUES(dev_commission),
          receive_client_order_update_emails = VALUES(receive_client_order_update_emails),
          hand_delivered = VALUES(hand_delivered),
          cart = VALUES(cart)
      `,
      params,
    )
    .then((result) => {
      const durationMs = Date.now() - startedAt;
      if (!result || result.affectedRows === 0) {
        logger.warn(
          { userId: user.id, durationMs },
          'No rows updated while syncing direct shipping info to MySQL',
        );
      } else {
        logger.info(
          {
            userId: user.id,
            profileImageUrl: params.profileImageUrl,
            profileImageBytes,
            affectedRows: result.affectedRows,
            durationMs,
          },
          'Direct shipping info synced to MySQL (profile image included)',
        );
      }
    })
    .catch((error) => {
      logger.error(
        { err: error, userId: user.id },
        'Failed to sync direct shipping info to MySQL',
      );
    });
};

const normalizeRole = (role) => {
  const normalized = (role || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (normalized === 'sales_rep') return 'sales_rep';
  if (normalized === 'rep') return 'rep';
  if (normalized === 'sales_lead' || normalized === 'saleslead') return 'sales_lead';
  if (normalized === 'admin') return 'admin';
  if (normalized === 'test_doctor') return 'test_doctor';
  if (normalized === 'doctor') return 'doctor';
  return 'doctor';
};

const ensureUserDefaults = (user) => {
  const normalized = { ...user };
  if (typeof normalized.visits !== 'number' || Number.isNaN(normalized.visits)) {
    normalized.visits = normalized.createdAt ? 1 : 0;
  }
  if (!normalized.lastLoginAt) {
    normalized.lastLoginAt = normalized.createdAt || null;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'lastSeenAt')) {
    normalized.lastSeenAt = null;
  } else {
    normalized.lastSeenAt = normalizeOptionalString(normalized.lastSeenAt);
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'lastInteractionAt')) {
    normalized.lastInteractionAt = null;
  } else {
    normalized.lastInteractionAt = normalizeOptionalString(normalized.lastInteractionAt);
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'isOnline')) {
    normalized.isOnline = false;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'isIdle')) {
    normalized.isIdle = null;
  }
  if (!normalized.referralCredits) {
    normalized.referralCredits = 0;
  }
  if (!normalized.totalReferrals) {
    normalized.totalReferrals = 0;
  }
  if (typeof normalized.npiNumber === 'string') {
    normalized.npiNumber = normalizeNpiNumber(normalized.npiNumber) || null;
  } else if (normalized.npiNumber == null) {
    normalized.npiNumber = null;
  }
  normalized.role = normalizeRole(normalized.role);
  if (!Object.prototype.hasOwnProperty.call(normalized, 'salesRepId')) {
    normalized.salesRepId = null;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'npiVerification')) {
    normalized.npiVerification = null;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'npiLastVerifiedAt')) {
    normalized.npiLastVerifiedAt = null;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'npiVerificationStatus')) {
    normalized.npiVerificationStatus = null;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'isTaxExempt')) {
    normalized.isTaxExempt = false;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'taxExemptSource')) {
    normalized.taxExemptSource = null;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'taxExemptReason')) {
    normalized.taxExemptReason = null;
  }
  if (!Array.isArray(normalized.passkeys)) {
    normalized.passkeys = [];
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'profileImageUrl')) {
    normalized.profileImageUrl = null;
  } else {
    normalized.profileImageUrl = normalizeOptionalString(normalized.profileImageUrl);
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'cart')) {
    normalized.cart = [];
  } else {
    normalized.cart = normalizeCartItems(normalized.cart);
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'devCommission')) {
    normalized.devCommission = false;
  } else {
    normalized.devCommission = normalizeBooleanFlag(normalized.devCommission);
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'receiveClientOrderUpdateEmails')) {
    normalized.receiveClientOrderUpdateEmails = false;
  } else {
    normalized.receiveClientOrderUpdateEmails = normalizeBooleanFlag(
      normalized.receiveClientOrderUpdateEmails,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'handDelivered')) {
    normalized.handDelivered = normalizeBooleanFlag(normalized.hand_delivered);
  } else {
    normalized.handDelivered = normalizeBooleanFlag(normalized.handDelivered);
  }
  normalized.hand_delivered = normalized.handDelivered ? 1 : 0;
  DIRECT_SHIPPING_FIELDS.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(normalized, field)) {
      normalized[field] = null;
    } else {
      normalized[field] = normalizeOptionalString(normalized[field]);
    }
  });
  return normalized;
};

const loadUsers = () => {
  const users = userStore.read();
  let changed = false;
  const normalized = users.map((user) => {
    const candidate = ensureUserDefaults(user);
    const roleChanged = candidate.role !== user.role;
    const visitsChanged = candidate.visits !== user.visits;
    const lastLoginChanged = candidate.lastLoginAt !== user.lastLoginAt;
    const creditsChanged = candidate.referralCredits !== user.referralCredits;
    const totalRefsChanged = candidate.totalReferrals !== user.totalReferrals;
    if (roleChanged || visitsChanged || lastLoginChanged || creditsChanged || totalRefsChanged) {
      changed = true;
    }
    return candidate;
  });

  if (changed) {
    userStore.write(normalized);
  }

  return normalized;
};

const saveUsers = (users) => {
  userStore.write(users.map(ensureUserDefaults));
};

const getAll = () => loadUsers();

const findByEmail = (email) => loadUsers().find((user) => user.email === email) || null;

const findById = (id) => loadUsers().find((user) => user.id === id) || null;

const findByReferralCode = (code) => loadUsers().find((user) => user.referralCode === code) || null;

const findByNpiNumber = (npiNumber) => {
  const normalized = normalizeNpiNumber(npiNumber);
  if (!normalized) {
    return null;
  }
  return loadUsers().find((user) => normalizeNpiNumber(user.npiNumber) === normalized) || null;
};

const findByPasskeyId = (credentialId) => {
  if (!credentialId) {
    return null;
  }
  const users = loadUsers();
  return users.find((user) => Array.isArray(user.passkeys)
    && user.passkeys.some((pk) => pk.credentialID === credentialId)) || null;
};

const insert = (user) => {
  const users = loadUsers();
  const candidate = ensureUserDefaults(user);
  users.push(candidate);
  saveUsers(users);
  syncDirectShippingToSql(candidate);
  return candidate;
};

const update = (user) => {
  const users = loadUsers();
  const index = users.findIndex((item) => item.id === user.id);
  if (index === -1) {
    return null;
  }
  const merged = ensureUserDefaults({ ...users[index], ...user });
  users[index] = lockSalesRepIdIfAssigned(users[index], merged);
  saveUsers(users);
  syncDirectShippingToSql(users[index]);
  return users[index];
};

const replace = (predicate, updater) => {
  const users = loadUsers();
  const index = users.findIndex(predicate);
  if (index === -1) {
    return null;
  }
  const updated = lockSalesRepIdIfAssigned(
    users[index],
    ensureUserDefaults(updater(users[index])),
  );
  users[index] = updated;
  saveUsers(users);
  syncDirectShippingToSql(updated);
  return updated;
};

const removeById = (id) => {
  const users = loadUsers();
  const index = users.findIndex((item) => item.id === id);
  if (index === -1) {
    return null;
  }
  const [removed] = users.splice(index, 1);
  saveUsers(users);
  return removed || null;
};

module.exports = {
  getAll,
  insert,
  update,
  replace,
  removeById,
  findByEmail,
  findById,
  findByReferralCode,
  findByNpiNumber,
  findByPasskeyId,
};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const userRepository = require('../repositories/userRepository');
const referralService = require('./referralService');
const salesRepRepository = require('../repositories/salesRepRepository');
const referralCodeRepository = require('../repositories/referralCodeRepository');
const adminRepository = require('../repositories/adminRepository');
const salesProspectRepository = require('../repositories/salesProspectRepository');
const { env } = require('../config/env');
const { verifyDoctorNpi, normalizeNpiNumber } = require('./npiService');
const { logger } = require('../config/logger');
const mysqlClient = require('../database/mysqlClient');
const { deleteAccountAndRewriteReferences, DELETED_USER_ID } = require('./accountDeletionService');

const BCRYPT_REGEX = /^\$2[abxy]\$/;
const SALES_CODE_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}$/;

const normalizeId = (value) => {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length > 0 ? str : null;
};

const normalizeCode = (value) => {
  if (!value) return null;
  const normalized = String(value).trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
};

const normalizeEmail = (value) => (value ? String(value).trim().toLowerCase() : '');

const DIRECT_SHIPPING_FIELDS = [
  'officeAddressLine1',
  'officeAddressLine2',
  'officeCity',
  'officeState',
  'officePostalCode',
];

const DOCTOR_PROFILE_FIELD_LIMITS = {
  greaterArea: 190,
  studyFocus: 190,
  bio: 1000,
};

const RESELLER_PERMIT_ALLOWED_EXTENSIONS = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.heic',
  '.gif',
]);

const RESELLER_PERMIT_UPLOAD_DIR = path.join(
  env.dataDir,
  'uploads',
  'reseller-permits',
);

const supportsHrtimeBigint = typeof process.hrtime === 'function'
  && typeof process.hrtime.bigint === 'function';

const startTimer = () => (supportsHrtimeBigint
  ? process.hrtime.bigint()
  : process.hrtime());

const elapsedMs = (start) => {
  if (supportsHrtimeBigint && typeof start === 'bigint') {
    return Number(process.hrtime.bigint() - start) / 1e6;
  }
  const diff = process.hrtime(start);
  return (diff[0] * 1e3) + (diff[1] / 1e6);
};

const formatMs = (value) => Math.round(value * 100) / 100;

const maskEmailForLog = (value) => {
  if (typeof value !== 'string') {
    return 'unknown';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return 'unknown';
  }
  const [local, domain] = trimmed.split('@');
  if (!domain) {
    if (local.length <= 1) {
      return `${local || '*'}***`;
    }
    if (local.length === 2) {
      return `${local[0]}*`;
    }
    return `${local.slice(0, 2)}***`;
  }
  if (local.length <= 1) {
    return `*@${domain}`;
  }
  if (local.length === 2) {
    return `${local[0]}*@${domain}`;
  }
  return `${local.slice(0, 2)}***@${domain}`;
};

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

const deleteStoredResellerPermitFile = async (user) => {
  const relativePath = normalizeOptionalString(user?.resellerPermitFilePath);
  if (!relativePath) {
    return;
  }
  try {
    const absolutePath = path.resolve(env.dataDir, relativePath);
    const allowedRoot = path.resolve(RESELLER_PERMIT_UPLOAD_DIR);
    if (!absolutePath.startsWith(`${allowedRoot}${path.sep}`) && absolutePath !== allowedRoot) {
      return;
    }
    await fs.promises.unlink(absolutePath).catch((error) => {
      if (error && error.code !== 'ENOENT') {
        throw error;
      }
    });
  } catch (error) {
    logger.warn(
      {
        userId: user?.id || null,
        resellerPermitFilePath: user?.resellerPermitFilePath || null,
        error: error?.message || String(error),
      },
      'Failed to remove stored reseller permit file',
    );
  }
};

const normalizeRole = (role) => {
  const normalized = (role || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (normalized === 'sales_partner') return 'sales_partner';
  if (normalized === 'sales_rep') return 'sales_rep';
  if (normalized === 'rep') return 'rep';
  if (normalized === 'sales_lead' || normalized === 'saleslead') return 'sales_lead';
  if (normalized === 'admin') return 'admin';
  if (normalized === 'test_doctor') return 'test_doctor';
  if (normalized === 'doctor') return 'doctor';
  return 'doctor';
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

const hydrateUserCartFromSql = async (user) => {
  if (!user || !mysqlClient.isEnabled()) {
    return user;
  }
  try {
    const row = await mysqlClient.fetchOne(
      `
        SELECT cart
        FROM users
        WHERE id = :userId
        LIMIT 1
      `,
      { userId: user.id },
    );
    if (!row || !Object.prototype.hasOwnProperty.call(row, 'cart')) {
      return user;
    }
    const rawCart = row.cart;
    const parsedCart =
      typeof rawCart === 'string'
        ? (() => {
            try {
              return JSON.parse(rawCart);
            } catch {
              return [];
            }
          })()
        : rawCart;
    return {
      ...user,
      cart: normalizeCartItems(parsedCart),
    };
  } catch (error) {
    logger.warn({ err: error, userId: user.id }, 'Failed to hydrate user cart from MySQL');
    return user;
  }
};

const sanitizeUser = (user) => {
  const normalizeRepSummary = (rep) => {
    if (!rep || typeof rep !== 'object') return null;
    const repId = normalizeId(rep.id || rep.salesRepId || rep.legacyUserId);
    if (!repId) return null;
    return {
      id: repId,
      name: normalizeOptionalString(rep.name),
      email: normalizeOptionalString(rep.email),
      phone: normalizeOptionalString(rep.phone),
      jurisdiction: normalizeOptionalString(rep.jurisdiction),
      isPartner: normalizeBooleanFlag(rep.isPartner ?? rep.is_partner),
      allowedRetail: normalizeBooleanFlag(rep.allowedRetail ?? rep.allowed_retail),
    };
  };

  const resolveSalesRepSummary = (rawUser) => {
    if (!rawUser || typeof rawUser !== 'object') return null;
    const embedded = normalizeRepSummary(rawUser.salesRep);
    if (embedded) return embedded;

    const repId = normalizeId(rawUser.salesRepId || rawUser.sales_rep_id);
    const userRole = normalizeRole(rawUser.role);
    const repEmailCandidate = normalizeEmail(rawUser.email);
    let repRecord = null;

    if (repId) {
      repRecord = salesRepRepository.findById(repId);
    }

    if (!repRecord && (userRole === 'sales_rep' || userRole === 'sales_partner' || userRole === 'rep' || userRole === 'sales_lead')) {
      repRecord = salesRepRepository.findByEmail(repEmailCandidate);
    }

    return normalizeRepSummary(repRecord);
  };

  const {
    password,
    passkeys,
    ...rest
  } = user;
  return {
    ...rest,
    profileImageUrl: normalizeOptionalString(user.profileImageUrl),
    profileOnboarding: normalizeBooleanFlag(
      user.profileOnboarding ?? user.profile_onboarding,
    ),
    resellerPermitOnboardingPresented: normalizeBooleanFlag(
      user.resellerPermitOnboardingPresented ?? user.reseller_permit_onboarding_presented,
    ),
    isTaxExempt: normalizeBooleanFlag(user.isTaxExempt ?? user.is_tax_exempt),
    taxExemptSource: normalizeOptionalString(user.taxExemptSource ?? user.tax_exempt_source),
    taxExemptReason: normalizeOptionalString(user.taxExemptReason ?? user.tax_exempt_reason),
    resellerPermitFilePath: normalizeOptionalString(
      user.resellerPermitFilePath ?? user.reseller_permit_file_path,
    ),
    resellerPermitFileName: normalizeOptionalString(
      user.resellerPermitFileName ?? user.reseller_permit_file_name,
    ),
    resellerPermitUploadedAt: normalizeOptionalString(
      user.resellerPermitUploadedAt ?? user.reseller_permit_uploaded_at,
    ),
    resellerPermitApprovedByRep: normalizeBooleanFlag(
      user.resellerPermitApprovedByRep ?? user.reseller_permit_approved_by_rep,
    ),
    greaterArea: normalizeOptionalString(user.greaterArea),
    studyFocus: normalizeOptionalString(user.studyFocus),
    bio: normalizeOptionalString(user.bio),
    networkPresenceAgreement: normalizeBooleanFlag(
      user.networkPresenceAgreement ?? user.network_presence_agreement,
    ),
    delegateLogoUrl: normalizeOptionalString(user.delegateLogoUrl),
    delegateSecondaryColor: normalizeOptionalString(user.delegateSecondaryColor),
    cart: normalizeCartItems(user.cart),
    role: normalizeRole(user.role),
    researchTermsAgreement: normalizeBooleanFlag(
      user.researchTermsAgreement ?? user.research_terms_agreement,
    ),
    delegateOptIn: normalizeBooleanFlag(
      user.delegateOptIn ?? user.delegate_opt_in,
    ),
    receiveClientOrderUpdateEmails: normalizeBooleanFlag(user.receiveClientOrderUpdateEmails),
    hasPasskeys: Array.isArray(passkeys) && passkeys.length > 0,
    salesRep: resolveSalesRepSummary(user),
  };
};

const hasRequiredDoctorProfileFields = (user) => [
  user?.name,
  user?.email,
  user?.greaterArea ?? user?.greater_area,
  user?.studyFocus ?? user?.study_focus,
].every((field) => typeof field === 'string' && field.trim().length > 0);

const sanitizeUserForAuthResponse = (user) => {
  const sanitized = sanitizeUser(user);
  return {
    ...sanitized,
    // Large data URLs make login/register responses noticeably slower.
    // The client can hydrate these later via profile fetch/update flows.
    profileImageUrl: null,
    delegateLogoUrl: null,
  };
};

const normalizeHumanName = (value = '') =>
  String(value)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const HONORIFIC_TOKENS = new Set(['mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'sir', 'madam']);
const SUFFIX_TOKENS = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

const tokenizeName = (value = '') =>
  normalizeHumanName(value)
    .split(' ')
    .map((token) => token.replace(/[.,]/g, ''))
    .filter(
      (token) =>
        token &&
        !HONORIFIC_TOKENS.has(token) &&
        !SUFFIX_TOKENS.has(token),
    );

const namesRoughlyMatch = (a = '', b = '') => {
  const tokensA = tokenizeName(a);
  const tokensB = tokenizeName(b);
  if (!tokensA.length || !tokensB.length) {
    return false;
  }
  if (tokensA.join(' ') === tokensB.join(' ')) {
    return true;
  }
  const firstA = tokensA[0];
  const lastA = tokensA[tokensA.length - 1];
  const firstB = tokensB[0];
  const lastB = tokensB[tokensB.length - 1];
  if (!firstA || !lastA || !firstB || !lastB) {
    return false;
  }
  if (firstA !== firstB || lastA !== lastB) {
    return false;
  }
  const middleA = tokensA.slice(1, -1).join(' ');
  const middleB = tokensB.slice(1, -1).join(' ');
  if (!middleA || !middleB) {
    return true;
  }
  return middleA === middleB;
};

// Keep auth tokens short-lived; additional server-side checks enforce idle/session limits as well.
const createAuthToken = (payload) => jwt.sign(payload, env.jwtSecret, { expiresIn: '24h' });

const comparePassword = async (plainText, hashed) => {
  if (typeof hashed !== 'string' || !BCRYPT_REGEX.test(hashed)) {
    // Treat malformed hashes as invalid credentials instead of throwing
    return false;
  }
  try {
    return await bcrypt.compare(plainText, hashed);
  } catch (error) {
    if (error instanceof Error && /invalid salt/i.test(error.message)) {
      return false;
    }
    throw error;
  }
};

const createError = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const normalizeDoctorProfileTextField = (field, value) => {
  const normalized = normalizeOptionalString(value);
  if (normalized && normalized.length > DOCTOR_PROFILE_FIELD_LIMITS[field]) {
    throw createError(`${String(field).toUpperCase()}_TOO_LONG`, 400);
  }
  return normalized;
};

const isPhysicianTaxonomy = (value) => {
  if (!value) {
    return false;
  }
  const normalized = String(value).toLowerCase();
  return normalized.includes('physician');
};

const resolveSalesRepIdFromReferralCode = (codeValue) => {
  const normalizedCode = normalizeCode(codeValue);
  if (!normalizedCode) return null;

  const reps = salesRepRepository.getAll();
  const repMatch = reps.find((rep) => normalizeCode(rep?.salesCode || rep?.sales_code) === normalizedCode) || null;
  if (repMatch) {
    return normalizeId(repMatch?.id || repMatch?.salesRepId || repMatch?.legacyUserId);
  }

  const record = referralCodeRepository.findByCode(normalizedCode);
  if (!record) {
    return null;
  }
  const status = (record.status || '').toString().trim().toLowerCase();
  if (status === 'revoked' || status === 'retired') {
    throw createError('REFERRAL_CODE_UNAVAILABLE', 409);
  }
  return normalizeId(record.salesRepId);
};

const ensureConvertedSalesProspectForDoctor = async ({
  doctorId,
  salesRepId,
  name,
  email,
  phone,
}) => {
  const docId = normalizeId(doctorId);
  const repId = normalizeId(salesRepId);
  if (!docId || !repId) return null;

  const emailNormalized = normalizeEmail(email);
  let existing = await salesProspectRepository.findBySalesRepAndDoctorId(repId, docId);
  if (!existing && emailNormalized) {
    existing = await salesProspectRepository.findBySalesRepAndContactEmail(repId, emailNormalized);
  }

  const existingStatus = (existing?.status || '').toString().trim().toLowerCase();
  const preserveStatus = existingStatus === 'nuture' || existingStatus === 'nurturing';

  const existingId = existing?.id ? String(existing.id) : '';
  const isDoctorProspect = Boolean(existingId.startsWith('doctor:'))
    && Boolean(normalizeId(existing?.doctorId))
    && !normalizeId(existing?.referralId)
    && !normalizeId(existing?.contactFormId);
  const resolvedIsManual = existing
    ? (isDoctorProspect ? true : Boolean(existing.isManual))
    : true;

  return salesProspectRepository.upsert({
    ...(existing || {}),
    id: existing?.id || `doctor:${docId}`,
    salesRepId: repId,
    doctorId: docId,
    status: preserveStatus ? (existing?.status || 'converted') : 'converted',
    isManual: resolvedIsManual,
    contactName: name || existing?.contactName || null,
    contactEmail: emailNormalized || existing?.contactEmail || null,
    contactPhone: phone || existing?.contactPhone || null,
  });
};

const register = async ({
  name,
  email,
  password,
  code,
  npiNumber,
  phone,
}) => {
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  const normalizedEmail = normalizeEmail(email);
  const rawPassword = typeof password === 'string' ? password : '';
  const normalizedCode = normalizeCode(code);
  const normalizedPhone = normalizeOptionalString(phone);

  if (!normalizedName || !normalizedEmail) {
    throw createError('NAME_EMAIL_REQUIRED', 400);
  }
  if (!rawPassword.trim()) {
    throw createError('PASSWORD_REQUIRED', 400);
  }
  if (!normalizedCode || !SALES_CODE_PATTERN.test(normalizedCode)) {
    throw createError('INVALID_REFERRAL_CODE', 400);
  }

  const existing = userRepository.findByEmail(normalizedEmail);
  if (existing) {
    throw createError('EMAIL_EXISTS', 409);
  }

  const salesRepAccount = salesRepRepository.findByEmail(normalizedEmail);
  const isSalesRepEmail = Boolean(salesRepAccount);
  const adminAccount = adminRepository.findByEmail(normalizedEmail);
  const isAdminEmail = Boolean(adminAccount);

  const normalizedNpi = normalizeNpiNumber(npiNumber);
  const hasValidNpi = /^\d{10}$/.test(normalizedNpi);

  if (!isSalesRepEmail && !isAdminEmail && !hasValidNpi) {
    throw createError('NPI_INVALID', 400);
  }

  if (hasValidNpi) {
    const existingNpi = userRepository.findByNpiNumber(normalizedNpi);
    if (existingNpi) {
      throw createError('NPI_ALREADY_REGISTERED', 409);
    }
  }

  const npiVerification = hasValidNpi
    ? await verifyDoctorNpi(normalizedNpi)
    : null;

  if (!isSalesRepEmail && !isAdminEmail && npiVerification?.name) {
    if (!namesRoughlyMatch(name, npiVerification.name)) {
      throw createError('NPI_NAME_MISMATCH', 422);
    }
  }

  const hashedPassword = await bcrypt.hash(rawPassword, 10);
  const now = new Date().toISOString();

  let npiVerificationStatus = null;
  let isTaxExempt = false;
  let taxExemptSource = null;
  let taxExemptReason = null;

  if (npiVerification) {
    const physicianTaxonomy = isPhysicianTaxonomy(npiVerification.primaryTaxonomy);
    npiVerificationStatus = physicianTaxonomy ? 'VALID_PHYSICIAN' : 'VALID';
    if (physicianTaxonomy) {
      isTaxExempt = true;
      taxExemptSource = 'NPI_VERIFICATION';
      taxExemptReason = 'Licensed medical provider purchasing prescription products';
    }
  }

  if (isSalesRepEmail) {
    const expected = normalizeCode(salesRepAccount?.salesCode || salesRepAccount?.sales_code);
    if (expected && expected !== normalizedCode) {
      throw createError('SALES_REP_EMAIL_MISMATCH', 409);
    }
  }

  const role = isAdminEmail
    ? 'admin'
    : (isSalesRepEmail
      ? (normalizeBooleanFlag(salesRepAccount?.isPartner ?? salesRepAccount?.is_partner) ? 'sales_partner' : 'sales_rep')
      : 'doctor');
  const resolvedDoctorSalesRepId = role === 'doctor'
    ? resolveSalesRepIdFromReferralCode(normalizedCode)
    : null;
  if (role === 'doctor' && !resolvedDoctorSalesRepId) {
    throw createError('REFERRAL_CODE_NOT_FOUND', 404);
  }

  const user = userRepository.insert({
    id: Date.now().toString(),
    name: normalizedName,
    email: normalizedEmail,
    phone: normalizedPhone,
    password: hashedPassword,
    referralCode: adminAccount?.referralCode || referralService.generateReferralCode(),
    referralCredits: 0,
    totalReferrals: 0,
    visits: 1,
    createdAt: now,
    lastLoginAt: now,
    role,
    salesRepId: isSalesRepEmail
      ? salesRepAccount?.id
        || salesRepAccount?.legacyUserId
        || salesRepAccount?.salesRepId
        || null
      : resolvedDoctorSalesRepId,
    npiNumber: npiVerification ? npiVerification.npiNumber : null,
    npiLastVerifiedAt: npiVerification ? now : null,
    npiVerificationStatus,
    isTaxExempt,
    taxExemptSource,
    taxExemptReason,
    researchTermsAgreement: false,
    delegateOptIn: false,
    profileOnboarding: false,
    networkPresenceAgreement: true,
    resellerPermitOnboardingPresented: false,
    resellerPermitApprovedByRep: false,
    greaterArea: null,
    studyFocus: null,
    bio: null,
    npiVerification: npiVerification
      ? {
        name: npiVerification.name,
        credential: npiVerification.credential,
        enumerationType: npiVerification.enumerationType,
        primaryTaxonomy: npiVerification.primaryTaxonomy,
        organizationName: npiVerification.organizationName,
      }
      : null,
    profileImageUrl: null,
  });

  if (role === 'doctor' && resolvedDoctorSalesRepId) {
    ensureConvertedSalesProspectForDoctor({
      doctorId: user.id,
      salesRepId: resolvedDoctorSalesRepId,
      name: user.name,
      email: user.email,
      phone: user.phone,
    }).catch((error) => {
      logger.warn({ err: error, doctorId: user.id, salesRepId: resolvedDoctorSalesRepId }, 'Failed to create converted sales prospect for new doctor');
    });
  }

  const token = createAuthToken({ id: user.id, email: user.email });
  const hydratedUser = await hydrateUserCartFromSql(user);

  return {
    token,
    user: sanitizeUserForAuthResponse(hydratedUser),
  };
};

const login = async ({ email, password }) => {
  if (!email || !password) {
    const error = new Error('Email and password required');
    error.status = 400;
    throw error;
  }

  const maskedEmail = maskEmailForLog(email);
  const totalStart = startTimer();
  const lookupStart = startTimer();
  const user = userRepository.findByEmail(email);
  const lookupMs = elapsedMs(lookupStart);

  if (!user) {
    logger.warn(
      { email: maskedEmail, lookupMs: formatMs(lookupMs) },
      'AuthService login email lookup failed',
    );
    const error = new Error('EMAIL_NOT_FOUND');
    error.status = 404;
    throw error;
  }

  const passwordStart = startTimer();
  const validPassword = await comparePassword(password, user.password);
  const passwordMs = elapsedMs(passwordStart);

  if (!validPassword) {
    logger.warn(
      { email: maskedEmail, passwordMs: formatMs(passwordMs) },
      'AuthService login invalid password',
    );
    const error = new Error('INVALID_PASSWORD');
    error.status = 401;
    throw error;
  }

  const persistStart = startTimer();
  const nowIso = new Date().toISOString();
  const updated = userRepository.update({
    ...user,
    visits: (user.visits || 1) + 1,
    lastLoginAt: nowIso,
    lastSeenAt: nowIso,
    lastInteractionAt: nowIso,
    isOnline: true,
    isIdle: false,
  });
  const persistMs = elapsedMs(persistStart);

  const token = createAuthToken({ id: user.id, email: user.email });
  const totalMs = elapsedMs(totalStart);
  const hydratedUser = await hydrateUserCartFromSql(updated || user);
  const sanitizedUser = sanitizeUserForAuthResponse(hydratedUser);

  logger.debug(
    {
      email: maskedEmail,
      userId: sanitizedUser.id,
      lookupMs: formatMs(lookupMs),
      passwordMs: formatMs(passwordMs),
      persistMs: formatMs(persistMs),
      totalMs: formatMs(totalMs),
    },
    'AuthService login timings',
  );

  return {
    token,
    user: sanitizedUser,
  };
};

const checkEmail = (email) => {
  if (!email) {
    const error = new Error('EMAIL_REQUIRED');
    error.status = 400;
    throw error;
  }
  const exists = Boolean(userRepository.findByEmail(email));
  return { exists };
};

const getProfile = async (userId) => {
  const user = userRepository.findById(userId);
  if (!user) {
    const error = new Error('User not found');
    error.status = 404;
    throw error;
  }
  return sanitizeUser(await hydrateUserCartFromSql(user));
};

const updateProfile = async (userId, data) => {
  const user = userRepository.findById(userId);
  if (!user) {
    const error = new Error('User not found');
    error.status = 404;
    throw error;
  }

  const next = { ...user };
  if (typeof data.name === 'string' && data.name.trim()) next.name = data.name.trim();
  if (typeof data.phone === 'string') next.phone = data.phone.trim();
  if (typeof data.email === 'string' && data.email.trim() && data.email.trim() !== user.email) {
    const existing = userRepository.findByEmail(data.email.trim());
    if (existing && existing.id !== user.id) {
      const error = new Error('EMAIL_EXISTS');
      error.status = 409;
      throw error;
    }
    next.email = data.email.trim();
  }

  DIRECT_SHIPPING_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      next[field] = normalizeOptionalString(data[field]);
    }
  });
  if (Object.prototype.hasOwnProperty.call(data, 'profileImageUrl')) {
    next.profileImageUrl = normalizeOptionalString(data.profileImageUrl);
    logger.info(
      {
        userId: user.id,
        profileImageUrl: next.profileImageUrl,
        mysqlEnabled: mysqlClient.isEnabled(),
        profileImageBytes: next.profileImageUrl
          ? Buffer.byteLength(next.profileImageUrl, 'utf8')
          : 0,
      },
      'Profile image value saved to user record',
    );
  }
  if (Object.prototype.hasOwnProperty.call(data, 'delegateLogoUrl')) {
    next.delegateLogoUrl = normalizeOptionalString(data.delegateLogoUrl);
  }
  if (Object.prototype.hasOwnProperty.call(data, 'delegateSecondaryColor')) {
    next.delegateSecondaryColor = normalizeOptionalString(data.delegateSecondaryColor);
  }
  if (Object.prototype.hasOwnProperty.call(data, 'receiveClientOrderUpdateEmails')) {
    next.receiveClientOrderUpdateEmails = normalizeBooleanFlag(
      data.receiveClientOrderUpdateEmails,
    );
  }
  if (Object.prototype.hasOwnProperty.call(data, 'researchTermsAgreement')) {
    next.researchTermsAgreement = normalizeBooleanFlag(data.researchTermsAgreement);
  }
  if (Object.prototype.hasOwnProperty.call(data, 'delegateOptIn')) {
    next.delegateOptIn = normalizeBooleanFlag(data.delegateOptIn);
  }
  if (Object.prototype.hasOwnProperty.call(data, 'profileOnboarding')) {
    next.profileOnboarding = normalizeBooleanFlag(data.profileOnboarding);
  }
  if (Object.prototype.hasOwnProperty.call(data, 'networkPresenceAgreement')) {
    next.networkPresenceAgreement = normalizeBooleanFlag(data.networkPresenceAgreement);
    next.network_presence_agreement = next.networkPresenceAgreement ? 1 : 0;
  } else if (Object.prototype.hasOwnProperty.call(data, 'network_presence_agreement')) {
    next.networkPresenceAgreement = normalizeBooleanFlag(data.network_presence_agreement);
    next.network_presence_agreement = next.networkPresenceAgreement ? 1 : 0;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'resellerPermitOnboardingPresented')) {
    next.resellerPermitOnboardingPresented = normalizeBooleanFlag(
      data.resellerPermitOnboardingPresented,
    );
  }
  ['greaterArea', 'studyFocus', 'bio'].forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      next[field] = normalizeDoctorProfileTextField(field, data[field]);
    }
  });
  if (normalizeRole(next.role) === 'doctor' || normalizeRole(next.role) === 'test_doctor') {
    next.profileOnboarding = hasRequiredDoctorProfileFields(next);
  }
  const updated = userRepository.update(next, { syncToSql: false }) || next;
  await userRepository.syncDirectShippingToSql(updated, { throwOnError: true });
  logger.debug(
    {
      userId: updated.id,
      profileImageUrl: updated.profileImageUrl,
      mysqlEnabled: mysqlClient.isEnabled(),
      profileImageBytes: updated.profileImageUrl
        ? Buffer.byteLength(updated.profileImageUrl, 'utf8')
        : 0,
    },
    'Profile update persisted across stores (local + MySQL sync completed)',
  );

  const normalizedRole = normalizeRole(updated.role);
  if ((normalizedRole === 'sales_rep' || normalizedRole === 'sales_partner') && updated.salesRepId) {
    salesRepRepository.update({
      id: updated.salesRepId,
      phone: updated.phone,
    });
  }

  return sanitizeUser(updated);
};

const uploadResellerPermit = async (userId, parsed) => {
  const user = userRepository.findById(userId);
  if (!user) {
    throw createError('User not found', 404);
  }

  const fileBuffer = Buffer.isBuffer(parsed?.buffer) ? parsed.buffer : null;
  if (!fileBuffer || fileBuffer.length === 0) {
    throw createError('No file provided', 400);
  }

  const ext = path.extname(String(parsed?.filename || '')).toLowerCase();
  if (!RESELLER_PERMIT_ALLOWED_EXTENSIONS.has(ext)) {
    throw createError('Invalid file type', 400);
  }

  const safeOriginal = path
    .basename(String(parsed?.filename || 'reseller_permit'))
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 160) || 'reseller_permit';
  const storedName = `reseller_permit_${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`;
  await fs.promises.mkdir(RESELLER_PERMIT_UPLOAD_DIR, { recursive: true });
  const storedPath = path.join(RESELLER_PERMIT_UPLOAD_DIR, storedName);
  await fs.promises.writeFile(storedPath, fileBuffer);

  const next = {
    ...user,
    resellerPermitOnboardingPresented: true,
    ...resolveTaxExemptionWithoutResellerPermit(user),
    resellerPermitFilePath: path.posix.join('uploads', 'reseller-permits', storedName),
    resellerPermitFileName: safeOriginal,
    resellerPermitUploadedAt: new Date().toISOString(),
    resellerPermitApprovedByRep: false,
  };
  const updated = userRepository.update(next) || next;
  await deleteStoredResellerPermitFile(user);
  return sanitizeUser(updated);
};

const resolveTaxExemptionWithoutResellerPermit = (user) => {
  const currentSource = normalizeOptionalString(
    user?.taxExemptSource ?? user?.tax_exempt_source,
  );
  if (currentSource && currentSource !== 'RESELLER_PERMIT') {
    return {
      isTaxExempt: normalizeBooleanFlag(user?.isTaxExempt ?? user?.is_tax_exempt),
      taxExemptSource: currentSource,
      taxExemptReason: normalizeOptionalString(
        user?.taxExemptReason ?? user?.tax_exempt_reason,
      ),
    };
  }

  const verificationStatus = normalizeOptionalString(
    user?.npiVerificationStatus ?? user?.npi_verification_status,
  );
  if (verificationStatus === 'VALID_PHYSICIAN') {
    return {
      isTaxExempt: true,
      taxExemptSource: 'NPI_VERIFICATION',
      taxExemptReason: 'Licensed medical provider purchasing prescription products',
    };
  }

  return {
    isTaxExempt: false,
    taxExemptSource: null,
    taxExemptReason: null,
  };
};

const deleteResellerPermit = async (userId) => {
  const user = userRepository.findById(userId);
  if (!user) {
    throw createError('User not found', 404);
  }

  const next = {
    ...user,
    ...resolveTaxExemptionWithoutResellerPermit(user),
    resellerPermitFilePath: null,
    resellerPermitFileName: null,
    resellerPermitUploadedAt: null,
    resellerPermitApprovedByRep: false,
    resellerPermitOnboardingPresented: true,
  };
  const updated = userRepository.update(next) || next;
  await deleteStoredResellerPermitFile(user);
  return sanitizeUser(updated);
};

const updateCart = async (userId, cart) => {
  const user = userRepository.findById(userId);
  if (!user) {
    throw createError('User not found', 404);
  }
  const updated = userRepository.update({
    ...user,
    cart: normalizeCartItems(cart),
  }) || user;
  return sanitizeUser(updated);
};

const emailService = require('./emailService');

// In-memory store for password reset tokens.
// TODO: Replace this with a database table.
const passwordResetTokens = new Map();

const requestPasswordReset = async (email) => {
  const normalizedEmail = typeof email === 'string' ? email.trim() : '';

  if (!normalizedEmail) {
    throw createError('EMAIL_REQUIRED', 400);
  }

  const lookupEmails = [normalizedEmail];
  const lowered = normalizedEmail.toLowerCase();
  if (!lookupEmails.includes(lowered)) {
    lookupEmails.push(lowered);
  }

  const user = lookupEmails
    .map((candidate) => userRepository.findByEmail(candidate))
    .find(Boolean);
  if (!user) {
    // Don't reveal if a user doesn't exist.
    // Just log it and return successfully.
    logger.info({ email: maskEmailForLog(normalizedEmail) }, 'Password reset request for non-existent user');
    return null;
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + 3600000; // 1 hour

  passwordResetTokens.set(token, { userId: user.id, expires });

  await emailService.sendPasswordResetEmail(user.email || normalizedEmail, token);
  return { token };
};

const resetPassword = async ({ token, password }) => {
  const normalizedToken = typeof token === 'string' ? token.trim() : '';
  const nextPassword = typeof password === 'string' ? password.trim() : '';

  if (!normalizedToken) {
    throw createError('TOKEN_REQUIRED', 400);
  }

  if (!nextPassword) {
    throw createError('PASSWORD_REQUIRED', 400);
  }

  const tokenData = passwordResetTokens.get(normalizedToken);

  if (!tokenData || tokenData.expires < Date.now()) {
    throw createError('Invalid or expired password reset token', 400);
  }

  const user = userRepository.findById(tokenData.userId);
  if (!user) {
    throw createError('User not found', 404);
  }

  const hashedPassword = await bcrypt.hash(nextPassword, 10);
  userRepository.update({ ...user, password: hashedPassword, mustResetPassword: false });

  passwordResetTokens.delete(normalizedToken);
};

const deleteAccount = async (userId) => {
  const normalizedUserId = normalizeId(userId);
  if (!normalizedUserId) {
    throw createError('USER_ID_REQUIRED', 400);
  }
  await deleteAccountAndRewriteReferences({
    userId: normalizedUserId,
    replacementUserId: DELETED_USER_ID,
  });
  for (const [token, tokenData] of passwordResetTokens.entries()) {
    if (normalizeId(tokenData?.userId) === normalizedUserId) {
      passwordResetTokens.delete(token);
    }
  }
  return {
    ok: true,
    deletedUserId: normalizedUserId,
    replacementUserId: DELETED_USER_ID,
  };
};

module.exports = {
  register,
  login,
  checkEmail,
  getProfile,
  updateProfile,
  uploadResellerPermit,
  deleteResellerPermit,
  updateCart,
  sanitizeUser,
  sanitizeUserForAuthResponse,
  createAuthToken,
  requestPasswordReset,
  resetPassword,
  deleteAccount,
};

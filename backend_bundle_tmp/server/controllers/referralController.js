const crypto = require('crypto');
const referralRepository = require('../repositories/referralRepository');
const referralCodeRepository = require('../repositories/referralCodeRepository');
const creditLedgerRepository = require('../repositories/creditLedgerRepository');
const salesRepRepository = require('../repositories/salesRepRepository');
const userRepository = require('../repositories/userRepository');
const mysqlClient = require('../database/mysqlClient');
const { logger } = require('../config/logger');

const REFERRAL_STATUSES = ['pending', 'contacted', 'account_created', 'nuture', 'converted', 'contact_form'];

const REFERRAL_CODE_STATUSES = ['available', 'assigned', 'revoked', 'retired'];

const normalizeRole = (role) => (role || '').toString().trim().toLowerCase();
const normalizeCode = (value) => {
  if (!value) return null;
  const normalized = String(value).trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
};
const buildInitials = (user) => {
  const source = `${user?.initials || ''} ${user?.name || ''} ${user?.email || ''}`;
  const letters = source.replace(/[^a-zA-Z]/g, '');
  const base = letters.slice(0, 2).toUpperCase();
  return (base || 'PP').padEnd(2, 'X').slice(0, 2);
};
const randomSuffix = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let output = '';
  crypto.randomBytes(3).forEach((byte) => {
    output += alphabet[byte % alphabet.length];
  });
  return output.slice(0, 3);
};

const isRep = (role) => {
  const normalized = normalizeRole(role);
  return normalized === 'sales_rep' || normalized === 'rep';
};
const ensureDoctor = (user, context = 'unknown') => {
  const role = normalizeRole(user?.role);
  if (!user || (role !== 'doctor' && role !== 'test_doctor' && role !== 'admin')) {
    logger.warn(
      {
        context,
        userId: user?.id || null,
        role: user?.role || null,
      },
      'Doctor access required but not satisfied',
    );
    const error = new Error('Doctor access required');
    error.status = 403;
    throw error;
  }
};

const ensureSalesRep = (user, context = 'unknown') => {
  const role = normalizeRole(user?.role);
  if (!user || (!isRep(role) && role !== 'admin')) {
    logger.warn(
      {
        context,
        userId: user?.id || null,
        role: user?.role || null,
      },
      'Sales representative access required but not satisfied',
    );
    const error = new Error('Sales representative access required');
    error.status = 403;
    throw error;
  }
};

const submitDoctorReferral = (req, res, next) => {
  try {
    ensureDoctor(req.user, 'submitDoctorReferral');
    const { contactName, contactEmail, contactPhone, notes } = req.body || {};
    if (!contactName || typeof contactName !== 'string') {
      const error = new Error('Contact name is required');
      error.status = 400;
      throw error;
    }

    const now = new Date().toISOString();
    const record = referralRepository.insert({
      id: crypto.randomUUID(),
      referrerDoctorId: req.user.id,
      salesRepId: req.user.salesRepId || null,
      referredContactName: contactName.trim(),
      referredContactEmail: contactEmail || null,
      referredContactPhone: contactPhone || null,
      status: 'pending',
      notes: notes || null,
      createdAt: now,
      updatedAt: now,
      referrerDoctorName: req.user.name || null,
      referrerDoctorEmail: req.user.email || null,
      referrerDoctorPhone: req.user.phone || null,
    });

    res.json({ referral: record });
  } catch (error) {
    next(error);
  }
};

const deleteDoctorReferral = (req, res, next) => {
  try {
    ensureDoctor(req.user, 'deleteDoctorReferral');
    const { referralId } = req.params;
    const referral = referralRepository.findById(referralId);
    if (!referral) {
      // treat missing as already deleted for idempotency
      return res.json({ deleted: true });
    }
    const status = (referral.status || '').toLowerCase();
    if (status !== 'pending') {
      const error = new Error('Referral can only be deleted while pending');
      error.status = 409;
      throw error;
    }
    const removed = referralRepository.remove(referralId);
    if (!removed) {
      return res.json({ deleted: true });
    }
    res.json({ deleted: true });
  } catch (error) {
    next(error);
  }
};

const buildDoctorCredits = (doctorId) => {
  const ledger = creditLedgerRepository.findByDoctorId(doctorId);
  const totalCredits = ledger.reduce((sum, entry) => {
    const amount = Number(entry.amount) || 0;
    return entry.direction === 'debit' ? sum - amount : sum + amount;
  }, 0);
  const firstOrderBonuses = ledger.filter((entry) => entry.firstOrderBonus).length;
  return {
    totalCredits,
    firstOrderBonuses,
    ledger,
  };
};

const buildAggregatedCredits = (doctorIds = []) => {
  const uniqueDoctorIds = Array.from(new Set(doctorIds.filter(Boolean)));
  const aggregated = {
    totalCredits: 0,
    firstOrderBonuses: 0,
    ledger: [],
  };

  uniqueDoctorIds.forEach((doctorId) => {
    const summary = buildDoctorCredits(doctorId);
    aggregated.totalCredits += summary.totalCredits;
    aggregated.firstOrderBonuses += summary.firstOrderBonuses;
  });

  return aggregated;
};

const getDoctorSummary = (req, res, next) => {
  try {
    const role = normalizeRole(req.user?.role);
    logger.info(
      {
        userId: req.user?.id || null,
        role,
        salesRepId: req.user?.salesRepId || null,
        path: '/api/referrals/doctor/summary',
      },
      'Referral summary request',
    );
    if (!req.user) {
      const error = new Error('Authentication required');
      error.status = 401;
      throw error;
    }

    if (role === 'doctor' || role === 'test_doctor') {
      const referrals = referralRepository.findByDoctorId(req.user.id);
      const credits = buildDoctorCredits(req.user.id);
      res.json({
        credits,
        referrals,
        scope: 'doctor',
      });
      return;
    }

    if (role === 'sales_rep' || role === 'rep') {
      const salesRepId = req.user.salesRepId || req.user.id;
      const referrals = referralRepository.findBySalesRepId(salesRepId);
      const doctorIds = referrals.map((referral) => referral.referrerDoctorId).filter(Boolean);
      const credits = buildAggregatedCredits(doctorIds);
      res.json({
        credits,
        referrals,
        scope: 'sales_rep',
      });
      return;
    }

    if (role === 'admin') {
      const referrals = referralRepository.getAll();
      const doctorIds = referrals.map((referral) => referral.referrerDoctorId).filter(Boolean);
      const credits = buildAggregatedCredits(doctorIds);
      res.json({
        credits,
        referrals,
        scope: 'admin',
      });
      return;
    }

    logger.warn(
      { userId: req.user.id, role, path: '/api/referrals/doctor/summary' },
      'Access denied for doctor summary request',
    );
    const error = new Error('Doctor access required');
    error.status = 403;
    throw error;
  } catch (error) {
    next(error);
  }
};

const getDoctorLedger = (req, res, next) => {
  try {
    ensureDoctor(req.user, 'getDoctorLedger');
    const ledger = creditLedgerRepository.findByDoctorId(req.user.id);
    res.json({ ledger });
  } catch (error) {
    next(error);
  }
};

const getSalesRepDashboard = async (req, res, next) => {
  try {
    ensureSalesRep(req.user, 'getSalesRepDashboard');
    const role = normalizeRole(req.user.role);
    const isAdmin = role === 'admin';
    const requestedSalesRepId = req.query.salesRepId || req.user.salesRepId || req.user.id;
    const scopeAll = isAdmin && (req.query.scope || '').toLowerCase() === 'all';
    const salesRepId = scopeAll ? null : requestedSalesRepId;
    logger.info(
      {
        userId: req.user.id,
        role,
        requestedSalesRepId,
        salesRepId,
        scopeAll,
        path: '/api/referrals/admin/dashboard',
      },
      'Sales rep dashboard request',
    );
    const allReferrals = referralRepository.getAll();
    let referrals = scopeAll
      ? allReferrals
      : referralRepository.findBySalesRepId(salesRepId);
    // Include users/accounts to help UI detect account creation
    const rawUsers = userRepository.getAll();
    const users = scopeAll
      ? rawUsers
      : rawUsers.filter((user) => {
          const ownerIds = [user.salesRepId, user.id, user.sales_rep_id].map((v) =>
            v == null ? null : String(v),
          );
          return ownerIds.includes(String(salesRepId));
        });

    // Always merge in any unmatched referrals so local data (mismatched salesRepId) still appears
    if (!scopeAll) {
      const dedup = new Map();
      referrals.forEach((r) => dedup.set(r.id, r));
      allReferrals.forEach((r) => {
        if (!dedup.has(r.id)) {
          dedup.set(r.id, r);
        }
      });
      referrals = Array.from(dedup.values());
    }
    let codes = [];
    if (isAdmin) {
      codes = referralCodeRepository.getAll();
    } else {
      const ownerIds = [
        salesRepId || null,
        req.user?.id || null,
        req.user?.salesRepId || null,
      ].filter(Boolean);
      ownerIds.forEach((ownerId) => {
        codes = codes.concat(referralCodeRepository.findBySalesRepId(ownerId));
      });
    }

    // Merge sales rep "salesCode" from local store
    const mergeRepCodes = (repList) => {
      repList.forEach((rep) => {
        const repCode = normalizeCode(rep?.salesCode);
        if (!repCode) return;
        if (!codes.some((c) => normalizeCode(c.code) === repCode)) {
          const now = new Date().toISOString();
          codes.push({
            id: `sales-rep-code-${rep?.id || repCode}`,
            code: repCode,
            salesRepId: rep?.id || salesRepId || null,
            status: 'assigned',
            issuedAt: rep?.updatedAt || rep?.createdAt || now,
            updatedAt: rep?.updatedAt || now,
            referrerDoctorId: null,
            referralId: null,
            history: [
              {
                action: 'issued',
                at: now,
                by: rep?.id || salesRepId,
                status: 'assigned',
                source: 'sales_rep',
              },
            ],
          });
        }
      });
    };

    if (isAdmin) {
      mergeRepCodes(salesRepRepository.getAll());
    } else {
      const rep =
        salesRepRepository.findById(salesRepId) ||
        salesRepRepository.findByEmail(req.user?.email) ||
        [];
      mergeRepCodes([rep].filter(Boolean));
    }

    if (isAdmin && mysqlClient.isEnabled()) {
      try {
        const rows = await mysqlClient.fetchAll(
          `
            SELECT id, name, email, phone, source, created_at, updated_at, createdAt, updatedAt
            FROM contact_forms
            ORDER BY COALESCE(updated_at, updatedAt, created_at, createdAt) DESC
          `,
        );
        const mapped = (rows || []).map((row) => {
          const createdAt = row.created_at || row.createdAt || null;
          const updatedAt = row.updated_at || row.updatedAt || createdAt || null;
          return {
            id: row.id ? `contact_form:${row.id}` : crypto.randomUUID(),
            status: 'contact_form',
            salesRepId: null,
            referrerDoctorId: null,
            referrerDoctorName: 'Contact Form / House',
            referrerDoctorEmail: null,
            referrerDoctorPhone: null,
            referredContactName: row.name || 'Contact Form Lead',
            referredContactEmail: row.email || null,
            referredContactPhone: row.phone || null,
            notes: row.source || 'Contact form submission',
            createdAt: createdAt ? new Date(createdAt).toISOString() : new Date().toISOString(),
            updatedAt: updatedAt ? new Date(updatedAt).toISOString() : new Date().toISOString(),
            source: 'contact_form',
          };
        });
        referrals = [...mapped, ...referrals];
      } catch (error) {
        logger.error({ err: error }, 'Failed to load contact form referrals from MySQL');
      }
    }

    res.json({
      referrals,
      codes,
      users,
      statuses: REFERRAL_STATUSES,
    });
  } catch (error) {
    next(error);
  }
};

const createReferralCode = (req, res, next) => {
  try {
    ensureSalesRep(req.user, 'createReferralCode');
    const { referralId } = req.body || {};
    if (!referralId) {
      const error = new Error('Referral ID is required');
      error.status = 400;
      throw error;
    }
    const referral = referralRepository.findById(referralId);
    const isAdmin = normalizeRole(req.user?.role) === 'admin';
    const referralOwner = referral ? referral.salesRepId : null;
    const missingOwner = !referralOwner;
    const ownedByUser = referralOwner && referralOwner === req.user.id;
    if (!referral || (!isAdmin && !missingOwner && !ownedByUser)) {
      const error = new Error('Referral not found for sales representative');
      error.status = 404;
      throw error;
    }

    const salesRep =
      salesRepRepository.findById(req.user?.id) ||
      salesRepRepository.findByEmail(req.user?.email) ||
      {};
    const initials = buildInitials({ ...salesRep, ...req.user });
    const existingCodes = new Set(
      referralCodeRepository
        .getAll()
        .map((code) => (code.code || '').toString().toUpperCase())
        .filter(Boolean),
    );
    let codeValue = '';
    for (let attempts = 0; attempts < 200; attempts += 1) {
      const candidate = `${initials}${randomSuffix()}`.slice(0, 5).toUpperCase();
      if (!existingCodes.has(candidate)) {
        codeValue = candidate;
        break;
      }
    }
    if (!codeValue) {
      const error = new Error('Unable to generate referral code');
      error.status = 500;
      throw error;
    }
    const now = new Date().toISOString();
    const code = referralCodeRepository.insert({
      salesRepId: req.user.id,
      referrerDoctorId: referral.referrerDoctorId || null,
      referralId,
      code: codeValue,
      status: 'assigned',
      issuedAt: now,
      updatedAt: now,
      history: [
        {
          action: 'issued',
          at: now,
          by: req.user.id,
          status: 'assigned',
        },
      ],
    });

    referralRepository.update(referralId, {
      referralCodeId: code.id,
      status: 'contacted',
    });

    res.json({ code });
  } catch (error) {
    next(error);
  }
};

const updateReferralCodeStatus = (req, res, next) => {
  try {
    ensureSalesRep(req.user, 'updateReferralCodeStatus');
    const { codeId } = req.params;
    const { status } = req.body || {};
    if (!REFERRAL_CODE_STATUSES.includes(status)) {
      const error = new Error('Unsupported referral code status');
      error.status = 400;
      throw error;
    }
    const record = referralCodeRepository.findById(codeId);
    if (!record || record.salesRepId !== req.user.id) {
      const error = new Error('Referral code not found');
      error.status = 404;
      throw error;
    }
    const now = new Date().toISOString();
    const updatedHistory = Array.isArray(record.history) ? [...record.history] : [];
    updatedHistory.push({
      action: 'status_change',
      at: now,
      by: req.user.id,
      status,
    });
    const updated = referralCodeRepository.update(codeId, {
      status,
      history: updatedHistory,
    });
    res.json({ code: updated });
  } catch (error) {
    next(error);
  }
};

const listReferralCodes = (req, res, next) => {
  try {
    ensureSalesRep(req.user, 'listReferralCodes');
    const ownerIds = [
      req.user?.id || null,
      req.user?.salesRepId || null,
    ].filter(Boolean);

    // Collect any codes that match the user id or linked salesRepId
    const codes = ownerIds
      .map((ownerId) => referralCodeRepository.findBySalesRepId(ownerId))
      .flat();

    const rep =
      salesRepRepository.findById(req.user?.salesRepId || req.user?.id) ||
      salesRepRepository.findByEmail(req.user?.email);
    const repCode = normalizeCode(rep?.salesCode);
    if (repCode && !codes.some((c) => normalizeCode(c.code) === repCode)) {
      const now = new Date().toISOString();
      codes.push({
        id: `sales-rep-code-${rep?.id || repCode}`,
        code: repCode,
        salesRepId: rep?.id || req.user.id,
        status: 'assigned',
        issuedAt: rep?.updatedAt || rep?.createdAt || now,
        updatedAt: rep?.updatedAt || now,
        referrerDoctorId: null,
        referralId: null,
        history: [
          {
            action: 'issued',
            at: now,
            by: req.user.id,
            status: 'assigned',
            source: 'sales_rep',
          },
        ],
      });
    }
    res.json({ codes });
  } catch (error) {
    next(error);
  }
};

const updateReferral = (req, res, next) => {
  try {
    ensureSalesRep(req.user);
    const { referralId } = req.params;
    const updates = {};
    if (req.body?.status) {
      if (!REFERRAL_STATUSES.includes(req.body.status)) {
        const error = new Error('Unsupported referral status');
        error.status = 400;
        throw error;
      }
      updates.status = req.body.status;
    }
    ['notes', 'referredContactName', 'referredContactEmail', 'referredContactPhone'].forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
        updates[field] = req.body[field];
      }
    });
    if (Object.keys(updates).length === 0) {
      const error = new Error('No updates provided');
      error.status = 400;
      throw error;
    }

    const referral = referralRepository.findById(referralId);
    const isAdmin = normalizeRole(req.user?.role) === 'admin';
    const owner = referral ? referral.salesRepId : null;
    const ownedByUser = owner && owner === req.user.id;

    // If the record is missing locally (e.g., contact form or remote source), create it on the fly
    if (!referral) {
      const now = new Date().toISOString();
      const seeded = referralRepository.insert({
        id: referralId,
        salesRepId: req.user.id,
        status: updates.status || 'pending',
        notes: updates.notes || null,
        referrerDoctorId: req.body?.referrerDoctorId || null,
        referrerDoctorName: req.body?.referrerDoctorName || null,
        referrerDoctorEmail: req.body?.referrerDoctorEmail || null,
        referrerDoctorPhone: req.body?.referrerDoctorPhone || null,
        referredContactName: req.body?.referredContactName || 'Lead',
        referredContactEmail: req.body?.referredContactEmail || null,
        referredContactPhone: req.body?.referredContactPhone || null,
        referredContactHasAccount: false,
        referredContactEligibleForCredit: false,
        createdAt: now,
        updatedAt: now,
        history: [
          {
            action: 'status_seed',
            at: now,
            by: req.user.id,
            status: updates.status || 'pending',
          },
        ],
      });
      return res.json({
        referral: seeded,
        statuses: REFERRAL_STATUSES,
      });
    }

    if (!isAdmin && owner && !ownedByUser) {
      logger.warn(
        {
          referralId,
          referralOwner: owner,
          requestUser: req.user?.id || null,
          role: req.user?.role || null,
        },
        'Referral update by non-owner; reassigning to requesting sales rep',
      );
      updates.salesRepId = req.user.id;
    }

    const updated = referralRepository.update(referralId, updates);
    res.json({
      referral: updated,
      statuses: REFERRAL_STATUSES,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  submitDoctorReferral,
  deleteDoctorReferral,
  getDoctorSummary,
  getDoctorLedger,
  getSalesRepDashboard,
  createReferralCode,
  updateReferralCodeStatus,
  listReferralCodes,
  updateReferral,
  REFERRAL_STATUSES,
};

const crypto = require('crypto');
const referralRepository = require('../repositories/referralRepository');
const referralCodeRepository = require('../repositories/referralCodeRepository');
const creditLedgerRepository = require('../repositories/creditLedgerRepository');

const REFERRAL_STATUSES = [
  'pending',
  'contacted',
  'follow_up',
  'code_issued',
  'converted',
  'closed',
  'not_interested',
  'disqualified',
  'rejected',
  'in_review',
];

const REFERRAL_CODE_STATUSES = ['available', 'assigned', 'revoked', 'retired'];

const normalizeRole = (role) => (role || '').toString().trim().toLowerCase();
const isRep = (role) => normalizeRole(role) === 'sales_rep';
const ensureDoctor = (user) => {
  const role = normalizeRole(user?.role);
  if (!user || (role !== 'doctor' && role !== 'test_doctor' && role !== 'admin')) {
    const error = new Error('Doctor access required');
    error.status = 403;
    throw error;
  }
};

const ensureSalesRep = (user) => {
  const role = normalizeRole(user?.role);
  if (!user || (!isRep(role) && role !== 'admin')) {
    const error = new Error('Sales representative access required');
    error.status = 403;
    throw error;
  }
};

const submitDoctorReferral = (req, res, next) => {
  try {
    ensureDoctor(req.user);
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

const getDoctorSummary = (req, res, next) => {
  try {
    ensureDoctor(req.user);
    const referrals = referralRepository.findByDoctorId(req.user.id);
    const credits = buildDoctorCredits(req.user.id);
    res.json({
      credits,
      referrals,
    });
  } catch (error) {
    next(error);
  }
};

const getDoctorLedger = (req, res, next) => {
  try {
    ensureDoctor(req.user);
    const ledger = creditLedgerRepository.findByDoctorId(req.user.id);
    res.json({ ledger });
  } catch (error) {
    next(error);
  }
};

const getSalesRepDashboard = (req, res, next) => {
  try {
    ensureSalesRep(req.user);
    const role = normalizeRole(req.user.role);
    const isAdmin = role === 'admin';
    const referrals = isAdmin ? referralRepository.getAll() : referralRepository.findBySalesRepId(req.user.id);
    const codes = isAdmin ? referralCodeRepository.getAll() : referralCodeRepository.findBySalesRepId(req.user.id);
    res.json({
      referrals,
      codes,
      statuses: REFERRAL_STATUSES,
    });
  } catch (error) {
    next(error);
  }
};

const createReferralCode = (req, res, next) => {
  try {
    ensureSalesRep(req.user);
    const { referralId } = req.body || {};
    if (!referralId) {
      const error = new Error('Referral ID is required');
      error.status = 400;
      throw error;
    }
    const referral = referralRepository.findById(referralId);
    if (!referral || referral.salesRepId !== req.user.id) {
      const error = new Error('Referral not found for sales representative');
      error.status = 404;
      throw error;
    }

    const codeValue = `PP${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
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
      status: 'code_issued',
    });

    res.json({ code });
  } catch (error) {
    next(error);
  }
};

const updateReferralCodeStatus = (req, res, next) => {
  try {
    ensureSalesRep(req.user);
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
    if (!referral || referral.salesRepId !== req.user.id) {
      const error = new Error('Referral not found for sales representative');
      error.status = 404;
      throw error;
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
  getDoctorSummary,
  getDoctorLedger,
  getSalesRepDashboard,
  createReferralCode,
  updateReferralCodeStatus,
  updateReferral,
  REFERRAL_STATUSES,
};

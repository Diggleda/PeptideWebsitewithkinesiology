const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const referralRepository = require('../repositories/referralRepository');
const referralCodeRepository = require('../repositories/referralCodeRepository');
const creditLedgerRepository = require('../repositories/creditLedgerRepository');
const adminRepository = require('../repositories/adminRepository');
const salesRepRepository = require('../repositories/salesRepRepository');
const userRepository = require('../repositories/userRepository');
const salesProspectRepository = require('../repositories/salesProspectRepository');
const orderRepository = require('../repositories/orderRepository');
const mysqlClient = require('../database/mysqlClient');
const { logger } = require('../config/logger');
const { env } = require('../config/env');
const { parseMultipartSingleFile } = require('../utils/multipart');

const REFERRAL_STATUSES = ['pending', 'contacted', 'verified', 'account_created', 'converted', 'nuture', 'contact_form'];

const normalizeReferralStatus = (value) => {
  const normalized = (value || '').toString().trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'verifying') return 'verified';
  if (normalized === 'nurture') return 'nuture';
  if (normalized === 'nuturing') return 'nuture';
  if (normalized === 'account created') return 'account_created';
  if (normalized === 'account-created') return 'account_created';
  if (normalized === 'accountcreated') return 'account_created';
  return normalized;
};

const REFERRAL_CODE_STATUSES = ['available', 'assigned', 'revoked', 'retired'];

const normalizeRole = (role) => (role || '')
  .toString()
  .trim()
  .toLowerCase()
  .replace(/[\s-]+/g, '_');
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
  return (
    normalized === 'sales_rep' ||
    normalized === 'rep' ||
    normalized === 'sales_lead' ||
    normalized === 'saleslead'
  );
};

const isSalesLead = (role) => {
  const normalized = normalizeRole(role);
  return (
    normalized === 'sales_lead' ||
    normalized === 'saleslead'
  );
};

const ensureSalesLeadOrAdmin = (user, context = 'unknown') => {
  const role = normalizeRole(user?.role);
  if (user && (role === 'admin' || isSalesLead(role))) {
    return;
  }
  logger.warn(
    {
      context,
      userId: user?.id || null,
      role: user?.role || null,
    },
    'Sales lead or admin access required but not satisfied',
  );
  const error = new Error('Sales lead or admin access required');
  error.status = 403;
  throw error;
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

const normalizeOwnerIds = (user) => {
  return [
    user?.id || null,
    user?.salesRepId || null,
  ]
    .filter(Boolean)
    .map((value) => String(value));
};

const extractContactFormId = (identifier) => {
  const raw = String(identifier || '');
  if (!raw.startsWith('contact_form:')) return null;
  const [, value] = raw.split(':', 2);
  return value ? String(value).trim() : null;
};

const isHouseContactReferral = (referral) => {
  const id = String(referral?.id || '').trim().toLowerCase();
  const status = String(referral?.status || '').trim().toLowerCase();
  const source = String(referral?.source || '').trim().toLowerCase();
  const leadType = String(referral?.leadType || referral?.lead_type || '').trim().toLowerCase();
  const referrerName = String(referral?.referrerDoctorName || '').trim().toLowerCase();
  const contactFormId = String(referral?.contactFormId || referral?.contact_form_id || '').trim();
  const hasHouseReferrerName = referrerName === 'contact form / house' || referrerName === 'house / contact form';
  const sourceLooksContact = source === 'contact_form' || source === 'house' || source === 'house_contact';
  const leadTypeLooksContact = leadType === 'contact_form' || leadType === 'house' || leadType === 'house_contact';
  return status === 'contact_form'
    || id.startsWith('contact_form:')
    || Boolean(contactFormId)
    || sourceLooksContact
    || leadTypeLooksContact
    || hasHouseReferrerName;
};

const normalizeEmail = (value) => {
  if (value == null) return null;
  let normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith('mailto:')) {
    normalized = normalized.slice(7).trim();
  }
  const angleMatch = normalized.match(/<([^>]+)>/);
  if (angleMatch?.[1]) {
    normalized = angleMatch[1].trim();
  }
  normalized = normalized.replace(/\s+/g, '');
  return normalized || null;
};

const normalizePhoneDigits = (value) => {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/[^0-9]/g, '');
  return digits ? digits : null;
};

const buildAccountIndex = () => {
  const byEmail = new Map();
  const byPhone = new Map();
  try {
    userRepository.getAll().forEach((user) => {
      const role = normalizeRole(user?.role);
      if (role === 'admin' || role === 'sales_rep' || role === 'rep') {
        return;
      }
      const email = normalizeEmail(user?.email);
      if (email) {
        byEmail.set(email, {
          id: user?.id != null ? String(user.id) : null,
          email,
          source: 'user',
        });
      }
      const phone = normalizePhoneDigits(user?.phone);
      if (phone) {
        byPhone.set(phone, {
          id: user?.id != null ? String(user.id) : null,
          phone,
          source: 'user',
        });
      }
    });
  } catch {
    // ignore
  }
  return { byEmail, byPhone };
};

const fetchMysqlAccountLookup = async (emails) => {
  if (!mysqlClient.isEnabled()) {
    return null;
  }
  const normalized = Array.from(
    new Set((emails || []).map((email) => normalizeEmail(email)).filter(Boolean)),
  );
  if (normalized.length === 0) {
    return new Map();
  }
  const placeholders = normalized.map(() => '?').join(', ');
  const query = `SELECT id, email FROM users WHERE LOWER(TRIM(email)) IN (${placeholders})`;
  try {
    const rows = await mysqlClient.fetchAll(query, normalized);
    const lookup = new Map();
    (rows || []).forEach((row) => {
      const email = normalizeEmail(row?.email);
      if (email) {
        lookup.set(email, {
          id: row?.id != null ? String(row.id) : null,
          email,
          source: 'mysql',
        });
      }
    });
    return lookup;
  } catch (error) {
    logger.warn({ err: error }, 'Failed to query MySQL for referral account lookup');
    return null;
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

    // Status/notes live in sales_prospects in the new flow; create a prospect row when we can
    // associate this referral with a sales rep.
    if (record.salesRepId) {
      salesProspectRepository
        .upsert({
          id: String(record.id),
          salesRepId: String(record.salesRepId),
          referralId: String(record.id),
          status: 'pending',
          isManual: false,
          contactName: record.referredContactName,
          contactEmail: record.referredContactEmail,
          contactPhone: record.referredContactPhone,
          notes: null,
        })
        .catch((error) => {
          logger.warn({ err: error, referralId: record.id }, 'Failed to create sales prospect for referral');
        });
    }

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

    const checkDeletion = async () => {
      const referralStatus = String(referral.status || '').toLowerCase().trim() || 'pending';
      let prospectStatuses = [];
      try {
        const prospects = await salesProspectRepository.findAllByReferralId(referralId);
        prospectStatuses = (Array.isArray(prospects) ? prospects : [])
          .map((p) => String(p?.status || '').toLowerCase().trim() || 'pending');
      } catch (error) {
        logger.warn({ err: error, referralId }, 'Failed to load sales prospects while deleting referral');
      }

      const progressed = [referralStatus, ...prospectStatuses].some(
        (status) => status && status !== 'pending',
      );
      if (progressed) {
        const error = new Error('Referral can only be deleted while pending');
        error.status = 409;
        throw error;
      }
      const removed = referralRepository.remove(referralId);
      if (!removed) {
        return res.json({ deleted: true });
      }
      await salesProspectRepository.removeByReferralId(referralId).catch(() => null);
      return res.json({ deleted: true });
    };

    checkDeletion().catch(next);
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
			    const viewerSalesRepId = req.user.salesRepId || req.user.id;
			    const requestedSalesRepId = req.query.salesRepId || req.user.salesRepId || req.user.id;
			    const scopeAll = (isAdmin || isSalesLead(role)) && (req.query.scope || '').toLowerCase() === 'all';
			    const adminViewingAll = isAdmin && scopeAll;
			    const salesRepId = scopeAll ? null : requestedSalesRepId;
			    const isViewingOwnDashboard =
			      !req.query.salesRepId || String(req.query.salesRepId) === String(viewerSalesRepId);
			    const requestContext = String(req.query.context || '').trim().toLowerCase();
			    const includeContactForms =
			      isAdmin &&
			      mysqlClient.isEnabled() &&
			      (scopeAll || isViewingOwnDashboard) &&
			      requestContext !== 'modal';
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
    const userIds = (users || [])
      .map((u) => (u && u.id != null ? String(u.id) : null))
      .filter(Boolean);
    const orderCounts = {};
    if (userIds.length > 0) {
      if (mysqlClient.isEnabled()) {
        try {
          const placeholders = userIds.map((_, idx) => `:id${idx}`).join(', ');
          const params = userIds.reduce((acc, id, idx) => ({ ...acc, [`id${idx}`]: id }), {});
          const rows = await mysqlClient.fetchAll(
            `
              SELECT user_id AS userId, COUNT(*) AS count
              FROM peppro_orders
              WHERE user_id IN (${placeholders})
              GROUP BY user_id
            `,
            params,
          );
          (rows || []).forEach((row) => {
            if (row?.userId != null) {
              orderCounts[String(row.userId)] = Number(row.count) || 0;
            }
          });
        } catch (error) {
          logger.warn({ err: error }, 'Failed to load order counts for dashboard users');
        }
      } else {
        try {
          const orders = orderRepository.getAll();
          (orders || []).forEach((order) => {
            const uid = order?.userId != null ? String(order.userId) : null;
            if (!uid) return;
            if (!orderCounts[uid]) orderCounts[uid] = 0;
            orderCounts[uid] += 1;
          });
        } catch (error) {
          logger.warn({ err: error }, 'Failed to load local order counts for dashboard users');
        }
      }
    }
	    const usersWithOrders = (users || []).map((u) => ({
	      ...u,
	      totalOrders: orderCounts[String(u?.id)] || 0,
	    }));

	    let codes = [];
	    if (adminViewingAll) {
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

	    if (adminViewingAll) {
	      mergeRepCodes(salesRepRepository.getAll());
	    } else {
	      const rep =
	        salesRepRepository.findById(salesRepId) ||
	        salesRepRepository.findByEmail(req.user?.email) ||
	        [];
	      mergeRepCodes([rep].filter(Boolean));
	    }

		    // Contact form leads are "house/unassigned" prospects. They should be visible on the
		    // admin's own dashboard (and in global scope=all), but should NOT be injected when an
		    // admin fetches another rep's dashboard for the user modal.
		    if (includeContactForms) {
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

    // Overlay prospect-owned fields (status/notes/isManual) onto the referral list.
    // This allows the UI to remain backward compatible while we migrate the source of truth.
    try {
      const ownerIds = normalizeOwnerIds(req.user);
      const useOwnerId = !scopeAll ? String(salesRepId || '') : null;
      const allowedOwners = scopeAll && isAdmin ? null : new Set(ownerIds.concat(useOwnerId ? [useOwnerId] : []));

      const merged = await Promise.all(
        (referrals || []).map(async (referral) => {
          const id = String(referral?.id || '');
          if (!id) return referral;

          let prospect = await salesProspectRepository.findById(id);
          if (!prospect && useOwnerId) {
            const contactFormId = extractContactFormId(id);
            if (contactFormId) {
              prospect = await salesProspectRepository.findBySalesRepAndContactFormId(useOwnerId, contactFormId);
            } else {
              prospect = await salesProspectRepository.findBySalesRepAndReferralId(useOwnerId, id);
            }
          }

          if (!prospect) {
            return referral;
          }

          if (allowedOwners && prospect.salesRepId && !allowedOwners.has(String(prospect.salesRepId))) {
            return referral;
          }

          return {
            ...referral,
            status: prospect.status || referral.status,
            notes: prospect.notes ?? referral.notes ?? null,
            salesRepNotes: prospect.notes ?? null,
            isManual: Boolean(prospect.isManual) || String(id).startsWith('manual:'),
            resellerPermitExempt: Boolean(prospect.resellerPermitExempt),
            resellerPermitFilePath: prospect.resellerPermitFilePath || null,
            resellerPermitFileName: prospect.resellerPermitFileName || null,
            resellerPermitUploadedAt: prospect.resellerPermitUploadedAt || null,
          };
        }),
      );

      referrals = merged;
    } catch (error) {
      logger.warn({ err: error }, 'Failed to overlay sales prospect data onto dashboard referrals');
    }

    // Ensure leads can reflect account creation by checking the MySQL users table (email match).
    // We only return a boolean + optional account id; we do not expose user records.
    try {
      const useMysql = mysqlClient.isEnabled();
      const mysqlLookup = useMysql
        ? await fetchMysqlAccountLookup((referrals || []).map((referral) => referral?.referredContactEmail))
        : null;
      const fallbackIndex = !useMysql ? buildAccountIndex() : null;
      referrals = (referrals || []).map((referral) => {
        const existingHasAccount = referral?.referredContactHasAccount === true;
        if (existingHasAccount) return referral;

        const email = normalizeEmail(referral?.referredContactEmail);
        const accountMatch = useMysql
          ? (email ? mysqlLookup?.get(email) : null)
          : (email ? fallbackIndex?.byEmail.get(email) : null);

        if (!accountMatch) {
          // Always normalize to an explicit boolean so the UI doesn't have to guess.
          if (typeof referral?.referredContactHasAccount === 'boolean') return referral;
          return { ...referral, referredContactHasAccount: false };
        }

        return {
          ...referral,
          referredContactHasAccount: true,
          referredContactAccountId: referral?.referredContactAccountId || accountMatch.id || null,
          referredContactAccountEmail: referral?.referredContactAccountEmail || accountMatch.email || null,
        };
      });
    } catch (error) {
      logger.warn({ err: error }, 'Failed to enrich dashboard referrals with account detection');
    }

    // House/contact-form leads are not doctor referrals and must never be credit-eligible.
    referrals = (referrals || []).map((referral) => {
      if (!isHouseContactReferral(referral)) {
        return referral;
      }
      return {
        ...referral,
        referredContactEligibleForCredit: false,
        creditIssuedAt: null,
        creditIssuedAmount: null,
        creditIssuedBy: null,
        referrerDoctorId: null,
      };
    });

    res.json({
      referrals,
      codes,
      users: usersWithOrders,
      statuses: REFERRAL_STATUSES,
    });
  } catch (error) {
    next(error);
  }
};

const getSalesRepById = async (req, res, next) => {
  try {
    ensureSalesLeadOrAdmin(req.user, 'getSalesRepById');
    const salesRepId = String(req.params?.salesRepId || '').trim();
    if (!salesRepId) {
      return res.status(400).json({ error: 'salesRepId is required' });
    }

    let rep = null;
    if (mysqlClient.isEnabled()) {
      try {
        rep = await mysqlClient.fetchOne(
          `
            SELECT id, name, email, sales_code AS salesCode, initials
            FROM sales_reps
            WHERE id = :salesRepId
            LIMIT 1
          `,
          { salesRepId },
        );
      } catch (error) {
        logger.warn({ err: error, salesRepId }, 'Failed to query MySQL sales_reps table');
      }

      if (!rep) {
        try {
          rep = await mysqlClient.fetchOne(
            `
              SELECT id, name, email, sales_code AS salesCode, initials
              FROM sales_rep
              WHERE id = :salesRepId
              LIMIT 1
            `,
            { salesRepId },
          );
        } catch (error) {
          // Optional compatibility: some deployments may have a singular table name.
          logger.debug({ err: error, salesRepId }, 'MySQL sales_rep table lookup skipped');
        }
      }
    }

    if (!rep) {
      rep = salesRepRepository.findById(salesRepId);
    }

    if (!rep) {
      return res.status(404).json({ error: 'Sales rep not found' });
    }

    const users = userRepository.getAll();
    const normalizedRepId = String(rep.id || rep.salesRepId || salesRepId);
    const byRepId =
      users.find(
        (candidate) =>
          String(candidate?.salesRepId || '') === normalizedRepId ||
          String(candidate?.sales_rep_id || '') === normalizedRepId,
      ) || null;

    const legacyUserId = rep?.legacyUserId != null ? String(rep.legacyUserId).trim() : '';
    const byLegacy = legacyUserId ? userRepository.findById(legacyUserId) : null;
    const byEmail = rep?.email ? userRepository.findByEmail(rep.email) : null;
    const resolvedUserId = (byRepId?.id || byLegacy?.id || byEmail?.id || null);

    return res.status(200).json({
      salesRep: {
        id: normalizedRepId,
        name: rep?.name || null,
        email: rep?.email || null,
        role: rep?.role || null,
        userId: resolvedUserId,
      },
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
      const status = normalizeReferralStatus(req.body.status);
      if (!status || !REFERRAL_STATUSES.includes(status)) {
        logger.warn(
          {
            referralId,
            receivedStatus: req.body.status,
            normalizedStatus: status,
            allowedStatuses: REFERRAL_STATUSES,
            userId: req.user?.id || null,
          },
          'Unsupported referral status update request',
        );
        const error = new Error('Unsupported referral status');
        error.status = 400;
        throw error;
      }
      updates.status = status;
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
    const owner = referral?.salesRepId ? String(referral.salesRepId) : null;
    const ownerIds = normalizeOwnerIds(req.user);
    const ownedByUser = Boolean(owner && ownerIds.includes(owner));

    // If the record is missing locally (e.g., contact form or remote source), create it on the fly
    if (!referral) {
      const now = new Date().toISOString();
      const referrerDoctorId = req.body?.referrerDoctorId ? String(req.body.referrerDoctorId) : null;
      const referrerDoctor = referrerDoctorId ? userRepository.findById(referrerDoctorId) : null;
      const referrerSalesRepId = referrerDoctor?.salesRepId ? String(referrerDoctor.salesRepId) : null;
      const fallbackOwner = isAdmin ? req.user?.salesRepId : (req.user?.salesRepId || req.user?.id);
      const seededSalesRepId = referrerSalesRepId || (fallbackOwner ? String(fallbackOwner) : null);
      const seeded = referralRepository.insert({
        id: referralId,
        salesRepId: seededSalesRepId,
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
        'Referral update denied for non-owner',
      );
      const error = new Error('Referral not found for sales representative');
      error.status = 404;
      throw error;
    }

    const updated = referralRepository.update(referralId, updates);
    const contactFormId = extractContactFormId(referralId);
    const isManual = String(referralId).startsWith('manual:');
    salesProspectRepository
      .findById(referralId)
      .catch(() => null)
      .then((existingProspect) => {
        const resolvedOwnerId = updated?.salesRepId
          ? String(updated.salesRepId)
          : (owner || (existingProspect?.salesRepId ? String(existingProspect.salesRepId) : null));
        if (!resolvedOwnerId) {
          logger.warn({ referralId }, 'Skipping sales prospect sync for referral with no sales rep owner');
          return null;
        }
        return salesProspectRepository.upsert({
          id: String(referralId),
          salesRepId: resolvedOwnerId,
          referralId: contactFormId ? null : (isManual ? null : String(referralId)),
          contactFormId: contactFormId ? String(contactFormId) : null,
          status: updates.status || updated?.status || existingProspect?.status || 'pending',
          notes: Object.prototype.hasOwnProperty.call(updates, 'notes')
            ? updates.notes
            : (existingProspect?.notes ?? null),
          isManual,
          contactName: updated?.referredContactName || req.body?.referredContactName || existingProspect?.contactName || null,
          contactEmail: updated?.referredContactEmail || req.body?.referredContactEmail || existingProspect?.contactEmail || null,
          contactPhone: updated?.referredContactPhone || req.body?.referredContactPhone || existingProspect?.contactPhone || null,
        });
      })
      .catch((error) => {
        logger.warn({ err: error, referralId }, 'Failed to sync sales prospect on referral update');
      })
      .finally(() => {
        res.json({
          referral: updated,
          statuses: REFERRAL_STATUSES,
        });
      });
  } catch (error) {
    next(error);
  }
};

const createManualProspect = async (req, res, next) => {
  try {
    ensureSalesRep(req.user, 'createManualProspect');
    const payload = req.body || {};
    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    if (!name) {
      const error = new Error('Name is required');
      error.status = 400;
      throw error;
    }
    const status = normalizeReferralStatus(payload.status) || 'pending';
    if (!REFERRAL_STATUSES.includes(status) || status === 'contact_form') {
      logger.warn(
        {
          receivedStatus: payload.status,
          normalizedStatus: status,
          allowedStatuses: REFERRAL_STATUSES,
          userId: req.user?.id || null,
        },
        'Unsupported manual prospect status',
      );
      const error = new Error('Unsupported referral status');
      error.status = 400;
      throw error;
    }

    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : null;
    const phone = typeof payload.phone === 'string' ? payload.phone.trim() : null;
    const notesRaw = typeof payload.notes === 'string' ? payload.notes : null;
    const notes = notesRaw && notesRaw.trim().length > 0
      ? notesRaw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      : null;
    const hasAccount = payload.hasAccount === true;
    const salesRepId = req.user.salesRepId || req.user.id;
    const now = new Date().toISOString();

    if (email) {
      const normalizeEmail = (value) => (value ? String(value).trim().toLowerCase() : '');
      const emailTakenInReferrals = () => {
        try {
          const referrals = referralRepository.getAll();
          return Array.isArray(referrals)
            && referrals.some((r) => normalizeEmail(r?.referredContactEmail) === email);
        } catch {
          return false;
        }
      };
      const emailTakenInSalesProspects = async () => {
        try {
          const prospects = await salesProspectRepository.getAll();
          return Array.isArray(prospects)
            && prospects.some((p) => normalizeEmail(p?.contactEmail) === email);
        } catch {
          return false;
        }
      };
      const emailTakenInContactForms = async () => {
        if (!mysqlClient.isEnabled()) {
          return false;
        }
        try {
          const row = await mysqlClient.fetchOne(
            'SELECT id FROM contact_forms WHERE LOWER(email) = :email LIMIT 1',
            { email },
          );
          return Boolean(row);
        } catch {
          return false;
        }
      };

      const taken =
        Boolean(adminRepository.findByEmail(email))
        || Boolean(salesRepRepository.findByEmail(email))
        || Boolean(userRepository.findByEmail(email))
        || emailTakenInReferrals()
        || (await emailTakenInSalesProspects())
        || (await emailTakenInContactForms());

      if (taken) {
        const error = new Error('Email already exists in the system');
        error.status = 400;
        throw error;
      }
    }

    const record = referralRepository.insert({
      id: `manual:${crypto.randomUUID()}`,
      referrerDoctorId: null,
      salesRepId,
      referredContactName: name,
      referredContactEmail: email || null,
      referredContactPhone: phone || null,
      status,
      notes: notes || null,
      createdAt: now,
      updatedAt: now,
      referredContactHasAccount: hasAccount,
      referredContactEligibleForCredit: false,
      source: 'manual',
    });

    salesProspectRepository
      .upsert({
        id: String(record.id),
        salesRepId: String(salesRepId),
        status,
        notes: notes || null,
        isManual: true,
        contactName: name,
        contactEmail: email || null,
        contactPhone: phone || null,
      })
      .catch((error) => {
        logger.warn({ err: error, manualId: record.id }, 'Failed to persist manual sales prospect');
      })
      .finally(() => {
        res.status(201).json({ referral: { ...record, isManual: true }, statuses: REFERRAL_STATUSES });
      });
  } catch (error) {
    next(error);
  }
};

const deleteManualProspect = (req, res, next) => {
  try {
    ensureSalesRep(req.user, 'deleteManualProspect');
    const { referralId } = req.params;
    const referral = referralRepository.findById(referralId);
    if (!referral) {
      return res.json({ status: 'deleted' });
    }
    if (!String(referral.id || '').startsWith('manual:')) {
      const error = new Error('Not a manual prospect');
      error.status = 400;
      throw error;
    }

    const isAdmin = normalizeRole(req.user?.role) === 'admin';
    if (!isAdmin) {
      const owner = referral.salesRepId ? String(referral.salesRepId) : null;
      const allowedOwners = [req.user.id, req.user.salesRepId].filter(Boolean).map(String);
      if (owner && !allowedOwners.includes(owner)) {
        const error = new Error('Referral not found');
        error.status = 404;
        throw error;
      }
    }

    referralRepository.remove(referralId);
    salesProspectRepository.remove(referralId).catch(() => null).finally(() => {
      res.json({ status: 'deleted' });
    });
  } catch (error) {
    next(error);
  }
};

const getSalesProspect = async (req, res, next) => {
  try {
    ensureSalesRep(req.user, 'getSalesProspect');
    const identifier = String(req.params.identifier || '').trim();
    if (!identifier) {
      const error = new Error('Identifier is required');
      error.status = 400;
      throw error;
    }

    const role = normalizeRole(req.user.role);
    const isAdmin = role === 'admin';
    const ownerIds = normalizeOwnerIds(req.user);
    const requestedSalesRepId = req.query.salesRepId || req.user.salesRepId || req.user.id;
    const scopeAll = isAdmin && (req.query.scope || '').toLowerCase() === 'all';
    const salesRepId = scopeAll ? null : String(requestedSalesRepId);

    let prospect = await salesProspectRepository.findById(identifier);
    if (!prospect && salesRepId) {
      const contactFormId = extractContactFormId(identifier);
      prospect = contactFormId
        ? await salesProspectRepository.findBySalesRepAndContactFormId(salesRepId, contactFormId)
        : await salesProspectRepository.findByDoctorId(identifier)
          || await salesProspectRepository.findBySalesRepAndDoctorId(salesRepId, identifier)
          || await salesProspectRepository.findBySalesRepAndReferralId(salesRepId, identifier);
    }

    if (prospect && !scopeAll && !isAdmin) {
      const owner = prospect.salesRepId ? String(prospect.salesRepId) : null;
      if (owner && !ownerIds.includes(owner)) {
        const error = new Error('Prospect not found');
        error.status = 404;
        throw error;
      }
    }

    res.json({ prospect: prospect || null });
  } catch (error) {
    next(error);
  }
};

const upsertSalesProspect = async (req, res, next) => {
  try {
    ensureSalesRep(req.user, 'upsertSalesProspect');
    const identifier = String(req.params.identifier || '').trim();
    if (!identifier) {
      const error = new Error('Identifier is required');
      error.status = 400;
      throw error;
    }

    const payload = req.body || {};
    const updates = {};
    if (Object.prototype.hasOwnProperty.call(payload, 'notes')) {
      updates.notes = payload.notes == null ? null : String(payload.notes);
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'resellerPermitExempt')) {
      updates.resellerPermitExempt = Boolean(payload.resellerPermitExempt);
    }
    if (payload.status) {
      const status = normalizeReferralStatus(payload.status);
      if (!status || !REFERRAL_STATUSES.includes(status)) {
        const error = new Error('Unsupported referral status');
        error.status = 400;
        throw error;
      }
      updates.status = status;
    }

    const role = normalizeRole(req.user.role);
    const isAdmin = role === 'admin';
    const ownerIds = normalizeOwnerIds(req.user);
    const requestedSalesRepId = req.query.salesRepId || req.user.salesRepId || req.user.id;
    const scopeAll = isAdmin && (req.query.scope || '').toLowerCase() === 'all';
    const salesRepId = scopeAll ? null : String(requestedSalesRepId);

    let existing = await salesProspectRepository.findById(identifier);
    if (!existing && salesRepId) {
      const contactFormId = extractContactFormId(identifier);
      existing = contactFormId
        ? await salesProspectRepository.findBySalesRepAndContactFormId(salesRepId, contactFormId)
        : await salesProspectRepository.findByDoctorId(identifier)
          || await salesProspectRepository.findBySalesRepAndDoctorId(salesRepId, identifier)
          || await salesProspectRepository.findBySalesRepAndReferralId(salesRepId, identifier);
    }

    if (existing && !scopeAll && !isAdmin) {
      const owner = existing.salesRepId ? String(existing.salesRepId) : null;
      if (owner && !ownerIds.includes(owner)) {
        const error = new Error('Prospect not found');
        error.status = 404;
        throw error;
      }
    }

    const contactFormId = extractContactFormId(identifier);
    const isManual = identifier.startsWith('manual:');
    const owner = existing?.salesRepId || salesRepId || req.user.salesRepId || req.user.id;

    let base = existing;
    if (!base) {
      if (contactFormId) {
        base = {
          id: identifier,
          salesRepId: String(owner),
          contactFormId: String(contactFormId),
          status: 'contact_form',
          isManual: false,
        };
      } else if (isManual) {
        base = {
          id: identifier,
          salesRepId: String(owner),
          status: 'pending',
          isManual: true,
        };
      } else {
        const maybeDoctor = userRepository.findById(identifier);
        const maybeDoctorRole = normalizeRole(maybeDoctor?.role);
        if (maybeDoctor && (maybeDoctorRole === 'doctor' || maybeDoctorRole === 'test_doctor')) {
          const doctorName = typeof maybeDoctor.name === 'string' ? maybeDoctor.name.trim() : null;
          const doctorEmail = typeof maybeDoctor.email === 'string' ? maybeDoctor.email.trim().toLowerCase() : null;
          const doctorPhone = typeof maybeDoctor.phone === 'string'
            ? maybeDoctor.phone.trim()
            : (typeof maybeDoctor.phoneNumber === 'string' ? maybeDoctor.phoneNumber.trim() : null);
          base = {
            id: `doctor:${identifier}`,
            salesRepId: String(owner),
            doctorId: String(identifier),
            status: 'converted',
            isManual: true,
            contactName: doctorName || null,
            contactEmail: doctorEmail || null,
            contactPhone: doctorPhone || null,
          };
        } else {
          base = {
            id: identifier,
            salesRepId: String(owner),
            referralId: identifier,
            status: 'pending',
            isManual: false,
          };
        }
      }
    }

    const saved = await salesProspectRepository.upsert({
      ...base,
      ...updates,
    });
    res.json({ prospect: saved });
  } catch (error) {
    next(error);
  }
};

const uploadResellerPermit = async (req, res, next) => {
  try {
    ensureSalesRep(req.user, 'uploadResellerPermit');
    const identifier = String(req.params.identifier || '').trim();
    if (!identifier) {
      const error = new Error('Identifier is required');
      error.status = 400;
      throw error;
    }

    const role = normalizeRole(req.user.role);
    const isAdmin = role === 'admin';
    const ownerIds = normalizeOwnerIds(req.user);
    const requestedSalesRepId = req.query.salesRepId || req.user.salesRepId || req.user.id;
    const scopeAll = isAdmin && (req.query.scope || '').toLowerCase() === 'all';
    const salesRepId = scopeAll ? null : String(requestedSalesRepId);

    let existing = await salesProspectRepository.findById(identifier);
    if (!existing && salesRepId) {
      const contactFormId = extractContactFormId(identifier);
      existing = contactFormId
        ? await salesProspectRepository.findBySalesRepAndContactFormId(salesRepId, contactFormId)
        : await salesProspectRepository.findByDoctorId(identifier)
          || await salesProspectRepository.findBySalesRepAndDoctorId(salesRepId, identifier)
          || await salesProspectRepository.findBySalesRepAndReferralId(salesRepId, identifier);
    }

    if (existing && !scopeAll && !isAdmin) {
      const owner = existing.salesRepId ? String(existing.salesRepId) : null;
      if (owner && !ownerIds.includes(owner)) {
        const error = new Error('Prospect not found');
        error.status = 404;
        throw error;
      }
    }

    const parsed = await parseMultipartSingleFile(req, {
      fieldName: 'file',
      maxBytes: 25 * 1024 * 1024,
    });
    const ext = path.extname(String(parsed.filename || '')).toLowerCase();
    const allowedExt = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.heic', '.gif']);
    if (!allowedExt.has(ext)) {
      const error = new Error('Invalid file type');
      error.status = 400;
      throw error;
    }

    const safeOriginal = path
      .basename(String(parsed.filename || 'reseller_permit'))
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .slice(0, 160);
    const storedName = `reseller_permit_${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext || ''}`;
    const uploadDir = path.join(env.dataDir, 'uploads', 'reseller-permits');
    fs.mkdirSync(uploadDir, { recursive: true });
    const storedPath = path.join(uploadDir, storedName);
    await fs.promises.writeFile(storedPath, parsed.buffer);

    const contactFormId = extractContactFormId(identifier);
    const isManual = identifier.startsWith('manual:');
    const owner = existing?.salesRepId || salesRepId || req.user.salesRepId || req.user.id;

    let base = existing;
    if (!base) {
      if (contactFormId) {
        base = {
          id: identifier,
          salesRepId: String(owner),
          contactFormId: String(contactFormId),
          status: 'contact_form',
          isManual: false,
        };
      } else if (isManual) {
        base = {
          id: identifier,
          salesRepId: String(owner),
          status: 'pending',
          isManual: true,
        };
      } else {
        base = {
          id: identifier,
          salesRepId: String(owner),
          referralId: identifier,
          status: 'pending',
          isManual: false,
        };
      }
    }

    const saved = await salesProspectRepository.upsert({
      ...base,
      resellerPermitFilePath: path.posix.join('uploads', 'reseller-permits', storedName),
      resellerPermitFileName: safeOriginal,
      resellerPermitUploadedAt: new Date().toISOString(),
    });

    res.json({ prospect: saved });
  } catch (error) {
    next(error);
  }
};

const downloadResellerPermit = async (req, res, next) => {
  try {
    ensureSalesRep(req.user, 'downloadResellerPermit');
    const identifier = String(req.params.identifier || '').trim();
    if (!identifier) {
      const error = new Error('Identifier is required');
      error.status = 400;
      throw error;
    }

    const role = normalizeRole(req.user.role);
    const isAdmin = role === 'admin';
    const ownerIds = normalizeOwnerIds(req.user);
    const requestedSalesRepId = req.query.salesRepId || req.user.salesRepId || req.user.id;
    const scopeAll = isAdmin && (req.query.scope || '').toLowerCase() === 'all';
    const salesRepId = scopeAll ? null : String(requestedSalesRepId);

    let existing = await salesProspectRepository.findById(identifier);
    if (!existing && salesRepId) {
      const contactFormId = extractContactFormId(identifier);
      existing = contactFormId
        ? await salesProspectRepository.findBySalesRepAndContactFormId(salesRepId, contactFormId)
        : await salesProspectRepository.findByDoctorId(identifier)
          || await salesProspectRepository.findBySalesRepAndDoctorId(salesRepId, identifier)
          || await salesProspectRepository.findBySalesRepAndReferralId(salesRepId, identifier);
    }

    if (existing && !scopeAll && !isAdmin) {
      const owner = existing.salesRepId ? String(existing.salesRepId) : null;
      if (owner && !ownerIds.includes(owner)) {
        const error = new Error('Prospect not found');
        error.status = 404;
        throw error;
      }
    }

    const relativePath = existing?.resellerPermitFilePath
      ? String(existing.resellerPermitFilePath)
      : '';
    if (!existing || !relativePath) {
      const error = new Error('Permit not found');
      error.status = 404;
      throw error;
    }

    const allowedRoot = path.resolve(env.dataDir, 'uploads', 'reseller-permits');
    const candidate = path.resolve(env.dataDir, relativePath.replace(/^[/\\\\]+/, ''));
    if (!(candidate === allowedRoot || candidate.startsWith(`${allowedRoot}${path.sep}`))) {
      const error = new Error('Permit not found');
      error.status = 404;
      throw error;
    }
    if (!fs.existsSync(candidate)) {
      const error = new Error('Permit not found');
      error.status = 404;
      throw error;
    }

    const ext = path.extname(candidate).toLowerCase();
    const contentType = (() => {
      switch (ext) {
        case '.pdf':
          return 'application/pdf';
        case '.png':
          return 'image/png';
        case '.jpg':
        case '.jpeg':
          return 'image/jpeg';
        case '.webp':
          return 'image/webp';
        case '.gif':
          return 'image/gif';
        case '.heic':
          return 'image/heic';
        default:
          return 'application/octet-stream';
      }
    })();

    const safeNameBase = existing?.resellerPermitFileName
      ? String(existing.resellerPermitFileName)
      : path.basename(candidate);
    const safeName = path
      .basename(safeNameBase)
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .slice(0, 160) || 'reseller_permit';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.sendFile(candidate);
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
  getSalesRepById,
  createReferralCode,
  createManualProspect,
  deleteManualProspect,
  getSalesProspect,
  upsertSalesProspect,
  uploadResellerPermit,
  downloadResellerPermit,
  updateReferralCodeStatus,
  listReferralCodes,
  updateReferral,
  REFERRAL_STATUSES,
};

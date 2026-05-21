const crypto = require('crypto');
const mysqlClient = require('../database/mysqlClient');

const ACTIVE_LINK_SQL = '(expires_at IS NULL OR expires_at > UTC_TIMESTAMP())';
const SUPPORTED_LINK_TYPES = new Set(['delegate', 'brochure']);

const isEnabled = () => mysqlClient.isEnabled();

const normalizeOptionalString = (value, maxLength = 190) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
};

const normalizeLinkType = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return SUPPORTED_LINK_TYPES.has(normalized) ? normalized : 'delegate';
};

const capabilitiesForLinkType = (value) => {
  const linkType = normalizeLinkType(value);
  if (linkType === 'brochure') {
    return {
      canViewProducts: true,
      canViewPricing: false,
      canAddToCart: false,
      canCheckout: false,
      canSubmitProposal: false,
      canViewCOA: true,
      canViewInventory: false,
    };
  }
  return {
    canViewProducts: true,
    canViewPricing: true,
    canAddToCart: true,
    canCheckout: false,
    canSubmitProposal: true,
    canViewCOA: true,
    canViewInventory: true,
  };
};

const normalizeOptionalInt = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1, Math.min(10_000, Math.floor(parsed)));
};

const normalizeCount = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
};

const normalizeMarkupPercent = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(500, Math.round((parsed + Number.EPSILON) * 100) / 100));
};

const hashToken = (token) =>
  crypto.createHash('sha256').update(String(token || '').trim()).digest('hex');

const toMysqlDateTime = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
};

const toIsoDateTime = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
};

const normalizeAllowedProducts = (value) => {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.replace(/\n/g, ',').split(',')
      : [];
  const seen = new Set();
  const normalized = [];
  for (const entry of source) {
    const token = String(entry || '').trim().toUpperCase();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    normalized.push(token);
  }
  return normalized;
};

const linkSnapshotParams = (link, doctorId) => {
  const token = normalizeOptionalString(link?.token, 128);
  if (!token) return null;
  const subjectLabel = normalizeOptionalString(link?.subjectLabel ?? link?.patientId ?? link?.patient_id);
  const studyLabel = normalizeOptionalString(link?.studyLabel ?? link?.study_label);
  const patientReference = normalizeOptionalString(
    link?.patientReference ?? link?.patient_reference ?? link?.referenceLabel ?? link?.reference_label,
  );
  const allowedProducts = normalizeAllowedProducts(link?.allowedProducts ?? link?.allowed_products);
  const linkType = normalizeLinkType(link?.linkType ?? link?.link_type);
  const brochureName = linkType === 'brochure'
    ? normalizeOptionalString(link?.brochureName ?? link?.brochure_name)
    : null;
  const trackingName = linkType === 'brochure'
    ? (link?.recipientName ?? link?.recipient_name ?? link?.delegateName ?? link?.delegate_name)
    : (link?.delegateName ?? link?.delegate_name);
  const trackingContact = linkType === 'brochure'
    ? (link?.recipientContact ?? link?.recipient_contact ?? link?.delegateContact ?? link?.delegate_contact)
    : (link?.delegateContact ?? link?.delegate_contact);

  return {
    token: hashToken(token),
    token_hint: token.split('-')[0] || token.slice(0, 8),
    link_type: linkType,
    doctor_id: String(doctorId || link?.doctorId || link?.doctor_id || '').trim(),
    created_by_user_id: normalizeOptionalString(link?.createdByUserId ?? link?.created_by_user_id, 32) || String(doctorId || link?.doctorId || link?.doctor_id || '').trim(),
    patient_id: subjectLabel,
    reference_label: patientReference || studyLabel,
    subject_label: subjectLabel,
    study_label: studyLabel,
    patient_reference: patientReference,
    brochure_name: brochureName,
    delegate_name: normalizeOptionalString(trackingName),
    delegate_contact: normalizeOptionalString(trackingContact),
    delegate_role: linkType === 'brochure' ? null : normalizeOptionalString(link?.delegateRole ?? link?.delegate_role, 64),
    product_scope: normalizeOptionalString(link?.productScope ?? link?.product_scope, 64) || 'all_physician_approved',
    product_scope_items_json: JSON.stringify(normalizeAllowedProducts(link?.productScopeItems ?? link?.product_scope_items)),
    delegate_permission: linkType === 'brochure' ? 'view_products_only' : (normalizeOptionalString(link?.delegatePermission ?? link?.delegate_permission, 64) || 'submit_for_physician_review'),
    created_at: toMysqlDateTime(link?.createdAt ?? link?.created_at) || toMysqlDateTime(new Date()),
    expires_at: toMysqlDateTime(link?.expiresAt ?? link?.expires_at),
    markup_percent: linkType === 'brochure' ? 0 : normalizeMarkupPercent(link?.markupPercent ?? link?.markup_percent),
    pricing_disclosure: linkType === 'brochure' ? null : normalizeOptionalString(link?.pricingDisclosure ?? link?.pricing_disclosure, 1000),
    zelle_recipient_name: linkType === 'brochure' ? null : normalizeOptionalString(link?.zelleRecipientName ?? link?.zelle_recipient_name),
    payment_confirmation_required: linkType === 'brochure' ? 0 : ((link?.paymentConfirmationRequired ?? link?.payment_confirmation_required) === false ? 0 : 1),
    delegate_instructions: linkType === 'brochure' ? null : normalizeOptionalString(link?.delegateInstructions ?? link?.delegate_instructions, 4000),
    internal_physician_note: normalizeOptionalString(link?.internalPhysicianNote ?? link?.internal_physician_note, 4000),
    terms_version: normalizeOptionalString(link?.termsVersion ?? link?.terms_version, 64),
    shipping_policy_version: normalizeOptionalString(link?.shippingPolicyVersion ?? link?.shipping_policy_version, 64),
    privacy_policy_version: normalizeOptionalString(link?.privacyPolicyVersion ?? link?.privacy_policy_version, 64),
    instructions: linkType === 'brochure' ? null : normalizeOptionalString(link?.instructions, 4000),
    allowed_products_json: JSON.stringify(allowedProducts),
    usage_limit: normalizeOptionalInt(link?.usageLimit ?? link?.usage_limit),
    status: normalizeOptionalString(link?.status, 32) || 'active',
    payment_method: linkType === 'brochure' ? null : normalizeOptionalString(link?.paymentMethod ?? link?.payment_method, 32),
    payment_instructions: normalizeOptionalString(
      linkType === 'brochure' ? null : (link?.paymentInstructions ?? link?.payment_instructions),
      4000,
    ),
    physician_certified: link?.physicianCertified || link?.physician_certified ? 1 : 0,
  };
};

const createLinkSnapshot = async (link, doctorId) => {
  if (!isEnabled()) return false;
  const params = linkSnapshotParams(link, doctorId);
  if (!params?.token || !params.doctor_id) return false;

  const result = await mysqlClient.execute(
    `
      INSERT INTO patient_links (
        token,
        token_version,
        token_hint,
        link_type,
        doctor_id,
        created_by_user_id,
        patient_id,
        reference_label,
        subject_label,
        study_label,
        patient_reference,
        brochure_name,
        delegate_name,
        delegate_contact,
        delegate_role,
        product_scope,
        product_scope_items_json,
        delegate_permission,
        created_at,
        expires_at,
        markup_percent,
        pricing_disclosure,
        zelle_recipient_name,
        payment_confirmation_required,
        delegate_instructions,
        internal_physician_note,
        terms_version,
        shipping_policy_version,
        privacy_policy_version,
        instructions,
        allowed_products_json,
        usage_limit,
        usage_count,
        open_count,
        status,
        payment_method,
        payment_instructions,
        physician_certified
      ) VALUES (
        :token,
        2,
        :token_hint,
        :link_type,
        :doctor_id,
        :created_by_user_id,
        :patient_id,
        :reference_label,
        :subject_label,
        :study_label,
        :patient_reference,
        :brochure_name,
        :delegate_name,
        :delegate_contact,
        :delegate_role,
        :product_scope,
        :product_scope_items_json,
        :delegate_permission,
        :created_at,
        :expires_at,
        :markup_percent,
        :pricing_disclosure,
        :zelle_recipient_name,
        :payment_confirmation_required,
        :delegate_instructions,
        :internal_physician_note,
        :terms_version,
        :shipping_policy_version,
        :privacy_policy_version,
        :instructions,
        :allowed_products_json,
        :usage_limit,
        0,
        0,
        :status,
        :payment_method,
        :payment_instructions,
        :physician_certified
      )
      ON DUPLICATE KEY UPDATE
        usage_limit = VALUES(usage_limit),
        markup_percent = VALUES(markup_percent),
        link_type = VALUES(link_type),
        created_by_user_id = VALUES(created_by_user_id),
        brochure_name = VALUES(brochure_name),
        delegate_name = VALUES(delegate_name),
        delegate_contact = VALUES(delegate_contact),
        delegate_role = VALUES(delegate_role),
        product_scope = VALUES(product_scope),
        product_scope_items_json = VALUES(product_scope_items_json),
        delegate_permission = VALUES(delegate_permission),
        pricing_disclosure = VALUES(pricing_disclosure),
        zelle_recipient_name = VALUES(zelle_recipient_name),
        payment_confirmation_required = VALUES(payment_confirmation_required),
        delegate_instructions = VALUES(delegate_instructions),
        internal_physician_note = VALUES(internal_physician_note),
        terms_version = VALUES(terms_version),
        shipping_policy_version = VALUES(shipping_policy_version),
        privacy_policy_version = VALUES(privacy_policy_version),
        payment_method = VALUES(payment_method),
        payment_instructions = VALUES(payment_instructions)
    `,
    params,
  );
  return Boolean(result);
};

const buildTokenLookup = (tokens) => {
  const normalizedTokens = Array.from(new Set(
    (tokens || [])
      .map((token) => String(token || '').trim())
      .filter(Boolean),
  ));
  const params = {};
  const placeholders = [];
  const tokenByLookup = new Map();

  normalizedTokens.forEach((token) => {
    [token, hashToken(token)].forEach((lookupToken) => {
      if (!lookupToken || tokenByLookup.has(lookupToken)) return;
      const key = `token${placeholders.length}`;
      params[key] = lookupToken;
      placeholders.push(`:${key}`);
      tokenByLookup.set(lookupToken, token);
    });
  });

  return { normalizedTokens, params, placeholders, tokenByLookup };
};

const fetchMetricsByTokens = async (tokens) => {
  const empty = new Map();
  if (!isEnabled()) return empty;
  const { params, placeholders, tokenByLookup } = buildTokenLookup(tokens);
  if (placeholders.length === 0) return empty;

  const rows = await mysqlClient.fetchAll(
    `
      SELECT
        token,
        usage_limit,
        usage_count,
        open_count,
        view_count,
        last_used_at,
        last_opened_at,
        first_viewed_at,
        last_viewed_at
      FROM patient_links
      WHERE token IN (${placeholders.join(', ')})
    `,
    params,
  );

  const metrics = new Map();
  for (const row of rows || []) {
    const ownerToken = tokenByLookup.get(String(row?.token || '').trim());
    if (!ownerToken) continue;
    metrics.set(ownerToken, {
      usageLimit: normalizeOptionalInt(row.usage_limit),
      usageCount: normalizeCount(row.usage_count),
      openCount: normalizeCount(row.open_count),
      viewCount: normalizeCount(row.view_count ?? row.open_count),
      lastUsedAt: toIsoDateTime(row.last_used_at),
      lastOpenedAt: toIsoDateTime(row.last_opened_at),
      firstViewedAt: toIsoDateTime(row.first_viewed_at),
      lastViewedAt: toIsoDateTime(row.last_viewed_at ?? row.last_opened_at),
    });
  }
  return metrics;
};

const parseJsonField = (value, fallback) => {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
};

const mapSqlLink = (row, fallbackToken = null) => {
  if (!row || typeof row !== 'object') return null;
  const linkType = normalizeLinkType(row.link_type);
  const brochureName = normalizeOptionalString(row.brochure_name);
  const delegateName = normalizeOptionalString(row.delegate_name);
  const delegateContact = normalizeOptionalString(row.delegate_contact);
  const patientReference = normalizeOptionalString(row.patient_reference);
  const studyLabel = normalizeOptionalString(row.study_label);
  return {
    token: fallbackToken || String(row.token || '').trim(),
    linkType,
    link_type: linkType,
    capabilities: capabilitiesForLinkType(linkType),
    doctorId: String(row.doctor_id || '').trim(),
    createdByUserId: normalizeOptionalString(row.created_by_user_id, 32),
    patientReference,
    studyLabel,
    brochureName: linkType === 'brochure' ? brochureName : null,
    brochure_name: linkType === 'brochure' ? brochureName : null,
    label: (linkType === 'brochure' ? brochureName : null) || patientReference || studyLabel || null,
    recipientName: linkType === 'brochure' ? delegateName : null,
    recipientContact: linkType === 'brochure' ? delegateContact : null,
    delegateName: linkType === 'brochure' ? null : delegateName,
    delegateContact: linkType === 'brochure' ? null : delegateContact,
    delegateRole: linkType === 'brochure' ? null : normalizeOptionalString(row.delegate_role, 64),
    productScope: normalizeOptionalString(row.product_scope, 64) || 'all_physician_approved',
    productScopeItems: parseJsonField(row.product_scope_items_json, []),
    delegatePermission: linkType === 'brochure' ? 'view_products_only' : (normalizeOptionalString(row.delegate_permission, 64) || 'submit_for_physician_review'),
    allowedProducts: parseJsonField(row.allowed_products_json, []),
    status: normalizeOptionalString(row.status, 32) || 'active',
    revokedAt: toIsoDateTime(row.revoked_at),
    expiresAt: toIsoDateTime(row.expires_at),
    openCount: normalizeCount(row.open_count),
    viewCount: normalizeCount(row.view_count ?? row.open_count),
    firstViewedAt: toIsoDateTime(row.first_viewed_at),
    lastViewedAt: toIsoDateTime(row.last_viewed_at ?? row.last_opened_at),
  };
};

const findByToken = async (token, { includeInactive = false } = {}) => {
  if (!isEnabled()) return null;
  const normalized = String(token || '').trim();
  if (!normalized) return null;
  const row = await mysqlClient.fetchOne(
    `
      SELECT *
      FROM patient_links
      WHERE token = :rawToken OR token = :hashedToken
      LIMIT 1
    `,
    { rawToken: normalized, hashedToken: hashToken(normalized) },
  );
  const mapped = mapSqlLink(row, normalized);
  if (!mapped) return null;
  if (includeInactive) return mapped;
  if (mapped.revokedAt || mapped.status === 'revoked' || mapped.status === 'expired') return null;
  const expiresAtMs = Date.parse(mapped.expiresAt || '');
  if (Number.isFinite(expiresAtMs) && Date.now() >= expiresAtMs) return null;
  return mapped;
};

const touchLastUsed = async (token, { ipHash = null, userAgentHash = null } = {}) => {
  if (!isEnabled()) return null;
  const normalized = String(token || '').trim();
  if (!normalized) return null;
  const updates = [
    'last_used_at = UTC_TIMESTAMP()',
    'last_opened_at = UTC_TIMESTAMP()',
    'open_count = COALESCE(open_count, 0) + 1',
    'view_count = COALESCE(view_count, 0) + 1',
    'first_viewed_at = COALESCE(first_viewed_at, UTC_TIMESTAMP())',
    'last_viewed_at = UTC_TIMESTAMP()',
  ];
  const params = {
    rawToken: normalized,
    hashedToken: hashToken(normalized),
  };
  if (typeof ipHash === 'string' && ipHash.trim()) {
    updates.push('last_ip_hash = :lastIpHash');
    params.lastIpHash = ipHash.trim().slice(0, 64);
  }
  if (typeof userAgentHash === 'string' && userAgentHash.trim()) {
    updates.push('last_user_agent_hash = :lastUserAgentHash');
    params.lastUserAgentHash = userAgentHash.trim().slice(0, 64);
  }
  await mysqlClient.execute(
    `
      UPDATE patient_links
      SET ${updates.join(', ')}
      WHERE (token = :rawToken OR token = :hashedToken)
        AND ${ACTIVE_LINK_SQL}
    `,
    params,
  );
  return (await fetchMetricsByTokens([normalized])).get(normalized) || null;
};

const mergeMetricsIntoLinks = async (links) => {
  if (!Array.isArray(links) || links.length === 0 || !isEnabled()) {
    return links;
  }
  const metricsByToken = await fetchMetricsByTokens(links.map((link) => link?.token));
  if (metricsByToken.size === 0) return links;
  return links.map((link) => {
    const token = String(link?.token || '').trim();
    const metrics = metricsByToken.get(token);
    return metrics ? { ...link, ...metrics } : link;
  });
};

module.exports = {
  createLinkSnapshot,
  capabilitiesForLinkType,
  fetchMetricsByTokens,
  findByToken,
  hashToken,
  isEnabled,
  mergeMetricsIntoLinks,
  normalizeCount,
  normalizeOptionalInt,
  touchLastUsed,
};

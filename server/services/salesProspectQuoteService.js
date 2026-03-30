const salesProspectQuoteRepository = require('../repositories/salesProspectQuoteRepository');
const salesProspectRepository = require('../repositories/salesProspectRepository');
const salesRepRepository = require('../repositories/salesRepRepository');
const userRepository = require('../repositories/userRepository');
const {
  resolveScopedProspectAccess,
  buildProspectBaseRecord,
  normalizeOptionalText,
} = require('./salesProspectAccessService');
const { generateProspectQuotePdf } = require('./salesProspectQuotePdfService');

const QUOTE_STATUS_DRAFT = 'draft';
const QUOTE_STATUS_EXPORTED = 'exported';

const toMoney = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round((numeric + Number.EPSILON) * 100) / 100;
};

const normalizeTitle = (value, fallback = 'Quote') => {
  const normalized = normalizeOptionalText(value);
  return normalized || fallback;
};

const normalizeQuoteItems = (items) => (Array.isArray(items) ? items : [])
  .map((item, index) => {
    const quantity = Math.max(1, Math.floor(Number(item?.quantity) || 1));
    const unitPrice = toMoney(item?.unitPrice);
    const lineTotal = toMoney(item?.lineTotal ?? unitPrice * quantity);
    const productId = normalizeOptionalText(item?.productId);
    const variantId = normalizeOptionalText(item?.variantId);
    const name = normalizeTitle(item?.name, 'Item');
    if (!productId && !name) {
      return null;
    }
    return {
      position: index + 1,
      productId: productId || null,
      variantId: variantId || null,
      sku: normalizeOptionalText(item?.sku),
      imageUrl: normalizeOptionalText(item?.imageUrl) || normalizeOptionalText(item?.image),
      name,
      quantity,
      unitPrice,
      lineTotal,
      note: normalizeOptionalText(item?.note),
    };
  })
  .filter(Boolean);

const sanitizeQuoteSummary = (quote) => {
  if (!quote) return null;
  return {
    id: quote.id,
    prospectId: quote.prospectId,
    salesRepId: quote.salesRepId,
    revisionNumber: quote.revisionNumber,
    status: quote.status,
    title: quote.title,
    currency: quote.currency,
    subtotal: quote.subtotal,
    createdAt: quote.createdAt,
    updatedAt: quote.updatedAt,
    exportedAt: quote.exportedAt || null,
  };
};

const sanitizeQuoteDetail = (quote) => {
  if (!quote) return null;
  return {
    ...sanitizeQuoteSummary(quote),
    quotePayloadJson: quote.quotePayloadJson || null,
  };
};

const resolveSalesRepSnapshot = (prospect, actor) => {
  const prospectSalesRepId = normalizeOptionalText(prospect?.salesRepId);
  const repRecord = prospectSalesRepId
    ? salesRepRepository.findById(prospectSalesRepId)
      || salesRepRepository.findByEmail(prospectSalesRepId)
    : null;
  const linkedUser = prospectSalesRepId
    ? userRepository.findById(prospectSalesRepId)
    : null;
  return {
    id: prospectSalesRepId || normalizeOptionalText(actor?.salesRepId) || normalizeOptionalText(actor?.id),
    name: normalizeOptionalText(repRecord?.name)
      || normalizeOptionalText(linkedUser?.name)
      || normalizeOptionalText(actor?.name)
      || 'PepPro',
    email: normalizeOptionalText(repRecord?.email)
      || normalizeOptionalText(linkedUser?.email)
      || normalizeOptionalText(actor?.email),
  };
};

const ensureProspectRecord = async ({
  identifier,
  user,
  query,
  context,
  prospectSnapshot,
} = {}) => {
  const access = await resolveScopedProspectAccess({
    identifier,
    user,
    query,
    context,
  });
  if (access.prospect) {
    return {
      ...access,
      prospect: access.prospect,
    };
  }

  const ownerSalesRepId = normalizeOptionalText(prospectSnapshot?.salesRepId)
    || normalizeOptionalText(prospectSnapshot?.ownerSalesRepId)
    || normalizeOptionalText(access.salesRepId)
    || normalizeOptionalText(user?.salesRepId)
    || normalizeOptionalText(user?.id);
  const base = buildProspectBaseRecord({
    identifier: access.identifier,
    existing: null,
    ownerSalesRepId,
    prospectSnapshot,
    doctorSourceSystem: 'account',
  });
  const prospect = await salesProspectRepository.upsert(base);
  return {
    ...access,
    prospect,
  };
};

const listQuotesForProspect = async ({
  identifier,
  user,
  query,
} = {}) => {
  const access = await resolveScopedProspectAccess({
    identifier,
    user,
    query,
    context: 'listProspectQuotes',
  });
  if (!access.prospect) {
    return {
      prospect: null,
      currentDraft: null,
      history: [],
    };
  }
  const history = await salesProspectQuoteRepository.listByProspectId(access.prospect.id);
  const currentDraft = history.find((quote) => quote.status === QUOTE_STATUS_DRAFT) || null;
  return {
    prospect: access.prospect,
    currentDraft: sanitizeQuoteDetail(currentDraft),
    history: history.map(sanitizeQuoteSummary),
  };
};

const importCartToProspectQuote = async ({
  identifier,
  user,
  query,
  payload,
} = {}) => {
  const quoteInput = payload && typeof payload === 'object' ? payload : {};
  const items = normalizeQuoteItems(quoteInput.items);
  if (items.length === 0) {
    const error = new Error('Quote items are required');
    error.status = 400;
    throw error;
  }

  const access = await ensureProspectRecord({
    identifier,
    user,
    query,
    context: 'importCartToProspectQuote',
    prospectSnapshot: quoteInput.prospectSnapshot,
  });

  const history = await salesProspectQuoteRepository.listByProspectId(access.prospect.id);
  const activeDraft = history.find((quote) => quote.status === QUOTE_STATUS_DRAFT) || null;
  const maxRevision = history.reduce(
    (max, quote) => Math.max(max, Math.floor(Number(quote?.revisionNumber) || 0)),
    0,
  );
  const revisionNumber = activeDraft
    ? activeDraft.revisionNumber
    : Math.max(1, maxRevision + 1);
  const subtotal = toMoney(
    quoteInput.subtotal != null
      ? quoteInput.subtotal
      : items.reduce((sum, item) => sum + toMoney(item.lineTotal), 0),
  );
  const prospectSnapshot = {
    identifier: access.identifier,
    id: access.prospect.id,
    status: access.prospect.status,
    salesRepId: access.prospect.salesRepId,
    doctorId: access.prospect.doctorId || normalizeOptionalText(quoteInput?.prospectSnapshot?.doctorId),
    referralId: access.prospect.referralId || normalizeOptionalText(quoteInput?.prospectSnapshot?.referralId),
    contactFormId: access.prospect.contactFormId || normalizeOptionalText(quoteInput?.prospectSnapshot?.contactFormId),
    contactName:
      access.prospect.contactName
      || normalizeOptionalText(quoteInput?.prospectSnapshot?.contactName)
      || normalizeOptionalText(quoteInput?.prospectSnapshot?.referredContactName),
    contactEmail:
      access.prospect.contactEmail
      || normalizeOptionalText(quoteInput?.prospectSnapshot?.contactEmail)
      || normalizeOptionalText(quoteInput?.prospectSnapshot?.referredContactEmail),
    contactPhone:
      access.prospect.contactPhone
      || normalizeOptionalText(quoteInput?.prospectSnapshot?.contactPhone)
      || normalizeOptionalText(quoteInput?.prospectSnapshot?.referredContactPhone),
  };

  const quote = await salesProspectQuoteRepository.upsert({
    id: activeDraft?.id || undefined,
    prospectId: access.prospect.id,
    salesRepId: access.prospect.salesRepId || normalizeOptionalText(user?.salesRepId) || normalizeOptionalText(user?.id),
    revisionNumber,
    status: QUOTE_STATUS_DRAFT,
    title: normalizeTitle(quoteInput.title, activeDraft?.title || `Quote R${revisionNumber}`),
    currency: String(quoteInput.currency || 'USD').trim().toUpperCase() || 'USD',
    subtotal,
    exportedAt: null,
    quotePayloadJson: {
      title: normalizeTitle(quoteInput.title, activeDraft?.title || `Quote R${revisionNumber}`),
      notes: normalizeOptionalText(quoteInput.notes),
      pricingMode: String(quoteInput.pricingMode || 'wholesale').trim().toLowerCase() || 'wholesale',
      currency: String(quoteInput.currency || 'USD').trim().toUpperCase() || 'USD',
      subtotal,
      items,
      prospect: prospectSnapshot,
      salesRep: resolveSalesRepSnapshot(access.prospect, user),
    },
  });

  const nextHistory = await salesProspectQuoteRepository.listByProspectId(access.prospect.id);
  return {
    prospect: access.prospect,
    quote: sanitizeQuoteDetail(quote),
    history: nextHistory.map(sanitizeQuoteSummary),
  };
};

const updateProspectQuote = async ({
  identifier,
  quoteId,
  user,
  query,
  payload,
} = {}) => {
  const access = await resolveScopedProspectAccess({
    identifier,
    user,
    query,
    context: 'updateProspectQuote',
  });
  if (!access.prospect) {
    const error = new Error('Prospect not found');
    error.status = 404;
    throw error;
  }
  const existing = await salesProspectQuoteRepository.findById(quoteId);
  if (!existing || existing.prospectId !== access.prospect.id) {
    const error = new Error('Quote not found');
    error.status = 404;
    throw error;
  }
  if (existing.status !== QUOTE_STATUS_DRAFT) {
    const error = new Error('Only draft quotes can be updated');
    error.status = 409;
    throw error;
  }

  const nextPayload = payload && typeof payload === 'object' ? payload : {};
  const updated = await salesProspectQuoteRepository.upsert({
    ...existing,
    title: normalizeTitle(nextPayload.title, existing.title),
    quotePayloadJson: {
      ...(existing.quotePayloadJson || {}),
      title: normalizeTitle(nextPayload.title, existing.title),
      notes: Object.prototype.hasOwnProperty.call(nextPayload, 'notes')
        ? normalizeOptionalText(nextPayload.notes)
        : normalizeOptionalText(existing?.quotePayloadJson?.notes),
    },
  });

  return {
    prospect: access.prospect,
    quote: sanitizeQuoteDetail(updated),
  };
};

const exportProspectQuote = async ({
  identifier,
  quoteId,
  user,
  query,
} = {}) => {
  const access = await resolveScopedProspectAccess({
    identifier,
    user,
    query,
    context: 'exportProspectQuote',
  });
  if (!access.prospect) {
    const error = new Error('Prospect not found');
    error.status = 404;
    throw error;
  }

  const existing = await salesProspectQuoteRepository.findById(quoteId);
  if (!existing || existing.prospectId !== access.prospect.id) {
    const error = new Error('Quote not found');
    error.status = 404;
    throw error;
  }

  let quote = existing;
  if (quote.status === QUOTE_STATUS_DRAFT) {
    quote = await salesProspectQuoteRepository.upsert({
      ...quote,
      status: QUOTE_STATUS_EXPORTED,
      exportedAt: new Date().toISOString(),
    });
  }

  const enrichedQuote = {
    ...quote,
    quotePayloadJson: {
      ...(quote.quotePayloadJson || {}),
      prospect: {
        ...((quote.quotePayloadJson && typeof quote.quotePayloadJson === 'object'
          ? quote.quotePayloadJson.prospect
          : null) || {}),
        identifier:
          normalizeOptionalText(quote?.quotePayloadJson?.prospect?.identifier)
          || normalizeOptionalText(access.identifier)
          || normalizeOptionalText(access.prospect?.id),
        contactName:
          normalizeOptionalText(quote?.quotePayloadJson?.prospect?.contactName)
          || normalizeOptionalText(quote?.quotePayloadJson?.prospect?.name)
          || normalizeOptionalText(access.prospect?.contactName),
        contactEmail:
          normalizeOptionalText(quote?.quotePayloadJson?.prospect?.contactEmail)
          || normalizeOptionalText(access.prospect?.contactEmail),
        contactPhone:
          normalizeOptionalText(quote?.quotePayloadJson?.prospect?.contactPhone)
          || normalizeOptionalText(access.prospect?.contactPhone),
      },
    },
  };

  const rendered = await generateProspectQuotePdf(enrichedQuote);
  return {
    quote: sanitizeQuoteSummary(quote),
    pdf: rendered.pdf,
    filename: rendered.filename,
  };
};

const deleteProspectQuote = async ({
  identifier,
  quoteId,
  user,
  query,
} = {}) => {
  const access = await resolveScopedProspectAccess({
    identifier,
    user,
    query,
    context: 'deleteProspectQuote',
  });
  if (!access.prospect) {
    const error = new Error('Prospect not found');
    error.status = 404;
    throw error;
  }

  const existing = await salesProspectQuoteRepository.findById(quoteId);
  if (!existing || existing.prospectId !== access.prospect.id) {
    const error = new Error('Quote not found');
    error.status = 404;
    throw error;
  }

  await salesProspectQuoteRepository.deleteById(existing.id);
  return {
    deleted: true,
    quoteId: existing.id,
  };
};

module.exports = {
  listQuotesForProspect,
  importCartToProspectQuote,
  updateProspectQuote,
  exportProspectQuote,
  deleteProspectQuote,
};

const salesProspectQuoteService = require('../services/salesProspectQuoteService');

const formatDebugTimingMs = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return null;
  }
  return numeric.toFixed(1);
};

const appendServerTimingMetric = (metrics, name, value) => {
  const formatted = formatDebugTimingMs(value);
  if (!formatted) {
    return;
  }
  metrics.push(`${name};dur=${formatted}`);
};

const attachQuoteExportDebugHeaders = (res, result) => {
  const diagnostics = result && typeof result.diagnostics === 'object'
    ? result.diagnostics
    : null;
  if (!diagnostics) {
    return;
  }

  const pdfDiagnostics = diagnostics.pdf && typeof diagnostics.pdf === 'object'
    ? diagnostics.pdf
    : {};
  const htmlDiagnostics = pdfDiagnostics.html && typeof pdfDiagnostics.html === 'object'
    ? pdfDiagnostics.html
    : {};

  const headerValues = {
    'X-PepPro-Quote-Export-Ms': diagnostics.totalMs,
    'X-PepPro-Quote-Pdf-Ms': diagnostics.pdfMs,
    'X-PepPro-Quote-Render-Ms': pdfDiagnostics.renderMs ?? pdfDiagnostics.totalMs,
    'X-PepPro-Quote-Image-Ms': htmlDiagnostics.imageResolveMs,
  };

  Object.entries(headerValues).forEach(([headerName, headerValue]) => {
    const formatted = formatDebugTimingMs(headerValue);
    if (formatted) {
      res.setHeader(headerName, formatted);
    }
  });

  const renderer = String(pdfDiagnostics.renderer || '').trim();
  if (renderer) {
    res.setHeader('X-PepPro-Quote-Renderer', renderer);
  }

  const cacheLayer = String(pdfDiagnostics.cacheLayer || '').trim();
  if (cacheLayer) {
    res.setHeader('X-PepPro-Quote-Cache', cacheLayer);
  }

  const pdfLength = typeof result?.pdf?.length === 'number' ? result.pdf.length : null;
  if (Number.isFinite(pdfLength) && pdfLength >= 0) {
    res.setHeader('X-PepPro-Quote-Pdf-Bytes', String(pdfLength));
  }

  const serverTiming = [];
  appendServerTimingMetric(serverTiming, 'quote_total', diagnostics.totalMs);
  appendServerTimingMetric(serverTiming, 'quote_access', diagnostics.accessMs);
  appendServerTimingMetric(serverTiming, 'quote_lookup', diagnostics.findQuoteMs);
  appendServerTimingMetric(serverTiming, 'quote_mark', diagnostics.markExportedMs);
  appendServerTimingMetric(serverTiming, 'quote_enrich', diagnostics.enrichMs);
  appendServerTimingMetric(serverTiming, 'quote_pdf', diagnostics.pdfMs);
  appendServerTimingMetric(serverTiming, 'pdf_page', pdfDiagnostics.pageCreateMs);
  appendServerTimingMetric(serverTiming, 'pdf_html', pdfDiagnostics.renderQuoteHtmlMs);
  appendServerTimingMetric(serverTiming, 'pdf_images', htmlDiagnostics.imageResolveMs);
  appendServerTimingMetric(serverTiming, 'pdf_set', pdfDiagnostics.setContentMs);
  appendServerTimingMetric(serverTiming, 'pdf_wait_images', pdfDiagnostics.waitForImagesMs);
  appendServerTimingMetric(serverTiming, 'pdf_print', pdfDiagnostics.pdfMs);
  if (serverTiming.length > 0) {
    res.setHeader('Server-Timing', serverTiming.join(', '));
  }
};

const list = async (req, res, next) => {
  try {
    const result = await salesProspectQuoteService.listQuotesForProspect({
      identifier: req.params.identifier,
      user: req.user,
      query: req.query,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
};

const importCart = async (req, res, next) => {
  try {
    const result = await salesProspectQuoteService.importCartToProspectQuote({
      identifier: req.params.identifier,
      user: req.user,
      query: req.query,
      payload: req.body,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
};

const update = async (req, res, next) => {
  try {
    const result = await salesProspectQuoteService.updateProspectQuote({
      identifier: req.params.identifier,
      quoteId: req.params.quoteId,
      user: req.user,
      query: req.query,
      payload: req.body,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
};

const remove = async (req, res, next) => {
  try {
    const result = await salesProspectQuoteService.deleteProspectQuote({
      identifier: req.params.identifier,
      quoteId: req.params.quoteId,
      user: req.user,
      query: req.query,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
};

const exportPdf = async (req, res, next) => {
  try {
    const result = await salesProspectQuoteService.exportProspectQuote({
      identifier: req.params.identifier,
      quoteId: req.params.quoteId,
      user: req.user,
      query: req.query,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-PepPro-Quote-Id', result.quote?.id || '');
    attachQuoteExportDebugHeaders(res, result);
    res.status(200).send(result.pdf);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  list,
  importCart,
  update,
  remove,
  exportPdf,
};

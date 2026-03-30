const salesProspectQuoteService = require('../services/salesProspectQuoteService');

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

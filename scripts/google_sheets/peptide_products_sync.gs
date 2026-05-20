const TIMEZONE = 'America/Indiana/Indianapolis';
const WEBHOOK_SECRET = 'wqEpTQeBJzrDBZV6Ao5CIU7EQZV5KJUD+kd1gdI1Stw=';

// Peptide product information endpoint on the VPS backend.
const PEPTIDE_PRODUCTS_WEBHOOK_URL = 'https://api.trufusionlabs.com/api/integrations/google-sheets/peptide-products';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Run')
    .addItem('Sync Peptide Products', 'syncPeptideProducts')
    .addToUi();
}

function normalizedHeader_(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function findHeaderIndex_(headers, label, fallbackIndex) {
  const target = normalizedHeader_(label);
  const exactIndex = headers.findIndex((header) => normalizedHeader_(header) === target);
  return exactIndex >= 0 ? exactIndex : fallbackIndex;
}

// Column A = Product Name, Column B = Product SKU, Column C = Product Description,
// Column D = Product Information, Column E = Sync Status
function syncPeptideProducts() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const data = sheet.getDataRange().getDisplayValues();

  const headers = data[0] || [];
  const rows = data.length > 1 ? data.slice(1) : [];
  const stamp = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss');

  const idx = {
    productName: findHeaderIndex_(headers, 'Product Name', 0),
    productSku: findHeaderIndex_(headers, 'Product SKU', 1),
    productDescription: findHeaderIndex_(headers, 'Product Description', 2),
    productInformation: findHeaderIndex_(headers, 'Product Information', 3),
    syncStatus: 4,
  };

  const toStr = (v) => (v == null ? '' : String(v));
  const norm = (s) => toStr(s).trim();
  const keyOf = (sku) => norm(sku).toLowerCase();

  const products = [];
  const rowMap = [];
  const hasAnyData = rows.map((row) => {
    const productName = norm(row[idx.productName]);
    const productSku = norm(row[idx.productSku]);
    const productDescription = norm(row[idx.productDescription]);
    const productInformation = norm(row[idx.productInformation]);
    return productName !== ''
      || productSku !== ''
      || productDescription !== ''
      || productInformation !== '';
  });

  for (let i = 0; i < rows.length; i++) {
    const productName = norm(rows[i][idx.productName]);
    const productSku = norm(rows[i][idx.productSku]);
    const productDescription = norm(rows[i][idx.productDescription]);
    const productInformation = norm(rows[i][idx.productInformation]);

    if (productName === '' && productSku === '') {
      continue;
    }

    products.push({
      sheetRow: i + 2,
      productName,
      productSku,
      productDescription,
      productInformation,
      key: keyOf(productSku),
    });
    rowMap.push(i);
  }

  const statusValues = rows.map(() => ['']);
  const payload = {
    products,
    fullSync: true,
  };

  let statusCode = null;
  let responseBody = '';

  try {
    const resp = UrlFetchApp.fetch(PEPTIDE_PRODUCTS_WEBHOOK_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      headers: {
        Authorization: WEBHOOK_SECRET,
        'X-WebHook-Signature': WEBHOOK_SECRET,
      },
      muteHttpExceptions: true,
    });

    statusCode = resp.getResponseCode();
    responseBody = resp.getContentText();

    Logger.log(`Peptide products sync status: ${statusCode}`);
    Logger.log(`Body: ${responseBody}`);

    let deletedSet = new Set();
    let results = null;
    let responseErrors = [];
    try {
      const json = JSON.parse(responseBody || '{}');
      if (Array.isArray(json.errors)) {
        responseErrors = json.errors.map((error) => String(error || '').trim()).filter(Boolean);
      } else if (json.error) {
        responseErrors = [String(json.error).trim()].filter(Boolean);
      }
      if (Array.isArray(json.deletedSkus)) {
        json.deletedSkus.forEach((sku) => {
          if (sku) deletedSet.add(keyOf(sku));
        });
      }
      if (Array.isArray(json.results)) {
        results = json.results;
        json.results.forEach((result) => {
          const status = String(result.status || result.action || '').toLowerCase();
          const key = keyOf(result.key || result.productSku || result.sku || '');
          if (status === 'deleted' && key) deletedSet.add(key);
        });
      }
    } catch (e) {
      Logger.log(`Response JSON parse skipped/failed (non-fatal): ${e}`);
    }

    if (statusCode >= 200 && statusCode < 300) {
      if (Array.isArray(results) && results.length === rowMap.length) {
        for (let k = 0; k < results.length; k++) {
          const result = results[k] || {};
          const rowIdx = rowMap[k];
          const status = String(result.status || result.action || 'ok').toUpperCase();
          const error = String(result.error || '').trim();
          const sku = norm(rows[rowIdx][idx.productSku]);
          const deletedMark = sku && deletedSet.has(keyOf(sku)) ? '[DELETED] ' : '';
          statusValues[rowIdx][0] = error
            ? `${deletedMark}${status}: ${error} @ ${stamp}`
            : `${deletedMark}${status} @ ${stamp}`;
        }
      } else {
        for (let k = 0; k < rowMap.length; k++) {
          const rowIdx = rowMap[k];
          const sku = norm(rows[rowIdx][idx.productSku]);
          const deletedMark = sku && deletedSet.has(keyOf(sku)) ? '[DELETED] ' : '';
          statusValues[rowIdx][0] = `${deletedMark}Updated @ ${stamp}`;
        }
      }
    } else {
      const genericError = responseErrors.length > 0
        ? responseErrors.slice(0, 2).join('; ')
        : `Failure (${statusCode}), contact petergibbons7@icloud.com`;
      hasAnyData.forEach((isDataRow, i) => {
        if (isDataRow) statusValues[i][0] = genericError;
      });
    }
  } catch (err) {
    Logger.log(`Peptide products sync threw: ${err}`);
    Logger.log(`Last status: ${statusCode === null ? 'none' : statusCode}`);
    Logger.log(`Last body: ${responseBody || '(empty)'}`);

    hasAnyData.forEach((isDataRow, i) => {
      if (isDataRow) statusValues[i][0] = 'Failure, contact petergibbons7@icloud.com';
    });
  }

  if (rows.length > 0) {
    sheet.getRange(2, idx.syncStatus + 1, rows.length, 1).setValues(statusValues);
  }
}

function syncProductInformation() {
  return syncPeptideProducts();
}

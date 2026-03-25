const WEBHOOK_URL = 'https://port.peppro.net/api/integrations/google-sheets/sales-reps.php';
const WEBHOOK_SECRET = 'wqEpTQeBJzrDBZV6Ao5CIU7EQZV5KJUD+kd1gdI1Stw=';
const TIMEZONE = 'America/Indiana/Indianapolis';

function toPartnerFlag_(value) {
  const normalized = value == null ? '' : String(value).trim().toLowerCase();
  return normalized === '1'
    || normalized === 'true'
    || normalized === 'yes'
    || normalized === 'y'
    || normalized === 'on';
}

function syncSalesReps() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Rep List');
  if (!sheet) throw new Error('Sheet "Rep List" not found');
  SpreadsheetApp.flush();
  const data = sheet.getDataRange().getDisplayValues();
  if (data.length <= 1) return;

  const headers = data[0];
  const rows = data.slice(1);
  const hasAnyData = rows.map((row) => row.some((cell) => cell && String(cell).trim() !== ''));

  const idx = {
    first: headers.indexOf('First Name'),
    last: headers.indexOf('Last Name'),
    email: headers.indexOf('Email'),
    phone: headers.indexOf('Phone'),
    territory: headers.indexOf('Territory'),
    initials: headers.indexOf('Initials'),
    salesCode: headers.indexOf('Sales Code'),
    isPartner: headers.indexOf('Is Partner'),
  };

  const reps = [];
  const rowSalesCodes = [];

  for (let r = 0; r < rows.length; r++) {
    if (!hasAnyData[r]) {
      rowSalesCodes[r] = '';
      continue;
    }

    const row = rows[r];
    const toString = (value) => (value == null ? '' : String(value).trim());
    const first = toString(row[idx.first]);
    const last = toString(row[idx.last]);
    const fullName = [first, last].filter(Boolean).join(' ');
    const salesCode = toString(row[idx.salesCode]).toUpperCase();

    reps.push({
      name: fullName,
      email: toString(row[idx.email]),
      phone: toString(row[idx.phone]),
      territory: toString(row[idx.territory]),
      initials: toString(row[idx.initials]),
      salesCode,
      isPartner: toPartnerFlag_(row[idx.isPartner]),
    });

    rowSalesCodes[r] = salesCode;
  }

  const existingSalesCodes = rowSalesCodes
    .filter((sc) => sc && sc.trim() !== '')
    .map((sc) => sc.toUpperCase());

  const payload = {
    salesReps: reps,
    existingSalesCodes,
  };

  const statusValues = rows.map(() => ['']);
  const stamp = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss');

  let statusCode = null;
  let responseBody = '';

  try {
    const response = UrlFetchApp.fetch(WEBHOOK_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      headers: {
        Authorization: WEBHOOK_SECRET,
        'X-WebHook-Signature': WEBHOOK_SECRET,
      },
      muteHttpExceptions: true,
    });

    statusCode = response.getResponseCode();
    responseBody = response.getContentText();

    Logger.log(`Sync status: ${statusCode}`);
    Logger.log(`Body: ${responseBody}`);

    const deletedSet = new Set();
    try {
      const json = JSON.parse(responseBody || '{}');
      if (Array.isArray(json.deletedSalesCodes)) {
        json.deletedSalesCodes.forEach((sc) => {
          if (sc) deletedSet.add(String(sc).toUpperCase());
        });
      }
      if (Array.isArray(json.results)) {
        json.results.forEach((result) => {
          const status = String(result.status || result.action || '').toLowerCase();
          const code = String(result.salesCode || result.code || '').toUpperCase();
          if (status === 'deleted' && code) deletedSet.add(code);
        });
      }
    } catch (parseErr) {
      Logger.log(`Response JSON parse skipped/failed (non-fatal): ${parseErr}`);
    }

    if (statusCode >= 200 && statusCode < 300) {
      hasAnyData.forEach((isDataRow, i) => {
        if (!isDataRow) return;
        const sc = rowSalesCodes[i] || '';
        statusValues[i][0] = sc && deletedSet.has(sc)
          ? `[DELETED] Updated @ ${stamp}`
          : `Updated @ ${stamp}`;
      });
    } else {
      hasAnyData.forEach((isDataRow, i) => {
        if (isDataRow) statusValues[i][0] = `Failure (${statusCode}), contact petergibbons7@icloud.com`;
      });
    }
  } catch (err) {
    Logger.log(`Sync threw: ${err}`);
    Logger.log(`Last status: ${statusCode === null ? 'none' : statusCode}`);
    Logger.log(`Last body: ${responseBody || '(empty)'}`);

    hasAnyData.forEach((isDataRow, i) => {
      if (isDataRow) statusValues[i][0] = 'Failure, contact petergibbons7@icloud.com';
    });
  }

  if (rows.length > 0) {
    sheet.getRange(2, 9, rows.length, 1).setValues(statusValues);
  }
}

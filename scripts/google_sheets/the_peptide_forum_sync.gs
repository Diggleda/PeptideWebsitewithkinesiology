const TIMEZONE = 'America/Los_Angeles';
// Keep this in sync with the backend env var: GOOGLE_SHEETS_WEBHOOK_SECRET
const WEBHOOK_SECRET = 'REPLACE_ME';

// PepPro Forum webhook endpoint (Flask backend)
const FORUM_WEBHOOK_URL = 'https://api.peppro.net/api/integrations/google-sheets/the-peptide-forum';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Run')
    .addItem('Sync The Peptide Forum', 'syncPeptideForum')
    .addToUi();
}

// Column A = Title, Column B = Date, Column C = Time, Column D = Description, Column E = Link, Column F = Sync Status
function syncPeptideForum() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const data = sheet.getDataRange().getValues();
  // Even if only header row is present, POST an empty list to keep the sheet authoritative
  // (this is how you wipe the DB list intentionally).

  const rows = data.length > 1 ? data.slice(1) : []; // skip header
  const stamp = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss');

  const toStr = (v) => (v == null ? '' : String(v));
  const norm = (s) => toStr(s).trim();
  const formatSheetDate = (v) => (v instanceof Date ? Utilities.formatDate(v, TIMEZONE, 'yyyy-MM-dd') : norm(v));
  const formatSheetTime = (v) => (v instanceof Date ? Utilities.formatDate(v, TIMEZONE, 'h:mm a') : norm(v));

  const items = [];
  const hasAnyData = rows.map(r => r.some(c => c && String(c).trim() !== ''));

  for (let i = 0; i < rows.length; i++) {
    const title = norm(rows[i][0]); // Col A
    const date = formatSheetDate(rows[i][1]); // Col B
    const time = formatSheetTime(rows[i][2]); // Col C
    const description = norm(rows[i][3]); // Col D
    const link = norm(rows[i][4]); // Col E

    // consider a row "non-empty" only if it has title or link content
    if (title === '' && link === '') continue;
    items.push({ title, date, time, description, link });
  }

  // Prepare a status column buffer (Column F) sized to all data rows
  const statusValues = rows.map(() => ['']);

  // Tell the server this list is authoritative (enables mirror deletions).
  const payload = { items, fullSync: true };

  let statusCode = null;
  let responseBody = '';

  try {
    const resp = UrlFetchApp.fetch(FORUM_WEBHOOK_URL, {
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

    Logger.log(`Forum sync status: ${statusCode}`);
    Logger.log(`Body: ${responseBody}`);

    if (statusCode >= 200 && statusCode < 300) {
      // Mark statuses for rows that had any data.
      hasAnyData.forEach((isDataRow, i) => {
        if (isDataRow) statusValues[i][0] = `Updated @ ${stamp}`;
      });
    } else {
      hasAnyData.forEach((isDataRow, i) => {
        if (isDataRow) statusValues[i][0] = `Failure (${statusCode}), contact petergibbons7@icloud.com`;
      });
    }
  } catch (err) {
    Logger.log(`Forum sync threw: ${err}`);
    Logger.log(`Last status: ${statusCode === null ? 'none' : statusCode}`);
    Logger.log(`Last body: ${responseBody || '(empty)'}`);

    hasAnyData.forEach((isDataRow, i) => {
      if (isDataRow) statusValues[i][0] = 'Failure, contact petergibbons7@icloud.com';
    });
  }

  // Write statuses to Column F for all data rows
  if (rows.length > 0) {
    sheet.getRange(2, 6, rows.length, 1).setValues(statusValues);
  }
}

// Backwards-compat alias (older versions referenced this name).
function syncThePeptideForum() {
  return syncPeptideForum();
}

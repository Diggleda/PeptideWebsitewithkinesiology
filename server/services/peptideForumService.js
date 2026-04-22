const { peptideForumStore } = require('../storage');
const mysqlClient = require('../database/mysqlClient');
const { logger } = require('../config/logger');

const normalizeText = (value) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || '';
};

const normalizeOptionalText = (value) => {
  const text = normalizeText(value);
  return text ? text : null;
};

const normalizeDurationMinutes = (item) => {
  const raw =
    item?.durationMinutes ??
    item?.duration_minutes ??
    item?.duration ??
    item?.lengthMinutes ??
    item?.length_minutes ??
    null;
  const value = typeof raw === 'number' ? raw : Number(normalizeText(raw));
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
};

const tryParseDateTime = (dateValue, timeValue) => {
  const rawDate = normalizeText(dateValue);
  const rawTime = normalizeText(timeValue);
  if (!rawDate) return { iso: null, rawDate: null, rawTime: rawTime || null };

  const candidates = [];
  if (rawTime) {
    // Google Sheet time strings like "3:00 PM" should be interpreted in PST.
    candidates.push(`${rawDate} ${rawTime} GMT-0800`);
    candidates.push(`${rawDate} ${rawTime}`);
  }
  candidates.push(rawDate);

  for (const candidate of candidates) {
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) {
      return { iso: parsed.toISOString(), rawDate, rawTime: rawTime || null };
    }
  }

  return { iso: null, rawDate, rawTime: rawTime || null };
};

const isCalendarDateOnly = (value) =>
  /^\d{4}-\d{1,2}-\d{1,2}$/.test(String(value || '').trim()) ||
  /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(String(value || '').trim());

const tryParseEndDateTime = (dateValue, timeValue) => {
  const rawDate = normalizeText(dateValue);
  const rawTime = normalizeText(timeValue);
  if (rawDate && !rawTime && isCalendarDateOnly(rawDate)) {
    return tryParseDateTime(rawDate, '23:59:59');
  }
  return tryParseDateTime(dateValue, timeValue);
};

const isLikelyUrl = (value) => /^https?:\/\//i.test(String(value || '').trim());

const normalizeItem = (item, index) => {
  const title = normalizeText(item?.title);
  const description = normalizeOptionalText(item?.description);
  const link = normalizeText(item?.link);
  const recording = normalizeOptionalText(item?.recording);
  const { iso: dateIso, rawDate, rawTime } = tryParseDateTime(item?.date, item?.time);
  const endDateInput =
    item?.endDate ?? item?.end_date ?? item?.endsAt ?? item?.ends_at ?? item?.endAt ?? item?.end_at ?? item?.end;
  const endTimeInput = item?.endTime ?? item?.end_time ?? item?.endTimeRaw ?? item?.end_time_raw;
  const { iso: endDateIso, rawDate: endRawDate, rawTime: endRawTime } = tryParseEndDateTime(
    endDateInput,
    endTimeInput,
  );
  const durationMinutes = normalizeDurationMinutes(item);

  if (!title && !link) {
    return { ok: false, error: `Row ${index}: missing title and link` };
  }
  if (link && !isLikelyUrl(link)) {
    return { ok: false, error: `Row ${index}: invalid link` };
  }
  if (recording && !isLikelyUrl(recording)) {
    return { ok: false, error: `Row ${index}: invalid recording link` };
  }

  const idBase = `${title || 'class'}|${dateIso || rawDate || 'nodate'}|${rawTime || 'notime'}|${link || 'nolink'}|${recording || 'norecording'}`;
  const id = Buffer.from(idBase).toString('base64url').slice(0, 48);

  return {
    ok: true,
    value: {
      id,
      title: title || (link ? 'The Peptide Forum' : 'Untitled'),
      date: dateIso || rawDate || null,
      time: rawTime || null,
      description,
      link: link || null,
      recording,
      endDate: endDateIso || endRawDate || null,
      endDateRaw: endRawDate || null,
      endTime: endRawTime || null,
      durationMinutes,
    },
  };
};

const list = () => {
  const payload = peptideForumStore.read();
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const updatedAt = typeof payload?.updatedAt === 'string' ? payload.updatedAt : null;
  return { updatedAt, items };
};

const toSqlDateTime = (value) => {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 19).replace('T', ' ');
};

const persistToMysql = async (items) => {
  if (!mysqlClient.isEnabled()) {
    return {
      mysqlEnabled: false,
      stored: 0,
      removed: 0,
    };
  }

  const syncToken = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let stored = 0;
  for (const item of items) {
    await mysqlClient.execute(
      `
        INSERT INTO peptide_forum_items (
          id,
          title,
          event_date,
          event_date_raw,
          event_time_raw,
          event_end_date,
          event_end_date_raw,
          event_end_time_raw,
          duration_minutes,
          description,
          link,
          recording,
          sync_token
        ) VALUES (
          :id,
          :title,
          :eventDate,
          :eventDateRaw,
          :eventTimeRaw,
          :eventEndDate,
          :eventEndDateRaw,
          :eventEndTimeRaw,
          :durationMinutes,
          :description,
          :link,
          :recording,
          :syncToken
        )
        ON DUPLICATE KEY UPDATE
          title = VALUES(title),
          event_date = VALUES(event_date),
          event_date_raw = VALUES(event_date_raw),
          event_time_raw = VALUES(event_time_raw),
          event_end_date = VALUES(event_end_date),
          event_end_date_raw = VALUES(event_end_date_raw),
          event_end_time_raw = VALUES(event_end_time_raw),
          duration_minutes = VALUES(duration_minutes),
          description = VALUES(description),
          link = VALUES(link),
          recording = VALUES(recording),
          sync_token = VALUES(sync_token)
      `,
      {
        id: item.id,
        title: item.title,
        eventDate: toSqlDateTime(item.date),
        eventDateRaw: item.date ? String(item.date) : null,
        eventTimeRaw: item.time ? String(item.time) : null,
        eventEndDate: toSqlDateTime(item.endDate),
        eventEndDateRaw: item.endDateRaw ? String(item.endDateRaw) : null,
        eventEndTimeRaw: item.endTime ? String(item.endTime) : null,
        durationMinutes:
          typeof item.durationMinutes === 'number' && Number.isFinite(item.durationMinutes)
            ? Math.round(item.durationMinutes)
            : null,
        description: item.description || null,
        link: item.link || null,
        recording: item.recording || null,
        syncToken,
      },
    );
    stored += 1;
  }

  let removed = 0;
  if (items.length === 0) {
    const deletedAll = await mysqlClient.execute('DELETE FROM peptide_forum_items');
    removed = Number(deletedAll?.affectedRows || 0);
  } else {
    const deletedStale = await mysqlClient.execute(
      'DELETE FROM peptide_forum_items WHERE sync_token <> :syncToken',
      { syncToken },
    );
    removed = Number(deletedStale?.affectedRows || 0);
  }

  return {
    mysqlEnabled: true,
    stored,
    removed,
  };
};

const replaceFromWebhook = async (incoming) => {
  const rows = Array.isArray(incoming) ? incoming : [];
  const errors = [];
  const items = [];

  rows.forEach((row, idx) => {
    const normalized = normalizeItem(row, idx);
    if (!normalized.ok) {
      errors.push(normalized.error);
      return;
    }
    items.push(normalized.value);
  });

  const next = {
    updatedAt: new Date().toISOString(),
    items,
  };
  peptideForumStore.write(next);

  let mysql = null;
  try {
    mysql = await persistToMysql(items);
  } catch (error) {
    logger.error({ err: error }, '[Peptide Forum] Failed to persist forum rows to MySQL');
    mysql = {
      mysqlEnabled: mysqlClient.isEnabled(),
      stored: 0,
      removed: 0,
      error:
        typeof error?.message === 'string' && error.message
          ? error.message
          : 'Unable to persist forum rows to MySQL',
    };
  }

  return {
    updatedAt: next.updatedAt,
    stored: items.length,
    received: rows.length,
    errors,
    mysql,
  };
};

module.exports = {
  list,
  replaceFromWebhook,
};

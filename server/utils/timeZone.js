const buildDateTimeFormatter = (timeZone) => new Intl.DateTimeFormat('en-US', {
  timeZone,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const getZonedParts = (date, timeZone) => {
  const formatter = buildDateTimeFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const map = parts.reduce((acc, part) => {
    if (part.type !== 'literal') {
      acc[part.type] = part.value;
    }
    return acc;
  }, {});
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
};

const getTimeZoneOffsetMs = (date, timeZone) => {
  const timestamp = date instanceof Date ? date.getTime() : Date.parse(String(date));
  const truncated = new Date(Math.floor(timestamp / 1000) * 1000);
  const parts = getZonedParts(truncated, timeZone);
  const asUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0,
  );
  return asUtcMs - truncated.getTime();
};

const zonedDateTimeToUtcMs = (
  { year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0 },
  timeZone,
) => {
  // Start with a naive UTC guess and refine using the timezone offset at that instant.
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const offset1 = getTimeZoneOffsetMs(new Date(utcMs), timeZone);
  utcMs -= offset1;
  const offset2 = getTimeZoneOffsetMs(new Date(utcMs), timeZone);
  utcMs -= (offset2 - offset1);
  return utcMs;
};

const parseYyyyMmDd = (value) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  return { year, month, day, raw };
};

const resolvePacificDayWindowUtc = ({ periodStart, periodEnd, timeZone = 'America/Los_Angeles' } = {}) => {
  const start = parseYyyyMmDd(periodStart);
  const end = parseYyyyMmDd(periodEnd);

  const startMs = start
    ? zonedDateTimeToUtcMs({ ...start, hour: 0, minute: 0, second: 0, millisecond: 0 }, timeZone)
    : null;
  const endMs = end
    ? zonedDateTimeToUtcMs({ ...end, hour: 23, minute: 59, second: 59, millisecond: 999 }, timeZone)
    : null;

  if (startMs !== null && endMs !== null && startMs > endMs) {
    return {
      startMs: endMs,
      endMs: startMs,
      start: end,
      end: start,
      timeZone,
    };
  }

  return {
    startMs,
    endMs,
    start,
    end,
    timeZone,
  };
};

module.exports = {
  resolvePacificDayWindowUtc,
};

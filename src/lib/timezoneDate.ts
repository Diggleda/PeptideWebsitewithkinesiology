const HAS_EXPLICIT_TIMEZONE_RE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;
const NAIVE_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?)?$/;

const TIME_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const getPacificOffsetMs = (timestampMs: number) => {
  const parts = TIME_PARTS_FORMATTER.formatToParts(new Date(timestampMs));
  const pick = (type: string) => {
    const found = parts.find((part) => part.type === type)?.value || "";
    const parsed = Number(found);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const year = pick("year");
  const month = pick("month");
  const day = pick("day");
  const hour = pick("hour");
  const minute = pick("minute");
  const second = pick("second");
  const asUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  return asUtcMs - timestampMs;
};

const parseNaivePacific = (value: string): Date | null => {
  const match = value.match(NAIVE_DATETIME_RE);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] || "0");
  const minute = Number(match[5] || "0");
  const second = Number(match[6] || "0");
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    return null;
  }

  const targetWallAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  let resolvedUtcMs = targetWallAsUtcMs;
  for (let i = 0; i < 3; i += 1) {
    resolvedUtcMs = targetWallAsUtcMs - getPacificOffsetMs(resolvedUtcMs);
  }

  const result = new Date(resolvedUtcMs);
  return Number.isNaN(result.getTime()) ? null : result;
};

export const parseBackendTimestamp = (value?: string | Date | null): Date | null => {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== "string") {
    return null;
  }

  const raw = value.trim();
  if (!raw) return null;

  const normalized = raw.includes(" ") && !raw.includes("T") ? raw.replace(" ", "T") : raw;

  if (HAS_EXPLICIT_TIMEZONE_RE.test(normalized)) {
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const pacificDate = parseNaivePacific(normalized);
  if (pacificDate) return pacificDate;

  const fallback = new Date(normalized);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
};


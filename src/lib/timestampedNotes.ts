export type TimestampedNotesEntry = {
  timestamp: Date;
  text: string;
};

type ParsedNotes = {
  entries: TimestampedNotesEntry[];
};

const pad2 = (value: number) => String(value).padStart(2, "0");

const monthIndexFromLabel = (raw: string) => {
  const key = raw.trim().slice(0, 3).toLowerCase();
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const index = months.indexOf(key);
  return index >= 0 ? index : null;
};

const parseTimestampLabel = (raw: string) => {
  const match = raw
    .trim()
    .match(
      /^(\d{1,2}):(\d{2})\s*(am|pm)\s*-\s*([A-Za-z]{3,})\s+(\d{1,2}),\s*(\d{4})$/i,
    );
  if (!match) return null;
  const hourRaw = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  const meridiem = match[3].toLowerCase();
  const monthIndex = monthIndexFromLabel(match[4]);
  const day = Number.parseInt(match[5], 10);
  const year = Number.parseInt(match[6], 10);
  if (!Number.isFinite(hourRaw) || !Number.isFinite(minute) || monthIndex == null || !Number.isFinite(day) || !Number.isFinite(year)) {
    return null;
  }
  if (minute < 0 || minute > 59) return null;
  if (day < 1 || day > 31) return null;
  if (year < 1970 || year > 9999) return null;
  if (hourRaw < 1 || hourRaw > 12) return null;

  let hour = hourRaw % 12;
  if (meridiem === "pm") hour += 12;
  const parsed = new Date(year, monthIndex, day, hour, minute, 0, 0);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const isValidDate = (value: Date) => Number.isFinite(value.getTime());

export const formatTimestampedNotesLabel = (value: Date) => {
  const time = value
    .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
    .replace(/\s+/g, "")
    .toLowerCase();
  const date = value.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${time} - ${date}`;
};

export const parseTimestampedNotes = (value: string): ParsedNotes | null => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const entries: TimestampedNotesEntry[] = [];
    for (const [key, stored] of Object.entries(parsed as Record<string, unknown>)) {
      const fromIso = new Date(key);
      const ts = isValidDate(fromIso)
        ? fromIso
        : parseTimestampLabel(key) || (Number.isFinite(Number(key)) ? new Date(Number(key)) : null);
      if (!ts || !isValidDate(ts)) continue;
      const text = stored == null ? "" : typeof stored === "string" ? stored : String(stored);
      entries.push({ timestamp: ts, text });
    }
    return entries.length > 0 ? { entries } : null;
  } catch {
    return null;
  }
};

export const formatTimestampedNotesForDisplay = (value: string) => {
  const raw = typeof value === "string" ? value : "";
  const trimmed = raw.trim();
  if (!trimmed) return "";

  const parsed = parseTimestampedNotes(trimmed);
  if (!parsed) return trimmed;

  return parsed.entries
    .map((entry) => {
      const label = formatTimestampedNotesLabel(entry.timestamp);
      const head = `[${label}]`;
      const body = typeof entry.text === "string" ? entry.text.trimEnd() : "";
      return body ? `${head} ${body}` : head;
    })
    .join("\n");
};

export const toDateInputValue = (value: Date) => {
  const y = value.getFullYear();
  const m = pad2(value.getMonth() + 1);
  const d = pad2(value.getDate());
  return `${y}-${m}-${d}`;
};

export const toTimeInputValue = (value: Date) => `${pad2(value.getHours())}:${pad2(value.getMinutes())}`;


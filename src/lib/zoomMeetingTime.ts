type ExtractedMeetingTime = {
  date: Date;
  source: "query_param" | "hash" | "invitation_text";
  raw: string;
};

const parseDateCandidate = (value: string): Date | null => {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;

  const numeric = trimmed.replace(/[,_\s]/g, "");
  if (/^\d{10,13}$/.test(numeric)) {
    const asNumber = Number.parseInt(numeric, 10);
    if (!Number.isFinite(asNumber)) return null;
    const ms = numeric.length === 13 ? asNumber : asNumber * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // Support "YYYY-MM-DD HH:mm" and "YYYY-MM-DD_HH:mm"
  const normalized = trimmed.replace(/_/g, " ").replace(/\s+/, " ");
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(normalized)) {
    const date = new Date(normalized.replace(" ", "T"));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
};

const firstUrlFromText = (input: string): string | null => {
  const text = String(input || "");
  const match = text.match(/\b(https?:\/\/\S+|zoommtg:\/\/\S+)\b/i);
  return match ? match[1] : null;
};

const parseZoomUrlForDate = (urlText: string): ExtractedMeetingTime | null => {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    return null;
  }

  const params = url.searchParams;
  const candidateKeys = [
    "startTime",
    "start_time",
    "start",
    "datetime",
    "dateTime",
    "date_time",
    "time",
    "ts",
    "t",
  ];

  for (const key of candidateKeys) {
    const value = params.get(key);
    if (!value) continue;
    const parsed = parseDateCandidate(value);
    if (parsed) {
      return { date: parsed, source: "query_param", raw: `${key}=${value}` };
    }
  }

  if (url.hash) {
    const hash = url.hash.replace(/^#/, "");
    const parsed = parseDateCandidate(hash);
    if (parsed) {
      return { date: parsed, source: "hash", raw: url.hash };
    }
  }

  return null;
};

const parseInvitationTextForDate = (input: string): ExtractedMeetingTime | null => {
  const text = String(input || "").trim();
  if (!text) return null;

  // Common Zoom invite pattern: "Time: Jan 14, 2026 10:00 AM"
  const timeLineMatch = text.match(
    /\b(?:Time|When)\s*:\s*([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM))\b/i,
  );
  if (timeLineMatch?.[1]) {
    const parsed = parseDateCandidate(timeLineMatch[1]);
    if (parsed) {
      return { date: parsed, source: "invitation_text", raw: timeLineMatch[1] };
    }
  }

  // More generic date+time scan (kept conservative to avoid false positives)
  const genericMatch = text.match(
    /\b([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM))\b/i,
  );
  if (genericMatch?.[1]) {
    const parsed = parseDateCandidate(genericMatch[1]);
    if (parsed) {
      return { date: parsed, source: "invitation_text", raw: genericMatch[1] };
    }
  }

  return null;
};

export const extractMeetingTimeFromZoomLink = (
  input: string,
): ExtractedMeetingTime | null => {
  const urlText = firstUrlFromText(input) || input;
  const fromUrl = parseZoomUrlForDate(urlText);
  if (fromUrl) return fromUrl;
  return parseInvitationTextForDate(input);
};


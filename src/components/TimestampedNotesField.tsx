import { useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Pencil, Plus } from "lucide-react";
import { cn } from "./ui/utils";

type TimestampedEntry = {
  timestamp: Date;
  text: string;
};

type ParsedNotes = {
  preamble: string;
  entries: TimestampedEntry[];
};

const pad2 = (value: number) => String(value).padStart(2, "0");

const formatTimestamp = (value: Date) => {
  const time = value
    .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
    .replace(/\s+/g, "")
    .toLowerCase();
  const date = value.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${time} - ${date}`;
};

const monthIndexFromLabel = (raw: string) => {
  const key = raw.trim().slice(0, 3).toLowerCase();
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const index = months.indexOf(key);
  return index >= 0 ? index : null;
};

const parseTimestamp = (raw: string) => {
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

const parseNotesJson = (value: string): ParsedNotes | null => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const entries: TimestampedEntry[] = [];
  for (const [key, stored] of Object.entries(parsed as Record<string, unknown>)) {
    const fromIso = new Date(key);
    const ts = isValidDate(fromIso)
      ? fromIso
      : parseTimestamp(key) || (Number.isFinite(Number(key)) ? new Date(Number(key)) : null);
    if (!ts || !isValidDate(ts)) {
      continue;
    }
    const text = stored == null ? "" : typeof stored === "string" ? stored : String(stored);
    entries.push({ timestamp: ts, text });
  }

  if (entries.length === 0) return null;
  return { preamble: "", entries };
};

const parseNotes = (value: string): ParsedNotes => {
  const normalized = typeof value === "string" ? value : "";
  if (!normalized) return { preamble: "", entries: [] };

  const jsonParsed = parseNotesJson(normalized);
  if (jsonParsed) return jsonParsed;

  const lines = normalized.replace(/\r\n/g, "\n").split("\n");
  const entries: TimestampedEntry[] = [];
  const preambleLines: string[] = [];
  let current: TimestampedEntry | null = null;
  let seenFirstEntry = false;

  for (const line of lines) {
    const match = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (match) {
      const parsedTs = parseTimestamp(match[1]);
      if (parsedTs) {
        if (current) entries.push(current);
        current = { timestamp: parsedTs, text: match[2] || "" };
        seenFirstEntry = true;
        continue;
      }
    }

    if (!seenFirstEntry) {
      preambleLines.push(line);
    } else if (current) {
      current.text = current.text ? `${current.text}\n${line}` : line;
    } else {
      preambleLines.push(line);
    }
  }

  if (current) entries.push(current);
  const preamble = preambleLines.join("\n").trimEnd();
  return { preamble, entries };
};

const toDateInputValue = (value: Date) => {
  const y = value.getFullYear();
  const m = pad2(value.getMonth() + 1);
  const d = pad2(value.getDate());
  return `${y}-${m}-${d}`;
};

const toTimeInputValue = (value: Date) => `${pad2(value.getHours())}:${pad2(value.getMinutes())}`;

const combineDateAndTime = (dateValue: string, timeValue: string) => {
  const dateMatch = dateValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = timeValue.match(/^(\d{2}):(\d{2})$/);
  if (!dateMatch || !timeMatch) return null;
  const year = Number.parseInt(dateMatch[1], 10);
  const month = Number.parseInt(dateMatch[2], 10);
  const day = Number.parseInt(dateMatch[3], 10);
  const hour = Number.parseInt(timeMatch[1], 10);
  const minute = Number.parseInt(timeMatch[2], 10);
  if (![year, month, day, hour, minute].every((n) => Number.isFinite(n))) return null;
  const next = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (Number.isNaN(next.getTime())) return null;
  return next;
};

const serializeNotes = ({ preamble, entries }: ParsedNotes) => {
  const cleanPreamble = preamble ? String(preamble).trimEnd() : "";
  if (!entries.length) return cleanPreamble;

  const normalizedEntries = entries.map((entry) => ({
    timestamp: entry.timestamp,
    text: typeof entry.text === "string" ? entry.text : String(entry.text ?? ""),
  }));

  if (cleanPreamble) {
    const first = normalizedEntries[0];
    normalizedEntries[0] = {
      ...first,
      text: first.text ? `${cleanPreamble}\n${first.text}` : cleanPreamble,
    };
  }

  const used = new Set<string>();
  const obj: Record<string, string> = {};
  normalizedEntries.forEach((entry) => {
    let stamp = entry.timestamp instanceof Date ? entry.timestamp : new Date(entry.timestamp);
    if (!isValidDate(stamp)) {
      stamp = new Date();
    }
    let key = stamp.toISOString();
    while (used.has(key)) {
      stamp = new Date(stamp.getTime() + 1);
      key = stamp.toISOString();
    }
    used.add(key);
    obj[key] = entry.text;
  });

  return JSON.stringify(obj);
};

export type TimestampedNotesFieldProps = {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  id?: string;
};

export function TimestampedNotesField({
  value,
  onChange,
  disabled = false,
  className,
  placeholder,
  id,
}: TimestampedNotesFieldProps) {
  const parsed = useMemo(() => parseNotes(value), [value]);
  const preambleRef = useRef<HTMLTextAreaElement | null>(null);
  const textRefs = useRef<(HTMLTextAreaElement | null)[]>([]);
  const pendingFocusIndexRef = useRef<number | null>(null);
  const [timestampEditorIndex, setTimestampEditorIndex] = useState<number | null>(null);

  useLayoutEffect(() => {
    const index = pendingFocusIndexRef.current;
    if (index == null) return;
    pendingFocusIndexRef.current = null;
    const el = textRefs.current[index];
    if (!el) return;
    el.focus();
    const len = el.value.length;
    try {
      el.setSelectionRange(len, len);
    } catch {
      // Ignore selection errors for unsupported inputs.
    }
  }, [parsed.entries.length]);

  useLayoutEffect(() => {
    const autosize = (el: HTMLTextAreaElement | null) => {
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    };

    autosize(preambleRef.current);
    textRefs.current.forEach((el) => autosize(el));
  }, [parsed.preamble, parsed.entries]);

  const commit = useCallback(
    (next: ParsedNotes) => {
      onChange(serializeNotes(next));
    },
    [onChange],
  );

  const handlePreambleChange = useCallback(
    (nextPreamble: string) => {
      commit({ preamble: nextPreamble, entries: parsed.entries });
    },
    [commit, parsed.entries],
  );

  const handleEntryTextChange = useCallback(
    (index: number, nextText: string) => {
      const nextEntries = parsed.entries.map((entry, idx) => (idx === index ? { ...entry, text: nextText } : entry));
      commit({ preamble: parsed.preamble, entries: nextEntries });
    },
    [commit, parsed.entries, parsed.preamble],
  );

  const handleEntryTimestampChange = useCallback(
    (index: number, nextDate: Date) => {
      const nextEntries = parsed.entries.map((entry, idx) =>
        idx === index ? { ...entry, timestamp: nextDate } : entry,
      );
      commit({ preamble: parsed.preamble, entries: nextEntries });
    },
    [commit, parsed.entries, parsed.preamble],
  );

  const handleEntryTimestampDelete = useCallback(
    (index: number) => {
      const target = parsed.entries[index];
      if (!target) return;
      const movedText = typeof target.text === "string" ? target.text : String(target.text ?? "");
      const nextEntries = parsed.entries
        .filter((_, idx) => idx !== index)
        .map((entry) => ({ ...entry }));

      let nextPreamble = parsed.preamble;
      if (movedText) {
        if (index > 0 && nextEntries[index - 1]) {
          const prevText = nextEntries[index - 1].text || "";
          nextEntries[index - 1].text = prevText ? `${prevText}\n${movedText}` : movedText;
        } else {
          nextPreamble = nextPreamble ? `${nextPreamble}\n${movedText}` : movedText;
        }
      }

      setTimestampEditorIndex(null);
      commit({ preamble: nextPreamble, entries: nextEntries });
    },
    [commit, parsed.entries, parsed.preamble],
  );

  const handleAddEntry = useCallback(() => {
    if (disabled) return;
    const nextEntries = [...parsed.entries, { timestamp: new Date(), text: "" }];
    pendingFocusIndexRef.current = nextEntries.length - 1;
    setTimestampEditorIndex(null);
    commit({ preamble: parsed.preamble, entries: nextEntries });
  }, [commit, disabled, parsed.entries, parsed.preamble]);

  const insertNewlineAtCursor = (
    value: string,
    start: number | null,
    end: number | null,
  ) => {
    const safeStart = Number.isFinite(start) ? Math.max(0, start as number) : value.length;
    const safeEnd = Number.isFinite(end) ? Math.max(safeStart, end as number) : safeStart;
    const next = `${value.slice(0, safeStart)}\n${value.slice(safeEnd)}`;
    return { next, caret: safeStart + 1 };
  };

  const handlePreambleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      const el = event.currentTarget;
      const { next, caret } = insertNewlineAtCursor(el.value, el.selectionStart, el.selectionEnd);
      handlePreambleChange(next);
      window.requestAnimationFrame(() => {
        try {
          el.setSelectionRange(caret, caret);
        } catch {
          // Ignore unsupported selection APIs.
        }
      });
    },
    [handlePreambleChange],
  );

  const handleEntryKeyDown = useCallback(
    (index: number, event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      const el = event.currentTarget;
      const { next, caret } = insertNewlineAtCursor(el.value, el.selectionStart, el.selectionEnd);
      handleEntryTextChange(index, next);
      window.requestAnimationFrame(() => {
        try {
          el.setSelectionRange(caret, caret);
        } catch {
          // Ignore unsupported selection APIs.
        }
      });
    },
    [handleEntryTextChange],
  );

  const rootClasses = cn(
    "textarea bg-input-background border-input flex min-h-[80px] max-h-[420px] w-full flex-col gap-2 overflow-y-auto rounded-md border px-3 py-2 text-base transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
    "focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]",
    className,
  );

  return (
    <div id={id} className={rootClasses} aria-disabled={disabled || undefined}>
      {parsed.preamble ? (
        <textarea
          ref={preambleRef}
          value={parsed.preamble}
          onChange={(event) => handlePreambleChange(event.target.value)}
          onKeyDown={handlePreambleKeyDown}
          className="w-full resize-none overflow-hidden bg-transparent text-sm text-slate-700 outline-none placeholder:text-slate-400"
          rows={2}
          disabled={disabled}
          placeholder={parsed.entries.length === 0 ? placeholder : undefined}
        />
      ) : null}

      {parsed.entries.map((entry, index) => {
        const formatted = formatTimestamp(entry.timestamp);
        const dateValue = toDateInputValue(entry.timestamp);
        const timeValue = toTimeInputValue(entry.timestamp);
        const isEditorOpen = timestampEditorIndex === index;

        return (
          <div key={index} className="flex items-start gap-2">
            <Popover.Root
              open={isEditorOpen}
              onOpenChange={(open) => setTimestampEditorIndex(open ? index : null)}
            >
              <Popover.Trigger asChild disabled={disabled}>
                <button
                  type="button"
                  className={cn(
                    "timestamp-chip inline-flex items-center justify-center whitespace-nowrap text-[11px] font-semibold tracking-tight",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(95,179,249,0.3)]",
                    disabled ? "cursor-not-allowed opacity-60" : "",
                  )}
                  aria-label="Edit timestamp"
                >
                  <span className="timestamp-chip__label">[{formatted}]</span>
                  <span className="timestamp-chip__edit pointer-events-none">
                    <span className="timestamp-chip__bracket">[</span>
                    <span className="timestamp-chip__edit-pill">
                      <Pencil className="h-3 w-3" aria-hidden="true" />
                      Edit
                    </span>
                    <span className="timestamp-chip__bracket">]</span>
                  </span>
                </button>
            </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  side="bottom"
                  align="start"
                  sideOffset={8}
                  className="timestamp-editor-popover z-[10000] w-[260px] rounded-xl p-3 shadow-xl"
                >
                  <div className="timestamp-editor-popover__grid-wrap">
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => handleEntryTimestampDelete(index)}
                      className="timestamp-editor-popover__delete text-xs font-semibold"
                    >
                      Delete
                    </button>
                    <div className="timestamp-editor-popover__grid">
                    <div className="space-y-1">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">
                        Date
                      </div>
                      <input
                        type="date"
                        value={dateValue}
                        disabled={disabled}
                        onChange={(event) => {
                          const next = combineDateAndTime(event.target.value, timeValue);
                          if (next) handleEntryTimestampChange(index, next);
                        }}
                        className="w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-sm focus:border-[rgb(95,179,249)] focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.3)]"
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">
                        Time
                      </div>
                      <input
                        type="time"
                        value={timeValue}
                        step={60}
                        disabled={disabled}
                        onChange={(event) => {
                          const next = combineDateAndTime(dateValue, event.target.value);
                          if (next) handleEntryTimestampChange(index, next);
                        }}
                        className="w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-sm focus:border-[rgb(95,179,249)] focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.3)]"
                      />
                    </div>
                    </div>
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            <textarea
              ref={(el) => {
                textRefs.current[index] = el;
              }}
              value={entry.text}
              onChange={(event) => handleEntryTextChange(index, event.target.value)}
              onKeyDown={(event) => handleEntryKeyDown(index, event)}
              className="min-h-7 w-full flex-1 resize-none overflow-hidden bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400"
              rows={1}
              disabled={disabled}
            />
          </div>
        );
      })}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleAddEntry}
          disabled={disabled}
          className={cn(
            "timestamp-chip__add-button inline-flex items-center justify-center transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(95,179,249,0.3)]",
            disabled ? "cursor-not-allowed opacity-60" : "",
          )}
          aria-label="Add timestamped log"
        >
          <Plus className="h-4 w-4" />
        </button>
        {disabled && !parsed.preamble && parsed.entries.length === 0 && placeholder ? (
          <span className="text-xs text-slate-500">{placeholder}</span>
        ) : null}
      </div>
    </div>
  );
}

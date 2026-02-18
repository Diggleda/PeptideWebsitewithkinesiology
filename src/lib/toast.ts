import { toast as sonnerToast } from "sonner@2.0.3";

const DEDUPE_WINDOW_MS = 1500;
const recentToastAt = new Map<string, number>();

const normalizeMessageKey = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  return text.length > 0 ? text : null;
};

const shouldSuppress = (key: string): boolean => {
  const now = Date.now();
  for (const [existingKey, at] of recentToastAt.entries()) {
    if (now - at > DEDUPE_WINDOW_MS * 3) {
      recentToastAt.delete(existingKey);
    }
  }
  const previousAt = recentToastAt.get(key);
  if (typeof previousAt === "number" && now - previousAt < DEDUPE_WINDOW_MS) {
    return true;
  }
  recentToastAt.set(key, now);
  return false;
};

const resolveToastId = (
  kind: "success" | "error" | "info" | "warning" | "message",
  message: unknown,
  options: any,
): string | null => {
  const explicitId = options?.id;
  if (explicitId !== undefined && explicitId !== null && String(explicitId).trim().length > 0) {
    return String(explicitId).trim();
  }
  const messageKey = normalizeMessageKey(message);
  if (!messageKey) return null;
  return `auto:${kind}:${messageKey}`;
};

const showDeduped = (
  kind: "success" | "error" | "info" | "warning" | "message",
  message: unknown,
  options?: any,
) => {
  const id = resolveToastId(kind, message, options);
  if (id && shouldSuppress(id)) {
    return id;
  }
  const nextOptions = id ? { ...(options || {}), id } : options;
  const method = (sonnerToast as any)[kind];
  return method(message as any, nextOptions);
};

export const toast = Object.assign(
  (...args: any[]) => (sonnerToast as any)(...args),
  sonnerToast,
  {
    success: (message: unknown, options?: any) =>
      showDeduped("success", message, options),
    error: (message: unknown, options?: any) =>
      showDeduped("error", message, options),
    info: (message: unknown, options?: any) =>
      showDeduped("info", message, options),
    warning: (message: unknown, options?: any) =>
      showDeduped("warning", message, options),
    message: (message: unknown, options?: any) =>
      showDeduped("message", message, options),
  },
);


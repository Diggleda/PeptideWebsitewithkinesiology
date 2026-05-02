const LEGACY_STORAGE_KEYS: Record<string, string[]> = {
  trufusion_tab_id_v1: ["peppro_tab_id_v1"],
  trufusion_session_id_v1: ["peppro_session_id_v1"],
  trufusion_user_id_v1: ["peppro_user_id_v1"],
  trufusion_auth_email_v1: ["peppro_auth_email_v1"],
  trufusion_session_started_at_v1: ["peppro_session_started_at_v1"],
  trufusion_auth_event_v1: ["peppro_auth_event_v1"],
  trufusion_auth_mode_v1: ["peppro_auth_mode_v1"],
  trufusion_checkout_idempotency_v1: ["peppro_checkout_idempotency_v1"],
};

export const LEGACY_AUTH_CHANNEL_NAME = "peppro-auth";

export const legacyMetaKey = (key: string): string | null => {
  if (!key.startsWith("trufusion")) return null;
  return `peppro${key.slice("trufusion".length)}`;
};

export const withLegacyMetaKeys = (keys: string | string[]): string[] => {
  const list = Array.isArray(keys) ? keys : [keys];
  const expanded: string[] = [];
  list.forEach((key) => {
    if (!expanded.includes(key)) expanded.push(key);
    const legacy = legacyMetaKey(key);
    if (legacy && !expanded.includes(legacy)) expanded.push(legacy);
  });
  return expanded;
};

export const readStorageWithLegacy = (storage: Storage, key: string): string | null => {
  const current = storage.getItem(key);
  if (current !== null) return current;
  for (const legacyKey of LEGACY_STORAGE_KEYS[key] || []) {
    const legacyValue = storage.getItem(legacyKey);
    if (legacyValue !== null) {
      try {
        storage.setItem(key, legacyValue);
      } catch {
        // Best-effort migration only.
      }
      return legacyValue;
    }
  }
  return null;
};

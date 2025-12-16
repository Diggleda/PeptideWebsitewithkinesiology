type LockRecord = {
  tabId: string;
  expiresAt: number;
  updatedAt: number;
};

const TAB_ID_STORAGE_KEY = '__peppro_tab_id__';

const safeSessionStorageGet = (key: string): string | null => {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
};

const safeSessionStorageSet = (key: string, value: string) => {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // ignore
  }
};

const safeLocalStorageGet = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const safeLocalStorageSet = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
};

const safeLocalStorageRemove = (key: string) => {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
};

const createId = () => {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  return `tab_${rand}`;
};

export const getTabId = (): string => {
  if (typeof window === 'undefined') return 'server';
  const existing = safeSessionStorageGet(TAB_ID_STORAGE_KEY);
  if (existing) return existing;
  const id = createId();
  safeSessionStorageSet(TAB_ID_STORAGE_KEY, id);
  return id;
};

const lockKey = (name: string) => `peppro:lock:${name}`;

export const isTabLeader = (name: string, ttlMs: number): boolean => {
  if (typeof window === 'undefined') return true;
  const ttl = Math.max(5_000, Number.isFinite(ttlMs) ? ttlMs : 15_000);
  const key = lockKey(name);
  const tabId = getTabId();
  const now = Date.now();

  let parsed: LockRecord | null = null;
  const raw = safeLocalStorageGet(key);
  if (raw) {
    try {
      parsed = JSON.parse(raw) as LockRecord;
    } catch {
      parsed = null;
    }
  }

  const isExpired =
    !parsed ||
    typeof parsed.expiresAt !== 'number' ||
    parsed.expiresAt <= now ||
    !parsed.tabId;

  if (isExpired || parsed?.tabId === tabId) {
    const next: LockRecord = {
      tabId,
      expiresAt: now + ttl,
      updatedAt: now,
    };
    safeLocalStorageSet(key, JSON.stringify(next));
    return true;
  }

  return false;
};

export const releaseTabLeadership = (name: string) => {
  if (typeof window === 'undefined') return;
  const key = lockKey(name);
  const tabId = getTabId();
  const raw = safeLocalStorageGet(key);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as LockRecord;
    if (parsed?.tabId === tabId) {
      safeLocalStorageRemove(key);
    }
  } catch {
    // ignore
  }
};


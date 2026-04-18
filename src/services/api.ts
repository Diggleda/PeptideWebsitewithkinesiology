import type { AuthenticationResponseJSON, RegistrationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { sanitizePayloadMessages, sanitizeServiceNames } from '../lib/publicText';
import { readDelegateTokenFromLocation } from '../lib/researchSupplyLinks';
import type {
  ProspectQuoteDetail,
  ProspectQuoteImportPayload,
  ProspectQuoteListResponse,
} from '../types/quotes';

export const API_BASE_URL = (() => {
  const configured = ((import.meta.env.VITE_API_URL as string | undefined) || '').trim();
  if (!configured) {
    // In dev we expect the API on localhost:3001 by default.
    if (import.meta.env.DEV) {
      return 'http://localhost:3001/api';
    }
    // In production, default to relative same-origin `/api` so the bundle stays host-agnostic.
    return '/api';
  }

  const normalized = configured.replace(/\/+$/, '');
  return normalized.toLowerCase().endsWith('/api') ? normalized : `${normalized}/api`;
})();

const GREATER_AREA_UPPERCASE_WORDS = new Set([
  'dc',
  'dfw',
  'dmv',
  'nola',
  'nova',
  'nyc',
  'sf',
  'slc',
  'us',
  'usa',
]);

const normalizePhysicianGreaterArea = (value: unknown): string | null => {
  if (value == null) {
    return null;
  }
  const trimmed = String(value).trim().replace(/\s+/g, ' ');
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/[A-Za-z]+/g, (word, offset, fullText) => {
    const lower = word.toLowerCase();
    const upper = word.toUpperCase();
    let previousNonWhitespace = '';
    for (let index = offset - 1; index >= 0; index -= 1) {
      const candidate = fullText[index];
      if (!/\s/.test(candidate)) {
        previousNonWhitespace = candidate;
        break;
      }
    }
    if (GREATER_AREA_UPPERCASE_WORDS.has(lower)) {
      return upper;
    }
    if (word.length === 2 && previousNonWhitespace === ',') {
      return upper;
    }
    if (/^[a-z]+$/.test(word)) {
      return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
    }
    if (/^[A-Z]+$/.test(word)) {
      if (word.length <= 2) {
        return upper;
      }
      return `${upper.charAt(0)}${lower.slice(1)}`;
    }
    return word;
  });
};

const normalizeGreaterAreaFields = <T>(value: T): T => {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const normalizedEntry = normalizeGreaterAreaFields(entry);
      if (normalizedEntry !== entry) {
        changed = true;
      }
      return normalizedEntry;
    });
    return (changed ? next : value) as T;
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const record = value as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = {};
  Object.entries(record).forEach(([key, rawValue]) => {
    let normalizedValue = rawValue;
    if (key === 'greaterArea' || key === 'greater_area') {
      normalizedValue = normalizePhysicianGreaterArea(rawValue);
    } else if (rawValue && typeof rawValue === 'object') {
      normalizedValue = normalizeGreaterAreaFields(rawValue);
    }
    if (normalizedValue !== rawValue) {
      changed = true;
    }
    next[key] = normalizedValue;
  });
  return (changed ? next : value) as T;
};

type AuthenticatedRequestInit = RequestInit & {
  background?: boolean;
  skipReachabilityDispatch?: boolean;
  preserveAuthOnAuthFailure?: boolean;
};

type AuthTabEvent = {
  type: 'LOGIN';
  tabId: string;
  sessionId: string;
  userId?: string | null;
  email?: string | null;
  at: number;
};

type AuthSessionMode = 'standard' | 'shadow';

const AUTH_TAB_ID_KEY = 'peppro_tab_id_v1';
const AUTH_SESSION_ID_KEY = 'peppro_session_id_v1';
const AUTH_USER_ID_KEY = 'peppro_user_id_v1';
const AUTH_EMAIL_KEY = 'peppro_auth_email_v1';
const AUTH_SESSION_STARTED_AT_KEY = 'peppro_session_started_at_v1';
const AUTH_EVENT_STORAGE_KEY = 'peppro_auth_event_v1';
const AUTH_MODE_KEY = 'peppro_auth_mode_v1';
const AUTH_EVENT_NAME = 'peppro:force-logout';
const SHADOW_READ_ONLY_CODE = 'SHADOW_READ_ONLY';
const SHADOW_READ_ONLY_MESSAGE = 'Maintenance mode is read-only';
const AUTH_CHECK_FAILED_CODE = 'AUTH_CHECK_FAILED';

const MULTI_SESSION_EXEMPT_EMAIL = 'test@doctor.com';

const isMultiSessionExemptEmail = (email?: string | null) =>
  String(email || '')
    .trim()
    .toLowerCase() === MULTI_SESSION_EXEMPT_EMAIL;

const _randomId = () => {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // ignore
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
};

const getOrCreateTabId = () => {
  try {
    const existing = sessionStorage.getItem(AUTH_TAB_ID_KEY);
    if (existing && existing.trim()) return existing;
    const next = _randomId();
    sessionStorage.setItem(AUTH_TAB_ID_KEY, next);
    return next;
  } catch {
    return _randomId();
  }
};

const getSessionId = () => {
  try {
    const value = sessionStorage.getItem(AUTH_SESSION_ID_KEY);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
};

const getAuthMode = (): AuthSessionMode => {
  try {
    const value = sessionStorage.getItem(AUTH_MODE_KEY);
    return value === 'shadow' ? 'shadow' : 'standard';
  } catch {
    return 'standard';
  }
};

const setAuthMode = (mode: AuthSessionMode) => {
  try {
    sessionStorage.setItem(AUTH_MODE_KEY, mode);
  } catch {
    // ignore
  }
};

export const isShadowSessionMode = () => getAuthMode() === 'shadow';

const setSessionId = (sessionId: string) => {
  try {
    sessionStorage.setItem(AUTH_SESSION_ID_KEY, sessionId);
  } catch {
    // ignore
  }
};

const clearSessionId = () => {
  try {
    sessionStorage.removeItem(AUTH_SESSION_ID_KEY);
  } catch {
    // ignore
  }
};

const setSessionStartedAt = (valueMs) => {
  try {
    sessionStorage.setItem(AUTH_SESSION_STARTED_AT_KEY, String(Math.floor(Number(valueMs) || Date.now())));
  } catch {
    // ignore
  }
};

const clearSessionStartedAt = () => {
  try {
    sessionStorage.removeItem(AUTH_SESSION_STARTED_AT_KEY);
  } catch {
    // ignore
  }
};

const getAuthUserId = () => {
  try {
    const value = sessionStorage.getItem(AUTH_USER_ID_KEY);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
};

const setAuthUserId = (userId: string | null | undefined) => {
  try {
    const normalized = typeof userId === 'string' ? userId.trim() : '';
    if (!normalized) {
      sessionStorage.removeItem(AUTH_USER_ID_KEY);
      return;
    }
    sessionStorage.setItem(AUTH_USER_ID_KEY, normalized);
  } catch {
    // ignore
  }
};

const getAuthEmail = () => {
  try {
    const value = sessionStorage.getItem(AUTH_EMAIL_KEY);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
};

const setAuthEmail = (email: string | null | undefined) => {
  try {
    const normalized = typeof email === 'string' ? email.trim() : '';
    if (!normalized) {
      sessionStorage.removeItem(AUTH_EMAIL_KEY);
      return;
    }
    sessionStorage.setItem(AUTH_EMAIL_KEY, normalized);
  } catch {
    // ignore
  }
};

const _activeAuthenticatedRequestControllers = new Set<AbortController>();

const releaseAuthenticatedRequestController = (controller: AbortController | null | undefined) => {
  if (!controller) return;
  _activeAuthenticatedRequestControllers.delete(controller);
};

const createAuthenticatedRequestSignal = (existingSignal?: AbortSignal | null) => {
  const controller = new AbortController();
  const forwardAbort = () => {
    try {
      controller.abort((existingSignal as any)?.reason);
    } catch {
      controller.abort();
    }
  };
  if (existingSignal) {
    if (existingSignal.aborted) {
      forwardAbort();
    } else {
      existingSignal.addEventListener('abort', forwardAbort, { once: true });
    }
  }
  _activeAuthenticatedRequestControllers.add(controller);
  return {
    controller,
    signal: controller.signal,
    cleanup: () => {
      if (existingSignal) {
        existingSignal.removeEventListener('abort', forwardAbort);
      }
      releaseAuthenticatedRequestController(controller);
    },
  };
};

const abortAuthenticatedRequests = () => {
  const controllers = Array.from(_activeAuthenticatedRequestControllers);
  _activeAuthenticatedRequestControllers.clear();
  controllers.forEach((controller) => {
    try {
      controller.abort(new DOMException('Authentication ended', 'AbortError'));
    } catch {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    }
  });
  _inflightGetRequests.clear();
};

const emitAuthEvent = (payload: AuthTabEvent) => {
  if (typeof window === 'undefined') return;
  try {
    // BroadcastChannel is fast and avoids localStorage writes in most modern browsers.
    if ('BroadcastChannel' in window) {
      const channel = new (window as any).BroadcastChannel('peppro-auth');
      channel.postMessage(payload);
      channel.close();
    }
  } catch {
    // ignore
  }
  try {
    // Fallback path; also reaches browsers without BroadcastChannel.
    localStorage.setItem(AUTH_EVENT_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore
  }
};

type ForceLogoutDetail = {
  reason: string;
  authCode?: string;
};

let _lastForceLogoutAt = 0;

const dispatchForceLogout = (reason: string, meta?: { authCode?: string }) => {
  if (typeof window === 'undefined') return;
  // Debounce: multiple concurrent API calls can all observe TOKEN_* and trigger logout.
  const now = Date.now();
  if (now - _lastForceLogoutAt < 1500) return;
  _lastForceLogoutAt = now;
  try {
    const detail: ForceLogoutDetail = { reason, ...(meta?.authCode ? { authCode: meta.authCode } : {}) };
    window.dispatchEvent(new CustomEvent(AUTH_EVENT_NAME, { detail }));
  } catch {
    // ignore
  }
};

const handleIncomingAuthEvent = (payload: AuthTabEvent | null) => {
  if (!payload || payload.type !== 'LOGIN') return;
  if (isShadowSessionMode()) return;
  if (isMultiSessionExemptEmail(getAuthEmail())) return;
  const tabId = getOrCreateTabId();
  const localSessionId = getSessionId();
  if (payload.tabId === tabId && localSessionId === payload.sessionId) return;

  const localUserId = getAuthUserId();
  const payloadUserId = typeof payload.userId === 'string' ? payload.userId : null;
  const localEmail = String(getAuthEmail() || '').trim().toLowerCase();
  const payloadEmail =
    typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  const matchesByUserId =
    Boolean(localUserId) && Boolean(payloadUserId) && localUserId === payloadUserId;
  const matchesByEmail =
    Boolean(localEmail) && Boolean(payloadEmail) && localEmail === payloadEmail;
  // Scope cross-tab enforcement to the same account only.
  if (!matchesByUserId && !matchesByEmail) {
    return;
  }

  if (!localSessionId || localSessionId === payload.sessionId) return;

  // Another tab completed a login; force-logout this tab (without touching other tabs).
  clearAuthToken();
  clearSessionId();
  dispatchForceLogout('another_tab_login');
};

if (typeof window !== 'undefined') {
  // Enforce tab-scoped auth by clearing any legacy localStorage token left by older builds.
  try {
    localStorage.removeItem('auth_token');
  } catch {
    // ignore
  }

  // Ensure tab/session ids exist for already-authenticated tabs (e.g., after deploy refresh).
  try {
    const existingToken = sessionStorage.getItem('auth_token');
    if (existingToken && existingToken.trim() && !getSessionId()) {
      setSessionId(_randomId());
    }
    if (existingToken && existingToken.trim()) {
      const existingMode = sessionStorage.getItem(AUTH_MODE_KEY);
      if (existingMode !== 'shadow' && existingMode !== 'standard') {
        setAuthMode('standard');
      }
    }
    const startedAtRaw = sessionStorage.getItem(AUTH_SESSION_STARTED_AT_KEY);
    const startedAt = startedAtRaw ? Number(startedAtRaw) : NaN;
    if (existingToken && existingToken.trim() && !Number.isFinite(startedAt)) {
      setSessionStartedAt(Date.now());
    }
  } catch {
    // ignore
  }

  // BroadcastChannel listener
  try {
    if ('BroadcastChannel' in window) {
      const channel = new (window as any).BroadcastChannel('peppro-auth');
      channel.addEventListener('message', (event: any) => {
        try {
          handleIncomingAuthEvent(event?.data as AuthTabEvent);
        } catch {
          // ignore
        }
      });
    }
  } catch {
    // ignore
  }

  // localStorage listener fallback
  try {
    window.addEventListener('storage', (event: StorageEvent) => {
      if (event.key !== AUTH_EVENT_STORAGE_KEY || !event.newValue) return;
      try {
        handleIncomingAuthEvent(JSON.parse(event.newValue) as AuthTabEvent);
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }
}

// Helper function to get auth token (tab-scoped: sessionStorage only)
const getAuthToken = () => {
  try {
    const sessionToken = sessionStorage.getItem('auth_token');
    if (sessionToken && sessionToken.trim().length > 0) {
      return sessionToken;
    }
  } catch {
    // sessionStorage may be unavailable (SSR / private mode)
  }
  return null;
};

const persistAuthToken = (
  token: string,
  options?: { mode?: AuthSessionMode; suppressBroadcast?: boolean },
) => {
  if (!token) return;
  const mode = options?.mode === 'shadow' ? 'shadow' : 'standard';
  try {
    sessionStorage.setItem('auth_token', token);
  } catch {
    // Ignore sessionStorage errors (Safari private mode, etc.)
  }
  setAuthMode(mode);

  // Prefer scoping to account id so other accounts can remain signed in in other tabs.
  // Callers should set `peppro_user_id_v1` (via `setAuthUserId`) before persisting the token.

  if (mode === 'shadow' || options?.suppressBroadcast === true) {
    if (!getSessionId()) {
      setSessionId(_randomId());
    }
    setSessionStartedAt(Date.now());
    return;
  }

  if (isMultiSessionExemptEmail(getAuthEmail())) {
    if (!getSessionId()) {
      setSessionId(_randomId());
    }
    setSessionStartedAt(Date.now());
    return;
  }

  const sessionId = _randomId();
  setSessionId(sessionId);
  setSessionStartedAt(Date.now());
  emitAuthEvent({
    type: 'LOGIN',
    tabId: getOrCreateTabId(),
    sessionId,
    userId: getAuthUserId(),
    email: getAuthEmail(),
    at: Date.now(),
  });
};

const clearAuthToken = () => {
  abortAuthenticatedRequests();
  try {
    localStorage.removeItem('auth_token');
  } catch {
    // ignore
  }
  try {
    sessionStorage.removeItem('auth_token');
  } catch {
    // ignore storage errors
  }
  try {
    sessionStorage.removeItem(AUTH_USER_ID_KEY);
  } catch {
    // ignore
  }
  try {
    sessionStorage.removeItem(AUTH_EMAIL_KEY);
  } catch {
    // ignore
  }
  try {
    sessionStorage.removeItem(AUTH_MODE_KEY);
  } catch {
    // ignore
  }
  clearSessionStartedAt();
};

const isShadowReadOnlyPath = (url: string) => {
  const normalized = String(url || '').toLowerCase();
  return normalized.endsWith('/api/auth/logout') || normalized.includes('/api/auth/logout?');
};

const throwShadowReadOnly = (): never => {
  const error = new Error(SHADOW_READ_ONLY_MESSAGE);
  (error as any).status = 403;
  (error as any).code = SHADOW_READ_ONLY_CODE;
  throw error;
};

export const isShadowReadOnlyError = (error: unknown) =>
  Boolean(error && typeof error === 'object' && (error as any).code === SHADOW_READ_ONLY_CODE);

const throwLocalAuthRequired = (authCode: string = 'TOKEN_REQUIRED'): never => {
  clearAuthToken();
  clearSessionId();
  const error = new Error('Access token required');
  (error as any).status = 401;
  (error as any).code = 'AUTH_REQUIRED';
  (error as any).authCode = authCode;
  throw error;
};

const dispatchApiReachability = (payload: { ok: boolean; status?: number | null; message?: string | null }) => {
  try {
    if (typeof window === 'undefined') return;
    const detail = {
      ok: Boolean(payload.ok),
      status: typeof payload.status === 'number' ? payload.status : null,
      message: typeof payload.message === 'string' ? payload.message : null,
      at: Date.now(),
      backgroundCooldownRemainingMs: getApiBackgroundCooldownRemainingMs(),
    };
    window.dispatchEvent(new CustomEvent('peppro:api-reachability', { detail }));
  } catch {
    // ignore
  }
};

const _PEPPRO_BACKGROUND_COOLDOWN_MIN_MS = 15_000;
const _PEPPRO_BACKGROUND_COOLDOWN_BASE_MS = 30_000;
const _PEPPRO_BACKGROUND_COOLDOWN_MAX_MS = 5 * 60 * 1000;

let _backgroundApiCooldownUntil = 0;
let _backgroundApiCooldownFailures = 0;

const clampBackgroundCooldownMs = (value: number) =>
  Math.max(
    _PEPPRO_BACKGROUND_COOLDOWN_MIN_MS,
    Math.min(_PEPPRO_BACKGROUND_COOLDOWN_MAX_MS, Math.floor(value)),
  );

const parseRetryAfterMs = (value?: string | null) => {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const seconds = Number.parseFloat(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return clampBackgroundCooldownMs(seconds * 1000);
  }
  const targetAt = Date.parse(trimmed);
  if (!Number.isFinite(targetAt)) {
    return null;
  }
  return clampBackgroundCooldownMs(Math.max(0, targetAt - Date.now()));
};

const resolveBackgroundCooldownMs = (payload?: {
  status?: number | null;
  retryAfterMs?: number | null;
}) => {
  if (typeof payload?.retryAfterMs === 'number' && Number.isFinite(payload.retryAfterMs)) {
    return clampBackgroundCooldownMs(payload.retryAfterMs);
  }
  const attempt = Math.min(6, Math.max(1, _backgroundApiCooldownFailures + 1));
  const baseMs = payload?.status === 429 ? _PEPPRO_BACKGROUND_COOLDOWN_BASE_MS : 12_000;
  return clampBackgroundCooldownMs(baseMs * Math.pow(2, attempt - 1));
};

export const getApiBackgroundCooldownRemainingMs = () =>
  Math.max(0, _backgroundApiCooldownUntil - Date.now());

export const isApiBackgroundCooldownActive = () =>
  getApiBackgroundCooldownRemainingMs() > 0;

export const noteApiBackgroundThrottle = (payload?: {
  status?: number | null;
  retryAfterMs?: number | null;
  message?: string | null;
}) => {
  const cooldownMs = resolveBackgroundCooldownMs(payload);
  _backgroundApiCooldownFailures = Math.min(8, _backgroundApiCooldownFailures + 1);
  _backgroundApiCooldownUntil = Math.max(_backgroundApiCooldownUntil, Date.now() + cooldownMs);
  dispatchApiReachability({
    ok: false,
    status: typeof payload?.status === 'number' ? payload.status : null,
    message: typeof payload?.message === 'string' ? payload.message : null,
  });
  return cooldownMs;
};

const maybeResetBackgroundCooldown = () => {
  if (Date.now() < _backgroundApiCooldownUntil) {
    return;
  }
  _backgroundApiCooldownUntil = 0;
  _backgroundApiCooldownFailures = 0;
};

const buildBackgroundCooldownError = () => {
  const remainingMs = getApiBackgroundCooldownRemainingMs();
  const error = new Error('Background requests paused while the API recovers.');
  (error as any).status = 429;
  (error as any).code = 'BACKGROUND_COOLDOWN_ACTIVE';
  (error as any).retryAfterMs = remainingMs;
  return error;
};

const _PEPPRO_DEFAULT_TIMEOUT_MS = 15000;
const _PEPPRO_AUTH_TIMEOUT_MS = 12000;
const _PEPPRO_HEALTH_TIMEOUT_MS = 5000;
const _PEPPRO_HEALTH_SUCCESS_TTL_MS = 15000;
const _PEPPRO_HEALTH_FAILURE_COOLDOWN_MS = 45000;
const _PEPPRO_LONGPOLL_TIMEOUT_MS = 30000;
const _PEPPRO_CHECKOUT_TIMEOUT_MS = 45000;
const _PEPPRO_SALES_TRACKING_TIMEOUT_MS = 45000;
const _PEPPRO_SALES_SUMMARY_TIMEOUT_MS = 90000;
const _PEPPRO_MODAL_TIMEOUT_MS = 30000;
const _PEPPRO_REFERRAL_TIMEOUT_MS = 30000;
const _PEPPRO_MAINTENANCE_TIMEOUT_MS = 30000;
const _PEPPRO_QUOTE_EXPORT_TIMEOUT_MS = 90000;

const _timeoutMsForRequest = (url: string, method: string) => {
  const normalized = String(url || '').toLowerCase();
  if (normalized.includes('/api/health')) return _PEPPRO_HEALTH_TIMEOUT_MS;
  if (normalized.includes('/api/auth/shadow-sessions')) return _PEPPRO_MAINTENANCE_TIMEOUT_MS;
  if (normalized.includes('/api/auth/')) return _PEPPRO_AUTH_TIMEOUT_MS;
  if (normalized.includes('/longpoll')) return _PEPPRO_LONGPOLL_TIMEOUT_MS;
  if (normalized.includes('/api/settings/users')) return _PEPPRO_MODAL_TIMEOUT_MS;
  if (normalized.includes('/api/orders/sales-rep/users/') && normalized.includes('/modal-detail')) {
    return _PEPPRO_MODAL_TIMEOUT_MS;
  }
  if (normalized.includes('/api/orders/admin/taxes-by-state')) {
    return _PEPPRO_SALES_TRACKING_TIMEOUT_MS;
  }
  if (normalized.includes('/api/orders/sales-rep-summary')) {
    return _PEPPRO_SALES_SUMMARY_TIMEOUT_MS;
  }
  if (normalized.includes('/api/referrals/dashboard')) return _PEPPRO_REFERRAL_TIMEOUT_MS;
  if (method === 'GET' && normalized.includes('/api/referrals/sales-prospects/') && normalized.includes('/quotes/') && normalized.includes('/export')) {
    return _PEPPRO_QUOTE_EXPORT_TIMEOUT_MS;
  }
  if (method === 'GET' && normalized.includes('/api/orders/sales-rep')) {
    return _PEPPRO_SALES_TRACKING_TIMEOUT_MS;
  }
  // Order placement can be slower because it may sync with WooCommerce.
  if (method === 'POST' && (normalized.endsWith('/api/orders') || normalized.includes('/api/orders/'))) {
    return _PEPPRO_CHECKOUT_TIMEOUT_MS;
  }
  if (method === 'GET') return _PEPPRO_DEFAULT_TIMEOUT_MS;
  return _PEPPRO_DEFAULT_TIMEOUT_MS;
};

const isNetworkLikeFetchError = (error: any) => {
  const name = String(error?.name || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  if (name === 'aborterror') return false;
  return (
    name === 'typeerror'
    || message.includes('fetch api cannot load')
    || message.includes('failed to fetch')
    || message.includes('load failed')
    || message.includes('networkerror')
    || message.includes('fetch failed')
    || message.includes('access-control-allow-origin')
    || message.includes('origin https://')
  );
};

const _fetchWithTimeout = async (url: string, init: RequestInit, timeoutMs: number) => {
  if (typeof window === 'undefined' || timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    return fetch(url, init);
  }
  const controller = new AbortController();
  const existingSignal = init.signal;
  if (existingSignal) {
    if (existingSignal.aborted) controller.abort();
    else existingSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
  }
};

const _inflightGetRequests = new Map<string, Promise<any>>();

const buildAuthAbortError = () => {
  const error = new Error('Authentication ended');
  (error as any).status = 401;
  (error as any).code = 'AUTH_REQUIRED';
  (error as any).authCode = 'TOKEN_ABORTED';
  return error;
};

const buildStaleAuthAbortError = () => {
  try {
    return new DOMException('Authentication no longer applies to this request', 'AbortError');
  } catch {
    const error = new Error('Authentication no longer applies to this request');
    error.name = 'AbortError';
    return error;
  }
};

const isCurrentAuthSnapshot = (
  requestToken: string | null,
  requestSessionId: string | null,
) => {
  if (!requestToken) {
    return false;
  }
  const currentToken = getAuthToken();
  if (!currentToken || currentToken !== requestToken) {
    return false;
  }
  if (requestSessionId) {
    const currentSessionId = getSessionId();
    if (!currentSessionId || currentSessionId !== requestSessionId) {
      return false;
    }
  }
  return true;
};

const rewriteBlockedAdminPaths = (url: string) => {
  return String(url || '').replace(/\/orders\/admin\/on-hold(?=[/?#]|$)/i, '/orders/on-hold');
};

const buildSameOriginApiFallbackUrl = (url: string) => {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const parsed = new URL(String(url || ''), window.location.origin);
    const currentOrigin = window.location.origin;
    const currentHost = window.location.hostname.toLowerCase();
    const targetHost = parsed.hostname.toLowerCase();
    if (parsed.origin === currentOrigin) {
      return null;
    }
    if (!parsed.pathname.toLowerCase().startsWith('/api/')) {
      return null;
    }
    // Auth on `peppro.net/api` is not the same backend as `api.peppro.net/api`.
    // Keep auth requests pinned to the configured API origin so login/account checks
    // always hit the authoritative auth service.
    if (parsed.pathname.toLowerCase().startsWith('/api/auth/')) {
      return null;
    }
    const isPepProPrimaryHost = currentHost === 'peppro.net' || currentHost === 'www.peppro.net';
    const isPepProApiHost = targetHost === 'api.peppro.net';
    if (!isPepProPrimaryHost || !isPepProApiHost) {
      return null;
    }
    return `${currentOrigin}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
};

// Helper function to make authenticated requests
const fetchWithAuth = async (url: string, options: AuthenticatedRequestInit = {}) => {
  const rewrittenUrl = rewriteBlockedAdminPaths(url);
  const {
    background = false,
    skipReachabilityDispatch = false,
    preserveAuthOnAuthFailure = false,
    ...requestOptions
  } = options;
  const token = getAuthToken();
  const sessionIdAtRequestStart = getSessionId();
  const method = (requestOptions.method || 'GET').toUpperCase();
  if (isShadowSessionMode() && method !== 'GET' && method !== 'HEAD' && !isShadowReadOnlyPath(rewrittenUrl)) {
    throwShadowReadOnly();
  }
  const headers: Record<string, string> = {
    ...((requestOptions.headers as any) || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const hasBody = method !== 'GET' && method !== 'HEAD' && requestOptions.body != null;
  const isFormDataBody = typeof FormData !== 'undefined' && requestOptions.body instanceof FormData;
  if (hasBody && !isFormDataBody && headers['Content-Type'] == null) {
    headers['Content-Type'] = 'application/json';
  }

  const run = async () => {
    maybeResetBackgroundCooldown();
    if (background && isApiBackgroundCooldownActive()) {
      throw buildBackgroundCooldownError();
    }

    let requestUrl = rewrittenUrl;

    if (method === 'GET' && !(requestOptions.cache && requestOptions.cache !== 'default')) {
      const normalized = requestUrl.toLowerCase();
      const shouldAddTs =
        !normalized.includes('/longpoll')
        && !/[?&]_ts=/.test(normalized)
        && !/[?&]etag=/.test(normalized)
        && !/[?&]timeoutms=/.test(normalized);
      if (shouldAddTs) {
        const separator = requestUrl.includes('?') ? '&' : '?';
        requestUrl = `${requestUrl}${separator}_ts=${Date.now()}`;
      }
    }

    let response: Response;
    const authenticatedSignal = token
      ? createAuthenticatedRequestSignal(requestOptions.signal)
      : null;
    const requestInit: RequestInit = {
      cache: requestOptions.cache ?? 'no-store',
      ...requestOptions,
      signal: authenticatedSignal?.signal ?? requestOptions.signal,
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        ...headers,
      },
    };
    const timeoutMs = _timeoutMsForRequest(requestUrl, method);
    try {
      response = await _fetchWithTimeout(requestUrl, requestInit, timeoutMs);
    } catch (error: any) {
      if (authenticatedSignal?.signal.aborted) {
        throw isCurrentAuthSnapshot(token, sessionIdAtRequestStart)
          ? buildAuthAbortError()
          : buildStaleAuthAbortError();
      }
      const fallbackUrl =
        !background && isNetworkLikeFetchError(error)
          ? buildSameOriginApiFallbackUrl(requestUrl)
          : null;
      if (fallbackUrl && fallbackUrl !== requestUrl) {
        try {
          requestUrl = fallbackUrl;
          response = await _fetchWithTimeout(requestUrl, requestInit, timeoutMs);
        } catch (retryError: any) {
          error = retryError;
        }
      }
      if (typeof response !== 'undefined') {
        // The same-origin retry recovered the request; continue with normal handling below.
      } else {
        const isAbort = error?.name === 'AbortError';
        const message = isAbort ? 'Request timed out' : (typeof error?.message === 'string' ? error.message : null);
        if (
          background &&
          !isAbort &&
          isNetworkLikeFetchError(error)
        ) {
          noteApiBackgroundThrottle({ message });
        }
        if (!skipReachabilityDispatch) {
          dispatchApiReachability({ ok: false, status: null, message });
        }
        if (isAbort) {
          const wrapped = new Error('Request timed out');
          (wrapped as any).code = 'TIMEOUT';
          (wrapped as any).status = null;
          throw wrapped;
        }
        throw error;
      }
    } finally {
      authenticatedSignal?.cleanup();
    }

    if (response.status === 429) {
      noteApiBackgroundThrottle({
        status: 429,
        retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
      });
    } else if (response.status >= 500) {
      noteApiBackgroundThrottle({ status: response.status });
    } else if (response.ok) {
      maybeResetBackgroundCooldown();
    }

    if (!skipReachabilityDispatch && response.ok) {
      dispatchApiReachability({ ok: true, status: response.status });
    } else if (!skipReachabilityDispatch && (response.status >= 500 || response.status === 429)) {
      dispatchApiReachability({ ok: false, status: response.status });
    }

    if (!response.ok) {
      const contentType = response.headers.get('content-type') || '';
      let errorMessage = `Request failed (${response.status})`;
      let errorDetails: Record<string, unknown> | string | null = null;

      let htmlLikePayload = false;
      try {
        if (contentType.includes('application/json')) {
          errorDetails = await response.json();
          if (errorDetails && typeof errorDetails === 'object' && 'error' in errorDetails) {
            const candidate = (errorDetails as Record<string, unknown>).error;
            if (typeof candidate === 'string' && candidate.trim().length > 0) {
              errorMessage = candidate;
            }
          }
        } else {
          errorDetails = await response.text();
          if (typeof errorDetails === 'string' && errorDetails.trim().length > 0) {
            const trimmed = errorDetails.trim();
            htmlLikePayload = trimmed.startsWith('<') || trimmed.includes('<html');
            errorMessage = `${errorMessage}: ${trimmed}`;
          }
        }
      } catch (parseError) {
        errorDetails = { parseError: parseError instanceof Error ? parseError.message : String(parseError) };
      }

      if (htmlLikePayload) {
        const normalizedUrl = rewrittenUrl.toLowerCase();
        if (normalizedUrl.includes('/shipping/')) {
          errorMessage = 'Address cannot be identified.';
        } else {
          errorMessage = `Request failed (${response.status}). Please try again in a moment.`;
        }
      }

      errorMessage = sanitizeServiceNames(errorMessage);
      if (typeof errorDetails === 'string') {
        errorDetails = sanitizeServiceNames(errorDetails);
      } else if (errorDetails && typeof errorDetails === 'object') {
        sanitizePayloadMessages(errorDetails as any);
      }

      const error = new Error(errorMessage);
      (error as any).status = response.status;
      (error as any).details = errorDetails;
      const codeField = typeof errorDetails === 'object' && errorDetails !== null
        ? (errorDetails as any).code
        : null;
      if (typeof codeField === 'string' && codeField.trim().length > 0) {
        (error as any).code = codeField;
      }
      const isAuthError = response.status === 401
        || (response.status === 403 && typeof codeField === 'string' && codeField.startsWith('TOKEN_'));
      if (isAuthError) {
        if (!isCurrentAuthSnapshot(token, sessionIdAtRequestStart)) {
          throw buildStaleAuthAbortError();
        }
        if (preserveAuthOnAuthFailure) {
          (error as any).code = AUTH_CHECK_FAILED_CODE;
          if (typeof codeField === 'string') {
            (error as any).authCode = codeField;
          }
          throw error;
        }
        clearAuthToken();
        clearSessionId();
        // Only broadcast a logout if this tab *thought* it was authenticated.
        // Otherwise (e.g., calling /auth/logout without a token) we'd recurse.
        if (token) {
          const authCode = typeof codeField === 'string' ? codeField : undefined;
          const reason = authCode === 'TOKEN_REVOKED' ? 'token_revoked' : 'auth_revoked';
          dispatchForceLogout(reason, { authCode });
        }
        (error as any).code = 'AUTH_REQUIRED';
        if (typeof codeField === 'string') {
          (error as any).authCode = codeField;
        }
      } else if (response.status === 403) {
        (error as any).code = 'FORBIDDEN';
      }
      throw error;
    }

    if (response.status === 204 || response.status === 205) {
      return null;
    }

    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      const text = await response.text();
      if (!text) {
        return null;
      }
      try {
        const parsed = JSON.parse(text);
        return normalizeGreaterAreaFields(sanitizePayloadMessages(parsed));
      } catch (error) {
        console.warn('[fetchWithAuth] Failed to parse JSON response', { error });
        return sanitizeServiceNames(text);
      }
    }

    return response.text();
  };

  const dedupeKey = method === 'GET' && !options.signal ? `${token || ''}|${rewrittenUrl}` : null;
  if (!dedupeKey) {
    return run();
  }

  const existing = _inflightGetRequests.get(dedupeKey);
  if (existing) return existing;

  const promise = run();
  _inflightGetRequests.set(dedupeKey, promise);
  void promise.then(
    () => {
      if (_inflightGetRequests.get(dedupeKey) === promise) {
        _inflightGetRequests.delete(dedupeKey);
      }
    },
    () => {
      if (_inflightGetRequests.get(dedupeKey) === promise) {
        _inflightGetRequests.delete(dedupeKey);
      }
    },
  );
  return promise;
};

let _healthCheckInFlight: Promise<boolean> | null = null;
let _healthCheckLastAt = 0;
let _healthCheckLastOk = false;

const buildServiceUnavailableError = (message: string) => {
  const error = new Error(message);
  (error as any).status = 503;
  (error as any).code = 'SERVICE_UNAVAILABLE';
  return error;
};

const fetchWithAuthForm = async (url: string, options: RequestInit = {}) => {
  let requestUrl = rewriteBlockedAdminPaths(url);
  const token = getAuthToken();
  const sessionIdAtRequestStart = getSessionId();
  const headers: HeadersInit = {
    ...(options.headers || {}),
  };
  const method = (options.method || 'GET').toUpperCase();
  if (isShadowSessionMode() && method !== 'GET' && method !== 'HEAD' && !isShadowReadOnlyPath(requestUrl)) {
    throwShadowReadOnly();
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let response: Response;
  const authenticatedSignal = token
    ? createAuthenticatedRequestSignal(options.signal)
    : null;
  const requestInit: RequestInit = {
    cache: options.cache ?? 'no-store',
    ...options,
    signal: authenticatedSignal?.signal ?? options.signal,
    headers: {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      ...headers,
    },
  };
  const timeoutMs = _timeoutMsForRequest(requestUrl, method);
  try {
    response = await _fetchWithTimeout(requestUrl, requestInit, timeoutMs);
  } catch (error: any) {
    if (authenticatedSignal?.signal.aborted) {
      throw isCurrentAuthSnapshot(token, sessionIdAtRequestStart)
        ? buildAuthAbortError()
        : buildStaleAuthAbortError();
    }
    const fallbackUrl = isNetworkLikeFetchError(error)
      ? buildSameOriginApiFallbackUrl(requestUrl)
      : null;
    if (fallbackUrl && fallbackUrl !== requestUrl) {
      try {
        requestUrl = fallbackUrl;
        response = await _fetchWithTimeout(requestUrl, requestInit, timeoutMs);
      } catch (retryError: any) {
        error = retryError;
      }
    }
    if (typeof response === 'undefined') {
      const isAbort = error?.name === 'AbortError';
      const message = isAbort ? 'Request timed out' : (typeof error?.message === 'string' ? error.message : null);
      dispatchApiReachability({ ok: false, status: null, message });
      if (isAbort) {
        const wrapped = new Error('Request timed out');
        (wrapped as any).code = 'TIMEOUT';
        (wrapped as any).status = null;
        throw wrapped;
      }
      throw error;
    }
  } finally {
    authenticatedSignal?.cleanup();
  }

  if (response.ok) {
    dispatchApiReachability({ ok: true, status: response.status });
  } else if (response.status >= 500 || response.status === 429) {
    dispatchApiReachability({ ok: false, status: response.status });
  }

  if (!response.ok) {
    const contentType = response.headers.get('content-type') || '';
    let errorMessage = `Request failed (${response.status})`;
    let errorDetails: Record<string, unknown> | string | null = null;
    let htmlLikePayload = false;

    try {
      if (contentType.includes('application/json')) {
        errorDetails = await response.json();
        if (errorDetails && typeof errorDetails === 'object' && 'error' in errorDetails) {
          const candidate = (errorDetails as Record<string, unknown>).error;
          if (typeof candidate === 'string' && candidate.trim().length > 0) {
            errorMessage = candidate;
          }
        }
      } else {
        errorDetails = await response.text();
        if (typeof errorDetails === 'string' && errorDetails.trim().length > 0) {
          const trimmed = errorDetails.trim();
          htmlLikePayload = trimmed.startsWith('<') || trimmed.includes('<html');
          errorMessage = `${errorMessage}: ${trimmed}`;
        }
      }
    } catch (parseError) {
      errorDetails = { parseError: parseError instanceof Error ? parseError.message : String(parseError) };
    }

    if (htmlLikePayload) {
      if (response.status === 413) {
        errorMessage = 'Upload too large. Your server rejected the request (413).';
      } else {
        errorMessage = `Request failed (${response.status}). Please try again in a moment.`;
      }
    }

    errorMessage = sanitizeServiceNames(errorMessage);
    if (typeof errorDetails === 'string') {
      errorDetails = sanitizeServiceNames(errorDetails);
    } else if (errorDetails && typeof errorDetails === 'object') {
      sanitizePayloadMessages(errorDetails as any);
    }

    const error = new Error(errorMessage);
    (error as any).status = response.status;
    (error as any).details = errorDetails;
    const codeField = typeof errorDetails === 'object' && errorDetails !== null
      ? (errorDetails as any).code
      : null;
    if (typeof codeField === 'string' && codeField.trim().length > 0) {
      (error as any).code = codeField;
    }
    const isAuthError = response.status === 401
      || (response.status === 403 && typeof codeField === 'string' && codeField.startsWith('TOKEN_'));
    if (isAuthError) {
      if (!isCurrentAuthSnapshot(token, sessionIdAtRequestStart)) {
        throw buildStaleAuthAbortError();
      }
      clearAuthToken();
      clearSessionId();
      if (token) {
        const authCode = typeof codeField === 'string' ? codeField : undefined;
        const reason = authCode === 'TOKEN_REVOKED' ? 'token_revoked' : 'auth_revoked';
        dispatchForceLogout(reason, { authCode });
      }
      (error as any).code = 'AUTH_REQUIRED';
      if (typeof codeField === 'string') {
        (error as any).authCode = codeField;
      }
    } else if (response.status === 403) {
      (error as any).code = 'FORBIDDEN';
    }
    throw error;
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const text = await response.text();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      return normalizeGreaterAreaFields(sanitizePayloadMessages(parsed));
    } catch {
      return sanitizeServiceNames(text);
    }
  }
  return response.text();
};

const fetchWithAuthBlob = async (url: string, options: RequestInit & { skipAuth?: boolean } = {}) => {
  const requestUrl = rewriteBlockedAdminPaths(url);
  const token = options.skipAuth ? null : getAuthToken();
  const sessionIdAtRequestStart = options.skipAuth ? null : getSessionId();
  const headers: HeadersInit = {
    ...(options.headers || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let response: Response;
  const method = (options.method || 'GET').toUpperCase();
  const authenticatedSignal = token
    ? createAuthenticatedRequestSignal(options.signal)
    : null;
  try {
    response = await _fetchWithTimeout(requestUrl, {
      cache: options.cache ?? 'no-store',
      ...options,
      signal: authenticatedSignal?.signal ?? options.signal,
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        ...headers,
      },
    }, _timeoutMsForRequest(requestUrl, method));
  } catch (error: any) {
    if (authenticatedSignal?.signal.aborted) {
      throw isCurrentAuthSnapshot(token, sessionIdAtRequestStart)
        ? buildAuthAbortError()
        : buildStaleAuthAbortError();
    }
    const isAbort = error?.name === 'AbortError';
    const message = isAbort ? 'Request timed out' : (typeof error?.message === 'string' ? error.message : null);
    dispatchApiReachability({ ok: false, status: null, message });
    if (isAbort) {
      const wrapped = new Error('Request timed out');
      (wrapped as any).code = 'TIMEOUT';
      (wrapped as any).status = null;
      throw wrapped;
    }
    throw error;
  } finally {
    authenticatedSignal?.cleanup();
  }

  if (response.ok) {
    dispatchApiReachability({ ok: true, status: response.status });
  } else if (response.status >= 500 || response.status === 429) {
    dispatchApiReachability({ ok: false, status: response.status });
  }

  if (!response.ok) {
    const contentType = response.headers.get('content-type') || '';
    let errorMessage = `Request failed (${response.status})`;
    let errorDetails: Record<string, unknown> | string | null = null;

    try {
      if (contentType.includes('application/json')) {
        errorDetails = await response.json();
        if (errorDetails && typeof errorDetails === 'object' && 'error' in errorDetails) {
          const candidate = (errorDetails as Record<string, unknown>).error;
          if (typeof candidate === 'string' && candidate.trim().length > 0) {
            errorMessage = candidate;
          }
        }
      } else {
        errorDetails = await response.text();
      }
    } catch (parseError) {
      errorDetails = { parseError: parseError instanceof Error ? parseError.message : String(parseError) };
    }

    errorMessage = sanitizeServiceNames(errorMessage);
    if (typeof errorDetails === 'string') {
      errorDetails = sanitizeServiceNames(errorDetails);
    } else if (errorDetails && typeof errorDetails === 'object') {
      sanitizePayloadMessages(errorDetails as any);
    }

    const error = new Error(errorMessage);
    (error as any).status = response.status;
    (error as any).details = errorDetails;
    const codeField = typeof errorDetails === 'object' && errorDetails !== null
      ? (errorDetails as any).code
      : null;
    if (typeof codeField === 'string' && codeField.trim().length > 0) {
      (error as any).code = codeField;
    }
    const isAuthError = response.status === 401
      || (response.status === 403 && typeof codeField === 'string' && codeField.startsWith('TOKEN_'));
    if (isAuthError) {
      if (!isCurrentAuthSnapshot(token, sessionIdAtRequestStart)) {
        throw buildStaleAuthAbortError();
      }
      clearAuthToken();
      clearSessionId();
      if (token) {
        const authCode = typeof codeField === 'string' ? codeField : undefined;
        const reason = authCode === 'TOKEN_REVOKED' ? 'token_revoked' : 'auth_revoked';
        dispatchForceLogout(reason, { authCode });
      }
      (error as any).code = 'AUTH_REQUIRED';
      if (typeof codeField === 'string') {
        (error as any).authCode = codeField;
      }
    } else if (response.status === 403) {
      (error as any).code = 'FORBIDDEN';
    }
    throw error;
  }

  const contentDisposition = response.headers.get('content-disposition') || '';
  const filenameMatch = contentDisposition.match(/filename=\"?([^\";]+)\"?/i);
  const filename = filenameMatch && filenameMatch[1] ? filenameMatch[1] : null;
  const debugHeaderNames = [
    'server-timing',
    'x-peppro-quote-export-ms',
    'x-peppro-quote-pdf-ms',
    'x-peppro-quote-render-ms',
    'x-peppro-quote-image-ms',
    'x-peppro-quote-renderer',
    'x-peppro-quote-cache',
    'x-peppro-quote-pdf-bytes',
    'x-peppro-quote-id',
  ];
  const debugHeaders: Record<string, string> = {};
  for (const headerName of debugHeaderNames) {
    const value = response.headers.get(headerName);
    if (typeof value === 'string' && value.trim()) {
      debugHeaders[headerName] = value.trim();
    }
  }
  const blobStartedAt = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
  const blob = await response.blob();
  const blobReadMs = (typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()) - blobStartedAt;
  return {
    blob,
    filename,
    contentType: response.headers.get('content-type') || '',
    debugHeaders,
    blobReadMs: Number(blobReadMs.toFixed(1)),
  };
};

export type UpdateProfilePayload = {
  name?: string;
  email?: string;
  phone?: string;
  profileImageUrl?: string | null;
  profileOnboarding?: boolean;
  resellerPermitOnboardingPresented?: boolean;
  isTaxExempt?: boolean;
  taxExemptSource?: string | null;
  taxExemptReason?: string | null;
  resellerPermitFilePath?: string | null;
  resellerPermitFileName?: string | null;
  resellerPermitUploadedAt?: string | null;
  greaterArea?: string | null;
  studyFocus?: string | null;
  bio?: string | null;
  networkPresenceAgreement?: boolean;
  delegateLogoUrl?: string | null;
  delegateSecondaryColor?: string | null;
  officeAddressLine1?: string | null;
  officeAddressLine2?: string | null;
  officeCity?: string | null;
  officeState?: string | null;
  officePostalCode?: string | null;
  receiveClientOrderUpdateEmails?: boolean;
  researchTermsAgreement?: boolean;
  delegateOptIn?: boolean;
};

export type PersistedCartItemPayload = {
  productId: string;
  productWooId?: number | null;
  variantId?: string | null;
  variantWooId?: number | null;
  quantity: number;
  note?: string | null;
};

// Auth API
export const authAPI = {
  register: async (input: {
    name: string;
    email: string;
    password: string;
    code: string;
    npiNumber?: string;
    phone?: string;
  }) => {
    const data = await fetchWithAuth(`${API_BASE_URL}/auth/register`, {
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({
        name: input.name,
        email: input.email,
        password: input.password,
        code: input.code,
        npiNumber: input.npiNumber,
        phone: input.phone ?? undefined,
      }),
    });

    setAuthUserId(data?.user?.id);
    setAuthEmail(data?.user?.email ?? input.email);
    persistAuthToken(data.token, { mode: 'standard' });
    return data.user;
  },

  verifyNpi: async (npiNumber: string) => {
    return fetchWithAuth(`${API_BASE_URL}/auth/verify-npi`, {
      method: 'POST',
      body: JSON.stringify({ npiNumber }),
    });
  },

  login: async (email: string, password: string) => {
    const data = await fetchWithAuth(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    });

    if (
      !data
      || typeof data !== 'object'
      || typeof (data as any).token !== 'string'
      || !(data as any).user
      || typeof (data as any).user !== 'object'
    ) {
      throw buildServiceUnavailableError('AUTH_LOGIN_INVALID_RESPONSE');
    }

    setAuthUserId(data?.user?.id);
    setAuthEmail(data?.user?.email ?? email);
    persistAuthToken(data.token, { mode: 'standard' });
    return data.user;
  },

  createShadowSession: async (targetUserId: string) => {
    if (!targetUserId) {
      throw new Error('targetUserId is required');
    }
    return fetchWithAuth(`${API_BASE_URL}/auth/shadow-sessions`, {
      method: 'POST',
      body: JSON.stringify({ targetUserId }),
    });
  },

  exchangeShadowSession: async (launchToken: string) => {
    if (!launchToken) {
      throw new Error('launchToken is required');
    }
    const data = await fetchWithAuth(`${API_BASE_URL}/auth/shadow-sessions/exchange`, {
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ launchToken }),
    });
    setAuthUserId(data?.user?.id);
    setAuthEmail(data?.user?.email ?? null);
    persistAuthToken(data?.token, { mode: 'shadow', suppressBroadcast: true });
    return data;
  },

  checkEmail: async (email: string) => {
    const data = await fetchWithAuth(
      `${API_BASE_URL}/auth/check-email?email=${encodeURIComponent(email)}`,
      {
        method: 'GET',
      },
    );
    if (
      !data
      || typeof data !== 'object'
      || typeof (data as any).exists !== 'boolean'
    ) {
      throw buildServiceUnavailableError('EMAIL_CHECK_INVALID_RESPONSE');
    }
    return data;
  },

  logout: () => {
    const token = getAuthToken();
    if (token) {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        };
        void fetch(`${API_BASE_URL}/auth/logout`, {
          method: 'POST',
          keepalive: true,
          credentials: 'include',
          headers,
          body: '{}',
        }).catch(() => null);
      } catch {
        // ignore
      }
    }
    clearAuthToken();
    clearSessionId();
  },
	  getCurrentUser: async (options?: { background?: boolean }) => {
      if (!getAuthToken()) {
        clearAuthToken();
        clearSessionId();
        setAuthUserId(null);
        setAuthEmail(null);
        return null;
      }
	    try {
	      const user = await fetchWithAuth(`${API_BASE_URL}/auth/me`, {
          method: 'GET',
          cache: 'no-store',
          credentials: 'include',
          background: options?.background === true,
          preserveAuthOnAuthFailure: options?.background === true,
        });
	      setAuthUserId((user as any)?.id);
	      setAuthEmail((user as any)?.email);
        setAuthMode((user as any)?.shadowContext?.active ? 'shadow' : 'standard');
	      return user;
	    } catch (error) {
      const maybeAny = error as any;
      const status = typeof maybeAny?.status === 'number' ? maybeAny.status : null;
      const code = typeof maybeAny?.code === 'string' ? maybeAny.code : null;
      const authCode = typeof maybeAny?.authCode === 'string' ? maybeAny.authCode : null;
      const isAuthFailure = code === 'AUTH_REQUIRED'
        || code === AUTH_CHECK_FAILED_CODE
        || status === 401
        || (status === 403 && typeof authCode === 'string' && authCode.startsWith('TOKEN_'));
      if (isAuthFailure) {
        if (options?.background === true) {
          throw error;
        }
        // Token already cleared by fetchWithAuth(); caller can treat null as "logged out".
        setAuthUserId(null);
        setAuthEmail(null);
        return null;
      }
      throw error;
    }
  },
  getCurrentSession: async (options?: { background?: boolean }) => {
      if (!getAuthToken()) {
        clearAuthToken();
        clearSessionId();
        setAuthUserId(null);
        setAuthEmail(null);
        return null;
      }
      try {
        const user = await fetchWithAuth(`${API_BASE_URL}/auth/session`, {
          method: 'GET',
          cache: 'no-store',
          credentials: 'include',
          background: options?.background === true,
          preserveAuthOnAuthFailure: options?.background === true,
        });
        setAuthUserId((user as any)?.id);
        setAuthEmail((user as any)?.email);
        setAuthMode((user as any)?.shadowContext?.active ? 'shadow' : 'standard');
        return user;
      } catch (error) {
      const maybeAny = error as any;
      const status = typeof maybeAny?.status === 'number' ? maybeAny.status : null;
      const code = typeof maybeAny?.code === 'string' ? maybeAny.code : null;
      const authCode = typeof maybeAny?.authCode === 'string' ? maybeAny.authCode : null;
      const isAuthFailure = code === 'AUTH_REQUIRED'
        || code === AUTH_CHECK_FAILED_CODE
        || status === 401
        || (status === 403 && typeof authCode === 'string' && authCode.startsWith('TOKEN_'));
      if (isAuthFailure) {
        if (options?.background === true) {
          throw error;
        }
        setAuthUserId(null);
        setAuthEmail(null);
        return null;
      }
      throw error;
    }
  },

  updateMe: async (payload: UpdateProfilePayload) => {
    const requestPayload: Record<string, unknown> = { ...payload };
    if (Object.prototype.hasOwnProperty.call(payload, 'greaterArea')) {
      requestPayload.greaterArea = normalizePhysicianGreaterArea(payload.greaterArea);
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'networkPresenceAgreement')) {
      requestPayload.network_presence_agreement = payload.networkPresenceAgreement;
    }
    return fetchWithAuth(`${API_BASE_URL}/auth/me`, {
      method: 'PUT',
      body: JSON.stringify(requestPayload),
    });
  },

  uploadResellerPermit: async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return fetchWithAuthForm(`${API_BASE_URL}/auth/me/reseller-permit`, {
      method: 'POST',
      body: formData,
    });
  },

  downloadResellerPermit: async () => {
    return fetchWithAuthBlob(`${API_BASE_URL}/auth/me/reseller-permit`, {
      method: 'GET',
    });
  },

  deleteResellerPermit: async () => {
    const isMethodFallbackError = (error: any) => {
      const status = typeof error?.status === 'number' ? error.status : null;
      const details = error?.details;
      const code = details && typeof details === 'object' ? (details as any).code : null;
      const message = typeof error?.message === 'string' ? error.message : '';
      return status === 405
        || status === 404
        || code === 'METHOD_NOT_ALLOWED'
        || /method[_\s-]?not[_\s-]?allowed/i.test(message);
    };

    try {
      return await fetchWithAuth(`${API_BASE_URL}/auth/me/reseller-permit/delete`, {
        method: 'POST',
        body: '{}',
      });
    } catch (error: any) {
      if (!isMethodFallbackError(error)) {
        throw error;
      }

      return fetchWithAuth(`${API_BASE_URL}/auth/me/reseller-permit`, {
        method: 'DELETE',
      });
    }
  },

  updateCart: async (cart: PersistedCartItemPayload[]) => {
    return fetchWithAuth(`${API_BASE_URL}/auth/me/cart`, {
      method: 'PUT',
      body: JSON.stringify({ cart }),
    });
  },

  deleteMe: async () => {
    const clearDeletedSession = () => {
      clearAuthToken();
      clearSessionId();
      setAuthUserId(null);
      setAuthEmail(null);
    };

    const isMethodFallbackError = (error: any) => {
      const status = typeof error?.status === 'number' ? error.status : null;
      const details = error?.details;
      const code = details && typeof details === 'object' ? (details as any).code : null;
      const message = typeof error?.message === 'string' ? error.message : '';
      return status === 405
        || status === 404
        || code === 'METHOD_NOT_ALLOWED'
        || /method[_\s-]?not[_\s-]?allowed/i.test(message);
    };

    try {
      const result = await fetchWithAuth(`${API_BASE_URL}/auth/me/delete`, {
        method: 'POST',
        body: '{}',
      });
      clearDeletedSession();
      return result;
    } catch (error: any) {
      if (!isMethodFallbackError(error)) {
        throw error;
      }

      const result = await fetchWithAuth(`${API_BASE_URL}/auth/me`, {
        method: 'DELETE',
      });
      clearDeletedSession();
      return result;
    }
  },

  passkeys: {
    getRegistrationOptions: async (): Promise<{
      requestId: string;
      publicKey: PublicKeyCredentialCreationOptionsJSON;
    }> => {
      return fetchWithAuth(`${API_BASE_URL}/auth/passkeys/register/options`, {
        method: 'POST',
      });
    },
    completeRegistration: async (payload: {
      requestId: string;
      attestationResponse: RegistrationResponseJSON;
      label?: string;
    }) => {
      return fetchWithAuth(`${API_BASE_URL}/auth/passkeys/register/verify`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
    getAuthenticationOptions: async (email?: string): Promise<{
      requestId: string;
      publicKey: PublicKeyCredentialRequestOptionsJSON;
    }> => {
      const response = await fetch(`${API_BASE_URL}/auth/passkeys/login/options`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email }),
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || 'PASSKEY_OPTIONS_FAILED');
      }
      return response.json();
    },
    completeAuthentication: async (payload: {
      requestId: string;
      assertionResponse: AuthenticationResponseJSON;
    }) => {
      const response = await fetch(`${API_BASE_URL}/auth/passkeys/login/verify`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || 'PASSKEY_AUTH_FAILED');
      }
      const data = await response.json();
      setAuthUserId(data?.user?.id);
      setAuthEmail(data?.user?.email);
      persistAuthToken(data.token, { mode: 'standard' });
      return data.user;
    },
  },
};

export const settingsAPI = {
  getShopStatus: async () => {
    return fetchWithAuth(`${API_BASE_URL}/settings/shop`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
  },
  getBetaServices: async () => {
    return fetchWithAuth(`${API_BASE_URL}/settings/beta-services`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
  },
  getPatientLinksStatus: async () => {
    return fetchWithAuth(`${API_BASE_URL}/settings/patient-links`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
  },
  getPatientLinksDoctors: async () => {
    return fetchWithAuth(`${API_BASE_URL}/settings/patient-links/doctors`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
  },
  getNetworkDoctors: async () => {
    return fetchWithAuth(`${API_BASE_URL}/settings/network/doctors`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
  },
  getCrmStatus: async () => {
    return fetchWithAuth(`${API_BASE_URL}/settings/crm`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
  },
  getForumStatus: async () => {
    return fetchWithAuth(`${API_BASE_URL}/settings/forum`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
  },
  getResearchStatus: async () => {
    return fetchWithAuth(`${API_BASE_URL}/settings/research`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
  },
  getPhysicianMapStatus: async () => {
    return fetchWithAuth(`${API_BASE_URL}/settings/physician-map`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
  },
  getTestPaymentsOverrideStatus: async () => {
    return fetchWithAuth(`${API_BASE_URL}/settings/test-payments-override`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
  },
  updateShopStatus: async (enabled: boolean) => {
    return fetchWithAuth(`${API_BASE_URL}/settings/shop`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
  },
  updateBetaServices: async (betaServices: Array<string>) => {
    return fetchWithAuth(`${API_BASE_URL}/settings/beta-services`, {
      method: 'PUT',
      body: JSON.stringify({
        betaServices: (Array.isArray(betaServices) ? betaServices : [])
          .map((value) => String(value || '').trim())
          .filter((value) => value.length > 0),
      }),
    });
  },
  updatePatientLinksStatus: async (enabled: boolean, doctorUserIds?: Array<string | number> | null) => {
    return fetchWithAuth(`${API_BASE_URL}/settings/patient-links`, {
      method: 'PUT',
      body: JSON.stringify({
        enabled,
        doctorUserIds: Array.isArray(doctorUserIds)
          ? doctorUserIds.map((value) => String(value || '').trim()).filter((value) => value.length > 0)
          : [],
      }),
    });
  },
  updateCrmStatus: async (enabled: boolean) => {
    return fetchWithAuth(`${API_BASE_URL}/settings/crm`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
  },
  updateForumStatus: async (enabled: boolean) => {
    return fetchWithAuth(`${API_BASE_URL}/settings/forum`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
  },
  updateResearchStatus: async (enabled: boolean) => {
    return fetchWithAuth(`${API_BASE_URL}/settings/research`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
  },
  updatePhysicianMapStatus: async (enabled: boolean) => {
    return fetchWithAuth(`${API_BASE_URL}/settings/physician-map`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
  },
  updateTestPaymentsOverrideStatus: async (enabled: boolean) => {
    return fetchWithAuth(`${API_BASE_URL}/settings/test-payments-override`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
  },
  getStripeSettings: async () => {
    return fetchWithAuth(`${API_BASE_URL}/settings/stripe`, {
      method: 'GET',
    });
  },
  updateStripeTestMode: async (testMode: boolean) => {
    return fetchWithAuth(`${API_BASE_URL}/settings/stripe`, {
      method: 'PUT',
      body: JSON.stringify({ testMode }),
    });
  },
  getUserActivity: async (window: string) => {
    const query = window ? `?window=${encodeURIComponent(window)}` : '';
    return fetchWithAuth(`${API_BASE_URL}/settings/user-activity${query}`, {
      method: 'GET',
    });
  },
  getUserActivityLongPoll: async (
    window: string,
    etag?: string | null,
    timeoutMs: number = 25000,
    signal?: AbortSignal,
  ) => {
    if (!getAuthToken()) {
      throwLocalAuthRequired();
    }
    const params = new URLSearchParams();
    if (window) {
      params.set('window', window);
    }
    if (etag) {
      params.set('etag', String(etag));
    }
    if (timeoutMs && Number.isFinite(timeoutMs)) {
      params.set('timeoutMs', String(Math.max(1000, Math.min(timeoutMs, 30000))));
    }
    const query = params.toString() ? `?${params.toString()}` : '';
    return fetchWithAuth(`${API_BASE_URL}/settings/user-activity/longpoll${query}`, {
      method: 'GET',
      signal,
    });
  },
  pingPresence: async (
    payload?: { kind?: 'heartbeat' | 'interaction'; isIdle?: boolean },
    options?: { background?: boolean },
  ) => {
    if (!getAuthToken()) {
      return null;
    }
    if (isShadowSessionMode()) {
      return null;
    }
    return fetchWithAuth(`${API_BASE_URL}/settings/presence`, {
      method: 'POST',
      body: JSON.stringify(payload || {}),
      background: options?.background === true,
    });
  },
  getLiveClients: async (
    salesRepId?: string | null,
    options?: { background?: boolean },
  ) => {
    if (!getAuthToken()) {
      throwLocalAuthRequired();
    }
    const params = new URLSearchParams();
    if (salesRepId) {
      params.set('salesRepId', String(salesRepId));
    }
    const query = params.toString() ? `?${params.toString()}` : '';
    return fetchWithAuth(`${API_BASE_URL}/settings/live-clients${query}`, {
      method: 'GET',
      background: options?.background === true,
    });
  },
  getLiveClientsLongPoll: async (
    salesRepId?: string | null,
    etag?: string | null,
    timeoutMs: number = 25000,
    signal?: AbortSignal,
    options?: { background?: boolean },
  ) => {
    if (!getAuthToken()) {
      throwLocalAuthRequired();
    }
    const params = new URLSearchParams();
    if (salesRepId) {
      params.set('salesRepId', String(salesRepId));
    }
    if (etag) {
      params.set('etag', String(etag));
    }
    if (timeoutMs && Number.isFinite(timeoutMs)) {
      params.set('timeoutMs', String(Math.max(1000, Math.min(timeoutMs, 30000))));
    }
    const query = params.toString() ? `?${params.toString()}` : '';
    return fetchWithAuth(`${API_BASE_URL}/settings/live-clients/longpoll${query}`, {
      method: 'GET',
      signal,
      background: options?.background === true,
    });
  },

  getLiveUsers: async (options?: { background?: boolean }) => {
    if (!getAuthToken()) {
      throwLocalAuthRequired();
    }
    return fetchWithAuth(`${API_BASE_URL}/settings/live-users`, {
      method: 'GET',
      background: options?.background === true,
    });
  },

  getLiveUsersLongPoll: async (
    etag?: string | null,
    timeoutMs: number = 25000,
    signal?: AbortSignal,
    options?: { background?: boolean },
  ) => {
    if (!getAuthToken()) {
      throwLocalAuthRequired();
    }
    const params = new URLSearchParams();
    if (etag) {
      params.set('etag', String(etag));
    }
    if (timeoutMs && Number.isFinite(timeoutMs)) {
      params.set('timeoutMs', String(Math.max(1000, Math.min(timeoutMs, 30000))));
    }
    const query = params.toString() ? `?${params.toString()}` : '';
    return fetchWithAuth(`${API_BASE_URL}/settings/live-users/longpoll${query}`, {
      method: 'GET',
      signal,
      background: options?.background === true,
    });
  },
  getAdminUserProfile: async (userId: string | number) => {
    if (!userId) {
      throw new Error('userId is required');
    }
    if (!getAuthToken()) {
      throwLocalAuthRequired();
    }
    return fetchWithAuth(`${API_BASE_URL}/settings/users/${encodeURIComponent(String(userId))}`, {
      method: 'GET',
    });
  },
  getAdminUserProfiles: async (userIds: Array<string | number>) => {
    const ids = (Array.isArray(userIds) ? userIds : [])
      .map((value) => String(value || '').trim())
      .filter((value) => value.length > 0);
    if (!ids.length) {
      return { users: [] };
    }
    if (!getAuthToken()) {
      throwLocalAuthRequired();
    }
    const params = new URLSearchParams();
    params.set('ids', ids.join(','));
    return fetchWithAuth(`${API_BASE_URL}/settings/users?${params.toString()}`, {
      method: 'GET',
    });
  },
  getSalesRepProfile: async (salesRepId: string | number) => {
    if (!salesRepId) {
      throw new Error('salesRepId is required');
    }
    return fetchWithAuth(
      `${API_BASE_URL}/settings/sales-reps/${encodeURIComponent(String(salesRepId))}`,
      { method: 'GET' },
    );
  },
  getHandDeliveryStructure: async () => {
    return fetchWithAuth(`${API_BASE_URL}/settings/structure/hand-delivery`, {
      method: 'GET',
    });
  },
  updateHandDeliveryJurisdiction: async (
    userId: string | number,
    jurisdiction: 'local' | null,
  ) => {
    if (!userId) {
      throw new Error('userId is required');
    }
    return fetchWithAuth(
      `${API_BASE_URL}/settings/structure/hand-delivery/${encodeURIComponent(String(userId))}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ jurisdiction }),
      },
    );
  },
  getSalesRepHandDeliveryDoctors: async () => {
    return fetchWithAuth(`${API_BASE_URL}/settings/structure/hand-delivery/doctors`, {
      method: 'GET',
    });
  },
  updateSalesRepDoctorHandDelivery: async (
    doctorUserId: string | number,
    handDelivered: boolean,
  ) => {
    if (!doctorUserId) {
      throw new Error('doctorUserId is required');
    }
    return fetchWithAuth(
      `${API_BASE_URL}/settings/structure/hand-delivery/doctors/${encodeURIComponent(String(doctorUserId))}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ handDelivered: Boolean(handDelivered) }),
      },
    );
  },
  updateUserProfile: async (userId: string | number, payload: Record<string, any>) => {
    if (!userId) {
      throw new Error('userId is required');
    }
    return fetchWithAuth(`${API_BASE_URL}/settings/users/${encodeURIComponent(String(userId))}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },
  getReportSettings: async () => {
    return fetchWithAuth(`${API_BASE_URL}/settings/reports`, {
      method: 'GET',
    });
  },
  getDatabaseVisualizer: async (options?: {
    tableName?: string | null;
    page?: number;
    pageSize?: number;
    sortColumn?: string | null;
    sortDirection?: 'asc' | 'desc' | null;
    search?: string | null;
  }) => {
    const params = new URLSearchParams();
    if (options?.tableName) {
      params.set('table', String(options.tableName));
    }
    if (typeof options?.page === 'number' && Number.isFinite(options.page) && options.page > 0) {
      params.set('page', String(Math.floor(options.page)));
    }
    if (typeof options?.pageSize === 'number' && Number.isFinite(options.pageSize) && options.pageSize > 0) {
      params.set('pageSize', String(Math.floor(options.pageSize)));
    }
    if (options?.sortColumn) {
      params.set('sortColumn', String(options.sortColumn));
    }
    if (options?.sortDirection) {
      params.set('sortDirection', options.sortDirection);
    }
    if (options?.search) {
      params.set('search', String(options.search));
    }
    const query = params.toString() ? `?${params.toString()}` : '';
    return fetchWithAuth(`${API_BASE_URL}/settings/database-visualizer${query}`, {
      method: 'GET',
    });
  },
  setSalesBySalesRepCsvDownloadedAt: async (downloadedAt: string) => {
    return fetchWithAuth(`${API_BASE_URL}/settings/reports`, {
      method: 'PUT',
      body: JSON.stringify({ salesBySalesRepCsvDownloadedAt: downloadedAt }),
    });
  },
  setSalesLeadSalesBySalesRepCsvDownloadedAt: async (downloadedAt: string) => {
    return fetchWithAuth(`${API_BASE_URL}/settings/reports`, {
      method: 'PUT',
      body: JSON.stringify({ salesLeadSalesBySalesRepCsvDownloadedAt: downloadedAt }),
    });
  },
  setTaxesByStateCsvDownloadedAt: async (downloadedAt: string) => {
    return fetchWithAuth(`${API_BASE_URL}/settings/reports`, {
      method: 'PUT',
      body: JSON.stringify({ taxesByStateCsvDownloadedAt: downloadedAt }),
    });
  },
  setProductsCommissionCsvDownloadedAt: async (downloadedAt: string) => {
    return fetchWithAuth(`${API_BASE_URL}/settings/reports`, {
      method: 'PUT',
      body: JSON.stringify({ productsCommissionCsvDownloadedAt: downloadedAt }),
    });
  },
};

export const moderationAPI = {
  checkImage: async (payload: { dataUrl: string; purpose?: 'profile_photo' | 'delegate_logo' | string | null }) => {
    return fetchWithAuth(`${API_BASE_URL}/moderation/image`, {
      method: 'POST',
      body: JSON.stringify({
        dataUrl: payload.dataUrl,
        purpose: payload.purpose ?? null,
      }),
    });
  },
};

type CheckoutIdempotencyRecord = {
  key: string;
  fingerprint: string;
  createdAt: number;
};

const CHECKOUT_IDEMPOTENCY_STORAGE_KEY = 'peppro_checkout_idempotency_v1';
const CHECKOUT_IDEMPOTENCY_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

const generateIdempotencyKey = () => {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // ignore
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
};

const safeReadCheckoutIdempotencyRecord = (): CheckoutIdempotencyRecord | null => {
  try {
    const raw = sessionStorage.getItem(CHECKOUT_IDEMPOTENCY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CheckoutIdempotencyRecord>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.key !== 'string' || !parsed.key.trim()) return null;
    if (typeof parsed.fingerprint !== 'string' || !parsed.fingerprint.trim()) return null;
    if (typeof parsed.createdAt !== 'number' || !Number.isFinite(parsed.createdAt)) return null;
    return { key: parsed.key, fingerprint: parsed.fingerprint, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
};

const safeWriteCheckoutIdempotencyRecord = (record: CheckoutIdempotencyRecord) => {
  try {
    sessionStorage.setItem(CHECKOUT_IDEMPOTENCY_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // ignore
  }
};

const clearCheckoutIdempotencyRecord = () => {
  try {
    sessionStorage.removeItem(CHECKOUT_IDEMPOTENCY_STORAGE_KEY);
  } catch {
    // ignore
  }
};

const buildOrderFingerprint = (payload: {
  items: any[];
  total: number;
  referralCode?: string;
  discountCode?: string;
  discountCodeAmount?: number | null;
  paymentMethod?: string | null;
  handDelivery?: boolean;
  shipping?: { address?: any; estimate?: any; shippingTotal?: number | null };
  taxTotal?: number | null;
  delegateProposalToken?: string | null;
}) => {
  const normalizedItems = Array.isArray(payload.items)
    ? payload.items
      .map((item, index) => ({
        productId: item?.productId ?? item?.id ?? item?.sku ?? `item-${index}`,
        variationId: item?.variationId ?? item?.variantId ?? item?.variation?.id ?? null,
        quantity: Number(item?.quantity) || 0,
        price: Number(item?.price) || 0,
      }))
      .sort((a, b) => `${a.productId}:${a.variationId ?? ''}`.localeCompare(`${b.productId}:${b.variationId ?? ''}`))
    : [];

  const shippingAddress = payload.shipping?.address || null;
  const shippingPostalCode = shippingAddress?.postalCode || shippingAddress?.postcode || null;
  const shippingCountry = shippingAddress?.country || null;
  const shippingState = shippingAddress?.state || null;

  return JSON.stringify({
    items: normalizedItems,
    total: Number(payload.total) || 0,
    referralCode: payload.referralCode || null,
    discountCode: payload.discountCode || null,
    discountCodeAmount:
      typeof payload.discountCodeAmount === 'number' && Number.isFinite(payload.discountCodeAmount)
        ? payload.discountCodeAmount
        : null,
    paymentMethod: payload.paymentMethod || null,
    handDelivery: payload.handDelivery === true,
    taxTotal: typeof payload.taxTotal === 'number' ? payload.taxTotal : null,
    delegateProposalToken:
      typeof payload.delegateProposalToken === 'string' && payload.delegateProposalToken.trim()
        ? payload.delegateProposalToken.trim()
        : null,
    shipping: {
      postalCode: shippingPostalCode,
      country: shippingCountry,
      state: shippingState,
      shippingTotal: payload.shipping?.shippingTotal ?? null,
    },
  });
};

export const discountCodesAPI = {
  preview: async (
    code: string,
    itemsSubtotal: number,
    cartQuantity: number,
    items?: Array<{ quantity?: number | string | null }>,
  ) => {
    return fetchWithAuth(`${API_BASE_URL}/discount-codes/preview`, {
      method: 'POST',
      body: JSON.stringify({
        code,
        itemsSubtotal: typeof itemsSubtotal === 'number' ? itemsSubtotal : 0,
        cartQuantity: typeof cartQuantity === 'number' ? cartQuantity : 0,
        items: Array.isArray(items) ? items : undefined,
      }),
    });
  },
};

const getOrCreateCheckoutIdempotencyKey = (fingerprint: string) => {
  const now = Date.now();
  const existing = safeReadCheckoutIdempotencyRecord();
  if (existing && existing.fingerprint === fingerprint && now - existing.createdAt < CHECKOUT_IDEMPOTENCY_TTL_MS) {
    return existing.key;
  }
  const key = generateIdempotencyKey();
  safeWriteCheckoutIdempotencyRecord({ key, fingerprint, createdAt: now });
  return key;
};

// Orders API
export const ordersAPI = {
  create: async (
    items: any[],
    total: number,
    referralCode?: string,
    discountCode?: string,
    discountCodeAmount?: number | null,
    shipping?: {
      address?: any;
      estimate?: any;
      shippingTotal?: number | null;
    },
    expectedShipmentWindow?: string | null,
    options?: {
      physicianCertification?: boolean;
      handDelivery?: boolean;
      delegateProposalToken?: string | null;
    },
    taxTotal?: number | null,
    paymentMethod?: string | null,
    pricingMode?: 'wholesale' | 'retail' | string | null,
  ) => {
    const fingerprint = buildOrderFingerprint({
      items,
      total,
      referralCode,
      discountCode,
      discountCodeAmount: typeof discountCodeAmount === 'number' ? discountCodeAmount : null,
      shipping,
      paymentMethod,
      handDelivery: options?.handDelivery === true,
      taxTotal,
      delegateProposalToken: options?.delegateProposalToken ?? null,
    });
    const idempotencyKey = getOrCreateCheckoutIdempotencyKey(fingerprint);

    const response = await fetchWithAuth(`${API_BASE_URL}/orders/`, {
      method: 'POST',
      headers: {
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        items,
        total,
        referralCode,
        discountCode: discountCode ?? null,
        discountCodeAmount:
          typeof discountCodeAmount === 'number' && Number.isFinite(discountCodeAmount)
            ? discountCodeAmount
            : null,
        pricingMode: pricingMode ?? null,
        paymentMethod: paymentMethod ?? null,
        shippingAddress: shipping?.address,
        shippingEstimate: shipping?.estimate,
        shippingTotal: shipping?.shippingTotal ?? null,
        expectedShipmentWindow: expectedShipmentWindow ?? null,
        physicianCertification: options?.physicianCertification === true,
        handDelivery: options?.handDelivery === true,
        delegateProposalToken: options?.delegateProposalToken ?? null,
        taxTotal: typeof taxTotal === 'number' ? taxTotal : null,
      }),
    });

    if (response && typeof response === 'object' && (response as any).success === true) {
      clearCheckoutIdempotencyRecord();
    }
    return response;
  },

  estimateTotals: async (
    payload: {
      items: any[];
      shippingAddress: any;
      shippingEstimate: any;
      shippingTotal: number;
      handDelivery?: boolean;
      paymentMethod?: string | null;
      discountCode?: string | null;
    },
    options?: { signal?: AbortSignal },
  ) => {
    return fetchWithAuth(`${API_BASE_URL}/orders/estimate`, {
      method: 'POST',
      body: JSON.stringify(payload),
      signal: options?.signal,
    });
  },

  cancelOrder: async (orderId: string, reason?: string) => {
    if (!orderId) {
      throw new Error('Order ID is required to cancel an order');
    }
    return fetchWithAuth(`${API_BASE_URL}/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason || 'Payment confirmation failed' }),
    });
  },

  getAll: async (options?: { includeCanceled?: boolean; force?: boolean }) => {
    const params = new URLSearchParams();
    if (options?.includeCanceled) {
      params.set('includeCanceled', 'true');
    }
    if (options?.force) {
      params.set('force', 'true');
    }
    const query = params.toString();
    const url = query ? `${API_BASE_URL}/orders/?${query}` : `${API_BASE_URL}/orders/`;
    return fetchWithAuth(url);
  },

  getForSalesRep: async (options?: { salesRepId?: string | null; scope?: 'mine' | 'all'; localOnly?: boolean }) => {
    if (!getAuthToken()) {
      throwLocalAuthRequired();
    }
    const params = new URLSearchParams();
    if (options?.salesRepId) {
      params.set('salesRepId', options.salesRepId);
    }
    if (options?.scope) {
      params.set('scope', options.scope);
    }
    if (options?.localOnly) {
      params.set('localOnly', 'true');
    }
    // Ask backend (Node or Python) to include doctor context if supported
    params.set('includeDoctors', 'true');
    const query = params.toString();
    const url = query ? `${API_BASE_URL}/orders/sales-rep?${query}` : `${API_BASE_URL}/orders/sales-rep`;
    return fetchWithAuth(url);
  },

  getOnHoldForSalesRep: async (options?: { scope?: 'mine' | 'all'; limit?: number }) => {
    if (!getAuthToken()) {
      throwLocalAuthRequired();
    }
    const params = new URLSearchParams();
    if (options?.scope) {
      params.set('scope', options.scope);
    }
    if (typeof options?.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0) {
      params.set('limit', String(Math.trunc(options.limit)));
    }
    const query = params.toString();
    const url = query ? `${API_BASE_URL}/orders/sales-rep/on-hold?${query}` : `${API_BASE_URL}/orders/sales-rep/on-hold`;
    return fetchWithAuth(url);
  },

  getSalesByRepForAdmin: async (options?: { periodStart?: string; periodEnd?: string; force?: boolean }) => {
    if (!getAuthToken()) {
      throwLocalAuthRequired();
    }
    const params = new URLSearchParams();
    if (options?.periodStart) params.set('periodStart', options.periodStart);
    if (options?.periodEnd) params.set('periodEnd', options.periodEnd);
    if (options?.force) params.set('force', 'true');
    const query = params.toString();
    // Use non-admin path to avoid infra path-based restrictions; backend supports both.
    const url = query
      ? `${API_BASE_URL}/orders/sales-rep-summary?${query}`
      : `${API_BASE_URL}/orders/sales-rep-summary`;
    return fetchWithAuth(url);
  },

  getAdminOnHoldOrders: async (options?: { limit?: number }) => {
    if (!getAuthToken()) {
      throwLocalAuthRequired();
    }
    const params = new URLSearchParams();
    if (typeof options?.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0) {
      params.set('limit', String(Math.trunc(options.limit)));
    }
    const query = params.toString();
    // Use non-admin path to avoid infra path-based restrictions; backend supports both.
    const url = query
      ? `${API_BASE_URL}/orders/on-hold?${query}`
      : `${API_BASE_URL}/orders/on-hold`;
    return fetchWithAuth(url);
  },

  getTaxesByStateForAdmin: async (options?: { periodStart?: string; periodEnd?: string }) => {
    const params = new URLSearchParams();
    if (options?.periodStart) params.set('periodStart', options.periodStart);
    if (options?.periodEnd) params.set('periodEnd', options.periodEnd);
    const query = params.toString();
    const url = query
      ? `${API_BASE_URL}/orders/admin/taxes-by-state?${query}`
      : `${API_BASE_URL}/orders/admin/taxes-by-state`;
    return fetchWithAuth(url);
  },

  updateTaxNexusAppliedForAdmin: async (stateCode: string, taxNexusApplied: boolean) => {
    const normalizedStateCode = String(stateCode || '').trim().toUpperCase();
    if (!normalizedStateCode) {
      throw new Error('stateCode is required');
    }
    return fetchWithAuth(`${API_BASE_URL}/orders/admin/tax-tracking/${encodeURIComponent(normalizedStateCode)}`, {
      method: 'PATCH',
      body: JSON.stringify({ taxNexusApplied }),
    });
  },

  getProductSalesCommissionForAdmin: async (options?: { periodStart?: string; periodEnd?: string; debug?: boolean }) => {
    const params = new URLSearchParams();
    if (options?.periodStart) params.set('periodStart', options.periodStart);
    if (options?.periodEnd) params.set('periodEnd', options.periodEnd);
    if (options?.debug) params.set('debug', 'true');
    const query = params.toString();
    // Use non-admin path to avoid infra path-based restrictions; backend supports both.
    const url = query
      ? `${API_BASE_URL}/orders/product-sales-commission?${query}`
      : `${API_BASE_URL}/orders/product-sales-commission`;
    return fetchWithAuth(url);
  },

  getAdminOrdersForUser: async (userId: string | number) => {
    if (!userId) {
      throw new Error('userId is required');
    }
    return fetchWithAuth(`${API_BASE_URL}/orders/admin/users/${encodeURIComponent(String(userId))}`, {
      method: 'GET',
    });
  },

  getSalesRepOrderDetail: async (orderId: string | number, doctorEmailOrId?: string | null) => {
    if (!orderId) {
      throw new Error('orderId is required');
    }
    const params = new URLSearchParams();
    if (doctorEmailOrId) {
      const looksLikeEmail = typeof doctorEmailOrId === 'string' && doctorEmailOrId.includes('@');
      if (looksLikeEmail) {
        params.set('doctorEmail', doctorEmailOrId);
      } else {
        params.set('doctorId', String(doctorEmailOrId));
      }
      // Send both when we can to support Node and Python backends
      if (!looksLikeEmail) {
        params.set('doctorEmail', String(doctorEmailOrId));
      } else {
        params.set('doctorId', String(doctorEmailOrId));
      }
    }
    const query = params.toString();
    const url = query
      ? `${API_BASE_URL}/orders/sales-rep/${encodeURIComponent(orderId)}?${query}`
      : `${API_BASE_URL}/orders/sales-rep/${encodeURIComponent(orderId)}`;
    return fetchWithAuth(url);
  },

  getSalesModalDetail: async (userId: string | number) => {
    if (!userId) {
      throw new Error('userId is required');
    }
    return fetchWithAuth(
      `${API_BASE_URL}/orders/sales-rep/users/${encodeURIComponent(String(userId))}/modal-detail`,
      { method: 'GET' },
    );
  },

  updateOrderNotes: async (orderId: string | number, notes: string | null) => {
    if (!orderId) {
      throw new Error('orderId is required');
    }
    return fetchWithAuth(`${API_BASE_URL}/orders/${encodeURIComponent(String(orderId))}/notes`, {
      method: 'PATCH',
      body: JSON.stringify({ notes }),
    });
  },

  updateOrderFields: async (
    orderId: string | number,
    payload: {
      trackingNumber?: string | null;
      shippingCarrier?: string | null;
      shippingService?: string | null;
      status?: string | null;
      expectedShipmentWindow?: string | null;
    },
  ) => {
    if (!orderId) {
      throw new Error('orderId is required');
    }
    return fetchWithAuth(`${API_BASE_URL}/orders/${encodeURIComponent(String(orderId))}`, {
      method: 'PATCH',
      body: JSON.stringify(payload || {}),
    });
  },

  downloadInvoice: async (orderId: string | number) => {
    if (!orderId) {
      throw new Error('orderId is required');
    }
    return fetchWithAuthBlob(`${API_BASE_URL}/orders/${encodeURIComponent(String(orderId))}/invoice`, {
      method: 'GET',
      cache: 'no-store',
    });
  },
};

export const delegationAPI = {
  resolve: async (token: string) => {
    const normalized = typeof token === 'string' ? token.trim() : '';
    if (!normalized) {
      throw new Error('token is required');
    }
    const params = new URLSearchParams({ token: normalized });
    return fetchWithAuth(`${API_BASE_URL}/delegation/resolve?${params.toString()}`, { method: 'GET' });
  },

  listLinks: async () => {
    return fetchWithAuth(`${API_BASE_URL}/delegation/links`, { method: 'GET' });
  },

  createLink: async (payload?: {
    referenceLabel?: string | null;
    patientId?: string | null;
    subjectLabel?: string | null;
    studyLabel?: string | null;
    patientReference?: string | null;
    markupPercent?: number | null;
    instructions?: string | null;
    allowedProducts?: string[] | string | null;
    expiresInHours?: number | null;
    usageLimit?: number | null;
    paymentMethod?: string | null;
    paymentInstructions?: string | null;
    physicianCertified?: boolean | null;
  }) => {
    return fetchWithAuth(`${API_BASE_URL}/delegation/links`, {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
  },

	  updateLink: async (
	    token: string,
	    payload: {
	      referenceLabel?: string | null;
	      patientId?: string | null;
	      subjectLabel?: string | null;
	      studyLabel?: string | null;
	      patientReference?: string | null;
	      revoke?: boolean | null;
          delete?: boolean | null;
	      markupPercent?: number | null;
	      instructions?: string | null;
	      allowedProducts?: string[] | string | null;
	      expiresInHours?: number | null;
	      usageLimit?: number | null;
	      paymentMethod?: string | null;
	      paymentInstructions?: string | null;
	      receivedPayment?: boolean | number | null;
	    },
	  ) => {
    const normalized = typeof token === 'string' ? token.trim() : '';
    if (!normalized) {
      throw new Error('token is required');
    }
    return fetchWithAuth(`${API_BASE_URL}/delegation/links/${encodeURIComponent(normalized)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload || {}),
    });
  },

  updateConfig: async (payload: { markupPercent?: number | null }) => {
    return fetchWithAuth(`${API_BASE_URL}/delegation/config`, {
      method: 'PATCH',
      body: JSON.stringify(payload || {}),
    });
  },

  getLinkProposal: async (token: string) => {
    const normalized = typeof token === 'string' ? token.trim() : '';
    if (!normalized) {
      throw new Error('token is required');
    }
    return fetchWithAuth(`${API_BASE_URL}/delegation/links/${encodeURIComponent(normalized)}/proposal`, {
      method: 'GET',
    });
  },

  reviewLinkProposal: async (
    token: string,
    payload: {
      status: string;
      orderId?: string | null;
      notes?: string | null;
      reviewNotes?: string | null;
      amountDue?: number | null;
      amountDueCurrency?: string | null;
    },
  ) => {
    const normalized = typeof token === 'string' ? token.trim() : '';
    if (!normalized) {
      throw new Error('token is required');
    }
    return fetchWithAuth(`${API_BASE_URL}/delegation/links/${encodeURIComponent(normalized)}/proposal/review`, {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
  },

  estimateDelegateTotals: async (
    payload: {
      delegateToken: string;
      items: any[];
      shippingAddress: any;
      shippingEstimate: any;
      shippingTotal: number;
      paymentMethod?: string | null;
    },
    options?: { signal?: AbortSignal },
  ) => {
    return fetchWithAuth(`${API_BASE_URL}/orders/delegate/estimate`, {
      method: 'POST',
      body: JSON.stringify(payload),
      signal: options?.signal,
    });
  },

  shareDelegateOrder: async (payload: {
    delegateToken: string;
    items: any[];
    shippingAddress: any;
    shippingEstimate: any;
    shippingTotal: number;
    expectedShipmentWindow?: string | null;
    taxTotal?: number | null;
    paymentMethod?: string | null;
  }) => {
    return fetchWithAuth(`${API_BASE_URL}/orders/delegate/share`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
};

export const usageTrackingAPI = {
  track: async (payload: { event: string; metadata?: Record<string, unknown> | null }) => {
    if (isShadowSessionMode()) {
      return { ok: true, tracked: false, event: String(payload?.event || '') };
    }
    return fetchWithAuth(`${API_BASE_URL}/usage-tracking`, {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
  },
  getFunnel: async (events: Array<string>) => {
    const normalizedEvents = (Array.isArray(events) ? events : [])
      .map((value) => String(value || '').trim())
      .filter((value) => value.length > 0);
    const params = new URLSearchParams();
    if (normalizedEvents.length > 0) {
      params.set('events', normalizedEvents.join(','));
    }
    const query = params.toString();
    const url = query
      ? `${API_BASE_URL}/usage-tracking/funnel?${query}`
      : `${API_BASE_URL}/usage-tracking/funnel`;
    return fetchWithAuth(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
  },
};

export const trackingAPI = {
  getStatus: async (trackingNumber: string, options?: { carrier?: string }) => {
    const normalized = typeof trackingNumber === 'string' ? trackingNumber.trim() : '';
    if (!normalized) {
      throw new Error('trackingNumber is required');
    }
    const params = new URLSearchParams();
    if (options?.carrier) {
      params.set('carrier', options.carrier);
    }
    const query = params.toString();
    const url = query
      ? `${API_BASE_URL}/tracking/status/${encodeURIComponent(normalized)}?${query}`
      : `${API_BASE_URL}/tracking/status/${encodeURIComponent(normalized)}`;
    return fetchWithAuth(url, { method: 'GET', cache: 'no-store' });
  },
};

export const wooAPI = {
  listCertificateProducts: async () => {
    return fetchWithAuth(`${API_BASE_URL}/woo/certificates/products`, {
      method: 'GET',
      cache: 'no-store',
    });
  },

  listMissingCertificates: async () => {
    return fetchWithAuth(`${API_BASE_URL}/woo/certificates/missing`, {
      method: 'GET',
      cache: 'no-store',
    });
  },

  getProduct: async (productId: string | number) => {
    if (!productId) {
      throw new Error('productId is required');
    }
    return fetchWithAuth(`${API_BASE_URL}/woo/products/${encodeURIComponent(String(productId))}`, {
      method: 'GET',
      cache: 'force-cache',
      headers: {
        'Cache-Control': 'public, max-age=300',
        Pragma: '',
      },
    });
  },

  getProductVariation: async (productId: string | number, variationId: string | number) => {
    if (!productId) {
      throw new Error('productId is required');
    }
    if (!variationId) {
      throw new Error('variationId is required');
    }
    return fetchWithAuth(
      `${API_BASE_URL}/woo/products/${encodeURIComponent(String(productId))}/variations/${encodeURIComponent(String(variationId))}`,
      {
        method: 'GET',
        cache: 'force-cache',
        headers: {
          'Cache-Control': 'public, max-age=300',
          Pragma: '',
        },
      },
    );
  },

  getCertificateOfAnalysis: async (productId: string | number) => {
    if (!productId) {
      throw new Error('productId is required');
    }
    if (typeof window !== 'undefined') {
      const normalized = readDelegateTokenFromLocation(window.location);
      if (normalized) {
        const params = new URLSearchParams({ token: normalized });
        return fetchWithAuthBlob(
          `${API_BASE_URL}/woo/products/${encodeURIComponent(String(productId))}/certificate-of-analysis/delegate?${params.toString()}`,
          { method: 'GET', cache: 'no-store', skipAuth: true },
        );
      }
    }
    return fetchWithAuthBlob(
      `${API_BASE_URL}/woo/products/${encodeURIComponent(String(productId))}/certificate-of-analysis`,
      { method: 'GET', cache: 'no-store' },
    );
  },

  getCertificateOfAnalysisInfo: async (productId: string | number) => {
    if (!productId) {
      throw new Error('productId is required');
    }
    return fetchWithAuth(
      `${API_BASE_URL}/woo/products/${encodeURIComponent(String(productId))}/certificate-of-analysis/info`,
      {
        method: 'GET',
        cache: 'no-store',
      },
    );
  },

  uploadCertificateOfAnalysis: async (
    productId: string | number,
    payload: { file: File; filename?: string } | { dataUrl: string; filename?: string },
  ) => {
    if (!productId) {
      throw new Error('productId is required');
    }
    const url = `${API_BASE_URL}/woo/products/${encodeURIComponent(String(productId))}/certificate-of-analysis`;
    if ('file' in payload) {
      const form = new FormData();
      form.append('file', payload.file, payload.filename || payload.file.name || 'certificate-of-analysis');
      return fetchWithAuthForm(url, { method: 'POST', body: form });
    }
    if (!payload?.dataUrl) {
      throw new Error('dataUrl is required');
    }
    return fetchWithAuth(url, {
      method: 'POST',
      body: JSON.stringify({
        data: payload.dataUrl,
        filename: payload.filename,
      }),
    });
  },

  deleteCertificateOfAnalysis: async (productId: string | number) => {
    if (!productId) {
      throw new Error('productId is required');
    }
    return fetchWithAuth(`${API_BASE_URL}/woo/products/${encodeURIComponent(String(productId))}/certificate-of-analysis`, {
      method: 'DELETE',
    });
  },
};

export const shippingAPI = {
  getRates: async (payload: { shippingAddress: any; items: any[] }) => {
    return fetchWithAuth(`${API_BASE_URL}/shipping/rates`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
};

export const paymentsAPI = {
  confirmStripeIntent: async (paymentIntentId: string) => {
    return fetchWithAuth(`${API_BASE_URL}/payments/stripe/confirm`, {
      method: 'POST',
      body: JSON.stringify({ paymentIntentId }),
    });
  },
};

export const referralAPI = {
  submitDoctorReferral: async (payload: {
    contactName: string;
    contactEmail?: string;
    contactPhone?: string;
    notes?: string;
  }) => {
    return fetchWithAuth(`${API_BASE_URL}/referrals/doctor/referrals`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  getDoctorSummary: async (options?: { background?: boolean }) => {
    if (!getAuthToken()) {
      throwLocalAuthRequired();
    }
    return fetchWithAuth(`${API_BASE_URL}/referrals/doctor/summary`, {
      background: options?.background === true,
      preserveAuthOnAuthFailure: options?.background === true,
    });
  },

  getDoctorLedger: async (options?: { background?: boolean }) => {
    if (!getAuthToken()) {
      throwLocalAuthRequired();
    }
    return fetchWithAuth(`${API_BASE_URL}/referrals/doctor/ledger`, {
      background: options?.background === true,
      preserveAuthOnAuthFailure: options?.background === true,
    });
  },

  getSalesRepDashboard: async (options?: {
    salesRepId?: string | null;
    scope?: 'mine' | 'all';
    context?: 'dashboard' | 'modal';
    include?: string[] | null;
  }) => {
    if (!getAuthToken()) {
      throwLocalAuthRequired();
    }
    const params = new URLSearchParams();
    if (options?.salesRepId) {
      params.set('salesRepId', options.salesRepId);
    }
    if (options?.scope) {
      params.set('scope', options.scope);
    }
    if (options?.context) {
      params.set('context', options.context);
    }
    if (Array.isArray(options?.include) && options.include.length > 0) {
      const include = options.include
        .map((value) => String(value || '').trim())
        .filter((value) => value.length > 0)
        .join(',');
      if (include) {
        params.set('include', include);
      }
    }
    const query = params.toString();
    // Use non-admin path to avoid infra path-based restrictions; backend supports both.
    const url = query ? `${API_BASE_URL}/referrals/dashboard?${query}` : `${API_BASE_URL}/referrals/dashboard`;
    return fetchWithAuth(url);
  },

  getSalesRepById: async (salesRepId: string) => {
    if (!salesRepId) {
      throw new Error('salesRepId is required');
    }
    return fetchWithAuth(
      `${API_BASE_URL}/settings/sales-reps/${encodeURIComponent(String(salesRepId))}`,
      { method: 'GET' },
    );
  },

  createReferralCode: async (referralId: string) => {
    return fetchWithAuth(`${API_BASE_URL}/referrals/admin/referrals/code`, {
      method: 'POST',
      body: JSON.stringify({ referralId }),
    });
  },

  updateCodeStatus: async (codeId: string, status: string) => {
    return fetchWithAuth(`${API_BASE_URL}/referrals/admin/codes/${codeId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  },

  updateReferral: async (referralId: string, payload: {
    status?: string;
    notes?: string;
    salesRepNotes?: string;
    referredContactName?: string;
    referredContactEmail?: string;
    referredContactPhone?: string;
  }) => {
    return fetchWithAuth(`${API_BASE_URL}/referrals/admin/referrals/${referralId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },

  getSalesProspect: async (
    doctorId: string,
    options?: { background?: boolean },
  ) => {
    return fetchWithAuth(
      `${API_BASE_URL}/referrals/sales-prospects/${encodeURIComponent(doctorId)}`,
      { background: options?.background === true },
    );
  },

  upsertSalesProspect: async (
    doctorId: string,
    payload: {
      status?: string | null;
      notes?: string | null;
      resellerPermitExempt?: boolean | null;
      officeAddressLine1?: string | null;
      officeAddressLine2?: string | null;
      officeCity?: string | null;
      officeState?: string | null;
      officePostalCode?: string | null;
      officeCountry?: string | null;
    },
  ) => {
    return fetchWithAuth(`${API_BASE_URL}/referrals/sales-prospects/${encodeURIComponent(doctorId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },

  deleteSalesProspect: async (
    identifier: string,
    options?: {
      referralId?: string | null;
      doctorId?: string | null;
      kind?: string | null;
    },
  ) => {
    if (!identifier) {
      throw new Error('identifier is required');
    }
    const params = new URLSearchParams();
    if (options?.referralId) {
      params.set('referralId', String(options.referralId));
    }
    if (options?.doctorId) {
      params.set('doctorId', String(options.doctorId));
    }
    if (options?.kind) {
      params.set('kind', String(options.kind));
    }
    const query = params.toString();
    const url = query
      ? `${API_BASE_URL}/referrals/sales-prospects/${encodeURIComponent(identifier)}?${query}`
      : `${API_BASE_URL}/referrals/sales-prospects/${encodeURIComponent(identifier)}`;
    return fetchWithAuth(url, {
      method: 'DELETE',
    });
  },

  uploadResellerPermit: async (identifier: string, file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return fetchWithAuthForm(
      `${API_BASE_URL}/referrals/sales-prospects/${encodeURIComponent(identifier)}/reseller-permit`,
      {
        method: 'POST',
        body: formData,
      },
    );
  },

  downloadResellerPermit: async (identifier: string) => {
    return fetchWithAuthBlob(
      `${API_BASE_URL}/referrals/sales-prospects/${encodeURIComponent(identifier)}/reseller-permit`,
      { method: 'GET' },
    );
  },

  deleteResellerPermit: async (identifier: string) => {
    return fetchWithAuth(
      `${API_BASE_URL}/referrals/sales-prospects/${encodeURIComponent(identifier)}/reseller-permit`,
      { method: 'DELETE' },
    );
  },

  getProspectQuotes: async (identifier: string) => {
    if (!identifier) {
      throw new Error('identifier is required');
    }
    return fetchWithAuth(
      `${API_BASE_URL}/referrals/sales-prospects/${encodeURIComponent(identifier)}/quotes`,
      { method: 'GET', cache: 'no-store' },
    ) as Promise<ProspectQuoteListResponse>;
  },

  importProspectQuoteCart: async (identifier: string, payload: ProspectQuoteImportPayload) => {
    if (!identifier) {
      throw new Error('identifier is required');
    }
    return fetchWithAuth(
      `${API_BASE_URL}/referrals/sales-prospects/${encodeURIComponent(identifier)}/quotes/import-cart`,
      {
        method: 'POST',
        body: JSON.stringify(payload || {}),
      },
    ) as Promise<{
      prospect: Record<string, unknown> | null;
      quote: ProspectQuoteDetail | null;
      history: ProspectQuoteListResponse['history'];
    }>;
  },

  updateProspectQuote: async (
    identifier: string,
    quoteId: string,
    payload: {
      title?: string | null;
      notes?: string | null;
    },
  ) => {
    if (!identifier) {
      throw new Error('identifier is required');
    }
    if (!quoteId) {
      throw new Error('quoteId is required');
    }
    return fetchWithAuth(
      `${API_BASE_URL}/referrals/sales-prospects/${encodeURIComponent(identifier)}/quotes/${encodeURIComponent(quoteId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload || {}),
      },
    ) as Promise<{
      prospect: Record<string, unknown> | null;
      quote: ProspectQuoteDetail | null;
    }>;
  },

  deleteProspectQuote: async (identifier: string, quoteId: string) => {
    if (!identifier) {
      throw new Error('identifier is required');
    }
    if (!quoteId) {
      throw new Error('quoteId is required');
    }
    return fetchWithAuth(
      `${API_BASE_URL}/referrals/sales-prospects/${encodeURIComponent(identifier)}/quotes/${encodeURIComponent(quoteId)}`,
      {
        method: 'DELETE',
      },
    ) as Promise<{
      deleted: boolean;
      quoteId: string;
    }>;
  },

  exportProspectQuote: async (identifier: string, quoteId: string) => {
    if (!identifier) {
      throw new Error('identifier is required');
    }
    if (!quoteId) {
      throw new Error('quoteId is required');
    }
    return fetchWithAuthBlob(
      `${API_BASE_URL}/referrals/sales-prospects/${encodeURIComponent(identifier)}/quotes/${encodeURIComponent(quoteId)}/export`,
      {
        method: 'GET',
        cache: 'no-store',
      },
    );
  },

  createManualProspect: async (payload: {
    name: string;
    email?: string;
    emails?: string[];
    phone?: string;
    phones?: string[];
    notes?: string;
    status?: string;
    hasAccount?: boolean;
    officeAddressLine1?: string;
    officeAddressLine2?: string;
    officeCity?: string;
    officeState?: string;
    officePostalCode?: string;
    officeCountry?: string;
  }) => {
    return fetchWithAuth(`${API_BASE_URL}/referrals/admin/manual`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  deleteManualProspect: async (referralId: string) => {
    return fetchWithAuth(`${API_BASE_URL}/referrals/admin/manual/${referralId}`, {
      method: 'DELETE',
    });
  },

  deleteDoctorReferral: async (referralId: string) => {
    try {
      return await fetchWithAuth(`${API_BASE_URL}/referrals/doctor/referrals/${referralId}`, {
        method: 'DELETE',
      });
    } catch (error: any) {
      if (error?.status === 404) {
        return { deleted: true };
      }
      throw error;
    }
  },

  getReferralCodes: async () => {
    return fetchWithAuth(`${API_BASE_URL}/referrals/admin/codes`);
  },

  addManualCredit: async (payload: { doctorId: string; amount: number; reason: string; referralId?: string }) => {
    return fetchWithAuth(`${API_BASE_URL}/referrals/admin/credits`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
};

export const seamlessAPI = {
  getRawPayloads: async (limit: number = 20) => {
    const normalizedLimit = Math.max(1, Math.min(Number(limit) || 20, 200));
    return fetchWithAuth(
      `${API_BASE_URL}/integrations/seamless/raw?limit=${encodeURIComponent(String(normalizedLimit))}`,
      { method: 'GET' },
    );
  },
};

// Health check
export const getServerHealth = async (options: { quiet?: boolean } = {}) => {
  return fetchWithAuth(`${API_BASE_URL}/health`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
    cache: 'no-store',
    skipReachabilityDispatch: options.quiet === true,
  });
};

export const checkServerHealth = async (options: { force?: boolean; quiet?: boolean } = {}) => {
  const now = Date.now();
  if (!options.force && _healthCheckLastAt > 0) {
    const ageMs = now - _healthCheckLastAt;
    if (_healthCheckLastOk && ageMs < _PEPPRO_HEALTH_SUCCESS_TTL_MS) {
      return true;
    }
    if (!_healthCheckLastOk && ageMs < _PEPPRO_HEALTH_FAILURE_COOLDOWN_MS) {
      return false;
    }
  }
  if (_healthCheckInFlight) {
    return _healthCheckInFlight;
  }

  _healthCheckInFlight = (async () => {
    try {
      await getServerHealth({ quiet: options.quiet !== false });
      _healthCheckLastAt = Date.now();
      _healthCheckLastOk = true;
      return true;
    } catch {
      _healthCheckLastAt = Date.now();
      _healthCheckLastOk = false;
      return false;
    } finally {
      _healthCheckInFlight = null;
    }
  })();

  return _healthCheckInFlight;
};

export const newsAPI = {
  getPeptideHeadlines: async (options?: { background?: boolean }) => {
    if (options?.background && isApiBackgroundCooldownActive()) {
      return {
        items: [],
        count: 0,
        skipped: true,
      } as {
        items?: Array<{ title?: unknown; url?: unknown; summary?: unknown; imageUrl?: unknown; date?: unknown }>;
        count?: number;
        skipped?: boolean;
      };
    }
    const ts = Date.now();
    let response: Response;
    try {
      response = await fetch(`${API_BASE_URL}/news/peptides?_ts=${ts}`, {
        headers: {
          Accept: 'application/json',
        },
        credentials: 'include',
      });
    } catch (error) {
      if (options?.background && isNetworkLikeFetchError(error)) {
        noteApiBackgroundThrottle({
          message: typeof (error as any)?.message === 'string' ? (error as any).message : null,
        });
      }
      throw error;
    }

    if (!response.ok) {
      if (options?.background && (response.status === 429 || response.status >= 500)) {
        noteApiBackgroundThrottle({
          status: response.status,
          retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
        });
      }
      if (response.status === 404) {
        // Backend route not implemented in local/dev; return empty list gracefully.
        return { items: [], count: 0 } as {
          items?: Array<{ title?: unknown; url?: unknown; summary?: unknown; imageUrl?: unknown; date?: unknown }>;
          count?: number;
        };
      }
      throw new Error(`Failed to fetch peptide news (${response.status})`);
    }

    return response.json() as Promise<{
      items?: Array<{ title?: unknown; url?: unknown; summary?: unknown; imageUrl?: unknown; date?: unknown }>;
      count?: number;
      skipped?: boolean;
    }>;
  },
};

export const quotesAPI = {
  getQuoteOfTheDay: async () => {
    const response = await fetch(`${API_BASE_URL}/quotes/daily`, {
      headers: {
        Accept: 'application/json',
      },
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch quote (${response.status})`);
    }

    return response.json() as Promise<{
      text: string;
      author: string;
    }>;
  },
};

export const forumAPI = {
  listPeptideForum: async () => {
    const response = await fetch(`${API_BASE_URL}/forum/the-peptide-forum?_ts=${Date.now()}`, {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(text || `Forum request failed (${response.status})`);
    }
    return response.json() as Promise<{
      ok?: boolean;
      updatedAt?: string | null;
      items?: Array<{
        id: string;
        title: string;
        date?: string | null;
        description?: string | null;
        link?: string | null;
      }>;
    }>;
  },
};

export const passwordResetAPI = {
  request: async (email: string) => {
    return fetchWithAuth(`${API_BASE_URL}/password-reset/request`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  },
  reset: async (token: string, password: string) => {
    return fetchWithAuth(`${API_BASE_URL}/password-reset/reset`, {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    });
  },
};

export const contactFormsAPI = {
  getAll: async () => {
    return fetchWithAuth(`${API_BASE_URL}/contact`);
  },
};

// Legacy-style API helper used by some admin utilities
export const api = {
  post: async (path: string, payload: unknown) => {
    const token = getAuthToken();
    const url =
      path.startsWith('http://') || path.startsWith('https://')
        ? path
        : `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;

    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    return fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload ?? {}),
    });
  },
};

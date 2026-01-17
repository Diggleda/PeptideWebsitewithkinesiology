import type { AuthenticationResponseJSON, RegistrationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { sanitizePayloadMessages, sanitizeServiceNames } from '../lib/publicText';

export const API_BASE_URL = (() => {
  const configured = ((import.meta.env.VITE_API_URL as string | undefined) || '').trim();

  if (!configured) {
    // In dev we expect the API on localhost:3001 by default.
    if (import.meta.env.DEV) {
      return 'http://localhost:3001/api';
    }
    // In production, default to same-origin so deployments that serve the API under `/api`
    // work without requiring a rebuild-time env var.
    if (typeof window !== 'undefined' && window.location?.origin) {
      return `${window.location.origin}/api`;
    }
    return '/api';
  }

  const normalized = configured.replace(/\/+$/, '');
  const normalizedWithApi = normalized.toLowerCase().endsWith('/api') ? normalized : `${normalized}/api`;

  // Guardrail: in production builds, always default to same-origin to avoid CORS/proxy drift.
  if (import.meta.env.PROD && typeof window !== 'undefined' && window.location?.origin) {
    try {
      if (/^https?:\/\//i.test(normalizedWithApi)) {
        const parsed = new URL(normalizedWithApi);
        const current = new URL(window.location.origin);
        if (parsed.origin !== current.origin) {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[API] Ignoring cross-origin VITE_API_URL in production bundle; defaulting to same-origin /api');
          }
          return `${window.location.origin}/api`;
        }
      }
    } catch {
      // If parsing fails, fall through to returning the configured value.
    }
  }

  return normalizedWithApi;
})();

type AuthTabEvent = {
  type: 'LOGIN';
  tabId: string;
  sessionId: string;
  userId?: string | null;
  at: number;
};

const AUTH_TAB_ID_KEY = 'peppro_tab_id_v1';
const AUTH_SESSION_ID_KEY = 'peppro_session_id_v1';
const AUTH_USER_ID_KEY = 'peppro_user_id_v1';
const AUTH_SESSION_STARTED_AT_KEY = 'peppro_session_started_at_v1';
const AUTH_EVENT_STORAGE_KEY = 'peppro_auth_event_v1';
const AUTH_EVENT_NAME = 'peppro:force-logout';

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
  const tabId = getOrCreateTabId();
  if (payload.tabId === tabId) return;

  const localUserId = getAuthUserId();
  const payloadUserId = typeof payload.userId === 'string' ? payload.userId : null;
  // Scope cross-tab enforcement to the same account only.
  if (!localUserId || !payloadUserId || localUserId !== payloadUserId) {
    return;
  }

  const localSessionId = getSessionId();
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

const persistAuthToken = (token: string) => {
  if (!token) return;
  try {
    sessionStorage.setItem('auth_token', token);
  } catch {
    // Ignore sessionStorage errors (Safari private mode, etc.)
  }

  // Prefer scoping to account id so other accounts can remain signed in in other tabs.
  // Callers should set `peppro_user_id_v1` (via `setAuthUserId`) before persisting the token.

  const sessionId = _randomId();
  setSessionId(sessionId);
  setSessionStartedAt(Date.now());
  emitAuthEvent({
    type: 'LOGIN',
    tabId: getOrCreateTabId(),
    sessionId,
    userId: getAuthUserId(),
    at: Date.now(),
  });
};

const clearAuthToken = () => {
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
  clearSessionStartedAt();
};

const dispatchApiReachability = (payload: { ok: boolean; status?: number | null; message?: string | null }) => {
  try {
    if (typeof window === 'undefined') return;
    const detail = {
      ok: Boolean(payload.ok),
      status: typeof payload.status === 'number' ? payload.status : null,
      message: typeof payload.message === 'string' ? payload.message : null,
      at: Date.now(),
    };
    window.dispatchEvent(new CustomEvent('peppro:api-reachability', { detail }));
  } catch {
    // ignore
  }
};

const _PEPPRO_DEFAULT_TIMEOUT_MS = 15000;
const _PEPPRO_AUTH_TIMEOUT_MS = 12000;
const _PEPPRO_HEALTH_TIMEOUT_MS = 5000;
const _PEPPRO_LONGPOLL_TIMEOUT_MS = 30000;

const _timeoutMsForRequest = (url: string, method: string) => {
  const normalized = String(url || '').toLowerCase();
  if (normalized.includes('/api/health')) return _PEPPRO_HEALTH_TIMEOUT_MS;
  if (normalized.includes('/api/auth/')) return _PEPPRO_AUTH_TIMEOUT_MS;
  if (normalized.includes('/api/settings/user-activity/longpoll')) return _PEPPRO_LONGPOLL_TIMEOUT_MS;
  if (method === 'GET') return _PEPPRO_DEFAULT_TIMEOUT_MS;
  return _PEPPRO_DEFAULT_TIMEOUT_MS;
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

// Helper function to make authenticated requests
const fetchWithAuth = async (url: string, options: RequestInit = {}) => {
  const token = getAuthToken();
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const method = (options.method || 'GET').toUpperCase();
  let requestUrl = url;

  if (method === 'GET' && !(options.cache && options.cache !== 'default')) {
    const separator = requestUrl.includes('?') ? '&' : '?';
    requestUrl = `${requestUrl}${separator}_ts=${Date.now()}`;
  }

  let response: Response;
  try {
    const timeoutMs = _timeoutMsForRequest(requestUrl, method);
    response = await _fetchWithTimeout(requestUrl, {
      cache: options.cache ?? 'no-store',
      ...options,
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        ...headers,
      },
    }, timeoutMs);
  } catch (error: any) {
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
      const normalizedUrl = url.toLowerCase();
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
    const isAuthError = response.status === 401
      || (response.status === 403 && typeof codeField === 'string' && codeField.startsWith('TOKEN_'));
    if (isAuthError) {
      clearAuthToken();
      clearSessionId();
      // Only broadcast a logout if this tab *thought* it was authenticated.
      // Otherwise (e.g., calling /auth/logout without a token) we'd recurse.
      if (token) {
        const authCode = typeof codeField === 'string' ? codeField : undefined;
        const reason = authCode === 'TOKEN_REVOKED' ? 'credentials_used_elsewhere' : 'auth_revoked';
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
      return sanitizePayloadMessages(parsed);
    } catch (error) {
      console.warn('[fetchWithAuth] Failed to parse JSON response', { error });
      return sanitizeServiceNames(text);
    }
  }

  return response.text();
};

const fetchWithAuthForm = async (url: string, options: RequestInit = {}) => {
  const token = getAuthToken();
  const headers: HeadersInit = {
    ...(options.headers || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let response: Response;
  const method = (options.method || 'GET').toUpperCase();
  try {
    response = await _fetchWithTimeout(url, {
      cache: options.cache ?? 'no-store',
      ...options,
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        ...headers,
      },
    }, _timeoutMsForRequest(url, method));
  } catch (error: any) {
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
    const isAuthError = response.status === 401
      || (response.status === 403 && typeof codeField === 'string' && codeField.startsWith('TOKEN_'));
    if (isAuthError) {
      clearAuthToken();
      clearSessionId();
      if (token) {
        const authCode = typeof codeField === 'string' ? codeField : undefined;
        const reason = authCode === 'TOKEN_REVOKED' ? 'credentials_used_elsewhere' : 'auth_revoked';
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
      return sanitizePayloadMessages(parsed);
    } catch {
      return sanitizeServiceNames(text);
    }
  }
  return response.text();
};

const fetchWithAuthBlob = async (url: string, options: RequestInit = {}) => {
  const token = getAuthToken();
  const headers: HeadersInit = {
    ...(options.headers || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let response: Response;
  const method = (options.method || 'GET').toUpperCase();
  try {
    response = await _fetchWithTimeout(url, {
      cache: options.cache ?? 'no-store',
      ...options,
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        ...headers,
      },
    }, _timeoutMsForRequest(url, method));
  } catch (error: any) {
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
    const isAuthError = response.status === 401
      || (response.status === 403 && typeof codeField === 'string' && codeField.startsWith('TOKEN_'));
    if (isAuthError) {
      clearAuthToken();
      clearSessionId();
      if (token) {
        const authCode = typeof codeField === 'string' ? codeField : undefined;
        const reason = authCode === 'TOKEN_REVOKED' ? 'credentials_used_elsewhere' : 'auth_revoked';
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
  const blob = await response.blob();
  return { blob, filename, contentType: response.headers.get('content-type') || '' };
};

export type UpdateProfilePayload = {
  name?: string;
  email?: string;
  phone?: string;
  officeAddressLine1?: string | null;
  officeAddressLine2?: string | null;
  officeCity?: string | null;
  officeState?: string | null;
  officePostalCode?: string | null;
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
      body: JSON.stringify({
        name: input.name,
        email: input.email,
        password: input.password,
        code: input.code,
        npiNumber: input.npiNumber,
        phone: input.phone ?? undefined,
      }),
    });

    persistAuthToken(data.token);
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
      body: JSON.stringify({ email, password }),
    });

    setAuthUserId(data?.user?.id);
    persistAuthToken(data.token);
    return data.user;
  },

  checkEmail: async (email: string) => {
    const response = await fetch(`${API_BASE_URL}/auth/check-email?email=${encodeURIComponent(email)}`);
    if (!response.ok) {
      throw new Error('EMAIL_CHECK_FAILED');
    }
    return response.json();
  },

  logout: () => {
    const token = getAuthToken();
    try {
      if (token) {
        void fetch(`${API_BASE_URL}/auth/logout`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        }).catch(() => null);
      }
    } catch {
      // ignore
    }
    clearAuthToken();
    clearSessionId();
  },
  markOffline: () => {
    const token = getAuthToken();
    if (!token) return;
    try {
      void fetch(`${API_BASE_URL}/auth/logout`, {
        method: 'POST',
        keepalive: true,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      }).catch(() => null);
    } catch {
      // ignore
    }
  },

  getCurrentUser: async () => {
    try {
      const user = await fetchWithAuth(`${API_BASE_URL}/auth/me`);
      setAuthUserId((user as any)?.id);
      return user;
    } catch (error) {
      const maybeAny = error as any;
      const status = typeof maybeAny?.status === 'number' ? maybeAny.status : null;
      const code = typeof maybeAny?.code === 'string' ? maybeAny.code : null;
      const authCode = typeof maybeAny?.authCode === 'string' ? maybeAny.authCode : null;
      const isAuthFailure = code === 'AUTH_REQUIRED'
        || status === 401
        || (status === 403 && typeof authCode === 'string' && authCode.startsWith('TOKEN_'));
      if (isAuthFailure) {
        // Token already cleared by fetchWithAuth(); caller can treat null as "logged out".
        setAuthUserId(null);
        return null;
      }
      throw error;
    }
  },

  updateMe: async (payload: UpdateProfilePayload) => {
    return fetchWithAuth(`${API_BASE_URL}/auth/me`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
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
      persistAuthToken(data.token);
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
  pingPresence: async (payload?: { kind?: 'heartbeat' | 'interaction'; isIdle?: boolean }) => {
    return fetchWithAuth(`${API_BASE_URL}/settings/presence`, {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
  },
  getLiveClients: async (salesRepId?: string | null) => {
    const params = new URLSearchParams();
    if (salesRepId) {
      params.set('salesRepId', String(salesRepId));
    }
    const query = params.toString() ? `?${params.toString()}` : '';
    return fetchWithAuth(`${API_BASE_URL}/settings/live-clients${query}`, {
      method: 'GET',
    });
  },
  getLiveClientsLongPoll: async (
    salesRepId?: string | null,
    etag?: string | null,
    timeoutMs: number = 25000,
    signal?: AbortSignal,
  ) => {
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
    });
  },

  getLiveUsers: async () => {
    return fetchWithAuth(`${API_BASE_URL}/settings/live-users`, {
      method: 'GET',
    });
  },

  getLiveUsersLongPoll: async (
    etag?: string | null,
    timeoutMs: number = 25000,
    signal?: AbortSignal,
  ) => {
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
    });
  },
  getAdminUserProfile: async (userId: string | number) => {
    if (!userId) {
      throw new Error('userId is required');
    }
    return fetchWithAuth(`${API_BASE_URL}/settings/users/${encodeURIComponent(String(userId))}`, {
      method: 'GET',
    });
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
  setSalesBySalesRepCsvDownloadedAt: async (downloadedAt: string) => {
    return fetchWithAuth(`${API_BASE_URL}/settings/reports`, {
      method: 'PUT',
      body: JSON.stringify({ salesBySalesRepCsvDownloadedAt: downloadedAt }),
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
  paymentMethod?: string | null;
  shipping?: { address?: any; estimate?: any; shippingTotal?: number | null };
  taxTotal?: number | null;
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
    paymentMethod: payload.paymentMethod || null,
    taxTotal: typeof payload.taxTotal === 'number' ? payload.taxTotal : null,
    shipping: {
      postalCode: shippingPostalCode,
      country: shippingCountry,
      state: shippingState,
      shippingTotal: payload.shipping?.shippingTotal ?? null,
    },
  });
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
    shipping?: {
      address?: any;
      estimate?: any;
      shippingTotal?: number | null;
    },
    expectedShipmentWindow?: string | null,
    options?: {
      physicianCertification?: boolean;
    },
    taxTotal?: number | null,
    paymentMethod?: string | null,
  ) => {
    const fingerprint = buildOrderFingerprint({
      items,
      total,
      referralCode,
      shipping,
      paymentMethod,
      taxTotal,
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
        paymentMethod: paymentMethod ?? null,
        shippingAddress: shipping?.address,
        shippingEstimate: shipping?.estimate,
        shippingTotal: shipping?.shippingTotal ?? null,
        expectedShipmentWindow: expectedShipmentWindow ?? null,
        physicianCertification: options?.physicianCertification === true,
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
      paymentMethod?: string | null;
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

  getForSalesRep: async (options?: { salesRepId?: string | null; scope?: 'mine' | 'all' }) => {
    const params = new URLSearchParams();
    if (options?.salesRepId) {
      params.set('salesRepId', options.salesRepId);
    }
    if (options?.scope) {
      params.set('scope', options.scope);
    }
    // Ask backend (Node or Python) to include doctor context if supported
    params.set('includeDoctors', 'true');
    const query = params.toString();
    const url = query ? `${API_BASE_URL}/orders/sales-rep?${query}` : `${API_BASE_URL}/orders/sales-rep`;
    return fetchWithAuth(url);
  },

  getSalesByRepForAdmin: async (options?: { periodStart?: string; periodEnd?: string }) => {
    const params = new URLSearchParams();
    if (options?.periodStart) params.set('periodStart', options.periodStart);
    if (options?.periodEnd) params.set('periodEnd', options.periodEnd);
    const query = params.toString();
    const url = query
      ? `${API_BASE_URL}/orders/admin/sales-rep-summary?${query}`
      : `${API_BASE_URL}/orders/admin/sales-rep-summary`;
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
    return fetchWithAuthBlob(
      `${API_BASE_URL}/woo/products/${encodeURIComponent(String(productId))}/certificate-of-analysis`,
      {
        method: 'GET',
        cache: 'no-store',
      },
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

  getDoctorSummary: async () => {
    return fetchWithAuth(`${API_BASE_URL}/referrals/doctor/summary`);
  },

  getDoctorLedger: async () => {
    return fetchWithAuth(`${API_BASE_URL}/referrals/doctor/ledger`);
  },

  getSalesRepDashboard: async (options?: { salesRepId?: string | null; scope?: 'mine' | 'all' }) => {
    const params = new URLSearchParams();
    if (options?.salesRepId) {
      params.set('salesRepId', options.salesRepId);
    }
    if (options?.scope) {
      params.set('scope', options.scope);
    }
    const query = params.toString();
    const url = query ? `${API_BASE_URL}/referrals/admin/dashboard?${query}` : `${API_BASE_URL}/referrals/admin/dashboard`;
    return fetchWithAuth(url);
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

  getSalesProspect: async (doctorId: string) => {
    return fetchWithAuth(`${API_BASE_URL}/referrals/admin/sales-prospects/${encodeURIComponent(doctorId)}`);
  },

  upsertSalesProspect: async (
    doctorId: string,
    payload: { status?: string | null; notes?: string | null; resellerPermitExempt?: boolean | null },
  ) => {
    return fetchWithAuth(`${API_BASE_URL}/referrals/admin/sales-prospects/${encodeURIComponent(doctorId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },

  uploadResellerPermit: async (identifier: string, file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return fetchWithAuthForm(
      `${API_BASE_URL}/referrals/admin/sales-prospects/${encodeURIComponent(identifier)}/reseller-permit`,
      {
        method: 'POST',
        body: formData,
      },
    );
  },

  downloadResellerPermit: async (identifier: string) => {
    return fetchWithAuthBlob(
      `${API_BASE_URL}/referrals/admin/sales-prospects/${encodeURIComponent(identifier)}/reseller-permit`,
      { method: 'GET' },
    );
  },

  deleteResellerPermit: async (identifier: string) => {
    return fetchWithAuth(
      `${API_BASE_URL}/referrals/admin/sales-prospects/${encodeURIComponent(identifier)}/reseller-permit`,
      { method: 'DELETE' },
    );
  },

  createManualProspect: async (payload: {
    name: string;
    email?: string;
    phone?: string;
    notes?: string;
    status?: string;
    hasAccount?: boolean;
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

// Health check
export const checkServerHealth = async () => {
  try {
    const response = await fetch(`${API_BASE_URL}/health`);
    return response.ok;
  } catch {
    return false;
  }
};

export const newsAPI = {
  getPeptideHeadlines: async () => {
    const ts = Date.now();
    const response = await fetch(`${API_BASE_URL}/news/peptides?_ts=${ts}`, {
      headers: {
        Accept: 'application/json',
      },
      credentials: 'include',
    });

    if (!response.ok) {
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

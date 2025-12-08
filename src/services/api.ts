import type { AuthenticationResponseJSON, RegistrationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';

export const API_BASE_URL = (() => {
  const configured = ((import.meta.env.VITE_API_URL as string | undefined) || '').trim();

  if (!configured) {
    return 'http://localhost:3001/api';
  }

  const normalized = configured.replace(/\/+$/, '');
  return normalized.toLowerCase().endsWith('/api') ? normalized : `${normalized}/api`;
})();

// Helper function to get auth token
const getAuthToken = () => {
  try {
    const sessionToken = sessionStorage.getItem('auth_token');
    if (sessionToken && sessionToken.trim().length > 0) {
      return sessionToken;
    }
  } catch {
    // sessionStorage may be unavailable (SSR / private mode)
  }
  try {
    const storageToken = localStorage.getItem('auth_token');
    if (storageToken && storageToken.trim().length > 0) {
      try {
        sessionStorage.setItem('auth_token', storageToken);
      } catch {
        // Ignore sessionStorage writes if unavailable
      }
      return storageToken;
    }
  } catch {
    // Ignore localStorage errors
  }
  return null;
};

const persistAuthToken = (token: string) => {
  if (!token) return;
  localStorage.setItem('auth_token', token);
  try {
    sessionStorage.setItem('auth_token', token);
  } catch {
    // Ignore sessionStorage errors (Safari private mode, etc.)
  }
};

const clearAuthToken = () => {
  localStorage.removeItem('auth_token');
  try {
    sessionStorage.removeItem('auth_token');
  } catch {
    // ignore storage errors
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

  const response = await fetch(requestUrl, {
    cache: options.cache ?? 'no-store',
    ...options,
    headers: {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      ...headers,
    },
  });

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
      return JSON.parse(text);
    } catch (error) {
      console.warn('[fetchWithAuth] Failed to parse JSON response', { error });
      return text;
    }
  }

  return response.text();
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
    clearAuthToken();
  },

  getCurrentUser: async () => {
    try {
      return await fetchWithAuth(`${API_BASE_URL}/auth/me`);
    } catch (error) {
      // If token is invalid, clear it
      localStorage.removeItem('auth_token');
      try {
        sessionStorage.removeItem('auth_token');
      } catch {
        // ignore
      }
      return null;
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
      persistAuthToken(data.token);
      return data.user;
    },
  },
};

export const settingsAPI = {
  getShopStatus: async () => {
    return fetchWithAuth(`${API_BASE_URL}/settings/shop`, {
      method: 'GET',
    });
  },
  updateShopStatus: async (enabled: boolean) => {
    return fetchWithAuth(`${API_BASE_URL}/settings/shop`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
  },
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
    options?: {
      physicianCertification?: boolean;
    },
    taxTotal?: number | null,
  ) => {
    return fetchWithAuth(`${API_BASE_URL}/orders/`, {
      method: 'POST',
      body: JSON.stringify({
        items,
        total,
        referralCode,
        shippingAddress: shipping?.address,
        shippingEstimate: shipping?.estimate,
        shippingTotal: shipping?.shippingTotal ?? null,
        physicianCertification: options?.physicianCertification === true,
        taxTotal: typeof taxTotal === 'number' ? taxTotal : null,
      }),
    });
  },

  estimateTotals: async (
    payload: {
      items: any[];
      shippingAddress: any;
      shippingEstimate: any;
      shippingTotal: number;
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

  getAll: async () => {
    return fetchWithAuth(`${API_BASE_URL}/orders/`);
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

  getSalesByRepForAdmin: async () => {
    return fetchWithAuth(`${API_BASE_URL}/orders/admin/sales-rep-summary`);
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
    referredContactName?: string;
    referredContactEmail?: string;
    referredContactPhone?: string;
  }) => {
    return fetchWithAuth(`${API_BASE_URL}/referrals/admin/referrals/${referralId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },

  createManualProspect: async (payload: {
    name: string;
    email?: string;
    phone?: string;
    notes?: string;
    status?: string;
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

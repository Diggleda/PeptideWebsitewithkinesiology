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
    // sessionStorage may be unavailable in certain environments (e.g., SSR)
  }

  return localStorage.getItem('auth_token');
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
          errorMessage = `${errorMessage}: ${errorDetails}`;
        }
      }
    } catch (parseError) {
      errorDetails = { parseError: parseError instanceof Error ? parseError.message : String(parseError) };
    }

    const error = new Error(errorMessage);
    (error as any).status = response.status;
    (error as any).details = errorDetails;
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
    localStorage.removeItem('auth_token');
    try {
      sessionStorage.removeItem('auth_token');
    } catch {
      // ignore
    }
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

  updateMe: async (payload: { name?: string; email?: string; phone?: string }) => {
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

// Orders API
export const ordersAPI = {
  create: async (items: any[], total: number, referralCode?: string) => {
    return fetchWithAuth(`${API_BASE_URL}/orders`, {
      method: 'POST',
      body: JSON.stringify({ items, total, referralCode }),
    });
  },

  getAll: async () => {
    return fetchWithAuth(`${API_BASE_URL}/orders`);
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

  getSalesRepDashboard: async () => {
    return fetchWithAuth(`${API_BASE_URL}/referrals/admin/dashboard`);
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
    const response = await fetch(`${API_BASE_URL}/news/peptides`, {
      headers: {
        Accept: 'application/json',
      },
      credentials: 'include',
    });

    if (!response.ok) {
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

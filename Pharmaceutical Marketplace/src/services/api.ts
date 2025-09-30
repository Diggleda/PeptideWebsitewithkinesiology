const API_BASE_URL = 'http://localhost:3001/api';

// Helper function to get auth token
const getAuthToken = () => localStorage.getItem('auth_token');

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

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
};

// Auth API
export const authAPI = {
  register: async (name: string, email: string, password: string) => {
    const data = await fetchWithAuth(`${API_BASE_URL}/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
    });

    // Store token
    localStorage.setItem('auth_token', data.token);
    return data.user;
  },

  login: async (email: string, password: string) => {
    const data = await fetchWithAuth(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });

    // Store token
    localStorage.setItem('auth_token', data.token);
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
  },

  getCurrentUser: async () => {
    try {
      return await fetchWithAuth(`${API_BASE_URL}/auth/me`);
    } catch (error) {
      // If token is invalid, clear it
      localStorage.removeItem('auth_token');
      return null;
    }
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

// Health check
export const checkServerHealth = async () => {
  try {
    const response = await fetch(`${API_BASE_URL}/health`);
    return response.ok;
  } catch {
    return false;
  }
};

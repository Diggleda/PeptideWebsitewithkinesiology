import { useState, useEffect, useRef, useLayoutEffect, useCallback, FormEvent } from 'react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogClose } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Search, User, Gift, ShoppingCart, LogOut, Copy, X, Eye, EyeOff, Pencil, Loader2, Info, Package, Download, RotateCcw } from 'lucide-react';
import { toast } from 'sonner@2.0.3';
import { AuthActionResult } from '../types/auth';
import clsx from 'clsx';
import { requestStoredPasswordCredential } from '../lib/passwordCredential';

interface HeaderUserSalesRep {
  id?: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

type DirectShippingField =
  | 'officeAddressLine1'
  | 'officeAddressLine2'
  | 'officeCity'
  | 'officeState'
  | 'officePostalCode';

interface HeaderUser {
  id?: string;
  name: string;
  role?: string | null;
  referralCode?: string | null;
  visits?: number;
  hasPasskeys?: boolean;
  email?: string | null;
  phone?: string | null;
  salesRep?: HeaderUserSalesRep | null;
  officeAddressLine1?: string | null;
  officeAddressLine2?: string | null;
  officeCity?: string | null;
  officeState?: string | null;
  officePostalCode?: string | null;
}

interface AccountOrderLineItem {
  id?: string | null;
  name?: string | null;
  quantity?: number | null;
  total?: number | null;
  price?: number | null;
  sku?: string | null;
}

interface AccountOrderSummary {
  id: string;
  number?: string | null;
  status?: string | null;
  currency?: string | null;
  total?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  source: 'local' | 'woocommerce';
  lineItems?: AccountOrderLineItem[];
  integrations?: Record<string, string | null> | null;
  paymentMethod?: string | null;
}

interface HeaderProps {
  user: HeaderUser | null;
  onLogin: (email: string, password: string) => Promise<AuthActionResult> | AuthActionResult;
  onLogout: () => void;
  cartItems: number;
  onSearch: (query: string) => void;
  onCreateAccount?: (details: {
    name: string;
    email: string;
    password: string;
    confirmPassword: string;
    code: string;
  }) => Promise<AuthActionResult> | AuthActionResult;
  onCartClick?: () => void;
  loginPromptToken?: number;
  loginContext?: 'checkout' | null;
  showCartIconFallback?: boolean;
  onShowInfo?: () => void;
  onUserUpdated?: (user: HeaderUser) => void;
  accountOrders?: AccountOrderSummary[];
  accountOrdersLoading?: boolean;
  accountOrdersError?: string | null;
  ordersLastSyncedAt?: string | null;
  onRefreshOrders?: () => void;
  accountModalRequest?: { tab: 'details' | 'orders'; open?: boolean; token: number } | null;
  showCanceledOrders?: boolean;
  onToggleShowCanceled?: () => void;
}

const formatOrderDate = (value?: string | null) => {
  if (!value) return 'Pending';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const formatCurrency = (amount?: number | null, currency = 'USD') => {
  if (amount === null || amount === undefined || Number.isNaN(amount)) {
    return '—';
  }
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
};

const humanizeOrderStatus = (status?: string | null) => {
  if (!status) return 'Pending';
  const normalized = status.trim().toLowerCase();
  if (normalized === 'trash') return 'Canceled';
  return status
    .split(/[_\s]+/)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ');
};

export function Header({
  user,
  onLogin,
  onLogout,
  cartItems,
  onSearch,
  onCreateAccount,
  onCartClick,
  loginPromptToken,
  loginContext = null,
  showCartIconFallback = false,
  onShowInfo,
  onUserUpdated,
  accountOrders = [],
  accountOrdersLoading = false,
  accountOrdersError = null,
  ordersLastSyncedAt,
  onRefreshOrders,
  accountModalRequest = null,
  showCanceledOrders = false,
  onToggleShowCanceled,
}: HeaderProps) {
  const secondaryColor = 'rgb(95, 179, 249)';
  const translucentSecondary = 'rgba(95, 179, 249, 0.18)';
  const elevatedShadow = '0 32px 60px -28px rgba(95, 179, 249, 0.55)';
  const logoHaloBackground = 'rgba(95, 179, 249, 0.08)';
  const [loginOpen, setLoginOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [signupName, setSignupName] = useState('');
  const [signupSuffix, setSignupSuffix] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupConfirmPassword, setSignupConfirmPassword] = useState('');
  const [signupCode, setSignupCode] = useState('');
  const lastLoginPromptToken = useRef<number | null>(null);
  const [loginError, setLoginError] = useState('');
  const [signupError, setSignupError] = useState('');
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [accountTab, setAccountTab] = useState<'details' | 'orders'>('details');
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [referralCopied, setReferralCopied] = useState(false);
  const referralCopyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isLargeScreen, setIsLargeScreen] = useState(false);
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [showSignupPassword, setShowSignupPassword] = useState(false);
  const [showSignupConfirmPassword, setShowSignupConfirmPassword] = useState(false);
  const [loginSubmitting, setLoginSubmitting] = useState(false);
  const [trackingForm, setTrackingForm] = useState({ orderId: '', email: '' });
  const [trackingPending, setTrackingPending] = useState(false);
  const [trackingMessage, setTrackingMessage] = useState<string | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const [localUser, setLocalUser] = useState<HeaderUser | null>(user);
  const loginFormRef = useRef<HTMLFormElement | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<AccountOrderSummary | null>(null);
  const [cachedAccountOrders, setCachedAccountOrders] = useState<AccountOrderSummary[]>(Array.isArray(accountOrders) ? accountOrders : []);
  const loginEmailRef = useRef<HTMLInputElement | null>(null);
  const loginPasswordRef = useRef<HTMLInputElement | null>(null);
  const pendingLoginPrefill = useRef<{ email?: string; password?: string }>({});
  const credentialAutofillRequestInFlight = useRef(false);
  const accountModalRequestTokenRef = useRef<number | null>(null);
  const applyPendingLoginPrefill = useCallback(() => {
    const pending = pendingLoginPrefill.current;
    if (pending.email !== undefined && loginEmailRef.current) {
      loginEmailRef.current.value = pending.email;
      pending.email = undefined;
    }
    if (pending.password !== undefined && loginPasswordRef.current) {
      loginPasswordRef.current.value = pending.password;
      pending.password = undefined;
    }
  }, []);
  const queueLoginPrefill = useCallback(
    (values: { email?: string; password?: string }) => {
      if (values.email !== undefined) {
        pendingLoginPrefill.current.email = values.email;
      }
      if (values.password !== undefined) {
        pendingLoginPrefill.current.password = values.password;
      }
      applyPendingLoginPrefill();
    },
    [applyPendingLoginPrefill]
  );
  const triggerCredentialAutofill = useCallback(async () => {
    if (credentialAutofillRequestInFlight.current) {
      return;
    }
    credentialAutofillRequestInFlight.current = true;
    try {
      const credential = await requestStoredPasswordCredential();
      if (credential) {
        queueLoginPrefill({
          email: credential.id,
          password: credential.password,
        });
      }
    } finally {
      credentialAutofillRequestInFlight.current = false;
    }
  }, [queueLoginPrefill]);
  const handleLoginCredentialFocus = useCallback(() => {
    if (!loginOpen || authMode !== 'login') {
      return;
    }
    void triggerCredentialAutofill();
  }, [triggerCredentialAutofill, loginOpen, authMode]);

  useEffect(() => {
    if (!accountModalRequest) {
      return;
    }
    if (accountModalRequest.token && accountModalRequest.token === accountModalRequestTokenRef.current) {
      return;
    }
    accountModalRequestTokenRef.current = accountModalRequest.token ?? Date.now();
    console.debug('[Header] Processing account modal request', accountModalRequest);
    if (accountModalRequest.tab) {
      setAccountTab(accountModalRequest.tab);
    }
    if (accountModalRequest.open) {
      setWelcomeOpen(true);
    }
  }, [accountModalRequest]);
  useEffect(() => { setLocalUser(user); }, [user]);
  useEffect(() => {
    if (!loginOpen || authMode !== 'login') {
      return;
    }
    const raf = requestAnimationFrame(() => {
      applyPendingLoginPrefill();
    });
    return () => cancelAnimationFrame(raf);
  }, [loginOpen, authMode, applyPendingLoginPrefill]);
  useEffect(() => {
    if (!welcomeOpen) {
      setAccountTab('details');
    }
  }, [welcomeOpen]);
  const headerDisplayName = localUser
    ? user.role === 'sales_rep'
      ? `Admin: ${localUser.name}`
      : localUser.name
    : '';

  // Account tab underline indicator (shared bar that moves to active tab)
  const tabsContainerRef = useRef<HTMLDivElement | null>(null);
  const [indicatorLeft, setIndicatorLeft] = useState<number>(0);
  const [indicatorWidth, setIndicatorWidth] = useState<number>(0);
  const [indicatorOpacity, setIndicatorOpacity] = useState<number>(0);

  const updateTabIndicator = useCallback(() => {
    const container = tabsContainerRef.current;
    if (!container) return;
    const activeBtn = container.querySelector<HTMLButtonElement>(`button[data-tab="${accountTab}"]`);
    if (!activeBtn) return;
    const cRect = container.getBoundingClientRect();
    const bRect = activeBtn.getBoundingClientRect();
    const inset = 8; // match left/right padding for a tidy fit
    const left = Math.max(0, bRect.left - cRect.left + inset);
    const width = Math.max(0, bRect.width - inset * 2);
    setIndicatorLeft(left);
    setIndicatorWidth(width);
    setIndicatorOpacity(1);
  }, [accountTab]);

  useLayoutEffect(() => {
    const raf = requestAnimationFrame(() => {
      updateTabIndicator();
    });
    return () => cancelAnimationFrame(raf);
  }, [updateTabIndicator, welcomeOpen, accountTab]);

  useEffect(() => {
    const onResize = () => updateTabIndicator();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [updateTabIndicator]);

  useEffect(() => {
    if (!welcomeOpen) return;
    const timer = setTimeout(() => {
      updateTabIndicator();
    }, 80);
    return () => clearTimeout(timer);
  }, [welcomeOpen, updateTabIndicator, accountTab]);

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (loginSubmitting) {
      return;
    }

    setLoginError('');
    setSignupError('');
    setLoginSubmitting(true);

    const formElement = event.currentTarget;
    const emailValue = loginEmailRef.current?.value ?? '';
    const passwordValue = loginPasswordRef.current?.value ?? '';

    const result = await onLogin(emailValue, passwordValue);

    if (result.status === 'success') {
      queueLoginPrefill({ email: '', password: '' });
      formElement.reset();
      setLoginOpen(false);
      setAuthMode('login');
      setSignupName('');
      setSignupSuffix('');
      setSignupEmail('');
      setSignupPassword('');
      setSignupConfirmPassword('');
      setSignupCode('');
      setShowLoginPassword(false);
      setShowSignupPassword(false);
      setShowSignupConfirmPassword(false);
      setLoginError('');
      setSignupError('');
      if (loginContext !== 'checkout') {
        setWelcomeOpen(true);
      }
      setLoginSubmitting(false);
      return;
    }

    if (result.status === 'sales_rep_signup_required') {
      setLoginError('Your sales rep profile needs to be activated before you can sign in. Please finish setting up your account or contact support for help.');
      setShowLoginPassword(false);
      setShowSignupPassword(false);
      setShowSignupConfirmPassword(false);
      setLoginSubmitting(false);
      return;
    }

    if (result.status === 'invalid_password') {
      setLoginError('Incorrect password. Please try again.');
      queueLoginPrefill({ password: '' });
      setAuthMode('login');
      setShowLoginPassword(false);
      setShowSignupPassword(false);
      setShowSignupConfirmPassword(false);
      setLoginSubmitting(false);
      return;
    }

    if (result.status === 'email_not_found') {
      setLoginError('');
      setSignupError('We couldn\'t find that email. Please create your account below.');
      setAuthMode('signup');
      setSignupEmail(emailValue);
      setSignupSuffix('');
      setSignupPassword(passwordValue);
      setSignupConfirmPassword(passwordValue);
      setSignupCode('');
      setShowLoginPassword(false);
      setShowSignupPassword(false);
      setShowSignupConfirmPassword(false);
      setLoginSubmitting(false);
      return;
    }

    if (result.status === 'error') {
      setLoginError('Unable to log in. Please try again.');
    }

    setLoginSubmitting(false);
  };

  useEffect(() => {
    if (loginPromptToken === undefined || loginPromptToken === null || loginPromptToken === 0) {
      return;
    }
    if (lastLoginPromptToken.current === loginPromptToken) {
      return;
    }
    lastLoginPromptToken.current = loginPromptToken;
    setAuthMode('login');
    setLoginError('');
    setSignupError('');
    setSignupSuffix('');
    setSignupName('');
    setSignupEmail('');
    setSignupPassword('');
    setSignupConfirmPassword('');
    setSignupCode('');
    queueLoginPrefill({ email: '', password: '' });
    setShowLoginPassword(false);
    setShowSignupPassword(false);
    setShowSignupConfirmPassword(false);
    if (!user) {
      setLoginOpen(true);
    }
    setWelcomeOpen(false);
  }, [loginPromptToken, user]);

  useEffect(() => {
    if (user && loginOpen) {
      setLoginOpen(false);
    }
  }, [user, loginOpen]);

  useEffect(() => {
    if (!user) {
      setWelcomeOpen(false);
    }
  }, [user]);

  // Preserve last known orders so UI doesn't clear while refresh runs in background
  useEffect(() => {
    const incoming = Array.isArray(accountOrders) ? accountOrders : [];
    if (incoming.length > 0) {
      setCachedAccountOrders(incoming);
      return;
    }
    if (!accountOrdersLoading) {
      setCachedAccountOrders(incoming);
    }
  }, [accountOrders, accountOrdersLoading]);

  // Auto-refresh orders when the orders tab is open
  useEffect(() => {
    if (!welcomeOpen || accountTab !== 'orders' || !onRefreshOrders || !user) {
      return undefined;
    }
    onRefreshOrders();
    const intervalId = window.setInterval(() => {
      onRefreshOrders();
    }, 10000);
    return () => window.clearInterval(intervalId);
  }, [welcomeOpen, accountTab, onRefreshOrders, user]);

  useEffect(() => {
    const handleResize = () => {
      if (typeof window !== 'undefined') {
        const isLarge = window.innerWidth >= 1024;
        setIsLargeScreen(isLarge);
        if (isLarge) {
          setMobileSearchOpen(false);
        }
      }
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  useLayoutEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const headerElement = headerRef.current;
    if (!headerElement) {
      return;
    }

    const updateHeightVariable = () => {
      const { height } = headerElement.getBoundingClientRect();
      document.documentElement.style.setProperty('--app-header-height', `${Math.round(height)}px`);
    };

    updateHeightVariable();

    let resizeObserver: ResizeObserver | null = null;

    if ('ResizeObserver' in window) {
      resizeObserver = new ResizeObserver(() => updateHeightVariable());
      resizeObserver.observe(headerElement);
    } else {
      window.addEventListener('resize', updateHeightVariable);
    }

    return () => {
      if (resizeObserver) {
        resizeObserver.disconnect();
      } else {
        window.removeEventListener('resize', updateHeightVariable);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (referralCopyTimeout.current) {
        clearTimeout(referralCopyTimeout.current);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleGlobalClose = () => {
      setWelcomeOpen(false);
      setLoginOpen(false);
    };
    window.addEventListener('peppro:close-dialogs', handleGlobalClose);
    return () => {
      window.removeEventListener('peppro:close-dialogs', handleGlobalClose);
    };
  }, []);

  const handleSearch = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onSearch(searchQuery);
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setMobileSearchOpen(false);
    }
  };


  const handleSearchChange = (value: string) => {
    console.debug('[Header] Search change', { value });
    setSearchQuery(value);
    onSearch(value);
  };

  const toggleMobileSearch = () => {
    setMobileSearchOpen((prev) => !prev);
  };

  const handleSignup = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fullName = signupSuffix ? `${signupSuffix} ${signupName}`.trim() : signupName;

    const details = {
      name: fullName,
      email: signupEmail,
      password: signupPassword,
      confirmPassword: signupConfirmPassword,
      code: signupCode,
    };

    setSignupError('');
    setLoginError('');

    const result = onCreateAccount
      ? await onCreateAccount(details)
      : await onLogin(signupEmail, signupPassword);

    if (result.status === 'success') {
      setSignupName('');
      setSignupSuffix('');
      setSignupEmail('');
      setSignupPassword('');
      setSignupConfirmPassword('');
      setSignupCode('');
      setShowLoginPassword(false);
      setShowSignupPassword(false);
      setShowSignupConfirmPassword(false);
      setAuthMode('login');
      setLoginOpen(false);
      setSignupError('');
      setLoginError('');
      if (loginContext !== 'checkout') {
        setWelcomeOpen(true);
      }
      return;
    }

    if (result.status === 'email_exists') {
      setSignupError('');
      setLoginError('An account with this email already exists. Please log in.');
      setAuthMode('login');
      queueLoginPrefill({ email: details.email, password: '' });
      setSignupSuffix('');
      setSignupPassword('');
      setSignupConfirmPassword('');
      setSignupCode('');
      setShowLoginPassword(false);
      setShowSignupPassword(false);
      setShowSignupConfirmPassword(false);
      return;
    }

    if (result.status === 'invalid_password') {
      setSignupError('');
      setLoginError('Incorrect password. Please try again.');
      setAuthMode('login');
      queueLoginPrefill({ email: details.email, password: '' });
      setSignupSuffix('');
      setSignupPassword('');
      setSignupConfirmPassword('');
      setSignupCode('');
      setShowLoginPassword(false);
      setShowSignupPassword(false);
      setShowSignupConfirmPassword(false);
      return;
    }

    if (result.status === 'email_not_found') {
      setSignupError('We couldn\'t find that email. Please create your account below.');
      setAuthMode('signup');
      setSignupEmail(details.email);
      setSignupSuffix('');
      setSignupPassword('');
      setSignupConfirmPassword('');
      setSignupCode('');
      setShowLoginPassword(false);
      setShowSignupPassword(false);
      setShowSignupConfirmPassword(false);
      return;
    }

    if (result.status === 'password_mismatch') {
      setSignupError('Passwords do not match. Please confirm and try again.');
      return;
    }

    if (result.status === 'invalid_referral_code') {
      setSignupError('Referral codes must be 5 characters (e.g., AB123). Please double-check and try again.');
      return;
    }

    if (result.status === 'referral_code_not_found') {
      setSignupError('We couldn\'t locate that onboarding code. Please confirm it with your sales representative.');
      return;
    }

    if (result.status === 'sales_rep_email_mismatch') {
      setSignupError('Please use the email address associated with your sales representative profile.');
      return;
    }

    if (result.status === 'referral_code_unavailable') {
      setSignupError('This onboarding code has already been used. Please request a new code from your sales representative.');
      return;
    }

    if (result.status === 'name_email_required') {
      setSignupError('Name and email are required to create your account.');
      return;
    }

    if (result.status === 'error') {
      if (result.message === 'PASSWORD_REQUIRED') {
        setSignupError('Please create a secure password to access your account.');
      } else {
        setSignupError('Unable to create an account right now. Please try again.');
      }
  }
  };

  const handleTrackOrder = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (!trackingForm.orderId.trim()) {
      setTrackingMessage('Please enter a valid order ID.');
      return;
    }

    setTrackingPending(true);
    setTrackingMessage(null);
    try {
      await new Promise((resolve) => setTimeout(resolve, 900));
      setTrackingMessage('We will email your latest tracking update shortly.');
    } catch (error) {
      console.warn('[Account modal] Tracking lookup failed', error);
      setTrackingMessage('Unable to look up that order right now. Please try again.');
    } finally {
      setTrackingPending(false);
    }
  };


  const handleDialogChange = (open: boolean) => {
    console.debug('[Header] Auth dialog open change', { open });
    setLoginOpen(open);
    if (!open) {
      setAuthMode('login');
      setSignupName('');
      setSignupSuffix('');
      setSignupEmail('');
      setSignupPassword('');
      setSignupConfirmPassword('');
      setSignupCode('');
      setLoginError('');
      setSignupError('');
      setShowLoginPassword(false);
      setShowSignupPassword(false);
      setShowSignupConfirmPassword(false);
    }
  };

  const handleCartClick = () => {
    if (onCartClick) {
      onCartClick();
    }
  };

  const handleCopyReferralCode = async () => {
  if (!user?.referralCode) return;
    try {
      if (!navigator?.clipboard) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(user.referralCode);
      // toast.success('Referral code copied');
      setReferralCopied(true);
      if (referralCopyTimeout.current) {
        clearTimeout(referralCopyTimeout.current);
      }
      referralCopyTimeout.current = setTimeout(() => {
        setReferralCopied(false);
      }, 2000);
    } catch (error) {
      // toast.error('Unable to copy referral code');
      setReferralCopied(false);
    }
  };

  const renderCartButton = () => (
    <Button
      variant="outline"
      size="sm"
      onClick={handleCartClick}
      className={clsx(
        'relative hidden md:inline-flex glass squircle-sm transition-all duration-300 flex-shrink-0',
        showCartIconFallback && 'inline-flex'
      )}
      style={{
        color: secondaryColor,
        borderColor: translucentSecondary,
      }}
    >
      <ShoppingCart className="h-4 w-4" style={{ color: secondaryColor }} />
      {cartItems > 0 && (
        <Badge
          variant="outline"
          className="absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center p-0 glass-strong squircle-sm border border-[var(--brand-glass-border-2)] text-[rgb(95,179,249)]"
        >
          {cartItems}
        </Badge>
      )}
    </Button>
  );

  const renderSearchField = (inputClassName = '') => (
    <div className="relative">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 transform text-slate-600"
      />
      <Input
        type="text"
        placeholder="Search peptides..."
        value={searchQuery}
        onChange={(e) => handleSearchChange(e.target.value)}
        className={`glass squircle-sm pl-10 focus-visible:outline-none focus-visible:ring-0 focus-visible:border-[rgba(255,255,255,0.3)] ${inputClassName}`.trim()}
        style={{ borderColor: translucentSecondary, minWidth: '100%' }}
      />
    </div>
  );

  const accountHeaderTabs = [
    { id: 'details', label: 'Details', Icon: Info },
    { id: 'orders', label: 'Orders', Icon: Package },
  ] as const;

  const saveProfileField = useCallback(
    async (label: string, payload: Record<string, string | null>) => {
      try {
        const api = await import('../services/api');
        const updated = await api.authAPI.updateMe(payload);

        const normalizedPayload = Object.fromEntries(
          Object.entries(payload).map(([key, value]) => {
            if (typeof value === 'string') {
              const trimmed = value.trim();
              return [key, trimmed.length > 0 ? trimmed : null];
            }
            return [key, value];
          }),
        );

        const nextUserState: HeaderUser = {
          ...(localUser || {}),
          ...(updated || {}),
        };

        Object.entries(normalizedPayload).forEach(([key, value]) => {
          const serverValue = updated ? (updated as Record<string, unknown>)[key] : undefined;
          const shouldUsePayload =
            serverValue === undefined
            || serverValue === null
            || (typeof serverValue === 'string' && serverValue.trim().length === 0);

          if (shouldUsePayload) {
            (nextUserState as Record<string, unknown>)[key] = value;
          }
        });

        setLocalUser(nextUserState);
        onUserUpdated?.(nextUserState);
        toast.success(`${label} updated`);
      } catch (error: any) {
        toast.error(error?.message === 'EMAIL_EXISTS' ? 'That email is already in use.' : 'Update failed');
        throw error;
      }
    },
    [setLocalUser, onUserUpdated, localUser],
  );

  const identityFields: Array<{ key: 'name' | 'email' | 'phone'; label: string; type?: string; autoComplete?: string }> = [
    { key: 'name', label: 'Full Name', autoComplete: 'name' },
    { key: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
    { key: 'phone', label: 'Phone', autoComplete: 'tel' },
  ];

  const directShippingFields: Array<{ key: DirectShippingField; label: string; type?: string; autoComplete?: string }> = [
    { key: 'officeAddressLine1', label: 'Street', autoComplete: 'shipping address-line1' },
    { key: 'officeAddressLine2', label: 'Suite / Unit', autoComplete: 'shipping address-line2' },
    { key: 'officeCity', label: 'City', autoComplete: 'shipping address-level2' },
    { key: 'officeState', label: 'State', autoComplete: 'shipping address-level1' },
    { key: 'officePostalCode', label: 'Postal Code', autoComplete: 'shipping postal-code' },
  ];

  const accountInfoPanel = localUser ? (
    <div className="space-y-4">
      {localUser.role !== 'sales_rep' && (
        <div className="glass-card squircle-md p-4 space-y-2 border border-[var(--brand-glass-border-2)]">
          <p className="text-sm font-medium text-slate-700">Please contact your Regional Administrator at anytime.</p>
          <div className="space-y-1 text-sm text-slate-600">
            <p><span className="font-semibold">Name:</span> {localUser.salesRep?.name || 'N/A'}</p>
            <p><span className="font-semibold">Email:</span> {localUser.salesRep?.email || 'N/A'}</p>
            <p><span className="font-semibold">Phone:</span> {localUser.salesRep?.phone || 'N/A'}</p>
          </div>
        </div>
      )}
      <div className="glass-card squircle-md p-4 border border-[var(--brand-glass-border-2)] space-y-1">
        <h3 className="text-base font-semibold text-slate-800">Account Details</h3>
        <div className="grid gap-3 pt-2">
          {identityFields.map(({ key, label, type, autoComplete }) => (
            <EditableRow
              key={key}
              label={label}
              value={(localUser?.[key] as string | null) || ''}
              type={type || 'text'}
              autoComplete={autoComplete}
              onSave={async (next) => {
                await saveProfileField(label, { [key]: next });
              }}
            />
          ))}
        </div>
      </div>
      <div className="glass-card squircle-md p-4 border border-[var(--brand-glass-border-2)] space-y-3">
        <div>
          <h3 className="text-base font-semibold text-slate-800">Direct Shipping</h3>
          <p className="text-sm text-slate-600">Use your office address for cold-chain deliveries and samples.</p>
        </div>
        <div className="grid gap-3">
          {directShippingFields.map(({ key, label, autoComplete }) => (
            <EditableRow
              key={key}
              label={label}
              value={(localUser?.[key] as string | null) || ''}
              autoComplete={autoComplete}
              onSave={async (next) => {
                await saveProfileField(label, { [key]: next });
              }}
            />
          ))}
        </div>
      </div>
    </div>
  ) : null;

  const renderOrdersList = () => {
    const visibleOrders = cachedAccountOrders
      .filter((order) => order.source === 'woocommerce')
      .filter((order) => {
        if (showCanceledOrders) {
          return true;
        }
        const status = order.status ? String(order.status).trim().toLowerCase() : '';
        return status !== 'canceled' && status !== 'trash';
      });

    if (!visibleOrders.length) {
      return (
        <div className="text-center py-12">
          <div className="glass-card squircle-lg p-8 border border-[var(--brand-glass-border-2)] inline-block">
            <Package className="h-12 w-12 mx-auto mb-3 text-slate-400" />
            <p className="text-sm font-medium text-slate-700 mb-1">No orders found</p>
            <p className="text-xs text-slate-500">Your recent orders will appear here</p>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {visibleOrders.map((order) => {
          const status = humanizeOrderStatus(order.status);
          const statusNormalized = (order.status || '').toLowerCase();
          const isCanceled = statusNormalized.includes('cancel') || statusNormalized === 'trash';
          const isCompleted = statusNormalized.includes('complete');
          const isProcessing = statusNormalized.includes('processing');
          
          return (
            <div
              key={`${order.source}-${order.id}`}
              className="glass-card squircle-lg border border-[rgba(95,179,249,0.6)] overflow-hidden shadow-[0_12px_40px_-20px_rgba(95,179,249,0.5),0_10px_30px_-24px_rgba(15,23,42,0.35)] transition-all duration-300"
            >
              {/* Order Header */}
              <div className="px-6 py-5 border-b border-[rgba(95,179,249,0.12)] bg-gradient-to-r from-[rgba(95,179,249,0.05)] to-transparent">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center ${
                      isCompleted ? 'bg-green-100' : 
                      isCanceled ? 'bg-red-100' : 
                      isProcessing ? 'bg-blue-100' : 'bg-slate-100'
                    }`}>
                      <Package className={`h-5 w-5 ${
                        isCompleted ? 'text-green-600' : 
                        isCanceled ? 'text-red-600' : 
                        isProcessing ? 'text-blue-600' : 'text-slate-600'
                      }`} />
                    </div>
                    <div>
                      <h4 className="font-semibold text-slate-900">
                        Order #{order.number || order.id}
                      </h4>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {formatOrderDate(order.createdAt)}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge 
                      variant="outline" 
                      className={`squircle-sm ${
                        isCompleted ? 'bg-green-50 text-green-700 border-green-200' : 
                        isCanceled ? 'bg-red-50 text-red-700 border-red-200' : 
                        isProcessing ? 'bg-blue-50 text-blue-700 border-blue-200' : 
                        'bg-slate-50 text-slate-700 border-slate-200'
                      }`}
                    >
                      {status}
                    </Badge>
                    <Badge variant="outline" className="squircle-sm bg-[rgba(95,179,249,0.08)] text-[rgb(28,109,173)] border-[rgba(95,179,249,0.2)]">
                      {order.source === 'woocommerce' ? 'Store' : 'PepPro'}
                    </Badge>
                  </div>
                </div>
              </div>

              {/* Order Body */}
              <div className="px-6 py-5">
                {/* Items Summary */}
                {order.lineItems && order.lineItems.length > 0 && (
                  <div className="mb-4">
                    <p className="text-xs uppercase tracking-wider text-slate-500 mb-2 font-medium">Items</p>
                    <div className="space-y-1.5">
                      {order.lineItems.slice(0, 3).map((line, idx) => (
                        <div key={line.id || idx} className="flex items-center justify-between text-sm">
                          <span className="text-slate-700">
                            {line.name || 'Item'} {line.quantity && <span className="text-slate-500">× {line.quantity}</span>}
                          </span>
                          <span className="font-medium text-slate-900">
                            {formatCurrency(line.total ?? line.price ?? null, order.currency || 'USD')}
                          </span>
                        </div>
                      ))}
                      {order.lineItems.length > 3 && (
                        <p className="text-xs text-slate-500 italic">
                          +{order.lineItems.length - 3} more item{order.lineItems.length - 3 !== 1 ? 's' : ''}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* Total and Actions */}
                <div className="flex items-center justify-between pt-4 border-t border-[var(--brand-glass-border-1)]">
                  <div>
                    <p className="text-xs text-slate-500 mb-1">Order Total</p>
                    <p className="text-lg font-bold text-slate-900">
                      {formatCurrency(order.total ?? null, order.currency || 'USD')}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="squircle-sm bg-slate-100/90 text-slate-800 border-slate-300 hover:bg-slate-200"
                    onClick={() => setSelectedOrder(order)}
                  >
                    View Details
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderOrderDetails = () => {
    if (!selectedOrder) return null;

    return (
      <div className="glass-card squircle-lg border border-[var(--brand-glass-border-2)] p-6 text-center space-y-4">
        <p className="text-sm text-slate-700">
          Order detail redesign in progress for Order #{selectedOrder.number || selectedOrder.id}.
        </p>
        <Button
          type="button"
          variant="outline"
          className="squircle-sm glass btn-hover-lighter"
          onClick={() => setSelectedOrder(null)}
        >
          ← Back to orders
        </Button>
      </div>
    );
  };

  const accountOrdersPanel = localUser ? (
    localUser.role !== 'sales_rep' ? (
      <div className="space-y-4">
        {/* Header Section */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Order History</h3>
              <p className="text-sm text-slate-600 mt-1">Track and manage your purchases</p>
            </div>
            <div className="flex items-center gap-2">
              {ordersLastSyncedAt && (
                <span className="text-xs text-slate-500 px-3 py-1.5 glass-card squircle-sm border border-[var(--brand-glass-border-1)]">
                  Updated {formatOrderDate(ordersLastSyncedAt)}
                </span>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onToggleShowCanceled?.()}
                className="glass squircle-sm btn-hover-lighter"
              >
                {showCanceledOrders ? (
                  <>
                    <EyeOff className="h-4 w-4 mr-2" aria-hidden="true" />
                    Hide canceled
                  </>
                ) : (
                  <>
                    <Eye className="h-4 w-4 mr-2" aria-hidden="true" />
                    Show canceled
                  </>
                )}
              </Button>
            </div>
          </div>

          {accountOrdersError && (
            <div className="glass-card squircle-md p-4 border border-red-200 bg-red-50/50">
              <p className="text-sm text-red-700 font-medium">{accountOrdersError}</p>
            </div>
          )}

        {accountOrdersLoading && !cachedAccountOrders.length && (
          <div className="glass-card squircle-lg p-8 border border-[var(--brand-glass-border-2)] text-center">
            <Loader2 className="h-8 w-8 animate-spin mx-auto mb-3 text-[rgb(95,179,249)]" />
            <p className="text-sm text-slate-600">Loading your orders...</p>
          </div>
        )}
      </div>

      {/* Orders Content */}
      <div className="relative">
        {accountOrdersLoading && cachedAccountOrders.length > 0 && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/40 backdrop-blur-[2px]">
            <Loader2 className="h-6 w-6 animate-spin text-[rgb(95,179,249)]" />
          </div>
        )}
        {selectedOrder ? renderOrderDetails() : renderOrdersList()}
      </div>
      </div>
    ) : (
      <div className="glass-card squircle-lg p-8 border border-[var(--brand-glass-border-2)] text-center">
        <Package className="h-12 w-12 mx-auto mb-3 text-slate-400" />
        <p className="text-sm font-medium text-slate-700 mb-1">Sales Rep View</p>
        <p className="text-sm text-slate-600">
          Order history and tracking details for your sales rep profile will appear here soon.
        </p>
      </div>
    )
  ) : null;

  const activeAccountPanel = accountTab === 'details' ? accountInfoPanel : accountOrdersPanel;

  const authControls = user ? (
    <>
      <Dialog open={welcomeOpen} onOpenChange={(open) => {
        console.debug('[Header] Welcome dialog open change', { open });
        setWelcomeOpen(open);
      }}>
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => setWelcomeOpen(true)}
            className="squircle-sm glass-brand btn-hover-lighter transition-all duration-300 whitespace-nowrap px-4"
            aria-haspopup="dialog"
            aria-expanded={welcomeOpen}
          >
            <User className="h-4 w-4 flex-shrink-0" />
            <span className="hidden sm:inline ml-3">{headerDisplayName}</span>
          </Button>
        </DialogTrigger>
        <DialogContent
          className="glass-card squircle-xl w-full max-w-[min(960px,calc(100vw-2rem))] border border-[var(--brand-glass-border-2)] shadow-2xl p-0 flex flex-col max-h-[90vh] overflow-hidden"
          style={{ backdropFilter: 'blur(38px) saturate(1.6)' }}
        >
          <DialogHeader
            className="sticky top-0 z-10 glass-card border-b border-[var(--brand-glass-border-1)] px-6 py-4 backdrop-blur-lg flex items-start justify-between gap-4"
            style={{ boxShadow: '0 18px 28px -20px rgba(7,18,36,0.2)' }}
          >
            <div className="flex-1 min-w-0 space-y-3">
              <DialogTitle className="text-xl font-semibold text-[rgb(95,179,249)]">
                {user.name}
              </DialogTitle>
              <DialogDescription>
                {(user.visits ?? 1) > 1
                  ? `We appreciate you joining us on the path to making healthcare simpler and more transparent! We are excited to have you! Your can manage your account details and orders below.`
                  : `We are thrilled to have you with us—let's make healthcare simpler together!`}
              </DialogDescription>
              <div className="relative flex items-center gap-4 pb-2" ref={tabsContainerRef}>
                {accountHeaderTabs.map((tab) => {
                  const isActive = accountTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      className={clsx(
                        'relative inline-flex items-center gap-2 px-3 pb-2 pt-1 text-sm font-semibold transition-colors text-slate-600 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-black/30',
                        isActive && 'text-slate-900'
                      )}
                      data-tab={tab.id}
                      aria-pressed={isActive}
                      onClick={() => setAccountTab(tab.id)}
                    >
                      <tab.Icon className="h-3.5 w-3.5" aria-hidden="true" />
                      {tab.label}
                    </button>
                  );
                })}
                <span
                  aria-hidden="true"
                  className="account-tab-underline-indicator"
                  style={{ left: indicatorLeft, width: indicatorWidth, opacity: indicatorOpacity }}
                />
              </div>
            </div>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <div className="space-y-6 pt-4">
              {activeAccountPanel ?? (
                <div className="text-sm text-slate-600">
                  Loading account details...
                </div>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  console.log('[Header] Home clicked', { onShowInfo: !!onShowInfo });
                  setWelcomeOpen(false);
                  // Delay the onShowInfo call slightly to ensure modal closes first
                  setTimeout(() => {
                    if (onShowInfo) {
                      console.log('[Header] Calling onShowInfo after modal close');
                      onShowInfo();
                    }
                  }, 100);
                }}
                className="squircle-sm glass btn-hover-lighter w-full"
                style={{
                  boxShadow:
                    '0 2px 6px -1px rgba(0,0,0,0.10), 0 1px 2px -1px rgba(0,0,0,0.06), inset 0 1px rgba(255,255,255,0.5)'
                }}
              >
                Home
              </Button>
              <div className="flex flex-row gap-3 pt-2 pb-1">
                <Button
                  type="button"
                  variant="outline"
                  onClick={onLogout}
                  className="squircle-sm glass btn-hover-lighter flex-1"
                  style={{
                    boxShadow:
                      '0 2px 6px -1px rgba(0,0,0,0.10), 0 1px 2px -1px rgba(0,0,0,0.06), inset 0 1px rgba(255,255,255,0.5)'
                  }}
                >
                  <LogOut className="h-4 w-4 mr-2" />
                  Logout
                </Button>
                <Button
                  type="button"
                  onClick={() => setWelcomeOpen(false)}
                  className="squircle-sm glass-brand btn-hover-lighter flex-1"
                >
                  Continue
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {renderCartButton()}
    </>
  ) : (
    <>
      <Dialog open={loginOpen} onOpenChange={handleDialogChange}>
        <DialogTrigger asChild>
          <Button
            variant="default"
            className="squircle-sm glass-brand-subtle btn-hover-lighter transition-all duration-300 whitespace-nowrap"
          >
            <User className="h-4 w-4 flex-shrink-0" />
            <span className="hidden sm:inline ml-2">Login</span>
          </Button>
        </DialogTrigger>
        <DialogContent
          className="glass-card squircle-xl w-auto border border-[var(--brand-glass-border-2)] shadow-2xl"
          style={{
            backdropFilter: 'blur(38px) saturate(1.6)',
            width: 'min(640px, calc(100vw - 3rem))',
            maxWidth: 'min(640px, calc(100vw - 3rem))',
          }}
        >
          <DialogHeader
            className="flex items-start justify-between gap-4 border-b border-[var(--brand-glass-border-1)] pb-3"
            style={{
              boxShadow: '0 20px 45px -18px rgba(15,23,42,0.1)',
              position: 'relative',
              zIndex: 20,
            }}
          >
            <div className="flex-1 min-w-0 space-y-1">
              <DialogTitle className="text-xl font-semibold text-[rgb(95,179,249)]">
                {authMode === 'login' ? 'Welcome back' : 'Create Account'}
              </DialogTitle>
              <DialogDescription>
                {authMode === 'login'
                  ? 'Login to enter your PepPro account.'
                  : 'Create your PepPro physician account to access PepPro.'}
              </DialogDescription>
            </div>
            <DialogClose
              className="dialog-close-btn inline-flex h-9 w-9 items-center justify-center text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-[3px] focus-visible:ring-offset-[rgba(4,14,21,0.75)] transition-all duration-150"
              aria-label="Close account modal"
            >
              <X className="h-4 w-4" />
            </DialogClose>
          </DialogHeader>
          {authMode === 'login' ? (
            <div className="space-y-5">
              <form ref={loginFormRef} autoComplete="on" onSubmit={handleLogin} className="space-y-4">
                <div className="space-y-3">
                  <Label htmlFor="login-username">Email</Label>
                  <Input
                    ref={loginEmailRef}
                    id="login-username"
                    name="username"
                    type="email"
                    autoComplete="username"
                    inputMode="email"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    onFocus={handleLoginCredentialFocus}
                    className="glass squircle-sm mt-1 focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.3)]"
                    style={{ borderColor: translucentSecondary }}
                    required
                  />
                </div>
                {/* Login password */}
                <div className="space-y-3">
                  <Label htmlFor="login-password">Password</Label>
                  <div className="relative mt-1">
                    <Input
                      ref={loginPasswordRef}
                      id="login-password"
                      name="password"
                      autoComplete="current-password"
                      type={showLoginPassword ? 'text' : 'password'}
                      autoCorrect="off"
                      spellCheck={false}
                      onFocus={handleLoginCredentialFocus}
                      className="glass squircle-sm pr-20 focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.3)]"
                      style={{ borderColor: translucentSecondary }}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowLoginPassword((prev) => !prev)}
                      className="absolute right-4 top-1/2 -translate-y-1/2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-600 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(95,179,249,0.12)] btn-hover-lighter"
                      aria-label={showLoginPassword ? 'Hide password' : 'Show password'}
                      aria-pressed={showLoginPassword}
                    >
                      {showLoginPassword ? (
                        <>
                          <Eye className="h-4 w-4" />
                          <span className="sr-only">Hide</span>
                        </>
                      ) : (
                        <>
                          <EyeOff className="h-4 w-4" />
                          <span className="sr-only">Show</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
                {loginError && (
                  <p className="text-sm text-red-600">{loginError}</p>
                )}
                <Button
                  type="submit"
                  size="lg"
                  className="w-full squircle-sm glass-brand btn-hover-lighter inline-flex items-center justify-center gap-2"
                  disabled={loginSubmitting}
                >
                  {loginSubmitting && (
                      <Loader2
                        className="h-4 w-4 animate-spin-slow text-white shrink-0"
                      aria-hidden="true"
                      style={{ transformOrigin: 'center center', transform: 'translateZ(0)' }}
                    />
                  )}
                  {loginSubmitting ? 'Signing in…' : 'Sign In'}
                </Button>
              </form>
              <p className="text-center text-sm text-gray-600">
                New to PepPro?{' '}
                <button
                  type="button"
                  onClick={() => setAuthMode('signup')}
                  className="font-semibold btn-hover-lighter"
                  style={{ color: secondaryColor }}
                >
                  Create an account
                </button>
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              <form onSubmit={handleSignup} className="space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-4">
                  <div className="space-y-2 sm:w-36 sm:pb-0">
                    <Label htmlFor="suffix">Suffix</Label>
                    <select
                      id="suffix"
                      value={signupSuffix}
                      onChange={(e) => setSignupSuffix(e.target.value)}
                      className="glass squircle-sm mt-1 w-full px-3 text-sm border transition-colors focus-visible:outline-none focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[3px] focus-visible:ring-[rgba(95,179,249,0.3)] leading-tight"
                      style={{
                        borderColor: translucentSecondary,
                        backgroundColor: 'rgba(95,179,249,0.02)',
                        WebkitAppearance: 'none',
                        MozAppearance: 'none',
                        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23071b1b' d='M6 9L1 4h10z'/%3E%3C/svg%3E")`,
                        backgroundRepeat: 'no-repeat',
                        backgroundPosition: 'right 0.75rem center',
                        backgroundSize: '12px',
                        paddingRight: '2.5rem',
                        height: '2.5rem',
                        lineHeight: '1.25rem'
                      }}
                    >
                      <option value="">None</option>
                      <option value="Mr.">Mr.</option>
                      <option value="Mrs.">Mrs.</option>
                      <option value="Ms.">Ms.</option>
                      <option value="Mx.">Mx.</option>
                      <option value="Dr.">Dr.</option>
                      <option value="Prof.">Prof.</option>
                      <option value="Sir">Sir</option>
                      <option value="Dame">Dame</option>
                    </select>
                  </div>
                  <div className="flex-1 space-y-2 sm:pb-0">
                    <Label htmlFor="name">Full Name</Label>
                  <Input
                    id="name"
                    name="name"
                    autoComplete="name"
                    type="text"
                    value={signupName}
                    onChange={(e) => setSignupName(e.target.value)}
                    className="glass squircle-sm mt-1 h-10 focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.3)]"
                    style={{ borderColor: translucentSecondary }}
                    required
                  />
                  </div>
                </div>
                <div className="space-y-3">
                  <Label htmlFor="signup-email">Email</Label>
                  <Input
                    id="signup-email"
                    name="email"
                    autoComplete="email"
                    type="email"
                    value={signupEmail}
                    onChange={(e) => setSignupEmail(e.target.value)}
                    className="glass squircle-sm mt-1 focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.3)]"
                    style={{ borderColor: translucentSecondary }}
                    required
                  />
                </div>
                {/* Signup password */}
                <div className="space-y-3">
                  <Label htmlFor="signup-password">Password</Label>
                  <div className="relative mt-1">
                    <Input
                      id="signup-password"
                      name="password"
                      autoComplete="new-password"
                      type={showSignupPassword ? 'text' : 'password'}
                      value={signupPassword}
                      onChange={(e) => setSignupPassword(e.target.value)}
                      className="glass squircle-sm pr-20 focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.3)]"
                      style={{ borderColor: translucentSecondary }}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowSignupPassword((prev) => !prev)}
                      className="absolute right-4 top-1/2 -translate-y-1/2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-600 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(95,179,249,0.12)] btn-hover-lighter"
                      aria-label={showSignupPassword ? 'Hide password' : 'Show password'}
                      aria-pressed={showSignupPassword}
                    >
                      {showSignupPassword ? (
                        <>
                          <Eye className="h-4 w-4" />
                          <span className="sr-only">Hide</span>
                        </>
                      ) : (
                        <>
                          <EyeOff className="h-4 w-4" />
                          <span className="sr-only">Show</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
                {/* Signup confirm password */}
                <div className="space-y-3">
                  <Label htmlFor="signup-confirm-password">Confirm Password</Label>
                  <div className="relative mt-1">
                    <Input
                      id="signup-confirm-password"
                      name="confirm-password"
                      autoComplete="new-password"
                      type={showSignupConfirmPassword ? 'text' : 'password'}
                      value={signupConfirmPassword}
                      onChange={(e) => setSignupConfirmPassword(e.target.value)}
                      className="glass squircle-sm pr-20 focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.3)]"
                      style={{ borderColor: translucentSecondary }}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowSignupConfirmPassword((prev) => !prev)}
                      className="absolute right-4 top-1/2 -translate-y-1/2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-600 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(95,179,249,0.12)] btn-hover-lighter"
                      aria-label={showSignupConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
                      aria-pressed={showSignupConfirmPassword}
                    >
                      {showSignupConfirmPassword ? (
                        <>
                          <Eye className="h-4 w-4" />
                          <span className="sr-only">Hide</span>
                        </>
                      ) : (
                        <>
                          <EyeOff className="h-4 w-4" />
                          <span className="sr-only">Show</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
                {/* Signup referral code */}
                <div className="space-y-3">
                  <Label htmlFor="signup-code">Referral Code</Label>
                  <Input
                    id="signup-code"
                    name="referral-code"
                    autoComplete="off"
                    value={signupCode}
                    onChange={(e) => setSignupCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5))}
                    maxLength={5}
                    inputMode="text"
                    pattern="[A-Z0-9]*"
                    className="glass squircle-sm focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.3)]"
                    style={{ borderColor: translucentSecondary, textTransform: 'uppercase' }}
                    required
                  />
                  <p className="text-xs text-slate-500">Codes are 5 characters and issued by your sales representative.</p>
                </div>
                {signupError && (
                  <p className="text-sm text-red-600">{signupError}</p>
                )}
                <Button
                  type="submit"
                  size="lg"
                  className="w-full squircle-sm glass-brand btn-hover-lighter"
                >
                  Create Account
                </Button>
              </form>
              <p className="text-center text-sm text-gray-600">
                Already have an account?{' '}
                <button
                  type="button"
                  onClick={() => setAuthMode('login')}
                  className="font-semibold btn-hover-lighter"
                  style={{ color: secondaryColor }}
                >
                  Sign in
                </button>
              </p>
            </div>
          )}
          <div className="mt-6 glass squircle-lg p-4 sm:p-5 space-y-4 border border-[var(--brand-glass-border-1)]">
            <div className="flex flex-col gap-1">
              <h3 className="text-base font-semibold text-slate-800">Track an order</h3>
              <p className="text-sm text-slate-600">
                Enter your PepPro order ID and email. We&apos;ll email you the latest fulfillment update.
              </p>
            </div>
            <form className="grid gap-3 sm:grid-cols-2" onSubmit={handleTrackOrder}>
              <div>
                <Label htmlFor="account-track-id">Order ID</Label>
                <Input
                  id="account-track-id"
                  value={trackingForm.orderId}
                  onChange={(event) => setTrackingForm((prev) => ({ ...prev, orderId: event.target.value }))}
                  className="mt-1"
                  placeholder="ORD-12345"
                  required
                />
              </div>
              <div>
                <Label htmlFor="account-track-email">Email</Label>
                <Input
                  id="account-track-email"
                  type="email"
                  value={trackingForm.email}
                  onChange={(event) => setTrackingForm((prev) => ({ ...prev, email: event.target.value }))}
                  className="mt-1"
                  placeholder="you@example.com"
                />
              </div>
              <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
                <Button
                  type="submit"
                  className="glass-brand squircle-sm inline-flex items-center gap-2"
                  disabled={trackingPending}
                >
                  {trackingPending && (
                    <Loader2
                      className="h-4 w-4 animate-spin text-current shrink-0"
                      aria-hidden="true"
                      style={{ transformOrigin: 'center center' }}
                    />
                  )}
                  {trackingPending ? 'Checking…' : 'Email tracking link'}
                </Button>
                {trackingMessage && (
                  <p className="text-sm text-slate-600">{trackingMessage}</p>
                )}
              </div>
            </form>
          </div>
        </DialogContent>
      </Dialog>
      {renderCartButton()}
    </>
  );

  const logoSizing = isLargeScreen
    ? { maxWidth: '160px', maxHeight: '160px' }
    : { maxWidth: 'min(150px, 42vw)', maxHeight: '64px' };

  return (
    <header
      ref={headerRef}
      data-app-header
      className="w-full glass-strong border-b border-white/20 bg-white/70 supports-[backdrop-filter]:bg-white/40 backdrop-blur shadow-sm"
      style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9500 }}
    >
      <div className="w-full px-6 sm:px-6 py-4">
        <div className="flex flex-col gap-3 md:gap-4">
          <div className="flex w-full flex-wrap items-center gap-3 sm:gap-4 justify-between">
            {/* Logo */}
            <div className="flex items-center gap-3 min-w-0 flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="brand-logo relative flex items-center justify-center flex-shrink-0">
                  <img
                    src="/Peppro_fulllogo.png"
                    alt="PepPro logo"
                    className="relative z-[1] flex-shrink-0"
                    style={{
                      display: 'block',
                      width: 'auto',
                      height: 'auto',
                      maxWidth: logoSizing.maxWidth,
                      maxHeight: logoSizing.maxHeight,
                      objectFit: 'contain'
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Search Bar - Desktop (centered) */}
            {isLargeScreen && (
              <form
                onSubmit={handleSearch}
                className="flex flex-1 justify-center"
              >
                <div className="w-full max-w-md">
                  {renderSearchField()}
                </div>
              </form>
            )}

            {/* User Actions */}
            <div className="ml-auto flex items-center gap-2 md:gap-4 flex-wrap sm:flex-nowrap justify-end">
              {authControls}
              {!isLargeScreen && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={toggleMobileSearch}
                  aria-expanded={mobileSearchOpen}
                  className="glass squircle-sm transition-all duration-300"
                  style={{
                    color: secondaryColor,
                    borderColor: translucentSecondary,
                  }}
                >
                  {mobileSearchOpen ? (
                    <X className="h-4 w-4" style={{ color: secondaryColor }} />
                  ) : (
                    <Search className="h-4 w-4" style={{ color: secondaryColor }} />
                  )}
                  <span className="sr-only">{mobileSearchOpen ? 'Close search' : 'Open search'}</span>
                </Button>
              )}
            </div>
          </div>

          {mobileSearchOpen && !isLargeScreen && (
            <div className="px-1 pb-2">
              <form onSubmit={handleSearch}>{renderSearchField()}</form>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function EditableRow({
  label,
  value,
  type = 'text',
  autoComplete,
  onSave,
}: {
  label: string;
  value: string;
  type?: string;
  autoComplete?: string;
  onSave: (next: string) => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [next, setNext] = useState(value);
  useEffect(() => setNext(value), [value]);
  const [saving, setSaving] = useState(false);
  return (
    <div className="group flex items-center justify-between gap-3">
      <div className="min-w-[7rem] text-sm font-medium text-slate-700">{label}</div>
      <div className="flex-1 flex items-center gap-2">
        {editing ? (
          <input
            className="w-full h-9 px-3 squircle-sm border border-slate-200/70 bg-white/96 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
            value={next}
            type={type}
            autoComplete={autoComplete}
            onChange={(e) => setNext(e.currentTarget.value)}
          />
        ) : (
          <div className="flex-1 text-sm text-slate-700">{value || '—'}</div>
        )}
        {!editing ? (
          <button
            type="button"
            className="opacity-0 group-hover:opacity-100 transition-opacity text-slate-500 hover:text-slate-700"
            onClick={() => setEditing(true)}
            aria-label={`Edit ${label}`}
            title={`Edit ${label}`}
          >
            <Pencil className="w-4 h-4" />
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="squircle-sm"
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                try {
                  await onSave(next);
                  setEditing(false);
                } finally {
                  setSaving(false);
                }
              }}
            >
              Save
            </Button>
            <Button
              variant="ghost"
              className="squircle-sm"
              onClick={() => {
                setNext(value);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

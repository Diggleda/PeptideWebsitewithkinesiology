import { useState, useEffect, useRef, useLayoutEffect, useCallback, FormEvent } from 'react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Search, User, Gift, ShoppingCart, LogOut, Copy, X, Eye, EyeOff, Pencil } from 'lucide-react';
import { toast } from 'sonner@2.0.3';
import { AuthActionResult } from '../types/auth';
import clsx from 'clsx';
import { requestStoredPasswordCredential } from '../lib/passwordCredential';

interface HeaderProps {
  user: { name: string; role?: string | null; referralCode?: string | null; visits?: number; hasPasskeys?: boolean } | null;
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
}

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
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [referralCopied, setReferralCopied] = useState(false);
  const referralCopyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isLargeScreen, setIsLargeScreen] = useState(false);
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [showSignupPassword, setShowSignupPassword] = useState(false);
  const [showSignupConfirmPassword, setShowSignupConfirmPassword] = useState(false);
  const headerRef = useRef<HTMLElement | null>(null);
  const [localUser, setLocalUser] = useState(user);
  const loginFormRef = useRef<HTMLFormElement | null>(null);
  const loginEmailRef = useRef<HTMLInputElement | null>(null);
  const loginPasswordRef = useRef<HTMLInputElement | null>(null);
  const pendingLoginPrefill = useRef<{ email?: string; password?: string }>({});
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
  const credentialAutofillRequestInFlight = useRef(false);
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
  const headerDisplayName = localUser
    ? user.role === 'sales_rep'
      ? `Admin: ${localUser.name}`
      : localUser.name
    : '';

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    setLoginError('');
    setSignupError('');

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
      return;
    }

    if (result.status === 'sales_rep_signup_required') {
      setLoginError('Your sales rep profile needs to be activated before you can sign in. Please finish setting up your account or contact support for help.');
      setShowLoginPassword(false);
      setShowSignupPassword(false);
      setShowSignupConfirmPassword(false);
      return;
    }

    if (result.status === 'invalid_password') {
      setLoginError('Incorrect password. Please try again.');
      queueLoginPrefill({ password: '' });
      setAuthMode('login');
      setShowLoginPassword(false);
      setShowSignupPassword(false);
      setShowSignupConfirmPassword(false);
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
      return;
    }

    if (result.status === 'error') {
      setLoginError('Unable to log in. Please try again.');
    }
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
          className="glass-card squircle-xl w-auto border border-[var(--brand-glass-border-2)] shadow-2xl"
          style={{
            backdropFilter: 'blur(38px) saturate(1.6)',
            width: 'min(640px, calc(100vw - 3rem))',
            maxWidth: 'min(640px, calc(100vw - 3rem))',
          }}
        >
          <DialogTitle className="sr-only">Account greeting</DialogTitle>
          <DialogDescription className="sr-only">Account welcome actions</DialogDescription>
          <DialogHeader className="space-y-3">
            <DialogTitle>
              {(user.visits ?? 1) > 1
                ? `Welcome back, ${user.name}!`
                : `Welcome to PepPro, ${user.name}!`}
            </DialogTitle>
            <DialogDescription>
              {(user.visits ?? 1) > 1
                ? `We appreciate your continued support—let's make healthcare simpler together!`
                : `We are thrilled to have you with us—let's make healthcare simpler together!`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-6 pt-4 pb-2">
            {localUser && localUser.role !== 'sales_rep' && (
              <div className="glass-card squircle-md p-4 space-y-2 border border-[var(--brand-glass-border-2)]">
                <p className="text-sm font-medium text-slate-700">Please contact your Regional Administrator at anytime.</p>
                <div className="space-y-1 text-sm text-slate-600">
                  <p><span className="font-semibold">Name:</span> {localUser.salesRep?.name || 'N/A'}</p>
                  <p><span className="font-semibold">Email:</span> {localUser.salesRep?.email || 'N/A'}</p>
                  <p><span className="font-semibold">Phone:</span> {localUser.salesRep?.phone || 'N/A'}</p>
                </div>
              </div>
            )}
            {localUser && (
              <div className="glass-card squircle-md p-4 border border-[var(--brand-glass-border-2)]">
                <div className="grid gap-3">
                  {([['name','Full Name'],['email','Email'],['phone','Phone']] as const).map(([key,label]) => (
                    <EditableRow
                      key={key}
                      label={label}
                      value={(localUser as any)[key] || ''}
                      type={key === 'email' ? 'email' : 'text'}
                      onSave={async (next) => {
                        try {
                          const updated = await (await import('../services/api')).authAPI.updateMe({ [key]: next } as any);
                          setLocalUser(updated);
                          toast.success(`${label} updated`);
                        } catch (e:any) {
                          toast.error(e?.message === 'EMAIL_EXISTS' ? 'That email is already in use.' : 'Update failed');
                          throw e;
                        }
                      }}
                    />
                  ))}
                </div>
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                console.log('[Header] How does this work clicked', { onShowInfo: !!onShowInfo });
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
              How does this work?
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
          <DialogTitle className="sr-only">Authentication modal</DialogTitle>
          <DialogDescription className="sr-only">User authentication workflow</DialogDescription>
          <DialogHeader className="space-y-3">
            <div className="space-y-1">
              <DialogTitle>
                {authMode === 'login' ? 'Welcome back' : 'Create Account'}
              </DialogTitle>
              <DialogDescription>
                {authMode === 'login'
                  ? 'Login to enter your PepPro account.'
                  : ''}
              </DialogDescription>
            </div>
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
                  className="w-full squircle-sm glass-brand btn-hover-lighter"
                >
                  Sign In
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
        </DialogContent>
      </Dialog>
      {renderCartButton()}
    </>
  );

  return (
    <header
      ref={headerRef}
      data-app-header
      className="w-full glass-strong border-b border-white/20 bg-white/70 supports-[backdrop-filter]:bg-white/40 backdrop-blur shadow-sm"
      style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9500 }}
    >
      <div className="container mx-auto px-4 py-4">
        <div className="flex flex-col gap-3 md:gap-4">
          <div className="flex items-center justify-between gap-4">
            {/* Logo */}
            <div className="flex items-center space-x-3">
              <div className="flex items-center gap-3">
                <div className="brand-logo relative flex items-center justify-center flex-shrink-0">
                  <img
                    src="/Peppro_FullLogo_Transparent_NoBuffer.png"
                    alt="PepPro logo"
                    className="relative z-[1] flex-shrink-0"
                    style={{
                      display: 'block',
                      width: 'auto',
                      height: 'auto',
                      maxWidth: '160px',
                      maxHeight: '160px',
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
            <div className="flex items-center gap-2 md:gap-4">
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

function EditableRow({ label, value, type = 'text', onSave }: { label: string; value: string; type?: string; onSave: (next: string) => Promise<void> | void }) {
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

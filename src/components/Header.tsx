import { useState, useEffect, useRef } from 'react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Search, User, Gift, ShoppingCart, LogOut, Copy, X, Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner@2.0.3';
import { AuthActionResult } from '../types/auth';

interface HeaderProps {
  user: { name: string; referralCode: string; visits?: number } | null;
  onLogin: (email: string, password: string) => Promise<AuthActionResult> | AuthActionResult;
  onLogout: () => void;
  cartItems: number;
  onSearch: (query: string) => void;
  onCreateAccount?: (details: {
    name: string;
    email: string;
    password: string;
    confirmPassword: string;
  }) => Promise<AuthActionResult> | AuthActionResult;
  onCartClick?: () => void;
  loginPromptToken?: number;
  loginContext?: 'checkout' | null;
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
  loginContext = null
}: HeaderProps) {
  const secondaryColor = 'rgb(7, 27, 27)';
  const translucentSecondary = 'rgba(7, 27, 27, 0.18)';
  const elevatedShadow = '0 32px 60px -28px rgba(7, 27, 27, 0.55)';
  const logoHaloBackground = 'rgba(7, 27, 27, 0.08)';
  const [loginOpen, setLoginOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [signupName, setSignupName] = useState('');
  const [signupSuffix, setSignupSuffix] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupConfirmPassword, setSignupConfirmPassword] = useState('');
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

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();

    setLoginError('');
    setSignupError('');

    const result = await onLogin(email, password);

    if (result.status === 'success') {
      setLoginOpen(false);
      setEmail('');
      setPassword('');
      setAuthMode('login');
      setSignupName('');
      setSignupSuffix('');
      setSignupEmail('');
      setSignupPassword('');
      setSignupConfirmPassword('');
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

    if (result.status === 'invalid_password') {
      setLoginError('Incorrect password. Please try again.');
      setPassword('');
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
      setSignupEmail(email);
      setSignupSuffix('');
      setSignupPassword(password);
      setSignupConfirmPassword(password);
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
    window.addEventListener('protixa:close-dialogs', handleGlobalClose);
    return () => {
      window.removeEventListener('protixa:close-dialogs', handleGlobalClose);
    };
  }, []);

  const handleSearch = (e: React.FormEvent) => {
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

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    const fullName = signupSuffix ? `${signupSuffix} ${signupName}`.trim() : signupName;

    const details = {
      name: fullName,
      email: signupEmail,
      password: signupPassword,
      confirmPassword: signupConfirmPassword,
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
      setEmail(details.email);
      setPassword('');
      setSignupSuffix('');
      setSignupPassword('');
      setSignupConfirmPassword('');
      setShowLoginPassword(false);
      setShowSignupPassword(false);
      setShowSignupConfirmPassword(false);
      return;
    }

    if (result.status === 'invalid_password') {
      setSignupError('');
      setLoginError('Incorrect password. Please try again.');
      setAuthMode('login');
      setEmail(details.email);
      setPassword('');
      setSignupSuffix('');
      setSignupPassword('');
      setSignupConfirmPassword('');
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
      setShowLoginPassword(false);
      setShowSignupPassword(false);
      setShowSignupConfirmPassword(false);
      return;
    }

    if (result.status === 'error') {
      if (result.message === 'PASSWORD_MISMATCH') {
        setSignupError('Passwords do not match. Please confirm and try again.');
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
      toast.success('Referral code copied');
      setReferralCopied(true);
      if (referralCopyTimeout.current) {
        clearTimeout(referralCopyTimeout.current);
      }
      referralCopyTimeout.current = setTimeout(() => {
        setReferralCopied(false);
      }, 2000);
    } catch (error) {
      toast.error('Unable to copy referral code');
      setReferralCopied(false);
    }
  };

  const renderDesktopCartButton = () => (
    <Button
      variant="outline"
      size="sm"
      onClick={handleCartClick}
      className="relative hidden md:inline-flex glass squircle-sm transition-all duration-300 flex-shrink-0"
      style={{
        color: secondaryColor,
        borderColor: translucentSecondary,
      }}
    >
      <ShoppingCart className="h-4 w-4" style={{ color: secondaryColor }} />
      {cartItems > 0 && (
        <Badge
          variant="outline"
          className="absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center p-0 glass-strong squircle-sm border border-[var(--brand-glass-border-2)] text-[rgb(7,27,27)] shadow"
        >
          {cartItems}
        </Badge>
      )}
    </Button>
  );

  const renderSearchField = (inputClassName = '') => (
    <div className="relative">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 transform"
        style={{ color: secondaryColor }}
      />
      <Input
        type="text"
        placeholder="Search peptides..."
        value={searchQuery}
        onChange={(e) => handleSearchChange(e.target.value)}
        className={`glass squircle-sm pl-10 focus-visible:border-[rgb(7,27,27)] focus-visible:ring-[rgba(7,27,27,0.3)] ${inputClassName}`.trim()}
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
              className="squircle-sm shadow-sm transition-all duration-300 whitespace-nowrap px-4"
            style={{
              backgroundColor: secondaryColor,
              borderColor: 'transparent',
              color: '#fff',
            }}
            aria-haspopup="dialog"
            aria-expanded={welcomeOpen}
          >
            <User className="h-4 w-4 flex-shrink-0" style={{ color: '#ffffff' }} />
            <span className="hidden sm:inline ml-3">{user.name}</span>
          </Button>
        </DialogTrigger>
        <DialogContent
          className="w-full max-w-[min(340px,calc(100vw-2rem))] squircle-xl border backdrop-blur-xl shadow-lg"
          style={{
            borderColor: 'rgba(7, 27, 27, 0.32)',
            borderWidth: '1.5px',
            background: 'linear-gradient(155deg, rgba(255,255,255,0.98), rgba(240,255,255,0.96))',
            boxShadow:
              '0 55px 110px -45px rgba(7, 27, 27, 0.68), 0 28px 60px -40px rgba(7, 27, 27, 0.55)',
          }}
        >
          <DialogTitle className="sr-only">Account greeting</DialogTitle>
          <DialogDescription className="sr-only">Account welcome actions</DialogDescription>
          <DialogHeader className="space-y-3">
            <DialogTitle>
              {(user.visits ?? 1) > 1
                ? `Welcome back, ${user.name}!`
                : `Welcome to Protixa, ${user.name}!`}
            </DialogTitle>
            <DialogDescription>
              {(user.visits ?? 1) > 1
                ? `We appreciate your continued trust. This is visit number ${user.visits ?? 1}.`
                : 'We are thrilled to have you with us—let’s make healthcare simpler together.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-6 pt-4 pb-2">
            <div className="space-y-2">
              <Label>Referral Code</Label>
              <div className="flex flex-col items-start gap-1" aria-live="polite">
                <button
                  type="button"
                  onClick={handleCopyReferralCode}
                  className="group copy-trigger inline-flex h-10 items-center gap-2 rounded-full border px-3 text-sm font-medium transition-transform duration-150 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 cursor-pointer btn-hover-lighter"
                  style={{
                    backgroundColor: translucentSecondary,
                    color: secondaryColor,
                    borderColor: translucentSecondary,
                  }}
                >
                  <Gift className="h-[0.875rem] w-[0.875rem]" style={{ color: secondaryColor }} />
                  <span className="tracking-wide uppercase leading-none">{user.referralCode}</span>
                  <Copy className="copy-icon h-3 w-3 pointer-events-none" aria-hidden="true" />
                  <span className="sr-only">Copy referral code</span>
                </button>
                <span
                  className="h-4 text-xs font-semibold text-emerald-600 transition-opacity duration-200"
                  style={{ opacity: referralCopied ? 1 : 0 }}
                  aria-hidden={!referralCopied}
                >
                  Copied
                </span>
              </div>
            </div>
            <div className="flex flex-wrap gap-3 pt-6 pb-1">
              <Button
                type="button"
                variant="outline"
                onClick={onLogout}
                className="squircle-sm"
                style={{
                  color: secondaryColor,
                  borderColor: 'rgba(7,27,27,0.25)',
                  backgroundColor: 'rgba(7,27,27,0.04)'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'rgba(7,27,27,0.08)';
                  e.currentTarget.style.borderColor = 'rgba(7,27,27,0.35)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'rgba(7,27,27,0.04)';
                  e.currentTarget.style.borderColor = 'rgba(7,27,27,0.25)';
                }}
              >
                <LogOut className="h-4 w-4 mr-2" />
                Logout
              </Button>
              <Button
                type="button"
                onClick={() => setWelcomeOpen(false)}
                className="squircle-sm flex-1 min-w-[150px]"
                style={{
                  backgroundColor: secondaryColor,
                  color: '#fff',
                  borderColor: 'transparent'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'rgba(7,27,27,0.82)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = secondaryColor;
                }}
              >
                Continue
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {renderDesktopCartButton()}
    </>
  ) : (
    <>
      <Dialog open={loginOpen} onOpenChange={handleDialogChange}>
        <DialogTrigger asChild>
          <Button
            variant="default"
            className="squircle-sm shadow-sm transition-all duration-300 whitespace-nowrap"
            style={{
              backgroundColor: secondaryColor,
              borderColor: 'transparent',
              color: '#fff',
            }}
          >
            <User className="h-4 w-4 flex-shrink-0" style={{ color: '#ffffff' }} />
            <span className="hidden sm:inline ml-2">Login</span>
          </Button>
        </DialogTrigger>
        <DialogContent
          className="w-full max-w-[min(340px,calc(100vw-2rem))] squircle-xl border backdrop-blur-xl shadow-lg"
          style={{
            borderColor: 'rgba(7, 27, 27, 0.32)',
            borderWidth: '1.5px',
            background: 'linear-gradient(155deg, rgba(255,255,255,0.98), rgba(240,255,255,0.96))',
            boxShadow:
              '0 55px 110px -45px rgba(7, 27, 27, 0.68), 0 28px 60px -40px rgba(7, 27, 27, 0.55)',
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
                  ? 'Login to enter your Protixa account.'
                  : 'Set up your Protixa account in moments.'}
              </DialogDescription>
            </div>
          </DialogHeader>
          {authMode === 'login' ? (
            <div className="space-y-5">
              <form onSubmit={handleLogin} className="space-y-4">
                <div className="space-y-3">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    name="username"
                    autoComplete="username"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="glass squircle-sm mt-1 focus-visible:border-[rgb(7,27,27)] focus-visible:ring-[rgba(7,27,27,0.3)]"
                    style={{ borderColor: translucentSecondary }}
                    required
                  />
                </div>
                {/* Login password */}
                <div className="space-y-3">
                  <Label htmlFor="password">Password</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="password"
                      name="password"
                      autoComplete="current-password"
                      type={showLoginPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="glass squircle-sm mt-1 flex-1 focus-visible:border-[rgb(7,27,27)] focus-visible:ring-[rgba(7,27,27,0.3)]"
                      style={{ borderColor: translucentSecondary }}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowLoginPassword((prev) => !prev)}
                      className="mt-1 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-gray-600 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(7,27,27,0.12)] btn-hover-lighter"
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
                  className="w-full squircle-sm shadow-sm"
                  style={{
                    backgroundColor: secondaryColor,
                    color: '#fff',
                    borderColor: 'transparent',
                  }}
                >
                  Sign In
                </Button>
              </form>
              <p className="text-center text-sm text-gray-600">
                New to Protixa?{' '}
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
                      className="glass squircle-sm mt-1 h-10 w-full px-3 text-sm border transition-colors focus-visible:outline-none focus-visible:border-[rgb(7,27,27)] focus-visible:ring-[3px] focus-visible:ring-[rgba(7,27,27,0.3)]"
                      style={{
                        borderColor: translucentSecondary,
                        backgroundColor: 'rgba(7,27,27,0.02)',
                        WebkitAppearance: 'none',
                        MozAppearance: 'none',
                        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23071b1b' d='M6 9L1 4h10z'/%3E%3C/svg%3E")`,
                        backgroundRepeat: 'no-repeat',
                        backgroundPosition: 'right 0.75rem center',
                        backgroundSize: '12px',
                        paddingRight: '2.5rem'
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
                      className="glass squircle-sm mt-1 focus-visible:border-[rgb(7,27,27)] focus-visible:ring-[rgba(7,27,27,0.3)]"
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
                    className="glass squircle-sm mt-1 focus-visible:border-[rgb(7,27,27)] focus-visible:ring-[rgba(7,27,27,0.3)]"
                    style={{ borderColor: translucentSecondary }}
                    required
                  />
                </div>
                {/* Signup password */}
                <div className="space-y-3">
                  <Label htmlFor="signup-password">Password</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="signup-password"
                      name="new-password"
                      autoComplete="new-password"
                      type={showSignupPassword ? 'text' : 'password'}
                      value={signupPassword}
                      onChange={(e) => setSignupPassword(e.target.value)}
                      className="glass squircle-sm mt-1 flex-1 focus-visible:border-[rgb(7,27,27)] focus-visible:ring-[rgba(7,27,27,0.3)]"
                      style={{ borderColor: translucentSecondary }}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowSignupPassword((prev) => !prev)}
                      className="mt-1 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-gray-600 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(7,27,27,0.12)] btn-hover-lighter"
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
                  <div className="flex items-center gap-2">
                    <Input
                      id="signup-confirm-password"
                      name="confirm-password"
                      autoComplete="new-password"
                      type={showSignupConfirmPassword ? 'text' : 'password'}
                      value={signupConfirmPassword}
                      onChange={(e) => setSignupConfirmPassword(e.target.value)}
                      className="glass squircle-sm mt-1 flex-1 focus-visible:border-[rgb(7,27,27)] focus-visible:ring-[rgba(7,27,27,0.3)]"
                      style={{ borderColor: translucentSecondary }}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowSignupConfirmPassword((prev) => !prev)}
                      className="mt-1 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-gray-600 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(7,27,27,0.12)] btn-hover-lighter"
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
                {signupError && (
                  <p className="text-sm text-red-600">{signupError}</p>
                )}
                <Button
                  type="submit"
                  className="w-full squircle-sm shadow-sm"
                  style={{
                    backgroundColor: secondaryColor,
                    color: '#fff',
                    borderColor: 'transparent',
                  }}
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
      {renderDesktopCartButton()}
    </>
  );

  return (
    <header className="sticky top-0 z-50 glass-strong border-b border-white/20">
      <div className="container mx-auto px-4 py-4">
        <div className="flex flex-col gap-3 md:gap-4">
          <div className="flex items-center justify-between gap-4">
            {/* Logo */}
            <div className="flex items-center space-x-3">
              <div className="flex items-center gap-3">
                <div className="brand-logo relative flex items-center justify-center flex-shrink-0">
                  <img
                    src="/logo.png"
                    alt="Protixa logo"
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

import { useState, useEffect, useRef } from 'react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Search, User, Gift, ShoppingCart, LogOut, Copy } from 'lucide-react';
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

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(searchQuery);
  };

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    onSearch(value);
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
      return;
    }

    if (result.status === 'email_not_found') {
      setSignupError('We couldn\'t find that email. Please create your account below.');
      setAuthMode('signup');
      setSignupEmail(details.email);
      setSignupSuffix('');
      setSignupPassword('');
      setSignupConfirmPassword('');
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
    } catch (error) {
      toast.error('Unable to copy referral code');
    }
  };

  return (
    <header className="sticky top-0 z-50 glass-strong border-b border-white/20">
      <div className="container mx-auto px-4 py-4">
        <div className="flex items-center justify-between">
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

          {/* Search Bar */}
          <form onSubmit={handleSearch} className="mx-8 flex-1 max-w-md" style={{ minWidth: '32%' }}>
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
                className="glass squircle-sm pl-10 focus-visible:border-[rgb(7,27,27)] focus-visible:ring-[rgba(7,27,27,0.3)]"
                style={{ borderColor: translucentSecondary, minWidth: '100%' }}
              />
            </div>
          </form>

          {/* User Actions */}
          <div className="flex items-center gap-2 md:gap-4">
            {user ? (
              <>
                <Dialog open={welcomeOpen} onOpenChange={setWelcomeOpen}>
                  <DialogTrigger asChild>
                    <Button
                      variant="default"
                      size="sm"
                      className="squircle-sm shadow-sm transition-all duration-300 hover:scale-105 whitespace-nowrap px-4"
                      style={{
                        backgroundColor: secondaryColor,
                        borderColor: 'transparent',
                        color: '#fff',
                      }}
                    >
                      <User className="h-4 w-4 flex-shrink-0" style={{ color: '#ffffff' }} />
                      <span className="hidden sm:inline ml-3">{user.name}</span>
                    </Button>
                  </DialogTrigger>
                  <DialogContent
                    className="sm:max-w-md squircle-xl border backdrop-blur-xl shadow-xl"
                    style={{
                      borderColor: 'rgba(7, 27, 27, 0.32)',
                      borderWidth: '1.5px',
                      background: 'linear-gradient(155deg, rgba(255,255,255,0.98), rgba(240,255,255,0.96))',
                      boxShadow:
                        '0 55px 110px -45px rgba(7, 27, 27, 0.68), 0 28px 60px -40px rgba(7, 27, 27, 0.55)',
                    }}
                  >
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
                      <button
                        type="button"
                        onClick={handleCopyReferralCode}
                        className="group copy-trigger inline-flex h-10 items-center gap-2 rounded-full border px-3 text-sm font-medium transition-transform hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 cursor-pointer"
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
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCartClick}
                  className="relative glass squircle-sm transition-all duration-300 hover:scale-105 flex-shrink-0"
                  style={{
                    color: secondaryColor,
                    borderColor: translucentSecondary,
                  }}
                >
                  <ShoppingCart className="h-4 w-4" style={{ color: secondaryColor }} />
                  {cartItems > 0 && (
                    <Badge
                      className="absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center p-0 glass squircle-sm transition-all duration-300"
                      style={{
                        backgroundColor: secondaryColor,
                        color: '#f8fbfb',
                        borderColor: 'rgba(255,255,255,0.4)',
                      }}
                    >
                      {cartItems}
                    </Badge>
                  )}
                </Button>
              <button
                type="button"
                onClick={handleCopyReferralCode}
                className="group copy-trigger referral-pill inline-flex h-9 items-center gap-2 rounded-full border px-3 text-xs font-medium transition-all hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 cursor-pointer"
                style={{
                  backgroundColor: translucentSecondary,
                  color: secondaryColor,
                  borderColor: translucentSecondary,
                }}
              >
                <Gift className="h-[0.875rem] w-[0.875rem]" style={{ color: secondaryColor }} />
                <span className="tracking-wide uppercase text-sm leading-none">{user.referralCode}</span>
                <Copy className="copy-icon h-3 w-3 pointer-events-none" aria-hidden="true" />
                <span className="sr-only">Copy referral code</span>
              </button>
              </>
            ) : (
              <>
                <Dialog open={loginOpen} onOpenChange={handleDialogChange}>
                  <DialogTrigger asChild>
                    <Button
                      variant="default"
                      className="squircle-sm shadow-sm transition-all duration-300 hover:scale-105 whitespace-nowrap"
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
                  className="sm:max-w-md squircle-xl border backdrop-blur-xl shadow-xl"
                  style={{
                    borderColor: 'rgba(7, 27, 27, 0.32)',
                    borderWidth: '1.5px',
                    background: 'linear-gradient(155deg, rgba(255,255,255,0.98), rgba(240,255,255,0.96))',
                    boxShadow:
                      '0 55px 110px -45px rgba(7, 27, 27, 0.68), 0 28px 60px -40px rgba(7, 27, 27, 0.55)',
                  }}
                >
                  <DialogHeader className="space-y-3">
                    <div className="space-y-1">
                      <DialogTitle>
                        {authMode === 'login' ? 'Welcome back' : 'Create Account'}
                      </DialogTitle>
                      <DialogDescription>
                        {authMode === 'login'
                          ? 'Use your Protixa credentials to continue.'
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
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="glass squircle-sm mt-1 focus-visible:border-[rgb(7,27,27)] focus-visible:ring-[rgba(7,27,27,0.3)]"
                            style={{ borderColor: translucentSecondary }}
                            required
                          />
                        </div>
                        <div className="space-y-3">
                          <Label htmlFor="password">Password</Label>
                          <Input
                            id="password"
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="glass squircle-sm mt-1 focus-visible:border-[rgb(7,27,27)] focus-visible:ring-[rgba(7,27,27,0.3)]"
                            style={{ borderColor: translucentSecondary }}
                            required
                          />
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
                          className="font-semibold"
                          style={{ color: secondaryColor }}
                        >
                          Create an account
                        </button>
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-5">
                      <form onSubmit={handleSignup} className="space-y-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                          <div className="space-y-2 sm:w-32">
                            <Label htmlFor="suffix">Suffix</Label>
                            <select
                              id="suffix"
                              value={signupSuffix}
                              onChange={(e) => setSignupSuffix(e.target.value)}
                              className="glass squircle-sm mt-1 h-10 px-3 text-sm focus-visible:border-[rgb(7,27,27)] focus-visible:ring-[rgba(7,27,27,0.3)]"
                              style={{ borderColor: translucentSecondary }}
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
                          <div className="flex-1 space-y-2">
                            <Label htmlFor="name">Full Name</Label>
                            <Input
                              id="name"
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
                            type="email"
                            value={signupEmail}
                            onChange={(e) => setSignupEmail(e.target.value)}
                            className="glass squircle-sm mt-1 focus-visible:border-[rgb(7,27,27)] focus-visible:ring-[rgba(7,27,27,0.3)]"
                            style={{ borderColor: translucentSecondary }}
                            required
                          />
                        </div>
                        <div className="space-y-3">
                          <Label htmlFor="signup-password">Password</Label>
                          <Input
                            id="signup-password"
                            type="password"
                            value={signupPassword}
                            onChange={(e) => setSignupPassword(e.target.value)}
                            className="glass squircle-sm mt-1 focus-visible:border-[rgb(7,27,27)] focus-visible:ring-[rgba(7,27,27,0.3)]"
                            style={{ borderColor: translucentSecondary }}
                            required
                          />
                        </div>
                        <div className="space-y-3">
                          <Label htmlFor="signup-confirm-password">Confirm Password</Label>
                          <Input
                            id="signup-confirm-password"
                            type="password"
                            value={signupConfirmPassword}
                            onChange={(e) => setSignupConfirmPassword(e.target.value)}
                            className="glass squircle-sm mt-1 focus-visible:border-[rgb(7,27,27)] focus-visible:ring-[rgba(7,27,27,0.3)]"
                            style={{ borderColor: translucentSecondary }}
                            required
                          />
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
                          className="font-semibold"
                          style={{ color: secondaryColor }}
                        >
                          Sign in
                        </button>
                      </p>
                    </div>
                  )}
                </DialogContent>
              </Dialog>
              <Button
                variant="outline"
                size="sm"
                onClick={handleCartClick}
                className="relative glass squircle-sm transition-all duration-300 hover:scale-105"
                style={{
                  color: secondaryColor,
                  borderColor: translucentSecondary,
                }}
              >
                <ShoppingCart className="h-4 w-4" style={{ color: secondaryColor }} />
                {cartItems > 0 && (
                  <Badge
                    className="absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center p-0 glass squircle-sm transition-all duration-300"
                    style={{
                      backgroundColor: secondaryColor,
                      color: '#f8fbfb',
                      borderColor: 'rgba(255,255,255,0.4)',
                    }}
                  >
                    {cartItems}
                  </Badge>
                )}
              </Button>
            </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

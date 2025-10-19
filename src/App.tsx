import { useState, useMemo, useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { FeaturedSection } from './components/FeaturedSection';
import { ProductCard, Product } from './components/ProductCard';
import { CategoryFilter } from './components/CategoryFilter';
import { CheckoutModal } from './components/CheckoutModal';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import { toast } from 'sonner@2.0.3';
import { Grid, List, ShoppingCart, Eye, EyeOff, ArrowRight } from 'lucide-react';
import { peptideProducts, peptideCategories, peptideTypes } from './data/peptideData';
import { authAPI, ordersAPI } from './services/api';
import { ProductDetailDialog } from './components/ProductDetailDialog';
import { LegalFooter } from './components/LegalFooter';
import { AuthActionResult } from './types/auth';

interface User {
  name: string;
  email: string;
  referralCode: string;
  referralCredits?: number;
  totalReferrals?: number;
}

interface CartItem {
  product: Product;
  quantity: number;
  note?: string;
}

interface FilterState {
  categories: string[];
  types: string[];
  inStockOnly: boolean;
  prescriptionOnly: boolean;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [productDetailOpen, setProductDetailOpen] = useState(false);
  const [loginPromptToken, setLoginPromptToken] = useState(0);
  const [shouldReopenCheckout, setShouldReopenCheckout] = useState(false);
  const [loginContext, setLoginContext] = useState<'checkout' | null>(null);
  const [landingAuthMode, setLandingAuthMode] = useState<'login' | 'signup'>('login');
  const [postLoginHold, setPostLoginHold] = useState(false);
  const [isReturningUser, setIsReturningUser] = useState(false);
  const prevUserRef = useRef<User | null>(null);
  const [showLandingLoginPassword, setShowLandingLoginPassword] = useState(false);
  const [showLandingSignupPassword, setShowLandingSignupPassword] = useState(false);
  const [showLandingSignupConfirm, setShowLandingSignupConfirm] = useState(false);

  // (handled directly in handleLogin/handleCreateAccount to avoid flicker)
  const [landingLoginError, setLandingLoginError] = useState('');
  const [landingSignupError, setLandingSignupError] = useState('');
  const [filters, setFilters] = useState<FilterState>({
    categories: [],
    types: [],
    inStockOnly: false,
    prescriptionOnly: false
  });
  const sidebarMotionRef = useRef<HTMLDivElement | null>(null);

  // Always start with a clean auth slate on fresh loads
  useEffect(() => {
    authAPI.logout();
  }, []);

  // Add springy scroll effect to sidebar
  useEffect(() => {
    let lastScrollY = window.scrollY;
    let ticking = false;

    const handleScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          const sidebar = document.querySelector('.filter-sidebar-container > *') as HTMLElement;
          if (sidebar && window.innerWidth >= 1024) {
            const currentScrollY = window.scrollY;
            const scrollDelta = currentScrollY - lastScrollY;
            const maxOffset = 40;
            const offset = Math.max(-maxOffset, Math.min(maxOffset, scrollDelta * 0.8));

            sidebar.style.transform = `translateY(${-offset}px)`;

            setTimeout(() => {
              sidebar.style.transform = 'translateY(0)';
            }, 150);

            lastScrollY = currentScrollY;
          }
          ticking = false;
        });
        ticking = true;
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    const closeAllDialogs = () => {
      setProductDetailOpen(false);
      setSelectedProduct(null);
      setCheckoutOpen(false);
    };
    window.addEventListener('peppro:close-dialogs', closeAllDialogs);
    return () => window.removeEventListener('peppro:close-dialogs', closeAllDialogs);
  }, []);

  // Login function connected to backend
  const handleLogin = async (email: string, password: string): Promise<AuthActionResult> => {
    console.debug('[Auth] Login attempt', { email });
    try {
      const user = await authAPI.login(email, password);
      setUser(user);
      setPostLoginHold(true);
      const isReturning = (user.visits ?? 1) > 1;
      setIsReturningUser(isReturning);
      toast.success(`${isReturning ? 'Welcome back' : 'Welcome to Peppro'}, ${user.name}!`);
      setLoginContext(null);
      setShowLandingLoginPassword(false);
      setShowLandingSignupPassword(false);
      setShowLandingSignupConfirm(false);
      console.debug('[Auth] Login success', { userId: user.id, visits: user.visits });
      return { status: 'success' };
    } catch (error: any) {
      console.warn('[Auth] Login failed', { email, error });
      const message = error.message || 'LOGIN_ERROR';

      if (message === 'EMAIL_NOT_FOUND') {
        return { status: 'email_not_found' };
      }

      if (message === 'INVALID_PASSWORD') {
        return { status: 'invalid_password' };
      }

      if (message === 'Invalid credentials' || message === 'INVALID_CREDENTIALS') {
        try {
          const result = await authAPI.checkEmail(email);
          return result.exists ? { status: 'invalid_password' } : { status: 'email_not_found' };
        } catch (lookupError: any) {
          return { status: 'email_not_found' };
        }
      }

      if (message === 'EMAIL_REQUIRED') {
        return { status: 'error', message };
      }

      return { status: 'error', message };
    }
  };

  // Create account function connected to backend
  const handleCreateAccount = async (details: {
    name: string;
    email: string;
    password: string;
    confirmPassword: string;
  }): Promise<AuthActionResult> => {
    console.debug('[Auth] Create account attempt', { email: details.email });
    try {
      if (details.password !== details.confirmPassword) {
        toast.error('Passwords do not match');
        return { status: 'error', message: 'PASSWORD_MISMATCH' };
      }

      const user = await authAPI.register(details.name, details.email, details.password);
      setUser(user);
      setPostLoginHold(true);
      setIsReturningUser(false);
      toast.success(`Welcome to Peppro, ${user.name}!`);
      console.debug('[Auth] Create account success', { userId: user.id });
      setLoginContext(null);
      setShowLandingLoginPassword(false);
      setShowLandingSignupPassword(false);
      setShowLandingSignupConfirm(false);
      return { status: 'success' };
    } catch (error: any) {
      console.warn('[Auth] Create account failed', { email: details.email, error });
      const message = error.message || 'REGISTER_ERROR';
      if (message === 'EMAIL_EXISTS') {
        return { status: 'email_exists' };
      }
      if (message === 'User already exists') {
        return { status: 'email_exists' };
      }
      return { status: 'error', message };
    }
  };

  const handleLogout = () => {
    console.debug('[Auth] Logout');
    authAPI.logout();
    setUser(null);
    setLoginContext(null);
    setPostLoginHold(false);
    setIsReturningUser(false);
    setCheckoutOpen(false);
    setShouldReopenCheckout(false);
    toast.success('Logged out successfully');
  };

  const handleAddToCart = (productId: string, quantity = 1, note?: string) => {
    console.debug('[Cart] Add to cart requested', { productId, quantity, note });
    const product = peptideProducts.find(p => p.id === productId);
    if (!product) return;

    const quantityToAdd = Math.max(1, Math.floor(quantity));

    setCartItems(prev => {
      const existingItem = prev.find(item => item.product.id === productId);
      if (existingItem) {
        return prev.map(item =>
          item.product.id === productId
            ? {
              ...item,
              quantity: item.quantity + quantityToAdd,
              note: note ?? item.note
            }
            : item
        );
      }
      return [...prev, { product, quantity: quantityToAdd, note }];
    });
    
    console.debug('[Cart] Add to cart success', { productId, quantity: quantityToAdd });
    toast.success(`${quantityToAdd} × ${product.name} added to cart`);
  };

  const handleSearch = (query: string) => {
    setSearchQuery(query);
  };

  const handleCheckout = async (referralCode?: string) => {
    console.debug('[Checkout] Attempt', { items: cartItems.length, referralCode });
    if (cartItems.length === 0) {
      toast.error('Your cart is empty');
      return;
    }

    const items = cartItems.map(({ product, quantity, note }) => ({
      productId: product.id,
      name: product.name,
      price: product.price,
      quantity,
      note: note ?? null
    }));

    const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

    try {
      const response = await ordersAPI.create(items, total, referralCode);
      setCartItems([]);
      toast.success('Order placed successfully!');
      if (response?.message) {
        toast.info(response.message);
      }
      console.debug('[Checkout] Success', { orderId: response?.id, total });
    } catch (error: any) {
      console.error('[Checkout] Failed', { error });
      const message = error?.message === 'Request failed'
        ? 'Unable to complete purchase. Please try again.'
        : error?.message ?? 'Unable to complete purchase. Please try again.';
      toast.error(message);
      throw error;
    }
  };

  const handleRequireLogin = () => {
    console.debug('[Checkout] Require login triggered');
    setCheckoutOpen(false);
    setLoginPromptToken((token) => token + 1);
    setShouldReopenCheckout(true);
    setLoginContext('checkout');
    setLandingAuthMode('login');
    QueueMicrotask(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  };

  const handleAdvanceFromWelcome = () => {
    console.debug('[Intro] Advance from welcome', { shouldReopenCheckout });
    setPostLoginHold(false);
    if (shouldReopenCheckout) {
      setCheckoutOpen(true);
      setShouldReopenCheckout(false);
    }
  };

  const handleUpdateCartItemQuantity = (productId: string, quantity: number) => {
    console.debug('[Cart] Update quantity', { productId, quantity });
    const normalized = Math.max(1, Math.floor(quantity || 1));
    setCartItems((prev) =>
      prev.map((item) =>
        item.product.id === productId
          ? { ...item, quantity: normalized }
          : item
      )
    );
  };

  const handleRemoveCartItem = (productId: string) => {
    console.debug('[Cart] Remove item', { productId });
    setCartItems((prev) => prev.filter((item) => item.product.id !== productId));
    toast.success('Item removed from cart');
  };

  const handleViewProduct = (product: Product) => {
    console.debug('[Product] View details', { productId: product.id });
    setSelectedProduct(product);
    setProductDetailOpen(true);
  };

  const handleCloseProductDetail = () => {
    console.debug('[Product] Close details');
    setProductDetailOpen(false);
    setSelectedProduct(null);
  };

  // Filter and search products
  const filteredProducts = useMemo(() => {
    let filtered = peptideProducts;

    // Search filter
    if (searchQuery) {
      filtered = filtered.filter(product =>
        product.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        product.category.toLowerCase().includes(searchQuery.toLowerCase()) ||
        product.manufacturer.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (product.description && product.description.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (product.benefits && product.benefits.toLowerCase().includes(searchQuery.toLowerCase()))
      );
    }

    // Category filter
    if (filters.categories.length > 0) {
      filtered = filtered.filter(product =>
        filters.categories.includes(product.category)
      );
    }

    // Stock filter
    if (filters.inStockOnly) {
      filtered = filtered.filter(product => product.inStock);
    }

    // Prescription filter
    if (filters.prescriptionOnly) {
      filtered = filtered.filter(product => product.prescription);
    }

    // Type filter
    if (filters.types.length > 0) {
      filtered = filtered.filter(product => product.type && filters.types.includes(product.type));
    }

    return filtered;
  }, [searchQuery, filters]);

  // Get product counts by category
  const productCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    peptideCategories.forEach(category => {
      counts[category] = peptideProducts.filter(product => product.category === category).length;
    });
    return counts;
  }, []);

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    peptideTypes.forEach(type => {
      counts[type] = peptideProducts.filter(product => product.type === type).length;
    });
    return counts;
  }, []);

  useEffect(() => {
    if (!sidebarMotionRef.current) return;

    const mediaQuery = window.matchMedia('(min-width: 1024px)');
    const smoothing = 0.18;
    const stopThreshold = 0.4;
    const maxOffset = 160;

    let frame = 0;
    let eased = window.scrollY;
    let lastTime = performance.now();

    const stop = () => {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      const el = sidebarMotionRef.current;
      if (el) {
        el.style.transform = '';
      }
      eased = window.scrollY;
      lastTime = performance.now();
    };

    const step = (time: number) => {
      const el = sidebarMotionRef.current;
      if (!el || !mediaQuery.matches) {
        stop();
        return;
      }

      const dt = Math.min((time - lastTime) / 1000, 0.1);
      lastTime = time;

      const target = window.scrollY;
      const alpha = 1 - Math.exp(-dt / smoothing);
      eased += (target - eased) * alpha;

      let offset = target - eased;
      offset = Math.max(Math.min(offset, maxOffset), -maxOffset);

      if (Math.abs(offset) <= stopThreshold) {
        stop();
        return;
      }

      el.style.transform = `translate3d(0, ${offset.toFixed(2)}px, 0)`;
      frame = requestAnimationFrame(step);
    };

    const ensureRunning = () => {
      if (!mediaQuery.matches || frame) {
        return;
      }
      eased = window.scrollY;
      lastTime = performance.now();
      frame = requestAnimationFrame(step);
    };

    const handleScroll = () => {
      ensureRunning();
    };

    const handleChange = () => {
      stop();
      if (mediaQuery.matches) {
        ensureRunning();
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    mediaQuery.addEventListener('change', handleChange);
    ensureRunning();

    return () => {
      stop();
      mediaQuery.removeEventListener('change', handleChange);
      window.removeEventListener('scroll', handleScroll);
    };
  }, []);

  // Get featured products
  const featuredProducts = peptideProducts.slice(0, 4);

  const totalCartItems = cartItems.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <div
      className="min-h-screen bg-slate-50"
      style={{
        position: 'static',
      }}
    >
      {/* Ambient background texture */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          backgroundImage: 'url(/leafTexture.jpg)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
          zIndex: 0,
          pointerEvents: 'none',
          maskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.15) 40%, rgba(0,0,0,0.05) 70%, rgba(0,0,0,0) 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.50) 0%, rgba(0,0,0,0.15) 40%, rgba(0,0,0,0.05) 50%, rgba(0,0,0,0) 100%)'
        }}
      />
      {/* Header - Only show when logged in */}
      {user && !postLoginHold && (
        <Header
          user={user}
          onLogin={handleLogin}
          onLogout={handleLogout}
          cartItems={totalCartItems}
          onSearch={handleSearch}
          onCreateAccount={handleCreateAccount}
          onCartClick={() => setCheckoutOpen(true)}
          loginPromptToken={loginPromptToken}
          loginContext={loginContext}
        />
      )}

      {/* Landing Page - Show when not logged in */}
      {(!user || postLoginHold) && (
        <div className="min-h-screen flex flex-col items-center px-4 py-12">
          {/* Logo */}
          <div className={`flex justify-center pt-20 ${
            landingAuthMode === 'signup' ? 'mb-6 sm:mb-8 lg:mb-12' : 'mb-12 sm:mb-12 lg:mb-20'
          }`}>
            <div className="brand-logo">
              <img
                src="/Peppro_FullLogo_Transparent_NoBuffer.png"
                alt="Peppro"
                style={{
                  display: 'block',
                  width: 'auto',
                  height: 'auto',
                  maxWidth: '280px',
                  maxHeight: '280px',
                  objectFit: 'contain'
                }}
              />
            </div>
          </div>

          {/* Auth Card */}
          <div className={`w-full max-w-md ${
            landingAuthMode === 'signup' ? 'mt-3 sm:mt-4 md:mt-6' : 'mt-4 sm:mt-6 md:mt-8'
          }`}>
          <div className="glass-card landing-glass squircle-xl border border-[var(--brand-glass-border-2)] p-8 shadow-xl">
              <div className={landingAuthMode === 'login' ? 'space-y-4' : 'space-y-6'}>
                {postLoginHold && user ? (
                  <div className="relative flex flex-col gap-6 max-h-[70vh]">
                    <div className="flex-1 overflow-y-auto pr-1 space-y-12">
                      <div className="text-center">
                        {/* Add introductory copy for returning or new customers here */}
                      </div>

                      <section className="squircle glass-card landing-glass border border-[var(--brand-glass-border-2)] p-6 shadow-sm">
                        <h2 className="text-lg sm:text-xl font-semibold text-[rgb(7,27,27)]">Customer experiences & referrals</h2>
                        <div className="mt-4 grid gap-4 sm:grid-cols-2">
                          {/* Provide customer testimonials, referral stories, or metrics here */}
                        </div>
                        <div className="mt-4 text-sm text-gray-600">
                          {/* Add referral program call-to-action or highlight here */}
                        </div>
                      </section>

                      <div className="grid gap-10 md:grid-cols-[1.15fr_0.85fr]">
                        <section className="squircle glass-card landing-glass border border-[var(--brand-glass-border-2)] p-6 shadow-sm">
                          <h3 className="text-lg font-semibold text-[rgb(7,27,27)]">Shipping & handling pipeline</h3>
                          <div className="mt-2 text-sm text-gray-600">
                            {/* Insert overview of your logistics, fulfillment partners, or SLAs */}
                          </div>
                          <ol className="mt-4 space-y-3 text-sm text-gray-700">
                            {/* Outline each stage in your fulfillment pipeline */}
                          </ol>
                          <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-[rgb(7,27,27)]">
                            {/* Add badges, SLAs, or support commitments */}
                          </div>
                        </section>
                        <section className="squircle glass-card landing-glass border border-[var(--brand-glass-border-2)] p-6 shadow-sm">
                          <figure className="space-y-4">
                            <img
                              src="/Placeholder.png"
                              alt="Peppro fulfillment specialists preparing temperature-controlled shipments"
                              className="w-full squircle object-cover shadow-md"
                            />
                            <figcaption className="text-xs text-gray-500">
                              {/* Supply supporting caption or accreditation */}
                            </figcaption>
                          </figure>
                        </section>
                      </div>

                      <section className="squircle glass-strong landing-glass-strong border border-[var(--brand-glass-border-3)] p-6 text-slate-900 shadow-sm">
                        <h3 className="text-lg font-semibold">Compliance & legal essentials</h3>
                        <ul className="mt-4 space-y-2 text-sm list-disc list-inside">
                          {/* Enumerate legal obligations, storage requirements, or policy acknowledgements */}
                        </ul>
                        <div className="mt-4 text-xs text-slate-300">
                          {/* Provide compliance contact details or escalation paths */}
                        </div>
                      </section>
                    </div>

                    <div className="-mx-8 px-8 pb-2">
                    <div
                        className="sticky bottom-0 flex w-full glass-strong landing-glass-strong border-t border-[var(--brand-glass-border-2)] pt-4 pb-2 shadow-[0_-10px_30px_-18px_rgba(7,27,27,0.45)]"
                        style={{ justifyContent: 'flex-end' }}
                      >
                        <Button
                          type="button"
                          size="lg"
                          onClick={handleAdvanceFromWelcome}
                          className="ml-auto bg-[#071B1B] hover:bg-[#0c2d2d] text-white squircle-sm px-6 py-2 font-semibold uppercase tracking-wide shadow-lg shadow-[rgba(7,27,27,0.4)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[rgba(7,27,27,0.35)] focus-visible:ring-offset-2 focus-visible:ring-offset-white transition-all duration-300 hover:shadow-xl hover:scale-105 hover:-translate-y-0.5 active:translate-y-0"
                          style={{ backgroundColor: '#071B1B' }}
                        >
                          <span className="mr-2">Next</span>
                          <ArrowRight className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : landingAuthMode === 'login' ? (
                  <>
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        setLandingLoginError('');
                        const fd = new FormData(e.currentTarget);
                        const res = await handleLogin(fd.get('email') as string, fd.get('password') as string);
                        if (res.status !== 'success') {
                          if (res.status === 'invalid_password') setLandingLoginError('Incorrect password. Please try again.');
                          else if (res.status === 'email_not_found') setLandingLoginError('We could not find that email.');
                          else setLandingLoginError('Unable to log in. Please try again.');
                        }
                      }}
                      className="space-y-3"
                    >
                      <div className="space-y-2">
                        <label htmlFor="landing-email" className="text-sm font-medium">Email</label>
                        <input id="landing-email" name="email" type="email" autoComplete="email" required className="w-full h-10 px-3 squircle-sm border border-slate-200/70 bg-white/96 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30" />
                      </div>
                      <div className="space-y-2">
                        <label htmlFor="landing-password" className="text-sm font-medium">Password</label>
                        <div className="relative">
                          <input id="landing-password" name="password" type={showLandingLoginPassword ? 'text' : 'password'} autoComplete="current-password" required className="w-full h-10 px-3 pr-12 squircle-sm border border-slate-200/70 bg-white/96 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30" />
                          <button
                            type="button"
                            onClick={() => setShowLandingLoginPassword((p) => !p)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-md text-gray-600 hover:text-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[rgba(7,27,27,0.3)] btn-hover-lighter"
                            aria-label={showLandingLoginPassword ? 'Hide password' : 'Show password'}
                            aria-pressed={showLandingLoginPassword}
                          >
                            {showLandingLoginPassword ? (
                              <Eye className="h-5 w-5" />
                            ) : (
                              <EyeOff className="h-5 w-5" />
                            )}
                          </button>
                        </div>
                      </div>
                      {landingLoginError && (
                        <p className="text-sm text-red-600" role="alert">{landingLoginError}</p>
                      )}
                      <button type="submit" className="w-full h-10 squircle-sm shadow-sm font-medium transition-all duration-300 hover:scale-105 btn-hover-lighter" style={{ backgroundColor: 'rgb(7, 27, 27)', color: '#fff', border: 'none' }}>Sign In</button>
                    </form>
                    <div className="text-center">
                      <p className="text-sm text-gray-600">
                        New to Peppro?{' '}
                        <button type="button" onClick={() => setLandingAuthMode('signup')} className="font-semibold hover:underline btn-hover-lighter" style={{ color: 'rgb(7, 27, 27)' }}>
                          Create an account
                        </button>
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-center space-y-2">
                      <h1 className="text-2xl font-semibold">Create Account</h1>
                      <p className="text-sm text-gray-600">Set up your Peppro account in moments.</p>
                    </div>
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        setLandingSignupError('');
                        const fd = new FormData(e.currentTarget);
                        const suffix = (fd.get('suffix') as string) || '';
                        const nameOnly = (fd.get('name') as string) || '';
                        const fullName = suffix ? `${suffix} ${nameOnly}`.trim() : nameOnly;
                        const details = {
                          name: fullName,
                          email: (fd.get('email') as string) || '',
                          password: (fd.get('password') as string) || '',
                          confirmPassword: (fd.get('confirm') as string) || ''
                        };
                        const res = await handleCreateAccount(details);
                        if (res.status === 'success') {
                          setLandingAuthMode('login');
                        } else if (res.status === 'email_exists') {
                          setLandingSignupError('An account with this email already exists. Please sign in.');
                        } else if (res.status === 'error') {
                          setLandingSignupError('Unable to create account. Please try again.');
                        }
                      }}
                      className="space-y-4"
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-4">
                        <div className="space-y-2 sm:w-36">
                          <label htmlFor="landing-suffix" className="text-sm font-medium">Suffix</label>
                          <select
                            id="landing-suffix"
                            name="suffix"
                            className="glass squircle-sm mt-1 h-10 w-full px-3 text-sm border transition-colors focus-visible:outline-none focus-visible:border-[rgb(7,27,27)] focus-visible:ring-[rgba(7,27,27,0.3)]"
                            style={{
                              borderColor: 'rgba(7,27,27,0.18)',
                              backgroundColor: 'rgba(7,27,27,0.02)',
                              WebkitAppearance: 'none' as any,
                              MozAppearance: 'none' as any,
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
                        <div className="flex-1 space-y-2">
                          <label htmlFor="landing-name" className="text-sm font-medium">Full Name</label>
                          <input id="landing-name" name="name" type="text" required className="w-full h-10 px-3 squircle-sm border border-slate-200/70 bg-white/96 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30" />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <label htmlFor="landing-email2" className="text-sm font-medium">Email</label>
                        <input id="landing-email2" name="email" type="email" required className="w-full h-10 px-3 squircle-sm border border-slate-200/70 bg-white/96 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30" />
                      </div>
                      <div className="space-y-2">
                        <label htmlFor="landing-password2" className="text-sm font-medium">Password</label>
                        <div className="relative">
                          <input id="landing-password2" name="password" type={showLandingSignupPassword ? 'text' : 'password'} required className="w-full h-10 px-3 pr-12 squircle-sm border border-slate-200/70 bg-white/96 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30" />
                          <button
                            type="button"
                            onClick={() => setShowLandingSignupPassword((p) => !p)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-md text-gray-600 hover:text-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[rgba(7,27,27,0.3)] btn-hover-lighter"
                            aria-label={showLandingSignupPassword ? 'Hide password' : 'Show password'}
                            aria-pressed={showLandingSignupPassword}
                          >
                            {showLandingSignupPassword ? (
                              <Eye className="h-5 w-5" />
                            ) : (
                              <EyeOff className="h-5 w-5" />
                            )}
                          </button>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <label htmlFor="landing-confirm" className="text-sm font-medium">Confirm Password</label>
                        <div className="relative">
                          <input id="landing-confirm" name="confirm" type={showLandingSignupConfirm ? 'text' : 'password'} required className="w-full h-10 px-3 pr-12 squircle-sm border border-slate-200/70 bg-white/96 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30" />
                          <button
                            type="button"
                            onClick={() => setShowLandingSignupConfirm((p) => !p)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-md text-gray-600 hover:text-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[rgba(7,27,27,0.3)] btn-hover-lighter"
                            aria-label={showLandingSignupConfirm ? 'Hide confirm password' : 'Show confirm password'}
                            aria-pressed={showLandingSignupConfirm}
                          >
                            {showLandingSignupConfirm ? (
                              <Eye className="h-5 w-5" />
                            ) : (
                              <EyeOff className="h-5 w-5" />
                            )}
                          </button>
                        </div>
                      </div>
                      {landingSignupError && (
                        <p className="text-sm text-red-600" role="alert">{landingSignupError}</p>
                      )}
                      <button type="submit" className="w-full h-10 squircle-sm shadow-sm font-medium transition-all duration-300 hover:scale-105 btn-hover-lighter" style={{ backgroundColor: 'rgb(7, 27, 27)', color: '#fff', border: 'none' }}>Create Account</button>
                    </form>
                    <div className="text-center">
                      <p className="text-sm text-gray-600">
                        Already have an account?{' '}
                        <button type="button" onClick={() => setLandingAuthMode('login')} className="font-semibold hover:underline btn-hover-lighter" style={{ color: 'rgb(7, 27, 27)' }}>
                          Sign in
                        </button>
                      </p>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main Content */}
      {user && !postLoginHold && (
        <main className="container mx-auto px-4 py-8">
        {/* Products Section */}
        <div className="products-layout">
          {/* Filters Sidebar */}
          <div className="filter-sidebar-container lg:min-w-[18rem] lg:max-w-[24rem] xl:min-w-[20rem] xl:max-w-[26rem]">
            <div ref={sidebarMotionRef} className="filter-sidebar-content">
              <CategoryFilter
                categories={peptideCategories}
                types={peptideTypes}
                filters={filters}
                onFiltersChange={setFilters}
                productCounts={productCounts}
                typeCounts={typeCounts}
              />
            </div>
          </div>

          {/* Products Grid */}
          <div className="w-full min-w-0 flex-1">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-4">
                <h2>Products</h2>
                <Badge variant="outline" className="squircle-sm glass-strong border border-[var(--brand-glass-border-2)] text-[rgb(7,27,27)]">
                  {filteredProducts.length} items
                </Badge>
                {searchQuery && (
                  <Badge variant="outline" className="squircle-sm">
                    Search: "{searchQuery}"
                  </Badge>
                )}
              </div>
              
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  aria-pressed={viewMode === 'grid'}
                  onClick={() => setViewMode('grid')}
                  className={`glass squircle-sm text-[rgb(7,27,27)] transition-all duration-300 ease-out flex items-center justify-center ${
                    viewMode === 'grid'
                      ? 'h-14 w-14 ring-2 ring-primary/60 glass-strong shadow-[0_24px_60px_-36px_rgba(7,27,27,0.45)]'
                      : 'h-8.5 w-8.5 opacity-70 shadow-[0_6px_16px_-14px_rgba(7,27,27,0.25)]'
                  }`}
                >
                  <Grid className={`transition-transform duration-300 ${viewMode === 'grid' ? 'scale-110' : 'scale-95'}`} />
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setViewMode('list')}
                  aria-pressed={viewMode === 'list'}
                  className={`glass squircle-sm text-[rgb(7,27,27)] transition-all duration-300 ease-out flex items-center justify-center ${
                    viewMode === 'list'
                      ? 'h-14 w-14 ring-2 ring-primary/60 glass-strong shadow-[0_24px_60px_-36px_rgba(7,27,27,0.45)]'
                      : 'h-8.5 w-8.5 opacity-70 shadow-[0_6px_16px_-14px_rgba(7,27,27,0.25)]'
                  }`}
                >
                  <List className={`transition-transform duration-300 ${viewMode === 'list' ? 'scale-110' : 'scale-95'}`} />
                </Button>
                
                {totalCartItems > 0 && (
                  <Button
                    variant="ghost"
                    onClick={() => setCheckoutOpen(true)}
                    className="squircle-sm glass-strong text-[rgb(7,27,27)] border border-[var(--brand-glass-border-2)] transition-all duration-200"
                  >
                    <ShoppingCart className="w-4 h-4 mr-2" />
                    Checkout ({totalCartItems})
                  </Button>
                )}
              </div>
            </div>

            {filteredProducts.length > 0 ? (
              <div className={`grid gap-6 w-full ${
                viewMode === 'grid' 
                  ? 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3' 
                  : 'grid-cols-1'
              }`}>
                {filteredProducts.map((product) => (
                  <ProductCard
                    key={product.id}
                    product={product}
                    onAddToCart={handleAddToCart}
                    onViewDetails={handleViewProduct}
                    viewMode={viewMode}
                  />
                ))}
              </div>
            ) : (
              <div className="text-center py-12">
                <div className="glass-card squircle-lg p-8 max-w-md mx-auto">
                  <h3 className="mb-2">No products found</h3>
                  <p className="text-gray-600">Try adjusting your filters or search terms.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
      )}

      {/* Footer */}
      <LegalFooter />

      {/* Checkout Modal */}
      <CheckoutModal
        isOpen={checkoutOpen}
        onClose={() => setCheckoutOpen(false)}
        cartItems={cartItems}
        userReferralCode={user?.referralCode}
        onCheckout={handleCheckout}
        onUpdateItemQuantity={handleUpdateCartItemQuantity}
        onRemoveItem={handleRemoveCartItem}
        isAuthenticated={Boolean(user)}
        onRequireLogin={handleRequireLogin}
      />

      <ProductDetailDialog
        product={selectedProduct}
        isOpen={productDetailOpen}
        onClose={handleCloseProductDetail}
        onAddToCart={handleAddToCart}
      />
    </div>
  );
}

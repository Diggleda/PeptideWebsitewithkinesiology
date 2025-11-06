import { useState, useMemo, useEffect, useRef, useCallback, FormEvent, ReactNode } from 'react';
import { Header } from './components/Header';
import { FeaturedSection } from './components/FeaturedSection';
import { ProductCard, Product } from './components/ProductCard';
import { CategoryFilter } from './components/CategoryFilter';
import { CheckoutModal } from './components/CheckoutModal';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import { toast } from 'sonner@2.0.3';
import { Grid, List, ShoppingCart, Eye, EyeOff, ArrowRight, ArrowLeft, ChevronRight, RefreshCw, ArrowUpDown } from 'lucide-react';
import { peptideProducts, peptideCategories, peptideTypes } from './data/peptideData';
import { authAPI, ordersAPI, referralAPI, newsAPI, quotesAPI, checkServerHealth } from './services/api';
import { ProductDetailDialog } from './components/ProductDetailDialog';
import { LegalFooter } from './components/LegalFooter';
import { AuthActionResult } from './types/auth';
import { DoctorCreditSummary, ReferralRecord, SalesRepDashboard } from './types/referral';
import { listProducts, listCategories } from './lib/wooClient';

interface User {
  id: string;
  name: string;
  email: string;
  referralCode?: string | null;
  role: 'doctor' | 'sales_rep' | string;
  salesRepId?: string | null;
  salesRep?: {
    id: string;
    name?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
  referrerDoctorId?: string | null;
  phone?: string | null;
  referralCredits?: number;
  totalReferrals?: number;
  mustResetPassword?: boolean;
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
}

type WooImage = { src?: string | null };
type WooCategory = { id: number; name: string };
type WooMeta = { key?: string | null; value?: string | null };

interface WooProduct {
  id: number;
  name: string;
  price?: string;
  regular_price?: string;
  images?: WooImage[];
  categories?: WooCategory[];
  stock_status?: string;
  average_rating?: string;
  rating_count?: number;
  sku?: string;
  type?: string;
  short_description?: string;
  description?: string;
  meta_data?: WooMeta[];
}

interface PeptideNewsItem {
  title: string;
  url: string;
  summary?: string;
  image?: string;
  date?: string;
}

const WOO_PLACEHOLDER_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 400'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0%25' stop-color='%2395C5F9'/%3E%3Cstop offset='100%25' stop-color='%235FB3F9'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='400' height='400' fill='url(%23g)'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' font-family='Arial' font-size='28' fill='rgba(255,255,255,0.75)'%3EWoo Product%3C/text%3E%3C/svg%3E";

const PEPTIDE_NEWS_PLACEHOLDER_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'%3E%3Cdefs%3E%3ClinearGradient id='grad' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0%25' stop-color='%23B7D8F9'/%3E%3Cstop offset='100%25' stop-color='%2395C5F9'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='120' height='120' rx='16' fill='url(%23grad)'/%3E%3Cpath d='M35 80l15-18 12 14 11-12 12 16' stroke='%23ffffff' stroke-width='5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3Ccircle cx='44' cy='43' r='9' fill='none' stroke='%23ffffff' stroke-width='5'/%3E%3C/svg%3E";

const stripHtml = (value?: string | null): string =>
  value ? value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';

const formatNewsDate = (dateString?: string | null): string => {
  if (!dateString) return '';
  try {
    // Parse ISO date string (YYYY-MM-DD) to avoid timezone issues
    const parts = dateString.split('-');
    if (parts.length === 3) {
      const year = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1; // Month is 0-indexed
      const day = parseInt(parts[2], 10);
      const date = new Date(year, month, day);
      if (!isNaN(date.getTime())) {
        const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
        return date.toLocaleDateString('en-US', options);
      }
    }
    return dateString;
  } catch {
    return dateString;
  }
};

const mapWooProductToProduct = (product: WooProduct): Product => {
  const imageSources = (product.images ?? [])
    .map((image) => image?.src)
    .filter((src): src is string => Boolean(src));

  const categoryName = product.categories?.[0]?.name ?? 'WooCommerce';

  const parsePrice = (value?: string) => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const price = parsePrice(product.price) ?? parsePrice(product.regular_price) ?? 0;
  const originalPrice = parsePrice(product.regular_price);
  const cleanedDescription = stripHtml(product.short_description || product.description);
  const manufacturerMeta = product.meta_data?.find((meta) => meta?.key === 'manufacturer')?.value;

  return {
    id: `woo-${product.id}`,
    name: stripHtml(product.name) || `Product ${product.id}`,
    category: categoryName,
    price,
    originalPrice: originalPrice && originalPrice > price ? originalPrice : undefined,
    rating: Number.parseFloat(product.average_rating || '') || 5,
    reviews: Number.isFinite(product.rating_count) ? Number(product.rating_count) : 0,
    image: imageSources[0] ?? WOO_PLACEHOLDER_IMAGE,
    images: imageSources.length > 0 ? imageSources : [WOO_PLACEHOLDER_IMAGE],
    inStock: (product.stock_status ?? '').toLowerCase() !== 'outofstock',
    prescription: false,
    dosage: product.sku ? `SKU ${product.sku}` : 'See details',
    manufacturer: stripHtml(typeof manufacturerMeta === 'string' ? manufacturerMeta : '') || 'WooCommerce Catalog',
    type: product.type ?? 'General',
    description: cleanedDescription || undefined,
  };
};

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
  const checkoutButtonObserverRef = useRef<IntersectionObserver | null>(null);
  const [isCheckoutButtonVisible, setIsCheckoutButtonVisible] = useState(false);
  const filterSidebarRef = useRef<HTMLDivElement | null>(null);

  // (handled directly in handleLogin/handleCreateAccount to avoid flicker)
  const [landingLoginError, setLandingLoginError] = useState('');
  const [landingSignupError, setLandingSignupError] = useState('');
  const [filters, setFilters] = useState<FilterState>({
    categories: [],
    types: [],
    inStockOnly: false
  });
  const [doctorSummary, setDoctorSummary] = useState<DoctorCreditSummary | null>(null);
  const [doctorReferrals, setDoctorReferrals] = useState<ReferralRecord[]>([]);
  const [salesRepDashboard, setSalesRepDashboard] = useState<SalesRepDashboard | null>(null);
  const [salesRepStatusFilter, setSalesRepStatusFilter] = useState<string>('all');
  const [referralForm, setReferralForm] = useState({
    contactName: '',
    contactEmail: '',
    contactPhone: '',
    notes: '',
  });
  const [referralSubmitting, setReferralSubmitting] = useState(false);
  const [referralStatusMessage, setReferralStatusMessage] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [referralDataLoading, setReferralDataLoading] = useState(false);
  const [referralDataError, setReferralDataError] = useState<ReactNode>(null);
  const referralRefreshInFlight = useRef(false);
  const [adminActionState, setAdminActionState] = useState<{
    updatingReferral: string | null;
    error: string | null;
  }>({
    updatingReferral: null,
    error: null,
  });
  const [catalogProducts, setCatalogProducts] = useState<Product[]>(peptideProducts);
  const [catalogCategories, setCatalogCategories] = useState<string[]>(peptideCategories);
  const [catalogTypes, setCatalogTypes] = useState<string[]>(peptideTypes);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [peptideNews, setPeptideNews] = useState<PeptideNewsItem[]>([]);
  const [peptideNewsLoading, setPeptideNewsLoading] = useState(false);
  const [peptideNewsError, setPeptideNewsError] = useState<string | null>(null);
  const [peptideNewsUpdatedAt, setPeptideNewsUpdatedAt] = useState<Date | null>(null);
  const [isReferralSectionExpanded, setIsReferralSectionExpanded] = useState(false);
  const [quoteOfTheDay, setQuoteOfTheDay] = useState<{ text: string; author: string } | null>(null);
  const [showWelcome, setShowWelcome] = useState(false);
  const [showQuote, setShowQuote] = useState(false);
  const [referralSearchTerm, setReferralSearchTerm] = useState('');
  const [referralSortOrder, setReferralSortOrder] = useState<'desc' | 'asc'>('desc');
  const [isDesktopLandingLayout, setIsDesktopLandingLayout] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth >= 1024;
  });

  const filteredDoctorReferrals = useMemo(() => {
    const normalizedQuery = referralSearchTerm.trim().toLowerCase();
    const sorted = [...doctorReferrals].sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return referralSortOrder === 'desc' ? bTime - aTime : aTime - bTime;
    });

    if (!normalizedQuery) {
      return sorted;
    }

    return sorted.filter((referral) => {
      const haystack = [
        referral.referredContactName ?? '',
        referral.referredContactEmail ?? '',
        referral.referredContactPhone ?? '',
        referral.status ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [doctorReferrals, referralSearchTerm, referralSortOrder]);

  const salesRepStatusOptions = useMemo(() => {
    if (!salesRepDashboard) {
      return [] as string[];
    }
    if (Array.isArray(salesRepDashboard.statuses) && salesRepDashboard.statuses.length > 0) {
      return Array.from(new Set(salesRepDashboard.statuses.map((status) => (status || '').trim()))).filter(Boolean);
    }
    return Array.from(
      new Set((salesRepDashboard.referrals ?? []).map((referral) => (referral.status || '').trim()).filter(Boolean))
    );
  }, [salesRepDashboard]);

  const filteredSalesRepReferrals = useMemo(() => {
    const allReferrals = salesRepDashboard?.referrals ?? [];
    console.debug('[Referral] Filter compute', {
      filter: salesRepStatusFilter,
      total: allReferrals.length,
    });
    if (salesRepStatusFilter === 'all') {
      return allReferrals;
    }
    const filtered = allReferrals.filter(
      (referral) => (referral.status || '').toLowerCase() === salesRepStatusFilter.toLowerCase()
    );
    console.debug('[Referral] Filter result', { filter: salesRepStatusFilter, count: filtered.length });
    return filtered;
  }, [salesRepDashboard, salesRepStatusFilter]);

  const handleReferralSortToggle = useCallback(() => {
    setReferralSortOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'));
  }, []);

  const sortDirectionLabel = referralSortOrder === 'desc' ? 'Newest first' : 'Oldest first';

  useEffect(() => {
    if (salesRepStatusFilter === 'all') {
      return;
    }
    const available = new Set(salesRepStatusOptions.map((status) => status.toLowerCase()));
    if (!available.has(salesRepStatusFilter.toLowerCase())) {
      setSalesRepStatusFilter('all');
    }
  }, [salesRepStatusFilter, salesRepStatusOptions]);

  const refreshReferralData = useCallback(async (options?: { showLoading?: boolean }) => {
    if (!user) {
      console.debug('[Referral] refreshReferralData skipped: no user');
      return;
    }

    const shouldShowLoading = options?.showLoading ?? true;

    if (referralRefreshInFlight.current) {
      if (shouldShowLoading) {
        setReferralDataLoading(true);
      }
      return;
    }

    referralRefreshInFlight.current = true;

    if (shouldShowLoading) {
      setReferralDataLoading(true);
    }

    console.debug('[Referral] Refresh start', { role: user.role, userId: user.id });

    try {
      setReferralDataError(null);
      if (user.role === 'doctor') {
        const response = await referralAPI.getDoctorSummary();
        const referrals = Array.isArray(response?.referrals) ? response.referrals : [];
        const credits = response?.credits ?? {};

        const normalizedCredits: DoctorCreditSummary = {
          totalCredits: Number(credits.totalCredits ?? 0),
          firstOrderBonuses: Number(credits.firstOrderBonuses ?? 0),
          ledger: Array.isArray(credits.ledger) ? credits.ledger : [],
        };

        setDoctorSummary({ ...normalizedCredits });
        const normalizedReferrals = referrals.map((referral) => ({ ...referral }));
        setDoctorReferrals(normalizedReferrals);
        setUser((previous) => {
          if (!previous) {
            return previous;
          }
          const nextCredits = normalizedCredits.totalCredits;
          const nextTotalReferrals = normalizedReferrals.length;
          const unchanged =
            Number(previous.referralCredits ?? 0) === nextCredits &&
            Number(previous.totalReferrals ?? 0) === nextTotalReferrals;
          if (unchanged) {
            return previous;
          }
          return {
            ...previous,
            referralCredits: nextCredits,
            totalReferrals: nextTotalReferrals,
          };
        });
        console.debug('[Referral] Doctor summary loaded', {
          referrals: normalizedReferrals.length,
          credits: normalizedCredits,
        });
      } else if (user.role === 'sales_rep') {
        const dashboard = await referralAPI.getSalesRepDashboard();
        setSalesRepDashboard(dashboard);
        console.debug('[Referral] Sales rep dashboard loaded', {
          referrals: dashboard?.referrals?.length ?? 0,
          statuses: dashboard?.statuses ?? null,
        });
      } else {
        console.debug('[Referral] Refresh skipped for role', { role: user.role });
      }
    } catch (error: any) {
      const status = typeof error?.status === 'number' ? error.status : null;
      const message = typeof error?.message === 'string' ? error.message : 'UNKNOWN_ERROR';
      console.warn('[Referral] Failed to load data', { status, message, error });
      setReferralDataError(
        <>
          There is an issue in loading your referral data. Please refresh the page or contact{' '}
          <a className="text-[rgb(95,179,249)] underline" href="mailto:support@peppro.net">
            support@peppro.net
          </a>
          .
        </>,
      );
    } finally {
      console.debug('[Referral] Refresh complete', { role: user.role });
      referralRefreshInFlight.current = false;
      if (shouldShowLoading) {
        setReferralDataLoading(false);
      }
    }
  }, [user, setUser]);

  const formatDate = useCallback((value?: string | null) => {
    if (!value) {
      return '—';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }, []);

  const formatDateTime = useCallback((value?: string | null) => {
    if (!value) {
      return '—';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }, []);

  const formatReferralStatus = useCallback((status: string) => {
    if (!status) {
      return 'Unknown';
    }
    return status
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }, []);
  const checkoutButtonRef = useCallback((node: HTMLButtonElement | null) => {
    if (checkoutButtonObserverRef.current) {
      checkoutButtonObserverRef.current.disconnect();
      checkoutButtonObserverRef.current = null;
    }

    if (!node || typeof IntersectionObserver === 'undefined') {
      setIsCheckoutButtonVisible(false);
      return;
    }

    const observer = new IntersectionObserver(([entry]) => {
      setIsCheckoutButtonVisible(entry.isIntersecting);
    }, {
      rootMargin: '-10% 0px 0px 0px',
    });

    observer.observe(node);
    checkoutButtonObserverRef.current = observer;
  }, []);

  // Always start with a clean auth slate on fresh loads
  useEffect(() => {
    authAPI.logout();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    let cancelled = false;
    const loadCatalog = async () => {
      setCatalogLoading(true);
      setCatalogError(null);
      try {
        const [wooProducts, wooCategories] = await Promise.all([
          listProducts<WooProduct[]>({ per_page: 48, status: 'publish' }),
          listCategories<WooCategory[]>({ per_page: 100 }),
        ]);

        if (cancelled) {
          return;
        }

        const mappedProducts = (wooProducts ?? [])
          .filter((item): item is WooProduct => Boolean(item && typeof item === 'object' && 'id' in item))
          .map(mapWooProductToProduct)
          .filter((product) => product && product.name);

        if (mappedProducts.length > 0) {
          setCatalogProducts(mappedProducts);
          const categoriesFromProducts = Array.from(
            new Set(mappedProducts.map((product) => product.category).filter(Boolean)),
          );
          const categoryNamesFromApi = Array.isArray(wooCategories)
            ? wooCategories.map((category) => category?.name).filter((name): name is string => Boolean(name))
            : [];
          const nextCategories =
            categoriesFromProducts.length > 0
              ? categoriesFromProducts
              : categoryNamesFromApi.length > 0
                ? categoryNamesFromApi
                : peptideCategories;
          setCatalogCategories(nextCategories);

          const typesFromProducts = Array.from(
            new Set(mappedProducts.map((product) => product.type).filter(Boolean)),
          ) as string[];
          setCatalogTypes(typesFromProducts.length > 0 ? typesFromProducts : peptideTypes);
        } else if (Array.isArray(wooCategories) && wooCategories.length > 0) {
          const categoryNames = wooCategories
            .map((category) => category?.name)
            .filter((name): name is string => Boolean(name));
          if (categoryNames.length > 0) {
            setCatalogCategories(categoryNames);
          }
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('[WooCommerce] Catalog fetch failed', error);
          setCatalogError(error instanceof Error ? error.message : 'Unable to load WooCommerce catalog.');
        }
      } finally {
        if (!cancelled) {
          setCatalogLoading(false);
        }
      }
    };

    loadCatalog();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadPeptideNews = async () => {
      setPeptideNewsLoading(true);
      setPeptideNewsError(null);

      try {
        const data = await newsAPI.getPeptideHeadlines();
        if (cancelled) {
          return;
        }

        const items = Array.isArray(data?.items)
          ? data.items
            .map((item: any) => ({
              title: typeof item?.title === 'string' ? item.title.trim() : '',
              url: typeof item?.url === 'string' ? item.url.trim() : '',
              summary: typeof item?.summary === 'string' && item.summary.trim() ? item.summary.trim() : undefined,
              image: typeof item?.imageUrl === 'string' && item.imageUrl.trim() ? item.imageUrl.trim() : undefined,
              date: typeof item?.date === 'string' && item.date.trim() ? item.date.trim() : undefined,
            }))
            .filter((item) => item.title && item.url)
          : [];

        if (items.length === 0) {
          setPeptideNews([]);
          setPeptideNewsError('No headlines available right now.');
          setPeptideNewsUpdatedAt(new Date());
          return;
        }
        setPeptideNews(items.slice(0, 6));
        setPeptideNewsUpdatedAt(new Date());
      } catch (error) {
        if (!cancelled) {
          console.warn('[News] Failed to load peptide headlines', error);
          setPeptideNewsError('Unable to load peptide news at the moment.');
          setPeptideNews([]);
        }
      } finally {
        if (!cancelled) {
          setPeptideNewsLoading(false);
        }
      }
    };

    loadPeptideNews();

    return () => {
      cancelled = true;
    };
  }, []);

  // Load quote and trigger sequenced appearance when user logs in
  useEffect(() => {
    if (!user) {
      setShowWelcome(false);
      setShowQuote(false);
      setQuoteOfTheDay(null);
      return;
    }

    const loadQuoteAndAnimate = async () => {
      try {
        const quote = await quotesAPI.getQuoteOfTheDay();
        setQuoteOfTheDay(quote);
      } catch (error) {
        console.warn('[Quotes] Failed to load quote of the day', error);
        setQuoteOfTheDay({ text: 'Excellence is not a skill, it\'s an attitude.', author: 'Ralph Marston' });
      }

      // Sequenced appearance
      setTimeout(() => setShowWelcome(true), 300);
      setTimeout(() => setShowQuote(true), 600);
    };

    loadQuoteAndAnimate();
  }, [user]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const handleResize = () => {
      setIsDesktopLandingLayout(window.innerWidth >= 1024);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  useEffect(() => {
    setFilters((prev) => {
      const nextCategories = prev.categories.filter((category) => catalogCategories.includes(category));
      const nextTypes = prev.types.filter((type) => catalogTypes.includes(type));
      if (nextCategories.length === prev.categories.length && nextTypes.length === prev.types.length) {
        return prev;
      }
      return {
        ...prev,
        categories: nextCategories,
        types: nextTypes,
      };
    });
  }, [catalogCategories, catalogTypes]);

  useEffect(() => {
    if (!user) {
      setDoctorSummary(null);
      setDoctorReferrals([]);
      setSalesRepDashboard(null);
      setSalesRepStatusFilter('all');
      setAdminActionState({ updatingReferral: null, error: null });
      return;
    }

    if (postLoginHold) {
      return;
    }

    let cancelled = false;

    (async () => {
      if (!cancelled) {
        await refreshReferralData({ showLoading: true });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, postLoginHold, refreshReferralData]);

  useEffect(() => {
    if (!user || user.role !== 'sales_rep' || postLoginHold) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      refreshReferralData({ showLoading: false });
    }, 15000);

    return () => window.clearInterval(intervalId);
  }, [user?.id, user?.role, postLoginHold, refreshReferralData]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return undefined;
    }

    if (!user || user.role !== 'doctor' || postLoginHold) {
      return undefined;
    }

    let cancelled = false;

    const refreshIfActive = () => {
      if (!cancelled) {
        refreshReferralData({ showLoading: false });
      }
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        refreshIfActive();
      }
    };

    const handleFocus = () => {
      refreshIfActive();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);

    const intervalId = window.setInterval(() => {
      refreshIfActive();
    }, 15000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [user?.id, user?.role, postLoginHold, refreshReferralData]);

  useEffect(() => () => {
    if (checkoutButtonObserverRef.current) {
      checkoutButtonObserverRef.current.disconnect();
      checkoutButtonObserverRef.current = null;
    }
  }, []);

  // Add springy scroll effect to sidebar - DISABLED to allow normal scrolling
  // useEffect(() => {
  //   let lastScrollY = window.scrollY;
  //   let ticking = false;

  //   const handleScroll = () => {
  //     if (!ticking) {
  //       window.requestAnimationFrame(() => {
  //         const sidebar = document.querySelector('.filter-sidebar-container > *') as HTMLElement;
  //         if (sidebar && window.innerWidth >= 1024) {
  //           const currentScrollY = window.scrollY;
  //           const scrollDelta = currentScrollY - lastScrollY;
  //           const maxOffset = 40;
  //           const offset = Math.max(-maxOffset, Math.min(maxOffset, scrollDelta * 0.8));

  //           sidebar.style.transform = `translateY(${-offset}px)`;

  //           setTimeout(() => {
  //             sidebar.style.transform = 'translateY(0)';
  //           }, 150);

  //           lastScrollY = currentScrollY;
  //         }
  //         ticking = false;
  //       });
  //       ticking = true;
  //     }
  //   };

  //   window.addEventListener('scroll', handleScroll, { passive: true });
  //   return () => window.removeEventListener('scroll', handleScroll);
  // }, []);

  useEffect(() => {
    const closeAllDialogs = () => {
      setProductDetailOpen(false);
      setSelectedProduct(null);
      setCheckoutOpen(false);
    };
    window.addEventListener('peppro:close-dialogs', closeAllDialogs);
    return () => window.removeEventListener('peppro:close-dialogs', closeAllDialogs);
  }, []);

  const loginWithRetry = async (email: string, password: string, attempt = 0): Promise<AuthActionResult> => {
    console.debug('[Auth] Login attempt', { email, attempt });
    try {
      const user = await authAPI.login(email, password);
      setUser(user);
      setPostLoginHold(true);
      const isReturning = (user.visits ?? 1) > 1;
      setIsReturningUser(isReturning);
      // toast.success(`${isReturning ? 'Welcome back' : 'Welcome to PepPro'}, ${user.name}!`);
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

      if (message === 'SALES_REP_ACCOUNT_REQUIRED') {
        return { status: 'sales_rep_signup_required', message };
      }

      const statusCode = typeof error?.status === 'number' ? error.status : null;
      const normalizedMessage = typeof message === 'string' ? message.toUpperCase() : '';
      const isNetworkError =
        message === 'Failed to fetch' ||
        normalizedMessage.includes('NETWORKERROR') ||
        normalizedMessage.includes('NETWORK_ERROR');
      const isServerError = statusCode !== null && statusCode >= 500;

      if (attempt === 0 && (isNetworkError || isServerError)) {
        console.warn('[Auth] Transient login failure detected, warming API then retrying', { email, statusCode, message });
        try {
          await Promise.race([
            checkServerHealth(),
            new Promise((resolve) => setTimeout(resolve, 1000))
          ]);
        } catch {
          // ignore health check failures, we'll still retry once
        }
        await new Promise((resolve) => setTimeout(resolve, 350));
        return loginWithRetry(email, password, attempt + 1);
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

  // Login function connected to backend
  const handleLogin = (email: string, password: string): Promise<AuthActionResult> => {
    return loginWithRetry(email, password, 0);
  };

  // Create account function connected to backend
  const handleCreateAccount = async (details: {
    name: string;
    email: string;
    password: string;
    confirmPassword: string;
    code: string;
  }): Promise<AuthActionResult> => {
    console.debug('[Auth] Create account attempt', { email: details.email });
    try {
      const password = (details.password || '').trim();
      const confirmPassword = (details.confirmPassword || '').trim();

      if (!password) {
        return { status: 'error', message: 'PASSWORD_REQUIRED' };
      }

      if (password !== confirmPassword) {
        return { status: 'password_mismatch' };
      }

      const normalizedCode = (details.code || '').trim().toUpperCase();

      if (!/^[A-Z]{2}[A-Z0-9]{3}$/.test(normalizedCode)) {
        return { status: 'invalid_referral_code' };
      }

      const user = await authAPI.register({
        name: details.name,
        email: details.email,
        password,
        code: normalizedCode,
      });
      setUser(user);
      setPostLoginHold(true);
      setIsReturningUser(false);
      // toast.success(`Welcome to PepPro, ${user.name}!`);
      console.debug('[Auth] Create account success', { userId: user.id });
      setLoginContext(null);
      setShowLandingLoginPassword(false);
      setShowLandingSignupPassword(false);
      setShowLandingSignupConfirm(false);
      return { status: 'success' };
    } catch (error: any) {
      const status = error?.status ?? 'unknown';
      const detailsPayload = error?.details ?? null;
      console.warn('[Auth] Create account failed', {
        email: details.email,
        status,
        message: error?.message,
        details: detailsPayload,
      });
      const message =
        typeof error?.message === 'string' && error.message.trim()
          ? error.message.trim()
          : 'REGISTER_ERROR';
      if (message === 'EMAIL_EXISTS' || message === 'User already exists') {
        return { status: 'email_exists' };
      }
      if (message === 'INVALID_REFERRAL_CODE') {
        return { status: 'invalid_referral_code' };
      }
      if (message === 'REFERRAL_CODE_NOT_FOUND') {
        return { status: 'referral_code_not_found' };
      }
      if (message === 'REFERRAL_CODE_UNAVAILABLE') {
        return { status: 'referral_code_unavailable' };
      }
      if (message === 'SALES_REP_EMAIL_MISMATCH') {
        return { status: 'sales_rep_email_mismatch' };
      }
      if (message === 'NAME_EMAIL_REQUIRED') {
        return { status: 'name_email_required' };
      }
      if (message === 'PASSWORD_REQUIRED') {
        return { status: 'error', message };
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
    setDoctorSummary(null);
    setDoctorReferrals([]);
    setSalesRepDashboard(null);
    setReferralStatusMessage(null);
    setReferralDataError(null);
    setAdminActionState({ updatingReferral: null, error: null });
    // toast.success('Logged out successfully');
  };

  const handleAddToCart = (productId: string, quantity = 1, note?: string) => {
    console.debug('[Cart] Add to cart requested', { productId, quantity, note });
    const product =
      catalogProducts.find((item) => item.id === productId) ||
      peptideProducts.find((item) => item.id === productId);
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
    // toast.success(`${quantityToAdd} × ${product.name} added to cart`);
  };

  const handleRefreshNews = async () => {
    setPeptideNewsLoading(true);
    setPeptideNewsError(null);

    try {
      const data = await newsAPI.getPeptideHeadlines();
      const items = Array.isArray(data?.items)
        ? data.items
          .map((item: any) => ({
            title: typeof item?.title === 'string' ? item.title.trim() : '',
            url: typeof item?.url === 'string' ? item.url.trim() : '',
            summary: typeof item?.summary === 'string' && item.summary.trim() ? item.summary.trim() : undefined,
            image: typeof item?.imageUrl === 'string' && item.imageUrl.trim() ? item.imageUrl.trim() : undefined,
            date: typeof item?.date === 'string' && item.date.trim() ? item.date.trim() : undefined,
          }))
          .filter((item) => item.title && item.url)
        : [];

      if (items.length === 0) {
        setPeptideNews([]);
        setPeptideNewsError('No headlines available right now.');
        setPeptideNewsUpdatedAt(new Date());
        return;
      }
      setPeptideNews(items.slice(0, 6));
      setPeptideNewsUpdatedAt(new Date());
    } catch (error) {
      console.warn('[News] Failed to refresh peptide headlines', error);
      setPeptideNewsError('Unable to load peptide news at the moment.');
      setPeptideNews([]);
    } finally {
      setPeptideNewsLoading(false);
    }
  };

  const handleSearch = (query: string) => {
    setSearchQuery(query);
  };

  const handleCheckout = async (referralCode?: string) => {
    console.debug('[Checkout] Attempt', { items: cartItems.length, referralCode });
    if (cartItems.length === 0) {
      // toast.error('Your cart is empty');
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
      // toast.success('Order placed successfully!');
      // if (response?.message) {
      //   toast.info(response.message);
      // }
      console.debug('[Checkout] Success', { orderId: response?.id, total });
    } catch (error: any) {
      console.error('[Checkout] Failed', { error });
      const message = error?.message === 'Request failed'
        ? 'Unable to complete purchase. Please try again.'
        : error?.message ?? 'Unable to complete purchase. Please try again.';
      // toast.error(message);
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
    // toast.success('Item removed from cart');
  };

  const submitReferralWithRetry = async (
    payload: { contactName: string; contactEmail?: string; contactPhone?: string; notes?: string },
    attempt = 0
  ): Promise<void> => {
    try {
      await referralAPI.submitDoctorReferral(payload);
    } catch (error: any) {
      const statusCode = typeof error?.status === 'number' ? error.status : null;
      const message = typeof error?.message === 'string' ? error.message : '';
      const normalizedMessage = message.toUpperCase();
      const isNetworkError =
        message === 'Failed to fetch' ||
        normalizedMessage.includes('NETWORKERROR') ||
        normalizedMessage.includes('NETWORK_ERROR');
      const isServerError = statusCode !== null && statusCode >= 500;

      if (attempt === 0 && (isNetworkError || isServerError)) {
        console.warn('[Referral] Transient submission failure detected, warming API then retrying', {
          statusCode,
          message
        });
        try {
          await Promise.race([
            checkServerHealth(),
            new Promise((resolve) => setTimeout(resolve, 1000))
          ]);
        } catch {
          // ignore health check failures and continue to retry once
        }
        await new Promise((resolve) => setTimeout(resolve, 350));
        await submitReferralWithRetry(payload, attempt + 1);
        return;
      }

      throw error;
    }
  };

  const handleSubmitReferral = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user || user.role !== 'doctor') {
      return;
    }

    if (!referralForm.contactName.trim()) {
      setReferralStatusMessage({ type: 'error', message: 'Please provide the doctor’s name before submitting.' });
      return;
    }

    try {
      setReferralSubmitting(true);
      setReferralStatusMessage(null);
      await submitReferralWithRetry({
        contactName: referralForm.contactName.trim(),
        contactEmail: referralForm.contactEmail.trim() || undefined,
        contactPhone: referralForm.contactPhone.trim() || undefined,
        notes: referralForm.notes.trim() || undefined,
      });
      setReferralStatusMessage({ type: 'success', message: 'Referral sent to your regional administrator.' });
      setReferralForm({ contactName: '', contactEmail: '', contactPhone: '', notes: '' });
      setReferralSearchTerm('');
      await refreshReferralData({ showLoading: true });
    } catch (error: any) {
      console.warn('[Referral] Submission failed', error);
      setReferralStatusMessage({ type: 'error', message: 'Unable to submit referral. Please try again.' });
    } finally {
      setReferralSubmitting(false);
    }
  };

  const handleUpdateReferralStatus = async (referralId: string, nextStatus: string) => {
    if (!user || user.role !== 'sales_rep') {
      return;
    }

    try {
      setAdminActionState((prev) => ({ ...prev, updatingReferral: referralId, error: null }));
      const response = await referralAPI.updateReferral(referralId, { status: nextStatus });
      setSalesRepDashboard((prev) => {
        if (!prev) {
          return prev;
        }
        const updatedReferral = response?.referral;
        const statuses = (response?.statuses as string[] | undefined) ?? prev.statuses;
        if (!updatedReferral) {
          return { ...prev, statuses };
        }
        const updatedReferrals = prev.referrals.map((item) =>
          item.id === updatedReferral.id ? updatedReferral : item
        );
        return {
          ...prev,
          referrals: updatedReferrals,
          statuses,
        };
      });
    } catch (error: any) {
      console.warn('[Referral] Update referral status failed', error);
      setAdminActionState((prev) => ({
        ...prev,
        error:
          typeof error?.message === 'string' && error.message
            ? error.message
            : 'Unable to update referral status. Please try again.',
      }));
    } finally {
      setAdminActionState((prev) => ({ ...prev, updatingReferral: null }));
    }
  };

  
const renderDoctorDashboard = () => {
  if (!user || user.role !== 'doctor') {
    return null;
  }

  const totalCredits = doctorSummary?.totalCredits ?? Number(user.referralCredits ?? 0);
  const firstOrderBonuses = doctorSummary?.firstOrderBonuses ?? 0;
  const totalReferrals = user.totalReferrals ?? doctorReferrals.length ?? 0;
  const recentLedger = (doctorSummary?.ledger ?? [])
    .slice()
    .sort((a, b) => new Date(b.issuedAt).getTime() - new Date(a.issuedAt).getTime())
    .slice(0, 5);

  const renderReferralHubTrigger = (expanded: boolean) => {
    const baseTriggerClasses =
      'group glass-card referral-pill squircle-xl flex w-full items-center justify-between gap-4 pr-5 py-4 text-left transition-all';
    const triggerClasses = expanded
      ? `${baseTriggerClasses} shadow-md`
      : `${baseTriggerClasses} shadow-[0_18px_48px_-28px_rgba(95,179,249,0.8)] hover:shadow-[0_20px_52px_-24px_rgba(95,179,249,0.85)]`;

    return (
      <button
        type="button"
        className={triggerClasses}
        onClick={() => setIsReferralSectionExpanded((prev) => !prev)}
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse Referral Rewards Hub' : 'Expand Referral Rewards Hub'}
        style={{ borderWidth: '2px', borderColor: 'var(--brand-glass-border-2)', paddingLeft: '1rem', borderRadius: '24px' }}
      >
        <div className="flex items-center gap-6 flex-shrink-0 pl-4 ml-2">
          <div
            className={`flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-600 transition-all duration-300 group-hover:bg-slate-200 ${
              expanded ? 'shadow-inner' : ''
            }`}
          >
            <ChevronRight
              className="h-5 w-5"
              style={{
                transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
                transformOrigin: 'center'
              }}
            />
          </div>
          <div className="hidden sm:block">
            <p className="text-sm font-semibold text-slate-700">Referral Rewards Hub</p>
            <p className="text-xs text-slate-500">Invite doctors & track credited referrals</p>
          </div>
        </div>

        <div className="flex flex-1 items-center justify-end gap-2">
          <svg className="w-5 h-5 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
          </svg>
          <p className="text-lg font-medium text-slate-700">Refer your colleagues</p>
        </div>
      </button>
    );
  };

  const renderExpandedContent = () => (
    <div
      className="overflow-hidden transition-all duration-500 ease-in-out"
      style={{
        maxHeight: isReferralSectionExpanded ? '5000px' : '0',
        opacity: isReferralSectionExpanded ? 1 : 0,
      }}
    >
      <div className="px-16 pb-8 space-y-8 squircle-xl" style={{ padding: '1rem 1rem 1rem' }}>
        {referralDataError && (
          <div className="px-4 py-3 text-sm text-red-700">
            <div className="flex items-center justify-center gap-2">
              <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
              <span>{referralDataError}</span>
            </div>
          </div>
        )}

        <div className="glass squircle-lg p-8 ml-5 mr-5 shadow-sm space-y-6">
          <form className="glass-strong squircle-md p-6 space-y-3" onSubmit={handleSubmitReferral}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs font-medium text-slate-700" htmlFor="referral-contact-name">Colleague Name *</label>
                <input
                  id="referral-contact-name"
                  type="text"
                  required
                  value={referralForm.contactName}
                  onChange={(event) => setReferralForm((prev) => ({ ...prev, contactName: event.target.value }))}
                  className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700" htmlFor="referral-contact-email">Email</label>
                <input
                  id="referral-contact-email"
                  type="email"
                  value={referralForm.contactEmail}
                  onChange={(event) => setReferralForm((prev) => ({ ...prev, contactEmail: event.target.value }))}
                  className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700" htmlFor="referral-contact-phone">Phone</label>
                <input
                  id="referral-contact-phone"
                  type="tel"
                  value={referralForm.contactPhone}
                  onChange={(event) => setReferralForm((prev) => ({ ...prev, contactPhone: event.target.value }))}
                  className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs font-medium text-slate-700" htmlFor="referral-notes">Notes</label>
                <textarea
                  id="referral-notes"
                  value={referralForm.notes}
                  onChange={(event) => setReferralForm((prev) => ({ ...prev, notes: event.target.value }))}
                  className="w-full min-h-[70px] rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            </div>
            <div className="pt-1 flex w-full justify-end">
              <div className="inline-flex flex-wrap items-center justify-end gap-3 text-right sm:flex-nowrap">
                <p className="text-sm text-slate-600 max-w-[24ch] sm:max-w-[26ch]">
                  Your regional administrator will credit you $50 each time your new referee has completed their first checkout.
                </p>
                <Button
                  type="submit"
                  disabled={referralSubmitting}
                  className="glass-brand squircle-sm transition-all duration-300 hover:scale-105 hover:-translate-y-0.5 active:translate-y-0"
                >
                  {referralSubmitting ? 'Submitting…' : 'Submit Referral'}
                </Button>
                {referralStatusMessage && (
                  <span className={`text-sm ${referralStatusMessage.type === 'success' ? 'text-emerald-600' : 'text-red-600'}`}>
                    {referralStatusMessage.message}
                  </span>
                )}
              </div>
            </div>
          </form>
        </div>

        <div className="mt-8 grid gap-6 md:grid-cols-2">
          <div className="glass squircle-lg p-8 shadow-sm space-y-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center squircle-sm bg-emerald-100">
                <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <h3 className="text-base font-semibold text-slate-800">Your Referrals</h3>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-right">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Total Referrals</p>
                <p className="text-lg font-bold text-emerald-600">{totalReferrals}</p>
              </div>
              {referralDataLoading && (
                <span className="text-xs text-slate-500 flex items-center gap-1">
                  <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Loading…
                </span>
              )}
            </div>
          </div>
          {doctorReferrals.length === 0 ? (
            <div className="text-center py-8 glass-strong squircle-md">
              <div className="flex justify-center mb-3">
                <div className="flex h-12 w-12 items-center justify-center squircle-sm bg-slate-100">
                  <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                  </svg>
                </div>
              </div>
              <p className="text-sm text-slate-600">No referrals yet</p>
              <p className="text-xs text-slate-500 mt-1">Submit your first referral above to get started</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="referral-toolbar">
                <div className="referral-toolbar__search">
                  <input
                    type="search"
                    value={referralSearchTerm}
                    onChange={(event) => setReferralSearchTerm(event.target.value)}
                    placeholder="Search by name or email"
                    aria-label="Search referrals"
                    className="referral-search-input"
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleReferralSortToggle}
                  aria-pressed={referralSortOrder === 'desc'}
                  className="referral-sort-toggle"
                >
                  <ArrowUpDown className="h-4 w-4 mr-2" />
                  {sortDirectionLabel}
                </Button>
              </div>
              <div className="referrals-table-scroll">
                <div className="referrals-table-container glass-card squircle-xl">
                  {filteredDoctorReferrals.length === 0 ? (
                    <div className="referrals-empty-state">
                      <p className="text-sm text-slate-600">No referrals match your search.</p>
                      <p className="text-xs text-slate-500 mt-1">Try adjusting your filters or search terms.</p>
                    </div>
                  ) : (
                    <div className="referrals-table" role="table" aria-label="Your referrals">
                      <div className="referrals-table__header" role="row">
                        <span role="columnheader">Colleague</span>
                        <span role="columnheader">Submitted</span>
                        <span role="columnheader">Status</span>
                      </div>
                      <div className="referrals-table__body" role="rowgroup">
                        {filteredDoctorReferrals.map((referral) => (
                          <div key={referral.id} className="referrals-table__row" role="row">
                            <div className="referrals-table__cell" role="cell">
                              <div className="referral-contact">
                                <span className="referral-contact__name">{referral.referredContactName}</span>
                                {(referral.referredContactEmail || referral.referredContactPhone) && (
                                  <span className="referral-contact__meta">
                                    {referral.referredContactEmail || referral.referredContactPhone}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="referrals-table__cell" role="cell">
                              <span className="referral-date">{formatDate(referral.createdAt)}</span>
                            </div>
                            <div className="referrals-table__cell" role="cell">
                              <span className="referral-status-badge">
                                {formatReferralStatus(referral.status ?? 'pending')}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
          </div>

          <div className="glass squircle-lg p-8 shadow-sm min-w-0 space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center squircle-sm bg-amber-100">
                <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h3 className="text-base font-semibold text-slate-800">Recent Credit Activity</h3>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-right">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Total Credits</p>
                <p className="text-lg font-bold text-emerald-600">${totalCredits.toFixed(2)}</p>
              </div>
              {recentLedger.length > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
                  </svg>
                  {recentLedger.length} recent
                </span>
              )}
            </div>
          </div>

          {recentLedger.length === 0 ? (
            <div className="text-center py-8 glass-strong squircle-md">
              <div className="flex justify-center mb-3">
                <div className="flex h-12 w-12 items-center justify-center squircle-sm bg-slate-100">
                  <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                </div>
              </div>
              <p className="text-sm text-slate-600">No credit activity yet</p>
              <p className="text-xs text-slate-500 mt-1">Credits appear after your referrals place their first order</p>
            </div>
          ) : (
            <ul className="space-y-2.5">
              {recentLedger.map((entry) => (
                <li key={entry.id} className="group relative glass-strong squircle-md p-5 shadow-sm transition-all hover:shadow-md">
                  <div className="relative flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2 mb-1">
                        <span className="text-lg font-bold text-emerald-600">${entry.amount.toFixed(2)}</span>
                      </div>
                      {entry.description && (
                        <p className="text-sm text-slate-600 leading-relaxed">{entry.description}</p>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <span className="text-xs font-medium text-slate-500 whitespace-nowrap">{formatDate(entry.issuedAt)}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <section className="grid gap-6 mb-16 mt-0">
      <div
        className={`glass-card squircle-xl referral-pill-wrapper transition-all duration-500 ${
          isReferralSectionExpanded
            ? 'pb-8 shadow-[0_30px_80px_-65px_rgba(95,179,249,0.8)]'
            : 'shadow-[0_18px_48px_-28px_rgba(95,179,249,0.8)] hover:shadow-[0_20px_52px_-24px_rgba(95,179,249,0.85)]'
        }`}
        style={{ borderRadius: '24px' }}
      >
        {renderReferralHubTrigger(isReferralSectionExpanded)}
        {renderExpandedContent()}
      </div>
    </section>
  );
};

const renderProductSection = () => (
  <div className="products-layout mt-24">
    {/* Filters Sidebar */}
    <div
      ref={filterSidebarRef}
      className="filter-sidebar-container lg:min-w-[18rem] lg:max-w-[24rem] xl:min-w-[20rem] xl:max-w-[26rem] lg:pl-4 xl:pl-6"
    >
      <CategoryFilter
        categories={catalogCategories}
        types={catalogTypes}
        filters={filters}
        onFiltersChange={setFilters}
        productCounts={productCounts}
        typeCounts={typeCounts}
      />
    </div>

    {/* Products Grid */}
    <div className="w-full min-w-0 flex-1">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <h2>Products</h2>
          <Badge variant="outline" className="squircle-sm glass">
            {filteredProducts.length} items
          </Badge>
          {searchQuery && (
            <Badge variant="outline" className="squircle-sm">
              Search: "{searchQuery}"
            </Badge>
          )}
          {catalogLoading && (
            <Badge variant="outline" className="squircle-sm glass">
              Syncing…
            </Badge>
          )}
          {catalogError && (
            <Badge variant="destructive" className="squircle-sm">
              Woo sync issue
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            aria-pressed={viewMode === 'grid'}
            onClick={() => setViewMode('grid')}
            className={`squircle-sm transition-all duration-300 ease-out flex items-center justify-center ${
              viewMode === 'grid'
                ? 'h-14 w-14 ring-2 ring-primary/60 glass shadow-[0_24px_60px_-36px_rgba(95,179,249,0.45)] text-[rgb(95,179,249)]'
                : 'h-8.5 w-8.5 opacity-70 glass shadow-[0_6px_16px_-14px_rgba(95,179,249,0.25)] text-[rgb(95,179,249)]'
            }`}
          >
            <Grid className={`transition-transform duration-300 ${viewMode === 'grid' ? 'scale-110' : 'scale-95'}`} />
          </Button>
          <Button
            variant="outline"
            onClick={() => setViewMode('list')}
            aria-pressed={viewMode === 'list'}
            className={`squircle-sm transition-all duration-300 ease-out flex items-center justify-center ${
              viewMode === 'list'
                ? 'h-14 w-14 ring-2 ring-primary/60 glass shadow-[0_24px_60px_-36px_rgba(95,179,249,0.45)] text-[rgb(95,179,249)]'
                : 'h-8.5 w-8.5 opacity-70 glass shadow-[0_6px_16px_-14px_rgba(95,179,249,0.25)] text-[rgb(95,179,249)]'
            }`}
          >
            <List className={`transition-transform duration-300 ${viewMode === 'list' ? 'scale-110' : 'scale-95'}`} />
          </Button>

          {totalCartItems > 0 && (
            <Button
              variant="ghost"
              onClick={() => setCheckoutOpen(true)}
              ref={checkoutButtonRef}
              className="squircle-sm glass-brand shadow-lg shadow-[rgba(95,179,249,0.4)] transition-all duration-300 hover:shadow-xl hover:scale-105 hover:-translate-y-0.5 active:translate-y-0"
            >
              <ShoppingCart className="w-4 h-4 mr-2" />
              Checkout ({totalCartItems})
            </Button>
          )}
        </div>
      </div>

      {filteredProducts.length > 0 ? (
        <div
          className={`grid gap-6 w-full ${
            viewMode === 'grid' ? 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3' : 'grid-cols-1'
          }`}
        >
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
);

const renderSalesRepDashboard = () => {
  if (!user || user.role !== 'sales_rep') {
    return null;
  }

  const referrals = salesRepDashboard?.referrals ?? [];
  const statusOptions = Array.from(
    new Set([
      ...salesRepStatusOptions,
      ...referrals.map((referral) => (referral.status || '').trim()).filter(Boolean),
    ]),
  ).filter(Boolean);
  statusOptions.sort();

  const totalReferrals = referrals.length;
  const activeStatuses = new Set(['pending', 'contacted', 'follow_up', 'code_issued']);
  const activeReferrals = referrals.filter((ref) => activeStatuses.has((ref.status || '').toLowerCase())).length;
  const convertedReferrals = referrals.filter((ref) => (ref.status || '').toLowerCase() === 'converted').length;

  return (
    <section className="glass-card squircle-xl p-6 shadow-[0_30px_80px_-55px_rgba(95,179,249,0.6)] w-full">
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">Sales Rep Dashboard</h2>
            <p className="text-sm text-slate-600">Monitor referral progress and keep statuses in sync.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={salesRepStatusFilter}
              onChange={(event) => setSalesRepStatusFilter(event.target.value)}
              className="rounded-md border border-slate-200/80 bg-white/90 px-3 py-2 text-sm focus:border-[rgb(95,179,249)] focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.3)]"
            >
              <option value="all">All statuses</option>
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {formatReferralStatus(status)}
                </option>
              ))}
            </select>
            <Button
              type="button"
              variant="outline"
              onClick={() => refreshReferralData({ showLoading: true })}
              disabled={referralDataLoading}
              className="gap-2"
            >
              <RefreshCw className={`h-4 w-4 ${referralDataLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-200/70 bg-white/80 p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Total Referrals</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">{totalReferrals}</p>
          </div>
          <div className="rounded-xl border border-slate-200/70 bg-white/80 p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Active Pipeline</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">{activeReferrals}</p>
          </div>
          <div className="rounded-xl border border-slate-200/70 bg-white/80 p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Converted</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">{convertedReferrals}</p>
          </div>
        </div>

        {adminActionState.error && (
          <p className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {adminActionState.error}
          </p>
        )}

        <div className="overflow-x-auto rounded-xl border border-slate-200/70 bg-white/90 shadow-sm">
          <table className="min-w-[720px] divide-y divide-slate-200/70">
            <thead className="bg-slate-50/70">
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Referrer</th>
                <th className="px-4 py-3">Referral</th>
                <th className="px-4 py-3">Notes</th>
                <th className="px-4 py-3 whitespace-nowrap">Submitted</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/60">
              {referralDataLoading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-sm text-slate-500">
                    Loading referrals…
                  </td>
                </tr>
              ) : filteredSalesRepReferrals.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-sm text-slate-500">
                    No referrals match this filter.
                  </td>
                </tr>
              ) : (
                filteredSalesRepReferrals.map((referral) => {
                  const isUpdating = adminActionState.updatingReferral === referral.id;
                  const referralStatusOptions = statusOptions.length > 0 ? statusOptions : [referral.status || 'pending'];

                  return (
                    <tr key={referral.id} className="align-top">
                      <td className="px-4 py-4">
                        <div className="font-semibold text-slate-900">{referral.referrerDoctorName ?? '—'}</div>
                        <div className="text-xs text-slate-500">{referral.referrerDoctorEmail ?? '—'}</div>
                        {referral.referrerDoctorPhone && (
                          <div className="text-xs text-slate-500">{referral.referrerDoctorPhone}</div>
                        )}
                      </td>
                      <td className="px-4 py-4">
                        <div className="font-medium text-slate-900">{referral.referredContactName || '—'}</div>
                        {referral.referredContactEmail && (
                          <div className="text-xs text-slate-500">{referral.referredContactEmail}</div>
                        )}
                        {referral.referredContactPhone && (
                          <div className="text-xs text-slate-500">{referral.referredContactPhone}</div>
                        )}
                      </td>
                      <td className="px-4 py-4">
                        {referral.notes ? (
                          <div className="max-w-md text-sm text-slate-600 whitespace-pre-wrap">
                            {referral.notes}
                          </div>
                        ) : (
                          <span className="text-xs italic text-slate-400">No notes</span>
                        )}
                      </td>
                      <td className="px-4 py-4 text-sm text-slate-600">
                        <div>{formatDateTime(referral.createdAt)}</div>
                        <div className="text-xs text-slate-400">Updated {formatDateTime(referral.updatedAt)}</div>
                      </td>
                      <td className="px-4 py-4">
                        <select
                          value={referral.status}
                          onChange={(event) => handleUpdateReferralStatus(referral.id, event.target.value)}
                          disabled={isUpdating}
                          className="w-full rounded-md border border-slate-200/80 bg-white/95 px-3 py-2 text-sm focus:border-[rgb(95,179,249)] focus:outline-none focus:ring-2 focus:ring-[rgba(95,179,249,0.3)]"
                        >
                          {referralStatusOptions.map((status) => (
                            <option key={status} value={status}>
                              {formatReferralStatus(status)}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
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
    let filtered = catalogProducts;

    // Search filter
    if (searchQuery) {
      filtered = filtered.filter(product =>
        product.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        product.category.toLowerCase().includes(searchQuery.toLowerCase()) ||
        product.manufacturer.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (product.description && product.description.toLowerCase().includes(searchQuery.toLowerCase()))
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

    // Type filter
    if (filters.types.length > 0) {
      filtered = filtered.filter(product => product.type && filters.types.includes(product.type));
    }

    return filtered;
  }, [catalogProducts, searchQuery, filters]);

  // Get product counts by category
  const productCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    catalogCategories.forEach(category => {
      counts[category] = catalogProducts.filter(product => product.category === category).length;
    });
    return counts;
  }, [catalogProducts, catalogCategories]);

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    catalogTypes.forEach(type => {
      counts[type] = catalogProducts.filter(product => product.type === type).length;
    });
    return counts;
  }, [catalogProducts, catalogTypes]);

  // Add springy scroll effect to filter sidebar on large screens - DISABLED FOR TESTING
  // useEffect(() => {
  //   let lastScrollY = window.scrollY;
  //   let ticking = false;

  //   const handleScroll = () => {
  //     if (ticking) {
  //       return;
  //     }
  //     window.requestAnimationFrame(() => {
  //       const sidebar = document.querySelector<HTMLDivElement>('.filter-sidebar-container > *');
  //       if (sidebar && window.innerWidth >= 1024) {
  //         const currentScrollY = window.scrollY;
  //         const scrollDelta = currentScrollY - lastScrollY;
  //         const maxOffset = 40;
  //         const offset = Math.max(-maxOffset, Math.min(maxOffset, scrollDelta * 0.8));

  //         sidebar.style.transform = `translateY(${-offset}px)`;

  //         window.setTimeout(() => {
  //           sidebar.style.transform = 'translateY(0)';
  //         }, 150);

  //         lastScrollY = currentScrollY;
  //       }
  //       ticking = false;
  //     });
  //     ticking = true;
  //   };

  //   window.addEventListener('scroll', handleScroll, { passive: true });
  //   return () => window.removeEventListener('scroll', handleScroll);
  // }, []);

  // Get featured products
  const featuredProducts = catalogProducts.slice(0, 4);

  const totalCartItems = cartItems.reduce((sum, item) => sum + item.quantity, 0);
  const shouldShowHeaderCartIcon = totalCartItems > 0 && !isCheckoutButtonVisible;

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
          maskImage: 'linear-gradient(to top, rgba(0,0,0,0.2) 0%, rgba(0,0,0,0.15) 33%, rgba(0,0,0,0.075) 66%, rgba(0,0,0,0) 100%)',
          WebkitMaskImage: 'linear-gradient(to top, rgba(0,0,0,0.50) 0%, rgba(0,0,0,0.15) 40%, rgba(0,0,0,0.05) 50%, rgba(0,0,0,0) 100%)'
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
          showCartIconFallback={shouldShowHeaderCartIcon}
          onShowInfo={() => {
            console.log('[App] onShowInfo called, setting postLoginHold to true');
            setPostLoginHold(true);
          }}
        />
      )}

      {/* Landing Page - Show when not logged in */}
      {(!user || postLoginHold) && (
        <div className="min-h-screen flex flex-col items-center pt-20 px-4 py-12">
          {/* Logo with Welcome and Quote Containers */}
          {postLoginHold && user ? (
            <div className="w-full max-w-7xl mb-6 px-4">
              {isDesktopLandingLayout ? (
                <div className="flex flex-row items-stretch justify-between gap-4 lg:gap-6 mb-8">
                  <div
                    className={`glass-card squircle-lg border border-[var(--brand-glass-border-2)] px-8 py-6 lg:px-10 lg:py-8 shadow-lg transition-all duration-500 flex items-center justify-center flex-1 ${
                      showWelcome ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4'
                    }`}
                    style={{ backdropFilter: 'blur(20px) saturate(1.4)' }}
                  >
                    <p className="text-2xl lg:text-3xl font-semibold text-[rgb(95,179,249)] text-center">
                      Welcome{user.visits && user.visits > 1 ? ' back' : ''}, {user.name}!
                    </p>
                  </div>

                  <div className="flex-shrink-0 px-6 lg:px-8">
                    <div className="brand-logo brand-logo--landing">
                      <img
                        src="/Peppro_FullLogo_Transparent_NoBuffer.png"
                        alt="PepPro"
                        style={{
                          display: 'block',
                          width: 'auto',
                          height: 'auto',
                          maxWidth: 'min(320px, 35vw)',
                          maxHeight: 'min(280px, 25vh)',
                          objectFit: 'contain'
                        }}
                      />
                    </div>
                  </div>

                  {quoteOfTheDay && (
                    <div
                      className={`glass-card squircle-lg border border-[var(--brand-glass-border-2)] px-8 py-6 lg:px-10 lg:py-8 shadow-lg transition-all duration-500 flex flex-col justify-center flex-1 ${
                        showQuote ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4'
                      }`}
                      style={{ backdropFilter: 'blur(20px) saturate(1.4)' }}
                    >
                      <p className="text-base lg:text-lg italic text-gray-700 text-center">
                        "{quoteOfTheDay.text}" — {quoteOfTheDay.author}
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center gap-6 mb-8">
                  <div className="flex justify-center px-4">
                    <div className="brand-logo brand-logo--landing">
                      <img
                        src="/Peppro_FullLogo_Transparent_NoBuffer.png"
                        alt="PepPro"
                        style={{
                          display: 'block',
                          width: 'auto',
                          height: 'auto',
                          maxWidth: 'min(320px, 35vw)',
                          maxHeight: 'min(280px, 25vh)',
                          objectFit: 'contain'
                        }}
                      />
                    </div>
                  </div>
                  <div
                    className={`glass-card squircle-lg border border-[var(--brand-glass-border-2)] px-4 py-4 shadow-lg transition-all duration-500 w-full ${
                      showWelcome ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4'
                    }`}
                    style={{ backdropFilter: 'blur(20px) saturate(1.4)' }}
                  >
                    <p className="text-center text-xl font-semibold text-[rgb(95,179,249)]">
                      Welcome{user.visits && user.visits > 1 ? ' back' : ''}, {user.name}!
                    </p>
                    {quoteOfTheDay && (
                      <div
                        className={`mt-5 rounded-lg bg-white/65 px-4 py-3 text-center shadow-inner transition-opacity duration-500 ${
                          showQuote ? 'opacity-100' : 'opacity-0'
                        }`}
                      >
                        <p className="text-sm italic text-gray-700">
                          "{quoteOfTheDay.text}" — {quoteOfTheDay.author}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className={`flex justify-center ${
              landingAuthMode === 'signup' ? 'mb-6 sm:mb-8 lg:mb-12' : 'mb-12 sm:mb-12 lg:mb-20'
            }`}>
              <div className="brand-logo brand-logo--landing">
                <img
                  src="/Peppro_FullLogo_Transparent_NoBuffer.png"
                  alt="PepPro"
                  style={{
                    display: 'block',
                    width: 'auto',
                    height: 'auto',
                    maxWidth: 'min(360px, 80vw)',
                    maxHeight: 'min(360px, 40vh)',
                    objectFit: 'contain'
                  }}
                />
              </div>
            </div>
          )}

          {/* Info Container - After Login */}
          {postLoginHold && user ? (
            <div className="w-full max-w-6xl mt-4 sm:mt-6 md:mt-8">

              <div className="post-login-layout">
                <div className="post-login-news glass-card landing-glass squircle-xl border border-[var(--brand-glass-border-2)] p-6 sm:p-8 shadow-xl" style={{ backdropFilter: 'blur(38px) saturate(1.6)' }}>
                  <div className="space-y-5">
                    <div className="flex items-center justify-between gap-3 mb-4">
                      <div className="flex items-center gap-2">
                        <h2 className="text-lg sm:text-xl font-semibold text-[rgb(95,179,249)]">Peptide News</h2>
                        <button
                          onClick={handleRefreshNews}
                          disabled={peptideNewsLoading}
                          className="p-1.5 rounded-md hover:bg-[rgba(95,179,249,0.1)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          title="Refresh news"
                        >
                          <RefreshCw className={`h-4 w-4 text-[rgb(95,179,249)] ${peptideNewsLoading ? 'animate-spin' : ''}`} />
                        </button>
                        {peptideNewsUpdatedAt && (
                          <span className="text-xs text-gray-500">
                            Updated at: {peptideNewsUpdatedAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                          </span>
                        )}
                      </div>
                      <a
                        href="https://www.nature.com/subjects/peptides"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-semibold uppercase tracking-wide text-[rgb(95,179,249)] hover:underline"
                      >
                        View All
                      </a>
                    </div>
                    <div className="max-h-[60vh] overflow-y-auto pr-1 space-y-4 text-sm text-gray-700 leading-relaxed">
                      {peptideNewsLoading && (
                        <div className="flex items-center gap-2 text-xs text-slate-500">
                          <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                          </svg>
                          Loading latest headlines…
                        </div>
                      )}
                      {!peptideNewsLoading && peptideNewsError && (
                        <p className="text-xs text-red-600">{peptideNewsError}</p>
                      )}
                      {!peptideNewsLoading && !peptideNewsError && peptideNews.length === 0 && (
                        <p className="text-xs text-slate-600">No headlines available right now. Please check back soon.</p>
                      )}
                      {!peptideNewsLoading && !peptideNewsError && peptideNews.length > 0 && (
                        <>
                          <ul className="space-y-4">
                            {peptideNews.map((item) => (
                              <li key={item.url} className="flex items-start gap-3">
                                <div className="peptide-news-thumb flex-none ring-1 ring-white/40 shadow-sm">
                                  <img
                                    src={item.image ?? PEPTIDE_NEWS_PLACEHOLDER_IMAGE}
                                    alt={`Peptide news: ${item.title}`}
                                    loading="lazy"
                                  />
                                </div>
                                <div className="space-y-1">
                                  <div>
                                    {item.date && (
                                      <span className="text-xs text-gray-500 mr-2">
                                        {formatNewsDate(item.date)}
                                      </span>
                                    )}
                                    <a
                                      href={item.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-[rgb(95,179,249)] font-semibold hover:underline"
                                    >
                                      {item.title}
                                    </a>
                                  </div>
                                  {item.summary && (
                                    <p className="text-xs text-gray-600 leading-relaxed">
                                      {item.summary}
                                    </p>
                                  )}
                                </div>
                              </li>
                            ))}
                          </ul>
                          <div className="pt-4 text-[11px] uppercase tracking-wide text-gray-500 border-t border-white/40">
                            Source:{' '}
                            <a
                              href="https://www.nature.com/subjects/peptides"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-semibold text-[rgb(95,179,249)] hover:underline"
                            >
                              Nature.com – Peptide Subject
                            </a>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <div className="post-login-info glass-card landing-glass squircle-xl border border-[var(--brand-glass-border-2)] p-6 sm:p-8 shadow-xl" style={{ backdropFilter: 'blur(38px) saturate(1.6)' }}>
                  <div className="space-y-4">
                    <div className="flex w-full justify-between gap-3 pb-2">
                      <Button
                        type="button"
                        size="lg"
                        onClick={handleLogout}
                        className="text-white squircle-sm px-6 py-2 font-semibold uppercase tracking-wide shadow-lg shadow-[rgba(95,179,249,0.4)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[rgba(95,179,249,0.35)] focus-visible:ring-offset-2 focus-visible:ring-offset-white transition-all duration-300 hover:shadow-xl hover:scale-105 hover:-translate-y-0.5 active:translate-y-0"
                        style={{ backgroundColor: 'rgb(95, 179, 249)' }}
                      >
                        <ArrowLeft className="h-4 w-4 mr-2" aria-hidden="true" />
                        <span>Logout</span>
                      </Button>
                      <Button
                        type="button"
                        size="lg"
                        onClick={handleAdvanceFromWelcome}
                        className="text-white squircle-sm px-6 py-2 font-semibold uppercase tracking-wide shadow-lg shadow-[rgba(95,179,249,0.4)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[rgba(95,179,249,0.35)] focus-visible:ring-offset-2 focus-visible:ring-offset-white transition-all duration-300 hover:shadow-xl hover:scale-105 hover:-translate-y-0.5 active:translate-y-0"
                        style={{ backgroundColor: 'rgb(95, 179, 249)' }}
                      >
                        <span className="mr-2">Shop</span>
                        <ArrowRight className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                    {user.role !== 'sales_rep' && (
                      <div className="glass-card squircle-md p-4 space-y-2 border border-[var(--brand-glass-border-2)]">
                        <p className="text-sm font-medium text-slate-700">Please contact your Regional Administrator at anytime.</p>
                        <div className="space-y-1 text-sm text-slate-600">
                          <p><span className="font-semibold">Name:</span> {user.salesRep?.name || 'N/A'}</p>
                          <p><span className="font-semibold">Email:</span> {user.salesRep?.email || 'N/A'}</p>
                          <p><span className="font-semibold">Phone:</span> {user.salesRep?.phone || 'N/A'}</p>
                        </div>
                      </div>
                    )}
                    <div className="relative flex flex-col gap-6 max-h-[70vh]">
                      <div className="flex-1 overflow-y-auto pr-1 space-y-16">
                        <section className="squircle glass-card landing-glass border border-[var(--brand-glass-border-2)] p-6 shadow-sm mb-4">
                          <h2 className="text-lg sm:text-xl font-semibold text-[rgb(95,179,249)]">Customer experiences & referrals</h2>
                          <div className="mt-4 grid gap-4 sm:grid-cols-2">
                            {/* Provide customer testimonials, referral stories, or metrics here */}
                          </div>
                          <div className="mt-4 text-sm text-gray-600">
                            {/* Add referral program call-to-action or highlight here */}
                          </div>
                        </section>

                        <div className="grid gap-10 md:grid-cols-[1.15fr_0.85fr] mb-4">
                          <section className="squircle glass-card landing-glass border border-[var(--brand-glass-border-2)] p-6 shadow-sm mb-4">
                            <h3 className="text-lg font-semibold text-[rgb(95,179,249)]">Physicians' Choice Program</h3>
                            <div className="mt-4 space-y-4 text-sm text-gray-700 leading-relaxed">
                              <p>
                                The Physicians' Choice Program is designed exclusively for medical professionals who order 25 units or more of a single product. Participants can choose to private label their products and/or utilize our 3PL Fulfillment Program for seamless inventory and distribution management.
                              </p>
                            </div>
                            <div className="mt-6 space-y-3 text-sm text-gray-700 leading-relaxed">
                              <h4 className="text-sm font-semibold text-[rgb(95,179,249)] uppercase tracking-wide">Private Labeling</h4>
                              <p>
                                Physicians who opt to private label will collaborate with their Regional Administrator to provide logos and branding details for custom product labels.
                              </p>
                              <p>
                                For those wishing to customize beyond the standard PepPro label design - such as changing colors, layout, or branding - we will provide a die line template for your designer to create your preferred look and feel. If design assistance is needed, we can connect you with a trusted graphic design partner.
                              </p>
                            </div>
                            <div className="mt-6 space-y-3 text-sm text-gray-700 leading-relaxed">
                              <h4 className="text-sm font-semibold text-[rgb(95,179,249)] uppercase tracking-wide">3PL Fulfillment Program</h4>
                              <p>
                                Our third-party logistics (3PL) program enables physicians to maintain inventory at our Anaheim, CA fulfillment center, ensuring quick, reliable delivery directly to patients. Participants may also hold stock at their practice for in-person distribution.
                              </p>
                              <p>
                                All PepPro products are produced in GMP-certified and 503A/503B-compliant facilities located in San Diego, CA. Each order is stored in a temperature-controlled environment and shipped within 24 hours of receipt.
                              </p>
                              <p>
                                Shipments include ice packs to maintain product integrity, ensuring all items arrive cold and ready for use. Comprehensive dosing instructions are included with every order - covering nasal sprays, vials, and chewables.
                              </p>
                            </div>
                            <div className="mt-6 space-y-3 text-sm text-gray-700 leading-relaxed">
                              <h4 className="text-sm font-semibold text-[rgb(95,179,249)] uppercase tracking-wide">Shipping</h4>
                              <p className="font-semibold text-[rgb(95,179,249)]">
                                Orders over $250 qualify for free shipping within the U.S.A.
                              </p>
                            </div>
                          </section>
                          <section className="squircle glass-card landing-glass border border-[var(--brand-glass-border-2)] p-6 shadow-sm flex items-center justify-center">
                            <figure className="space-y-4 flex flex-col items-center">
                              <img
                                src="/src/data/Peptide_PNGs/PeptidePackagedWell.png"
                                alt="PepPro fulfillment specialists preparing temperature-controlled shipments"
                                className="object-contain shadow-md"
                                style={{ width: '50%', height: 'auto' }}
                              />
                              <figcaption className="text-xs text-gray-500">
                                {/* Supply supporting caption or accreditation */}
                              </figcaption>
                            </figure>
                          </section>
                        </div>

                        <section className="squircle glass-strong landing-glass-strong border border-[var(--brand-glass-border-3)] p-6 text-slate-900 shadow-sm">
                          <h3 className="text-lg font-semibold">Care & Compliance</h3>
                          <div className="mt-4 text-sm">
                            <p>PepPro peptide products are research chemicals intended for licensed physicians only. They are not intended to prevent, treat, or cure any medical condition, ailment or disease. These products have not been reviewed or approved by the US Food and Drug Administration.</p>
                          </div>
                        </section>
                      </div>

                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className={`w-full max-w-md ${
              landingAuthMode === 'signup' ? 'mt-3 sm:mt-4 md:mt-6' : 'mt-4 sm:mt-6 md:mt-8'
            }`}>
              <div
                className="glass-card landing-glass squircle-xl border border-[var(--brand-glass-border-2)] p-8 shadow-xl"
                style={{ backdropFilter: 'blur(38px) saturate(1.6)' }}
              >
                <div className={landingAuthMode === 'login' ? 'space-y-4' : 'space-y-6'}>
                {landingAuthMode === 'login' ? (
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
                            className="absolute right-2 top-1/2 -translate-y-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-md text-gray-600 hover:text-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[rgba(95,179,249,0.3)] btn-hover-lighter"
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
                      <Button
                        type="submit"
                        size="lg"
                        className="w-full squircle-sm glass-brand btn-hover-lighter"
                      >
                        Sign In
                      </Button>
                    </form>
                    <div className="text-center">
                      <p className="text-sm text-gray-600">
                        Have a referral code?{' '}
                        <button type="button" onClick={() => setLandingAuthMode('signup')} className="font-semibold hover:underline btn-hover-lighter" style={{ color: 'rgb(95, 179, 249)' }}>
                          Create an account
                        </button>
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-center space-y-2">
                      <h1 className="text-2xl font-semibold">Join the PepPro Network</h1>
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
                          confirmPassword: (fd.get('confirm') as string) || '',
                          code: ((fd.get('code') as string) || '').toUpperCase()
                        };
                        const res = await handleCreateAccount(details);
                        if (res.status === 'success') {
                          setLandingAuthMode('login');
                        } else if (res.status === 'email_exists') {
                          setLandingSignupError('An account with this email already exists. Please sign in.');
                        } else if (res.status === 'invalid_referral_code') {
                          setLandingSignupError('Referral codes must be 5 characters (e.g., AB123).');
                        } else if (res.status === 'referral_code_not_found') {
                          setLandingSignupError('We couldn\'t locate that onboarding code. Please confirm it with your regional administrator.');
                        } else if (res.status === 'referral_code_unavailable') {
                          setLandingSignupError('This onboarding code has already been used. Ask your regional administrator for a new code.');
                        } else if (res.status === 'name_email_required') {
                          setLandingSignupError('Name and email are required to create your account.');
                        } else if (res.status === 'password_mismatch') {
                          setLandingSignupError('Passwords do not match. Please confirm and try again.');
                        } else if (res.status === 'error') {
                          setLandingSignupError(res.message === 'PASSWORD_REQUIRED'
                            ? 'Please create a secure password to access your account.'
                            : 'Unable to create account. Please try again.');
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
                            className="glass squircle-sm w-full px-3 text-sm border transition-colors focus-visible:outline-none focus-visible:border-[rgb(95,179,249)] focus-visible:ring-[rgba(95,179,249,0.3)] leading-tight"
                            style={{
                              borderColor: 'rgba(95,179,249,0.18)',
                              backgroundColor: 'rgba(95,179,249,0.02)',
                              WebkitAppearance: 'none' as any,
                              MozAppearance: 'none' as any,
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
                          <input
                            id="landing-password2"
                            name="password"
                            type={showLandingSignupPassword ? 'text' : 'password'}
                            required
                            autoComplete="new-password"
                            className="w-full h-10 px-3 pr-12 squircle-sm border border-slate-200/70 bg-white/96 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                          />
                          <button
                            type="button"
                            onClick={() => setShowLandingSignupPassword((p) => !p)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-md text-gray-600 hover:text-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[rgba(95,179,249,0.3)] btn-hover-lighter"
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
                          <input
                            id="landing-confirm"
                            name="confirm"
                            type={showLandingSignupConfirm ? 'text' : 'password'}
                            required
                            autoComplete="new-password"
                            className="w-full h-10 px-3 pr-12 squircle-sm border border-slate-200/70 bg-white/96 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                          />
                          <button
                            type="button"
                            onClick={() => setShowLandingSignupConfirm((p) => !p)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-md text-gray-600 hover:text-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[rgba(95,179,249,0.3)] btn-hover-lighter"
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
                      <div className="space-y-2">
                        <label htmlFor="landing-code" className="text-sm font-medium">Referral Code</label>
                        <input
                          id="landing-code"
                          name="code"
                          type="text"
                          required
                          maxLength={5}
                          inputMode="text"
                          pattern="[A-Z0-9]*"
                          autoComplete="off"
                          onInput={(event) => {
                            const target = event.currentTarget;
                            target.value = target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
                          }}
                          className="w-full h-10 px-3 squircle-sm border border-slate-200/70 bg-white/96 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                          style={{ textTransform: 'uppercase' }}
                        />
                        <p className="text-xs text-slate-500">Codes are 5 characters and issued by your regional administrator.</p>
                      </div>
                      {landingSignupError && (
                        <p className="text-sm text-red-600" role="alert">{landingSignupError}</p>
                      )}
                      <Button
                        type="submit"
                        size="lg"
                        className="w-full squircle-sm glass-brand btn-hover-lighter"
                      >
                        Create Account
                      </Button>
                    </form>
                    <div className="text-center">
                      <p className="text-sm text-gray-600">
                        Already have an account?{' '}
                        <button type="button" onClick={() => setLandingAuthMode('login')} className="font-semibold hover:underline btn-hover-lighter" style={{ color: 'rgb(95, 179, 249)' }}>
                          Sign in
                        </button>
                      </p>
                    </div>
                  </>
                )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Main Content */}
      {user && !postLoginHold && (
        <main className="mx-auto px-4 sm:px-6 lg:px-10 py-12" style={{ marginTop: '2.4rem' }}>
          {user.role === 'sales_rep' ? renderSalesRepDashboard() : renderDoctorDashboard()}
          {renderProductSection()}
        </main>
      )}

      {/* Footer */}
      <LegalFooter />

      {/* Checkout Modal */}
      <CheckoutModal
        isOpen={checkoutOpen}
        onClose={() => setCheckoutOpen(false)}
        cartItems={cartItems}
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

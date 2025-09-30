import { useState, useMemo, useEffect } from 'react';
import { Header } from './components/Header';
import { FeaturedSection } from './components/FeaturedSection';
import { ProductCard, Product } from './components/ProductCard';
import { CategoryFilter } from './components/CategoryFilter';
import { CheckoutModal } from './components/CheckoutModal';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import { toast } from 'sonner@2.0.3';
import { Grid, List, ShoppingCart } from 'lucide-react';
import { peptideProducts, peptideCategories, peptideTypes } from './data/peptideData';
import { authAPI } from './services/api';
import { ProductDetailDialog } from './components/ProductDetailDialog';
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
  const [filters, setFilters] = useState<FilterState>({
    categories: [],
    types: [],
    inStockOnly: false,
    prescriptionOnly: false
  });

  // Check if user is already logged in on mount
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const currentUser = await authAPI.getCurrentUser();
        if (currentUser) {
          setUser(currentUser);
        }
      } catch (error) {
        // Not logged in or token expired
      }
    };
    checkAuth();
  }, []);

  // Login function connected to backend
  const handleLogin = async (email: string, password: string): Promise<AuthActionResult> => {
    try {
      const user = await authAPI.login(email, password);
      setUser(user);
      const isReturning = (user.visits ?? 1) > 1;
      toast.success(`${isReturning ? 'Welcome back' : 'Welcome to Protixa'}, ${user.name}!`);
      if (shouldReopenCheckout) {
        setCheckoutOpen(true);
        setShouldReopenCheckout(false);
      }
      setLoginContext(null);
      return { status: 'success' };
    } catch (error: any) {
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
    try {
      if (details.password !== details.confirmPassword) {
        toast.error('Passwords do not match');
        return { status: 'error', message: 'PASSWORD_MISMATCH' };
      }

      const user = await authAPI.register(details.name, details.email, details.password);
      setUser(user);
      toast.success(`Welcome to Protixa, ${user.name}!`);
      if (shouldReopenCheckout) {
        setCheckoutOpen(true);
        setShouldReopenCheckout(false);
      }
      setLoginContext(null);
      return { status: 'success' };
    } catch (error: any) {
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
    authAPI.logout();
    setUser(null);
    setLoginContext(null);
    setShouldReopenCheckout(false);
    toast.success('Logged out successfully');
  };

  const handleAddToCart = (productId: string, quantity = 1, note?: string) => {
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
    
    toast.success(`${quantityToAdd} × ${product.name} added to cart`);
  };

  const handleSearch = (query: string) => {
    setSearchQuery(query);
  };

  const handleCheckout = (referralCode?: string) => {
    toast.success('Order placed successfully!');
    setCartItems([]);
  };

  const handleRequireLogin = () => {
    setCheckoutOpen(false);
    setLoginPromptToken((token) => token + 1);
    setShouldReopenCheckout(true);
    setLoginContext('checkout');
  };

  const handleUpdateCartItemQuantity = (productId: string, quantity: number) => {
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
    setCartItems((prev) => prev.filter((item) => item.product.id !== productId));
    toast.success('Item removed from cart');
  };

  const handleViewProduct = (product: Product) => {
    setSelectedProduct(product);
    setProductDetailOpen(true);
  };

  const handleCloseProductDetail = () => {
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

  // Get featured products
  const featuredProducts = peptideProducts.slice(0, 4);

  const totalCartItems = cartItems.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
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

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        {/* Products Section */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
          {/* Filters Sidebar */}
          <div className="lg:col-span-1">
            <CategoryFilter
              categories={peptideCategories}
              types={peptideTypes}
              filters={filters}
              onFiltersChange={setFilters}
              productCounts={productCounts}
              typeCounts={typeCounts}
            />
          </div>

          {/* Products Grid */}
          <div className="lg:col-span-3">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-4">
                <h2>Products</h2>
                <Badge variant="secondary" className="squircle-sm">
                  {filteredProducts.length} items
                </Badge>
                {searchQuery && (
                  <Badge variant="outline" className="squircle-sm">
                    Search: "{searchQuery}"
                  </Badge>
                )}
              </div>
              
              <div className="flex items-center gap-2">
                <Button
                  variant={viewMode === 'grid' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setViewMode('grid')}
                  className="glass squircle-sm"
                >
                  <Grid className="w-4 h-4" />
                </Button>
                <Button
                  variant={viewMode === 'list' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setViewMode('list')}
                  className="glass squircle-sm"
                >
                  <List className="w-4 h-4" />
                </Button>
                
                {totalCartItems > 0 && (
                  <Button
                    onClick={() => setCheckoutOpen(true)}
                    className="bg-primary hover:bg-primary/90 squircle-sm"
                  >
                    <ShoppingCart className="w-4 h-4 mr-2" />
                    Checkout ({totalCartItems})
                  </Button>
                )}
              </div>
            </div>

            {filteredProducts.length > 0 ? (
              <div className={`grid gap-6 ${
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

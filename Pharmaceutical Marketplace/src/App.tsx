import { useState, useMemo } from 'react';
import { Header } from './components/Header';
import { FeaturedSection } from './components/FeaturedSection';
import { ProductCard, Product } from './components/ProductCard';
import { CategoryFilter } from './components/CategoryFilter';
import { CheckoutModal } from './components/CheckoutModal';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import { toast } from 'sonner@2.0.3';
import { Grid, List, ShoppingCart } from 'lucide-react';
import { mockProducts, categories, generateReferralCode } from './data/mockData';

interface User {
  name: string;
  email: string;
  referralCode: string;
}

interface CartItem {
  product: Product;
  quantity: number;
}

interface FilterState {
  categories: string[];
  priceRange: [number, number];
  inStockOnly: boolean;
  prescriptionOnly: boolean;
  rating: number;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [filters, setFilters] = useState<FilterState>({
    categories: [],
    priceRange: [0, 500],
    inStockOnly: false,
    prescriptionOnly: false,
    rating: 0
  });

  // Mock login function
  const handleLogin = (email: string, password: string) => {
    const mockUser: User = {
      name: 'Dr. Sarah Johnson',
      email: email,
      referralCode: generateReferralCode()
    };
    setUser(mockUser);
    toast.success(`Welcome back, ${mockUser.name}!`);
  };

  const handleLogout = () => {
    setUser(null);
    toast.success('Logged out successfully');
  };

  const handleAddToCart = (productId: string) => {
    const product = mockProducts.find(p => p.id === productId);
    if (!product) return;

    setCartItems(prev => {
      const existingItem = prev.find(item => item.product.id === productId);
      if (existingItem) {
        return prev.map(item =>
          item.product.id === productId
            ? { ...item, quantity: item.quantity + 1 }
            : item
        );
      }
      return [...prev, { product, quantity: 1 }];
    });
    
    toast.success(`${product.name} added to cart`);
  };

  const handleSearch = (query: string) => {
    setSearchQuery(query);
  };

  const handleCheckout = (referralCode?: string) => {
    toast.success('Order placed successfully!');
    setCartItems([]);
  };

  // Filter and search products
  const filteredProducts = useMemo(() => {
    let filtered = mockProducts;

    // Search filter
    if (searchQuery) {
      filtered = filtered.filter(product =>
        product.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        product.category.toLowerCase().includes(searchQuery.toLowerCase()) ||
        product.manufacturer.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    // Category filter
    if (filters.categories.length > 0) {
      filtered = filtered.filter(product =>
        filters.categories.includes(product.category)
      );
    }

    // Price filter
    filtered = filtered.filter(product =>
      product.price >= filters.priceRange[0] && product.price <= filters.priceRange[1]
    );

    // Stock filter
    if (filters.inStockOnly) {
      filtered = filtered.filter(product => product.inStock);
    }

    // Prescription filter
    if (filters.prescriptionOnly) {
      filtered = filtered.filter(product => product.prescription);
    }

    // Rating filter
    if (filters.rating > 0) {
      filtered = filtered.filter(product => product.rating >= filters.rating);
    }

    return filtered;
  }, [searchQuery, filters]);

  // Get product counts by category
  const productCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    categories.forEach(category => {
      counts[category] = mockProducts.filter(product => product.category === category).length;
    });
    return counts;
  }, []);

  // Get featured products
  const featuredProducts = mockProducts.filter(product => product.originalPrice).slice(0, 4);

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
      />

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        {/* Featured Section */}
        {!searchQuery && filters.categories.length === 0 && (
          <FeaturedSection
            featuredProducts={featuredProducts}
            onAddToCart={handleAddToCart}
          />
        )}

        {/* Products Section */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
          {/* Filters Sidebar */}
          <div className="lg:col-span-1">
            <CategoryFilter
              categories={categories}
              filters={filters}
              onFiltersChange={setFilters}
              productCounts={productCounts}
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
      />
    </div>
  );
}
import { useState } from 'react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Search, User, Gift, ShoppingCart } from 'lucide-react';
// import protixaLogo from 'figma:asset/d428cd31395c54d5cda24313f94d90f6228ba639.png';

interface HeaderProps {
  user: { name: string; referralCode: string } | null;
  onLogin: (email: string, password: string) => void;
  onLogout: () => void;
  cartItems: number;
  onSearch: (query: string) => void;
}

export function Header({ user, onLogin, onLogout, cartItems, onSearch }: HeaderProps) {
  const [loginOpen, setLoginOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    onLogin(email, password);
    setLoginOpen(false);
    setEmail('');
    setPassword('');
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(searchQuery);
  };

  return (
    <header className="sticky top-0 z-50 glass-strong border-b border-white/20 shadow-lg">
      <div className="container mx-auto px-4 py-4">
        <div className="flex items-center justify-between">
          {/* Logo */}
          <div className="flex items-center space-x-3">
            <div className="flex items-center gap-2 px-3 py-1 glass squircle-sm">
              <div className="w-6 h-6 bg-primary squircle-sm"></div>
              <span className="font-bold text-lg">Protixa</span>
            </div>
          </div>

          {/* Search Bar */}
          <form onSubmit={handleSearch} className="flex-1 max-w-md mx-8">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
              <Input
                type="text"
                placeholder="Search medications..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 glass squircle-sm"
              />
            </div>
          </form>

          {/* User Actions */}
          <div className="flex items-center space-x-4">
            {user ? (
              <>
                <div className="flex items-center space-x-2">
                  <Badge variant="secondary" className="glass squircle-sm bg-green-50 text-green-800 border-green-200">
                    <Gift className="w-3 h-3 mr-1" />
                    {user.referralCode}
                  </Badge>
                </div>
                <div className="flex items-center space-x-2">
                  <span className="hidden sm:inline">Welcome, {user.name}</span>
                  <Button variant="outline" size="sm" onClick={onLogout} className="glass squircle-sm">
                    Logout
                  </Button>
                </div>
              </>
            ) : (
              <Dialog open={loginOpen} onOpenChange={setLoginOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline" className="glass squircle-sm">
                    <User className="w-4 h-4 mr-2" />
                    Login
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-md glass-strong squircle-lg">
                  <DialogHeader>
                    <DialogTitle>Sign In</DialogTitle>
                    <DialogDescription>
                      Enter your credentials to access your Protixa account.
                    </DialogDescription>
                  </DialogHeader>
                  <form onSubmit={handleLogin} className="space-y-4">
                    <div>
                      <Label htmlFor="email">Email</Label>
                      <Input
                        id="email"
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="glass squircle-sm"
                        required
                      />
                    </div>
                    <div>
                      <Label htmlFor="password">Password</Label>
                      <Input
                        id="password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="glass squircle-sm"
                        required
                      />
                    </div>
                    <Button type="submit" className="w-full bg-primary hover:bg-primary/90 squircle-sm">
                      Sign In
                    </Button>
                  </form>
                </DialogContent>
              </Dialog>
            )}
            
            {/* Cart */}
            <Button variant="outline" size="sm" className="relative glass squircle-sm">
              <ShoppingCart className="w-4 h-4" />
              {cartItems > 0 && (
                <Badge className="absolute -top-2 -right-2 w-5 h-5 flex items-center justify-center p-0 bg-red-500 squircle-sm">
                  {cartItems}
                </Badge>
              )}
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}
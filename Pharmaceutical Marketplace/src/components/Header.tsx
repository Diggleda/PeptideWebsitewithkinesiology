import { useState } from 'react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Search, User, Gift, ShoppingCart } from 'lucide-react';
import protixaLogo from '../assets/ProtixaLogo.PNG';

interface HeaderProps {
  user: { name: string; referralCode: string } | null;
  onLogin: (email: string, password: string) => void;
  onLogout: () => void;
  cartItems: number;
  onSearch: (query: string) => void;
}

export function Header({ user, onLogin, onLogout, cartItems, onSearch }: HeaderProps) {
  const secondaryColor = 'rgb(7, 27, 27)';
  const translucentSecondary = 'rgba(7, 27, 27, 0.18)';
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
    <header className="sticky top-0 z-50 glass-strong border-b border-white/20">
      <div className="container mx-auto px-4 py-4">
        <div className="flex items-center justify-between">
          {/* Logo */}
          <div className="flex items-center space-x-3">
            <div
              className="flex items-center gap-3 px-3 py-1 glass squircle-sm"
              style={{ borderColor: translucentSecondary }}
            >
              <img src={protixaLogo} alt="Protixa logo" className="h-8 w-auto" />
            </div>
          </div>

          {/* Search Bar */}
          <form onSubmit={handleSearch} className="mx-8 flex-1 max-w-md">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 transform"
                style={{ color: secondaryColor }}
              />
              <Input
                type="text"
                placeholder="Search medications..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="glass squircle-sm pl-10 focus-visible:border-[rgb(7,27,27)] focus-visible:ring-[rgba(7,27,27,0.3)]"
                style={{ borderColor: translucentSecondary }}
              />
            </div>
          </form>

          {/* User Actions */}
          <div className="flex items-center space-x-4">
            {user ? (
              <>
                <div className="flex items-center space-x-2">
                  <Badge
                    variant="secondary"
                    className="glass squircle-sm border"
                    style={{
                      backgroundColor: translucentSecondary,
                      color: secondaryColor,
                      borderColor: translucentSecondary,
                    }}
                  >
                    <Gift className="h-3 w-3" style={{ color: secondaryColor }} />
                    {user.referralCode}
                  </Badge>
                </div>
                <div className="flex items-center space-x-2">
                  <span className="hidden sm:inline" style={{ color: secondaryColor }}>
                    Welcome, {user.name}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onLogout}
                    className="glass squircle-sm"
                    style={{
                      color: secondaryColor,
                      borderColor: translucentSecondary,
                    }}
                  >
                    Logout
                  </Button>
                </div>
              </>
            ) : (
              <Dialog open={loginOpen} onOpenChange={setLoginOpen}>
                <DialogTrigger asChild>
                  <Button
                    variant="outline"
                    className="glass squircle-sm"
                    style={{
                      color: secondaryColor,
                      borderColor: translucentSecondary,
                    }}
                  >
                    <User className="mr-2 h-4 w-4" style={{ color: secondaryColor }} />
                    Login
                  </Button>
                </DialogTrigger>
                <DialogContent
                  className="glass-strong squircle-lg sm:max-w-md"
                  style={{ borderColor: translucentSecondary }}
                >
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
                        className="glass squircle-sm focus-visible:border-[rgb(7,27,27)] focus-visible:ring-[rgba(7,27,27,0.3)]"
                        style={{ borderColor: translucentSecondary }}
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
                        className="glass squircle-sm focus-visible:border-[rgb(7,27,27)] focus-visible:ring-[rgba(7,27,27,0.3)]"
                        style={{ borderColor: translucentSecondary }}
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
            <Button
              variant="outline"
              size="sm"
              className="relative glass squircle-sm"
              style={{
                color: secondaryColor,
                borderColor: translucentSecondary,
              }}
            >
              <ShoppingCart className="h-4 w-4" style={{ color: secondaryColor }} />
              {cartItems > 0 && (
                <Badge
                  className="absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center p-0 glass squircle-sm"
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
          </div>
        </div>
      </div>
    </header>
  );
}

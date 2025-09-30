const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3001;
const SECRET_KEY = 'your-secret-key-change-in-production'; // Change this in production!
const BACKEND_BUILD = '2024.10.01-01';

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Simple file-based storage (easy to migrate to database later)
const DATA_DIR = path.join(__dirname, 'server-data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

// Create data directory if it doesn't exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

// Initialize files if they don't exist
if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(USERS_FILE, JSON.stringify([]));
}
if (!fs.existsSync(ORDERS_FILE)) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify([]));
}

// Helper functions
const writeUsers = (users) => fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

const ensureUserDefaults = (user) => {
  const normalized = { ...user };
  if (typeof normalized.visits !== 'number' || Number.isNaN(normalized.visits)) {
    normalized.visits = normalized.createdAt ? 1 : 0;
  }
  if (!normalized.lastLoginAt) {
    normalized.lastLoginAt = normalized.createdAt || null;
  }
  return normalized;
};

const readUsers = () => {
  const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  let changed = false;
  const normalized = data.map((user) => {
    const candidate = ensureUserDefaults(user);
    if (candidate.visits !== user.visits || candidate.lastLoginAt !== user.lastLoginAt) {
      changed = true;
    }
    return candidate;
  });

  if (changed) {
    writeUsers(normalized);
  }

  return normalized;
};
const readOrders = () => JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
const writeOrders = (orders) => fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));

// Generate unique referral code
const generateReferralCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const users = readUsers();
  const existingCodes = new Set(users.map(u => u.referralCode));

  let result = '';
  let attempts = 0;
  const maxAttempts = 100;

  do {
    result = '';
    for (let i = 0; i < 6; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    attempts++;

    if (attempts > maxAttempts) {
      throw new Error('Unable to generate unique referral code');
    }
  } while (existingCodes.has(result));

  return result;
};

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

// Backend help / diagnostics
app.get('/api/help', (req, res) => {
  const payload = {
    ok: true,
    service: 'Protixa Backend',
    build: BACKEND_BUILD,
    endpoints: ['/api/auth/login', '/api/auth/register', '/api/auth/me', '/api/auth/check-email', '/api/help'],
    timestamp: new Date().toISOString(),
  };

  console.log(`[backend-help] build=${BACKEND_BUILD} timestamp=${payload.timestamp}`);
  res.json(payload);
});

// ============ AUTH ROUTES ============

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const users = readUsers();

    // Check if user exists
    if (users.find(u => u.email === email)) {
      return res.status(409).json({ error: 'EMAIL_EXISTS' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const now = new Date().toISOString();
    const newUser = {
      id: Date.now().toString(),
      name,
      email,
      password: hashedPassword,
      referralCode: generateReferralCode(),
      referralCredits: 0,
      totalReferrals: 0,
      visits: 1,
      createdAt: now,
      lastLoginAt: now
    };

    users.push(newUser);
    writeUsers(users);

    // Generate token
    const token = jwt.sign({ id: newUser.id, email: newUser.email }, SECRET_KEY, { expiresIn: '7d' });

    res.json({
      token,
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        referralCode: newUser.referralCode,
        referralCredits: newUser.referralCredits,
        totalReferrals: newUser.totalReferrals,
        visits: newUser.visits,
        lastLoginAt: newUser.lastLoginAt
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const users = readUsers();
    const userIndex = users.findIndex(u => u.email === email);
    const user = userIndex >= 0 ? users[userIndex] : null;

    if (!user) {
      return res.status(404).json({ error: 'EMAIL_NOT_FOUND' });
    }

    // Check password
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'INVALID_PASSWORD' });
    }

    // Update visit tracking
    const updatedUser = {
      ...user,
      visits: (user.visits || 1) + 1,
      lastLoginAt: new Date().toISOString()
    };
    users[userIndex] = updatedUser;
    writeUsers(users);

    // Generate token
    const token = jwt.sign({ id: user.id, email: user.email }, SECRET_KEY, { expiresIn: '7d' });

    res.json({
      token,
      user: {
        id: updatedUser.id,
        name: updatedUser.name,
        email: updatedUser.email,
        referralCode: updatedUser.referralCode,
        referralCredits: updatedUser.referralCredits || 0,
        totalReferrals: updatedUser.totalReferrals || 0,
        visits: updatedUser.visits,
        lastLoginAt: updatedUser.lastLoginAt
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Email existence check
app.get('/api/auth/check-email', (req, res) => {
  const { email } = req.query;
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'EMAIL_REQUIRED' });
  }

  const users = readUsers();
  const exists = users.some((user) => user.email === email);
  res.json({ exists });
});

// Get current user
app.get('/api/auth/me', authenticateToken, (req, res) => {
  const users = readUsers();
  const user = users.find(u => u.id === req.user.id);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    referralCode: user.referralCode,
    referralCredits: user.referralCredits || 0,
    totalReferrals: user.totalReferrals || 0,
    visits: user.visits || 1,
    lastLoginAt: user.lastLoginAt || null
  });
});

// ============ ORDER ROUTES ============

// Create order
app.post('/api/orders', authenticateToken, (req, res) => {
  try {
    const { items, total, referralCode } = req.body;

    const orders = readOrders();
    const users = readUsers();

    let referrerBonus = null;

    // If referral code is provided, credit the referrer
    if (referralCode) {
      const referrer = users.find(u => u.referralCode === referralCode && u.id !== req.user.id);

      if (referrer) {
        // Calculate 5% commission for referrer
        const commission = total * 0.05;
        referrer.referralCredits = (referrer.referralCredits || 0) + commission;
        referrer.totalReferrals = (referrer.totalReferrals || 0) + 1;

        writeUsers(users);

        referrerBonus = {
          referrerName: referrer.name,
          commission: commission.toFixed(2)
        };
      }
    }

    const newOrder = {
      id: Date.now().toString(),
      userId: req.user.id,
      items,
      total,
      referralCode: referralCode || null,
      referrerBonus,
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    orders.push(newOrder);
    writeOrders(orders);

    res.json({
      success: true,
      order: newOrder,
      message: referrerBonus ? `${referrerBonus.referrerName} earned $${referrerBonus.commission} commission!` : null
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user orders
app.get('/api/orders', authenticateToken, (req, res) => {
  const orders = readOrders();
  const userOrders = orders.filter(o => o.userId === req.user.id);
  res.json(userOrders);
});

// ============ HEALTH CHECK ============
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Backend server running on http://localhost:${PORT}`);
  console.log(`📊 API available at http://localhost:${PORT}/api`);
});

# Backend Guide

## 🚀 Running the Backend Locally

### Start Both Frontend & Backend:
```bash
# Terminal 1: Start backend server
npm run server

# Terminal 2: Start frontend (in a new terminal)
npm run dev
```

The backend will run on **http://localhost:3001**
The frontend will run on **http://localhost:3000**

### Test the Backend:
Open your browser and go to:
```
http://localhost:3001/api/health
```

You should see: `{"status":"ok","message":"Server is running"}`

---

## 📁 How It Works

### File-Based Storage
The backend uses simple JSON files to store data (easy to migrate to a real database later):

- `server-data/users.json` - All user accounts
- `server-data/orders.json` - All orders

**Why file-based?**
- ✅ No database setup needed
- ✅ Easy to see and edit data
- ✅ Simple to migrate to MongoDB/PostgreSQL later

---

## 🔐 API Endpoints

### Authentication
- **POST** `/api/auth/register` - Create new account
  ```json
  {
    "name": "Dr. John Doe",
    "email": "john@example.com",
    "password": "yourpassword"
  }
  ```

- **POST** `/api/auth/login` - Login
  ```json
  {
    "email": "john@example.com",
    "password": "yourpassword"
  }
  ```

- **GET** `/api/auth/me` - Get current user (requires token)

### Orders
- **POST** `/api/orders` - Create order (requires authentication)
  ```json
  {
    "items": [...],
    "total": 123.45,
    "referralCode": "ABC123"
  }
  ```

- **GET** `/api/orders` - Get user's orders (requires authentication)

---

## 🌐 Deploying to Production

### Option 1: Heroku (Easiest)
1. Install Heroku CLI: https://devcenter.heroku.com/articles/heroku-cli
2. Login: `heroku login`
3. Create app: `heroku create your-app-name`
4. Deploy:
   ```bash
   git add .
   git commit -m "Add backend"
   git push heroku main
   ```
5. Your backend will be at: `https://your-app-name.herokuapp.com`

### Option 2: Railway.app (Modern & Free)
1. Go to https://railway.app
2. Click "New Project" → "Deploy from GitHub"
3. Connect your repo
4. Railway auto-detects Node.js and deploys!
5. Get your URL from the dashboard

### Option 3: Render.com (Free Tier)
1. Go to https://render.com
2. Click "New +" → "Web Service"
3. Connect GitHub repo
4. Set:
   - Build Command: `npm install`
   - Start Command: `npm run server`
5. Deploy!

---

## 🔄 Migrating to a Real Database

When you're ready to use MongoDB/PostgreSQL:

1. Replace file operations in `server.js`:
   ```javascript
   // Old (file-based):
   const readUsers = () => JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));

   // New (MongoDB):
   const readUsers = () => User.find();
   ```

2. Install database package:
   ```bash
   npm install mongoose  # for MongoDB
   # or
   npm install pg        # for PostgreSQL
   ```

3. Update connection in `server.js`
4. Deploy new version

---

## 🔒 Security Notes

**IMPORTANT**: Before deploying to production:

1. Change `SECRET_KEY` in `server.js` to a secure random string:
   ```javascript
   const SECRET_KEY = process.env.JWT_SECRET || 'your-secure-random-key-here';
   ```

2. Use environment variables:
   - Create `.env` file (don't commit it!)
   - Store secrets there
   - Use `require('dotenv').config()`

3. Enable HTTPS (hosting providers do this automatically)

---

## 📊 Monitoring Your Backend

### Check if it's running:
```bash
curl http://localhost:3001/api/health
```

### View stored data:
```bash
cat server-data/users.json
cat server-data/orders.json
```

### Watch logs:
The backend prints all requests to the terminal where it's running.

---

## 🐛 Troubleshooting

**Port already in use?**
```bash
# Find what's using port 3001:
lsof -i :3001
# Kill it:
kill -9 <PID>
```

**CORS errors?**
The backend already has CORS enabled for all origins. In production, restrict it:
```javascript
app.use(cors({
  origin: 'https://your-frontend-domain.com'
}));
```

**Can't connect from frontend?**
Make sure:
1. Backend is running (`npm run server`)
2. Frontend API calls use `http://localhost:3001/api`
3. No firewall blocking port 3001

---

## 📝 Next Steps

1. **Start the backend**: `npm run server`
2. **Test it**: Visit http://localhost:3001/api/health
3. **Connect frontend**: Use the `authAPI` in your React components
4. **Deploy**: Choose a hosting platform above
5. **Upgrade to real database**: When ready, follow migration guide above
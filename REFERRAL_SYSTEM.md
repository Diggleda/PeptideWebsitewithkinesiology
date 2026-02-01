# Referral System Documentation

## 🎁 How It Works

When someone uses a referral code during checkout, the referrer (code owner) automatically gets credited!

### Referral Credits System

- **Commission Rate**: 5% of order subtotal
- **Tracking**: All referrals and earnings are tracked automatically
- **Storage**: Stored in `server-data/users.json`

---

## 📊 User Data Structure

Each user has the following referral-related fields:

```json
{
  "id": "1234567890",
  "name": "Dr. John Doe",
  "email": "john@example.com",
  "referralCode": "ABC123",
  "referralCredits": 25.50,
  "totalReferrals": 5,
  "createdAt": "2025-01-01T00:00:00.000Z"
}
```

### Fields:
- `referralCode` - Unique 6-character code (shown in header when logged in)
- `referralCredits` - Total $ earned from referrals
- `totalReferrals` - Number of successful referrals

---

## 🔄 How Referral Credits Work

### When an order is placed with a referral code:

1. **Order Created**: User places order with referral code
2. **Referrer Found**: System looks up who owns that referral code
3. **Credit Applied**: Referrer gets 5% of order subtotal added to their `referralCredits`
4. **Counter Updated**: Referrer's `totalReferrals` count increases by 1
5. **Response**: System confirms who earned the commission

### Example:

```javascript
// User places $100 order with referral code "ABC123"
POST /api/orders
{
  "items": [...],
  "total": 100.00,
  "referralCode": "ABC123"
}

// Response:
{
  "success": true,
  "order": {...},
  "message": "Dr. John Doe earned $5.00 commission!"
}

// Dr. John Doe's account is updated:
// referralCredits: 5.00 → 10.00 (+5.00)
// totalReferrals: 0 → 1
```

---

## 🛡️ Safety Features

- ✅ Users **cannot** use their own referral code
- ✅ Invalid codes are ignored (no error, just no credit)
- ✅ Credits are immediately saved to file storage
- ✅ All referral activity is logged in orders

---

## 📈 Viewing Referral Stats

### From the API:

**Get current user info** (includes referral stats):
```bash
GET /api/auth/me
Authorization: Bearer <token>

Response:
{
  "id": "1234567890",
  "name": "Dr. John Doe",
  "email": "john@example.com",
  "referralCode": "ABC123",
  "referralCredits": 25.50,
  "totalReferrals": 5
}
```

### From the file system:

Check `server-data/users.json` to see all users' referral data.

---

## 💰 Future Enhancements

You can easily add:

1. **Payout System**: Let users cash out their credits
2. **Referral History**: Track which specific orders generated credits
3. **Tiered Commissions**: Different rates for different products
4. **Referral Bonuses**: Extra rewards for milestones (10 referrals, etc.)
5. **Dashboard**: Show referral stats in the UI

---

## 🔧 Technical Details

### Backend Implementation:

The referral system is implemented in `server.js`:

1. **User Creation** - New users get `referralCredits: 0` and `totalReferrals: 0`
2. **Order Processing** - When order includes `referralCode`, system:
   - Finds user with that code
   - Calculates 5% commission
   - Updates their credits and count
   - Saves to file

### Database Migration:

When moving to MongoDB/PostgreSQL, the structure stays the same:

```javascript
// MongoDB Schema Example
const UserSchema = new mongoose.Schema({
  name: String,
  email: String,
  password: String,
  referralCode: String,
  referralCredits: { type: Number, default: 0 },
  totalReferrals: { type: Number, default: 0 },
  createdAt: Date
});
```

---

## 🧪 Testing the System

### Test locally:

1. **Create User 1** (register)
   - Gets referral code: `ABC123`
   - Credits: $0

2. **Create User 2** (register)
   - Gets referral code: `XYZ789`
   - Credits: $0

3. **User 2 places $100 order** with User 1's code (`ABC123`)
   - User 1's credits: $0 → $5
   - User 1's total referrals: 0 → 1

4. **Check User 1's account**:
   ```bash
   cat server-data/users.json
   ```
   Should show updated `referralCredits` and `totalReferrals`!

---

## 📝 Notes

- Commission rate can be changed in `server.js` (currently `0.05` = 5%)
- Referral codes are generated randomly on account creation
- Credits accumulate indefinitely (no expiration)
- System works offline with file storage (no database needed)

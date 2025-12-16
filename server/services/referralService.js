const crypto = require('crypto');
const userRepository = require('../repositories/userRepository');

const generateReferralCode = () => {
  const users = userRepository.getAll();
  const existingCodes = new Set(users.map((user) => user.referralCode).filter(Boolean));
  const maxAttempts = 100;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const code = crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
    if (!existingCodes.has(code)) {
      return code;
    }
  }

  throw new Error('Unable to generate unique referral code');
};

const applyReferralCredit = ({ referralCode, total, purchaserId, orderId }) => {
  if (!referralCode) {
    return null;
  }
  if (!Number.isFinite(total) || total <= 0) {
    return null;
  }

  const referrer = userRepository.findByReferralCode(referralCode);
  if (!referrer || referrer.id === purchaserId) {
    return null;
  }

  const creditedOrders = Array.isArray(referrer.referralOrdersCredited)
    ? referrer.referralOrdersCredited.filter(Boolean).map(String)
    : [];
  if (orderId && creditedOrders.includes(String(orderId))) {
    return null;
  }

  const commission = Number.parseFloat((total * 0.05).toFixed(2));
  const updated = userRepository.update({
    ...referrer,
    referralCredits: (referrer.referralCredits || 0) + commission,
    totalReferrals: (referrer.totalReferrals || 0) + 1,
    ...(orderId
      ? { referralOrdersCredited: [...creditedOrders.slice(-999), String(orderId)] }
      : {}),
  });

  if (!updated) {
    return null;
  }

  return {
    referrerId: updated.id,
    referrerName: updated.name,
    commission,
  };
};

module.exports = {
  generateReferralCode,
  applyReferralCredit,
};

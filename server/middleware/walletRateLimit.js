// Shared per-wallet action cooldown — prevents spam on game-critical endpoints
const walletCooldowns = new Map();

function walletRateLimit(action, cooldownMs = 3000) {
  return (req, res, next) => {
    const wallet = req.body?.wallet || req.query?.wallet;
    if (!wallet) return next();
    const key = `${wallet}:${action}`;
    const now = Date.now();
    const last = walletCooldowns.get(key) || 0;
    if (now - last < cooldownMs) {
      return res.status(429).json({ error: 'Too fast. Please wait a moment.' });
    }
    walletCooldowns.set(key, now);
    next();
  };
}

// Clean cooldowns every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [key, time] of walletCooldowns) {
    if (now - time > 60000) walletCooldowns.delete(key);
  }
}, 300000);

module.exports = walletRateLimit;

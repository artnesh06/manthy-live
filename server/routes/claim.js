const express = require('express');
const router = express.Router();
const { run, get, all, getConfig, getConfigStr, auditLog } = require('../db');
const walletRateLimit = require('../middleware/walletRateLimit');
const { calcEarnRate } = require('./stake');

router.post('/', walletRateLimit('claim', 5000), (req, res) => {
  const TOKEN_NAME = getConfigStr('token_name', '$MTHY');
  const { wallet } = req.body;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });
  const user = get('SELECT * FROM users WHERE wallet = ?', [wallet]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const staked = all('SELECT * FROM staked_nfts WHERE wallet = ?', [wallet]);
  if (staked.length === 0) return res.status(400).json({ error: 'No staked NFTs' });

  const now = new Date();
  let totalEarned = 0;
  for (const nft of staked) {
    const earnPerDay = calcEarnRate(nft.traits);
    const lastEarned = new Date(nft.last_earned + 'Z');
    const diffMs = now - lastEarned;
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    totalEarned += diffDays * earnPerDay;
    run("UPDATE staked_nfts SET last_earned = datetime('now') WHERE id = ?", [nft.id]);
  }
  run('UPDATE users SET mthy_balance = mthy_balance + ? WHERE wallet = ?', [totalEarned, wallet]);

  const updated = get('SELECT * FROM users WHERE wallet = ?', [wallet]);
  const earned = Math.round(totalEarned * 100) / 100;
  const balance = Math.round((updated.mthy_balance || 0) * 100) / 100;
  auditLog('claim', { wallet, amount: earned, detail: `Claimed from ${staked.length} NFTs` });
  res.json({ success: true, earned, balance, message: `Claimed ${earned} ${TOKEN_NAME}` });
});

module.exports = router;

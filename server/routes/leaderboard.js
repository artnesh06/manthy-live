const express = require('express');
const router = express.Router();
const { get, all, getConfig, getConfigStr } = require('../db');

// Public config — frontend asks here for current collection addresses
router.get('/config', async (req, res) => {
  const cosmos = getConfigStr('collection_cosmos', 'cosmos1sz2xd3z3xc5qkmgukh58udkeke4ehlq0wr3cfxh3cnqy005vm72sf6pa77');
  const stars = getConfigStr('collection_stars', 'stars1sz2xd3z3xc5qkmgukh58udkeke4ehlq0wr3cfxh3cnqy005vm72sla963x');
  const survivors = getConfig('max_survivors', 5);
  const tokenName = getConfigStr('token_name', '$MTHY');
  const catchThreshold = getConfig('catch_threshold', 10);
  const tickerExpiresAt = getConfigStr('ticker_expires_at', '');
  const tickerExpired = tickerExpiresAt && new Date(tickerExpiresAt).getTime() < Date.now();
  const tickerMessage = tickerExpired ? '' : getConfigStr('ticker_message', '');
  // Fetch live minted count from contract
  let minted = null;
  try {
    const q = Buffer.from(JSON.stringify({ num_tokens: {} })).toString('base64');
    const resp = await fetch(`https://lcd-cosmoshub.keplr.app/cosmwasm/wasm/v1/contract/${cosmos}/smart/${q}`, {
      signal: AbortSignal.timeout(5000)
    });
    if (resp.ok) {
      const data = await resp.json();
      minted = data?.data?.count ?? null;
    }
  } catch(e) { /* non-fatal */ }
  res.json({ cosmos, stars, survivors, tokenName, minted, catchThreshold, tickerMessage });
});

router.get('/', (req, res) => {
  const { sort = 'hp', limit = 20, offset = 0 } = req.query;
  // FIX: Whitelist sort parameter to prevent SQL injection
  const VALID_SORTS = {
    hp: 'hp DESC, staked_at ASC',
    score: "(hp + CAST((julianday('now') - julianday(staked_at)) AS INTEGER)) DESC, staked_at ASC",
    newest: 'staked_at DESC',
    oldest: 'staked_at ASC'
  };
  const orderBy = VALID_SORTS[sort] || VALID_SORTS.hp;
  const nfts = all(`SELECT *, CAST((julianday('now') - julianday(staked_at)) AS INTEGER) as days_alive FROM staked_nfts ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [Number(limit), Number(offset)]);
  const total = get('SELECT COUNT(*) as count FROM staked_nfts');
  const totalUsers = get('SELECT COUNT(DISTINCT wallet) as count FROM staked_nfts');
  res.json({ nfts, total: total?.count || 0, totalUsers: totalUsers?.count || 0 });
});

router.get('/stats', (req, res) => {
  const alive = get('SELECT COUNT(*) as count FROM staked_nfts')?.count || 0;
  const catchThreshold = getConfig('catch_threshold', 10);
  const weak = get('SELECT COUNT(*) as count FROM staked_nfts WHERE hp <= ?', [catchThreshold])?.count || 0;
  const dead = get('SELECT COUNT(*) as count FROM museum')?.count || 0;
  const survivors = getConfig('max_survivors', 5);
  const totalUsers = get('SELECT COUNT(*) as count FROM users')?.count || 0;
  const config = get("SELECT value FROM game_config WHERE key = 'game_start'");
  const gameEnded = getConfig('game_ended', 0);
  res.json({ alive, weak, dead, survivors, totalUsers, gameStart: config?.value, gameEnded });
});

// Recent catches — for ticker notification
router.get('/catches', (req, res) => {
  const { limit = 10, since } = req.query;
  let catches;
  if (since) {
    catches = all("SELECT * FROM catch_log WHERE caught_at > ? ORDER BY caught_at DESC LIMIT ?", [since, Number(limit)]);
  } else {
    catches = all('SELECT * FROM catch_log ORDER BY caught_at DESC LIMIT ?', [Number(limit)]);
  }
  res.json({ catches });
});

// Catch stats per day — for garden chart
router.get('/catch-stats', (req, res) => {
  const days = all("SELECT DATE(caught_at) as day, COUNT(*) as count FROM catch_log GROUP BY DATE(caught_at) ORDER BY day DESC LIMIT 14");
  res.json({ days });
});

// Winners — public endpoint
router.get('/winners', (req, res) => {
  const winners = all('SELECT * FROM winners ORDER BY hp DESC, days_survived DESC');
  const gameEnded = getConfig('game_ended', 0);
  res.json({ winners, gameEnded });
});

// User leaderboard — sorted by $MTHY balance, includes profile data + catches
router.get('/users', (req, res) => {
  const { limit = 20 } = req.query;
  const users = all(`SELECT u.wallet, u.mthy_balance, u.avatar, u.display_name, COUNT(s.id) as nft_count 
    FROM users u LEFT JOIN staked_nfts s ON u.wallet = s.wallet 
    GROUP BY u.wallet 
    HAVING nft_count > 0 OR u.mthy_balance > 0
    ORDER BY u.mthy_balance DESC 
    LIMIT ?`, [Number(limit)]);
  // Add catch count per user
  const result = users.map(u => {
    const catches = get('SELECT COUNT(*) as count FROM museum WHERE caught_by = ?', [u.wallet]);
    return { ...u, catches: catches?.count || 0 };
  });
  res.json({ users: result });
});

module.exports = router;

const express = require('express');
const router = express.Router();
const { run, get, all, getConfig, getConfigStr, auditLog } = require('../db');
const walletRateLimit = require('../middleware/walletRateLimit');

// === XSS Sanitization — strip HTML/script tags ===
function sanitizeText(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

const COSMOS_LCD_ENDPOINTS = [
  'https://lcd-cosmoshub.keplr.app',
  'https://cosmos-rest.publicnode.com',
  'https://lcd.cosmos.directory/cosmoshub'
];

const STARGAZE_LCD_ENDPOINTS = [
  'https://rpc.stargaze-apis.com',
  'https://rest.stargaze-apis.com'
];

// DB-backed wallet NFT cache
function getCachedWalletNFTs(wallet) {
  const row = get("SELECT nfts, cached_at FROM wallet_nft_cache WHERE wallet = ?", [wallet]);
  if (!row) return null;
  const age = Date.now() - new Date(row.cached_at + 'Z').getTime();
  try {
    const nfts = JSON.parse(row.nfts);
    // Empty results cache only 1 minute (user might have just received NFTs)
    // Non-empty results cache 10 minutes
    const maxAge = (nfts.length === 0) ? 60000 : 600000;
    if (age > maxAge) return null;
    return nfts;
  } catch(e) { return null; }
}

function setCachedWalletNFTs(wallet, nfts) {
  const json = JSON.stringify(nfts);
  run("INSERT OR REPLACE INTO wallet_nft_cache (wallet, nfts, cached_at) VALUES (?, ?, datetime('now'))", [wallet, json]);
}

// In-memory metadata cache
const metaCache = new Map();

router.post('/login', (req, res) => {
  const { wallet } = req.body;
  if (!wallet) return res.status(400).json({ error: 'Wallet address required' });
  // Validate wallet format
  if (!/^(cosmos1|stars1)[a-z0-9]{38,}$/.test(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address format' });
  }
  const existing = get('SELECT * FROM users WHERE wallet = ?', [wallet]);
  // Generate session token (sign once, use for all subsequent requests)
  const createSessionToken = req.app.locals.createSessionToken;
  const sessionToken = createSessionToken(wallet);
  if (existing) {
    run("UPDATE users SET last_seen = datetime('now') WHERE wallet = ?", [wallet]);
    return res.json({ user: existing, isNew: false, sessionToken });
  }
  run('INSERT INTO users (wallet, mthy_balance) VALUES (?, ?)', [wallet, 0]);
  const user = get('SELECT * FROM users WHERE wallet = ?', [wallet]);
  res.json({ user, isNew: true, sessionToken });
});

// One-time welcome bonus — granted on first stake, per user (anti-abuse)
router.post('/welcome-bonus', walletRateLimit('welcome', 3000), (req, res) => {
  // Session verification for write operations
  const verifySessionToken = req.app.locals.verifySessionToken;
  const token = req.headers['x-session-token'];
  const sessionWallet = verifySessionToken(token);
  if (!sessionWallet) return res.status(401).json({ error: 'Invalid or expired session. Please reconnect your wallet.' });

  const { wallet } = req.body;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });
  if (wallet !== sessionWallet) return res.status(403).json({ error: 'Session wallet mismatch' });

  const user = get('SELECT * FROM users WHERE wallet = ?', [wallet]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.welcome_claimed) return res.status(400).json({ error: 'Welcome bonus already claimed' });

  // Must have staked at least one NFT to claim (must actually play)
  const staked = get('SELECT COUNT(*) as count FROM staked_nfts WHERE wallet = ?', [wallet])?.count || 0;
  if (staked < 1) return res.status(400).json({ error: 'Stake at least one Manthy first' });

  const bonus = getConfig('welcome_bonus', 300);
  run('UPDATE users SET mthy_balance = mthy_balance + ?, welcome_claimed = 1 WHERE wallet = ?', [bonus, wallet]);
  const updated = get('SELECT * FROM users WHERE wallet = ?', [wallet]);
  auditLog('welcome-bonus', { wallet, amount: bonus });
  res.json({ success: true, bonus, balance: Math.round((updated.mthy_balance || 0) * 100) / 100 });
});

// Check welcome bonus eligibility (not yet claimed + has staked)
router.get('/welcome-status', (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });
  const user = get('SELECT welcome_claimed FROM users WHERE wallet = ?', [wallet]);
  if (!user) return res.json({ eligible: false, claimed: false });
  const staked = get('SELECT COUNT(*) as count FROM staked_nfts WHERE wallet = ?', [wallet])?.count || 0;
  const bonus = getConfig('welcome_bonus', 300);
  res.json({ eligible: !user.welcome_claimed && staked > 0, claimed: !!user.welcome_claimed, bonus });
});

router.get('/me', (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'Wallet required' });
  const user = get('SELECT * FROM users WHERE wallet = ?', [wallet]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const staked = all('SELECT * FROM staked_nfts WHERE wallet = ?', [wallet]);
  res.json({ user, staked, earnRate: staked.length * 80 });
});

router.get('/nfts', async (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });

  // DEV MODE — return mock NFTs so the UI flow can be tested without blockchain access
  if (process.env.DEV_MODE === '1') {
    const mock = [
      { tokenId: '1', name: 'Manthy #1 (DEV)', imageUrl: 'https://arweave.net/vrPtlQB7hC13opr7I2jm64vVA9DnISnDp6FopaxXGYQ/624.webp' },
      { tokenId: '2', name: 'Manthy #2 (DEV)', imageUrl: '' },
      { tokenId: '3', name: 'Manthy #3 (DEV)', imageUrl: '' }
    ];
    return res.json({ nfts: mock, total: mock.length, dev: true });
  }

  const cached = getCachedWalletNFTs(wallet);
  if (cached) {
    return res.json({ nfts: cached, total: cached.length, cached: true });
  }

  const cosmosCA = getConfigStr('collection_cosmos', 'cosmos1sz2xd3z3xc5qkmgukh58udkeke4ehlq0wr3cfxh3cnqy005vm72sf6pa77');
  const starsCA = getConfigStr('collection_stars', 'stars1sz2xd3z3xc5qkmgukh58udkeke4ehlq0wr3cfxh3cnqy005vm72sla963x');

  let tokenIds = [];
  let foundEndpoint = null;

  // Try Cosmos Hub first
  const query = Buffer.from(JSON.stringify({tokens:{owner:wallet,limit:30}})).toString('base64');
  for (const endpoint of COSMOS_LCD_ENDPOINTS) {
    try {
      const resp = await fetch(`${endpoint}/cosmwasm/wasm/v1/contract/${cosmosCA}/smart/${query}`, {
        signal: AbortSignal.timeout(10000)
      });
      if (resp.ok) {
        const data = await resp.json();
        tokenIds = data?.data?.tokens || [];
        foundEndpoint = endpoint;
        console.log(`[NFT] Found ${tokenIds.length} tokens on Cosmos for ${wallet} (${endpoint})`);
        break;
      } else {
        console.log(`[NFT] Cosmos ${endpoint}: ${resp.status} ${resp.statusText}`);
      }
    } catch(e) {
      console.log(`[NFT] Cosmos ${endpoint}: ${e.message}`);
    }
  }

  // If no tokens on Cosmos, try Stargaze (stars1 wallet format)
  if (tokenIds.length === 0 && wallet.startsWith('stars1')) {
    const starsQuery = Buffer.from(JSON.stringify({tokens:{owner:wallet,limit:30}})).toString('base64');
    for (const endpoint of STARGAZE_LCD_ENDPOINTS) {
      try {
        const resp = await fetch(`${endpoint}/cosmwasm/wasm/v1/contract/${starsCA}/smart/${starsQuery}`, {
          signal: AbortSignal.timeout(10000)
        });
        if (resp.ok) {
          const data = await resp.json();
          tokenIds = data?.data?.tokens || [];
          foundEndpoint = endpoint;
          console.log(`[NFT] Found ${tokenIds.length} tokens on Stargaze for ${wallet} (${endpoint})`);
          break;
        } else {
          console.log(`[NFT] Stargaze ${endpoint}: ${resp.status} ${resp.statusText}`);
        }
      } catch(e) {
        console.log(`[NFT] Stargaze ${endpoint}: ${e.message}`);
      }
    }
  }

  if (tokenIds.length === 0) {
    setCachedWalletNFTs(wallet, []);
    return res.json({ nfts: [], total: 0 });
  }

  const nfts = await Promise.all(tokenIds.map(async (tokenId) => {
    const cacheKey = cosmosCA + ':' + tokenId;
    const mc = metaCache.get(cacheKey);
    if (mc) return { tokenId, name: mc.name, imageUrl: mc.imageUrl };

    // Fetch from contract metadata
    try {
      const nftQuery = Buffer.from(JSON.stringify({all_nft_info:{token_id:tokenId}})).toString('base64');
      const contractUrl = foundEndpoint + `/cosmwasm/wasm/v1/contract/${cosmosCA}/smart/${nftQuery}`;
      const nftResp = await fetch(contractUrl, { signal: AbortSignal.timeout(4000) });

      if (nftResp.ok) {
        const nftData = await nftResp.json();
        const tokenUri = nftData?.data?.info?.token_uri || '';

        if (tokenUri) {
          let metaUrl = tokenUri;
          if (metaUrl.startsWith('ipfs://')) {
            metaUrl = metaUrl.replace('ipfs://', 'https://gateway.pinata.cloud/ipfs/');
          } else if (metaUrl.startsWith('ar://')) {
            metaUrl = metaUrl.replace('ar://', 'https://arweave.net/');
          }

          const metaResp = await fetch(metaUrl, { signal: AbortSignal.timeout(10000) });
          if (metaResp.ok) {
            const metaJson = await metaResp.json();
            let imgUrl = metaJson.image || '';
            if (imgUrl.startsWith('ipfs://')) imgUrl = imgUrl.replace('ipfs://', 'https://gateway.pinata.cloud/ipfs/');
            if (imgUrl.startsWith('ar://')) imgUrl = imgUrl.replace('ar://', 'https://arweave.net/');

            const r = { tokenId, name: metaJson.name || `#${tokenId}`, imageUrl: imgUrl };
            metaCache.set(cacheKey, r);
            return r;
          }
        }
      }
    } catch(e) {
      console.error(`[NFT] Metadata fetch error for ${tokenId}:`, e.message);
    }

    return { tokenId, name: `#${tokenId}`, imageUrl: '' };
  }));

  setCachedWalletNFTs(wallet, nfts);
  res.json({ nfts, total: nfts.length });
});

// Profile: get public profile
router.get('/profile', (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });
  const user = get('SELECT wallet, mthy_balance, avatar, display_name, created_at, last_seen FROM users WHERE wallet = ?', [wallet]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const staked = all('SELECT * FROM staked_nfts WHERE wallet = ?', [wallet]);
  const caught = all('SELECT * FROM museum WHERE original_owner = ?', [wallet]);
  const totalFeeds = get('SELECT COUNT(*) as count FROM feed_history WHERE wallet = ?', [wallet])?.count || 0;
  const winners = all('SELECT * FROM winners WHERE wallet = ?', [wallet]);
  res.json({ user, staked: staked.length, caught: caught.length, totalFeeds, winners: winners.length, earnRate: staked.length * 80 });
});

// Profile: update avatar (base64 image, max 50KB) — with anti-spam + SVG block + session check
router.post('/avatar', walletRateLimit('avatar', 5000), (req, res) => {
  // Session verification for write operations
  const verifySessionToken = req.app.locals.verifySessionToken;
  const token = req.headers['x-session-token'];
  const sessionWallet = verifySessionToken(token);
  if (!sessionWallet) return res.status(401).json({ error: 'Invalid or expired session. Please reconnect your wallet.' });

  const { wallet, avatar } = req.body;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });
  if (wallet !== sessionWallet) return res.status(403).json({ error: 'Session wallet mismatch' });
  if (!avatar) return res.status(400).json({ error: 'avatar required' });
  // Validate: must be base64 data URL, max ~50KB
  if (!avatar.startsWith('data:image/')) return res.status(400).json({ error: 'Invalid image format' });
  // Block SVG (can contain scripts) — only allow png, jpg, gif, webp
  const mimeMatch = avatar.match(/^data:image\/(png|jpeg|jpg|gif|webp);/);
  if (!mimeMatch) return res.status(400).json({ error: 'Only PNG, JPG, GIF, WEBP allowed. No SVG.' });
  if (avatar.length > 70000) return res.status(400).json({ error: 'Image too large. Max 50KB.' });
  const user = get('SELECT * FROM users WHERE wallet = ?', [wallet]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  run('UPDATE users SET avatar = ? WHERE wallet = ?', [avatar, wallet]);
  res.json({ success: true, message: 'Avatar updated' });
});

// Profile: update display name — sanitized + anti-spam + session check
router.post('/name', walletRateLimit('name', 3000), (req, res) => {
  // Session verification for write operations
  const verifySessionToken = req.app.locals.verifySessionToken;
  const token = req.headers['x-session-token'];
  const sessionWallet = verifySessionToken(token);
  if (!sessionWallet) return res.status(401).json({ error: 'Invalid or expired session. Please reconnect your wallet.' });

  const { wallet, name } = req.body;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });
  if (wallet !== sessionWallet) return res.status(403).json({ error: 'Session wallet mismatch' });
  const displayName = sanitizeText((name || '').trim().slice(0, 20));
  const user = get('SELECT * FROM users WHERE wallet = ?', [wallet]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  run('UPDATE users SET display_name = ? WHERE wallet = ?', [displayName, wallet]);
  res.json({ success: true, message: 'Name updated' });
});

// Heatmap: get feed/stake/catch activity per day for a wallet
router.get('/heatmap', (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.json({ days: {}, catches: {} });
  // Count feeds per day
  const feeds = all("SELECT DATE(fed_at) as day, COUNT(*) as count FROM feed_history WHERE wallet = ? GROUP BY DATE(fed_at)", [wallet]);
  // Count stakes per day
  const stakes = all("SELECT DATE(staked_at) as day, COUNT(*) as count FROM staked_nfts WHERE wallet = ? GROUP BY DATE(staked_at)", [wallet]);
  // Count catches against this wallet per day (their NFTs got caught)
  const catches = all("SELECT DATE(caught_at) as day, COUNT(*) as count FROM catch_log WHERE original_owner = ? GROUP BY DATE(caught_at)", [wallet]);
  const days = {};
  for (const f of feeds) { days[f.day] = (days[f.day] || 0) + f.count; }
  for (const s of stakes) { days[s.day] = (days[s.day] || 0) + s.count; }
  const catchDays = {};
  for (const c of catches) { catchDays[c.day] = (catchDays[c.day] || 0) + c.count; }
  const total = Object.values(days).reduce((a, b) => a + b, 0);
  res.json({ days, catches: catchDays, total });
});

module.exports = router;

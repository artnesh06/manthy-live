const express = require('express');
const router = express.Router();
const { run, get, all, getConfig, getConfigStr, auditLog } = require('../db');
const walletRateLimit = require('../middleware/walletRateLimit');

// Get collection addresses from config (dynamic)
function getCollectionAddrs() {
  const cosmos = getConfigStr('collection_cosmos', 'cosmos1sz2xd3z3xc5qkmgukh58udkeke4ehlq0wr3cfxh3cnqy005vm72sf6pa77');
  const stars = getConfigStr('collection_stars', 'stars1sz2xd3z3xc5qkmgukh58udkeke4ehlq0wr3cfxh3cnqy005vm72sla963x');
  return { cosmos, stars };
}

// Bech32 decode/encode for cosmos1 <-> stars1 conversion
function bech32Decode(addr) {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const sep = addr.lastIndexOf('1');
  const data = [];
  for (let i = sep + 1; i < addr.length; i++) {
    const v = CHARSET.indexOf(addr[i]);
    if (v === -1) return null;
    data.push(v);
  }
  // Remove checksum (last 6)
  const conv = data.slice(0, -6);
  // Convert 5-bit to 8-bit
  let acc = 0, bits = 0;
  const bytes = [];
  for (const v of conv) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); }
  }
  return bytes;
}

function bech32Encode(prefix, bytes) {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  // Convert 8-bit to 5-bit
  let acc = 0, bits = 0;
  const data = [];
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) { bits -= 5; data.push((acc >> bits) & 0x1f); }
  }
  if (bits > 0) data.push((acc << (5 - bits)) & 0x1f);
  // Checksum
  function polymod(values) {
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
      const b = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
    }
    return chk;
  }
  const hrpExpand = [];
  for (const c of prefix) hrpExpand.push(c.charCodeAt(0) >> 5);
  hrpExpand.push(0);
  for (const c of prefix) hrpExpand.push(c.charCodeAt(0) & 31);
  const values = [...hrpExpand, ...data, 0, 0, 0, 0, 0, 0];
  const pm = polymod(values) ^ 1;
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((pm >> (5 * (5 - i))) & 31);
  return prefix + '1' + [...data, ...checksum].map(d => CHARSET[d]).join('');
}

function cosmosToStars(cosmosAddr) {
  if (!cosmosAddr || cosmosAddr.startsWith('stars1')) return cosmosAddr;
  if (!cosmosAddr.startsWith('cosmos1')) return cosmosAddr;
  const bytes = bech32Decode(cosmosAddr);
  if (!bytes) return cosmosAddr;
  return bech32Encode('stars', bytes);
}

const COSMOS_REST = 'https://rest.cosmos.directory/cosmoshub';
const COSMOS_LCD_ENDPOINTS = [
  'https://lcd-cosmoshub.keplr.app',
  'https://cosmos-rest.publicnode.com'
];

// Fetch traits — try Stargaze GraphQL first, fallback to Cosmos Hub IPFS metadata
async function fetchTraits(tokenId) {
  // DEV MODE — skip chain trait lookup for local UI testing
  if (process.env.DEV_MODE === '1') return [];
  const { stars, cosmos } = getCollectionAddrs();
  
  // Method 1: Stargaze GraphQL
  try {
    const query = `{ token(collectionAddr:"${stars}", tokenId:"${tokenId}") { traits { name value } } }`;
    const resp = await fetch('https://graphql.mainnet.stargaze-apis.com/graphql', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(5000)
    });
    const data = await resp.json();
    const traits = data?.data?.token?.traits;
    if (traits && traits.length > 0) return traits;
  } catch(e) {}

  // Method 2: Cosmos Hub contract → IPFS metadata → attributes
  try {
    const nftQuery = Buffer.from(JSON.stringify({all_nft_info:{token_id:tokenId}})).toString('base64');
    for (const endpoint of COSMOS_LCD_ENDPOINTS) {
      try {
        const resp = await fetch(`${endpoint}/cosmwasm/wasm/v1/contract/${cosmos}/smart/${nftQuery}`, {
          signal: AbortSignal.timeout(5000)
        });
        if (resp.ok) {
          const nftData = await resp.json();
          const tokenUri = nftData?.data?.info?.token_uri || '';
          if (tokenUri) {
            let metaUrl = tokenUri;
            if (metaUrl.startsWith('ipfs://')) metaUrl = metaUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
            const metaResp = await fetch(metaUrl, { signal: AbortSignal.timeout(8000) });
            if (metaResp.ok) {
              const metaJson = await metaResp.json();
              const attrs = metaJson.attributes || [];
              // Convert {trait_type, value} to {name, value}
              return attrs.map(a => ({ name: a.trait_type || a.name || '', value: a.value || '' }));
            }
          }
        }
      } catch(e) { continue; }
    }
  } catch(e) {}

  console.warn('[STAKE] Trait fetch failed for token', tokenId);
  return [];
}

// Calculate earn rate for an NFT based on base rate + trait bonuses
function calcEarnRate(traits) {
  const baseRate = getConfig('earn_rate_per_day', 80);
  let bonus = 0;
  try {
    const rules = JSON.parse(getConfigStr('trait_bonuses', '[]'));
    const traitArr = typeof traits === 'string' ? JSON.parse(traits) : (traits || []);
    for (const rule of rules) {
      for (const t of traitArr) {
        const nameMatch = (t.name || '').toLowerCase() === (rule.trait_name || '').toLowerCase();
        const valueMatch = rule.trait_value === '*' || (t.value || '').toLowerCase() === (rule.trait_value || '').toLowerCase();
        if (nameMatch && valueMatch) {
          bonus += Number(rule.bonus) || 0;
        }
      }
    }
  } catch(e) {}
  return baseRate + bonus;
}

// Verify NFT ownership via Cosmos Hub REST API (primary) + Stargaze GraphQL (fallback)
async function verifyOwnership(wallet, tokenId) {
  // DEV MODE — skip on-chain ownership check for local UI testing
  if (process.env.DEV_MODE === '1') return { verified: true };
  const { cosmos, stars } = getCollectionAddrs();
  // Method 1: Cosmos Hub REST API
  try {
    const query = Buffer.from(JSON.stringify({owner_of:{token_id:tokenId}})).toString('base64');
    const resp = await fetch(`${COSMOS_REST}/cosmwasm/wasm/v1/contract/${cosmos}/smart/${query}`);
    if (resp.ok) {
      const data = await resp.json();
      const owner = data?.data?.owner;
      if (owner === wallet) return { verified: true };
      if (owner) return { verified: false, reason: `NFT owned by ${owner.slice(0,12)}..., not you` };
    }
  } catch(e) {
    console.warn('[STAKE] Cosmos Hub check failed:', e.message);
  }

  // Method 2: Stargaze GraphQL fallback
  try {
    const starsAddr = cosmosToStars(wallet);
    const query = `{ token(collectionAddr:"${stars}", tokenId:"${tokenId}") { owner { address } } }`;
    const resp = await fetch('https://graphql.mainnet.stargaze-apis.com/graphql', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    const data = await resp.json();
    const owner = data?.data?.token?.owner?.address;
    if (!owner) return { verified: false, reason: 'Token not found' };
    if (owner === starsAddr || owner === wallet) return { verified: true };
    return { verified: false, reason: `NFT owned by ${owner.slice(0,12)}..., not you` };
  } catch (e) {
    console.warn('[STAKE] All ownership checks failed, REJECTING for safety:', e.message);
    return { verified: false, reason: 'Ownership verification unavailable. Please try again later.' };
  }
}

router.post('/', walletRateLimit('stake', 5000), async (req, res) => {
  const { wallet, tokenId, name, imageUrl } = req.body;
  if (!wallet || !tokenId) return res.status(400).json({ error: 'wallet and tokenId required' });
  if (getConfig('game_ended', 0) === 1) return res.status(400).json({ error: 'Game has ended. No more staking allowed.' });
  if (!get('SELECT * FROM users WHERE wallet = ?', [wallet])) return res.status(404).json({ error: 'Login first' });
  const { stars } = getCollectionAddrs();
  if (get('SELECT * FROM staked_nfts WHERE token_id = ? AND collection_addr = ?', [tokenId, stars])) return res.status(400).json({ error: 'Already staked' });
  if (get('SELECT * FROM museum WHERE token_id = ? AND collection_addr = ?', [tokenId, stars])) return res.status(400).json({ error: 'In museum' });

  // FIX: Always verify ownership on-chain — never skip via cache
  const ownership = await verifyOwnership(wallet, tokenId);
  if (!ownership.verified) {
    return res.status(403).json({ error: ownership.reason || 'Not your NFT' });
  }

  // Fetch traits from Stargaze
  const traits = await fetchTraits(tokenId);
  const traitsJson = JSON.stringify(traits);

  run('INSERT INTO staked_nfts (wallet, token_id, collection_addr, name, image_url, traits) VALUES (?, ?, ?, ?, ?, ?)', [wallet, tokenId, stars, name||'', imageUrl||'', traitsJson]);
  run("DELETE FROM wallet_nft_cache WHERE wallet = ?", [wallet]);
  
  const earnRate = calcEarnRate(traits);
  auditLog('stake', { wallet, tokenId, detail: name || tokenId });

  // Broadcast real-time stake event
  const io = req.app.locals.io;
  if (io) io.emit('nft:staked', { tokenId, name: name || tokenId, wallet });

  res.json({ success: true, message: `${name||tokenId} staked!`, earnRate });
});

router.post('/unstake', walletRateLimit('unstake', 5000), (req, res) => {
  const { wallet, tokenId } = req.body;
  if (!wallet || !tokenId) return res.status(400).json({ error: 'wallet and tokenId required' });
  const { stars } = getCollectionAddrs();
  const nft = get('SELECT * FROM staked_nfts WHERE wallet = ? AND token_id = ? AND collection_addr = ?', [wallet, tokenId, stars]);
  if (!nft) return res.status(404).json({ error: 'Not staked by you' });
  
  // Auto-claim pending earnings before unstake (with trait bonus)
  const earnPerDay = calcEarnRate(nft.traits);
  const lastEarned = new Date(nft.last_earned + 'Z');
  const diffDays = (Date.now() - lastEarned.getTime()) / 86400000;
  const pending = diffDays * earnPerDay;
  if (pending > 0) {
    run('UPDATE users SET mthy_balance = mthy_balance + ? WHERE wallet = ?', [pending, wallet]);
  }
  
  run('DELETE FROM staked_nfts WHERE wallet = ? AND token_id = ? AND collection_addr = ?', [wallet, tokenId, stars]);
  run("DELETE FROM wallet_nft_cache WHERE wallet = ?", [wallet]);
  const updated = get('SELECT * FROM users WHERE wallet = ?', [wallet]);
  const balance = Math.round((updated?.mthy_balance || 0) * 100) / 100;
  auditLog('unstake', { wallet, tokenId, amount: Math.round(pending * 100) / 100, detail: 'Auto-claimed pending earnings' });

  // Broadcast real-time unstake event
  const io = req.app.locals.io;
  if (io) io.emit('nft:unstaked', { tokenId, wallet });

  res.json({ success: true, message: 'Unstaked', claimed: Math.round(pending * 100) / 100, balance });
});

router.get('/my', (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });
  const staked = all('SELECT * FROM staked_nfts WHERE wallet = ?', [wallet]);
  const baseRate = getConfig('earn_rate_per_day', 80);
  // Calculate earn rate per NFT including trait bonuses
  const enriched = staked.map(n => {
    const totalRate = calcEarnRate(n.traits);
    const bonus = totalRate - baseRate;
    return { ...n, earnRate: totalRate, earnBonus: bonus, baseRate };
  });
  res.json({ staked: enriched, baseRate });
});

// Batch stake — stake multiple NFTs in one request (used by STAKE ALL)
router.post('/batch', walletRateLimit('stake-batch', 5000), async (req, res) => {
  const { wallet, nfts } = req.body;
  if (!wallet || !Array.isArray(nfts) || nfts.length === 0) return res.status(400).json({ error: 'wallet and nfts[] required' });
  if (getConfig('game_ended', 0) === 1) return res.status(400).json({ error: 'Game has ended. No more staking allowed.' });
  if (!get('SELECT * FROM users WHERE wallet = ?', [wallet])) return res.status(404).json({ error: 'Login first' });
  const { stars } = getCollectionAddrs();

  const results = [];
  for (const nft of nfts) {
    const { tokenId, name, imageUrl } = nft;
    if (!tokenId) { results.push({ tokenId, success: false, error: 'Missing tokenId' }); continue; }
    if (get('SELECT * FROM staked_nfts WHERE token_id = ? AND collection_addr = ?', [tokenId, stars])) { results.push({ tokenId, success: false, error: 'Already staked' }); continue; }
    if (get('SELECT * FROM museum WHERE token_id = ? AND collection_addr = ?', [tokenId, stars])) { results.push({ tokenId, success: false, error: 'In museum' }); continue; }

    try {
      const ownership = await verifyOwnership(wallet, tokenId);
      if (!ownership.verified) { results.push({ tokenId, success: false, error: ownership.reason || 'Not your NFT' }); continue; }

      const traits = await fetchTraits(tokenId);
      const traitsJson = JSON.stringify(traits);
      run('INSERT INTO staked_nfts (wallet, token_id, collection_addr, name, image_url, traits) VALUES (?, ?, ?, ?, ?, ?)', [wallet, tokenId, stars, name||'', imageUrl||'', traitsJson]);
      const earnRate = calcEarnRate(traits);
      auditLog('stake', { wallet, tokenId, detail: name || tokenId });
      results.push({ tokenId, success: true, earnRate });
    } catch(e) {
      results.push({ tokenId, success: false, error: e.message || 'Stake failed' });
    }
  }

  run("DELETE FROM wallet_nft_cache WHERE wallet = ?", [wallet]);
  const staked = results.filter(r => r.success).length;

  // Broadcast real-time stake events
  const io = req.app.locals.io;
  if (io) {
    for (const r of results.filter(r => r.success)) {
      io.emit('nft:staked', { tokenId: r.tokenId, wallet });
    }
  }

  res.json({ success: true, staked, total: nfts.length, results });
});

router.get('/all', (req, res) => {
  const { limit = 20, offset = 0 } = req.query;
  const staked = all('SELECT * FROM staked_nfts ORDER BY hp DESC, staked_at ASC LIMIT ? OFFSET ?', [Number(limit), Number(offset)]);
  const total = get('SELECT COUNT(*) as count FROM staked_nfts');
  res.json({ staked, total: total?.count || 0 });
});

module.exports = router;
module.exports.calcEarnRate = calcEarnRate;
module.exports.getCollectionAddrs = getCollectionAddrs;

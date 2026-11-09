const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { run, get, all, getConfig, getConfigStr, auditLog } = require('../db');

// Decrypt helper (same as winners.js) — NO DEFAULT KEY
const ENC_KEY = process.env.CLAIM_SECRET;
if (!ENC_KEY) {
  console.error('FATAL: CLAIM_SECRET must be set in .env');
  process.exit(1);
}
function decrypt(data) {
  if (!data || !data.includes(':')) return data || '';
  try {
    const key = crypto.createHash('sha256').update(ENC_KEY).digest();
    const [ivHex, encrypted] = data.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch(e) { return data; }
}

router.get('/users', (req, res) => {
  res.json({ users: all('SELECT * FROM users ORDER BY last_seen DESC') });
});

router.post('/add-mthy', (req, res) => {
  const TOKEN_NAME = getConfigStr('token_name', '$MTHY');
  const { wallet, amount } = req.body;
  if (!wallet || !amount) return res.status(400).json({ error: 'wallet and amount required' });
  const user = get('SELECT * FROM users WHERE wallet = ?', [wallet]);
  if (!user) {
    run('INSERT INTO users (wallet, mthy_balance) VALUES (?, ?)', [wallet, amount]);
  } else {
    run('UPDATE users SET mthy_balance = mthy_balance + ? WHERE wallet = ?', [amount, wallet]);
  }
  res.json({ success: true, message: `Added ${amount} ${TOKEN_NAME}` });
  auditLog('admin:add-mthy', { wallet, amount, detail: `Admin added ${amount} ${TOKEN_NAME}` });
});

router.post('/force-catch', (req, res) => {
  const { tokenId } = req.body;
  if (!tokenId) return res.status(400).json({ error: 'tokenId required' });
  const nft = get('SELECT * FROM staked_nfts WHERE token_id = ?', [tokenId]);
  if (!nft) return res.status(404).json({ error: 'Not found' });
  run('INSERT INTO museum (token_id, collection_addr, name, image_url, original_owner, caught_by, reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [nft.token_id, nft.collection_addr, nft.name, nft.image_url, nft.wallet, 'ADMIN', 'Force caught']);
  run('INSERT INTO catch_log (token_id, name, caught_by, original_owner) VALUES (?, ?, ?, ?)',
    [nft.token_id, nft.name, 'ADMIN', nft.wallet]);
  run('DELETE FROM staked_nfts WHERE token_id = ? AND collection_addr = ?', [nft.token_id, nft.collection_addr]);
  auditLog('admin:force-catch', { tokenId, targetWallet: nft.wallet, detail: nft.name });
  res.json({ success: true, message: `Caught ${nft.name}` });
});

router.post('/reset', (req, res) => {
  const { confirm } = req.body;
  if (confirm !== 'RESET_GAME') return res.status(400).json({ error: 'Send confirm: "RESET_GAME"' });
  run('DELETE FROM staked_nfts');
  run('DELETE FROM museum');
  run('DELETE FROM feed_history');
  run('DELETE FROM users');
  run('DELETE FROM winners');
  run('DELETE FROM catch_log');
  run('DELETE FROM wallet_nft_cache');
  run("INSERT OR REPLACE INTO game_config (key, value) VALUES ('game_ended', '0')");
  auditLog('admin:reset', { detail: 'Full game reset — all data cleared' });
  res.json({ success: true, message: 'Game reset — all data cleared' });
});

// Save game config
router.post('/config', (req, res) => {
  const { earn_rate, feed_cost, museum_earn, max_survivors, trait_bonuses, token_name, catch_threshold, min_played_to_end, welcome_bonus, ticker_message } = req.body;
  if (earn_rate != null) run("INSERT OR REPLACE INTO game_config (key, value) VALUES ('earn_rate_per_day', ?)", [String(earn_rate)]);
  if (feed_cost != null) run("INSERT OR REPLACE INTO game_config (key, value) VALUES ('feed_cost', ?)", [String(feed_cost)]);
  if (museum_earn != null) run("INSERT OR REPLACE INTO game_config (key, value) VALUES ('museum_earn', ?)", [String(museum_earn)]);
  if (max_survivors != null) run("INSERT OR REPLACE INTO game_config (key, value) VALUES ('max_survivors', ?)", [String(max_survivors)]);
  if (catch_threshold != null) run("INSERT OR REPLACE INTO game_config (key, value) VALUES ('catch_threshold', ?)", [String(catch_threshold)]);
  if (min_played_to_end != null) run("INSERT OR REPLACE INTO game_config (key, value) VALUES ('min_played_to_end', ?)", [String(min_played_to_end)]);
  if (welcome_bonus != null) run("INSERT OR REPLACE INTO game_config (key, value) VALUES ('welcome_bonus', ?)", [String(welcome_bonus)]);
  if (ticker_message != null) {
    run("INSERT OR REPLACE INTO game_config (key, value) VALUES ('ticker_message', ?)", [String(ticker_message).slice(0, 280)]);
    // Auto-expire 24h after being set; empty message clears expiry too
    const expiresAt = ticker_message.trim() ? new Date(Date.now() + 24*60*60*1000).toISOString() : '';
    run("INSERT OR REPLACE INTO game_config (key, value) VALUES ('ticker_expires_at', ?)", [expiresAt]);
  }
  if (trait_bonuses != null) run("INSERT OR REPLACE INTO game_config (key, value) VALUES ('trait_bonuses', ?)", [typeof trait_bonuses === 'string' ? trait_bonuses : JSON.stringify(trait_bonuses)]);
  if (token_name != null && token_name.trim()) run("INSERT OR REPLACE INTO game_config (key, value) VALUES ('token_name', ?)", [token_name.trim()]);
  auditLog('admin:config', { detail: JSON.stringify(req.body) });
  res.json({ success: true, message: 'Config saved' });
});

// Change collection address (resets game!)
router.post('/change-collection', (req, res) => {
  const { cosmosAddr, confirm } = req.body;
  if (confirm !== 'CHANGE_COLLECTION') return res.status(400).json({ error: 'Confirm with CHANGE_COLLECTION' });
  if (!cosmosAddr || !cosmosAddr.startsWith('cosmos1')) return res.status(400).json({ error: 'Invalid Cosmos address' });
  
  // Auto-convert cosmos → stars
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const sep = cosmosAddr.lastIndexOf('1');
  const data = [];
  for (let i = sep + 1; i < cosmosAddr.length; i++) { data.push(CHARSET.indexOf(cosmosAddr[i])); }
  const conv = data.slice(0, -6);
  let acc = 0, bits = 0; const bytes = [];
  for (const v of conv) { acc = (acc << 5) | v; bits += 5; while (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); } }
  // Encode to stars
  acc = 0; bits = 0; const data5 = [];
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; data5.push((acc >> bits) & 0x1f); } }
  if (bits > 0) data5.push((acc << (5 - bits)) & 0x1f);
  function polymod(v) { const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let c = 1; for (const x of v) { const b = c >> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >> i) & 1) c ^= G[i]; } return c; }
  const hrpE = []; for (const c of 'stars') hrpE.push(c.charCodeAt(0) >> 5); hrpE.push(0); for (const c of 'stars') hrpE.push(c.charCodeAt(0) & 31);
  const vals = [...hrpE, ...data5, 0, 0, 0, 0, 0, 0];
  const pm = polymod(vals) ^ 1;
  const cs = []; for (let i = 0; i < 6; i++) cs.push((pm >> (5 * (5 - i))) & 31);
  const starsAddr = 'stars1' + [...data5, ...cs].map(d => CHARSET[d]).join('');

  // Reset game data
  run('DELETE FROM staked_nfts');
  run('DELETE FROM museum');
  run('DELETE FROM feed_history');
  run('DELETE FROM users');
  run('DELETE FROM winners');
  run('DELETE FROM catch_log');
  run('DELETE FROM wallet_nft_cache');
  run("INSERT OR REPLACE INTO game_config (key, value) VALUES ('game_ended', '0')");
  run("INSERT OR REPLACE INTO game_config (key, value) VALUES ('game_start', ?)", [new Date().toISOString()]);
  
  // Update collection addresses
  run("INSERT OR REPLACE INTO game_config (key, value) VALUES ('collection_cosmos', ?)", [cosmosAddr]);
  run("INSERT OR REPLACE INTO game_config (key, value) VALUES ('collection_stars', ?)", [starsAddr]);
  
  res.json({ success: true, message: `Collection changed to ${cosmosAddr}. Game reset.`, starsAddr });
  auditLog('admin:change-collection', { detail: `Changed to ${cosmosAddr} / ${starsAddr}` });
});

// Get game config
router.get('/config', (req, res) => {
  const rows = all('SELECT * FROM game_config');
  const config = {};
  for (const r of rows) config[r.key] = r.value;
  res.json({ config });
});

// Feed history
router.get('/feed-history', (req, res) => {
  const { limit = 50 } = req.query;
  const history = all('SELECT * FROM feed_history ORDER BY fed_at DESC LIMIT ?', [Number(limit)]);
  res.json({ history });
});

// Game summary
router.get('/summary', (req, res) => {
  const totalUsers = get('SELECT COUNT(*) as count FROM users')?.count || 0;
  const totalStaked = get('SELECT COUNT(*) as count FROM staked_nfts')?.count || 0;
  const totalMuseum = get('SELECT COUNT(*) as count FROM museum')?.count || 0;
  const totalFeeds = get('SELECT COUNT(*) as count FROM feed_history')?.count || 0;
  const totalMthy = get('SELECT SUM(mthy_balance) as total FROM users')?.total || 0;
  const avgHp = get('SELECT AVG(hp) as avg FROM staked_nfts')?.avg || 0;
  const gameEnded = getConfig('game_ended', 0);
  const totalWinners = get('SELECT COUNT(*) as count FROM winners')?.count || 0;
  res.json({ totalUsers, totalStaked, totalMuseum, totalFeeds, totalMthy: Math.floor(totalMthy), avgHp: Math.round(avgHp), gameEnded, totalWinners });
});

// End game — declare top 20 NFTs as winners
router.post('/end-game', (req, res) => {
  const { confirm } = req.body;
  if (confirm !== 'END_GAME') return res.status(400).json({ error: 'Send confirm: "END_GAME"' });
  
  const maxSurvivors = getConfig('max_survivors', 5);
  const survivors = all('SELECT * FROM staked_nfts ORDER BY hp DESC, staked_at ASC LIMIT ?', [maxSurvivors]);
  
  if (survivors.length === 0) return res.status(400).json({ error: 'No staked NFTs to declare as winners' });
  
  // Insert winners
  const now = new Date();
  for (const nft of survivors) {
    const daysSurvived = Math.floor((now - new Date(nft.staked_at + 'Z')) / 86400000);
    run('INSERT OR IGNORE INTO winners (token_id, collection_addr, wallet, name, image_url, hp, days_survived) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [nft.token_id, nft.collection_addr, nft.wallet, nft.name, nft.image_url, nft.hp, daysSurvived]);
  }
  
  // Mark game as ended
  run("INSERT OR REPLACE INTO game_config (key, value) VALUES ('game_ended', '1')");
  
  auditLog('admin:end-game', { detail: `${survivors.length} winners declared` });
  res.json({ success: true, message: `Game ended! ${survivors.length} winners declared.`, winners: survivors.length });
});

// Get winners (decrypted for admin)
router.get('/winners', (req, res) => {
  const winners = all('SELECT * FROM winners ORDER BY hp DESC, days_survived DESC');
  const decrypted = winners.map(w => ({
    ...w,
    claim_wallet: decrypt(w.claim_wallet),
    claim_address: decrypt(w.claim_address),
    claim_discord: decrypt(w.claim_discord),
    claim_twitter: decrypt(w.claim_twitter)
  }));
  res.json({ winners: decrypted });
});

// Undo end game — revert game_ended flag and clear winners
router.post('/undo-end-game', (req, res) => {
  const { confirm } = req.body;
  if (confirm !== 'UNDO_END_GAME') return res.status(400).json({ error: 'Send confirm: "UNDO_END_GAME"' });
  
  const gameEnded = getConfig('game_ended', 0);
  if (gameEnded !== 1) return res.status(400).json({ error: 'Game is not ended' });
  
  // Check if any prizes have been claimed
  const claimed = get('SELECT COUNT(*) as count FROM winners WHERE claimed_at IS NOT NULL');
  if (claimed && claimed.count > 0) {
    return res.status(400).json({ error: `Cannot undo: ${claimed.count} prize(s) already claimed. Reset winners first.` });
  }
  
  run('DELETE FROM winners');
  run("INSERT OR REPLACE INTO game_config (key, value) VALUES ('game_ended', '0')");
  
  auditLog('admin:undo-end-game', { detail: 'Game un-ended, winners cleared' });
  res.json({ success: true, message: 'Game un-ended. Winners cleared. Game is running again.' });
});

// Audit log — view all game actions (immutable, read-only)
router.get('/audit-log', (req, res) => {
  const { limit = 100, action, wallet } = req.query;
  let sql = 'SELECT * FROM audit_log';
  const params = [];
  const conditions = [];
  if (action) { conditions.push('action = ?'); params.push(action); }
  if (wallet) { conditions.push('(wallet = ? OR target_wallet = ?)'); params.push(wallet, wallet); }
  if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(Number(limit));
  res.json({ logs: all(sql, params) });
});

module.exports = router;

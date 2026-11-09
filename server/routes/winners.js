const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { run, get, all, auditLog } = require('../db');

// Simple AES-256 encryption for sensitive claim data — NO DEFAULT KEY
const ENC_KEY = process.env.CLAIM_SECRET;
if (!ENC_KEY) {
  console.error('FATAL: CLAIM_SECRET must be set in .env');
  process.exit(1);
}
const ENC_ALGO = 'aes-256-cbc';

function encrypt(text) {
  if (!text) return '';
  const key = crypto.createHash('sha256').update(ENC_KEY).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENC_ALGO, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(data) {
  if (!data || !data.includes(':')) return data || '';
  try {
    const key = crypto.createHash('sha256').update(ENC_KEY).digest();
    const [ivHex, encrypted] = data.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(ENC_ALGO, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch(e) {
    return data; // Return raw if decryption fails (legacy unencrypted data)
  }
}

// Get my winning NFTs (decrypt sensitive fields)
router.get('/my', (req, res) => {
  const { wallet } = req.query;
  if (!wallet) return res.status(400).json({ error: 'wallet required' });
  const winners = all('SELECT * FROM winners WHERE wallet = ?', [wallet]);
  // Decrypt for the owner only — mask address, show wallet
  const safe = winners.map(w => ({
    ...w,
    claim_wallet: w.claim_wallet ? decrypt(w.claim_wallet) : '',
    claim_address: w.claimed_at ? '••• (submitted)' : '',
    claim_discord: w.claim_discord ? decrypt(w.claim_discord) : '',
    claim_twitter: w.claim_twitter ? decrypt(w.claim_twitter) : ''
  }));
  res.json({ winners: safe });
});

// Claim prize — submit wallet address + shipping address + contacts (session protected)
router.post('/claim', (req, res) => {
  // Session verification for write operations
  const verifySessionToken = req.app.locals.verifySessionToken;
  const token = req.headers['x-session-token'];
  const sessionWallet = verifySessionToken(token);
  if (!sessionWallet) return res.status(401).json({ error: 'Invalid or expired session. Please reconnect your wallet.' });

  const { wallet, tokenId, claimWallet, claimAddress, discord, twitter } = req.body;
  if (!wallet || !tokenId) return res.status(400).json({ error: 'wallet and tokenId required' });
  if (wallet !== sessionWallet) return res.status(403).json({ error: 'Session wallet mismatch' });
  if (!claimWallet || !claimWallet.trim()) return res.status(400).json({ error: 'Wallet address is required for receiving 1/1 art' });
  if (!claimAddress || !claimAddress.trim()) return res.status(400).json({ error: 'Shipping address is required for merchandise' });

  // Validate wallet format (cosmos1/stars1)
  const w = claimWallet.trim();
  if (!/^(cosmos1|stars1)[a-z0-9]{38,}$/.test(w)) {
    return res.status(400).json({ error: 'Invalid wallet address. Must start with cosmos1 or stars1' });
  }

  // Validate shipping address has enough info
  const addr = claimAddress.trim();
  if (addr.length < 10) {
    return res.status(400).json({ error: 'Shipping address too short. Include full name, street, city, country, zip.' });
  }

  // At least one contact method required
  const disc = (discord || '').trim();
  const tw = (twitter || '').trim();
  if (!disc && !tw) {
    return res.status(400).json({ error: 'Provide at least one contact: Discord or Twitter/X' });
  }

  const winner = get('SELECT * FROM winners WHERE wallet = ? AND token_id = ?', [wallet, tokenId]);
  if (!winner) return res.status(404).json({ error: 'Not a winner or not your NFT' });
  if (winner.claimed_at) return res.status(400).json({ error: 'Already claimed' });

  // Encrypt sensitive data before storing
  const encWallet = encrypt(w);
  const encAddress = encrypt(addr);
  const encDiscord = disc ? encrypt(disc) : '';
  const encTwitter = tw ? encrypt(tw) : '';

  run("UPDATE winners SET claim_wallet = ?, claim_address = ?, claim_discord = ?, claim_twitter = ?, claimed_at = datetime('now') WHERE wallet = ? AND token_id = ?",
    [encWallet, encAddress, encDiscord, encTwitter, wallet, tokenId]);

  auditLog('prize-claim', { wallet, tokenId, detail: winner.name });
  res.json({ success: true, message: `Prize claimed for ${winner.name}!` });
});

module.exports = router;

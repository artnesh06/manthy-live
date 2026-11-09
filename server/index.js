const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const http = require('http');

// Load .env file if dotenv is available
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch(e) {}

const { initDB } = require('./db');
const { startCronJobs } = require('./cron');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

// === CREDENTIALS — NO DEFAULTS, MUST BE SET IN .env ===
const ADMIN_KEY = process.env.ADMIN_KEY;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!ADMIN_KEY || !ADMIN_USER || !ADMIN_PASS) {
  console.error('FATAL: ADMIN_KEY, ADMIN_USER, and ADMIN_PASS must be set in .env');
  process.exit(1);
}
if (!SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET must be set in .env (random string, min 32 chars)');
  process.exit(1);
}

// === SESSION TOKEN SYSTEM ===
// User signs in once → gets a session token → all write requests require it
// Token = wallet + expiry + HMAC signature (no external dependency needed)
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 hours

function createSessionToken(wallet) {
  const expires = Date.now() + SESSION_DURATION;
  const payload = `${wallet}:${expires}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}:${sig}`;
}

function verifySessionToken(token) {
  if (!token) return null;
  const parts = token.split(':');
  if (parts.length !== 3) return null;
  const [wallet, expiresStr, sig] = parts;
  const expires = Number(expiresStr);
  if (isNaN(expires) || Date.now() > expires) return null; // expired
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(`${wallet}:${expiresStr}`).digest('hex');
  // Timing-safe comparison
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch(e) { return null; }
  return wallet;
}

// Middleware: verify session token for write endpoints
function requireSession(req, res, next) {
  const token = req.headers['x-session-token'];
  const wallet = verifySessionToken(token);
  if (!wallet) {
    return res.status(401).json({ error: 'Invalid or expired session. Please reconnect your wallet.' });
  }
  // Ensure the wallet in the token matches the wallet in the request body/query
  const reqWallet = req.body?.wallet || req.query?.wallet;
  if (reqWallet && reqWallet !== wallet) {
    return res.status(403).json({ error: 'Session wallet mismatch. Please reconnect.' });
  }
  // Attach verified wallet to request
  req.sessionWallet = wallet;
  next();
}

// Export for use in routes
app.locals.createSessionToken = createSessionToken;
app.locals.verifySessionToken = verifySessionToken;

// === CORS — production only, no localhost ===
const allowedOrigins = process.env.NODE_ENV === 'development'
  ? ['https://manthy.fun', 'https://www.manthy.fun', 'https://manthy.vercel.app', 'http://localhost:3001', 'http://localhost:3000']
  : ['https://manthy.fun', 'https://www.manthy.fun', 'https://manthy.vercel.app'];

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

// === SOCKET.IO — real-time game events (optional — works without it) ===
let io = null;
try {
  const { Server: SocketServer } = require('socket.io');
  io = new SocketServer(server, {
    cors: { origin: allowedOrigins, credentials: true },
    pingTimeout: 60000,
    pingInterval: 25000
  });

  io.on('connection', (socket) => {
    socket.on('join', (wallet) => {
      if (wallet && typeof wallet === 'string') {
        socket.join(`wallet:${wallet}`);
      }
    });
  });
  console.log('[WS] Socket.io enabled');
} catch(e) {
  console.log('[WS] Socket.io not installed — running without WebSocket');
}

// Make io accessible from routes via app.locals
app.locals.io = io;

// === SECURITY HEADERS ===
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.json({ limit: '100kb' }));

// === RATE LIMITING (improved in-memory with per-route support) ===
const rateMap = new Map();
function rateLimit(maxReqs, windowMs) {
  return (req, res, next) => {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = forwarded ? forwarded.split(',')[0].trim() : (req.ip || 'unknown');
    const now = Date.now();
    if (!rateMap.has(ip)) rateMap.set(ip, []);
    const hits = rateMap.get(ip).filter(t => t > now - windowMs);
    if (hits.length >= maxReqs) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
    hits.push(now);
    rateMap.set(ip, hits);
    next();
  };
}

// Strict rate limit for admin login — 5 attempts per 15 minutes
const adminLoginLimit = rateLimit(5, 15 * 60 * 1000);

// Clean rate map every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of rateMap) {
    const valid = hits.filter(t => t > now - 15 * 60 * 1000);
    if (valid.length === 0) rateMap.delete(ip);
    else rateMap.set(ip, valid);
  }
}, 300000);

// === ADMIN AUTH MIDDLEWARE ===
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized. Invalid admin key.' });
  }
  next();
}

// Admin HTML — served normally (has its own login page)
// Admin login endpoint — rate limited, validates credentials + optional TOTP, returns admin key
// === TOTP 2FA for Admin ===
// If ADMIN_TOTP_SECRET is set in .env, admin login requires a 6-digit TOTP code (Google Authenticator)
const ADMIN_TOTP_SECRET = process.env.ADMIN_TOTP_SECRET; // base32 encoded secret

function generateTOTP(secret, timeStep = 30) {
  // Decode base32 secret
  const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.toUpperCase().replace(/=+$/, '')) {
    const val = base32Chars.indexOf(c);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const keyBytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    keyBytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  const key = Buffer.from(keyBytes);

  // Time counter
  const counter = Math.floor(Date.now() / 1000 / timeStep);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter & 0xffffffff, 4);

  // HMAC-SHA1
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset + 1] << 16 | hmac[offset + 2] << 8 | hmac[offset + 3]) % 1000000;
  return code.toString().padStart(6, '0');
}

function verifyTOTP(secret, inputCode) {
  if (!secret || !inputCode) return false;
  // Check current window ± 1 (allows 30s clock drift)
  for (const offset of [-1, 0, 1]) {
    const counter = Math.floor(Date.now() / 1000 / 30) + offset;
    const counterBuf = Buffer.alloc(8);
    counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    counterBuf.writeUInt32BE(counter & 0xffffffff, 4);

    const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const c of secret.toUpperCase().replace(/=+$/, '')) {
      const val = base32Chars.indexOf(c);
      if (val === -1) continue;
      bits += val.toString(2).padStart(5, '0');
    }
    const keyBytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      keyBytes.push(parseInt(bits.substring(i, i + 8), 2));
    }
    const key = Buffer.from(keyBytes);

    const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
    const off = hmac[hmac.length - 1] & 0x0f;
    const code = ((hmac[off] & 0x7f) << 24 | hmac[off + 1] << 16 | hmac[off + 2] << 8 | hmac[off + 3]) % 1000000;
    if (code.toString().padStart(6, '0') === inputCode.toString().padStart(6, '0')) return true;
  }
  return false;
}

if (ADMIN_TOTP_SECRET) {
  console.log('[AUTH] Admin TOTP 2FA is ENABLED');
} else {
  console.warn('[AUTH] Admin TOTP 2FA is DISABLED — set ADMIN_TOTP_SECRET in .env for extra security');
}

app.post('/api/admin-login', adminLoginLimit, express.json(), (req, res) => {
  const { id, pw, totp } = req.body;
  if (!id || !pw) {
    return res.status(400).json({ error: 'ID and password required' });
  }
  // Constant-time comparison to prevent timing attacks
  const trimId = id.trim();
  const trimPw = pw.trim();
  const trimUser = ADMIN_USER.trim();
  const trimPass = ADMIN_PASS.trim();
  
  const idMatch = trimId.length === trimUser.length && crypto.timingSafeEqual(Buffer.from(trimId), Buffer.from(trimUser));
  const pwMatch = trimPw.length === trimPass.length && crypto.timingSafeEqual(Buffer.from(trimPw), Buffer.from(trimPass));
  if (idMatch && pwMatch) {
    // If TOTP is enabled, verify the code
    if (ADMIN_TOTP_SECRET) {
      if (!totp) {
        return res.status(400).json({ error: '2FA code required', requires2FA: true });
      }
      if (!verifyTOTP(ADMIN_TOTP_SECRET, totp)) {
        return res.status(401).json({ error: 'Invalid 2FA code' });
      }
    }
    return res.json({ success: true, key: ADMIN_KEY });
  }
  // Delay response on failure to slow brute force
  setTimeout(() => {
    res.status(401).json({ error: 'Invalid credentials' });
  }, 1000);
});
// API endpoints still protected by X-Admin-Key header
app.use(express.static(path.join(__dirname, '..'), {
  index: 'index.html'
}));

// Rate limit: 200 requests per minute for write APIs
const writeLimit = rateLimit(200, 60000);
// Rate limit: 400 requests per minute for read APIs
const readLimit = rateLimit(400, 60000);

app.use('/api/auth', readLimit, require('./routes/auth'));
// Stake: GET routes are public reads, POST routes need session
const stakeRouter = require('./routes/stake');
app.get('/api/stake/my', readLimit, stakeRouter);
app.get('/api/stake/all', readLimit, stakeRouter);
app.use('/api/stake', writeLimit, requireSession, stakeRouter);
app.use('/api/feed', writeLimit, requireSession, require('./routes/feed'));
app.use('/api/catch', writeLimit, requireSession, require('./routes/catch'));
app.use('/api/claim', writeLimit, requireSession, require('./routes/claim'));
app.use('/api/leaderboard', readLimit, require('./routes/leaderboard'));
app.use('/api/museum', readLimit, require('./routes/museum'));
app.use('/api/admin', adminAuth, require('./routes/admin'));
// Winners: GET routes are public, POST claim needs session
const winnersRouter = require('./routes/winners');
app.get('/api/winners/my', readLimit, winnersRouter);
app.use('/api/winners', readLimit, winnersRouter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// SPA fallback — serve index.html for client-side routes
const SPA_ROUTES = ['/stake', '/arena', '/garden', '/gallery', '/museum', '/ranks', '/rules', '/profile'];
SPA_ROUTES.forEach(route => {
  app.get(route, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
  });
});

// Init DB then start server
initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`Manthy server on port ${PORT}`);
    console.log(`Admin panel: /admin.html`);
    startCronJobs();
  });
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});

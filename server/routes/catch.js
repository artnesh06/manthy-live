const express = require('express');
const router = express.Router();
const { run, get, all, getConfig, transaction, auditLog } = require('../db');
const walletRateLimit = require('../middleware/walletRateLimit');

// Check if game should auto-end after a catch
function checkAutoEndGame() {
  if (getConfig('game_ended', 0) === 1) return;
  const maxSurvivors = getConfig('max_survivors', 5);
  const minPlayed = getConfig('min_played_to_end', 15);
  const alive = get('SELECT COUNT(*) as count FROM staked_nfts')?.count || 0;
  const dead = get('SELECT COUNT(*) as count FROM museum')?.count || 0;
  const totalPlayed = alive + dead;
  if (alive > 0 && alive <= maxSurvivors && totalPlayed >= minPlayed) {
    const survivors = all('SELECT * FROM staked_nfts ORDER BY hp DESC, staked_at ASC');
    const now = new Date();
    for (const nft of survivors) {
      const daysSurvived = Math.floor((now - new Date(nft.staked_at + 'Z')) / 86400000);
      run('INSERT OR IGNORE INTO winners (token_id, collection_addr, wallet, name, image_url, hp, days_survived) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [nft.token_id, nft.collection_addr, nft.wallet, nft.name, nft.image_url, nft.hp, daysSurvived]);
    }
    run("INSERT OR REPLACE INTO game_config (key, value) VALUES ('game_ended', '1')");
    console.log(`[CATCH] Auto end-game! ${survivors.length} winners declared.`);
  }
}

router.post('/', walletRateLimit('catch', 5000), (req, res) => {
  const { wallet, tokenId } = req.body;
  if (!wallet || !tokenId) return res.status(400).json({ error: 'wallet and tokenId required' });

  // Block catches if game ended
  if (getConfig('game_ended', 0) === 1) return res.status(400).json({ error: 'Game has ended' });

  if (!get('SELECT * FROM users WHERE wallet = ?', [wallet])) return res.status(404).json({ error: 'User not found' });

  // FIX: Use database transaction to prevent race condition
  // All checks + delete + insert happen atomically — no two requests can catch the same NFT
  try {
    const result = transaction(() => {
      const nft = get('SELECT * FROM staked_nfts WHERE token_id = ?', [tokenId]);
      if (!nft) return { error: 'NFT not in garden (may have been caught already)', status: 404 };
      const catchThreshold = getConfig('catch_threshold', 10);
      if (nft.hp > catchThreshold) return { error: 'HP too high (' + nft.hp + '%). Catchable at ' + catchThreshold + '% or below.', status: 400 };
      if (nft.wallet === wallet) return { error: "Can't catch your own", status: 400 };

      // Delete from staked — inside transaction, so only one request can succeed
      run('DELETE FROM staked_nfts WHERE token_id = ? AND collection_addr = ?', [nft.token_id, nft.collection_addr]);

      // Insert into museum + catch log
      run('INSERT INTO museum (token_id, collection_addr, name, image_url, original_owner, caught_by, reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [nft.token_id, nft.collection_addr, nft.name, nft.image_url, nft.wallet, wallet, 'Caught in the garden']);
      run('INSERT INTO catch_log (token_id, name, caught_by, original_owner) VALUES (?, ?, ?, ?)',
        [nft.token_id, nft.name, wallet, nft.wallet]);

      return { success: true, nft };
    });

    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }

    // Check if game should auto-end (outside transaction — non-critical)
    checkAutoEndGame();

    auditLog('catch', { wallet, tokenId, targetWallet: result.nft.wallet, detail: result.nft.name });

    // Broadcast real-time catch event
    const io = req.app.locals.io;
    if (io) {
      io.emit('nft:caught', { tokenId, name: result.nft.name, caughtBy: wallet, originalOwner: result.nft.wallet });
      io.to(`wallet:${result.nft.wallet}`).emit('my:nft-caught', { tokenId, name: result.nft.name, caughtBy: wallet });
    }

    res.json({ success: true, message: `${result.nft.name} caught!` });
  } catch (e) {
    console.error('[CATCH] Transaction failed:', e.message);
    return res.status(409).json({ error: 'Catch conflict, try again' });
  }
});

module.exports = router;

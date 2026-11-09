const cron = require('node-cron');
const { run, all, get, getConfig, getConfigStr } = require('./db');

// Import calcEarnRate and getCollectionAddrs from stake route
let calcEarnRate, getCollectionAddrs;
try {
  const stakeModule = require('./routes/stake');
  calcEarnRate = stakeModule.calcEarnRate;
  getCollectionAddrs = stakeModule.getCollectionAddrs;
} catch(e) {
  // Fallback if circular dependency
  calcEarnRate = () => getConfig('earn_rate_per_day', 80);
  getCollectionAddrs = () => ({
    cosmos: getConfigStr('collection_cosmos', 'cosmos1sz2xd3z3xc5qkmgukh58udkeke4ehlq0wr3cfxh3cnqy005vm72sf6pa77'),
    stars: getConfigStr('collection_stars', 'stars1sz2xd3z3xc5qkmgukh58udkeke4ehlq0wr3cfxh3cnqy005vm72sla963x')
  });
}

// Auto-detect game end: if staked NFTs ≤ max_survivors, declare winners
function checkAutoEndGame() {
  if (getConfig('game_ended', 0) === 1) return;
  const maxSurvivors = getConfig('max_survivors', 5);
  const minPlayed = getConfig('min_played_to_end', 15);
  const alive = get('SELECT COUNT(*) as count FROM staked_nfts')?.count || 0;
  const dead = get('SELECT COUNT(*) as count FROM museum')?.count || 0;
  const totalPlayed = alive + dead;
  // Only auto-end if: enough NFTs have played (min_played_to_end total)
  // AND alive count dropped to max_survivors or below
  if (alive > 0 && alive <= maxSurvivors && totalPlayed >= minPlayed) {
    console.log(`[CRON] Auto end-game triggered! ${alive} alive, ${dead} dead (total ${totalPlayed})`);
    const survivors = all('SELECT * FROM staked_nfts ORDER BY hp DESC, staked_at ASC');
    const now = new Date();
    for (const nft of survivors) {
      const daysSurvived = Math.floor((now - new Date(nft.staked_at + 'Z')) / 86400000);
      run('INSERT OR IGNORE INTO winners (token_id, collection_addr, wallet, name, image_url, hp, days_survived) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [nft.token_id, nft.collection_addr, nft.wallet, nft.name, nft.image_url, nft.hp, daysSurvived]);
    }
    run("INSERT OR REPLACE INTO game_config (key, value) VALUES ('game_ended', '1')");
    console.log(`[CRON] Game ended! ${survivors.length} winners declared automatically.`);
  }
}

function startCronJobs() {
  // HP Decay — every 30 minutes, -1% per 30 min
  cron.schedule('0,30 * * * *', () => {
    if (getConfig('game_ended', 0) === 1) return;
    console.log('[CRON] HP decay...');
    const staked = all('SELECT * FROM staked_nfts');
    const now = new Date();
    let decayed = 0;
    let errors = 0;
    for (const nft of staked) {
      try {
        const lastFed = new Date(nft.last_fed + 'Z');
        const minutes = (now - lastFed) / (1000 * 60);
        // Decay: -1% per 30 minutes → 0% in 50 hours
        let newHp = Math.max(0, Math.round(100 - (minutes / 30)));
        if (newHp !== nft.hp) {
          run('UPDATE staked_nfts SET hp = ? WHERE id = ?', [newHp, nft.id]);
          decayed++;
        }
      } catch(e) {
        errors++;
        console.warn(`[CRON] HP decay failed for ${nft.token_id}:`, e.message);
      }
    }
    console.log(`[CRON] ${decayed} NFTs decayed${errors ? `, ${errors} errors` : ''}`);
  });

  // Museum earn — every hour, add earnings to original owners
  cron.schedule('30 * * * *', () => {
    console.log('[CRON] Museum earnings...');
    const museumEarnRate = getConfig('museum_earn', 16); // default 16/day (80 * 0.2)
    const earnPerHour = museumEarnRate / 24;
    const exhibits = all('SELECT * FROM museum');
    let earned = 0;
    let errors = 0;
    for (const ex of exhibits) {
      try {
        if (ex.original_owner) {
          const user = get('SELECT * FROM users WHERE wallet = ?', [ex.original_owner]);
          if (user) {
            run('UPDATE users SET mthy_balance = mthy_balance + ? WHERE wallet = ?', [earnPerHour, ex.original_owner]);
            earned++;
          }
        }
      } catch(e) {
        errors++;
        console.warn(`[CRON] Museum earn failed for ${ex.token_id}:`, e.message);
      }
    }
    if (earned > 0 || errors > 0) console.log(`[CRON] ${earned} museum NFTs earned${errors ? `, ${errors} errors` : ''}`);
  });

  // Auto-catch — every 6 hours, catch NFTs with HP = 0%
  cron.schedule('0 */6 * * *', () => {
    if (getConfig('game_ended', 0) === 1) return;
    console.log('[CRON] Auto-catch check...');
    const dead = all('SELECT * FROM staked_nfts WHERE hp <= 0');
    let caught = 0;
    let errors = 0;
    for (const nft of dead) {
      try {
        run('INSERT INTO museum (token_id, collection_addr, name, image_url, original_owner, caught_by, reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [nft.token_id, nft.collection_addr, nft.name, nft.image_url, nft.wallet, 'SYSTEM', 'Auto-caught: HP reached 0%']);
        run('INSERT INTO catch_log (token_id, name, caught_by, original_owner) VALUES (?, ?, ?, ?)',
          [nft.token_id, nft.name, 'SYSTEM', nft.wallet]);
        run('DELETE FROM staked_nfts WHERE id = ?', [nft.id]);
        caught++;
      } catch(e) {
        errors++;
        console.warn(`[CRON] Auto-catch failed for ${nft.token_id}:`, e.message);
      }
    }
    if (caught > 0 || errors > 0) console.log(`[CRON] Auto-caught ${caught} dead NFTs${errors ? `, ${errors} errors` : ''}`);

    // Auto-detect game end: if ≤ max_survivors NFTs remain, declare winners
    checkAutoEndGame();
  });

  // Ownership verification — every 30 minutes, check if staked NFTs still owned by staker
  // Uses batched processing with concurrency control and retry logic
  const COSMOS_REST_ENDPOINTS = [
    'https://lcd-cosmoshub.keplr.app',
    'https://cosmos-rest.publicnode.com'
  ];

  let ownershipRunning = false; // Prevent overlapping runs

  async function verifyOneNft(nft, cosmos) {
    const query = Buffer.from(JSON.stringify({owner_of:{token_id:nft.token_id}})).toString('base64');
    let currentOwner = null;
    let lastError = null;

    for (const endpoint of COSMOS_REST_ENDPOINTS) {
      // Retry each endpoint up to 2 times with backoff
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const resp = await fetch(`${endpoint}/cosmwasm/wasm/v1/contract/${cosmos}/smart/${query}`, {
            signal: AbortSignal.timeout(5000)
          });
          if (resp.ok) {
            const data = await resp.json();
            currentOwner = data?.data?.owner;
            if (currentOwner) return currentOwner;
          }
        } catch(e) {
          lastError = e;
          if (attempt === 0) await new Promise(r => setTimeout(r, 1000)); // 1s backoff before retry
        }
      }
    }
    return null; // All endpoints failed
  }

  // Process NFTs in batches of N concurrently
  async function processBatch(nfts, concurrency, cosmos) {
    let removed = 0;
    let checked = 0;
    let errors = 0;

    for (let i = 0; i < nfts.length; i += concurrency) {
      const batch = nfts.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map(async (nft) => {
          const currentOwner = await verifyOneNft(nft, cosmos);
          if (!currentOwner) return { nft, status: 'skip' };
          if (currentOwner !== nft.wallet) return { nft, status: 'transferred', currentOwner };
          return { nft, status: 'ok' };
        })
      );

      for (const result of results) {
        checked++;
        if (result.status === 'rejected') { errors++; continue; }
        const { nft, status, currentOwner } = result.value;
        if (status === 'transferred') {
          try {
            const earnPerDay = calcEarnRate(nft.traits);
            const lastEarned = new Date(nft.last_earned + 'Z');
            const diffDays = (Date.now() - lastEarned.getTime()) / 86400000;
            const pending = diffDays * earnPerDay;
            if (pending > 0) {
              run('UPDATE users SET mthy_balance = mthy_balance + ? WHERE wallet = ?', [pending, nft.wallet]);
            }
            run('DELETE FROM staked_nfts WHERE id = ?', [nft.id]);
            run("DELETE FROM wallet_nft_cache WHERE wallet = ?", [nft.wallet]);
            run("DELETE FROM wallet_nft_cache WHERE wallet = ?", [currentOwner]);
            removed++;
            console.log(`[CRON] Auto-unstaked ${nft.name} (${nft.token_id}) — transferred`);
          } catch(e) {
            errors++;
            console.warn(`[CRON] DB update failed for ${nft.token_id}:`, e.message);
          }
        }
      }

      // Small delay between batches to avoid rate limiting
      if (i + concurrency < nfts.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }
    return { removed, checked, errors };
  }

  cron.schedule('*/30 * * * *', async () => {
    if (ownershipRunning) {
      console.log('[CRON] Ownership check still running, skipping...');
      return;
    }
    ownershipRunning = true;
    const startTime = Date.now();
    const MAX_RUNTIME = 25 * 60 * 1000; // 25 min max (leave 5 min buffer before next run)

    try {
      console.log('[CRON] Ownership verification...');
      const { cosmos } = getCollectionAddrs();
      const staked = all('SELECT * FROM staked_nfts');

      if (staked.length === 0) {
        console.log('[CRON] No staked NFTs to verify');
        return;
      }

      // Adaptive concurrency: more NFTs = higher concurrency (up to 5)
      const concurrency = Math.min(5, Math.max(2, Math.ceil(staked.length / 100)));
      console.log(`[CRON] Verifying ${staked.length} NFTs (concurrency: ${concurrency})`);

      const { removed, checked, errors } = await processBatch(staked, concurrency, cosmos);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`[CRON] Ownership done: ${checked} checked, ${removed} removed, ${errors} errors (${elapsed}s)`);
    } catch(e) {
      console.error('[CRON] Ownership verification crashed:', e.message);
    } finally {
      ownershipRunning = false;
    }
  });

  console.log('[CRON] Started (HP decay hourly, museum earn hourly, auto-catch every 6h, ownership check every 30m)');
}

module.exports = { startCronJobs };

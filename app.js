'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
const WALLET         = '0xe88284dbf9342eb4d02b291d4577227d49edbd83';
const DATA_API       = 'https://data-api.polymarket.com';
const POLYGON_RPC    = 'https://polygon-bor-rpc.publicnode.com';
const USDC_CONTRACT  = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const USDCE_CONTRACT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const GAMMA_API          = '/.netlify/functions/gamma';
const SUPABASE_URL       = 'https://kfclevcoyzxaubxcxzdd.supabase.co';
const SUPABASE_ANON_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtmY2xldmNveXp4YXVieGN4emRkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MzA1MDYsImV4cCI6MjA5MTQwNjUwNn0.zf2j_odQJpoPrdWGhJXnM5NmMkaKK2iQGA51eRSu9Do';
const POLL_INTERVAL      = 3000;  // ms — Polymarket API poll
const CHAIN_POLL_INTERVAL = 2000; // ms — Polygon chain poll (faster)
const PASS_HASH      = '6fb5194f18297746a5e5101dc3e0c3f5d721104a0612ad65d561d9d4176669a8';
const OPPOSITE       = { Up: 'Down', Down: 'Up' };

// ERC-20 Transfer topic: Transfer(address,address,uint256)
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// Polymarket CTF Exchange contract (executes trades)
const CTF_EXCHANGE   = '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e';
// Contracts that send USDC TO wallet as winnings/redemptions (NOT deposits)
const PAYOUT_CONTRACTS = new Set([
  '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e', // CTF Exchange
  '0xc5d563a36ae78145c45a50134d48a1215220f80a', // NegRisk CTF Exchange
  '0xd91e80cf2e7be2e162c6513ced06f1dd0da35296', // NegRisk Adapter
  '0x4d97dcd97ec945f40cf65f87097ace5ea0476045', // Conditional Tokens Framework
]);

// ── Supabase ──────────────────────────────────────────────────────────────────
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── State ─────────────────────────────────────────────────────────────────────
let allTrades           = [];
let sortKey             = 'ts';
let sortDir             = -1;
let pnlCache            = {};  // conditionId → position — loaded from Supabase on boot
let chartInst           = null;
let currentProfitPeriod = 'day';
let prevValues          = {};   // track previous numbers for flash animation
let depositHistory      = [];   // [{ts, amount, txHash, block}] — loaded from Supabase on boot
let pollTimer        = null;
let chainPollTimer   = null;
let isRunning        = false;
let lastKnownBlock   = null;
let pendingChainTxs  = {}; // txHash → pending row data, replaced when API catches up
let knownApiTxHashes = new Set(); // tracks what the API already returned

// ── Auth ──────────────────────────────────────────────────────────────────────
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function checkPassword() {
  const input = document.getElementById('pwd-input').value;
  const hash  = await sha256(input);
  if (hash === PASS_HASH) {
    sessionStorage.setItem('auth', '1');
    document.getElementById('auth-gate').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    startPolling();
  } else {
    document.getElementById('pwd-error').textContent = 'Incorrect password';
    document.getElementById('pwd-input').value = '';
    document.getElementById('pwd-input').focus();
  }
}

// ── API Fetches ───────────────────────────────────────────────────────────────
async function erc20Balance(contract) {
  const data = '0x70a08231' + WALLET.slice(2).toLowerCase().padStart(64, '0');
  const res  = await fetch(POLYGON_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call',
      params: [{ to: contract, data }, 'latest'], id: 1 }),
  });
  const json = await res.json();
  return parseInt(json.result || '0x0', 16) / 1e6;
}

// ── Chain Polling (instant detection) ────────────────────────────────────────
async function rpc(method, params) {
  const res = await fetch(POLYGON_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const json = await res.json();
  return json.result;
}

async function getLatestBlock() {
  const hex = await rpc('eth_blockNumber', []);
  return parseInt(hex, 16);
}

async function getBlockTimestamp(blockHex) {
  const block = await rpc('eth_getBlockByNumber', [blockHex, false]);
  return block ? parseInt(block.timestamp, 16) : Math.floor(Date.now() / 1000);
}

// Watch for USDC transfers FROM wallet (= money leaving = a bet being placed)
async function pollChain() {
  try {
    const latestBlock = await getLatestBlock();
    if (!lastKnownBlock) {
      lastKnownBlock = latestBlock; // init — don't backfill old txs on first load
      chainPollTimer = setTimeout(pollChain, CHAIN_POLL_INTERVAL);
      return;
    }
    if (latestBlock <= lastKnownBlock) {
      chainPollTimer = setTimeout(pollChain, CHAIN_POLL_INTERVAL);
      return;
    }

    const fromBlock = '0x' + (lastKnownBlock + 1).toString(16);
    const toBlock   = '0x' + latestBlock.toString(16);
    const walletPadded = '0x' + WALLET.slice(2).toLowerCase().padStart(64, '0');

    // Fetch both outgoing (bets) and incoming (deposits) transfers in parallel
    const [outLogs, inLogs] = await Promise.all([
      rpc('eth_getLogs', [{
        fromBlock, toBlock,
        address: [USDC_CONTRACT, USDCE_CONTRACT],
        topics:  [TRANSFER_TOPIC, walletPadded],  // FROM wallet = bet
      }]),
      rpc('eth_getLogs', [{
        fromBlock, toBlock,
        address: [USDC_CONTRACT, USDCE_CONTRACT],
        topics:  [TRANSFER_TOPIC, null, walletPadded], // TO wallet = deposit or winnings
      }]),
    ]);

    lastKnownBlock = latestBlock;

    // ── Outgoing: new bets ────────────────────────────────────────────────────
    for (const log of (outLogs || [])) {
      const txHash = log.transactionHash;
      if (knownApiTxHashes.has(txHash) || pendingChainTxs[txHash]) continue;
      const amount = parseInt(log.data, 16) / 1e6;
      const ts     = await getBlockTimestamp(log.blockNumber);
      const time   = new Date(ts * 1000).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
      });
      pendingChainTxs[txHash] = {
        ts, time, title: 'Detecting market…', outcome: '—', actual: null,
        notional: amount, price_pct: null, pnl: null, pnl_pct: null,
        status: 'pending', tx: txHash, isPending: true,
      };
    }

    // ── Incoming: deposits (not payouts from Polymarket) ──────────────────────
    let newDeposit = false;
    for (const log of (inLogs || [])) {
      const fromAddr = ('0x' + log.topics[1].slice(26)).toLowerCase();
      if (PAYOUT_CONTRACTS.has(fromAddr)) continue;
      const amount = parseInt(log.data, 16) / 1e6;
      if (amount < 1) continue;
      if (depositHistory.some(d => d.txHash === log.transactionHash)) continue;
      const ts  = await getBlockTimestamp(log.blockNumber);
      await saveDepositToDB({ ts, amount, txHash: log.transactionHash, block: parseInt(log.blockNumber, 16) });
      newDeposit = true;
    }

    if (Object.keys(pendingChainTxs).length > 0) mergeAndRenderTrades();
    if (newDeposit) renderProfitChart(allTrades, currentProfitPeriod);
  } catch (e) {
    // silent — chain poll errors don't break the UI
  }
  chainPollTimer = setTimeout(pollChain, CHAIN_POLL_INTERVAL);
}

function mergeAndRenderTrades() {
  // Pending txs not yet in API
  const pending = Object.values(pendingChainTxs)
    .filter(p => !knownApiTxHashes.has(p.tx));

  allTrades = [...pending, ...(allTrades.filter(t => !t.isPending))];
  filterTrades();
}

async function fetchAll() {
  const cb = `_=${Date.now()}`;
  const [posRes, tradeRes, usdc, usdce] = await Promise.all([
    fetch(`${DATA_API}/positions?user=${WALLET}&limit=500&${cb}`),
    fetch(`${DATA_API}/trades?user=${WALLET}&limit=500&${cb}`),
    erc20Balance(USDC_CONTRACT),
    erc20Balance(USDCE_CONTRACT),
  ]);
  return {
    positions: await posRes.json(),
    trades:    await tradeRes.json(),
    cash:      usdc + usdce,
  };
}

// ── Outcome cache (gamma API → Supabase) ─────────────────────────────────────
let outcomeCache = {}; // slug → { winner, outcomes, prices } — loaded from Supabase on boot

async function loadCachesFromDB() {
  const [outRes, pnlRes, depRes] = await Promise.all([
    sb.from('outcome_cache').select('*'),
    sb.from('pnl_cache').select('*'),
    sb.from('deposits').select('*').order('ts', { ascending: true }),
  ]);
  if (outRes.error) console.error('outcome_cache load error:', outRes.error);
  if (pnlRes.error) console.error('pnl_cache load error:', pnlRes.error);
  for (const row of outRes.data || [])
    outcomeCache[row.slug] = { winner: row.winner, outcomes: row.outcomes, prices: row.prices };
  for (const row of pnlRes.data || [])
    pnlCache[row.condition_id] = row.data;
  depositHistory = (depRes.data || []).map(r => ({
    ts: r.ts, amount: parseFloat(r.amount), txHash: r.tx_hash, block: r.block_num,
  }));
  console.log(`DB loaded: ${(outRes.data||[]).length} outcomes, ${(pnlRes.data||[]).length} pnl, ${depositHistory.length} deposits`);
}

async function saveOutcomeToDB(slug, entry) {
  outcomeCache[slug] = entry;
  const { error } = await sb.from('outcome_cache').upsert({ slug, winner: entry.winner, outcomes: entry.outcomes, prices: entry.prices });
  if (error) console.error('outcome save error:', error);
  else console.log('saved outcome:', slug, entry.winner);
}

async function savePnlToDB(conditionId, posData) {
  pnlCache[conditionId] = posData;
  const { error } = await sb.from('pnl_cache').upsert({ condition_id: conditionId, data: posData });
  if (error) console.error('pnl save error:', error);
}

async function saveDepositToDB(dep) {
  if (depositHistory.some(d => d.txHash === dep.txHash)) return;
  depositHistory.push(dep);
  depositHistory.sort((a, b) => a.ts - b.ts);
  const { error } = await sb.from('deposits').upsert({
    tx_hash: dep.txHash, amount: dep.amount, ts: dep.ts, block_num: dep.block,
  });
  if (error) console.error('deposit save error:', error);
  else console.log(`Deposit saved: $${dep.amount.toFixed(2)} at ${new Date(dep.ts * 1000).toLocaleString()}`);
}

// ── Deposit History Scan ──────────────────────────────────────────────────────
async function scanDepositHistory() {
  try {
    const latestBlock  = await getLatestBlock();
    const walletPadded = '0x' + WALLET.slice(2).toLowerCase().padStart(64, '0');

    const { data: metaRow } = await sb.from('app_meta')
      .select('value').eq('key', 'deposit_scan_block').maybeSingle();
    const lastScanned = metaRow ? parseInt(metaRow.value) : 0;

    const historicalStart = latestBlock - 90 * 43200;
    const fromBlock = Math.max(lastScanned + 1, historicalStart);
    if (fromBlock >= latestBlock) {
      console.log('Deposit scan: already up to date');
      return;
    }

    console.log(`Deposit scan: blocks ${fromBlock} → ${latestBlock} (~${Math.round((latestBlock - fromBlock) / 43200)} days)`);

    const knownHashes = new Set(depositHistory.map(d => d.txHash));
    const CHUNK = 2000; // ~1 hour — safe for all public RPCs

    // Build all chunk ranges
    const chunks = [];
    for (let b = fromBlock; b <= latestBlock; b += CHUNK)
      chunks.push([b, Math.min(b + CHUNK - 1, latestBlock)]);

    // Process in parallel batches of 20
    const BATCH = 20;
    let found = 0;
    for (let i = 0; i < chunks.length; i += BATCH) {
      await Promise.all(chunks.slice(i, i + BATCH).map(async ([b, toB]) => {
        const result = await rpc('eth_getLogs', [{
          fromBlock: '0x' + b.toString(16),
          toBlock:   '0x' + toB.toString(16),
          address:   [USDC_CONTRACT, USDCE_CONTRACT],
          topics:    [TRANSFER_TOPIC, null, walletPadded],
        }]);
        if (!Array.isArray(result)) return;
        for (const log of result) {
          if (knownHashes.has(log.transactionHash)) continue;
          const fromAddr = ('0x' + log.topics[1].slice(26)).toLowerCase();
          if (PAYOUT_CONTRACTS.has(fromAddr)) continue;
          const amount = parseInt(log.data, 16) / 1e6;
          if (amount < 1) continue;
          const ts = await getBlockTimestamp(log.blockNumber);
          const dep = { ts, amount, txHash: log.transactionHash, block: parseInt(log.blockNumber, 16) };
          knownHashes.add(dep.txHash);
          await saveDepositToDB(dep);
          found++;
        }
      }));
    }

    await sb.from('app_meta').upsert({ key: 'deposit_scan_block', value: String(latestBlock) });
    const total = depositHistory.reduce((s, d) => s + d.amount, 0);
    console.log(`Deposit scan done. Found ${found} new deposits. Total: ${depositHistory.length} deposits, $${total.toFixed(2)}`);

    if (allTrades.length > 0) renderProfitChart(allTrades, currentProfitPeriod);
  } catch (e) {
    console.error('scanDepositHistory error:', e);
  }
}

// Fetch outcomes for slugs we don't have yet — runs in background, then re-renders
async function fetchMissingOutcomes(trades) {
  const missing = [...new Set(
    trades
      .filter(t => t.status === 'unknown' && t.eventSlug && !outcomeCache[t.eventSlug])
      .map(t => t.eventSlug)
  )].slice(0, 20); // max 20 per cycle to avoid rate limiting

  if (missing.length === 0) return false;

  // Fetch in parallel, 5 at a time
  const chunks = [];
  for (let i = 0; i < missing.length; i += 5)
    chunks.push(missing.slice(i, i + 5));

  let changed = false;
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async slug => {
      try {
        const res  = await fetch(`${GAMMA_API}?slug=${slug}`);
        const data = await res.json();
        if (!data || !data[0]) return;
        const event = data[0];
        const mkt   = event.markets?.[0];
        if (!mkt) return;
        // Only resolve when the market is actually closed
        if (!mkt.closed) return;
        const outcomes = JSON.parse(mkt.outcomes || '[]');
        const prices   = JSON.parse(mkt.outcomePrices || '[]');
        // Find winner: the outcome whose price resolved to 1
        const winIdx = prices.findIndex(p => parseFloat(p) >= 0.99);
        const winner = winIdx >= 0 ? outcomes[winIdx] : null;
        if (winner) {
          saveOutcomeToDB(slug, { winner, outcomes, prices });
          changed = true;
        }
      } catch {}
    }));
  }
  return changed;
}

// ── Compute ───────────────────────────────────────────────────────────────────
function compute(trades, positions, cash) {
  // Build P&L map + update cache
  const pnlMap = {};
  for (const p of positions) {
    pnlMap[p.conditionId] = p;
    if (p.redeemable && p.cashPnl !== undefined) {
      savePnlToDB(p.conditionId, p);
    }
  }

  const livePos      = positions.filter(p => !p.redeemable);
  const redeemPos    = positions.filter(p => p.redeemable);
  const openValue    = livePos.reduce((s, p) => s + (p.currentValue || 0), 0);
  const redeemable   = redeemPos.reduce((s, p) => s + (p.currentValue || 0), 0);
  const portfolio    = cash + openValue + redeemable;
  const sessionPnl   = positions.reduce((s, p) => s + (p.cashPnl || 0), 0);
  const totalInvested = trades.reduce((s, t) => s + t.size * t.price, 0);

  const wins     = redeemPos.filter(p => p.cashPnl > 0).length;
  const winRate  = redeemPos.length > 0 ? Math.round(wins / redeemPos.length * 100) : null;

  const upCount   = trades.filter(t => t.outcome === 'Up').length;
  const downCount = trades.length - upCount;
  const totalVol  = trades.reduce((s, t) => s + t.size * t.price, 0);

  const daily = {};
  for (const t of trades) {
    const day = new Date(t.timestamp * 1000).toISOString().slice(0, 10);
    daily[day] = (daily[day] || 0) + t.size * t.price;
  }

  const pseudonym = trades[0]?.pseudonym || '';

  // Mark these tx hashes as known so pending rows get dropped
  for (const t of trades) knownApiTxHashes.add(t.transactionHash);
  // Drop pending rows the API now covers
  for (const tx of Object.keys(pendingChainTxs)) {
    if (knownApiTxHashes.has(tx)) delete pendingChainTxs[tx];
  }

  const enriched = trades.map(t => {
    const pos      = pnlMap[t.conditionId] || pnlCache[t.conditionId];
    const notional = t.size * t.price;
    const time     = new Date(t.timestamp * 1000).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
    });
    let pnl = null, pnl_pct = null, status = 'unknown', actual = null;

    if (pos) {
      pnl     = pos.cashPnl;
      pnl_pct = pos.percentPnl;
      if (pos.curPrice > 0 && !pos.redeemable) {
        status = 'live';
      } else if (pos.redeemable) {
        const won = pos.cashPnl > 0;
        status = won ? 'won' : 'lost';
        actual = won ? t.outcome : OPPOSITE[t.outcome];
      }
    }

    // Fall back to gamma outcome cache for historical trades with no position data
    if (status === 'unknown' && t.eventSlug && outcomeCache[t.eventSlug]) {
      actual = outcomeCache[t.eventSlug].winner;
      if (actual) {
        const won = actual === t.outcome;
        status    = won ? 'won' : 'lost';
        // Reconstruct P&L from trade price: won → notional*(1/price - 1), lost → -notional
        const price = t.price; // 0-1
        pnl     = won ? +(t.size * t.price * (1 / price - 1)).toFixed(2) : +(-(t.size * t.price)).toFixed(2);
        pnl_pct = won ? +((1 / price - 1) * 100).toFixed(1) : -100;
      }
    }

    return { ts: t.timestamp, time, title: t.title, outcome: t.outcome, actual,
             notional, price_pct: t.price * 100, pnl, pnl_pct, status,
             tx: t.transactionHash, eventSlug: t.eventSlug };
  });

  return { cash, portfolio, redeemable, sessionPnl, totalInvested, winRate,
           upCount, downCount, totalVol, daily, pseudonym, pnlMap, enriched, positions };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const fmt  = v => '$' + Math.abs(v).toFixed(2);
const pnlFmt = v => (v >= 0 ? '+' : '') + '$' + Math.abs(v).toFixed(2);
const pnlCls = v => v >= 0 ? 'pnl-positive' : 'pnl-negative';

const coinName = t => { const m = t.match(/^(Bitcoin|Solana|Dogecoin|Ethereum|XRP|BNB|Cardano)/i); return m ? m[1] : t.split(' ')[0]; };
const timeWin  = t => { const m = t.match(/(\d+:\d+[AP]M-\d+:\d+[AP]M\s+ET)/i); return m ? m[1] : ''; };

function setVal(id, text, cssClass) {
  const el = $(id);
  if (!el) return;
  const prev = prevValues[id];
  if (prev !== undefined && prev !== text) {
    // Detect direction for flash
    const pn = parseFloat(prev.replace(/[^0-9.-]/g, ''));
    const nn = parseFloat(text.replace(/[^0-9.-]/g, ''));
    if (!isNaN(pn) && !isNaN(nn)) {
      el.classList.remove('value-up', 'value-down');
      void el.offsetWidth; // reflow
      el.classList.add(nn > pn ? 'value-up' : 'value-down');
    }
  }
  prevValues[id] = text;
  el.textContent = text;
  if (cssClass !== undefined) {
    el.className = 'bc-value' + (cssClass ? ' ' + cssClass : '');
  }
}

// ── Render: balance ───────────────────────────────────────────────────────────
function renderBalance(d) {
  setVal('cash-balance',      fmt(d.cash));
  setVal('portfolio-value',   fmt(d.portfolio));
  setVal('redeemable-value',  fmt(d.redeemable));

  const sp = $('session-pnl');
  sp.textContent = pnlFmt(d.sessionPnl);
  sp.className   = 'bc-value ' + (d.sessionPnl >= 0 ? 'pnl-positive' : 'pnl-negative');
}

// ── Render: stats ─────────────────────────────────────────────────────────────
function renderStats(d) {
  const upPct   = d.trades ? Math.round(d.upCount / d.trades * 100) : 0;
  const allCount = d.upCount + d.downCount;

  const cards = [
    { id: 'stat-trades',  label: 'Total Trades', val: allCount, sub: '' },
    { id: 'stat-volume',  label: 'Total Volume',  val: '$' + d.totalVol.toFixed(2), sub: '' },
    { id: 'stat-winrate', label: 'Win Rate',      val: d.winRate != null ? d.winRate + '%' : '—', sub: 'resolved trades' },
    { id: 'stat-up',      label: 'Bet Up',        val: d.upCount, sub: upPct + '% of trades' },
    { id: 'stat-down',    label: 'Bet Down',      val: d.downCount, sub: (100 - upPct) + '% of trades' },
  ];
  for (const c of cards) {
    $(c.id).innerHTML = `<div class="stat-label">${c.label}</div>
      <div class="stat-value">${c.val}</div>
      ${c.sub ? `<div class="stat-sub">${c.sub}</div>` : ''}`;
  }
}

// ── Render: positions ─────────────────────────────────────────────────────────
function renderPositions(positions) {
  // Only show truly active (in-window) positions — expired ones disappear automatically
  const live = positions.filter(p => p.curPrice > 0 && !p.redeemable);

  $('pos-pulse').className   = 'pulse-dot' + (live.length > 0 ? ' active' : '');
  $('pos-badge').textContent = live.length > 0 ? `${live.length} active` : 'idle';
  $('pos-meta').textContent  = `updated ${new Date().toLocaleTimeString()}`;

  if (live.length === 0) {
    $('positions-content').innerHTML = '<div class="positions-empty">No active positions — bot is idle</div>';
    return;
  }

  let html = '<div class="positions-grid">';
  for (const p of live) {
    const dir      = p.outcome.toLowerCase();
    const pricePct = Math.round(p.curPrice * 100);
    html += `
      <div class="pos-card live-${dir}">
        <span class="pos-tag live">live</span>
        <div class="pos-top">
          ${p.icon ? `<img class="pos-icon" src="${p.icon}" onerror="this.style.display='none'">` : `<div class="pos-icon-fb">${coinName(p.title).slice(0,3).toUpperCase()}</div>`}
          <div class="pos-info">
            <div class="pos-name">${coinName(p.title)} 5-min</div>
            <div class="pos-time">${timeWin(p.title)}</div>
          </div>
          <span class="dir-badge ${dir}">${p.outcome.toUpperCase()}</span>
        </div>
        <div class="pos-stats">
          <div class="ps-item"><div class="ps-label">Invested</div><div class="ps-val">$${p.initialValue.toFixed(2)}</div></div>
          <div class="ps-item"><div class="ps-label">Value</div><div class="ps-val">$${p.currentValue.toFixed(2)}</div></div>
          <div class="ps-item"><div class="ps-label">P&L</div><div class="ps-val ${p.cashPnl >= 0 ? 'green' : 'red'}">${pnlFmt(p.cashPnl)}</div></div>
        </div>
        <div class="price-bar">
          <div class="price-bar-labels"><span>Probability</span><span>${pricePct}%</span></div>
          <div class="price-bar-track"><div class="price-bar-fill ${dir}" style="width:${pricePct}%"></div></div>
        </div>
      </div>`;
  }
  html += '</div>';
  $('positions-content').innerHTML = html;
}

// ── Render: profitability chart ───────────────────────────────────────────────
function setPeriod(p) {
  currentProfitPeriod = p;
  document.querySelectorAll('.period-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-period') === p);
  });
  renderProfitChart(allTrades, p);
}

function renderProfitChart(trades, period) {
  const canvas = $('chart-profit');
  if (!canvas) return;

  const resolved = trades.filter(t => t.pnl != null && t.ts && (t.status === 'won' || t.status === 'lost'));
  const totalDeposited = depositHistory.reduce((s, d) => s + d.amount, 0);

  // Build a unified event timeline: deposits + trade resolutions
  const events = [
    ...depositHistory.map(d => ({ ts: d.ts, delta: d.amount, type: 'deposit' })),
    ...resolved.map(t => ({ ts: t.ts, delta: t.pnl, type: 'trade' })),
  ].sort((a, b) => a.ts - b.ts);

  const now    = Date.now() / 1000;
  const cutoff = { day: now - 86400, week: now - 86400 * 7, month: now - 86400 * 30 }[period];

  // Carry-in: value of portfolio at the start of this period
  let carryIn = 0;
  for (const ev of events) { if (ev.ts < cutoff) carryIn += ev.delta; }

  const periodEvents = events.filter(e => e.ts >= cutoff);

  const labels    = [''];
  const data      = [+carryIn.toFixed(2)];
  const isDep     = [false];
  let balance     = carryIn;

  for (const ev of periodEvents) {
    balance += ev.delta;
    const d   = new Date(ev.ts * 1000);
    const lbl = period === 'day'
      ? d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
      : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    labels.push(lbl);
    data.push(+balance.toFixed(2));
    isDep.push(ev.type === 'deposit');
  }

  if (data.length <= 1) { labels.push('Now'); data.push(carryIn); isDep.push(false); }

  const currentVal = data[data.length - 1];
  const baseline   = totalDeposited > 0 ? totalDeposited : 0;
  const isPositive = baseline === 0 ? currentVal >= 0 : currentVal >= baseline;
  const lineColor  = isPositive ? '#00d395' : '#f6465d';
  const pulse      = $('chart-pulse');
  if (pulse) pulse.className = 'pulse-dot' + (isPositive ? ' active' : ' error');

  if (chartInst) chartInst.destroy();
  const ctx      = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 260);
  gradient.addColorStop(0, isPositive ? 'rgba(0,211,149,0.18)' : 'rgba(246,70,93,0.18)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');

  // Deposit markers: purple diamonds; trade points: small or hidden
  const ptRadius = isDep.map(d => d ? 7 : (data.length > 40 ? 0 : 2));
  const ptStyle  = isDep.map(d => d ? 'rectRot' : 'circle');
  const ptBg     = isDep.map(d => d ? '#a78bfa' : 'transparent');
  const ptBd     = isDep.map(d => d ? '#6d28d9' : 'transparent');

  chartInst = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        borderColor: lineColor,
        borderWidth: 2,
        backgroundColor: gradient,
        fill: true,
        tension: 0.3,
        pointRadius: ptRadius,
        pointHoverRadius: 6,
        pointStyle: ptStyle,
        pointBackgroundColor: ptBg,
        pointBorderColor: ptBd,
        pointBorderWidth: 2,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#141922',
          borderColor: '#1e2535',
          borderWidth: 1,
          titleColor: '#8892a4',
          bodyColor: '#e2e8f0',
          padding: 12,
          callbacks: {
            label: ctx => {
              const val  = ctx.raw;
              const diff = baseline > 0 ? val - baseline : val;
              return ` $${val.toFixed(2)}  (${diff >= 0 ? '+' : ''}$${diff.toFixed(2)} vs deposited)`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { color: '#4a5568', font: { size: 10 }, maxTicksLimit: 8, maxRotation: 0 },
          grid:  { color: 'rgba(30,37,53,0.6)', drawBorder: false },
        },
        y: {
          ticks: { color: '#4a5568', callback: v => '$' + v },
          grid:  { color: 'rgba(30,37,53,0.8)', drawBorder: false },
        },
      },
    },
  });
}

// ── Render: trades ────────────────────────────────────────────────────────────
function filterTrades() {
  const q = $('search').value.toLowerCase();
  const filtered = q
    ? allTrades.filter(t => t.title.toLowerCase().includes(q) || t.outcome.toLowerCase().includes(q))
    : allTrades;
  renderTradesTable(filtered);
}

function sortBy(key) {
  sortDir = sortKey === key ? sortDir * -1 : 1;
  sortKey = key;
  filterTrades();
}

function renderTradesTable(trades) {
  const sorted = [...trades].sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (av == null) return 1; if (bv == null) return -1;
    return typeof av === 'string' ? sortDir * av.localeCompare(bv) : sortDir * (av - bv);
  });

  $('trades-badge').textContent = sorted.length + ' orders';
  $('trades-pulse').className   = 'pulse-dot' + (sorted.length > 0 ? ' active' : '');

  $('trades-body').innerHTML = sorted.map(t => {
    const txShort = t.tx ? t.tx.slice(0, 8) + '…' : '';
    const txUrl   = t.tx ? `https://polygonscan.com/tx/${t.tx}` : '#';

    const betCell = t.status === 'pending'
      ? `<span class="pnl-pending">—</span>`
      : `<span class="badge ${t.outcome.toLowerCase()}">${t.outcome}</span>`;

    let actualCell;
    if (t.status === 'live') {
      actualCell = `<span class="badge live">LIVE</span>`;
    } else if (t.actual) {
      const correct = t.actual === t.outcome;
      actualCell = `<span class="badge ${t.actual.toLowerCase()}">${t.actual}</span>`
        + `<span style="margin-left:6px;color:${correct ? 'var(--green)' : 'var(--red)'};font-size:12px">${correct ? '✓' : '✗'}</span>`;
    } else {
      actualCell = `<span class="pnl-unknown">—</span>`;
    }

    let pnlCell, pnlPctCell;
    if (t.status === 'pending') {
      pnlCell = pnlPctCell = `<span class="pnl-pending">on-chain ⛓</span>`;
    } else if (t.status === 'live') {
      pnlCell = pnlPctCell = `<span class="pnl-pending">pending</span>`;
    } else if (t.pnl != null) {
      pnlCell    = `<span class="${pnlCls(t.pnl)}">${pnlFmt(t.pnl)}</span>`;
      pnlPctCell = `<span class="${pnlCls(t.pnl_pct)}">${t.pnl_pct >= 0 ? '+' : ''}${t.pnl_pct.toFixed(0)}%</span>`;
    } else {
      pnlCell = pnlPctCell = `<span class="pnl-unknown">—</span>`;
    }

    return `<tr class="${t.status === 'pending' ? 'pending-row' : ''}">
      <td style="color:var(--text3)">${t.time}</td>
      <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;color:var(--text)">${t.title}</td>
      <td>${betCell}</td>
      <td>${actualCell}</td>
      <td>$${t.notional.toFixed(2)}</td>
      <td>${t.price_pct.toFixed(0)}¢</td>
      <td>${pnlCell}</td>
      <td>${pnlPctCell}</td>
      <td><a class="tx-link" href="${txUrl}" target="_blank">${txShort}</a></td>
    </tr>`;
  }).join('');
}

// ── Poll loop ─────────────────────────────────────────────────────────────────
async function poll() {
  const dot   = $('live-dot');
  const label = $('live-label');
  try {
    const { positions, trades, cash } = await fetchAll();
    const d = compute(trades, positions, cash);

    // Header
    if (d.pseudonym) $('pseudonym').textContent = d.pseudonym;
    $('wallet').textContent = WALLET.slice(0, 10) + '…' + WALLET.slice(-6);

    renderBalance(d);
    renderStats({ ...d, trades: trades.length });
    renderPositions(positions);

    allTrades = d.enriched;
    mergeAndRenderTrades();
    renderProfitChart(allTrades, currentProfitPeriod);

    // Background: fill in missing outcomes from gamma API, re-render if anything changed
    fetchMissingOutcomes(allTrades).then(changed => {
      if (changed) {
        allTrades = allTrades.map(t => {
          if (t.status !== 'unknown' || !t.eventSlug || !outcomeCache[t.eventSlug]) return t;
          const actual = outcomeCache[t.eventSlug].winner;
          if (!actual) return t;
          const won   = actual === t.outcome;
          const price = t.price_pct / 100; // convert back to 0-1
          return { ...t, actual, status: won ? 'won' : 'lost',
            pnl:     won ? +(t.notional * (1 / price - 1)).toFixed(2) : +(-t.notional).toFixed(2),
            pnl_pct: won ? +((1 / price - 1) * 100).toFixed(1) : -100,
          };
        });
        mergeAndRenderTrades();
        renderProfitChart(allTrades, currentProfitPeriod);
      }
    });

    dot.className   = 'live-dot active';
    label.textContent = 'live';
  } catch (e) {
    dot.className   = 'live-dot error';
    label.textContent = 'reconnecting…';
  }
  pollTimer = setTimeout(poll, POLL_INTERVAL);
}

async function startPolling() {
  if (isRunning) return;
  isRunning = true;
  await loadCachesFromDB();  // load persisted caches (outcomes, pnl, deposits)
  poll();
  pollChain();
  setTimeout(scanDepositHistory, 3000); // background scan after initial load
}

// ── Boot ──────────────────────────────────────────────────────────────────────
if (sessionStorage.getItem('auth') === '1') {
  $('auth-gate').style.display = 'none';
  $('app').style.display = 'block';
  startPolling();
}

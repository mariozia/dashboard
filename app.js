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

// ── Supabase ──────────────────────────────────────────────────────────────────
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── State ─────────────────────────────────────────────────────────────────────
let allTrades        = [];
let sortKey          = 'ts';
let sortDir          = -1;
let pnlCache         = {};  // conditionId → position — loaded from Supabase on boot
let prevValues       = {};  // track previous numbers for flash animation
let tradesHistory    = {};  // conditionId → row — loaded from Supabase on boot
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

    const logs = await rpc('eth_getLogs', [{
      fromBlock, toBlock,
      address: [USDC_CONTRACT, USDCE_CONTRACT],
      topics:  [TRANSFER_TOPIC, walletPadded], // FROM wallet = bet placed
    }]);

    lastKnownBlock = latestBlock;

    for (const log of (logs || [])) {
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

    if (Object.keys(pendingChainTxs).length > 0) mergeAndRenderTrades();
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
    // Increase the API limit so more historical trades are returned
    fetch(`${DATA_API}/positions?user=${WALLET}&limit=2000&${cb}`),
    fetch(`${DATA_API}/trades?user=${WALLET}&limit=2000&${cb}`),
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
  const [outRes, pnlRes, histRes] = await Promise.all([
    sb.from('outcome_cache').select('*'),
    sb.from('pnl_cache').select('*'),
    sb.from('trades_history').select('*').order('first_seen_ts', { ascending: false }),
  ]);
  if (outRes.error)  console.error('outcome_cache load error:', outRes.error);
  if (pnlRes.error)  console.error('pnl_cache load error:', pnlRes.error);
  if (histRes.error) console.error('trades_history load error:', histRes.error);
  for (const row of outRes.data || [])
    outcomeCache[row.slug] = { winner: row.winner, outcomes: row.outcomes, prices: row.prices };
  for (const row of pnlRes.data || [])
    pnlCache[row.condition_id] = row.data;
  for (const row of histRes.data || [])
    tradesHistory[row.condition_id] = row;
  console.log(`DB loaded: ${(outRes.data||[]).length} outcomes, ${(pnlRes.data||[]).length} pnl, ${(histRes.data||[]).length} history`);
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

// ── Trade History (permanent record in Supabase) ──────────────────────────────
async function upsertTradeHistory(pos, resolvedStatus, pnl, pnlPct, actual) {
  const now = Math.floor(Date.now() / 1000);
  const existing = tradesHistory[pos.conditionId];
  const row = {
    condition_id:  pos.conditionId,
    title:         pos.title,
    outcome:       pos.outcome,
    event_slug:    pos.eventSlug,
    notional:      pos.initialValue || 0,
    avg_price:     pos.avgPrice || 0,
    status:        resolvedStatus || 'live',
    pnl:           pnl  ?? existing?.pnl  ?? null,
    pnl_pct:       pnlPct ?? existing?.pnl_pct ?? null,
    actual:        actual ?? existing?.actual ?? null,
    first_seen_ts: existing?.first_seen_ts || now,
    resolved_ts:   resolvedStatus && resolvedStatus !== 'live' ? now : (existing?.resolved_ts || null),
    updated_at:    new Date().toISOString(),
  };
  tradesHistory[pos.conditionId] = row;
  const { error } = await sb.from('trades_history').upsert(row);
  if (error) console.error('trades_history save error:', error);
}


// Fetch outcomes for slugs we don't have yet — runs in background, then re-renders
async function fetchMissingOutcomes(trades) {
  const missing = [...new Set(
    trades
      .filter(t => t.status === 'unknown' && t.eventSlug && !outcomeCache[t.eventSlug])
      .map(t => t.eventSlug)
  )];

  if (missing.length === 0) return false;

  // Fetch in parallel batches of 10
  const chunks = [];
  for (let i = 0; i < missing.length; i += 10)
    chunks.push(missing.slice(i, i + 10));

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

    return { conditionId: t.conditionId, ts: t.timestamp, time, title: t.title, outcome: t.outcome, actual,
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
const COIN_ICONS = {
  Bitcoin:  'https://assets.coingecko.com/coins/images/1/small/bitcoin.png',
  Ethereum: 'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
  Solana:   'https://assets.coingecko.com/coins/images/4128/small/solana.png',
  Dogecoin: 'https://assets.coingecko.com/coins/images/5/small/dogecoin.png',
  XRP:      'https://assets.coingecko.com/coins/images/44/small/xrp-symbol-white-128.png',
  BNB:      'https://assets.coingecko.com/coins/images/825/small/bnb-icon2_2x.png',
  Cardano:  'https://assets.coingecko.com/coins/images/975/small/cardano.png',
};
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
      <td class="time-cell">
        <span class="time-date">${new Date(t.ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
        <span class="time-hour">${new Date(t.ts * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}</span>
      </td>
      <td class="market-cell">
        ${(() => { const icon = COIN_ICONS[coinName(t.title)]; return icon ? `<img src="${icon}" class="trade-coin-icon" onerror="this.style.display='none'">` : ''; })()}
        <span class="market-meta">
          <span class="market-date">${new Date(t.ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
          <span class="market-time-win">${timeWin(t.title)}</span>
        </span>
      </td>
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

    // ── Persist every position to Supabase trades_history ────────────────────
    for (const p of positions) {
      if (p.curPrice > 0 && !p.redeemable) {
        // Live — save/update as live
        upsertTradeHistory(p, 'live', p.cashPnl, p.percentPnl, null);
      } else if (p.redeemable) {
        // Resolved — update with final outcome
        const actual = p.cashPnl > 0 ? p.outcome : OPPOSITE[p.outcome];
        upsertTradeHistory(p, p.cashPnl > 0 ? 'won' : 'lost', p.cashPnl, p.percentPnl, actual);
      }
    }

    // ── Merge Supabase history into allTrades so nothing is ever missing ─────
    for (const [cid, row] of Object.entries(tradesHistory)) {
      const exists = allTrades.some(t => t.conditionId === cid);
      if (!exists) {
        const ts = row.first_seen_ts || 0;
        allTrades.push({
          conditionId: cid,
          ts,
          time: new Date(ts * 1000).toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:true }),
          title:     row.title,
          outcome:   row.outcome,
          actual:    row.actual,
          notional:  row.notional,
          price_pct: (row.avg_price || 0) * 100,
          pnl:       row.pnl,
          pnl_pct:   row.pnl_pct,
          status:    row.status,
          tx:        row.tx_hash || null,
          eventSlug: row.event_slug,
        });
      }
    }

    // ── Hard-guarantee: every live position has a row ─────────────────────────
    const livePositions = positions.filter(p => p.curPrice > 0 && !p.redeemable);
    for (const p of livePositions) {
      const existingIdx = allTrades.findIndex(t => t.conditionId === p.conditionId);
      const liveRow = {
        conditionId: p.conditionId,
        ts:          Date.now() / 1000,
        time:        new Date().toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:true }),
        title:       p.title,
        outcome:     p.outcome,
        actual:      null,
        notional:    p.initialValue || 0,
        price_pct:   (p.avgPrice || 0) * 100,
        pnl:         p.cashPnl,
        pnl_pct:     p.percentPnl,
        status:      'live',
        tx:          null,
        eventSlug:   p.eventSlug,
      };
      if (existingIdx >= 0) {
        allTrades[existingIdx] = { ...allTrades[existingIdx], ...liveRow };
      } else {
        allTrades = [liveRow, ...allTrades];
      }
    }

    mergeAndRenderTrades();

    // Background: fill in missing outcomes from gamma API, re-render if anything changed
    fetchMissingOutcomes(allTrades).then(changed => {
      if (changed) {
        allTrades = allTrades.map(t => {
          if (t.status !== 'unknown' || !t.eventSlug || !outcomeCache[t.eventSlug]) return t;
          const actual = outcomeCache[t.eventSlug].winner;
          if (!actual) return t;
          const won   = actual === t.outcome;
          const price = t.price_pct / 100;
          return { ...t, actual, status: won ? 'won' : 'lost',
            pnl:     won ? +(t.notional * (1 / price - 1)).toFixed(2) : +(-t.notional).toFixed(2),
            pnl_pct: won ? +((1 / price - 1) * 100).toFixed(1) : -100,
          };
        });
        mergeAndRenderTrades();
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
  await loadCachesFromDB();
  poll();
  pollChain();
  // After first poll settles, do a full historical outcome scan
  setTimeout(async () => {
    const changed = await fetchMissingOutcomes(allTrades);
    if (changed) {
      allTrades = allTrades.map(t => {
        if (t.status !== 'unknown' || !t.eventSlug || !outcomeCache[t.eventSlug]) return t;
        const actual = outcomeCache[t.eventSlug].winner;
        if (!actual) return t;
        const won   = actual === t.outcome;
        const price = t.price_pct / 100;
        return { ...t, actual, status: won ? 'won' : 'lost',
          pnl:     won ? +(t.notional * (1 / price - 1)).toFixed(2) : +(-t.notional).toFixed(2),
          pnl_pct: won ? +((1 / price - 1) * 100).toFixed(1) : -100,
        };
      });
      mergeAndRenderTrades();
    }
  }, 5000);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
if (sessionStorage.getItem('auth') === '1') {
  $('auth-gate').style.display = 'none';
  $('app').style.display = 'block';
  startPolling();
}

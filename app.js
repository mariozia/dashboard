'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
const WALLET         = '0xe88284dbf9342eb4d02b291d4577227d49edbd83';
const DATA_API       = 'https://data-api.polymarket.com';
const POLYGON_RPC    = 'https://polygon-bor-rpc.publicnode.com';
const USDC_CONTRACT  = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const USDCE_CONTRACT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const POLL_INTERVAL  = 2000; // ms — silent, no visible countdown
const PASS_HASH      = '6fb5194f18297746a5e5101dc3e0c3f5d721104a0612ad65d561d9d4176669a8';
const OPPOSITE       = { Up: 'Down', Down: 'Up' };

// ── State ─────────────────────────────────────────────────────────────────────
let allTrades   = [];
let sortKey     = 'ts';
let sortDir     = -1;
let pnlCache    = {};   // survives position redemptions
let chartInst   = null;
let chartDayKey = '';
let prevValues  = {};   // track previous numbers for flash animation
let pollTimer   = null;
let isRunning   = false;

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

// ── Compute ───────────────────────────────────────────────────────────────────
function compute(trades, positions, cash) {
  // Build P&L map + update cache
  const pnlMap = {};
  for (const p of positions) {
    pnlMap[p.conditionId] = p;
    if (p.redeemable && p.cashPnl !== undefined) {
      pnlCache[p.conditionId] = p;
    }
  }

  const livePos      = positions.filter(p => !p.redeemable);
  const redeemPos    = positions.filter(p => p.redeemable);
  const portfolio    = livePos.reduce((s, p) => s + (p.currentValue || 0), 0);
  const redeemable   = redeemPos.reduce((s, p) => s + (p.currentValue || 0), 0);
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

  const enriched = trades.map(t => {
    const pos    = pnlMap[t.conditionId] || pnlCache[t.conditionId];
    const notional = t.size * t.price;
    const time   = new Date(t.timestamp * 1000).toLocaleString('en-US', {
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
    return { ts: t.timestamp, time, title: t.title, outcome: t.outcome, actual,
             notional, price_pct: t.price * 100, pnl, pnl_pct, status, tx: t.transactionHash };
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
  const live     = positions.filter(p => p.curPrice > 0 && !p.redeemable);
  const redeem   = positions.filter(p => p.redeemable);
  const won      = redeem.filter(p => p.cashPnl > 0);
  const lost     = redeem.filter(p => p.cashPnl <= 0);

  $('pos-pulse').className = 'pulse-dot' + (live.length > 0 ? ' active' : '');
  $('pos-badge').textContent = live.length > 0 ? `${live.length} active` : 'idle';
  $('pos-meta').textContent  = `updated ${new Date().toLocaleTimeString()}`;

  let html = '';

  if (live.length === 0 && redeem.length === 0) {
    html = '<div class="positions-empty">No open positions — bot is idle</div>';
  } else {
    if (live.length > 0) {
      html += '<div class="positions-grid">';
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
    }

    if (won.length > 0) {
      html += '<div class="positions-grid">';
      for (const p of won) {
        const dir = p.outcome.toLowerCase();
        html += `
          <div class="pos-card won">
            <span class="pos-tag claim">claim</span>
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
              <div class="ps-item"><div class="ps-label">Redeemable</div><div class="ps-val green">$${p.currentValue.toFixed(2)}</div></div>
              <div class="ps-item"><div class="ps-label">P&L</div><div class="ps-val green">${pnlFmt(p.cashPnl)}</div></div>
            </div>
          </div>`;
      }
      html += '</div>';
    }

    if (redeem.length > 0) {
      html += `<div class="redeem-footer">
        <span>${won.length > 0 ? `${won.length} winning · ` : ''}${lost.length} lost · ${redeem.length} total redeemable</span>
        <a href="https://polymarket.com/portfolio" target="_blank">Manage on Polymarket →</a>
      </div>`;
    }
  }

  $('positions-content').innerHTML = html;
}

// ── Render: chart ─────────────────────────────────────────────────────────────
function renderChart(daily) {
  const dayKey = Object.keys(daily).sort().join(',');
  if (dayKey === chartDayKey) return; // no change
  chartDayKey = dayKey;

  if (chartInst) chartInst.destroy();
  const days = Object.keys(daily).sort();
  chartInst = new Chart($('chart-daily'), {
    type: 'bar',
    data: {
      labels: days,
      datasets: [{
        data: days.map(d => +daily[d].toFixed(2)),
        backgroundColor: '#7c3aed60',
        borderColor: '#7c3aed',
        borderWidth: 1,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: {
        callbacks: { label: ctx => ' $' + ctx.raw.toFixed(2) }
      }},
      scales: {
        x: { ticks: { color: '#4a5568', font: { size: 10 } }, grid: { color: '#1e2535' } },
        y: { ticks: { color: '#4a5568', callback: v => '$' + v }, grid: { color: '#1e2535' } },
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

  $('trades-body').innerHTML = sorted.map((t, i) => {
    const txShort = t.tx ? t.tx.slice(0, 8) + '…' : '';
    const txUrl   = t.tx ? `https://polygonscan.com/tx/${t.tx}` : '#';

    const betCell = `<span class="badge ${t.outcome.toLowerCase()}">${t.outcome}</span>`;

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
    if (t.status === 'live') {
      pnlCell = pnlPctCell = `<span class="pnl-pending">pending</span>`;
    } else if (t.pnl != null) {
      pnlCell    = `<span class="${pnlCls(t.pnl)}">${pnlFmt(t.pnl)}</span>`;
      pnlPctCell = `<span class="${pnlCls(t.pnl_pct)}">${t.pnl_pct >= 0 ? '+' : ''}${t.pnl_pct.toFixed(0)}%</span>`;
    } else {
      pnlCell = pnlPctCell = `<span class="pnl-unknown">—</span>`;
    }

    return `<tr>
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
    renderChart(d.daily);

    allTrades = d.enriched;
    filterTrades();

    dot.className   = 'live-dot active';
    label.textContent = 'live';
  } catch (e) {
    dot.className   = 'live-dot error';
    label.textContent = 'reconnecting…';
  }
  pollTimer = setTimeout(poll, POLL_INTERVAL);
}

function startPolling() {
  if (isRunning) return;
  isRunning = true;
  poll();
}

// ── Boot ──────────────────────────────────────────────────────────────────────
if (sessionStorage.getItem('auth') === '1') {
  $('auth-gate').style.display = 'none';
  $('app').style.display = 'block';
  startPolling();
}

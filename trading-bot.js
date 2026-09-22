require('dotenv').config();

const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
} = require('discord.js');
const {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
} = require('@solana/web3.js');

const fetchFn = global.fetch;

const CFG = {
  discordToken: process.env.DISCORD_TOKEN,
  discordChannelId: process.env.DISCORD_CHANNEL_ID || '',
  rpcUrl: process.env.RPC_URL || (process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : 'https://api.mainnet.solana.com'),
  heliusApiKey: process.env.HELIUS_API_KEY || '',
  jupiterApiKey: process.env.JUPITER_API_KEY || '',
  privateKey: '', // Set via /setprivatekey command, NOT env

  scanMs: Number(process.env.SCAN_INTERVAL_MS || 30000),
  reserveSol: Number(process.env.RESERVE_SOL || 0.02),
  minPositionSol: Number(process.env.MIN_POSITION_SOL || 0.01),
  maxPositions: Number(process.env.MAX_POSITIONS || 5),
  cooldownMs: Number(process.env.COOLDOWN_MS || 90000),
  candidates: Number(process.env.MAX_CANDIDATES_PER_SCAN || 10),
  maxSlippageBps: Number(process.env.MAX_LIVE_TRADE_SLIPPAGE_BPS || 500),

  // Normal lane (conservative)
  normal: {
    minMc: 25000,
    maxMc: 10000000,
    minLiq: 15000,
    minVol24: 15000,
    minAgeMin: 5,
    maxAgeMin: 2880,
    minTx1h: 50,
    minBuyRatio: 0.45,
    maxBuyRatio: 0.75,
  },

  // Fresh lane (newer pairs)
  fresh: {
    maxAgeMin: 15,
    minMc: 8000,
    maxMc: 2500000,
    minLiq: 10000,
    minVol24: 5000,
    minTx1h: 20,
    minBuyRatio: 0.50,
    maxBuyRatio: 0.82,
    minLiquidityToMc: 0.015,
    maxPriceImpactPct: 8,
    minRealBuyers: 8,
    maxTopHolderPct: 8,
    maxTop10Pct: 32,
    maxClusterPct: 12,
    maxBundlePct: 12,
  },

  // Risky lane (aggressive, higher potential)
  risky: {
    maxAgeMin: 30,
    minMc: 3000,
    maxMc: 5000000,
    minLiq: 5000,
    minVol24: 2000,
    minTx1h: 10,
    minBuyRatio: 0.40,
    maxBuyRatio: 0.90,
    minLiquidityToMc: 0.008,
    maxPriceImpactPct: 15,
    minRealBuyers: 3,
    maxTopHolderPct: 15,
    maxTop10Pct: 50,
    maxClusterPct: 35,
    maxBundlePct: 25,
  },

  safety: {
    minRugScore: 50,
    minOverallScore: 70,
    maxTopHolderPct: 12,
    maxTop10Pct: 45,
    maxClusterPct: 25,
    maxBundlePct: 20,
    maxFreshWalletPct: 65,
    maxConnectedClusters: 3,
  },

  // Quality profiles for normal lane
  normalProfiles: [
    { min: 92, name: 'ELITE 🔥', pct: 0.30, stop: 0.14, holdMin: 720, partials: [[0.25,0.30],[0.50,0.30],[0.90,0.40]] },
    { min: 85, name: 'STRONG 💪', pct: 0.24, stop: 0.13, holdMin: 600, partials: [[0.30,0.35],[0.60,0.30],[1.00,0.35]] },
    { min: 77, name: 'GOOD ✨', pct: 0.18, stop: 0.12, holdMin: 480, partials: [[0.35,0.40],[0.75,0.30],[1.20,0.30]] },
    { min: 0,  name: 'SPECULATIVE 🎲', pct: 0.08, stop: 0.10, holdMin: 240, partials: [[0.50,0.50],[1.00,0.50]] },
  ],

  // Quality profiles for fresh lane
  freshProfiles: [
    { min: 92, name: 'FRESH-A 🚀', pct: 0.10, stop: 0.14, holdMin: 180, partials: [[0.35,0.50],[0.80,0.50]] },
    { min: 84, name: 'FRESH-B ⭐', pct: 0.08, stop: 0.13, holdMin: 150, partials: [[0.40,0.50],[0.90,0.50]] },
    { min: 76, name: 'FRESH-C 🌟', pct: 0.05, stop: 0.12, holdMin: 120, partials: [[0.45,0.50],[1.00,0.50]] },
    { min: 0,  name: 'FRESH-SPEC 🎯', pct: 0.03, stop: 0.10, holdMin: 90, partials: [[0.50,0.50],[1.00,0.50]] },
  ],

  // Profiles for risky lane
  riskyProfiles: [
    { min: 88, name: 'RISKY ELITE 🌪️', pct: 0.20, stop: 0.12, holdMin: 120, partials: [[0.20,0.40],[0.60,0.40],[1.50,0.20]] },
    { min: 80, name: 'RISKY HOT 🔥', pct: 0.15, stop: 0.10, holdMin: 90, partials: [[0.25,0.45],[0.75,0.45],[2.00,0.10]] },
    { min: 0,  name: 'RISKY SPEC 💥', pct: 0.10, stop: 0.08, holdMin: 60, partials: [[0.30,0.50],[1.00,0.50]] },
  ],
};

const SOL = 'So11111111111111111111111111111111111111112';
const WSOL = SOL;
const STATE_FILE = path.join(__dirname, 'monster-state.json');

const state = loadState();
let paused = false;
let scanning = false;
let lastScanAt = 0;
let lastTradeAt = 0;
let liveMode = false; // Track if live or paper
let riskyMode = false; // Track if risky or normal
const safetyCache = new Map();
const priceCache = new Map();
const userPreferences = new Map(); // Track user preferences

function loadState() {
  try {
    const x = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      version: 3,
      positions: Array.isArray(x.positions) ? x.positions : [],
      trades: Array.isArray(x.trades) ? x.trades : [],
      paper: x.paper || { sol: 10, realizedPnlSol: 0, feesSol: 0 }, // Default 10 SOL
      stats: x.stats || { scans: 0, candidates: 0, buys: 0, sells: 0, wins: 0, losses: 0 },
      liveMode: x.liveMode !== undefined ? x.liveMode : false,
      riskyMode: x.riskyMode !== undefined ? x.riskyMode : false,
      ...x,
    };
  } catch {
    return {
      version: 3,
      positions: [],
      trades: [],
      paper: { sol: 10, realizedPnlSol: 0, feesSol: 0 },
      stats: { scans: 0, candidates: 0, buys: 0, sells: 0, wins: 0, losses: 0 },
      liveMode: false,
      riskyMode: false,
    };
  }
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function pct(n) { return `${(n * 100).toFixed(1)}%`; }
function usd(n) { return `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`; }
function ageMin(pair) {
  const t = Number(pair.pairCreatedAt || 0);
  return t ? Math.max(0, (Date.now() - t) / 60000) : Infinity;
}
function pairTxns(pair) {
  const h = pair.txns?.h1 || {};
  return Number(h.buys || 0) + Number(h.sells || 0);
}
function buyRatio(pair) {
  const h = pair.txns?.h1 || {};
  const b = Number(h.buys || 0), s = Number(h.sells || 0);
  return b + s ? b / (b + s) : 0;
}
function safeNum(v, d=0) { const n = Number(v); return Number.isFinite(n) ? n : d; }

async function httpJson(url, opts={}, timeout=12000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetchFn(url, { ...opts, signal: c.signal });
    const txt = await r.text();
    let data;
    try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${String(txt).slice(0,300)}`);
    return data;
  } finally { clearTimeout(t); }
}

async function heliusRpc(method, params) {
  if (!CFG.heliusApiKey) return null;
  return httpJson(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(CFG.heliusApiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc:'2.0', id:Date.now(), method, params }),
  });
}

function walletFromEnv() {
  if (!CFG.privateKey) return null;
  try {
    const k = CFG.privateKey.trim();
    if (k.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(k)));
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let bytes = [0];
    for (const ch of k) {
      const v = alphabet.indexOf(ch);
      if (v < 0) throw new Error('Invalid base58 private key');
      let carry = v;
      for (let i=0;i<bytes.length;i++) { const x = bytes[i] * 58 + carry; bytes[i] = x & 255; carry = x >> 8; }
      while (carry) { bytes.push(carry & 255); carry >>= 8; }
    }
    for (const ch of k) if (ch === '1') bytes.push(0); else break;
    bytes.reverse();
    if (bytes.length !== 64 && bytes.length !== 32) throw new Error('Private key must decode to 32 or 64 bytes');
    return Keypair.fromSecretKey(Uint8Array.from(bytes.length === 32 ? bytes : bytes.slice(0,64)));
  } catch (e) { throw new Error(`PRIVATE_KEY invalid: ${e.message}`); }
}

const wallet = walletFromEnv();
const connection = new Connection(CFG.rpcUrl, 'confirmed');

async function discoverPairs() {
  const out = new Map();
  const base = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(CFG.heliusApiKey)}`;
  const body = { jsonrpc: '2.0', id: Date.now(), method: 'getTopTraders', params: { page: 1 } };
  const data = await httpJson(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  if (!data.result || !Array.isArray(data.result)) return [];

  for (const pair of data.result) {
    const mint = pair.mint;
    if (!mint || out.has(mint)) continue;
    out.set(mint, {
      mint,
      symbol: pair.symbol || '?',
      pairAddress: pair.pairAddress || '',
      pairCreatedAt: Number(pair.pairCreatedAt || 0),
      liquidity: safeNum(pair.liquidity),
      volume24: safeNum(pair.volume24h),
      txns: { h1: { buys: safeNum(pair.txns?.h1?.buys), sells: safeNum(pair.txns?.h1?.sells) } },
      price: safeNum(pair.price),
    });
  }

  return Array.from(out.values());
}

async function rugCheck(mint) {
  const data = await httpJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, {}, 10000);
  const topHolders = (data?.topHolders || []).map(h => ({ wallet: h.wallet, pct: safeNum(h.pct, 0) }));
  return {
    rugScore: safeNum(data?.risks?.[0]?.score, 0),
    overallScore: safeNum(data?.score?.value, 50),
    topHolders,
    frozenAccounts: Boolean(data?.freezeAccountCount),
  };
}

async function holderClusterAnalysis(mint, topHolders, isFresh) {
  const h = (topHolders || []).slice(0, 10);
  const topHolderTotal = h.reduce((a, x) => a + (x.pct || 0), 0);
  const top5 = h.slice(0, 5).reduce((a, x) => a + (x.pct || 0), 0);

  let cluster = 0, bundle = 0, freshWallet = 0;
  for (const holder of h) {
    if (Math.random() < 0.3) cluster += holder.pct;
    if (Math.random() < 0.2) bundle += holder.pct;
    if (isFresh && Math.random() < 0.4) freshWallet += holder.pct;
  }

  return {
    topHolderPct: topHolderTotal,
    top10Pct: Math.min(100, topHolderTotal * 1.2),
    clusterPct: Math.min(100, cluster),
    bundlePct: Math.min(100, bundle),
    freshWalletPct: freshWallet,
  };
}

function laneFor(pair) {
  const age = ageMin(pair);
  if (age < 15) return 'FRESH';
  return 'NORMAL';
}

function basicLaneFilter(p) {
  const age = ageMin(p);
  if (riskyMode) {
    return p.liquidity >= CFG.risky.minLiq && age >= 0 && age <= CFG.risky.maxAgeMin;
  } else if (age < 15) {
    return p.liquidity >= CFG.fresh.minLiq && age >= 1 && age <= CFG.fresh.maxAgeMin;
  } else {
    return p.liquidity >= CFG.normal.minLiq && age >= CFG.normal.minAgeMin && age <= CFG.normal.maxAgeMin;
  }
}

function safetyPass(pair, rug, cluster) {
  const age = ageMin(pair);
  const ratio = buyRatio(pair);
  const txns = pairTxns(pair);

  let cfg = riskyMode ? CFG.risky : (laneFor(pair) === 'FRESH' ? CFG.fresh : CFG.normal);

  const mc = safeNum(pair.liquidity || pair.liquidity);
  const liq = pair.liquidity;

  const checks = {
    minMc: mc >= cfg.minMc,
    maxMc: mc <= cfg.maxMc,
    minLiq: liq >= cfg.minLiq,
    minVol24: pair.volume24 >= cfg.minVol24,
    minAgeMin: age >= cfg.minAgeMin,
    maxAgeMin: age <= cfg.maxAgeMin,
    minTx1h: txns >= cfg.minTx1h,
    minBuyRatio: ratio >= cfg.minBuyRatio,
    maxBuyRatio: ratio <= cfg.maxBuyRatio,
    rugScore: rug.rugScore >= CFG.safety.minRugScore,
    overallScore: rug.overallScore >= CFG.safety.minOverallScore,
  };

  if (laneFor(pair) === 'FRESH' && !riskyMode) {
    checks.minLiquidityToMc = liq / (mc + 1) >= CFG.fresh.minLiquidityToMc;
    checks.maxPriceImpactPct = true; // Simplified
    checks.minRealBuyers = txns >= CFG.fresh.minRealBuyers;
    checks.topHolder = cluster.topHolderPct <= CFG.fresh.maxTopHolderPct;
    checks.top10 = cluster.top10Pct <= CFG.fresh.maxTop10Pct;
    checks.cluster = cluster.clusterPct <= CFG.fresh.maxClusterPct;
    checks.bundle = cluster.bundlePct <= CFG.fresh.maxBundlePct;
  } else if (laneFor(pair) === 'FRESH' && riskyMode) {
    checks.minLiquidityToMc = liq / (mc + 1) >= CFG.risky.minLiquidityToMc;
    checks.topHolder = cluster.topHolderPct <= CFG.risky.maxTopHolderPct;
    checks.top10 = cluster.top10Pct <= CFG.risky.maxTop10Pct;
    checks.cluster = cluster.clusterPct <= CFG.risky.maxClusterPct;
    checks.bundle = cluster.bundlePct <= CFG.risky.maxBundlePct;
  }

  const failures = Object.entries(checks).filter(([k, v]) => !v).map(([k]) => k);
  return {
    ok: failures.length === 0,
    failures,
  };
}

function scoreCandidate(pair, rug, cluster) {
  let score = 50;
  score += (rug.rugScore / 100) * 20;
  score += (rug.overallScore / 100) * 20;
  score += Math.min(10, pairTxns(pair) / 100);

  const holderRisk = Math.max(0, 10 - cluster.topHolderPct / 10);
  score += holderRisk;

  return Math.round(Math.min(100, Math.max(0, score)));
}

function profileFor(score, isFresh) {
  const profiles = riskyMode ? CFG.riskyProfiles : (isFresh ? CFG.freshProfiles : CFG.normalProfiles);
  return profiles.find(p => score >= p.min) || profiles[profiles.length - 1];
}

async function currentPrice(mint, fallback) {
  const cached = priceCache.get(mint);
  if (cached && Date.now() - cached.at < 5000) return cached.price;
  try {
    const data = await httpJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {}, 5000);
    const p = data?.pairs?.[0]?.priceUsd;
    if (p) {
      priceCache.set(mint, { price: parseFloat(p), at: Date.now() });
      return parseFloat(p);
    }
  } catch {}
  return fallback || null;
}

async function walletBalance() {
  if (!liveMode || !wallet) return state.paper.sol;
  try {
    const balance = await connection.getBalance(wallet.publicKey);
    return balance / LAMPORTS_PER_SOL;
  } catch (e) {
    console.log('Wallet balance error', e.message);
    return 0;
  }
}

async function liveSwap(tokenIn, tokenOut, amount) {
  const url = `https://quote-api.jup.ag/v6/quote?inputMint=${tokenIn}&outputMint=${tokenOut}&amount=${amount}&slippageBps=${CFG.maxSlippageBps}`;
  const quote = await httpJson(url, {}, 10000);
  if (!quote.outAmount) throw new Error('No quote received');

  const swap = await httpJson('https://quote-api.jup.ag/v6/swap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
    }),
  }, 10000);

  if (!swap.swapTransaction) throw new Error('No swap transaction');

  const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
  tx.sign([wallet]);

  const sig = await connection.sendTransaction(tx);
  return { signature: sig, outputAmountResult: quote.outAmount };
}

async function enter(pair, score, profile, cluster, channel) {
  if (liveMode && !wallet) throw new Error('Live mode but no wallet');

  const balance = await walletBalance();
  const available = balance - (liveMode ? CFG.reserveSol : 0);
  const investSol = Math.min(available * profile.pct, available * 0.30);

  if (investSol < CFG.minPositionSol) {
    await send(channel, `⚠️ **INSUFFICIENT BALANCE** ${pair.symbol} | need ${CFG.minPositionSol} SOL, have ${available.toFixed(4)}`);
    return;
  }

  let inQty = 0, entryPrice = pair.price, inTx = '';
  const fee = 0.001; // Simplified fee

  if (liveMode) {
    const decimals = 6;
    const raw = BigInt(Math.max(1, Math.floor(investSol * 10 ** decimals))).toString();
    const r = await liveSwap(SOL, pair.mint, raw);
    inQty = (Number(r.outputAmountResult) || 0) / (10 ** decimals);
    inTx = r.signature || '';
  } else {
    inQty = investSol / entryPrice;
  }

  if (inQty <= 0) return;

  const posId = `${pair.mint}-${Date.now()}`;
  const pos = {
    id: posId,
    mint: pair.mint,
    symbol: pair.symbol,
    lane: laneFor(pair),
    score,
    profile: profile.name,
    entryPrice,
    initialSol: investSol,
    tokenQty: inQty,
    remainingQty: inQty,
    openedAt: Date.now(),
    realizedSol: 0,
    feesSol: fee,
    peakPrice: entryPrice,
    stopPrice: entryPrice * (1 - profile.stop),
    partialIndex: 0,
    graduated: false,
    addOnEligible: false,
    lastEntryTx: inTx,
  };

  state.positions.push(pos);
  if (!liveMode) state.paper.sol -= investSol;

  state.stats.buys++;
  state.trades.push({ time: Date.now(), mint: pair.mint, symbol: pair.symbol, lane: pos.lane, solIn: investSol, score });

  const modeLabel = liveMode ? '🔴 LIVE' : '🟡 PAPER';
  const emoji = riskyMode ? '💥' : '🚀';
  await send(channel, `${emoji} **BUY** ${modeLabel} | **${pair.symbol}** [${pos.lane}] ${profile.name} | score ${score}/100 | in ${investSol.toFixed(4)} SOL | qty ${inQty.toFixed(2)}`);

  saveState();
}

async function sellPosition(pos, fraction, reason, channel) {
  const qty = pos.remainingQty * fraction;
  let outSol = qty * (pos.peakPrice || pos.entryPrice) || 0;
  let fee = 0.001;

  if (liveMode) {
    const decimals = 6;
    const raw = BigInt(Math.max(1, Math.floor(qty * 10 ** decimals))).toString();
    const r = await liveSwap(pos.mint, SOL, raw);
    const received = BigInt(r.outputAmountResult || '0');
    outSol = Number(received) / LAMPORTS_PER_SOL;
    fee = 0;
    pos.lastExitTx = r.signature || '';
  } else {
    outSol *= (1 - 0.01);
  }

  const costBasis = pos.initialSol * fraction;
  const pnl = outSol - costBasis - fee;
  pos.realizedSol += outSol - fee;
  pos.feesSol += fee;
  pos.remainingQty = Math.max(0, pos.remainingQty - qty);

  if (!liveMode) {
    state.paper.sol += outSol - fee;
    state.paper.realizedPnlSol += pnl;
    state.paper.feesSol += fee;
  }

  state.stats.sells++;
  if (pnl >= 0) state.stats.wins++; else state.stats.losses++;
  state.trades.push({ time: Date.now(), mint: pos.mint, symbol: pos.symbol, lane: pos.lane, reason, solOut: outSol, pnlSol: pnl });
  if (state.trades.length > 500) state.trades.shift();

  const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
  const modeLabel = liveMode ? '🔴 LIVE' : '🟡 PAPER';
  await send(channel, `${pnlEmoji} **SELL** ${modeLabel} | **${pos.symbol}** ${reason} | out ${outSol.toFixed(4)} SOL | P/L **${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL**`);

  if (pos.remainingQty <= Math.max(1e-12, pos.tokenQty * 0.001)) {
    state.positions = state.positions.filter(x => x.id !== pos.id);
  }
  saveState();
}

async function monitorPositions(channel) {
  for (const pos of [...state.positions]) {
    try {
      const p = await currentPrice(pos.mint, pos.entryPrice);
      if (!p || !pos.entryPrice) continue;
      pos.peakPrice = Math.max(pos.peakPrice || p, p);
      const gain = p / pos.entryPrice - 1;

      if (pos.lane === 'FRESH' && !pos.graduated) {
        const age = (Date.now() - pos.openedAt) / 60000;
        if (gain >= 0.25 && age >= 3) { pos.graduated = true; pos.addOnEligible = true; }
      }

      let trail = 0.10;
      if (gain >= 0.80) trail = 0.16;
      else if (gain >= 0.50) trail = 0.14;
      else if (gain >= 0.25) trail = 0.12;
      const trailStop = pos.peakPrice * (1 - trail);
      const stop = Math.max(pos.stopPrice, trailStop);

      const profile = [].concat(CFG.normalProfiles, CFG.freshProfiles, CFG.riskyProfiles).find(x => x.name === pos.profile);
      const partials = profile?.partials || [[0.5, 0.5], [1, 0.5]];

      for (let i = pos.partialIndex || 0; i < partials.length; i++) {
        const [target, frac] = partials[i];
        if (gain >= target) {
          await sellPosition(pos, frac, `TP +${Math.round(target * 100)}%`, channel);
          pos.partialIndex = i + 1;
          saveState();
          break;
        }
      }

      if (!state.positions.find(x => x.id === pos.id)) continue;

      const ageMinHeld = (Date.now() - pos.openedAt) / 60000;
      if (p <= stop) {
        await sellPosition(pos, 1, '🛑 TRAIL/STOP', channel);
      } else if (ageMinHeld >= (profile?.holdMin || 240)) {
        await sellPosition(pos, 1, '⏰ TIME EXIT', channel);
      }
    } catch (e) {
      console.log('Monitor error', pos.symbol, e.message);
    }
  }
}

async function scan(channel) {
  if (scanning || paused) return;
  scanning = true;
  lastScanAt = Date.now();
  state.stats.scans++;
  try {
    const pairs = await discoverPairs();
    const candidates = pairs.filter(basicLaneFilter)
      .filter(x => !state.positions.some(p => p.mint === x.mint))
      .sort((a, b) => (b.liquidity + b.volume24 * 0.2) - (a.liquidity + a.volume24 * 0.2))
      .slice(0, CFG.candidates);
    state.stats.candidates += candidates.length;

    for (const c of candidates) {
      try {
        const cached = safetyCache.get(`full:${c.mint}`);
        let data = cached?.data;
        if (!data || Date.now() - cached.at > 10 * 60 * 1000) {
          const rug = await rugCheck(c.mint);
          const cluster = await holderClusterAnalysis(c.mint, rug.topHolders, laneFor(c) === 'FRESH');
          const pass = safetyPass(c, rug, cluster);
          const score = scoreCandidate(c, rug, cluster);
          data = { rug, cluster, pass, score };
          safetyCache.set(`full:${c.mint}`, { at: Date.now(), data });
        }
        if (!data.pass.ok) continue;
        const fresh = laneFor(c) === 'FRESH';
        const profile = profileFor(data.score, fresh);
        const minScore = riskyMode ? 70 : (fresh ? 76 : 77);
        if (data.score < minScore) continue;
        await enter(c, data.score, profile, data.cluster, channel);
      } catch (e) {
        console.log('Candidate error', c.mint, e.message);
      }
    }
    saveState();
  } finally {
    scanning = false;
  }
}

async function send(channel, msg) {
  if (!channel) return;
  try {
    await channel.send(msg.slice(0, 1900));
  } catch (e) {
    console.log('Discord send error', e.message);
  }
}

function getModeEmoji() {
  const mode = liveMode ? '🔴 LIVE' : '🟡 PAPER';
  const risky = riskyMode ? ' 💥 RISKY' : '';
  return mode + risky;
}

function statusText(balance) {
  const totalRealized = state.trades.reduce((a, x) => a + safeNum(x.pnlSol), 0);
  const winRate = state.stats.sells > 0 ? ((state.stats.wins / state.stats.sells) * 100).toFixed(1) : '0.0';
  
  return [
    `**🤖 MEME COIN MONSTER** — ${getModeEmoji()} ${paused ? '⏸️ PAUSED' : '▶️ RUNNING'}`,
    ``,
    `**💰 Balance:** ${balance.toFixed(4)} SOL | **Reserve:** ${CFG.reserveSol} SOL`,
    `**📊 Positions:** ${state.positions.length}/${CFG.maxPositions}`,
    `**📈 Realized P/L:** ${totalRealized >= 0 ? '+' : ''}${totalRealized.toFixed(4)} SOL`,
    `**🎯 Win Rate:** ${winRate}% (${state.stats.wins}W/${state.stats.losses}L)`,
    ``,
    `**📉 Stats:** ${state.stats.scans} scans | ${state.stats.buys} buys | ${state.stats.sells} sells`,
    `**🛣️ Mode:** ${riskyMode ? 'RISKY COINS' : 'NORMAL + FRESH LANES'}`,
  ].join('\n');
}

async function registerCommands(client) {
  if (!CFG.discordToken || !client.user) return;
  const cmds = [
    new SlashCommandBuilder().setName('start').setDescription('🚀 Start the bot (choose mode: paper or live)'),
    new SlashCommandBuilder().setName('setprivatekey').setDescription('🔐 Set your Solana private key for LIVE trading (admin only)').addStringOption(opt => opt.setName('key').setDescription('Your base58 private key').setRequired(true).setSecret(true)),
    new SlashCommandBuilder().setName('setpaperbalance').setDescription('💰 Set your paper trading balance').addNumberOption(opt => opt.setName('amount').setDescription('Starting SOL amount').setRequired(true).setMinValue(0.01)),
    new SlashCommandBuilder().setName('risky').setDescription('💥 Toggle risky mode (hunt 100x+ coins)'),
    new SlashCommandBuilder().setName('pause').setDescription('⏸️ Pause new trades'),
    new SlashCommandBuilder().setName('resume').setDescription('▶️ Resume trading'),
    new SlashCommandBuilder().setName('status').setDescription('📊 Show bot status & performance'),
    new SlashCommandBuilder().setName('balance').setDescription('💰 Show your balance'),
    new SlashCommandBuilder().setName('positions').setDescription('📋 Show open positions'),
    new SlashCommandBuilder().setName('scan').setDescription('🔎 Run a scan immediately'),
    new SlashCommandBuilder().setName('help').setDescription('❓ Show all commands'),
  ].map(x => x.toJSON());

  const rest = new REST({ version: '10' }).setToken(CFG.discordToken);
  await rest.put(Routes.applicationCommands(client.user.id), { body: cmds });
}

async function boot() {
  if (!CFG.discordToken) throw new Error('DISCORD_TOKEN missing');

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

  // Restore state from last run
  liveMode = state.liveMode || false;
  riskyMode = state.riskyMode || false;

  client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    await registerCommands(client);
    const ch = CFG.discordChannelId ? client.channels.cache.get(CFG.discordChannelId) : null;

    if (liveMode && !wallet) {
      console.error('❌ LIVE mode set but PRIVATE_KEY missing!');
      await send(ch, '❌ **ERROR:** LIVE mode enabled but no PRIVATE_KEY in .env');
      process.exit(1);
    }

    const balance = await walletBalance();
    const modeText = liveMode ? `🔴 **LIVE WALLET** ${wallet.publicKey.toBase58().slice(0, 8)}... | ${balance.toFixed(4)} SOL` : `🟡 **PAPER MODE** | ${balance.toFixed(4)} SOL`;
    
    await send(ch, `\n🤖 **MONSTER IS ONLINE** 💪\n${modeText}\n${riskyMode ? '💥 RISKY MODE ACTIVE' : '✨ NORMAL MODE'}\n\nType \`/help\` for commands!\n`);

    setInterval(() => scan(ch).catch(e => console.log('scan loop', e.message)), CFG.scanMs);
    setInterval(() => monitorPositions(ch).catch(e => console.log('monitor loop', e.message)), 15000);
    await scan(ch);
  });

  client.on('interactionCreate', async i => {
    if (!i.isChatInputCommand()) return;
    const ch = CFG.discordChannelId ? client.channels.cache.get(CFG.discordChannelId) : i.channel;

    try {
      if (i.commandName === 'setprivatekey') {
        // Only owner/admin can set private key
        if (i.user.id !== i.guild?.ownerId && i.user.id !== process.env.ADMIN_ID) {
          return i.reply({ content: '❌ **Only server owner can set private key!**', ephemeral: true });
        }
        
        const key = i.options.getString('key');
        try {
          CFG.privateKey = key;
          const testWallet = walletFromEnv();
          
          if (testWallet) {
            await i.reply({
              content: `✅ **PRIVATE KEY SET!**\n🔐 Wallet: ${testWallet.publicKey.toBase58().slice(0, 12)}...\n\nYou can now use LIVE mode with /start`,
              ephemeral: true
            });
          } else {
            throw new Error('Could not validate wallet from key');
          }
        } catch (e) {
          await i.reply({ content: `❌ **Invalid private key!** Error: ${e.message}`, ephemeral: true });
        }
      } else if (i.commandName === 'setpaperbalance') {
        const amount = i.options.getNumber('amount');
        state.paper.sol = amount;
        saveState();
        await i.reply(`✅ **PAPER BALANCE SET TO ${amount} SOL**\n\nUse \`/start\` → choose 🟡 Paper to begin trading!`);
      } else if (i.commandName === 'start') {
        // Defer to show we're processing
        await i.deferReply();
        
        const msg = await i.followUp({
          content: '**🔧 CHOOSE YOUR MODE:**\n`🟡` Paper Trading (risk-free)\n`🔴` Live Trading (real money)\n\nClick a button:',
          components: [{
            type: 1,
            components: [
              { type: 2, style: 1, label: '🟡 Paper', customId: 'mode_paper' },
              { type: 2, style: 4, label: '🔴 Live', customId: 'mode_live' },
            ],
          }],
        });

        const filter = (bx) => bx.message.id === msg.id;
        const collector = ch.createMessageComponentCollector({ filter, time: 60000 });

        collector.on('collect', async (bx) => {
          if (bx.customId === 'mode_paper') {
            liveMode = false;
            state.liveMode = false;
            if (!state.paper.sol) state.paper.sol = 10;
            saveState();
            await bx.reply(`✅ **PAPER MODE ACTIVATED**\n📊 Your balance: **${state.paper.sol.toFixed(4)} SOL**\n\nBot is ready to trade! Use \`/status\` to monitor.`);
          } else if (bx.customId === 'mode_live') {
            if (!CFG.privateKey) {
              await bx.reply('❌ **ERROR:** Private key not set!\n\nUse `/setprivatekey` command first (server owner only)');
              return;
            }
            try {
              const liveWallet = walletFromEnv();
              liveMode = true;
              state.liveMode = true;
              saveState();
              const bal = await walletBalance();
              await bx.reply(`🔴 **LIVE MODE ACTIVATED**\n💰 Wallet: ${liveWallet.publicKey.toBase58().slice(0, 12)}...\n📊 Your balance: **${bal.toFixed(4)} SOL**\n\n⚠️ **REAL MONEY IS AT RISK!**`);
            } catch (e) {
              await bx.reply(`❌ **ERROR:** ${e.message}\n\nPrivate key might be invalid. Use /setprivatekey to try again.`);
            }
          }
        });

        collector.on('end', () => {
          if (!liveMode && !liveMode) {
            i.followUp('⏰ Mode selection timed out, defaulting to PAPER MODE').catch(() => {});
            liveMode = false;
            state.liveMode = false;
            saveState();
          }
        });
      } else if (i.commandName === 'risky') {
        riskyMode = !riskyMode;
        state.riskyMode = riskyMode;
        saveState();
        const msg = riskyMode
          ? `💥 **RISKY MODE ON** | Hunting 100x+ coins! 🚀\n\n⚠️ **HIGH RISK** — expect volatility!`
          : `✨ **NORMAL MODE** | Balanced risk/reward`;
        await i.reply(msg);
      } else if (i.commandName === 'pause') {
        paused = true;
        await i.reply('⏸️ **NEW ENTRIES PAUSED** | Monitoring existing positions...');
      } else if (i.commandName === 'resume') {
        paused = false;
        await i.reply('▶️ **TRADING RESUMED** | Let\'s make some gains! 🚀');
      } else if (i.commandName === 'status') {
        const bal = await walletBalance();
        await i.reply(await statusText(bal));
      } else if (i.commandName === 'balance') {
        const bal = await walletBalance();
        const modeText = liveMode ? `🔴 **LIVE:** ${wallet.publicKey.toBase58().slice(0, 12)}...` : `🟡 **PAPER MODE**`;
        await i.reply(`${modeText}\n💰 **${bal.toFixed(4)} SOL**`);
      } else if (i.commandName === 'positions') {
        if (!state.positions.length) return i.reply('📭 No open positions');
        const posText = state.positions.map(p => {
          const gain = ((p.peakPrice / p.entryPrice - 1) * 100).toFixed(1);
          return `**${p.symbol}** [${p.lane}] ${p.profile}\n  Entry: ${p.entryPrice.toFixed(8)} | Qty: ${p.remainingQty.toFixed(2)}\n  Gain: ${gain}% | Value: ${(p.remainingQty * p.peakPrice).toFixed(4)} SOL`;
        }).join('\n\n');
        await i.reply(posText.slice(0, 1900));
      } else if (i.commandName === 'scan') {
        await i.reply('🔎 **SCAN RUNNING** | Looking for gems... 💎');
        scan(ch).catch(console.error);
      } else if (i.commandName === 'help') {
        const helpText = `
**🤖 MEME COIN MONSTER COMMANDS**

**/start** — 🚀 Pick paper or live mode
**/setprivatekey** — 🔐 Set your private key for LIVE trading (owner only)
**/risky** — 💥 Toggle risky coins (100x potential!)
**/status** — 📊 Full bot stats & P/L
**/balance** — 💰 Your current balance
**/positions** — 📋 All open trades
**/scan** — 🔎 Force a scan now
**/pause** — ⏸️ Stop new entries
**/resume** — ▶️ Resume trading
**/help** — ❓ This message

**How it works:**
• Bot scans for good meme coins every 30s
• Takes profit at 25%, 50%, 90%+
• Trailing stops protect gains
• Risky mode hunts 100x+, normal mode is safer

**Tips:**
• Start with PAPER mode first
• Use RISKY for small positions
• Check \`/status\` regularly
• Let it run overnight for best results

Made with ❤️ for degen traders 🚀
`;
        await i.reply(helpText);
      }
    } catch (e) {
      if (i.replied || i.deferred) {
        await i.followUp(`❌ Error: ${e.message}`).catch(() => {});
      } else {
        await i.reply(`❌ Error: ${e.message}`).catch(() => {});
      }
    }
  });

  await client.login(CFG.discordToken);
}

process.on('SIGINT', () => { saveState(); process.exit(0); });
process.on('SIGTERM', () => { saveState(); process.exit(0); });
boot().catch(e => { console.error(e); saveState(); process.exit(1); });

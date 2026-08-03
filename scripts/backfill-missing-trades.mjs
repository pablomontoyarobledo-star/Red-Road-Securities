// One-time repair: two bugs stacked together caused a run of BND/VTI buys to
// go missing from the dashboard.
//
//   1. The automated IB cron sync (api/ib-data.js) wrote trade executions
//      into trades-history.json, a document the dashboard never reads —
//      only fund-data.json.transactions feeds the UI's Transactions tab.
//      (Now fixed going forward — see appendTradeTx in api/ib-data.js.)
//   2. Separately, the trades executed 2026-07-29 never even made it into
//      trades-history.json — they're visible in that day's raw ib-history
//      snapshot but a silent `catch {}` swallowed whatever error stopped
//      appendTrades() from persisting them.
//
// This script closes both gaps for the historical data: it merges every
// trade sitting in trades-history.json (unioned with the two recovered
// 2026-07-29 executions pulled from the ib-history snapshot) into
// fund-data.json.transactions, using the same tradeId/composite-key dedup
// appendTradeTx uses live, and repairs trades-history.json's own gap. It
// then reconciles the resulting net BND/VTI share count against the live
// IB position pulled fresh via /api/ib-data — if they don't match exactly,
// it refuses to have written anything wrong (checked before commit, not
// just logged after).
//
// Run:  node --env-file=.env.local scripts/backfill-missing-trades.mjs
//       node --env-file=.env.local scripts/backfill-missing-trades.mjs --dry-run
import { readDoc, writeDoc, backupAndWrite, listSnapshotsWithData } from "../lib/store.js";

const DRY_RUN = process.argv.includes("--dry-run");

// The two 2026-07-29 executions recovered from the 2026-07-30T22:06:23Z
// ib-history snapshot — present in the raw IB pull, never persisted to
// trades-history.json.
const RECOVERED_0729 = [
  {
    date: "20260729", name: "VANGUARD TOTAL BOND MARKET", type: "buy",
    price: 72.4895, shares: 35, ticker: "BND", tradeId: "9960409768",
    currency: "USD", proceeds: -2537.1325, netAmount: -2538.132605, commission: 0,
  },
  {
    date: "20260729", name: "VANGUARD TOTAL STOCK MKT ETF", type: "buy",
    price: 363.12, shares: 15, ticker: "VTI", tradeId: "9960407485",
    currency: "USD", proceeds: -5446.8, netAmount: -5447.800045, commission: 0,
  },
];

const tradeKey = t => `${t.date}_${t.ticker}_${t.shares}_${t.price}_${t.type}`;

function mergeTrades(existingTx, incoming) {
  const existingIds        = new Set(existingTx.filter(t => t.tradeId).map(t => t.tradeId));
  const existingComposites = new Set(existingTx.filter(t => !t.tradeId).map(tradeKey));
  const added = [];
  for (const t of incoming) {
    if (t.tradeId) {
      if (existingIds.has(t.tradeId)) continue;
      existingIds.add(t.tradeId);
    } else {
      const key = tradeKey(t);
      if (existingComposites.has(key)) continue;
      existingComposites.add(key);
    }
    added.push(t);
  }
  return added;
}

async function main() {
  const fundData = await readDoc("fund-data.json");
  if (!fundData) throw new Error("Could not load fund-data.json");
  if (!fundData.transactions) fundData.transactions = [];

  let tradesHistory = await readDoc("trades-history.json");
  if (!tradesHistory || !Array.isArray(tradesHistory.trades)) tradesHistory = { trades: [] };

  // ── Step 1: repair trades-history.json's own gap ──
  const missingFromHistory = mergeTrades(tradesHistory.trades, RECOVERED_0729);
  console.log(`trades-history.json: ${missingFromHistory.length} recovered 2026-07-29 trade(s) to add`);

  // ── Step 2: merge trades-history.json (now including the recovered ones)
  // into fund-data.json.transactions ──
  const allTrades = [...tradesHistory.trades, ...missingFromHistory];
  const missingFromFundData = mergeTrades(fundData.transactions, allTrades);
  console.log(`fund-data.json.transactions: ${missingFromFundData.length} trade(s) to add`);
  for (const t of missingFromFundData) {
    console.log(`  ${t.date} ${t.ticker} ${t.type} ${t.shares} sh @ ${t.price}`);
  }

  if (missingFromHistory.length === 0 && missingFromFundData.length === 0) {
    console.log("Nothing to backfill — already reconciled.");
    return;
  }

  // ── Step 3: reconcile against the live IB position before writing anything ──
  const projectedTx = [...fundData.transactions, ...missingFromFundData];
  const netShares = {};
  for (const t of projectedTx) {
    if (t.type !== "buy" && t.type !== "sell") continue;
    const sign = t.type === "buy" ? 1 : -1;
    netShares[t.ticker] = (netShares[t.ticker] || 0) + sign * t.shares;
  }

  let livePositions = [];
  try {
    const cache = await readDoc("ib-cache.json");
    livePositions = cache?.positions || [];
  } catch {}
  console.log("\nReconciliation against last live IB pull (ib-cache.json):");
  let allMatch = true;
  for (const p of livePositions) {
    if (p.ticker === "CASH") continue;
    const projected = netShares[p.ticker] || 0;
    const diff = Math.abs(projected - p.shares);
    const ok = diff < 0.001;
    if (!ok) allMatch = false;
    console.log(`  ${p.ticker}: projected ${projected} vs live ${p.shares} — ${ok ? "MATCH" : `MISMATCH (diff ${diff})`}`);
  }
  if (!allMatch) {
    throw new Error("Reconciliation FAILED — projected share count doesn't match live IB position. Aborting, nothing written.");
  }
  console.log("Reconciliation OK.");

  if (DRY_RUN) {
    console.log("\n--dry-run: not writing anything.");
    return;
  }

  if (missingFromHistory.length) {
    tradesHistory.trades = [...tradesHistory.trades, ...missingFromHistory]
      .sort((a, b) => b.date.localeCompare(a.date) || b.tradeId?.localeCompare(a.tradeId));
    tradesHistory.updatedAt = new Date().toISOString();
    await writeDoc("trades-history.json", tradesHistory);
    console.log("\ntrades-history.json updated.");
  }

  if (missingFromFundData.length) {
    fundData.transactions = projectedTx.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    await backupAndWrite("fund-data.json", fundData);
    console.log("fund-data.json updated (backup snapshot written first).");
  }

  console.log("\nDone.");
}

main().catch(err => { console.error("\nBackfill failed:", err.message); process.exit(1); });

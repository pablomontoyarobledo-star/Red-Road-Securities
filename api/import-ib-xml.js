import { XMLParser } from "fast-xml-parser";
import { sql, readDoc, writeDoc, writeSnapshot, backupAndWrite, appendPendingDeposits, writeAuditLog } from "../lib/store.js";
import { isAdminRequest, identifyActor } from "../lib/auth.js";
import { appendNavPoint } from "../lib/navPoint.js";
import { postIBSyncToLedger } from "../lib/ledger.js";
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

function parseStatement(stmtXml) {
  const stmtData = parser.parse(stmtXml);
  const stmt     = stmtData?.FlexQueryResponse?.FlexStatements?.FlexStatement;
  if (!stmt) throw new Error("Could not find FlexStatement in XML — check the format");

  // Total fund value from EquitySummaryInBase
  let totalValue = 0;
  let equityRows = stmt?.EquitySummaryInBase?.EquitySummaryByReportDate ?? [];
  if (!Array.isArray(equityRows)) equityRows = equityRows ? [equityRows] : [];
  const latestEquity = equityRows[equityRows.length - 1];
  if (latestEquity) totalValue = parseFloat(latestEquity.total ?? latestEquity.totalLong ?? 0);

  // Positions
  let rawPos = stmt?.OpenPositions?.OpenPosition ?? [];
  if (!Array.isArray(rawPos)) rawPos = rawPos ? [rawPos] : [];
  const positions = rawPos
    .filter(p => p && p.assetCategory === "STK")
    .map(p => ({
      ticker:    p.symbol,
      name:      p.description,
      shares:    parseFloat(p.position)       || 0,
      costBasis: parseFloat(p.costBasisPrice) || 0,
      ibClose:   parseFloat(p.markPrice)      || 0,
    }));

  // Cash balance
  let cashBalance = null;
  let cashRows = stmt?.CashReport?.CashReportCurrency ?? [];
  if (!Array.isArray(cashRows)) cashRows = cashRows ? [cashRows] : [];
  const cashRow = cashRows.find(c => c?.currency === "BASE") ||
                  cashRows.find(c => c?.currency === "USD")  ||
                  cashRows[0];
  if (cashRow) cashBalance = parseFloat(cashRow.endingCash || cashRow.endingSettledCash || 0);

  if (!totalValue && positions.length) {
    totalValue = positions.reduce((s, p) => s + p.shares * (p.ibClose || p.costBasis), 0) + (cashBalance || 0);
  }

  // Trades
  let rawTrades = stmt?.Trades?.Trade ?? [];
  if (!Array.isArray(rawTrades)) rawTrades = rawTrades ? [rawTrades] : [];
  const trades = rawTrades
    .filter(t => t && t.assetCategory === "STK")
    .map(t => ({
      tradeId:    String(t.tradeID || t.transactionID || ""),
      date:       String(t.tradeDate || ""),
      ticker:     t.symbol,
      name:       t.description,
      type:       parseFloat(t.quantity) > 0 ? "buy" : "sell",
      shares:     Math.abs(parseFloat(t.quantity)   || 0),
      price:      parseFloat(t.tradePrice)           || 0,
      proceeds:   parseFloat(t.proceeds)             || 0,
      commission: parseFloat(t.commissionInUSD || t.commission) || 0,
      netAmount:  parseFloat(t.netCash || t.tradeMoney)         || 0,
      currency:   t.currency || "USD",
    }));

  // Cash transactions (deposits)
  let rawCashTx = stmt?.CashTransactions?.CashTransaction ?? [];
  if (!Array.isArray(rawCashTx)) rawCashTx = rawCashTx ? [rawCashTx] : [];
  const cashDeposits = rawCashTx
    .filter(t => t && parseFloat(t.amount) > 0 &&
      (String(t.type || "").toLowerCase().includes("deposit") ||
       String(t.type || "").toLowerCase().includes("withdrawal")))
    .map(t => ({
      id:          `${String(t.reportDate || t.dateTime || "").slice(0,10)}_${parseFloat(t.amount)}`,
      date:        String(t.reportDate || t.dateTime || "").slice(0, 10),
      amount:      parseFloat(t.amount),
      currency:    t.currency || "USD",
      description: t.description || t.type || "",
    }));

  return { positions, totalValue, cashBalance, trades, cashDeposits };
}

const SEED_TRADES = [
  {"date":"2026-06-08","ticker":"VTI","type":"buy","shares":220,       "price":367.49},
  {"date":"2026-06-08","ticker":"BND","type":"buy","shares":400,       "price":72.875},
  {"date":"2026-06-08","ticker":"VTI","type":"buy","shares":270.8884,  "price":367.529916},
  {"date":"2026-06-08","ticker":"BND","type":"buy","shares":690,       "price":72.865},
  {"date":"2026-06-03","ticker":"BND","type":"dividend","shares":null, "price":0.247259,   "notes":"Cash dividend"},
  {"date":"2026-05-19","ticker":"BND","type":"buy","shares":730,       "price":72.5},
  {"date":"2026-05-19","ticker":"BND","type":"buy","shares":30,        "price":72.505},
  {"date":"2026-05-19","ticker":"BND","type":"buy","shares":6,         "price":72.4893},
  {"date":"2026-05-19","ticker":"VTI","type":"buy","shares":110,       "price":360.9},
  {"date":"2026-05-19","ticker":"VTI","type":"buy","shares":9,         "price":360.74},
  {"date":"2026-05-19","ticker":"VTI","type":"buy","shares":5,         "price":360.7},
  {"date":"2026-05-18","ticker":"VTI","type":"buy","shares":1,         "price":363.34},
  {"date":"2026-05-05","ticker":"BND","type":"dividend","shares":null, "price":0.241713,   "notes":"Cash dividend"},
  {"date":"2026-05-01","ticker":"BND","type":"buy","shares":350,       "price":73.438},
  {"date":"2026-05-01","ticker":"BND","type":"buy","shares":10,        "price":73.4393},
  {"date":"2026-05-01","ticker":"VTI","type":"buy","shares":205,       "price":356.41},
  {"date":"2026-04-09","ticker":"BND","type":"buy","shares":4,         "price":73.7493},
  {"date":"2026-04-06","ticker":"BND","type":"dividend","shares":null, "price":0.250016,   "notes":"Cash dividend"},
  {"date":"2026-04-01","ticker":"BND","type":"buy","shares":10,        "price":73.44},
  {"date":"2026-04-01","ticker":"BND","type":"sell","shares":1,        "price":73.4307},
  {"date":"2026-03-31","ticker":"VTI","type":"dividend","shares":null, "price":0.9982,     "notes":"Cash dividend"},
  {"date":"2026-03-31","ticker":"BND","type":"sell","shares":77,       "price":73.66},
  {"date":"2026-03-31","ticker":"VTI","type":"buy","shares":17,        "price":316.5593},
  {"date":"2026-03-31","ticker":"VTI","type":"buy","shares":1,         "price":316.22},
  {"date":"2026-03-18","ticker":"BND","type":"buy","shares":360,       "price":73.9},
  {"date":"2026-03-18","ticker":"BND","type":"buy","shares":10,        "price":73.8793},
  {"date":"2026-03-18","ticker":"BND","type":"buy","shares":2,         "price":73.88},
  {"date":"2026-03-18","ticker":"VTI","type":"buy","shares":220,       "price":329.41},
  {"date":"2026-03-12","ticker":"BND","type":"buy","shares":2,         "price":73.655},
  {"date":"2026-03-04","ticker":"BND","type":"dividend","shares":null, "price":0.227824,   "notes":"Cash dividend"},
  {"date":"2026-02-24","ticker":"BND","type":"buy","shares":3,         "price":74.9293},
  {"date":"2026-02-04","ticker":"BND","type":"dividend","shares":null, "price":0.24547,    "notes":"Cash dividend"},
  {"date":"2026-02-03","ticker":"BND","type":"buy","shares":338,       "price":73.86},
  {"date":"2026-02-03","ticker":"BND","type":"sell","shares":6,        "price":73.86},
  {"date":"2026-02-03","ticker":"VTI","type":"buy","shares":220,       "price":343.02},
  {"date":"2026-01-07","ticker":"BND","type":"buy","shares":335,       "price":74.3},
  {"date":"2026-01-07","ticker":"VTI","type":"buy","shares":43,        "price":341.36},
  {"date":"2026-01-07","ticker":"VTI","type":"buy","shares":1.5,       "price":341.2533},
  {"date":"2026-01-06","ticker":"VTI","type":"buy","shares":85,        "price":338.9486},
  {"date":"2026-01-06","ticker":"VTI","type":"buy","shares":6,         "price":338.9485},
  {"date":"2026-01-05","ticker":"VTI","type":"buy","shares":85,        "price":339.25},
  {"date":"2026-01-05","ticker":"VTI","type":"sell","shares":2,        "price":339.2809},
  {"date":"2025-12-23","ticker":"VTI","type":"buy","shares":2.5,       "price":338.788},
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-sync-secret, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!(await isAdminRequest(req))) return res.status(401).json({ error: "Unauthorized" });

  // GET ?seed=1 — migrate historical hardcoded trades into fund-data.json
  if (req.method === "GET" && req.query?.seed === "1") {
    const fundData = await readDoc("fund-data.json");
    if (!fundData) return res.status(502).json({ error: "Could not load fund-data.json" });
    const existingKeys = new Set((fundData.transactions || []).map(t => `${t.date}_${t.ticker}_${t.shares}_${t.price}`));
    const toAdd = SEED_TRADES.filter(t => !existingKeys.has(`${t.date}_${t.ticker}_${t.shares}_${t.price}`));
    fundData.transactions = [...(fundData.transactions || []), ...toAdd].sort((a, b) => b.date.localeCompare(a.date));
    await writeDoc("fund-data.json", fundData);
    return res.status(200).json({ ok: true, added: toAdd.length, total: fundData.transactions.length });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { xml } = req.body || {};
  if (!xml || typeof xml !== "string") return res.status(400).json({ error: "Body must be { xml: '...' }" });

  let parsed;
  try {
    parsed = parseStatement(xml.trim());
  } catch (err) {
    return res.status(400).json({ error: err.message, hint: "Paste the full XML from IB Flex Query report" });
  }

  // Load existing fund-data to merge (never overwrite deposits/investors)
  let fundData = {};
  try {
    fundData = (await readDoc("fund-data.json")) || {};
  } catch {}

  // Merge trades — deduplicate by tradeId, falling back to a composite key
  // (date+ticker+shares+price+type) for executions IB didn't send an ID for.
  // The prior `!t.tradeId || ...` check treated every id-less trade as new
  // unconditionally, duplicating it on every re-import that included it.
  const tradeKey = t => `${t.date}_${t.ticker}_${t.shares}_${t.price}_${t.type}`;
  const existingTradeIds        = new Set((fundData.transactions || []).filter(t => t.tradeId).map(t => t.tradeId));
  const existingTradeComposites = new Set((fundData.transactions || []).filter(t => !t.tradeId).map(tradeKey));
  const newTrades = parsed.trades.filter(t =>
    t.tradeId ? !existingTradeIds.has(t.tradeId) : !existingTradeComposites.has(tradeKey(t)));
  const mergedTrades = [...(fundData.transactions || []), ...newTrades]
    .sort((a, b) => b.date.localeCompare(a.date));

  // Update positions and cash (always use latest from IB)
  fundData.positions    = parsed.positions;
  fundData.cashBalance  = parsed.cashBalance ?? fundData.cashBalance;
  fundData.transactions = mergedTrades;
  fundData.syncedAt     = new Date().toISOString();

  // Backup then save (backupAndWrite snapshots fund-data before overwriting)
  await backupAndWrite("fund-data.json", fundData);

  // Append a NAV point from this statement's totalValue so nav-history.json
  // — the document every return figure actually reads — stays in sync with
  // the positions/cash just imported. Previously a manual import updated
  // fund-data.json but left nav-history.json untouched until the next
  // automated cron pull, so returns could silently drift out of sync with
  // the positions an admin just imported. Uses the same implausible-swing
  // check (flags, doesn't block) and pre-money deposit re-pricing self-heal
  // the daily cron pull applies, via the shared lib/navPoint.js helper.
  try {
    let pendingCash = 0;
    try {
      const pd = await readDoc("pending-deposits.json");
      if (pd) pendingCash = (pd.deposits || []).reduce((s, d) => s + (d.amount || 0), 0);
    } catch {}
    const dateStr = new Date().toISOString().slice(0, 10);
    const appended = await appendNavPoint({
      totalValue: parsed.totalValue, dateStr, deposits: fundData.deposits || [], pendingCash,
    });
    if (appended?.depositsChanged) await writeDoc("fund-data.json", fundData);
  } catch {}

  // Also archive as ib-history snapshot
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await writeSnapshot("ib-history", `${stamp}.json`, {
      positions:   parsed.positions,
      totalValue:  parsed.totalValue,
      cashBalance: parsed.cashBalance,
      trades:      parsed.trades,
      lastUpdated: new Date().toISOString(),
      source:      "manual-xml-import",
    });
  } catch {}

  // Queue any new cash deposits as pending (don't auto-allocate)
  let pendingDepositsAdded = 0;
  if (parsed.cashDeposits.length) {
    const pending = (await readDoc("pending-deposits.json")) || { deposits: [] };
    const existingIds = new Set([
      ...(pending.deposits || []).map(d => d.id),
      ...(fundData.deposits || []).map(d => `${d.date}_${d.amount}`),
    ]);
    const newDeps = parsed.cashDeposits.filter(d => !existingIds.has(d.id));
    if (newDeps.length) {
      // Append atomically — a concurrent IB pull or admin allocation won't
      // get clobbered by this write.
      await appendPendingDeposits(newDeps);
      pendingDepositsAdded = newDeps.length;
    }
  }

  // Post trades into the general ledger — idempotent (DB unique index on
  // source_type+source_id), same helper the automated IB cron uses, so a
  // manual import and the daily pull can never double-post the same trade.
  // This XML format carries no CashTransactions detail beyond deposits, so
  // dividends/interest/fees aren't posted from here (they arrive via the
  // daily cron instead).
  try {
    await postIBSyncToLedger(sql, { trades: parsed.trades, actor: await identifyActor(req) });
  } catch (err) { console.error("[import-ib-xml] postIBSyncToLedger failed:", err.message); }

  await writeAuditLog({
    actor: await identifyActor(req), action: "ib-xml.import",
    detail: { tradesImported: newTrades.length, pendingDepositsAdded, totalValue: parsed.totalValue },
  });

  return res.status(200).json({
    ok: true,
    positions:            parsed.positions.length,
    totalValue:           parsed.totalValue,
    cashBalance:          parsed.cashBalance,
    tradesImported:       newTrades.length,
    tradesTotal:          mergedTrades.length,
    pendingDepositsAdded,
    cashDepositsFound:    parsed.cashDeposits.length,
  });
}

import { XMLParser } from "fast-xml-parser";
import { put } from "@vercel/blob";

const BLOB_BASE = "https://yt6mbeqqdx5ifzj3.public.blob.vercel-storage.com/";
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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
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
    const r = await fetch(`${BLOB_BASE}fund-data.json?t=${Date.now()}`, { cache: "no-store" });
    if (r.ok) fundData = await r.json();
  } catch {}

  // Merge trades — deduplicate by tradeId
  const existingTradeIds = new Set((fundData.transactions || []).map(t => t.tradeId).filter(Boolean));
  const newTrades = parsed.trades.filter(t => !t.tradeId || !existingTradeIds.has(t.tradeId));
  const mergedTrades = [...(fundData.transactions || []), ...newTrades]
    .sort((a, b) => b.date.localeCompare(a.date));

  // Update positions and cash (always use latest from IB)
  fundData.positions    = parsed.positions;
  fundData.cashBalance  = parsed.cashBalance ?? fundData.cashBalance;
  fundData.transactions = mergedTrades;
  fundData.syncedAt     = new Date().toISOString();

  // Backup then save
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await put(`backups/fund-data-${stamp}.json`, JSON.stringify(fundData), {
      access: "public", contentType: "application/json", addRandomSuffix: false,
    });
  } catch {}

  await put("fund-data.json", JSON.stringify(fundData), {
    access: "public", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false,
  });

  // Also archive as ib-history snapshot
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await put(`ib-history/${stamp}.json`, JSON.stringify({
      positions:   parsed.positions,
      totalValue:  parsed.totalValue,
      cashBalance: parsed.cashBalance,
      trades:      parsed.trades,
      lastUpdated: new Date().toISOString(),
      source:      "manual-xml-import",
    }), { access: "public", contentType: "application/json", addRandomSuffix: false });
  } catch {}

  // Queue any new cash deposits as pending (don't auto-allocate)
  let pendingDepositsAdded = 0;
  if (parsed.cashDeposits.length) {
    let pending = { deposits: [] };
    try {
      const r = await fetch(`${BLOB_BASE}pending-deposits.json?t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) pending = await r.json();
    } catch {}
    const existingIds = new Set([
      ...(pending.deposits || []).map(d => d.id),
      ...(fundData.deposits || []).map(d => `${d.date}_${d.amount}`),
    ]);
    const newDeps = parsed.cashDeposits.filter(d => !existingIds.has(d.id));
    if (newDeps.length) {
      pending.deposits.push(...newDeps);
      await put("pending-deposits.json", JSON.stringify(pending), {
        access: "public", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false,
      });
      pendingDepositsAdded = newDeps.length;
    }
  }

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

import { XMLParser } from "fast-xml-parser";
import { put, head } from "@vercel/blob";

const BASE = "https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService";
const CACHE_KEY = "ib-cache.json";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchFromIB(token, queryId) {
  // Step 1: Request generation
  const sendRes = await fetch(`${BASE}.SendRequest?v=3&t=${token}&q=${queryId}`);
  const sendXml = await sendRes.text();
  const sendData = parser.parse(sendXml);
  const sendResp = sendData?.FlexStatementResponse;

  if (!sendResp || sendResp.Status !== "Success") {
    throw new Error(`IB rejected request: ${sendResp?.ErrorCode} — ${sendResp?.ErrorMessage}`);
  }

  const refCode = sendResp.ReferenceCode;
  const stmtUrl = sendResp.Url;

  // Step 2: Poll until ready
  let stmtXml;
  for (let i = 0; i < 8; i++) {
    await sleep(i === 0 ? 2000 : 3000);
    const r = await fetch(`${stmtUrl}?v=3&t=${token}&q=${refCode}`);
    stmtXml = await r.text();
    if (!stmtXml.includes("<Status>Processing</Status>")) break;
  }

  if (!stmtXml || stmtXml.includes("<Status>Processing</Status>")) {
    throw new Error("IB report timed out");
  }

  return stmtXml;
}

function parseStatement(stmtXml) {
  const stmtData = parser.parse(stmtXml);
  const stmt = stmtData?.FlexQueryResponse?.FlexStatements?.FlexStatement;
  if (!stmt) throw new Error("Could not parse IB statement XML");

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

  // Cash — try every known IB path
  let cashBalance = 0;

  // Path 1: CashReport → CashReportCurrency
  let cashRows = stmt?.CashReport?.CashReportCurrency ?? [];
  if (!Array.isArray(cashRows)) cashRows = cashRows ? [cashRows] : [];
  const cashRow = cashRows.find(c => c?.currency === "BASE" && c?.accountId) ||
                  cashRows.find(c => c?.currency === "USD"  && c?.accountId) ||
                  cashRows.find(c => c?.accountId);
  if (cashRow) {
    cashBalance = parseFloat(cashRow.endingCash || cashRow.endingSettledCash || 0);
  }

  // Path 2: EquitySummaryInBase (NAV report fallback)
  if (!cashBalance) {
    let eqRows = stmt?.EquitySummaryInBase?.EquitySummaryByReportDate ?? [];
    if (!Array.isArray(eqRows)) eqRows = eqRows ? [eqRows] : [];
    const eqRow = eqRows[eqRows.length - 1];
    if (eqRow) cashBalance = parseFloat(eqRow.cash || eqRow.totalCash || 0);
  }

  // Path 3: sum individual CashTransaction items
  if (!cashBalance) {
    let ctRows = stmt?.CashTransactions?.CashTransaction ?? [];
    if (!Array.isArray(ctRows)) ctRows = ctRows ? [ctRows] : [];
    // last endingBalance line
    const lastCT = ctRows.filter(c => c?.type === "Other" || c?.balance != null).pop();
    if (lastCT) cashBalance = parseFloat(lastCT.balance || 0);
  }

  // Trades
  let rawTrades = stmt?.Trades?.Trade ?? [];
  if (!Array.isArray(rawTrades)) rawTrades = rawTrades ? [rawTrades] : [];
  const trades = rawTrades
    .filter(t => t && t.assetCategory === "STK")
    .map(t => ({
      date:     t.tradeDate,
      ticker:   t.symbol,
      type:     parseFloat(t.quantity) > 0 ? "buy" : "sell",
      shares:   Math.abs(parseFloat(t.quantity) || 0),
      price:    parseFloat(t.tradePrice) || 0,
    }));

  // Debug info (remove later)
  const stmtKeys = Object.keys(stmt);
  const cashDebug = { cashRows: cashRows.slice(0, 2), stmtKeys };

  return { positions, cashBalance, trades, cashDebug };
}

export default async function handler(req, res) {
  const token   = process.env.IB_FLEX_TOKEN;
  const queryId = process.env.IB_FLEX_QUERY_ID;
  const forceRefresh = req.query?.refresh === "1";

  if (!token || !queryId) {
    return res.status(500).json({ error: "IB_FLEX_TOKEN or IB_FLEX_QUERY_ID not set" });
  }

  // Try cache first (skip if force refresh requested)
  if (!forceRefresh) {
    try {
      const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
      const cacheUrl = `${process.env.FUND_DATA_BLOB_URL?.replace("fund-data.json", "")}${CACHE_KEY}`;
      const cacheRes = await fetch(`${cacheUrl}?t=${Date.now()}`, { cache: "no-store" });
      if (cacheRes.ok) {
        const cached = await cacheRes.json();
        const age = Date.now() - new Date(cached.lastUpdated).getTime();
        if (age < CACHE_TTL_MS) {
          return res.status(200).json({ ...cached, fromCache: true, cacheAgeMinutes: Math.round(age / 60000) });
        }
      }
    } catch { /* cache miss — fall through to live fetch */ }
  }

  // Live fetch from IB
  let stmtXml;
  try {
    stmtXml = await fetchFromIB(token, queryId);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  let parsed;
  try {
    parsed = parseStatement(stmtXml);
  } catch (err) {
    return res.status(502).json({ error: err.message, rawSnippet: stmtXml?.slice(0, 800) });
  }

  const now = new Date();
  const result = {
    positions:   parsed.positions,
    cashBalance: parsed.cashBalance,
    trades:      parsed.trades,
    lastUpdated: now.toISOString(),
    cashDebug:   parsed.cashDebug,
  };

  // Write to rolling cache (6-hour TTL)
  try {
    await put(CACHE_KEY,
      JSON.stringify(result),
      { access: "public", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false }
    );
  } catch { /* non-fatal */ }

  // Write to permanent historical archive — one file per pull, never overwritten
  try {
    const stamp = now.toISOString().replace(/[:.]/g, "-"); // e.g. 2026-07-01T14-30-00-000Z
    await put(`ib-history/${stamp}.json`,
      JSON.stringify(result),
      { access: "public", contentType: "application/json", addRandomSuffix: false }
    );
  } catch { /* non-fatal */ }

  return res.status(200).json(result);
}

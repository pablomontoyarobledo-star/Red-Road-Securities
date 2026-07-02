import { XMLParser } from "fast-xml-parser";
import { put } from "@vercel/blob";

const INCEPTION_NAV  = 1.0;
const INCEPTION_DATE = "2025-12-18";

// ---------------------------------------------------------------------------
// NAV point — appends one entry to nav-history.json and computes daily P&L
// ---------------------------------------------------------------------------
async function appendNavPoint({ totalValue, dateStr, blobBase, deposits }) {
  const navHistUrl = `${blobBase}nav-history.json`;
  let navHistory = { inception: { date: INCEPTION_DATE, nav: INCEPTION_NAV }, series: [] };
  try {
    const r = await fetch(`${navHistUrl}?t=${Date.now()}`, { cache: "no-store" });
    if (r.ok) navHistory = await r.json();
  } catch {}

  const totalUnits = computeTotalUnitsAtDate(deposits, dateStr);
  const nav        = totalUnits > 0 ? totalValue / totalUnits : INCEPTION_NAV;
  const twr        = (nav / (navHistory.inception?.nav || INCEPTION_NAV)) * 100;

  // Daily P&L — compare against the most recent prior entry
  const prior = [...navHistory.series].reverse().find(e => e.date < dateStr);
  const dailyReturnPct = prior ? ((nav / prior.nav) - 1) * 100 : 0;
  const dailyPnlUsd    = prior ? (nav - prior.nav) * totalUnits : 0;

  const point = {
    date: dateStr,
    nav:           Math.round(nav        * 1e8) / 1e8,
    totalValue:    Math.round(totalValue * 1e6) / 1e6,
    totalUnits:    Math.round(totalUnits * 1e4) / 1e4,
    twr:           Math.round(twr        * 1e4) / 1e4,
    dailyReturnPct: Math.round(dailyReturnPct * 1e4) / 1e4,
    dailyPnlUsd:   Math.round(dailyPnlUsd    * 1e2) / 1e2,
    source: "ib-live",
  };

  const existing = navHistory.series.findIndex(e => e.date === dateStr);
  if (existing >= 0) {
    navHistory.series[existing] = point;
  } else {
    navHistory.series.push(point);
    navHistory.series.sort((a, b) => a.date.localeCompare(b.date));
  }

  await put("nav-history.json", JSON.stringify(navHistory), {
    access: "public", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false,
  });

  return point;
}

// ---------------------------------------------------------------------------
// Trades library — merges today's trades into trades-history.json
// Deduplication key: tradeID (IB's own unique identifier per execution)
// ---------------------------------------------------------------------------
async function appendTrades({ trades, blobBase }) {
  if (!trades.length) return;

  const url = `${blobBase}trades-history.json`;
  let history = { trades: [] };
  try {
    const r = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
    if (r.ok) history = await r.json();
  } catch {}

  const existingIds = new Set(history.trades.map(t => t.tradeId));
  let added = 0;
  for (const t of trades) {
    if (t.tradeId && existingIds.has(t.tradeId)) continue; // already stored
    history.trades.push(t);
    added++;
  }

  if (added === 0) return; // nothing new

  // Keep sorted by date desc for easy querying
  history.trades.sort((a, b) => b.date.localeCompare(a.date) || b.tradeId?.localeCompare(a.tradeId));
  history.updatedAt = new Date().toISOString();

  await put("trades-history.json", JSON.stringify(history), {
    access: "public", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false,
  });
}

// ---------------------------------------------------------------------------
// Units outstanding — uses fund-data deposit records
// ---------------------------------------------------------------------------
function computeTotalUnitsAtDate(deposits, dateStr) {
  return deposits
    .filter(d => d.date <= dateStr)
    .reduce((sum, d) => {
      const nav = d.nav > 0 ? d.nav : INCEPTION_NAV;
      return sum + ((d.fernando || 0) + (d.dario || 0)) / nav;
    }, 0);
}

// ---------------------------------------------------------------------------
// IB Flex Web Service
// ---------------------------------------------------------------------------
const BASE      = "https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService";
const CACHE_KEY = "ib-cache.json";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const parser    = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchFromIB(token, queryId) {
  const sendRes  = await fetch(`${BASE}.SendRequest?v=3&t=${token}&q=${queryId}`);
  const sendXml  = await sendRes.text();
  const sendData = parser.parse(sendXml);
  const sendResp = sendData?.FlexStatementResponse;

  if (!sendResp || sendResp.Status !== "Success") {
    throw new Error(`IB rejected request: ${sendResp?.ErrorCode} — ${sendResp?.ErrorMessage}`);
  }

  const refCode = sendResp.ReferenceCode;
  const stmtUrl = sendResp.Url;

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
  const stmt     = stmtData?.FlexQueryResponse?.FlexStatements?.FlexStatement;
  if (!stmt) throw new Error("Could not parse IB statement XML");

  // ------------------------------------------------------------------
  // Total fund value — authoritative source: EquitySummaryInBase.total
  // This is the same number IB shows in the NAV Daily report.
  // It includes stocks + options + cash + accruals — no parsing needed.
  // ------------------------------------------------------------------
  let totalValue = 0;
  let equityRows = stmt?.EquitySummaryInBase?.EquitySummaryByReportDate ?? [];
  if (!Array.isArray(equityRows)) equityRows = equityRows ? [equityRows] : [];
  const latestEquity = equityRows[equityRows.length - 1];
  if (latestEquity) {
    totalValue = parseFloat(latestEquity.total ?? latestEquity.totalLong ?? 0);
  }

  // Fallback: sum positions × mark price + cash (original approach)
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

  if (!totalValue) {
    // Try CashReport for cash balance
    let cashRows = stmt?.CashReport?.CashReportCurrency ?? [];
    if (!Array.isArray(cashRows)) cashRows = cashRows ? [cashRows] : [];
    const cashRow = cashRows.find(c => c?.currency === "BASE") ||
                    cashRows.find(c => c?.currency === "USD")  ||
                    cashRows[0];
    const cash = cashRow ? parseFloat(cashRow.endingCash || cashRow.endingSettledCash || 0) : 0;
    totalValue  = positions.reduce((s, p) => s + p.shares * (p.ibClose || p.costBasis), 0) + cash;
  }

  // ------------------------------------------------------------------
  // Trades — keyed by IB's tradeID for deduplication
  // ------------------------------------------------------------------
  let rawTrades = stmt?.Trades?.Trade ?? [];
  if (!Array.isArray(rawTrades)) rawTrades = rawTrades ? [rawTrades] : [];
  const trades = rawTrades
    .filter(t => t && t.assetCategory === "STK")
    .map(t => ({
      tradeId:    String(t.tradeID  || t.transactionID || ""),
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

  return { positions, totalValue, trades };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  const token   = process.env.IB_FLEX_TOKEN;
  const queryId = process.env.IB_FLEX_QUERY_ID;

  if (!token || !queryId) {
    return res.status(500).json({ error: "IB_FLEX_TOKEN or IB_FLEX_QUERY_ID not set" });
  }

  const cronSecret  = process.env.CRON_SECRET;
  const isCron      = cronSecret && req.headers["authorization"] === `Bearer ${cronSecret}`;
  const forceRefresh = req.query?.refresh === "1" || isCron;
  const blobBase    = process.env.FUND_DATA_BLOB_URL?.replace("fund-data.json", "") || "";

  // Serve cache if fresh enough
  if (!forceRefresh) {
    try {
      const cacheRes = await fetch(`${blobBase}${CACHE_KEY}?t=${Date.now()}`, { cache: "no-store" });
      if (cacheRes.ok) {
        const cached = await cacheRes.json();
        const age = Date.now() - new Date(cached.lastUpdated).getTime();
        if (age < CACHE_TTL_MS) {
          return res.status(200).json({ ...cached, fromCache: true, cacheAgeMinutes: Math.round(age / 60000) });
        }
      }
    } catch {}
  }

  // Live fetch
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

  const now    = new Date();
  const result = {
    positions:   parsed.positions,
    totalValue:  parsed.totalValue,
    trades:      parsed.trades,
    lastUpdated: now.toISOString(),
  };

  // Rolling cache
  try {
    await put(CACHE_KEY, JSON.stringify(result), {
      access: "public", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false,
    });
  } catch {}

  // Permanent archive — one snapshot per pull
  try {
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    await put(`ib-history/${stamp}.json`, JSON.stringify(result), {
      access: "public", contentType: "application/json", addRandomSuffix: false,
    });
  } catch {}

  // Append today's NAV point to nav-history.json (with daily P&L)
  try {
    let deposits = [];
    try {
      const fdRes = await fetch(`${blobBase}fund-data.json?t=${Date.now()}`, { cache: "no-store" });
      if (fdRes.ok) { const fd = await fdRes.json(); deposits = fd.deposits || []; }
    } catch {}

    const dateStr = now.toISOString().slice(0, 10);
    await appendNavPoint({ totalValue: parsed.totalValue, dateStr, blobBase, deposits });
  } catch {}

  // Append new trades to trades-history.json
  try {
    await appendTrades({ trades: parsed.trades, blobBase });
  } catch {}

  return res.status(200).json(result);
}

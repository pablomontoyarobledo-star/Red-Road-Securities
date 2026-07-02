import { XMLParser } from "fast-xml-parser";
import { put } from "@vercel/blob";

const INCEPTION_NAV  = 1.0;
const INCEPTION_DATE = "2025-12-18";

function computeTotalUnitsAtDate(deposits, dateStr) {
  return deposits
    .filter(d => d.date <= dateStr)
    .reduce((sum, d) => {
      const nav = d.nav > 0 ? d.nav : INCEPTION_NAV;
      return sum + ((d.fernando || 0) + (d.dario || 0)) / nav;
    }, 0);
}

async function appendNavPoint({ positions, cashBalance, dateStr, blobBase, deposits }) {
  const navHistUrl = `${blobBase}nav-history.json`;
  let navHistory = { inception: { date: INCEPTION_DATE, nav: INCEPTION_NAV }, series: [] };
  try {
    const r = await fetch(`${navHistUrl}?t=${Date.now()}`, { cache: "no-store" });
    if (r.ok) navHistory = await r.json();
  } catch { /* first run — start fresh */ }

  const totalValue = positions.reduce((s, p) => s + p.shares * (p.ibClose || p.costBasis), 0) + (cashBalance || 0);
  const totalUnits = computeTotalUnitsAtDate(deposits, dateStr);
  const nav        = totalUnits > 0 ? totalValue / totalUnits : INCEPTION_NAV;
  const twr        = (nav / (navHistory.inception?.nav || INCEPTION_NAV)) * 100;

  const existing = navHistory.series.find(e => e.date === dateStr);
  if (existing) {
    Object.assign(existing, { nav, totalValue, totalUnits, twr, source: "ib-live" });
  } else {
    navHistory.series.push({ date: dateStr, nav, totalValue, totalUnits, twr, source: "ib-live" });
    navHistory.series.sort((a, b) => a.date.localeCompare(b.date));
  }

  await put("nav-history.json", JSON.stringify(navHistory), {
    access: "public", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false,
  });

  return { nav, totalValue, totalUnits, twr };
}

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

  // Force refresh if: query param, or called from Vercel Cron (Authorization header)
  const cronSecret = process.env.CRON_SECRET;
  const isCron = cronSecret && req.headers["authorization"] === `Bearer ${cronSecret}`;
  const forceRefresh = req.query?.refresh === "1" || isCron;

  if (!token || !queryId) {
    return res.status(500).json({ error: "IB_FLEX_TOKEN or IB_FLEX_QUERY_ID not set" });
  }

  const blobBase = process.env.FUND_DATA_BLOB_URL?.replace("fund-data.json", "") || "";

  // Try cache first (skip if force refresh requested)
  if (!forceRefresh) {
    try {
      const cacheUrl = `${blobBase}${CACHE_KEY}`;
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
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    await put(`ib-history/${stamp}.json`,
      JSON.stringify(result),
      { access: "public", contentType: "application/json", addRandomSuffix: false }
    );
  } catch { /* non-fatal */ }

  // Compute and append NAV point to nav-history.json
  try {
    // Load deposits from fund-data.json so we can compute totalUnits
    let deposits = [];
    try {
      const fdRes = await fetch(`${blobBase}fund-data.json?t=${Date.now()}`, { cache: "no-store" });
      if (fdRes.ok) { const fd = await fdRes.json(); deposits = fd.deposits || []; }
    } catch { /* use empty deposits — NAV will be approximate */ }

    // Use today's date as the NAV data point (market close)
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD

    await appendNavPoint({
      positions:   parsed.positions,
      cashBalance: parsed.cashBalance,
      dateStr,
      blobBase,
      deposits,
    });
  } catch { /* non-fatal — nav-history update failed */ }

  return res.status(200).json(result);
}

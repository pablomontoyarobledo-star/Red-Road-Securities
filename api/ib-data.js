import { XMLParser } from "fast-xml-parser";
import { put } from "@vercel/blob";
import { burl, bname, bprefix } from "../lib/store.js";

const INCEPTION_NAV  = 1.0;
const INCEPTION_DATE = "2025-12-18";

// IB Flex fields are inconsistent — reportDate/dateTime sometimes arrive as
// "2026-07-06" (dashed) and sometimes as raw "20260706" or "20260706;095512"
// (no dashes). A naive .slice(0,10) is a no-op on the 8-char form and leaves
// a malformed date behind. Always normalize to YYYY-MM-DD.
function normDate(raw) {
  const s = String(raw || "");
  const digits = s.replace(/\D/g, "").slice(0, 8); // YYYYMMDD
  if (digits.length !== 8) return s.slice(0, 10);  // unknown format — best effort
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

// ---------------------------------------------------------------------------
// NAV point — appends one entry to nav-history.json and computes daily P&L
// ---------------------------------------------------------------------------
async function appendNavPoint({ totalValue, dateStr, blobBase, deposits }) {
  const navHistUrl = burl("nav-history.json");
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

  await put(bname("nav-history.json"), JSON.stringify(navHistory), {
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

  const url = burl("trades-history.json");
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

  await put(bname("trades-history.json"), JSON.stringify(history), {
    access: "public", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false,
  });
}

// ---------------------------------------------------------------------------
// Units outstanding — uses fund-data deposit records
// ---------------------------------------------------------------------------
const DEPOSIT_META_KEYS = new Set(["date","amount","source","nav","investor","ibDesc","currency","description","source"]);
function computeTotalUnitsAtDate(deposits, dateStr) {
  return deposits
    .filter(d => d.date <= dateStr)
    .reduce((sum, d) => {
      const nav = d.nav > 0 ? d.nav : INCEPTION_NAV;
      if (d.investor) {
        // New format: {investor: "key", amount: N}
        return sum + (d.amount || 0) / nav;
      }
      // Old format: {fernando: N, dario: N, juana_robledo: N, ...}
      const invTotal = Object.entries(d)
        .filter(([k, v]) => !DEPOSIT_META_KEYS.has(k) && typeof v === "number" && v > 0)
        .reduce((s, [, v]) => s + v, 0);
      return sum + invTotal / nav;
    }, 0);
}

// ---------------------------------------------------------------------------
// IB Flex Web Service
// ---------------------------------------------------------------------------
const BASE      = "https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService";
const CACHE_KEY = bname("ib-cache.json");
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

  // Cash balance from CashReport
  let cashBalance = null;
  let cashRows2 = stmt?.CashReport?.CashReportCurrency ?? [];
  if (!Array.isArray(cashRows2)) cashRows2 = cashRows2 ? [cashRows2] : [];
  const cashRow2 = cashRows2.find(c => c?.currency === "BASE") ||
                   cashRows2.find(c => c?.currency === "USD")  ||
                   cashRows2[0];
  if (cashRow2) cashBalance = parseFloat(cashRow2.endingCash || cashRow2.endingSettledCash || 0);

  // ------------------------------------------------------------------
  // Cash transactions — deposits, dividends, interest, fees
  // ------------------------------------------------------------------
  let rawCashTx = stmt?.CashTransactions?.CashTransaction ?? [];
  if (!Array.isArray(rawCashTx)) rawCashTx = rawCashTx ? [rawCashTx] : [];

  const deposits = rawCashTx
    .filter(t => t && parseFloat(t.amount) > 0 &&
      (String(t.type || "").toLowerCase().includes("deposit") ||
       String(t.type || "").toLowerCase().includes("withdrawal") ||
       String(t.levelOfDetail || "").toLowerCase() === "currency"))
    .map(t => ({
      id:          `${normDate(t.reportDate || t.dateTime)}_${parseFloat(t.amount)}`,
      date:        normDate(t.reportDate || t.dateTime),
      amount:      parseFloat(t.amount),
      currency:    t.currency || "USD",
      description: t.description || t.type || "",
    }));

  // Dividend payments — store actual cash amounts from IB
  const dividends = rawCashTx
    .filter(t => t && String(t.type || "").toLowerCase().includes("dividend"))
    .map(t => {
      const date   = normDate(t.reportDate || t.dateTime);
      const amount = parseFloat(t.amount);
      const desc   = String(t.description || "");
      // Extract ticker from description like "BND (VANGUARD...) CASH DIVIDEND USD 0.247259 PER SHARE"
      const ticker = t.symbol || desc.match(/^([A-Z]+)\s/)?.[1] || "";
      const rateMatch = desc.match(/([\d.]+)\s+PER\s+SHARE/i);
      return {
        date,
        ticker,
        type:      "dividend",
        netAmount: amount,
        price:     rateMatch ? parseFloat(rateMatch[1]) : 0,
        notes:     "Cash dividend",
      };
    });

  // Interest income
  const interest = rawCashTx
    .filter(t => t && String(t.type || "").toLowerCase().includes("interest"))
    .map(t => ({
      date:      normDate(t.reportDate || t.dateTime),
      ticker:    null,
      type:      "interest",
      netAmount: parseFloat(t.amount),
      notes:     String(t.description || t.type || ""),
    }));

  // Broker fees (negative amounts, type "Other Fees" etc.)
  const fees = rawCashTx
    .filter(t => t && parseFloat(t.amount) < 0 &&
      !String(t.type || "").toLowerCase().includes("deposit") &&
      !String(t.type || "").toLowerCase().includes("withdrawal") &&
      !String(t.type || "").toLowerCase().includes("dividend") &&
      !String(t.type || "").toLowerCase().includes("interest"))
    .map(t => ({
      date:      normDate(t.reportDate || t.dateTime),
      ticker:    null,
      type:      "fee",
      netAmount: parseFloat(t.amount),
      notes:     String(t.description || t.type || ""),
    }));

  return { positions, totalValue, cashBalance, trades, deposits, dividends, interest, fees };
}

// ---------------------------------------------------------------------------
// Income transactions — merge dividends/interest/fees into fund-data.transactions
// Deduplication key: date + type + ticker (or date + type for non-ticker)
// ---------------------------------------------------------------------------
async function appendIncomeTx({ dividends, interest, fees, blobBase }) {
  const incoming = [...dividends, ...interest, ...fees].filter(t => t.date);
  if (!incoming.length) return;

  const fdUrl = burl("fund-data.json");
  let fd;
  try {
    const r = await fetch(`${fdUrl}?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return;
    fd = await r.json();
  } catch { return; }

  if (!fd.transactions) fd.transactions = [];

  // Build dedup key set from existing transactions that already have netAmount
  const existingKeys = new Set(
    fd.transactions
      .filter(t => t.netAmount != null)
      .map(t => `${t.date}|${t.type}|${t.ticker || ""}`)
  );

  let added = 0;
  for (const tx of incoming) {
    if (!tx.date) continue;
    const key = `${tx.date}|${tx.type}|${tx.ticker || ""}`;

    // Update existing record if it exists without netAmount
    const existing = fd.transactions.find(
      t => t.date === tx.date && t.type === tx.type && (t.ticker || "") === (tx.ticker || "")
    );
    if (existing) {
      if (existing.netAmount == null) {
        existing.netAmount = tx.netAmount;
        added++;
      }
      continue;
    }

    if (existingKeys.has(key)) continue;
    fd.transactions.push(tx);
    existingKeys.add(key);
    added++;
  }

  if (added === 0) return;

  fd.transactions.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  await put(bname("fund-data.json"), JSON.stringify(fd), {
    access: "public", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false,
  });
}

// ---------------------------------------------------------------------------
// Deposit detection — find new deposits not yet allocated or pending
// ---------------------------------------------------------------------------
async function detectNewDeposits({ deposits, blobBase, resendKey }) {
  if (!deposits.length) return;

  // Load already-allocated deposits
  let allocatedIds = new Set();
  try {
    const fd = await (await fetch(`${burl("fund-data.json")}?t=${Date.now()}`, { cache: "no-store" })).json();
    (fd.deposits || []).forEach(d => allocatedIds.add(`${d.date}_${d.amount}`));
  } catch {}

  // Load already-pending deposits — normalize any old datetime-format IDs to date_amount
  let pending = { deposits: [] };
  let pendingNeedsWrite = false;
  try {
    const r = await fetch(`${burl("pending-deposits.json")}?t=${Date.now()}`, { cache: "no-store" });
    if (r.ok) pending = await r.json();
  } catch {}
  pending.deposits = (pending.deposits || []).map(d => {
    const canonical = `${String(d.date || "").slice(0, 10)}_${d.amount}`;
    if (d.id !== canonical) { pendingNeedsWrite = true; return { ...d, id: canonical }; }
    return d;
  });
  const pendingIds = new Set(pending.deposits.map(d => d.id));

  // Find truly new ones
  const newDeposits = deposits.filter(d => !allocatedIds.has(d.id) && !pendingIds.has(d.id));
  if (!newDeposits.length) {
    // Still write back if we normalized any IDs
    if (pendingNeedsWrite) {
      await put(bname("pending-deposits.json"), JSON.stringify(pending), {
        access: "public", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false,
      });
    }
    return;
  }

  // Save to pending-deposits.json
  pending.deposits.push(...newDeposits);
  await put(bname("pending-deposits.json"), JSON.stringify(pending), {
    access: "public", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false,
  });

  // Send email for each new deposit
  if (!resendKey) return;
  for (const dep of newDeposits) {
    const base  = "https://red-road-securities.vercel.app";
    const btnStyle = "display:inline-block;padding:10px 20px;border-radius:6px;font-weight:600;font-size:14px;text-decoration:none;margin:4px;";
    const investors = [
      { key: "fernando", label: "Fernando" },
      { key: "dario",    label: "Dario"    },
    ];
    const allocBtns = investors.map(inv =>
      `<a href="${base}/?allocate=${encodeURIComponent(dep.id)}&investor=${inv.key}" style="${btnStyle}background:#1a6b3c;color:#fff;">Allocate to ${inv.label}</a>`
    ).join("\n");
    const newBtn = `<a href="${base}/?allocate=${encodeURIComponent(dep.id)}&investor=new" style="${btnStyle}background:#1a3a6b;color:#fff;">New investor</a>`;

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from:    "Fund ONE <onboarding@resend.dev>",
        to:      ["pablomontoyarobledo@gmail.com"],
        subject: `New deposit detected — $${dep.amount.toLocaleString("en-US")} on ${dep.date}`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;">
            <h2 style="color:#1a6b3c;margin-bottom:4px;">New Deposit Detected</h2>
            <p style="color:#666;margin-top:0;">Fund ONE · Red Road Securities</p>
            <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px;">
              <tr><td style="padding:8px 0;color:#888;">Date</td><td style="padding:8px 0;font-weight:600;">${dep.date}</td></tr>
              <tr><td style="padding:8px 0;color:#888;">Amount</td><td style="padding:8px 0;font-weight:600;color:#1a6b3c;">$${dep.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}</td></tr>
              <tr><td style="padding:8px 0;color:#888;">Currency</td><td style="padding:8px 0;">${dep.currency}</td></tr>
              <tr><td style="padding:8px 0;color:#888;">Description</td><td style="padding:8px 0;">${dep.description || "—"}</td></tr>
            </table>
            <p style="font-size:14px;margin-bottom:12px;">Allocate this deposit to an investor:</p>
            ${allocBtns}
            ${newBtn}
            <p style="font-size:11px;color:#aaa;margin-top:24px;">This deposit was automatically detected from your IB account. Log in to the admin panel to review pending deposits.</p>
          </div>
        `,
      }),
    });
  }
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

  // Live fetch — fall back to cache on IB 1001 (markets open / statement unavailable)
  let stmtXml;
  try {
    stmtXml = await fetchFromIB(token, queryId);
  } catch (err) {
    const is1001 = err.message.includes("1001");
    // Always try to serve cache on failure
    try {
      const cacheRes = await fetch(`${blobBase}${CACHE_KEY}?t=${Date.now()}`, { cache: "no-store" });
      if (cacheRes.ok) {
        const cached = await cacheRes.json();
        return res.status(200).json({
          ...cached,
          fromCache: true,
          cacheAgeMinutes: Math.round((Date.now() - new Date(cached.lastUpdated).getTime()) / 60000),
          ibUnavailable: true,
          ibNote: is1001
            ? "IB statements are only available after market close (4 PM ET). Showing last cached data."
            : err.message,
        });
      }
    } catch {}
    return res.status(502).json({ error: err.message });
  }

  let parsed;
  try {
    parsed = parseStatement(stmtXml);
  } catch (err) {
    return res.status(502).json({ error: err.message, rawSnippet: stmtXml?.slice(0, 800) });
  }

  const now    = new Date();

  // Append today's NAV point first so we can include nav/twr in the archive
  let navPoint = null;
  try {
    let deposits = [];
    try {
      const fdRes = await fetch(`${burl("fund-data.json")}?t=${Date.now()}`, { cache: "no-store" });
      if (fdRes.ok) { const fd = await fdRes.json(); deposits = fd.deposits || []; }
    } catch {}
    const dateStr = now.toISOString().slice(0, 10);
    navPoint = await appendNavPoint({ totalValue: parsed.totalValue, dateStr, blobBase, deposits });
  } catch {}

  // Cash balance — from CashReport if available, else from fund-data
  let cashBalance = parsed.cashBalance ?? null;

  const result = {
    positions:   parsed.positions,
    totalValue:  parsed.totalValue,
    cashBalance,
    nav:         navPoint?.nav         ?? null,
    twr:         navPoint?.twr         ?? null,
    trades:      parsed.trades,
    lastUpdated: now.toISOString(),
    source:      "cron",
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
    await put(`${bprefix("ib-history/")}${stamp}.json`, JSON.stringify(result), {
      access: "public", contentType: "application/json", addRandomSuffix: false,
    });
  } catch {}

  // Append new trades to trades-history.json
  try {
    await appendTrades({ trades: parsed.trades, blobBase });
  } catch {}

  // Keep fund-data.json's positions/cashBalance current — the dashboard's
  // total-value calculation reads these directly, and previously only a
  // manual "Sync to cloud" click ever refreshed them. Without this, new
  // deposits and daily price/share moves silently vanished from the
  // displayed total until someone happened to click sync.
  try {
    const fdRes = await fetch(`${burl("fund-data.json")}?t=${Date.now()}`, { cache: "no-store" });
    if (fdRes.ok) {
      const fd = await fdRes.json();
      if (parsed.positions?.length) fd.positions = parsed.positions;
      if (cashBalance != null) fd.cashBalance = cashBalance;
      fd.ibSyncedAt = now.toISOString();
      await put(bname("fund-data.json"), JSON.stringify(fd), {
        access: "public", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false,
      });
    }
  } catch {}

  // Merge dividend/interest/fee transactions into fund-data.transactions
  try {
    await appendIncomeTx({
      dividends: parsed.dividends || [],
      interest:  parsed.interest  || [],
      fees:      parsed.fees      || [],
      blobBase,
    });
  } catch {}

  // Detect new deposits and notify
  try {
    await detectNewDeposits({
      deposits:  parsed.deposits || [],
      blobBase,
      resendKey: process.env.RESEND_API_KEY,
    });
  } catch {}

  return res.status(200).json(result);
}

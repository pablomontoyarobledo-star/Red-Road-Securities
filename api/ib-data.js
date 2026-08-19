import { XMLParser } from "fast-xml-parser";
import { sql, readDoc, writeDoc, writeSnapshot, appendPendingDeposits, markPendingDepositsNotified } from "../lib/store.js";
import { appendNavPoint } from "../lib/navPoint.js";
import { postIBSyncToLedger } from "../lib/ledger.js";
import { checkAndPostMonthlyFees } from "../lib/unitTransfer.js";

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
// Trades library — merges today's trades into trades-history.json
// Deduplication key: tradeID (IB's own unique identifier per execution),
// falling back to a composite key when IB omits one for a given execution.
// ---------------------------------------------------------------------------
function tradeCompositeKey(t) {
  return `${t.date}_${t.ticker}_${t.shares}_${t.price}_${t.type}`;
}

async function appendTrades({ trades }) {
  if (!trades.length) return;

  let history = { trades: [] };
  try {
    const h = await readDoc("trades-history.json");
    if (h) history = h;
  } catch {}

  // A trade with no tradeId previously bypassed dedup entirely — `t.tradeId
  // && existingIds.has(...)` short-circuits to false on a falsy id, so every
  // re-pull/re-import containing that execution appended another copy. Fall
  // back to a composite key for id-less trades, same pattern
  // detectNewDeposits() already uses for deposits missing a txId.
  const existingIds        = new Set(history.trades.filter(t => t.tradeId).map(t => t.tradeId));
  const existingComposites = new Set(history.trades.filter(t => !t.tradeId).map(tradeCompositeKey));

  let added = 0;
  for (const t of trades) {
    if (t.tradeId) {
      if (existingIds.has(t.tradeId)) continue; // already stored
      existingIds.add(t.tradeId);
    } else {
      const key = tradeCompositeKey(t);
      if (existingComposites.has(key)) continue; // already stored
      existingComposites.add(key);
    }
    history.trades.push(t);
    added++;
  }

  if (added === 0) return; // nothing new

  // Keep sorted by date desc for easy querying
  history.trades.sort((a, b) => b.date.localeCompare(a.date) || b.tradeId?.localeCompare(a.tradeId));
  history.updatedAt = new Date().toISOString();

  await writeDoc("trades-history.json", history);
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

  // Deposits = any positive cash inflow that is NOT investment income or a fee.
  // (The old filter only caught type "deposit/withdrawal" or currency-summary
  // rows, so a wire IB labels differently — e.g. an EFT credit — slipped
  // through undetected.) Exclude summary rows (levelOfDetail "Currency") when
  // detail rows exist for the same money, and carry IB's transactionID so two
  // same-day, same-amount wires stay distinct instead of collapsing to one id.
  const INCOME_RE = /(dividend|interest|withhold|\btax\b|fee|commission|adjust)/i;
  let rawDeposits = rawCashTx.filter(t =>
    t && parseFloat(t.amount) > 0 && !INCOME_RE.test(String(t.type || "")));
  // If both per-transaction "Detail" rows and a "Currency" summary exist, keep
  // only the detail rows so the same wire isn't counted twice.
  const hasDetail = rawDeposits.some(t => String(t.levelOfDetail || "").toLowerCase() === "detail");
  if (hasDetail) rawDeposits = rawDeposits.filter(t => String(t.levelOfDetail || "").toLowerCase() !== "currency");

  const deposits = rawDeposits.map(t => {
    const date = normDate(t.reportDate || t.dateTime);
    const amt  = parseFloat(t.amount);
    const txId = String(t.transactionID || t.transactionId || "");
    return {
      id:          txId ? `tx_${txId}` : `${date}_${amt}`,
      txId,
      date,
      amount:      amt,
      currency:    t.currency || "USD",
      description: t.description || t.type || "",
    };
  });

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
        // IB's own per-row id — carried through so the general ledger has a
        // real natural key to dedup on (the "date|type|ticker" key used by
        // appendIncomeTx below is too weak to trust for GL idempotency:
        // two same-day dividends on the same ticker would collide).
        txId:      String(t.transactionID || t.transactionId || ""),
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
      txId:      String(t.transactionID || t.transactionId || ""),
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
      txId:      String(t.transactionID || t.transactionId || ""),
    }));

  return { positions, totalValue, cashBalance, trades, deposits, dividends, interest, fees };
}

// ---------------------------------------------------------------------------
// Trade transactions — merge buy/sell executions into fund-data.transactions,
// the field the dashboard's Transactions tab actually renders. Without this,
// a trade landed in trades-history.json (via appendTrades above) but stayed
// invisible in the UI — only a manual XML import ever wrote trades into
// fund-data.transactions. Dedup mirrors import-ib-xml.js's approach: IB's
// tradeID when present, else a composite key, since same-day same-ticker
// buys are common (e.g. several BND fills in one session) and a date+type
// +ticker key — fine for dividends — would collapse them into one.
// ---------------------------------------------------------------------------
async function appendTradeTx({ trades }) {
  if (!trades.length) return;

  let fd;
  try {
    fd = await readDoc("fund-data.json");
    if (!fd) return;
  } catch { return; }

  if (!fd.transactions) fd.transactions = [];

  const tradeKey = t => `${t.date}_${t.ticker}_${t.shares}_${t.price}_${t.type}`;
  const existingIds        = new Set(fd.transactions.filter(t => t.tradeId).map(t => t.tradeId));
  const existingComposites = new Set(fd.transactions.filter(t => !t.tradeId).map(tradeKey));

  let added = 0;
  for (const t of trades) {
    if (t.tradeId) {
      if (existingIds.has(t.tradeId)) continue;
      existingIds.add(t.tradeId);
    } else {
      const key = tradeKey(t);
      if (existingComposites.has(key)) continue;
      existingComposites.add(key);
    }
    fd.transactions.push(t);
    added++;
  }

  if (added === 0) return;

  fd.transactions.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  await writeDoc("fund-data.json", fd);
}

// ---------------------------------------------------------------------------
// Income transactions — merge dividends/interest/fees into fund-data.transactions
// Deduplication key: date + type + ticker (or date + type for non-ticker)
// ---------------------------------------------------------------------------
async function appendIncomeTx({ dividends, interest, fees }) {
  const incoming = [...dividends, ...interest, ...fees].filter(t => t.date);
  if (!incoming.length) return;

  let fd;
  try {
    fd = await readDoc("fund-data.json");
    if (!fd) return;
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
  await writeDoc("fund-data.json", fd);
}

// ---------------------------------------------------------------------------
// Deposit detection — find new deposits not yet allocated or pending
// ---------------------------------------------------------------------------
async function detectNewDeposits({ deposits }) {
  if (!deposits.length) return;

  // A deposit is already known if IB's transactionID has been seen, OR — for
  // records stored before we tracked transactionIDs — if a same-date/same-amount
  // entry is still "uncovered". Using a multiset count (not a plain set) means
  // two $10k wires on the same day are two distinct deposits, not one.
  const knownTxIds = new Set();
  const knownCount = new Map();
  const bump = k => knownCount.set(k, (knownCount.get(k) || 0) + 1);

  try {
    const fd = (await readDoc("fund-data.json")) || {};
    (fd.deposits || []).forEach(d => { if (d.txId) knownTxIds.add(d.txId); bump(`${d.date}_${d.amount}`); });
  } catch {}

  const pending = (await readDoc("pending-deposits.json")) || { deposits: [] };
  (pending.deposits || []).forEach(d => {
    if (d.txId) knownTxIds.add(d.txId);
    bump(`${String(d.date || "").slice(0, 10)}_${d.amount}`);
  });

  // Find truly new ones, consuming the multiset as we go.
  const newDeposits = [];
  for (const d of deposits) {
    if (d.txId && knownTxIds.has(d.txId)) continue;          // exact match — already known
    const key = `${d.date}_${d.amount}`;
    const left = knownCount.get(key) || 0;
    if (left > 0) { knownCount.set(key, left - 1); continue; } // covered by a pre-txId record
    newDeposits.push(d);
  }
  if (!newDeposits.length) return;

  // Append atomically — an admin allocating (removing) a different pending
  // deposit at the same moment won't get clobbered by this write.
  await appendPendingDeposits(newDeposits);
}

// ---------------------------------------------------------------------------
// Deposit notification — emails every pending deposit not yet acknowledged.
// Decoupled from detection and idempotent (a `notified` flag per deposit), so
// a send that fails — or a deposit detected before email worked — is retried
// on the next pull until it succeeds, instead of being emailed once or never.
// ---------------------------------------------------------------------------
async function notifyPendingDeposits({ resendKey }) {
  if (!resendKey) return;

  const pending = (await readDoc("pending-deposits.json")) || { deposits: [] };
  const toNotify = (pending.deposits || []).filter(d => !d.notified);
  if (!toNotify.length) return;

  // Offer a button for every current investor (not just Fernando/Dario).
  let investors = [];
  try {
    const inv = (await readDoc("investors.json")) || {};
    investors = (inv.investors || []).map(i => ({
      key:   i.id.startsWith("inv_") ? i.id.slice(4) : i.id,
      label: `${i.firstName} ${i.lastName}`.trim() || i.id,
    }));
  } catch {}
  if (!investors.length) investors = [{ key: "fernando", label: "Fernando" }, { key: "dario", label: "Dario" }];

  const notifiedIds = [];
  for (const dep of toNotify) {
    const base  = "https://red-road-securities.vercel.app";
    const btnStyle = "display:inline-block;padding:10px 20px;border-radius:6px;font-weight:600;font-size:14px;text-decoration:none;margin:4px;";
    const allocBtns = investors.map(inv =>
      `<a href="${base}/?allocate=${encodeURIComponent(dep.id)}&investor=${inv.key}" style="${btnStyle}background:#1a6b3c;color:#fff;">Allocate to ${inv.label}</a>`
    ).join("\n");
    const newBtn = `<a href="${base}/?allocate=${encodeURIComponent(dep.id)}&investor=new" style="${btnStyle}background:#1a3a6b;color:#fff;">New investor</a>`;

    try {
      const r = await fetch("https://api.resend.com/emails", {
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
      if (r.ok) notifiedIds.push(dep.id);
    } catch {}
  }

  // Mark atomically — an admin allocating (removing) a different pending
  // deposit at the same moment won't get clobbered by this write.
  if (notifiedIds.length) {
    await markPendingDepositsNotified(notifiedIds);
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

  // Serve cache if fresh enough
  if (!forceRefresh) {
    try {
      const cached = await readDoc(CACHE_KEY);
      if (cached) {
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
      const cached = await readDoc(CACHE_KEY);
      if (cached) {
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

  // Detect new deposits FIRST so this pull's fresh wires are in the pending
  // list before we price the NAV point (otherwise their cash would inflate
  // today's NAV until the next pull).
  try {
    await detectNewDeposits({
      deposits:  parsed.deposits || [],
      resendKey: process.env.RESEND_API_KEY,
    });
  } catch {}

  // Email any pending deposit not yet acknowledged (retries until it sends).
  try {
    await notifyPendingDeposits({ resendKey: process.env.RESEND_API_KEY });
  } catch {}

  // Sum un-allocated pending-deposit cash — folded into the NAV as pending units.
  let pendingCash = 0;
  try {
    const pd = await readDoc("pending-deposits.json");
    if (pd) pendingCash = (pd.deposits || []).reduce((s, d) => s + (d.amount || 0), 0);
  } catch {}

  // Append today's NAV point (pending cash held neutral as pending units)
  let navPoint = null;
  try {
    let fd = null;
    try {
      fd = await readDoc("fund-data.json");
    } catch {}
    const deposits = fd?.deposits || [];
    const dateStr = now.toISOString().slice(0, 10);
    const appended = await appendNavPoint({ totalValue: parsed.totalValue, dateStr, deposits, pendingCash });
    navPoint = appended?.point ?? null;
    // Persist any deposit re-pricing done by the self-heal pass
    if (appended?.depositsChanged && fd) {
      await writeDoc("fund-data.json", fd);
    }
  } catch {}

  // Cash balance — from CashReport if available, else from fund-data
  let cashBalance = parsed.cashBalance ?? null;

  const result = {
    positions:   parsed.positions,
    totalValue:  parsed.totalValue,
    cashBalance,
    pendingCash,
    nav:         navPoint?.nav         ?? null,
    twr:         navPoint?.twr         ?? null,
    trades:      parsed.trades,
    lastUpdated: now.toISOString(),
    source:      "cron",
  };

  // Rolling cache
  try {
    await writeDoc(CACHE_KEY, result);
  } catch {}

  // Permanent archive — one snapshot per pull
  try {
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    await writeSnapshot("ib-history", `${stamp}.json`, result);
  } catch {}

  // Append new trades to trades-history.json
  try {
    await appendTrades({ trades: parsed.trades });
  } catch (err) { console.error("[ib-data] appendTrades failed:", err.message); }

  // Merge trades into fund-data.transactions so they actually show up in
  // the dashboard's Transactions tab (trades-history.json above is a
  // separate archive nothing in the UI reads).
  try {
    await appendTradeTx({ trades: parsed.trades });
  } catch (err) { console.error("[ib-data] appendTradeTx failed:", err.message); }

  // Keep fund-data.json's positions/cashBalance current — the dashboard's
  // total-value calculation reads these directly, and previously only a
  // manual "Sync to cloud" click ever refreshed them. Without this, new
  // deposits and daily price/share moves silently vanished from the
  // displayed total until someone happened to click sync.
  try {
    const fd = await readDoc("fund-data.json");
    if (fd) {
      if (parsed.positions?.length) fd.positions = parsed.positions;
      if (cashBalance != null) fd.cashBalance = cashBalance;
      fd.ibSyncedAt = now.toISOString();
      await writeDoc("fund-data.json", fd);
    }
  } catch {}

  // Merge dividend/interest/fee transactions into fund-data.transactions
  try {
    await appendIncomeTx({
      dividends: parsed.dividends || [],
      interest:  parsed.interest  || [],
      fees:      parsed.fees      || [],
    });
  } catch {}

  // Post trades/dividends/interest/fees into the general ledger. Idempotent
  // against repeated pulls (DB unique index on source_type+source_id) — a
  // failure here must never fail the cron pull itself, same philosophy as
  // every other secondary step in this handler.
  try {
    await postIBSyncToLedger(sql, {
      trades:    parsed.trades    || [],
      dividends: parsed.dividends || [],
      interest:  parsed.interest  || [],
      fees:      parsed.fees      || [],
      actor: "cron",
    });
  } catch (err) { console.error("[ib-data] postIBSyncToLedger failed:", err.message); }

  // Post any management-fee/bonus unit transfers owed as of today (backlog
  // catch-up + this month's fee are the same code path — see
  // lib/unitTransfer.js). Also best-effort; retried on the next pull.
  try {
    await checkAndPostMonthlyFees(sql, { actor: "cron" });
  } catch (err) { console.error("[ib-data] checkAndPostMonthlyFees failed:", err.message); }

  return res.status(200).json(result);
}

import { readDoc, backupAndWrite, writeSnapshot, removePendingDeposit, writeAuditLog, allocateDepositAtomic, insertClaimToken } from "../lib/store.js";
import { isAdminRequest, identifyActor, issueClaimToken } from "../lib/auth.js";
import { recomputeNavSeries, fixIbDepositNavs, computeTotalUnitsAtDate, INCEPTION_NAV } from "../lib/nav.js";
import { sendClaimAccountEmail } from "../lib/claimEmail.js";

// Email deep-links pass bare keys ("dario") but investor.id is "inv_dario".
// Match either form — same flexible lookup the client uses in calcUnits().
function findInvestor(investors, key) {
  return investors.find(i => i.id === key || (i.id.startsWith("inv_") ? i.id.slice(4) : i.id) === key);
}

// Normalize a raw-digit IB date ("20260706") to ISO ("2026-07-06").
// Leaves already-correct dates untouched.
function normDate(raw) {
  const s = String(raw || "");
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const digits = s.replace(/\D/g, "").slice(0, 8);
  if (digits.length !== 8) return s;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

// One-off maintenance action: fixes malformed dates and mis-resolved source
// names on deposits already saved before the underlying bugs were patched.
// Safe to re-run — it's a no-op on records that are already correct.
async function repairDeposits() {
  const fundData = await readDoc("fund-data.json");
  if (!fundData) throw new Error("Could not load fund-data.json");
  const investorsData = await readDoc("investors.json");
  if (!investorsData || !Array.isArray(investorsData.investors)) {
    throw new Error("Could not load investors.json");
  }

  const META = new Set(["date", "amount", "source", "nav", "investor", "ibDesc", "currency", "description"]);
  let fixed = 0;
  const changes = [];

  for (const d of fundData.deposits || []) {
    const before = { date: d.date, source: d.source };

    const fixedDate = normDate(d.date);
    if (fixedDate !== d.date) d.date = fixedDate;

    // Figure out which investor this deposit belongs to
    let key = d.investor;
    if (!key) {
      const entry = Object.entries(d).find(([k, v]) => !META.has(k) && typeof v === "number" && v > 0);
      key = entry?.[0];
    }
    const inv = key ? findInvestor(investorsData.investors, key) : null;
    if (inv) {
      const fullName = `${inv.firstName} ${inv.lastName}`.trim();
      if (fullName && d.source !== fullName) d.source = fullName;
    }

    if (before.date !== d.date || before.source !== d.source) {
      fixed++;
      changes.push({ before, after: { date: d.date, source: d.source } });
    }
  }

  // Re-price IB-detected deposits at their fair pre-money NAV, then recompute
  // NAV history from the corrected ledger. A deposit priced at the inflated
  // post-cash NAV mints too few units for the depositor; a deposit excluded
  // from a day's unit count when its nav-history point was first written
  // never self-corrects once that point is stale. Both fixes are pure math
  // over data we already have — no IB call, safe to run mid-rate-limit.
  let navFixed = 0;
  const navHistory = await readDoc("nav-history.json");
  const navsRepriced = navHistory?.series?.length
    ? fixIbDepositNavs(fundData.deposits, navHistory.series)
    : 0;

  if (fixed > 0 || navsRepriced > 0) {
    fundData.deposits.sort((a, b) => a.date.localeCompare(b.date));
    await backupAndWrite("fund-data.json", fundData);
  }

  if (navHistory?.series?.length) {
    navFixed = recomputeNavSeries(navHistory.series, fundData.deposits, navHistory.inception?.nav || INCEPTION_NAV);
    if (navFixed > 0) await backupAndWrite("nav-history.json", navHistory);
  }

  return { fixed, changes, navsRepriced, navFixed };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-sync-secret, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!(await isAdminRequest(req))) return res.status(401).json({ error: "Unauthorized" });

  const actor = await identifyActor(req);

  if (req.body?.action === "repair") {
    try {
      const report = await repairDeposits();
      await writeAuditLog({ actor, action: "deposits.repair", detail: report });
      return res.status(200).json({ ok: true, ...report });
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  }

  const { depositId, investorKey, newInvestor, nav } = req.body || {};
  if (!depositId) return res.status(400).json({ error: "depositId required" });
  if (!investorKey && !newInvestor) return res.status(400).json({ error: "investorKey or newInvestor required" });

  // Load pending deposits
  const pending = await readDoc("pending-deposits.json") || { deposits: [] };
  const deposit = pending.deposits.find(d => d.id === depositId);
  if (!deposit) return res.status(404).json({ error: "Deposit not found in pending list" });

  // Load fund-data — hard fail if unavailable
  const fundData = await readDoc("fund-data.json");
  if (!fundData) return res.status(502).json({ error: "Could not load fund-data.json" });

  // Load investors — hard fail if unavailable, never default to empty array
  const investorsData = await readDoc("investors.json");
  if (!investorsData || !Array.isArray(investorsData.investors)) {
    return res.status(502).json({ error: "Could not load investors.json — aborting to prevent data loss" });
  }

  // Handle new investor creation
  let resolvedKey = investorKey;
  if (newInvestor) {
    const key = newInvestor.firstName.toLowerCase() + "_" + newInvestor.lastName.toLowerCase().replace(/\s+/g, "_");
    resolvedKey = key;
    investorsData.investors.push({
      id:          key,
      firstName:   newInvestor.firstName,
      lastName:    newInvestor.lastName,
      email:       newInvestor.email || "",
      joinDate:    deposit.date,
      nationality: "",
      lang:        "en",
      phone:       "",
      mailingAddress: "",
    });
    await backupAndWrite("investors.json", investorsData);
  }

  // Append deposit to fund-data.deposits
  // Use per-investor-key format so calcUnits() can sum across all investors
  //
  // Price the deposit at the NAV that exists the moment before its cash is
  // counted — the last known NAV strictly before the deposit date. A deposit
  // is struck at the current NAV and must never move it; the prior point's
  // NAV is exactly that price. Falls back to the client-supplied nav (or the
  // latest point) only if no earlier point exists.
  let depositNav = nav || deposit.navAtDeposit || 1.0;
  try {
    const navHist = await readDoc("nav-history.json");
    const series  = navHist?.series || [];
    let priorNav = null;
    for (const pt of series) {
      if (pt.date < deposit.date && pt.nav > 0) priorNav = pt.nav;
      else if (pt.date >= deposit.date) break;
    }
    // If the deposit dates to today (no strictly-earlier point on the same
    // day), fall back to the most recent available NAV.
    if (!priorNav && series.length) {
      const last = series[series.length - 1];
      if (last?.nav > 0) priorNav = last.nav;
    }
    if (priorNav > 0) depositNav = Math.round(priorNav * 1e8) / 1e8;
  } catch {}
  const invMatch   = findInvestor(investorsData.investors, resolvedKey);
  const record = {
    date:   deposit.date,
    amount: deposit.amount,
    source: invMatch ? `${invMatch.firstName} ${invMatch.lastName}`.trim() : resolvedKey,
    nav:    depositNav,
    ibDesc: deposit.description || "",
  };
  // Carry IB's transactionID so deposit detection never re-flags this wire.
  if (deposit.txId) record.txId = deposit.txId;
  // Deposit key: strip "inv_" prefix for legacy investors (inv_fernando -> fernando), keep as-is otherwise
  const depKey = invMatch
    ? (invMatch.id.startsWith("inv_") ? invMatch.id.slice(4) : invMatch.id)
    : (resolvedKey.startsWith("inv_") ? resolvedKey.slice(4) : resolvedKey);
  record[depKey] = deposit.amount;

  if (!fundData.deposits) fundData.deposits = [];
  fundData.deposits.push(record);
  fundData.deposits.sort((a, b) => a.date.localeCompare(b.date));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Best-effort snapshot (matches backupAndWrite's existing behavior) — the
  // write itself below is the atomic, duplicate-proof one.
  try { await writeSnapshot("backups", `fund-data-${stamp}.json`, fundData); } catch {}

  // Atomically insert the deposits-table row (the structural idempotency
  // gate, keyed on the pending deposit this is being promoted from) and
  // overwrite fund-data.json — both land or neither does (see
  // allocateDepositAtomic's comment for why a naive two-step write isn't
  // safe here). A conflict means someone already allocated this exact
  // pending deposit — a concurrent double-submit — so fund-data.json is
  // left untouched and the pending deposit stays put, rather than silently
  // minting the investor's cash twice.
  const canonicalInvestorId = invMatch ? invMatch.id : resolvedKey;
  const depositRowId = await allocateDepositAtomic({
    investorId: canonicalInvestorId,
    date:       record.date,
    amount:     record.amount,
    nav:        record.nav,
    source:     record.source,
    ibDesc:     record.ibDesc,
    txId:       record.txId || null,
    sourcePendingId: depositId,
    legacyKey:  depKey,
    fundData,
  });
  if (depositRowId == null) {
    return res.status(409).json({ error: "This deposit was already allocated (concurrent request) — no changes made." });
  }

  // Brand-new investor, first deposit just landed — send them an investor-claim
  // link so they can set their own password. Best-effort: an email failure
  // must never roll back or block the deposit allocation that already
  // succeeded above (falls back to the admin "Invite" button in the
  // Investors tab, which sends the same email).
  if (newInvestor && newInvestor.email) {
    try {
      const email = newInvestor.email.toLowerCase();
      const { token, jti, expiresAt } = issueClaimToken({ investorId: canonicalInvestorId, email });
      await insertClaimToken({ jti, investorId: canonicalInvestorId, email, expiresAt });
      await sendClaimAccountEmail({
        to: newInvestor.email, firstName: newInvestor.firstName, lang: newInvestor.lang || "en",
        amount: deposit.amount, date: deposit.date, token,
      });
    } catch (err) { console.error("[allocate-deposit] claim email failed:", err.message); }
  }

  // Remove from pending — atomic, so a concurrent IB pull adding/notifying
  // other deposits at the same moment can't silently resurrect this one.
  try { await writeSnapshot("backups", `pending-deposits-${stamp}.json`, pending); } catch {}
  await removePendingDeposit(depositId);

  await writeAuditLog({
    actor, action: "deposits.allocate", target: depositId,
    detail: { investorKey: resolvedKey, newInvestor: !!newInvestor, amount: deposit.amount, date: deposit.date, nav: depositNav, depositRowId },
  });

  return res.status(200).json({ ok: true, record });
}

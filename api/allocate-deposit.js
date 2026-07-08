import { put } from "@vercel/blob";
import { burl, bname, bprefix } from "../lib/store.js";
import { isAdminRequest } from "../lib/auth.js";
import { recomputeNavSeries, INCEPTION_NAV } from "../lib/nav.js";

// Email deep-links pass bare keys ("dario") but investor.id is "inv_dario".
// Match either form — same flexible lookup the client uses in calcUnits().
function findInvestor(investors, key) {
  return investors.find(i => i.id === key || (i.id.startsWith("inv_") ? i.id.slice(4) : i.id) === key);
}

async function readJson(name) {
  const r = await fetch(`${burl(name)}?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) return null;
  return r.json();
}

async function backupAndWrite(name, data) {
  // Save timestamped backup before overwriting any critical blob
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await put(`${bprefix("backups/")}${name.replace(".json", "")}-${stamp}.json`, JSON.stringify(data), {
      access: "public", contentType: "application/json", addRandomSuffix: false,
    });
  } catch {}
  await put(bname(name), JSON.stringify(data), {
    access: "public", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false,
  });
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
  const fundData = await readJson("fund-data.json");
  if (!fundData) throw new Error("Could not load fund-data.json");
  const investorsData = await readJson("investors.json");
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

  if (fixed > 0) {
    fundData.deposits.sort((a, b) => a.date.localeCompare(b.date));
    await backupAndWrite("fund-data.json", fundData);
  }

  // Recompute NAV history from the (now-correct) deposit ledger. A deposit
  // that was excluded from a day's unit count when its nav-history point was
  // first written (bad date, not yet allocated, etc.) never self-corrects
  // once that point is stale — this catches it up without any IB call, so
  // it's safe to run any time, including while IB is rate-limiting us.
  let navFixed = 0;
  const navHistory = await readJson("nav-history.json");
  if (navHistory?.series?.length) {
    navFixed = recomputeNavSeries(navHistory.series, fundData.deposits, navHistory.inception?.nav || INCEPTION_NAV);
    if (navFixed > 0) await backupAndWrite("nav-history.json", navHistory);
  }

  return { fixed, changes, navFixed };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-sync-secret, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!isAdminRequest(req)) return res.status(401).json({ error: "Unauthorized" });

  if (req.body?.action === "repair") {
    try {
      const report = await repairDeposits();
      return res.status(200).json({ ok: true, ...report });
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  }

  const { depositId, investorKey, newInvestor, nav } = req.body || {};
  if (!depositId) return res.status(400).json({ error: "depositId required" });
  if (!investorKey && !newInvestor) return res.status(400).json({ error: "investorKey or newInvestor required" });

  // Load pending deposits
  const pending = await readJson("pending-deposits.json") || { deposits: [] };
  const deposit = pending.deposits.find(d => d.id === depositId);
  if (!deposit) return res.status(404).json({ error: "Deposit not found in pending list" });

  // Load fund-data — hard fail if unavailable
  const fundData = await readJson("fund-data.json");
  if (!fundData) return res.status(502).json({ error: "Could not load fund-data.json" });

  // Load investors — hard fail if unavailable, never default to empty array
  const investorsData = await readJson("investors.json");
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
  const depositNav = nav || deposit.navAtDeposit || 1.0;
  const invMatch   = findInvestor(investorsData.investors, resolvedKey);
  const record = {
    date:   deposit.date,
    amount: deposit.amount,
    source: invMatch ? `${invMatch.firstName} ${invMatch.lastName}`.trim() : resolvedKey,
    nav:    depositNav,
    ibDesc: deposit.description || "",
  };
  // Deposit key: strip "inv_" prefix for legacy investors (inv_fernando -> fernando), keep as-is otherwise
  const depKey = invMatch
    ? (invMatch.id.startsWith("inv_") ? invMatch.id.slice(4) : invMatch.id)
    : (resolvedKey.startsWith("inv_") ? resolvedKey.slice(4) : resolvedKey);
  record[depKey] = deposit.amount;

  if (!fundData.deposits) fundData.deposits = [];
  fundData.deposits.push(record);
  fundData.deposits.sort((a, b) => a.date.localeCompare(b.date));

  await backupAndWrite("fund-data.json", fundData);

  // Remove from pending
  pending.deposits = pending.deposits.filter(d => d.id !== depositId);
  await backupAndWrite("pending-deposits.json", pending);

  return res.status(200).json({ ok: true, record });
}

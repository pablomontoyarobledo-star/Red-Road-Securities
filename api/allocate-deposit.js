import { put } from "@vercel/blob";

// Always use the hardcoded public URL — never rely on env var for reads
const BLOB_BASE = "https://yt6mbeqqdx5ifzj3.public.blob.vercel-storage.com/";

// Mutating endpoint — requires the shared sync secret
function isAuthorized(req) {
  const syncSecret = process.env.SYNC_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  if (syncSecret && req.headers["x-sync-secret"] === syncSecret) return true;
  if (cronSecret && req.headers["authorization"] === `Bearer ${cronSecret}`) return true;
  return false;
}

async function readJson(name) {
  const r = await fetch(`${BLOB_BASE}${name}?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) return null;
  return r.json();
}

async function backupAndWrite(name, data) {
  // Save timestamped backup before overwriting any critical blob
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await put(`backups/${name.replace(".json", "")}-${stamp}.json`, JSON.stringify(data), {
      access: "public", contentType: "application/json", addRandomSuffix: false,
    });
  } catch {}
  await put(name, JSON.stringify(data), {
    access: "public", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false,
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-sync-secret");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!isAuthorized(req)) return res.status(401).json({ error: "Unauthorized" });

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
  const record = {
    date:   deposit.date,
    amount: deposit.amount,
    source: `${investorsData.investors.find(i => i.id === resolvedKey)?.firstName || ""} ${investorsData.investors.find(i => i.id === resolvedKey)?.lastName || ""}`.trim() || resolvedKey,
    nav:    depositNav,
    ibDesc: deposit.description || "",
  };
  // Deposit key: strip "inv_" prefix for legacy investors (inv_fernando â†’ fernando), keep as-is otherwise
  const depKey = resolvedKey.startsWith("inv_") ? resolvedKey.slice(4) : resolvedKey;
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

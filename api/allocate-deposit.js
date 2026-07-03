import { put } from "@vercel/blob";

const BLOB_BASE = process.env.FUND_DATA_BLOB_URL?.replace("fund-data.json", "") || "";

async function readJson(url) {
  const r = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) return null;
  return r.json();
}

async function writeBlob(name, data) {
  await put(name, JSON.stringify(data), {
    access: "public", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false,
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { depositId, investorKey, newInvestor, nav } = req.body || {};
  if (!depositId) return res.status(400).json({ error: "depositId required" });
  if (!investorKey && !newInvestor) return res.status(400).json({ error: "investorKey or newInvestor required" });

  // Load pending deposits
  const pending = await readJson(`${BLOB_BASE}pending-deposits.json`) || { deposits: [] };
  const deposit = pending.deposits.find(d => d.id === depositId);
  if (!deposit) return res.status(404).json({ error: "Deposit not found in pending list" });

  // Load fund-data
  const fundData = await readJson(`${BLOB_BASE}fund-data.json`);
  if (!fundData) return res.status(502).json({ error: "Could not load fund-data.json" });

  // Load investors
  const investorsData = await readJson(`${BLOB_BASE}investors.json`) || { investors: [] };

  // Handle new investor creation
  let resolvedKey = investorKey;
  if (newInvestor) {
    const key = newInvestor.firstName.toLowerCase() + "_" + newInvestor.lastName.toLowerCase().replace(/\s+/g, "_");
    resolvedKey = key;
    investorsData.investors.push({
      id:        key,
      firstName: newInvestor.firstName,
      lastName:  newInvestor.lastName,
      email:     newInvestor.email || "",
      joinDate:  deposit.date,
    });
    await writeBlob("investors.json", investorsData);
  }

  // Append deposit to fund-data.deposits
  const depositNav = nav || deposit.navAtDeposit || 1.0;
  const record = {
    date:       deposit.date,
    amount:     deposit.amount,
    investor:   resolvedKey,
    nav:        depositNav,
    source:     "ib-detected",
    ibDesc:     deposit.description || "",
  };

  // Allocate units per investor key (fernando / dario / new key)
  if (!fundData.deposits) fundData.deposits = [];
  fundData.deposits.push(record);
  fundData.deposits.sort((a, b) => a.date.localeCompare(b.date));

  // Also bump cashBalance by deposit amount (IB already reflects it, but keep in sync)
  await writeBlob("fund-data.json", fundData);

  // Remove from pending
  pending.deposits = pending.deposits.filter(d => d.id !== depositId);
  await writeBlob("pending-deposits.json", pending);

  return res.status(200).json({ ok: true, record });
}

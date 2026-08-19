// Cloud sync for admin-owned documents — folds sync-data.js and
// sync-investors.js into one file to stay under Vercel's per-deployment
// Serverless Function cap. Route by ?target=fund|investors|ledger.
//
//   POST ?target=fund       { ...fund-data fields }    → overwrite fund-data.json (auto-backs up first)
//   GET  ?target=investors                             → current investors.json
//   GET  ?target=investors&backups=1                   → list investor backups (Neon `snapshots` table)
//   POST ?target=investors  { investors }               → overwrite investors.json (auto-backs up first)
//   POST ?target=investors  { restoreBackupId }          → restore investors.json from a given backup
//   GET  ?target=ledger&view=expenses                   → list manual expense entries
//   GET  ?target=ledger&view=trial-balance[&asOf=]       → account balances as of a date
//   GET  ?target=ledger&view=entries&accountCode=&from=&to=  → journal-line activity for one account
//   POST ?target=ledger  {action:"add-expense", date, category, amount, description, status}
//   POST ?target=ledger  {action:"reverse-entry", entryId, memo}

import { sql, readDoc, backupAndWrite, writeDoc, writeAuditLog, listSnapshots, readSnapshot } from "../lib/store.js";
import { isAdminRequest, identifyActor } from "../lib/auth.js";
import { postExpense, reverseJournalEntry, getTrialBalance, getAccountActivity, listExpenses } from "../lib/ledger.js";

async function handleFund(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!(await isAdminRequest(req))) return res.status(401).json({ error: "Unauthorized" });

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  // backupAndWrite snapshots the current fund-data.json (deposit ledger,
  // positions, transactions) before overwriting — this endpoint replaces the
  // whole document from whatever the client currently holds, so a stale tab
  // or a client-side bug must not be able to destroy history with no
  // rollback trail (every other fund-data.json writer already does this).
  const payload = { ...body, syncedAt: new Date().toISOString() };
  await backupAndWrite("fund-data.json", payload);

  await writeAuditLog({ actor: await identifyActor(req), action: "fund-data.sync" });

  return res.status(200).json({ ok: true, syncedAt: payload.syncedAt });
}

async function handleInvestors(req, res) {
  if (req.method === "GET") {
    // Return investors — PII, so secret required (clients use /api/data)
    if (!(await isAdminRequest(req))) return res.status(401).json({ error: "Unauthorized" });

    if (req.query?.backups) {
      const rows = await listSnapshots("backups", { limit: 100, namePrefix: "investors-" });
      return res.status(200).json({
        backups: rows.map(b => ({ id: b.id, name: b.name, uploadedAt: b.created_at })),
      });
    }

    try {
      const data = await readDoc("investors.json");
      if (!data) return res.status(404).json({ investors: [] });
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === "POST") {
    if (!(await isAdminRequest(req))) return res.status(401).json({ error: "Unauthorized" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    if (body?.restoreBackupId) {
      const snap = await readSnapshot(body.restoreBackupId);
      if (!snap) return res.status(404).json({ error: "Backup not found" });
      const data = snap.data;
      if (!Array.isArray(data?.investors)) return res.status(400).json({ error: "Invalid backup format" });
      await writeDoc("investors.json", data);
      await writeAuditLog({
        actor: await identifyActor(req), action: "investors.restore",
        target: String(body.restoreBackupId), detail: { from: snap.name, count: data.investors.length },
      });
      return res.status(200).json({ ok: true, restored: data.investors.length, from: snap.name });
    }

    if (!Array.isArray(body?.investors)) {
      return res.status(400).json({ error: "Body must be { investors: [...] }" });
    }

    const payload = {
      investors:  body.investors,
      updatedAt:  new Date().toISOString(),
    };

    // backupAndWrite snapshots the current investors doc before overwriting.
    await backupAndWrite("investors.json", payload);

    await writeAuditLog({
      actor: await identifyActor(req), action: "investors.sync",
      detail: { count: body.investors.length },
    });

    return res.status(200).json({ ok: true, count: body.investors.length, updatedAt: payload.updatedAt });
  }

  return res.status(405).end();
}

const EXPENSE_CATEGORIES = new Set(["custodial", "audit", "legal", "admin", "reg", "other"]);

async function handleLedger(req, res) {
  if (!(await isAdminRequest(req))) return res.status(401).json({ error: "Unauthorized" });

  if (req.method === "GET") {
    const view = req.query?.view;
    try {
      if (view === "expenses") {
        const rows = await listExpenses(sql, { from: req.query?.from || null, to: req.query?.to || null });
        return res.status(200).json({ expenses: rows });
      }
      if (view === "trial-balance") {
        const rows = await getTrialBalance(sql, req.query?.asOf ? { asOf: req.query.asOf } : {});
        return res.status(200).json({ accounts: rows });
      }
      if (view === "entries") {
        if (!req.query?.accountCode || !req.query?.from || !req.query?.to) {
          return res.status(400).json({ error: "entries view requires accountCode, from, to" });
        }
        const rows = await getAccountActivity(sql, {
          accountCode: req.query.accountCode, from: req.query.from, to: req.query.to,
        });
        return res.status(200).json({ entries: rows });
      }
      return res.status(400).json({ error: "Unknown or missing ?view= (expected expenses|trial-balance|entries)" });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === "POST") {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const actor = await identifyActor(req);

    if (body?.action === "add-expense") {
      const { date, category, amount, description = null, status = "paid" } = body;
      if (!date || !EXPENSE_CATEGORIES.has(category) || !(Number(amount) > 0)) {
        return res.status(400).json({ error: "Requires date, a valid category, and amount > 0" });
      }
      if (status !== "paid" && status !== "accrued") {
        return res.status(400).json({ error: "status must be 'paid' or 'accrued'" });
      }
      const { entryId, expenseId } = await postExpense(sql, {
        date, category, amountUsd: Number(amount), description, status, actor,
      });
      await writeAuditLog({ actor, action: "ledger.add-expense", target: String(expenseId), detail: { date, category, amount, status } });
      return res.status(200).json({ ok: true, entryId, expenseId });
    }

    if (body?.action === "reverse-entry") {
      const { entryId, memo } = body;
      if (!(Number(entryId) > 0)) return res.status(400).json({ error: "Requires entryId" });
      try {
        const reversalId = await reverseJournalEntry(sql, Number(entryId), { memo, actor });
        await writeAuditLog({ actor, action: "ledger.reverse-entry", target: String(entryId), detail: { reversalId, memo } });
        return res.status(200).json({ ok: true, reversalId });
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }

    return res.status(400).json({ error: "Unknown action (expected add-expense|reverse-entry)" });
  }

  return res.status(405).end();
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-sync-secret, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const target = req.query?.target;
  if (target === "fund") return handleFund(req, res);
  if (target === "investors") return handleInvestors(req, res);
  if (target === "ledger") return handleLedger(req, res);
  return res.status(400).json({ error: "Unknown or missing ?target= (expected fund|investors|ledger)" });
}

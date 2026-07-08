// Authenticated data gateway.
//
//   POST { action: "login", email, password }
//     → verifies credentials server-side (PBKDF2), returns an HMAC session token
//   GET  ?file=<name>   with  Authorization: Bearer <token>
//     → serves whitelisted data files from blob storage (URLs never reach the client)
//   POST { action: "migrate" }  with  x-sync-secret
//     → one-time migration: copies blobs to suffixed names, deletes old public ones
//
// Session tokens: base64url(email|exp) + "." + HMAC-SHA256(SYNC_SECRET, email|exp).
// Tokens expire after 30 days.

import crypto from "node:crypto";
import { put, del, list } from "@vercel/blob";
import { BLOB_BASE, bname, bprefix } from "../lib/store.js";
import { USERS, issueToken, verifyToken } from "../lib/auth.js";

// Files any logged-in investor may read; admin additionally gets pending-deposits
const READABLE       = new Set(["fund-data.json", "investors.json", "nav-history.json", "trades-history.json"]);
const READABLE_ADMIN = new Set([...READABLE, "pending-deposits.json"]);

function hasSyncSecret(req) {
  const s = process.env.SYNC_SECRET;
  if (s && req.headers["x-sync-secret"] === s) return true;
  const c = process.env.CRON_SECRET;
  return !!(c && req.headers["authorization"] === `Bearer ${c}`);
}

// ── Migration: move blobs from legacy public names to suffixed names ─────────
const MIGRATE_FILES = [
  "fund-data.json", "investors.json", "nav-history.json",
  "pending-deposits.json", "trades-history.json", "ib-cache.json",
];

async function migrate() {
  const report = { copied: [], deleted: [], skipped: [], folders: {} };

  // 1. Main files: copy old → suffixed, delete old
  for (const name of MIGRATE_FILES) {
    const newName = bname(name);
    if (newName === name) { report.skipped.push(name); continue; }
    const r = await fetch(`${BLOB_BASE}${name}?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) { report.skipped.push(`${name} (not found)`); continue; }
    const body = await r.text();
    await put(newName, body, { access: "public", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false });
    await del(`${BLOB_BASE}${name}`);
    report.copied.push(name);
    report.deleted.push(name);
  }

  // 2. Folders with guessable timestamped names: move under suffixed prefixes
  for (const prefix of ["backups/", "ib-history/"]) {
    const newPrefix = bprefix(prefix);
    if (newPrefix === prefix) continue;
    let moved = 0;
    const { blobs } = await list({ prefix, limit: 1000 });
    for (const b of blobs) {
      try {
        const r = await fetch(`${b.url}?t=${Date.now()}`, { cache: "no-store" });
        if (!r.ok) continue;
        const body    = await r.text();
        const relPath = b.pathname.slice(prefix.length);
        await put(`${newPrefix}${relPath}`, body, { access: "public", contentType: "application/json", allowOverwrite: true, addRandomSuffix: false });
        await del(b.url);
        moved++;
      } catch {}
    }
    report.folders[prefix] = moved;
  }

  return report;
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "POST") {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    if (body.action === "login") {
      const email = String(body.email || "").trim().toLowerCase();
      const entry = USERS[email];
      if (!entry || !body.password) return res.status(401).json({ error: "Invalid credentials" });
      const hash = crypto.pbkdf2Sync(String(body.password), entry.salt, 100000, 32, "sha256").toString("hex");
      if (hash !== entry.pwHash) return res.status(401).json({ error: "Invalid credentials" });
      return res.status(200).json({ token: issueToken(email), email, name: entry.name, admin: entry.admin });
    }

    if (body.action === "migrate") {
      if (!hasSyncSecret(req)) return res.status(401).json({ error: "Unauthorized" });
      try {
        const report = await migrate();
        return res.status(200).json({ ok: true, report });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    return res.status(400).json({ error: "Unknown action" });
  }

  if (req.method === "GET") {
    const file = String(req.query?.file || "");
    // Admin tooling may also read with the sync secret directly
    const session = hasSyncSecret(req)
      ? { email: "admin", admin: true }
      : verifyToken((req.headers["authorization"] || "").replace(/^Bearer\s+/i, ""));
    if (!session) return res.status(401).json({ error: "Unauthorized" });

    const allowed = session.admin ? READABLE_ADMIN : READABLE;
    if (!allowed.has(file)) return res.status(403).json({ error: "File not allowed" });

    try {
      const r = await fetch(`${BLOB_BASE}${bname(file)}?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return res.status(404).json({ error: "Not found" });
      return res.status(200).json(await r.json());
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

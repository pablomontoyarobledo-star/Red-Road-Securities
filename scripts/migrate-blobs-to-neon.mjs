// One-time migration: copy every dataset out of Vercel Blob and into Neon.
//
// Reads the *current* blob layout (suffixed names when BLOB_SUFFIX is set) and
// writes clean logical names into Postgres. Idempotent: documents upsert, and
// snapshots are matched by (folder, name) so re-running doesn't duplicate them.
//
// Requires two env vars:
//   DATABASE_URL           — Neon connection string (target)
//   BLOB_READ_WRITE_TOKEN  — Vercel Blob token (source; in .env.local)
// Optional:
//   BLOB_SUFFIX            — if the live blobs use the suffixed naming
//
// Run:  node --env-file=.env.local scripts/migrate-blobs-to-neon.mjs
//       (pass DATABASE_URL too, e.g. add it to .env.local or prefix it)

import { list } from "@vercel/blob";
import { ensureSchema, writeDoc, sql } from "../lib/store.js";

const BLOB_BASE = "https://yt6mbeqqdx5ifzj3.public.blob.vercel-storage.com/";
const SFX = process.env.BLOB_SUFFIX || "";

// Logical documents to copy. The suffix only ever applied to the "sensitive"
// set; price-cache/ib-cache handling below covers the rest.
const SENSITIVE = new Set([
  "fund-data.json", "investors.json", "nav-history.json",
  "pending-deposits.json", "trades-history.json", "ib-cache.json",
]);
const DOCUMENTS = [
  "fund-data.json", "investors.json", "nav-history.json",
  "pending-deposits.json", "trades-history.json", "ib-cache.json",
  "price-cache.json",
];

const blobName = (name) =>
  SFX && SENSITIVE.has(name) ? name.replace(/\.json$/, `-${SFX}.json`) : name;

const blobPrefix = (prefix) =>
  SFX ? prefix.replace(/\/$/, `-${SFX}/`) : prefix;

async function fetchJson(url) {
  const r = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) return { ok: false, status: r.status };
  try { return { ok: true, data: await r.json() }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// Copy a snapshot only if (folder, name) isn't already present — keeps re-runs
// from duplicating history.
async function upsertSnapshot(folder, name, data, createdAt) {
  const existing = await sql`select 1 from snapshots where folder = ${folder} and name = ${name} limit 1`;
  if (existing.length) return false;
  if (createdAt) {
    await sql`insert into snapshots (folder, name, data, created_at)
              values (${folder}, ${name}, ${JSON.stringify(data)}::jsonb, ${createdAt})`;
  } else {
    await sql`insert into snapshots (folder, name, data)
              values (${folder}, ${name}, ${JSON.stringify(data)}::jsonb)`;
  }
  return true;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("BLOB_READ_WRITE_TOKEN not set");

  console.log("Ensuring Neon schema…");
  await ensureSchema();

  const report = { documents: {}, snapshots: {} };

  // 1) Whole-JSON documents
  for (const name of DOCUMENTS) {
    const url = BLOB_BASE + blobName(name);
    const res = await fetchJson(url);
    if (!res.ok) { report.documents[name] = `skipped (${res.status || res.error || "not found"})`; continue; }
    await writeDoc(name, res.data);
    report.documents[name] = "copied";
  }

  // 2) Snapshot folders: backups/ and ib-history/
  for (const folder of ["backups", "ib-history"]) {
    const prefix = blobPrefix(`${folder}/`);
    let copied = 0, skipped = 0, cursor;
    do {
      const page = await list({ prefix, limit: 1000, cursor });
      cursor = page.cursor;
      for (const b of page.blobs) {
        const res = await fetchJson(b.url);
        if (!res.ok) { skipped++; continue; }
        // Store under the name relative to the folder, without the suffix.
        const rel = b.pathname.slice(prefix.length);
        const inserted = await upsertSnapshot(folder, rel, res.data, b.uploadedAt);
        inserted ? copied++ : skipped++;
      }
    } while (cursor);
    report.snapshots[folder] = { copied, skipped };
  }

  console.log("\nMigration complete:");
  console.log(JSON.stringify(report, null, 2));

  const [{ count: docCount }] = await sql`select count(*)::int as count from documents`;
  const [{ count: snapCount }] = await sql`select count(*)::int as count from snapshots`;
  console.log(`\nNeon now holds ${docCount} documents and ${snapCount} snapshots.`);
}

main().catch((err) => { console.error("Migration failed:", err); process.exit(1); });

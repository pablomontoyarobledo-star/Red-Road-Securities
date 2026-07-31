// Create the Neon schema (documents + snapshots). Idempotent.
// Run:  node --env-file=.env.local scripts/init-db.mjs
import { ensureSchema, sql } from "../lib/store.js";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  await ensureSchema();
  const [{ count: docs }]  = await sql`select count(*)::int as count from documents`;
  const [{ count: snaps }] = await sql`select count(*)::int as count from snapshots`;
  console.log(`Schema ready. documents=${docs} snapshots=${snaps}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

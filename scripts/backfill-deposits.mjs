// One-time, data-preserving backfill: populate the new `deposits` table
// (see lib/store.js#ensureSchema) from the existing fund-data.json.deposits
// JSON array, WITHOUT modifying or removing anything from that array — it
// remains the system of record every return calculation reads (lib/nav.js's
// pure math is unchanged). This script's only job is to give the historical
// ledger a real, uniquely-constrained row-per-deposit representation so
// future duplicate-insert protection (api/allocate-deposit.js) has
// something to check against, and so the data has a structurally-verifiable
// backup independent of the JSONB blob.
//
// Idempotent by refusal, not by upsert: refuses to run if `deposits` already
// has rows, rather than trying to reconcile a partial prior run — re-running
// after a failure should be preceded by `truncate deposits` if genuinely
// starting over, which is a deliberate, visible action, not something this
// script does silently.
//
// Run:  node --env-file=.env.local scripts/backfill-deposits.mjs
//       node --env-file=.env.local scripts/backfill-deposits.mjs --dry-run
import { readDoc, sql } from "../lib/store.js";
import { investorKeysFor, depositBelongsTo, investorDepositCash } from "../lib/nav.js";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const [existingCount] = await sql`select count(*)::int as n from deposits`;
  if (existingCount.n > 0 && !DRY_RUN) {
    throw new Error(
      `deposits table already has ${existingCount.n} row(s) — refusing to backfill again. ` +
      `If you genuinely need to re-run this, truncate the table first as a deliberate step.`
    );
  }

  const fundData  = await readDoc("fund-data.json");
  const invStore  = await readDoc("investors.json");
  const deposits  = fundData?.deposits || [];
  const investors = invStore?.investors || [];

  if (!deposits.length) { console.log("No deposits in fund-data.json — nothing to backfill."); return; }
  if (!investors.length) throw new Error("investors.json has no investors — aborting, can't resolve deposit ownership.");

  const investorKeyMap = investors.map(inv => ({ inv, keys: investorKeysFor(inv) }));

  const rows = [];
  const unresolved = [];
  const multiMatch = [];

  for (const d of deposits) {
    const matches = investorKeyMap.filter(({ keys }) => depositBelongsTo(d, keys));
    if (matches.length === 0) { unresolved.push(d); continue; }
    if (matches.length > 1 && d.investor) {
      // {investor:"key"} shape names exactly one investor by construction —
      // more than one match here would mean two investors share that exact
      // key, which the resolution logic can't disambiguate.
      multiMatch.push({ deposit: d, matched: matches.map(m => m.inv.id) });
      continue;
    }
    for (const { inv, keys } of matches) {
      const amount = investorDepositCash(d, keys);
      if (!(amount > 0)) continue; // this investor's key wasn't actually present/positive on this record
      const legacyKey = d.investor || Object.keys(d).find(k => keys.has(k) && typeof d[k] === "number" && d[k] > 0);
      rows.push({
        investorId: inv.id,
        date:       d.date,
        amount,
        nav:        d.nav > 0 ? d.nav : 1.0,
        source:     d.source || null,
        ibDesc:     d.ibDesc || null,
        currency:   d.currency || "USD",
        txId:       d.txId || null,
        legacyKey,
      });
    }
  }

  console.log(`Source: ${deposits.length} deposit record(s) in fund-data.json.deposits`);
  console.log(`Resolved to ${rows.length} (investor, deposit) row(s) to insert`);
  if (unresolved.length) {
    console.log(`\n*** ${unresolved.length} deposit record(s) could not be attributed to any known investor: ***`);
    for (const d of unresolved) console.log(`  date=${d.date} keys=${Object.keys(d).join(",")}`);
  }
  if (multiMatch.length) {
    console.log(`\n*** ${multiMatch.length} {investor:"key"} record(s) matched more than one investor: ***`);
    for (const m of multiMatch) console.log(`  date=${m.deposit.date} investor="${m.deposit.investor}" matched=${m.matched.join(",")}`);
  }

  // Reconciliation: total $ backfilled must equal total $ in the source
  // array (summed the same way the app already sums deposits), or this
  // script has a bug and must not be trusted to write anything.
  const sourceTotal   = deposits.reduce((s, d) => {
    if (d.investor) return s + (d.amount || 0);
    const META = new Set(["date","amount","source","nav","investor","ibDesc","currency","description","txId","id"]);
    return s + Object.entries(d).filter(([k, v]) => !META.has(k) && typeof v === "number" && v > 0).reduce((ss, [, v]) => ss + v, 0);
  }, 0);
  const backfillTotal = rows.reduce((s, r) => s + r.amount, 0);
  console.log(`\nSource total across all investors: $${sourceTotal.toFixed(2)}`);
  console.log(`Backfill total across all rows:     $${backfillTotal.toFixed(2)}`);
  const diff = Math.abs(sourceTotal - backfillTotal);
  if (diff > 0.01) {
    throw new Error(`Reconciliation FAILED: $${diff.toFixed(2)} discrepancy between source and backfill — aborting, not writing anything.`);
  }
  console.log(`Reconciliation OK (within $0.01).`);

  if (unresolved.length || multiMatch.length) {
    throw new Error(`Aborting: ${unresolved.length + multiMatch.length} record(s) need manual review before this can run safely (see above). Nothing was written.`);
  }

  if (DRY_RUN) {
    console.log(`\n--dry-run: not writing anything. ${rows.length} row(s) would be inserted.`);
    return;
  }

  let inserted = 0;
  for (const r of rows) {
    const result = await sql`
      insert into deposits (investor_id, date, amount, nav, source, ib_desc, currency, tx_id, source_pending_id, legacy_key)
      values (${r.investorId}, ${r.date}, ${r.amount}, ${r.nav}, ${r.source}, ${r.ibDesc}, ${r.currency}, ${r.txId}, null, ${r.legacyKey})
      returning id
    `;
    if (result.length) inserted++;
  }
  console.log(`\nInserted ${inserted} row(s) into deposits.`);

  const [finalCount] = await sql`select count(*)::int as n, coalesce(sum(amount),0)::float as total from deposits`;
  console.log(`deposits table now has ${finalCount.n} row(s) totaling $${finalCount.total.toFixed(2)}.`);
  if (finalCount.n !== rows.length || Math.abs(finalCount.total - backfillTotal) > 0.01) {
    throw new Error(`Post-write verification FAILED — table state doesn't match what was inserted. Investigate before trusting this table.`);
  }
  console.log(`Post-write verification OK.`);
}

main().catch(err => { console.error("\nBackfill failed:", err.message); process.exit(1); });

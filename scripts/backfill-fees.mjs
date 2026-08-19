// Prints (and optionally posts) every management-fee/bonus unit transfer
// owed so far — the same code path handles the initial backlog (June, July,
// August 2026) and every month going forward (lib/unitTransfer.js's
// checkAndPostMonthlyFees runs automatically on every IB cron pull too).
// This script exists so the very first production posting is manually
// eyeballed against known account values before it ever touches the ledger,
// same posture as scripts/backfill-deposits.mjs.
//
// Run:  node --env-file=.env.local scripts/backfill-fees.mjs --dry-run
//       node --env-file=.env.local scripts/backfill-fees.mjs
import { sql, readDoc, ensureSchema } from "../lib/store.js";
import {
  computeMonthlyFeeSplit, firstOfMonthsThrough, checkAndPostMonthlyFees,
  FEE_EFFECTIVE_FROM, MONTHLY_FEE_USD, BONUS_USD, BONUS_DATE,
} from "../lib/unitTransfer.js";

const DRY_RUN = process.argv.includes("--dry-run");

function printSplit(label, split) {
  console.log(
    `${label}: navPerUnit=${split.navPerUnit.toFixed(8)}  ` +
    `fernandoShare=$${split.fernandoShare.toFixed(2)}  darioShare=$${split.darioShare.toFixed(2)}  ` +
    `(sum=$${(split.fernandoShare + split.darioShare).toFixed(2)})`
  );
}

async function main() {
  await ensureSchema();

  const today = new Date().toISOString().slice(0, 10);
  const months = firstOfMonthsThrough(FEE_EFFECTIVE_FROM, today);

  const fundData = (await readDoc("fund-data.json")) || {};
  const deposits = fundData.deposits || [];
  const navHist  = (await readDoc("nav-history.json")) || {};
  const series   = navHist.series || [];

  const existingRows = await sql`
    select effective_date as date, type, from_investor_id as "from", to_investor_id as "to", units
    from unit_transfers order by effective_date
  `;
  const alreadyPostedMonths = new Set(existingRows.filter(r => r.type === "management_fee").map(r => r.date));
  const bonusAlreadyPosted  = existingRows.some(r => r.type === "bonus" && r.date === BONUS_DATE);

  // Simulate sequential posting (without writing) so month N+1's preview
  // correctly nets in month N's not-yet-posted split — matches what
  // checkAndPostMonthlyFees actually does when it runs for real, one month
  // at a time.
  const simulated = [...existingRows];

  console.log(`Fee effective from ${FEE_EFFECTIVE_FROM}. Checking ${months.length} month(s) through ${today}.\n`);

  for (const month of months) {
    if (alreadyPostedMonths.has(month)) {
      console.log(`${month}: already posted — skipping.`);
      continue;
    }
    const split = computeMonthlyFeeSplit({ deposits, series, unitTransfers: simulated, effectiveDate: month, totalFeeUsd: MONTHLY_FEE_USD });
    if (!split || !split.legs.length) {
      console.log(`${month}: no NAV point available yet for this date — will be retried on a later run.`);
      continue;
    }
    printSplit(month, split);
    for (const leg of split.legs) simulated.push({ date: month, type: "management_fee", from: leg.from, to: leg.to, units: leg.units });
  }

  if (bonusAlreadyPosted) {
    console.log(`\n${BONUS_DATE} bonus: already posted — skipping.`);
  } else if (BONUS_DATE <= today) {
    // Strictly-before BONUS_DATE, matching checkAndPostMonthlyFees's own
    // query — the bonus is priced independently of the same-day management
    // fee, not sequentially after it.
    const priorForBonus = simulated.filter(t => t.date < BONUS_DATE);
    const split = computeMonthlyFeeSplit({ deposits, series, unitTransfers: priorForBonus, effectiveDate: BONUS_DATE, totalFeeUsd: BONUS_USD });
    if (split && split.legs.length) {
      printSplit(`\n${BONUS_DATE} bonus`, split);
    } else {
      console.log(`\n${BONUS_DATE} bonus: no NAV point available yet for this date.`);
    }
  }

  if (DRY_RUN) {
    console.log(`\n--dry-run: nothing written. Re-run without --dry-run to post these for real.`);
    return;
  }

  console.log(`\nPosting for real...`);
  const result = await checkAndPostMonthlyFees(sql, { actor: "backfill-script" });
  console.log(`Posted ${result.posted}, skipped ${result.skipped} (already posted, or no NAV yet).`);
}

main().catch(err => { console.error("Backfill failed:", err.message); process.exit(1); });

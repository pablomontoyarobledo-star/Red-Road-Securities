// One-time credit: Dario and Fernando paid for Pablo's CFA Level 2 exam
// ($1,140.00) on 2026-10-07. Since management fees are paid in kind (see
// lib/unitTransfer.js), the credit is booked the same way, just reversed —
// units move from Pablo to Fernando/Dario (type "other"), netting against
// Pablo's management-fee income and their management-fee expense for the
// amount they fronted. The credit carries forward and offsets their
// management fee starting with the November 1, 2026 fee run.
//
// Split 65% Fernando / 35% Dario, effective 2026-10-07, priced at that
// day's NAV (same "price at the fund's actual NAV that day" convention as
// the monthly fee split and the CFA prep-course credit).
//
// Run:  node --env-file=.env.local scripts/credit-cfa-l2-exam-oct2026.mjs --dry-run
//       node --env-file=.env.local scripts/credit-cfa-l2-exam-oct2026.mjs
import { sql, readDoc, ensureSchema } from "../lib/store.js";
import { postUnitTransferBatch, FERNANDO_ID, DARIO_ID, PABLO_ID } from "../lib/unitTransfer.js";

const DRY_RUN = process.argv.includes("--dry-run");

const EFFECTIVE_DATE = "2026-10-07";
const TOTAL_USD      = 1140.00;
const FERNANDO_PCT   = 0.65;
const MEMO           = "Credit — CFA Level 2 exam fee paid by Fernando/Dario";
const SOURCE_ID      = `credit_cfa_l2_exam_${EFFECTIVE_DATE}`;

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function round8(n) { return Math.round((n + Number.EPSILON) * 1e8) / 1e8; }

function navAtDate(series, dateStr) {
  let nav = null;
  for (const pt of series || []) {
    if (pt.date <= dateStr && pt.nav > 0) nav = pt.nav;
    else if (pt.date > dateStr) break;
  }
  return nav;
}

async function main() {
  await ensureSchema();

  const existing = await sql`
    select 1 from unit_transfers where source_key = ${`other|${EFFECTIVE_DATE}|${PABLO_ID}|${FERNANDO_ID}`}
       or source_key = ${`other|${EFFECTIVE_DATE}|${PABLO_ID}|${DARIO_ID}`}
    limit 1
  `;
  if (existing.length) {
    console.log("Already posted — skipping.");
    return;
  }

  const navHist = (await readDoc("nav-history.json")) || {};
  const nav = navAtDate(navHist.series || [], EFFECTIVE_DATE);
  if (!(nav > 0)) {
    console.log(`No NAV point available at or before ${EFFECTIVE_DATE} yet.`);
    return;
  }

  const fernandoShare = round2(TOTAL_USD * FERNANDO_PCT);
  const darioShare    = round2(TOTAL_USD - fernandoShare); // guarantees exact sum, matches computeMonthlyFeeSplit's convention

  const legs = [
    { from: PABLO_ID, to: FERNANDO_ID, amountUsd: fernandoShare, navPerUnit: nav, units: round8(fernandoShare / nav) },
    { from: PABLO_ID, to: DARIO_ID,    amountUsd: darioShare,    navPerUnit: nav, units: round8(darioShare / nav) },
  ];

  console.log(`Effective ${EFFECTIVE_DATE}, navPerUnit=${nav.toFixed(8)}`);
  console.log(`  Fernando: $${fernandoShare.toFixed(2)} (${legs[0].units} units)`);
  console.log(`  Dario:    $${darioShare.toFixed(2)} (${legs[1].units} units)`);
  console.log(`  Sum: $${(fernandoShare + darioShare).toFixed(2)}`);

  if (DRY_RUN) {
    console.log(`\n--dry-run: nothing written. Re-run without --dry-run to post for real.`);
    return;
  }

  const ok = await postUnitTransferBatch(sql, {
    effectiveDate: EFFECTIVE_DATE, type: "other", legs, memo: MEMO, sourceId: SOURCE_ID, actor: "credit-cfa-l2-exam-script",
    fromAccountCode: "4300", toAccountCode: "5200", // swapped: nets against Pablo's mgmt-fee income / their mgmt-fee expense
  });
  console.log(ok ? "Posted." : "Skipped (duplicate).");
}

main().catch(err => { console.error("Credit post failed:", err.message); process.exit(1); });

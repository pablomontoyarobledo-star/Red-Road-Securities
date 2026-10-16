// One-time correction: the Apr 27, 2026 deposit was mis-split between
// Fernando and Dario. Moves $1,266 from Dario's deposit to Fernando's
// (total $100,000 cash and NAV/units outstanding for the fund are
// unaffected — only each investor's own unit count shifts).
//
// Run:  node --env-file=.env.local scripts/fix-apr27-fernando-dario-split.mjs --dry-run
//       node --env-file=.env.local scripts/fix-apr27-fernando-dario-split.mjs
import { sql, readDoc, backupAndWrite, writeAuditLog, ensureSchema } from "../lib/store.js";

const DRY_RUN = process.argv.includes("--dry-run");
const DATE = "2026-04-27";
const MOVE = 1266;

async function main() {
  await ensureSchema();

  const fundData = await readDoc("fund-data.json");
  if (!fundData) throw new Error("Could not load fund-data.json");

  const fernando = fundData.deposits.find(d => d.date === DATE && d.source === "Fernando Montoya");
  const dario    = fundData.deposits.find(d => d.date === DATE && d.source === "Dario Montoya");
  if (!fernando || !dario) throw new Error("Could not find both deposit records for 2026-04-27");

  console.log("Before:");
  console.log(`  Fernando: $${fernando.amount}`);
  console.log(`  Dario:    $${dario.amount}`);

  const newFernando = fernando.amount + MOVE;
  const newDario     = dario.amount - MOVE;

  console.log("\nAfter:");
  console.log(`  Fernando: $${newFernando}`);
  console.log(`  Dario:    $${newDario}`);
  console.log(`  Sum unchanged: ${fernando.amount + dario.amount} -> ${newFernando + newDario}`);

  if (DRY_RUN) {
    console.log("\n--dry-run: nothing written. Re-run without --dry-run to apply.");
    return;
  }

  fernando.amount = newFernando;
  fernando.fernando = newFernando;
  dario.amount = newDario;
  dario.dario = newDario;

  await backupAndWrite("fund-data.json", fundData);

  await sql`update deposits set amount = ${newFernando} where investor_id = 'inv_fernando' and date = ${DATE}`;
  await sql`update deposits set amount = ${newDario} where investor_id = 'inv_dario' and date = ${DATE}`;

  await writeAuditLog({
    actor: "manual-correction-script",
    action: "deposits.correct_split",
    detail: { date: DATE, move: MOVE, fernando: { before: newFernando - MOVE, after: newFernando }, dario: { before: newDario + MOVE, after: newDario } },
  });

  console.log("\nApplied and wrote audit log.");
}

main().catch(err => { console.error("Correction failed:", err.message); process.exit(1); });

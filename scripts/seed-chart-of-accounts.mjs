// One-time (but idempotent) seed of the general ledger's chart of accounts.
// Safe to re-run — `on conflict (code) do nothing` — so it can be part of a
// normal deploy/setup step alongside init-db.mjs, not a fragile one-shot.
//
// Run:  node --env-file=.env.local scripts/seed-chart-of-accounts.mjs
import { sql, ensureSchema } from "../lib/store.js";

const ACCOUNTS = [
  { code: "1000", name: "Cash & Equivalents",        type: "asset",     normalSide: "debit"  },
  { code: "1100", name: "Investments at Cost",        type: "asset",     normalSide: "debit"  },
  { code: "2100", name: "Accrued Expenses Payable",   type: "liability", normalSide: "credit" },
  { code: "3000", name: "Members' Equity",            type: "equity",    normalSide: "credit" },
  { code: "4000", name: "Dividend Income",            type: "income",    normalSide: "credit" },
  { code: "4100", name: "Interest Income",            type: "income",    normalSide: "credit" },
  { code: "4300", name: "Management Fee Income",      type: "income",    normalSide: "credit" },
  { code: "5100", name: "Broker Fees Expense",        type: "expense",   normalSide: "debit"  },
  { code: "5200", name: "Management Fee Expense",     type: "expense",   normalSide: "debit"  },
  { code: "5300", name: "Custodial Fees Expense",     type: "expense",   normalSide: "debit"  },
  { code: "5400", name: "Audit Fees Expense",         type: "expense",   normalSide: "debit"  },
  { code: "5500", name: "Legal Fees Expense",         type: "expense",   normalSide: "debit"  },
  { code: "5600", name: "Other Operating Expenses",   type: "expense",   normalSide: "debit"  },
];

async function main() {
  await ensureSchema();
  let inserted = 0;
  for (const a of ACCOUNTS) {
    const rows = await sql`
      insert into gl_accounts (code, name, type, normal_side)
      values (${a.code}, ${a.name}, ${a.type}, ${a.normalSide})
      on conflict (code) do nothing
      returning code
    `;
    if (rows.length) inserted++;
  }
  const [{ count }] = await sql`select count(*)::int as count from gl_accounts`;
  console.log(`Seeded ${inserted} new account(s). gl_accounts now has ${count} row(s) total.`);
}

main().catch(err => { console.error("Seed failed:", err.message); process.exit(1); });

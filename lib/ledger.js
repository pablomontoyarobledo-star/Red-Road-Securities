// Double-entry general ledger — the accounting system of record.
//
// journal_entries/journal_lines are append-only: a posted entry is never
// UPDATEd or DELETEd, only reversed via a new correcting entry
// (reverseJournalEntry). Idempotency is enforced by the DB itself — a
// unique index on (source_type, source_id) — so callers (the IB cron, a
// manual re-import) can post the same event as many times as they like and
// only the first attempt actually lands.
//
// Pure math (assertBalanced, flipLines) is kept DB-free and exported
// separately so it's directly unit-testable — see test/ledger.test.mjs.

export class LedgerImbalanceError extends Error {}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// Throws unless every line has exactly one of debit/credit set and the
// entry balances to the cent. Never touches the DB.
export function assertBalanced(lines) {
  if (!lines?.length) throw new LedgerImbalanceError("Journal entry has no lines");
  for (const l of lines) {
    const debit = l.debit || 0, credit = l.credit || 0;
    if ((debit > 0) === (credit > 0)) {
      throw new LedgerImbalanceError(
        `Line for ${l.accountCode} must have exactly one of debit/credit set (got debit=${debit}, credit=${credit})`
      );
    }
  }
  const totalDebit  = round2(lines.reduce((s, l) => s + (l.debit  || 0), 0));
  const totalCredit = round2(lines.reduce((s, l) => s + (l.credit || 0), 0));
  if (totalDebit !== totalCredit) {
    throw new LedgerImbalanceError(`Unbalanced journal entry: debits ${totalDebit} !== credits ${totalCredit}`);
  }
}

// Swap debit/credit on each line — the mechanics of a reversing entry.
// Pure, so the "does a reversal actually invert the entry" invariant is
// testable without a database.
export function flipLines(lines) {
  return lines.map(l => ({ ...l, debit: l.credit || 0, credit: l.debit || 0 }));
}

// Insert one balanced journal entry + its lines as a single atomic
// statement (CTE chain, mirroring allocateDepositAtomic in lib/store.js).
// On a (source_type, source_id) conflict, returns {posted:false} instead of
// throwing — callers must treat that as an expected, silent skip.
export async function postJournalEntry(sql, { date, memo, sourceType, sourceId = null, reversesEntryId = null, actor, lines }) {
  assertBalanced(lines);

  const accountCodes = lines.map(l => l.accountCode);
  const investorIds  = lines.map(l => l.investorId ?? null);
  const debits       = lines.map(l => l.debit  || 0);
  const credits      = lines.map(l => l.credit || 0);
  const descriptions = lines.map(l => l.description ?? null);

  const rows = await sql`
    with ins_entry as (
      insert into journal_entries (entry_date, memo, source_type, source_id, reverses_entry_id, created_by)
      values (${date}, ${memo}, ${sourceType}, ${sourceId}, ${reversesEntryId}, ${actor})
      on conflict (source_type, source_id) where source_id is not null do nothing
      returning id
    ),
    ins_lines as (
      insert into journal_lines (entry_id, account_code, investor_id, debit, credit, description)
      select (select id from ins_entry), t.account_code, t.investor_id, t.debit, t.credit, t.description
      from unnest(
        ${accountCodes}::text[], ${investorIds}::text[], ${debits}::numeric[],
        ${credits}::numeric[], ${descriptions}::text[]
      ) as t(account_code, investor_id, debit, credit, description)
      where exists (select 1 from ins_entry)
      returning entry_id
    )
    select (select id from ins_entry) as entry_id
  `;
  const entryId = rows.length ? rows[0].entry_id : null;
  if (entryId == null) return { posted: false, reason: "duplicate" };
  return { posted: true, entryId };
}

// Insert a new correcting entry whose lines are the original's, flipped.
// Never mutates the original entry — corrections are always new rows.
export async function reverseJournalEntry(sql, entryId, { memo, actor }) {
  const original = await sql`select id from journal_entries where id = ${entryId}`;
  if (!original.length) throw new Error(`Journal entry ${entryId} not found`);

  const rawLines = await sql`
    select account_code, investor_id, debit, credit, description
    from journal_lines where entry_id = ${entryId}
  `;
  if (!rawLines.length) throw new Error(`Journal entry ${entryId} has no lines`);

  const lines = flipLines(rawLines.map(l => ({
    accountCode: l.account_code,
    investorId:  l.investor_id,
    debit:       Number(l.debit),
    credit:      Number(l.credit),
    description: l.description,
  })));

  const today = new Date().toISOString().slice(0, 10);
  const result = await postJournalEntry(sql, {
    date: today,
    memo: memo || `Reversal of entry #${entryId}`,
    sourceType: "correction",
    sourceId: null,
    reversesEntryId: entryId,
    actor,
    lines,
  });
  return result.entryId;
}

// ── Manual expenses ──────────────────────────────────────────────────────

export const EXPENSE_CATEGORY_ACCOUNTS = {
  custodial: "5300",
  audit:     "5400",
  legal:     "5500",
  admin:     "5600",
  reg:       "5600",
  other:     "5600",
};

// Insert the expense_entries row + its journal entry atomically. `status`
// determines the credit side: "paid" hits Cash directly, "accrued" books a
// liability instead (feeds the Balance Sheet's accrued-expense lines).
export async function postExpense(sql, { date, category, amountUsd, description = null, status = "paid", actor }) {
  const expenseAccount = EXPENSE_CATEGORY_ACCOUNTS[category] || "5600";
  const creditAccount  = status === "accrued" ? "2100" : "1000";
  const memo = description ? `Expense: ${description}` : `Expense (${category})`;

  const rows = await sql`
    with ins_entry as (
      insert into journal_entries (entry_date, memo, source_type, source_id, created_by)
      values (${date}, ${memo}, 'manual_expense', null, ${actor})
      returning id
    ),
    ins_lines as (
      insert into journal_lines (entry_id, account_code, investor_id, debit, credit, description)
      select id, ${expenseAccount}, null, ${amountUsd}, 0, ${description} from ins_entry
      union all
      select id, ${creditAccount}, null, 0, ${amountUsd}, ${description} from ins_entry
      returning entry_id
    ),
    ins_expense as (
      insert into expense_entries (entry_date, category, amount_usd, description, status, journal_entry_id, created_by)
      select ${date}, ${category}, ${amountUsd}, ${description}, ${status}, id, ${actor} from ins_entry
      returning id
    )
    select (select id from ins_entry) as entry_id, (select id from ins_expense) as expense_id
  `;
  return { entryId: rows[0].entry_id, expenseId: rows[0].expense_id };
}

// ── IB sync auto-posting ─────────────────────────────────────────────────

function tradeCompositeKey(t) {
  return `${t.date}_${t.ticker}_${t.shares}_${t.price}_${t.type}`;
}
function incomeCompositeKey(t) {
  return `${t.date}|${t.type}|${t.ticker || ""}|${t.netAmount}`;
}

// Posts one journal entry per trade/dividend/interest/fee item. Best-effort
// per item — a single malformed record shouldn't block the rest of the
// batch — callers (api/ib-data.js) still wrap the whole call in a
// try/catch as a second line of defense.
export async function postIBSyncToLedger(sql, { trades = [], dividends = [], interest = [], fees = [], actor }) {
  let posted = 0, skipped = 0;

  for (const t of trades) {
    const amount = round2(Math.abs(Number(t.netAmount) || Number(t.shares) * Number(t.price) || 0));
    if (!(amount > 0)) continue;
    const sourceId = t.tradeId || tradeCompositeKey(t);
    const isBuy = t.type === "buy";
    const lines = isBuy
      ? [{ accountCode: "1100", debit: amount, description: `Buy ${t.shares} ${t.ticker}` },
         { accountCode: "1000", credit: amount, description: `Buy ${t.shares} ${t.ticker}` }]
      : [{ accountCode: "1000", debit: amount, description: `Sell ${t.shares} ${t.ticker}` },
         { accountCode: "1100", credit: amount, description: `Sell ${t.shares} ${t.ticker}` }];
    const result = await postJournalEntry(sql, {
      date: t.date, memo: `${isBuy ? "Buy" : "Sell"} ${t.shares} ${t.ticker} @ ${t.price}`,
      sourceType: "ib_trade", sourceId, actor, lines,
    });
    if (result.posted) posted++; else skipped++;
  }

  for (const d of dividends) {
    const amount = round2(Math.abs(Number(d.netAmount) || 0));
    if (!(amount > 0)) continue;
    const sourceId = d.txId || incomeCompositeKey(d);
    const result = await postJournalEntry(sql, {
      date: d.date, memo: `Dividend${d.ticker ? " — " + d.ticker : ""}`,
      sourceType: "ib_dividend", sourceId, actor,
      lines: [
        { accountCode: "1000", debit: amount, description: d.notes },
        { accountCode: "4000", credit: amount, description: d.notes },
      ],
    });
    if (result.posted) posted++; else skipped++;
  }

  for (const i of interest) {
    const amount = round2(Math.abs(Number(i.netAmount) || 0));
    if (!(amount > 0)) continue;
    const sourceId = i.txId || incomeCompositeKey(i);
    const result = await postJournalEntry(sql, {
      date: i.date, memo: "Interest income",
      sourceType: "ib_interest", sourceId, actor,
      lines: [
        { accountCode: "1000", debit: amount, description: i.notes },
        { accountCode: "4100", credit: amount, description: i.notes },
      ],
    });
    if (result.posted) posted++; else skipped++;
  }

  for (const f of fees) {
    const amount = round2(Math.abs(Number(f.netAmount) || 0));
    if (!(amount > 0)) continue;
    const sourceId = f.txId || incomeCompositeKey(f);
    const result = await postJournalEntry(sql, {
      date: f.date, memo: "Broker fee",
      sourceType: "ib_fee", sourceId, actor,
      lines: [
        { accountCode: "5100", debit: amount, description: f.notes },
        { accountCode: "1000", credit: amount, description: f.notes },
      ],
    });
    if (result.posted) posted++; else skipped++;
  }

  return { posted, skipped };
}

// ── Read helpers (trial balance / income statement, used by statements & admin reporting) ──

// Balance of every account as of a date (default: today), signed so a
// positive number always means "more of what this account normally holds"
// (e.g. a positive balance on an expense account means net debits, on an
// income account means net credits).
export async function getTrialBalance(sql, { asOf = new Date().toISOString().slice(0, 10) } = {}) {
  const rows = await sql`
    select a.code, a.name, a.type, a.normal_side,
           coalesce(sum(l.debit), 0)  as total_debit,
           coalesce(sum(l.credit), 0) as total_credit
    from gl_accounts a
    left join (
      select jl.account_code, jl.debit, jl.credit
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      where je.entry_date <= ${asOf}
    ) l on l.account_code = a.code
    group by a.code, a.name, a.type, a.normal_side
    order by a.code
  `;
  return rows.map(r => {
    const debit = Number(r.total_debit), credit = Number(r.total_credit);
    const balance = r.normal_side === "debit" ? debit - credit : credit - debit;
    return { code: r.code, name: r.name, type: r.type, normalSide: r.normal_side, debit, credit, balance };
  });
}

export async function getAccountActivity(sql, { accountCode, from, to }) {
  // Explicit casts: the neon driver otherwise returns Postgres `numeric` as
  // a JS string and `date` as a JS Date object — see listUnitTransfers's
  // comment in lib/unitTransfer.js for why that silently breaks consumers.
  return await sql`
    select je.entry_date::text as date, je.memo, je.source_type, je.source_id,
           jl.debit::float8 as debit, jl.credit::float8 as credit, jl.investor_id, jl.description
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    where jl.account_code = ${accountCode} and je.entry_date >= ${from} and je.entry_date <= ${to}
    order by je.entry_date, je.id
  `;
}

const INCOME_STATEMENT_ACCOUNTS = {
  dividendIncome:    "4000",
  interestIncome:    "4100",
  mgmtFeeIncome:     "4300",
  brokerFeesExpense: "5100",
  mgmtFeeExpense:    "5200",
  custodialExpense:  "5300",
  auditExpense:      "5400",
  legalExpense:      "5500",
  otherExpense:      "5600",
};

// Net income/expense activity for a period, keyed the way the PDF
// generators need it directly. Income accounts report net credits as-is
// (positive = income); expense accounts report net debits as a positive
// magnitude (positive = expense), even though internally they're the same
// "net credit" computation with expenses negated.
export async function getIncomeStatementTotals(sql, { from, to }) {
  const codes = Object.values(INCOME_STATEMENT_ACCOUNTS);
  const rows = await sql`
    select jl.account_code,
           coalesce(sum(jl.credit), 0) - coalesce(sum(jl.debit), 0) as net_credit
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    where je.entry_date >= ${from} and je.entry_date <= ${to}
      and jl.account_code = any(${codes}::text[])
    group by jl.account_code
  `;
  const byCode = Object.fromEntries(rows.map(r => [r.account_code, Number(r.net_credit)]));
  const result = {};
  for (const [key, code] of Object.entries(INCOME_STATEMENT_ACCOUNTS)) {
    const netCredit = byCode[code] || 0;
    result[key] = code.startsWith("4") ? netCredit : -netCredit;
  }
  return result;
}

// Explicit casts (see listUnitTransfers's comment in lib/unitTransfer.js):
// the neon driver returns `numeric`/`date` columns as JS strings/Date
// objects unless told otherwise, which silently breaks both client-side
// arithmetic (amount) and the "YYYY-MM-DD" string comparisons this
// codebase's date filtering relies on everywhere.
export async function listExpenses(sql, { from = null, to = null } = {}) {
  if (from && to) {
    return await sql`
      select entry_date::text as date, category, amount_usd::float8 as amount, description, status, id
      from expense_entries where entry_date >= ${from} and entry_date <= ${to}
      order by entry_date, id
    `;
  }
  return await sql`
    select entry_date::text as date, category, amount_usd::float8 as amount, description, status, id
    from expense_entries order by entry_date, id
  `;
}

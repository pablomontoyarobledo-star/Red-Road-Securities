// Management fee / bonus unit-transfer engine.
//
// Starting 2026-06-01, Pablo charges Dario and Fernando a $400/month
// management fee, paid IN KIND — Fernando's and Dario's units are reduced
// and Pablo's are credited by the equivalent dollar amount, priced at that
// day's fund NAV/unit, rather than any cash changing hands. A one-time
// $1,000 bonus was paid the same way on 2026-06-01. This is a bespoke,
// fixed arrangement between five specific people (not a generic fee engine),
// so the investor ids below are hardcoded on purpose.
//
// Split: Fernando pays 400 × (Fernando's value / (fund value − Pablo's
// value)). The entire Dario+Juana+Lucia "family bucket" is paid from Dario's
// account alone — Juana's and Lucia's own unit balances are untouched.

import { readDoc } from "./store.js";
import { computeInvestorUnitsAtDateWithTransfers } from "./nav.js";

export const FERNANDO_ID = "inv_fernando";
export const DARIO_ID    = "inv_dario";
export const JUANA_ID    = "juana_robledo";
export const LUCIA_ID    = "lucia_montoya";
export const PABLO_ID    = "pablo_montoya";

export const MONTHLY_FEE_USD     = 400;
export const BONUS_USD           = 1000;
export const FEE_EFFECTIVE_FROM  = "2026-06-01"; // first month the management fee applies
export const BONUS_DATE          = "2026-06-01"; // one-time bonus, same date

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function round8(n) { return Math.round((n + Number.EPSILON) * 1e8) / 1e8; }

// Last nav-history point at or before dateStr.
function navAtDate(series, dateStr) {
  let nav = null;
  for (const pt of series || []) {
    if (pt.date <= dateStr && pt.nav > 0) nav = pt.nav;
    else if (pt.date > dateStr) break;
  }
  return nav;
}

function investorValue(deposits, unitTransfers, id, dateStr, nav) {
  return computeInvestorUnitsAtDateWithTransfers(deposits, unitTransfers, { id }, dateStr) * nav;
}

// Pure — computes the Fernando/Dario split of a flat fee amount as of
// `effectiveDate`, priced at the fund's actual NAV that day. `unitTransfers`
// must be every transfer already posted STRICTLY BEFORE effectiveDate (not
// including it) — without netting those in, a later month's split would be
// computed against the payer's pre-fee ownership, silently overstating
// their share every month after the first.
//
// Returns null when there isn't yet a NAV point to price off (caller should
// skip and retry on a later run) or when the non-Pablo pool is empty/negative
// (degenerate — can't compute a share of nothing).
export function computeMonthlyFeeSplit({ deposits, series, unitTransfers, effectiveDate, totalFeeUsd }) {
  const nav = navAtDate(series, effectiveDate);
  if (!(nav > 0)) return null;

  const pabloValue    = investorValue(deposits, unitTransfers, PABLO_ID, effectiveDate, nav);
  const fernandoValue = investorValue(deposits, unitTransfers, FERNANDO_ID, effectiveDate, nav);
  const darioValue    = investorValue(deposits, unitTransfers, DARIO_ID, effectiveDate, nav);
  const juanaValue    = investorValue(deposits, unitTransfers, JUANA_ID, effectiveDate, nav);
  const luciaValue    = investorValue(deposits, unitTransfers, LUCIA_ID, effectiveDate, nav);

  const fundValue = pabloValue + fernandoValue + darioValue + juanaValue + luciaValue;
  const poolValue = fundValue - pabloValue;
  if (!(poolValue > 0)) return null;

  const fernandoShare = round2(totalFeeUsd * fernandoValue / poolValue);
  // Subtraction (not a separate formula) guarantees the two shares always
  // sum to exactly totalFeeUsd, with zero rounding drift — Dario absorbs the
  // Dario+Juana+Lucia bucket's amount in full.
  const darioShare = round2(totalFeeUsd - fernandoShare);

  const legs = [];
  if (fernandoShare > 0) {
    legs.push({ from: FERNANDO_ID, to: PABLO_ID, amountUsd: fernandoShare, navPerUnit: nav, units: round8(fernandoShare / nav) });
  }
  if (darioShare > 0) {
    legs.push({ from: DARIO_ID, to: PABLO_ID, amountUsd: darioShare, navPerUnit: nav, units: round8(darioShare / nav) });
  }
  return { navPerUnit: nav, fundValue, poolValue, fernandoValue, darioValue, fernandoShare, darioShare, legs };
}

// Every "1st of month" from startDateStr through the most recent one that
// is <= todayStr (inclusive) — the same code path serves both "catch up on
// everything owed so far" (first run after this ships) and "post this
// month's fee" (every run after).
export function firstOfMonthsThrough(startDateStr, todayStr) {
  const months = [];
  let [y, m] = startDateStr.split("-").map(Number);
  for (;;) {
    const dateStr = `${y}-${String(m).padStart(2, "0")}-01`;
    if (dateStr > todayStr) break;
    months.push(dateStr);
    m++; if (m > 12) { m = 1; y++; }
  }
  return months;
}

// Atomically inserts one journal entry (covering every leg) + its lines +
// the corresponding unit_transfers rows, as a single CTE chain — mirrors
// lib/ledger.js's postJournalEntry/postExpense pattern. `sourceId` gives
// the whole month/event entry-level idempotency; each leg's `source_key`
// (type|effectiveDate|fromInvestorId) additionally gives per-leg idempotency
// at the unit_transfers table itself — two independent guards against a
// duplicate post.
async function postUnitTransferBatch(sql, { effectiveDate, type, legs, memo, sourceId, actor }) {
  if (!legs.length) return false;

  const accountCodes = [];
  const investorIds  = [];
  const debits       = [];
  const credits      = [];
  const lineDescs    = [];
  for (const l of legs) {
    accountCodes.push("5200", "4300"); // Management Fee Expense (payer) / Management Fee Income (payee)
    investorIds.push(l.from, l.to);
    debits.push(l.amountUsd, 0);
    credits.push(0, l.amountUsd);
    lineDescs.push(`${memo} — payer`, `${memo} — payee`);
  }

  const xferDates   = legs.map(() => effectiveDate);
  const xferTypes   = legs.map(() => type);
  const xferFrom    = legs.map(l => l.from);
  const xferTo      = legs.map(l => l.to);
  const xferAmounts = legs.map(l => l.amountUsd);
  const xferNavs    = legs.map(l => l.navPerUnit);
  const xferUnits   = legs.map(l => l.units);
  const xferKeys    = legs.map(l => `${type}|${effectiveDate}|${l.from}`);
  const sourceType  = type === "bonus" ? "unit_transfer_bonus" : "unit_transfer_fee";

  const rows = await sql`
    with ins_entry as (
      insert into journal_entries (entry_date, memo, source_type, source_id, created_by)
      values (${effectiveDate}, ${memo}, ${sourceType}, ${sourceId}, ${actor})
      on conflict (source_type, source_id) where source_id is not null do nothing
      returning id
    ),
    ins_lines as (
      insert into journal_lines (entry_id, account_code, investor_id, debit, credit, description)
      select (select id from ins_entry), t.account_code, t.investor_id, t.debit, t.credit, t.description
      from unnest(
        ${accountCodes}::text[], ${investorIds}::text[], ${debits}::numeric[],
        ${credits}::numeric[], ${lineDescs}::text[]
      ) as t(account_code, investor_id, debit, credit, description)
      where exists (select 1 from ins_entry)
      returning entry_id
    ),
    ins_transfers as (
      insert into unit_transfers (
        effective_date, type, from_investor_id, to_investor_id,
        amount_usd, nav_per_unit, units, description, journal_entry_id, source_key
      )
      select t.effective_date, t.type, t.from_investor_id, t.to_investor_id,
             t.amount_usd, t.nav_per_unit, t.units, ${memo}, (select id from ins_entry), t.source_key
      from unnest(
        ${xferDates}::date[], ${xferTypes}::text[], ${xferFrom}::text[], ${xferTo}::text[],
        ${xferAmounts}::numeric[], ${xferNavs}::numeric[], ${xferUnits}::numeric[], ${xferKeys}::text[]
      ) as t(effective_date, type, from_investor_id, to_investor_id, amount_usd, nav_per_unit, units, source_key)
      where exists (select 1 from ins_entry)
      returning id
    )
    select (select id from ins_entry) as entry_id
  `;
  return rows.length && rows[0].entry_id != null;
}

// All unit transfers ever posted, in the canonical JS shape used by
// lib/nav.js's transfer-aware helpers and by the client
// ({date, type, from, to, amountUsd, navPerUnit, units, description}).
export async function listUnitTransfers(sql) {
  return await sql`
    select effective_date as date, type, from_investor_id as "from", to_investor_id as "to",
           amount_usd as "amountUsd", nav_per_unit as "navPerUnit", units, description
    from unit_transfers order by effective_date, id
  `;
}

// Load deposits + nav series once, then post every unposted month's fee
// (from FEE_EFFECTIVE_FROM through today) and the one-time bonus. Designed
// to be called on every cron run: already-posted months/bonus are silently
// skipped (checked both before computing, as a cheap short-circuit, and by
// the DB's own unique indexes inside postUnitTransferBatch), so this is the
// same code path for "catch up on backlog" and "post this month".
export async function checkAndPostMonthlyFees(sql, { actor }) {
  const today = new Date().toISOString().slice(0, 10);
  const months = firstOfMonthsThrough(FEE_EFFECTIVE_FROM, today);

  const fundData = (await readDoc("fund-data.json")) || {};
  const deposits = fundData.deposits || [];
  const navHist  = (await readDoc("nav-history.json")) || {};
  const series   = navHist.series || [];

  let posted = 0, skipped = 0;

  for (const month of months) {
    const existing = await sql`
      select 1 from unit_transfers where type = 'management_fee' and effective_date = ${month} limit 1
    `;
    if (existing.length) { skipped++; continue; }

    const prior = await sql`
      select effective_date as date, type, from_investor_id as "from", to_investor_id as "to", units
      from unit_transfers where effective_date < ${month}
    `;

    const split = computeMonthlyFeeSplit({ deposits, series, unitTransfers: prior, effectiveDate: month, totalFeeUsd: MONTHLY_FEE_USD });
    if (!split || !split.legs.length) { skipped++; continue; } // no NAV yet for this date — retried next run

    const ok = await postUnitTransferBatch(sql, {
      effectiveDate: month, type: "management_fee", legs: split.legs,
      memo: `Management fee — ${month}`, sourceId: `management_fee_${month}`, actor,
    });
    if (ok) posted++; else skipped++;
  }

  const bonusExisting = await sql`
    select 1 from unit_transfers where type = 'bonus' and effective_date = ${BONUS_DATE} limit 1
  `;
  if (!bonusExisting.length && BONUS_DATE <= today) {
    const prior = await sql`
      select effective_date as date, type, from_investor_id as "from", to_investor_id as "to", units
      from unit_transfers where effective_date < ${BONUS_DATE}
    `;
    const split = computeMonthlyFeeSplit({ deposits, series, unitTransfers: prior, effectiveDate: BONUS_DATE, totalFeeUsd: BONUS_USD });
    if (split && split.legs.length) {
      const ok = await postUnitTransferBatch(sql, {
        effectiveDate: BONUS_DATE, type: "bonus", legs: split.legs,
        memo: `Management bonus — ${BONUS_DATE}`, sourceId: `bonus_${BONUS_DATE}`, actor,
      });
      if (ok) posted++; else skipped++;
    } else skipped++;
  }

  return { posted, skipped };
}

// Neon Postgres data store — replaces the old Vercel Blob JSON files.
//
// The app treats each dataset as a whole JSON document (fund-data, investors,
// nav-history, ...), so we keep that shape: one row per logical document in a
// `documents` table, value stored as JSONB. Timestamped backups and IB pull
// snapshots (previously the backups/ and ib-history/ blob folders) become rows
// in a `snapshots` table.
//
// Because everything lives in Postgres now, there are no public URLs to guess,
// so the old BLOB_SUFFIX / bname() obfuscation is gone — documents are keyed by
// their plain logical name ("fund-data.json", etc.).

import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  // Fail loudly at import time in any serverless function that forgot the env
  // var, rather than throwing a confusing "sql is not a function" later.
  console.warn("[store] DATABASE_URL is not set — Neon queries will fail.");
}

export const sql = neon(process.env.DATABASE_URL || "");

// ── Documents (whole-JSON datasets) ─────────────────────────────────────────

// Read one document by logical name. Returns the parsed object, or null if the
// document doesn't exist yet (same contract as the old readJson()).
export async function readDoc(name) {
  const rows = await sql`select data from documents where name = ${name}`;
  return rows.length ? rows[0].data : null;
}

// Upsert one document. `data` is any JSON-serializable value.
export async function writeDoc(name, data) {
  await sql`
    insert into documents (name, data, updated_at)
    values (${name}, ${JSON.stringify(data)}::jsonb, now())
    on conflict (name) do update
      set data = excluded.data, updated_at = now()
  `;
}

// ── Snapshots (append-only history: backups, ib-history) ────────────────────

// Append a snapshot under a folder ("backups" | "ib-history").
export async function writeSnapshot(folder, name, data) {
  await sql`
    insert into snapshots (folder, name, data)
    values (${folder}, ${name}, ${JSON.stringify(data)}::jsonb)
  `;
}

// Backup-then-write: snapshot the current name into the backups folder, then
// overwrite the live document. Mirrors the old backupAndWrite() so callers that
// mutate critical documents keep a rollback trail. A backup failure never
// blocks the write.
export async function backupAndWrite(name, data) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    await writeSnapshot("backups", `${name.replace(/\.json$/, "")}-${stamp}.json`, data);
  } catch {}
  await writeDoc(name, data);
}

// ── Atomic pending-deposit mutations ────────────────────────────────────────
//
// pending-deposits.json's `deposits` array is mutated from independent code
// paths (an admin allocating one via the UI, and the daily IB cron pull
// detecting/notifying new ones). A read-whole-document, mutate-in-JS,
// write-whole-document round trip races: if two of these overlap, the writer
// that finishes last silently discards whatever the other one changed —
// which is exactly how an already-allocated deposit reappeared as pending.
// These act directly on the current row via a single UPDATE, so they're
// atomic no matter what else touches this document at the same time.

// Remove one pending deposit by id (admin allocated it).
export async function removePendingDeposit(id) {
  const rows = await sql`
    update documents
    set data = jsonb_set(
      data,
      '{deposits}',
      coalesce(
        (select jsonb_agg(elem) from jsonb_array_elements(data->'deposits') elem
         where elem->>'id' is distinct from ${id}),
        '[]'::jsonb
      )
    ),
    updated_at = now()
    where name = 'pending-deposits.json'
    returning data
  `;
  return rows.length ? rows[0].data : null;
}

// Append newly detected deposits (IB cron pull / manual XML import).
export async function appendPendingDeposits(newDeposits) {
  if (!newDeposits.length) return null;
  const rows = await sql`
    update documents
    set data = jsonb_set(
      data,
      '{deposits}',
      coalesce(data->'deposits', '[]'::jsonb) || ${JSON.stringify(newDeposits)}::jsonb
    ),
    updated_at = now()
    where name = 'pending-deposits.json'
    returning data
  `;
  if (rows.length) return rows[0].data;
  // No row yet — create it.
  const fresh = { deposits: newDeposits };
  await writeDoc("pending-deposits.json", fresh);
  return fresh;
}

// Mark specific pending deposits (by id) as notified, after their emails send.
export async function markPendingDepositsNotified(ids) {
  if (!ids.length) return null;
  const rows = await sql`
    update documents
    set data = jsonb_set(
      data,
      '{deposits}',
      (
        select jsonb_agg(
          case when elem->>'id' = any(${ids}::text[])
               then elem || '{"notified": true}'::jsonb
               else elem end
        )
        from jsonb_array_elements(data->'deposits') elem
      )
    ),
    updated_at = now()
    where name = 'pending-deposits.json'
    returning data
  `;
  return rows.length ? rows[0].data : null;
}

// List snapshots in a folder, newest first. Metadata only (no data payload) —
// use for listing UIs. `namePrefix` optionally filters by name (e.g. "investors-").
export async function listSnapshots(folder, { limit = 500, namePrefix = null } = {}) {
  if (namePrefix) {
    return await sql`
      select id, name, created_at from snapshots
      where folder = ${folder} and name like ${namePrefix + "%"}
      order by created_at desc limit ${limit}
    `;
  }
  return await sql`
    select id, name, created_at from snapshots
    where folder = ${folder}
    order by created_at desc limit ${limit}
  `;
}

// List snapshots in a folder including their JSON payloads, newest first.
export async function listSnapshotsWithData(folder, { limit = 500 } = {}) {
  return await sql`
    select id, public_id, name, data, created_at from snapshots
    where folder = ${folder}
    order by created_at desc limit ${limit}
  `;
}

// Fetch a single snapshot by internal id — admin-only call sites (the id is
// a sequential bigint, enumerable, and must never back an unauthenticated
// lookup; use readSnapshotByPublicId for that).
export async function readSnapshot(id) {
  const rows = await sql`select id, name, data, created_at from snapshots where id = ${id}`;
  return rows.length ? rows[0] : null;
}

// Fetch a single snapshot by its random, non-sequential public_id — safe to
// use in an unauthenticated single-snapshot read (e.g. an "open in new tab"
// link), since it can't be enumerated the way the internal bigint id can.
export async function readSnapshotByPublicId(publicId) {
  const rows = await sql`select id, name, data, created_at from snapshots where public_id = ${publicId}`;
  return rows.length ? rows[0] : null;
}

// ── User credential overrides ───────────────────────────────────────────────
//
// Passwords are otherwise hardcoded (hashed) in lib/auth.js#USERS, since
// there's no self-service signup. A password change can't rewrite source, so
// a changed credential lives here instead and takes priority over the
// hardcoded entry at login time. Also where a password gets upgraded off the
// original PBKDF2 hash onto scrypt (see lib/auth.js) the moment it's changed.
export async function getUserCredentialOverride(email) {
  const rows = await sql`select salt, pw_hash, algo from user_credentials where email = ${email}`;
  return rows.length ? { salt: rows[0].salt, pwHash: rows[0].pw_hash, algo: rows[0].algo } : null;
}

export async function setUserCredential(email, { salt, pwHash, algo }) {
  await sql`
    insert into user_credentials (email, salt, pw_hash, algo, updated_at)
    values (${email}, ${salt}, ${pwHash}, ${algo}, now())
    on conflict (email) do update
      set salt = excluded.salt, pw_hash = excluded.pw_hash, algo = excluded.algo, updated_at = now()
  `;
}

// ── Login rate limiting ─────────────────────────────────────────────────────
//
// POST /api/data {action:"login"} had no throttling at all — a script could
// brute-force any of the (few, known) account passwords with unlimited
// attempts. Track failures per email; once a threshold is hit, further
// attempts are rejected for a lockout window regardless of whether the
// password submitted is actually correct.
export async function recordLoginFailure(email) {
  const rows = await sql`
    insert into login_attempts (email, fail_count, updated_at)
    values (${email}, 1, now())
    on conflict (email) do update
      set fail_count = login_attempts.fail_count + 1, updated_at = now()
    returning fail_count
  `;
  return rows[0]?.fail_count ?? 1;
}

export async function resetLoginFailures(email) {
  await sql`delete from login_attempts where email = ${email}`;
}

export async function getLoginFailureState(email) {
  const rows = await sql`select fail_count, updated_at from login_attempts where email = ${email}`;
  return rows.length ? { failCount: rows[0].fail_count, updatedAt: rows[0].updated_at } : null;
}

// ── Investor self-service accounts ──────────────────────────────────────────
//
// lib/auth.js#USERS is a hardcoded, admin-provisioned allowlist — there's no
// row here for most investors. When an investor claims their account (see
// api/investor-claim.js) this table becomes the second source of "known
// users" lib/auth.js#lookupUser checks, so login works for anyone who has
// claimed, not just the 3 people baked into source.
export async function createInvestorAccount({ email, investorId, name }) {
  await sql`
    insert into investor_accounts (email, investor_id, name)
    values (${email}, ${investorId}, ${name})
    on conflict (email) do update
      set investor_id = excluded.investor_id, name = excluded.name
  `;
}

export async function getInvestorAccountByEmail(email) {
  const rows = await sql`select email, investor_id, name, claimed_at from investor_accounts where email = ${email}`;
  return rows.length ? { email: rows[0].email, investorId: rows[0].investor_id, name: rows[0].name, claimedAt: rows[0].claimed_at } : null;
}

export async function getInvestorAccountByInvestorId(investorId) {
  const rows = await sql`select email, investor_id, name, claimed_at from investor_accounts where investor_id = ${investorId}`;
  return rows.length ? { email: rows[0].email, investorId: rows[0].investor_id, name: rows[0].name, claimedAt: rows[0].claimed_at } : null;
}

export async function listClaimedInvestorIds() {
  const rows = await sql`select investor_id from investor_accounts`;
  return rows.map(r => r.investor_id);
}

// ── Claim tokens ─────────────────────────────────────────────────────────────
//
// A signed, expiring, single-use token an investor gets in the "set up your
// account" email — see lib/auth.js#issueClaimToken/verifyClaimToken. The
// signature alone proves the token wasn't forged, but not that it hasn't
// already been used or superseded by a resend; this table is the source of
// truth for that, keyed on the random `jti` embedded in the signed payload.
export async function insertClaimToken({ jti, investorId, email, expiresAt }) {
  await sql`
    insert into claim_tokens (jti, investor_id, email, expires_at)
    values (${jti}, ${investorId}, ${email}, ${expiresAt})
  `;
}

export async function getClaimToken(jti) {
  const rows = await sql`select jti, investor_id, email, expires_at, used_at from claim_tokens where jti = ${jti}`;
  return rows.length ? { jti: rows[0].jti, investorId: rows[0].investor_id, email: rows[0].email, expiresAt: rows[0].expires_at, usedAt: rows[0].used_at } : null;
}

// Atomic single-use gate: returns the row only if this call is the one that
// transitioned it from unused to used, so a concurrent double-submit of the
// same link can't both succeed.
export async function markClaimTokenUsed(jti) {
  const rows = await sql`
    update claim_tokens set used_at = now()
    where jti = ${jti} and used_at is null
    returning jti
  `;
  return rows.length > 0;
}

// Invalidate any outstanding (unused) tokens for an investor — called before
// issuing a fresh one (first invite or resend), so an old email link can't
// be used after a newer one was sent.
export async function invalidateOutstandingClaimTokens(investorId) {
  await sql`
    update claim_tokens set used_at = now()
    where investor_id = ${investorId} and used_at is null
  `;
}

// ── Session revocation ──────────────────────────────────────────────────────
//
// Session tokens are stateless HMAC signatures with no server-side session
// store, so a leaked token stays valid for its full 30-day TTL with no way to
// invalidate it early. This table adds one row per email holding the cutoff
// (ms epoch): any token whose `iat` predates it is rejected in verifyToken(),
// regardless of its signature/expiry. Call revokeSessionsNow() on password
// change or any other "log out everywhere" action.
export async function getRevokedBefore(email) {
  const rows = await sql`select revoked_before from session_revocations where email = ${email}`;
  return rows.length ? Number(rows[0].revoked_before) : null;
}

export async function revokeSessionsNow(email) {
  const now = Date.now();
  await sql`
    insert into session_revocations (email, revoked_before)
    values (${email}, ${now})
    on conflict (email) do update set revoked_before = ${now}
  `;
  return now;
}

// ── Audit log (actor-attributed record of mutating admin actions) ──────────
//
// Snapshots (above) capture *what a document looked like*; this captures
// *who did what and when* — the piece SEC 17a-4-style recordkeeping actually
// asks for. Every mutating endpoint should call this after (or alongside)
// its write. Best-effort: a logging failure must never block the underlying
// mutation, so failures are caught and reported to stderr, not thrown.
export async function writeAuditLog({ actor, action, target = null, detail = null }) {
  try {
    await sql`
      insert into audit_log (actor, action, target, detail)
      values (${actor || "unknown"}, ${action}, ${target}, ${detail != null ? JSON.stringify(detail) : null}::jsonb)
    `;
  } catch (err) {
    console.error("[audit] failed to write audit log entry:", err.message);
  }
}

// List audit log entries, newest first. For an admin-facing review UI.
export async function listAuditLog({ limit = 200, action = null } = {}) {
  if (action) {
    return await sql`
      select id, actor, action, target, detail, created_at from audit_log
      where action = ${action} order by created_at desc limit ${limit}
    `;
  }
  return await sql`
    select id, actor, action, target, detail, created_at from audit_log
    order by created_at desc limit ${limit}
  `;
}

// ── Schema bootstrap (run once, from scripts) ───────────────────────────────

export async function ensureSchema() {
  // gen_random_uuid() is built into Postgres core since v13; pgcrypto is the
  // fallback for older instances. Best-effort — Neon databases are recent
  // enough not to need it, but this keeps the migration self-contained.
  try { await sql`create extension if not exists pgcrypto`; } catch {}
  await sql`
    create table if not exists documents (
      name       text primary key,
      data       jsonb not null,
      updated_at timestamptz not null default now()
    )
  `;
  await sql`
    create table if not exists snapshots (
      id         bigint generated always as identity primary key,
      public_id  uuid not null default gen_random_uuid(),
      folder     text not null,
      name       text not null,
      data       jsonb not null,
      created_at timestamptz not null default now()
    )
  `;
  // Existing tables created before public_id existed won't have the column —
  // add it (and its unique index) idempotently rather than requiring a
  // separate migration step.
  await sql`alter table snapshots add column if not exists public_id uuid not null default gen_random_uuid()`;
  await sql`
    create index if not exists snapshots_folder_created_idx
      on snapshots (folder, created_at desc)
  `;
  await sql`
    create unique index if not exists snapshots_public_id_idx
      on snapshots (public_id)
  `;
  await sql`
    create table if not exists audit_log (
      id         bigint generated always as identity primary key,
      actor      text not null,
      action     text not null,
      target     text,
      detail     jsonb,
      created_at timestamptz not null default now()
    )
  `;
  await sql`
    create index if not exists audit_log_created_idx
      on audit_log (created_at desc)
  `;
  await sql`
    create table if not exists session_revocations (
      email          text primary key,
      revoked_before bigint not null
    )
  `;
  await sql`
    create table if not exists login_attempts (
      email      text primary key,
      fail_count int not null default 0,
      updated_at timestamptz not null default now()
    )
  `;
  await sql`
    create table if not exists user_credentials (
      email      text primary key,
      salt       text not null,
      pw_hash    text not null,
      algo       text not null default 'scrypt',
      updated_at timestamptz not null default now()
    )
  `;
  await sql`
    create table if not exists investor_accounts (
      email       text primary key,
      investor_id text not null,
      name        text not null,
      claimed_at  timestamptz not null default now()
    )
  `;
  await sql`create index if not exists investor_accounts_investor_id_idx on investor_accounts (investor_id)`;
  await sql`
    create table if not exists claim_tokens (
      jti         text primary key,
      investor_id text not null,
      email       text not null,
      created_at  timestamptz not null default now(),
      expires_at  timestamptz not null,
      used_at     timestamptz
    )
  `;
  await sql`create index if not exists claim_tokens_investor_id_idx on claim_tokens (investor_id)`;

  // ── Deposits (structural integrity layer) ─────────────────────────────
  //
  // fund-data.json.deposits (a JSON array inside one JSONB document) remains
  // the system of record every return calculation reads — lib/nav.js's pure
  // math functions are unchanged and still operate on that array. This table
  // exists specifically to make duplicate/lost deposit inserts structurally
  // impossible at the one place a new deposit record is created
  // (api/allocate-deposit.js): every allocation now inserts a row here,
  // keyed by the pending-deposit id it was promoted from, before it's ever
  // pushed into the JSONB array — a concurrent double-allocation of the same
  // pending deposit hits the unique constraint below and aborts instead of
  // silently minting the investor's cash twice. See scripts/backfill-deposits.mjs
  // for the one-time historical backfill.
  await sql`
    create table if not exists deposits (
      id                bigint generated always as identity primary key,
      investor_id       text not null,
      date              date not null,
      amount            numeric(18,2) not null check (amount > 0),
      nav               numeric(18,8) not null default 1.0,
      source            text,
      ib_desc           text,
      currency          text not null default 'USD',
      tx_id             text,
      source_pending_id text,
      legacy_key        text,
      created_at        timestamptz not null default now()
    )
  `;
  // A wire IB already assigned a transactionID to can never be inserted
  // twice under this constraint, regardless of which code path tries.
  await sql`
    create unique index if not exists deposits_tx_id_uidx
      on deposits (tx_id) where tx_id is not null
  `;
  // The real idempotency key for allocate-deposit.js: the pending-deposit
  // record a deposit was promoted from can only ever be allocated once, no
  // matter how many concurrent requests race to allocate it.
  await sql`
    create unique index if not exists deposits_source_pending_id_uidx
      on deposits (source_pending_id) where source_pending_id is not null
  `;
  await sql`create index if not exists deposits_investor_id_idx on deposits (investor_id)`;
  await sql`create index if not exists deposits_date_idx on deposits (date)`;
}

// Insert one deposit row, standalone — used only by the one-time historical
// backfill (scripts/backfill-deposits.mjs), which has no fund-data.json
// write to keep in lockstep with. Live deposit creation goes through
// allocateDepositAtomic() below instead, which needs the stronger guarantee
// this function alone doesn't provide (see its comment).
export async function insertDeposit({
  investorId, date, amount, nav, source = null, ibDesc = null,
  currency = "USD", txId = null, sourcePendingId = null, legacyKey = null,
}) {
  const rows = await sql`
    insert into deposits (investor_id, date, amount, nav, source, ib_desc, currency, tx_id, source_pending_id, legacy_key)
    values (${investorId}, ${date}, ${amount}, ${nav}, ${source}, ${ibDesc}, ${currency}, ${txId}, ${sourcePendingId}, ${legacyKey})
    on conflict (source_pending_id) where source_pending_id is not null do nothing
    returning id
  `;
  return rows.length ? rows[0].id : null;
}

// Atomically (a) insert a deposit row, keyed on the pending-deposit id it's
// being promoted from, and (b) overwrite fund-data.json with the caller's
// already-updated copy — as a single SQL statement (a CTE chain, not
// separate queries), so the two writes either both land or neither does.
//
// This is the actual fix for the "deposits have no structural duplicate
// protection" finding: a naive two-step version (insert into deposits, THEN
// separately write fund-data.json) would leave a real gap — if the document
// write failed after the deposits-table insert already succeeded, the
// pending deposit could never be retried (the unique constraint would
// reject the retry as "already allocated") while the investor's cash was
// never actually credited in the ledger every return figure reads. The
// `doc` CTE's `where exists (select 1 from ins)` makes the document write
// happen only when the deposits-table insert actually happened.
//
// Returns the new deposits.id, or null if `sourcePendingId` was already
// used by a concurrent allocation — in which case fund-data.json is left
// completely untouched.
export async function allocateDepositAtomic({
  investorId, date, amount, nav, source = null, ibDesc = null,
  currency = "USD", txId = null, sourcePendingId, legacyKey = null, fundData,
}) {
  const rows = await sql`
    with ins as (
      insert into deposits (investor_id, date, amount, nav, source, ib_desc, currency, tx_id, source_pending_id, legacy_key)
      values (${investorId}, ${date}, ${amount}, ${nav}, ${source}, ${ibDesc}, ${currency}, ${txId}, ${sourcePendingId}, ${legacyKey})
      on conflict (source_pending_id) where source_pending_id is not null do nothing
      returning id
    ),
    doc as (
      insert into documents (name, data, updated_at)
      select 'fund-data.json', ${JSON.stringify(fundData)}::jsonb, now()
      where exists (select 1 from ins)
      on conflict (name) do update
        set data = excluded.data, updated_at = now()
      returning name
    )
    select (select id from ins) as deposit_id
  `;
  return rows.length && rows[0].deposit_id != null ? rows[0].deposit_id : null;
}

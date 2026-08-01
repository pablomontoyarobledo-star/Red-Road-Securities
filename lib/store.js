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
    create table if not exists user_credentials (
      email      text primary key,
      salt       text not null,
      pw_hash    text not null,
      algo       text not null default 'scrypt',
      updated_at timestamptz not null default now()
    )
  `;
}

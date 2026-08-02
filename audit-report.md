# Red Road Securities — Data Treatment & Security Audit

**Scope:** `red-road-securities` repo (23 tracked files) — a single-fund, multi-LP
investor portal (Vercel serverless functions + Neon Postgres + a single-file
vanilla-JS SPA). Audited against the standard a registered fund/RIA would be
held to for customer financial data.

**Audit date:** 2026-07-31
**Method:** Full static review of every file in the repo (`api/*.js`, `lib/*.js`,
`index.html`, `scripts/*.mjs`, `vercel.json`, `package.json`). No infra,
Vercel project settings, Neon instance, or third-party (Resend/IB) console was
accessible — those are flagged as unverified where relevant.

---

## Executive summary

The codebase is small, generally well-organized, and shows real engineering
care around financial-math correctness (NAV/unit accounting is atomic,
self-healing, and well-commented). However, its security posture is that of a
personal/family project, not a fund-grade platform holding customer financial
data. The worst finding is **Critical**: every authenticated investor —
including the two non-admin LPs — receives the full `fund-data.json` document
through `/api/data`, which contains **every other investor's deposit dates,
amounts, and legal name**, and the client renders this as a plain table on a
page every logged-in user can reach. A second **Critical** finding is a
hardcoded, static backdoor token (`rrs-7x2p9q`) in `api/prices.js` that lets
anyone who has ever seen the source mutate financial records (delete
deposits) with no real authentication. There is no audit trail of who changed
what, no MFA, no field-level encryption of PII, and password hashing (PBKDF2,
100k rounds) is adequate but undocumented as a policy. The general shape of
the gap: this app was built to be *functionally* correct and convenient for a
small family fund, not to withstand the recordkeeping, isolation, and
access-control bar of SEC Reg S-P / 17a-4 / GLBA.

---

## Section 1 — Data flow map

### Where investor data enters
- **Admin manual entry** — `page-ownership`/admin panel in `index.html` (investor
  profile fields: name, email, phone, nationality, mailing address) →
  `POST /api/sync-investors` ([sync-investors.js](api/sync-investors.js)).
- **Deposit allocation** — admin allocates a pending wire to an investor →
  `POST /api/allocate-deposit` ([allocate-deposit.js](api/allocate-deposit.js)).
- **Interactive Brokers (custodian) Flex Web Service** — daily cron pulls
  positions, trades, cash transactions, deposits →
  [ib-data.js](api/ib-data.js), [ib-nav-history.js](api/ib-nav-history.js).
- **Manual IB XML paste** — admin pastes Flex XML into the UI →
  `POST /api/import-ib-xml` ([import-ib-xml.js](api/import-ib-xml.js)).
- **Yahoo Finance** (unauthenticated, scraped) — live prices →
  [prices.js](api/prices.js), [spx-history.js](api/spx-history.js).
- **Login** — email/password → `POST /api/data { action: "login" }`
  ([data.js](api/data.js)).

### Where it's stored
- **Neon Postgres** (`lib/store.js`) — two tables:
  - `documents` (one JSONB row per logical file: `fund-data.json`,
    `investors.json`, `nav-history.json`, `pending-deposits.json`,
    `trades-history.json`, `ib-cache.json`, `price-cache.json`).
  - `snapshots` (append-only-in-intent history: `backups/` and `ib-history/`).
- **Browser `localStorage`** — the SPA caches `fund-data.json`/`investors.json`
  contents client-side (`mff_*` keys, [index.html:1851-1876](index.html:1851))
  and the session token (`rrs_session`, [index.html:1931](index.html:1931)).
- **Legacy Vercel Blob** — `scripts/migrate-blobs-to-neon.mjs` shows the prior
  storage layer was **public** Vercel Blob URLs
  (`https://yt6mbeqqdx5ifzj3.public.blob.vercel-storage.com/...`), obfuscated
  only by an optional filename suffix. Whether those blobs were deleted after
  the Neon migration is **unverified — needs manual check**.
- **Resend (email)** — investor names, deposit amounts, and full statement
  HTML pass through Resend's API on every deposit notification and monthly
  statement ([ib-data.js:426](api/ib-data.js:426), [send-statements.js:439](api/send-statements.js:439)).
- **Vercel function logs** — see §10.

### Where it leaves the system
- `GET /api/data?file=...` — the only client-facing read path for fund/NAV/
  investor data, gated by session token.
- `GET /api/ib-pulls?pull=<id>` — **explicitly unauthenticated** single-snapshot
  read (see §1 finding below).
- Outbound to Resend (deposit-notification and statement emails, always to
  `pablomontoyarobledo@gmail.com`, never to the LPs themselves).
- Outbound to Yahoo Finance (ticker symbols only, not investor data).
- Client-side PDF generation (jsPDF, per `CLAUDE_CONTEXT.md`) — statements
  rendered and downloaded in-browser.

### Who/what can read or write each of the above
- **3 hardcoded users** in [lib/auth.js](lib/auth.js:14): 1 admin (Pablo), 2
  non-admin LPs (Dario, Fernando Montoya). No self-service signup, no other
  roles (no "support" or "advisor" role exists).
- **Service secrets**: `SYNC_SECRET` (also doubles as the HMAC key for session
  tokens), `CRON_SECRET`, `IB_FLEX_TOKEN`/`IB_FLEX_QUERY_ID`/`IB_NAV_QUERY_ID`,
  `RESEND_API_KEY`, `DATABASE_URL` — all read from `process.env`, never
  hardcoded (good), stored in `.env*` which is gitignored (good, confirmed via
  [.gitignore](.gitignore)).
- **A hardcoded diagnostic bypass token** `rrs-7x2p9q` in
  [prices.js:30](api/prices.js:30) — see Critical finding below.

---

## 2. Multi-tenant data isolation — **highest priority finding**

This is a single pooled fund (all LPs own units of one vehicle), not
per-investor segregated portfolios, so some shared visibility (aggregate NAV,
positions, fund performance) is inherent to the product. The problem is that
**individual capital-account data is not scoped at all**:

- **[Critical] Every deposit record for every investor is sent to every
  logged-in investor.** `READABLE` in [data.js:19](api/data.js:19) includes
  `fund-data.json` for *any* authenticated user (admin or not).
  `fund-data.json.deposits` contains, per record: `date`, `amount`, `source`
  (full legal name), `nav`, and a per-investor-keyed amount field
  ([allocate-deposit.js:166-179](api/allocate-deposit.js:166)). The client then
  renders this as a plain table — `renderDeposits()` in
  [index.html:3341-3406](index.html:3341) — on the **Ownership** page
  ([index.html:523-559](index.html:523)), which is a normal investor-facing
  page (outside the `#admin-screen` div, which only starts at
  [index.html:850](index.html:850)). Concretely: Dario Montoya, logged in as
  himself, sees Fernando's and Pablo's exact deposit dates, dollar amounts,
  and full names, and vice versa. There is no server-side or client-side
  filter to the requesting investor's own records anywhere in this path.
  This is the single largest gap between current state and what any
  registered fund would consider baseline LP-privacy.
- **[High] No tenant-scoping mechanism exists at all** — not ORM-level, not
  DB row-level security, not middleware. The Neon schema
  ([lib/store.js:174-195](lib/store.js:174)) stores each dataset as one
  whole-document JSONB row (`documents.name`), so there is no `investor_id`
  column to scope by in the first place; scoping would have to happen in
  application code, and currently doesn't for deposits.
- **[Medium] `investors.json` (containing phone, nationality, mailing
  address) is correctly gated to admin-only** — `READABLE_ADMIN` only
  ([data.js:20](api/data.js:20)), and [sync-investors.js:7](api/sync-investors.js:7)
  also requires `isAdminRequest`. This part is done correctly.
- **[Low/Informational] `GET /api/ib-pulls?pull=<id>` is intentionally
  unauthenticated** ([ib-pulls.js:18-22](api/ib-pulls.js:18)) — the code comment
  explains this is because a new browser tab can't carry the admin header, and
  treats the data as "operational" (positions/totals) rather than
  investor-personal. This is a knowing tradeoff, but note: pull IDs are
  sequential Postgres bigints (`id bigint generated always as identity` —
  [lib/store.js:184](lib/store.js:184)), so **every historical IB pull
  (positions, cash, trades) is enumerable by anyone who can guess adjacent
  integers**, with zero authentication. This should at minimum use a
  non-sequential ID (UUID) if it must stay unauthenticated.
- **[Critical] Admin auth can be fully bypassed via a hardcoded backdoor
  token.** [prices.js:30](api/prices.js:30):
  ```js
  if (req.query.diag === "dedupe" && req.query.k === "rrs-7x2p9q") {
  ```
  This branch reads and can **overwrite `fund-data.json` and
  `pending-deposits.json`** (deleting deposit records) with no session token,
  no `SYNC_SECRET`, nothing but a static string that is committed in plain
  text to the repo (see commit `3d7690d "temp: token-gated deposit dedupe on
  prices endpoint"`). Anyone with read access to the source — including this
  audit, a future contributor, or anyone who obtains a repo clone — has
  standing write access to financial records. This bypasses every other
  control in the system and is the most severe finding in the audit.
- Admin role is otherwise **not scoped or logged** — `isAdminRequest()`
  ([lib/auth.js:51](lib/auth.js:51)) is a single boolean; there's no
  per-action audit record of *which* admin action ran when (see §6).

---

## 3. Data classification & handling of sensitive fields

| Field | Where | Encrypted at rest? | In transit? | Logged? | Client-side exposure? |
|---|---|---|---|---|---|
| Password hash + salt | `lib/auth.js` (source) | N/A (PBKDF2 hash, not reversible) | HTTPS (Vercel, assumed) | No | Never shipped to browser (comment confirms, [lib/auth.js:13](lib/auth.js:13)) |
| Deposit amounts + investor name | `fund-data.json.deposits` | No — plain JSONB in Neon | HTTPS | Not intentionally, but see §10 | **Yes — shipped to every logged-in investor** (§1) |
| Phone / nationality / mailing address | `investors.json` | No — plain JSONB | HTTPS | No | Only admin; also hardcoded in-bundle as fallback defaults for the two named LPs (`DEFAULT_INVESTORS`, [index.html:1819-1822](index.html:1819)) — names/emails/nationality ship in the JS bundle itself regardless of login |
| IB account number (`U23388477`) | Hardcoded in statement disclaimer text, [send-statements.js:103](api/send-statements.js:103) | N/A | HTTPS | No | Yes — visible in every statement and in source |
| Session token (HMAC-signed) | `localStorage` | No — plaintext in browser storage | HTTPS | No | By design (client auth token) |
| IB Flex token / query IDs, SYNC/CRON secrets, Resend key, DATABASE_URL | `process.env` only | Managed by Vercel env store (unverified) | N/A | No | Never — correctly server-only |

No SSN/TIN, government ID, or bank routing/account numbers appear to be
collected or stored anywhere in this codebase. If KYC data of that kind is
collected outside this app (e.g., paper forms, a separate onboarding tool),
it is **out of scope of this repo** and should be audited separately.

Nothing sensitive is sent to third-party analytics or LLM APIs — the only
third parties in the data path are Resend (transactional email) and Yahoo
Finance (ticker prices only, no investor data).

---

## 4. Authentication & session security

- **Password hashing: PBKDF2-HMAC-SHA256, 100,000 iterations, 32-byte
  output** ([data.js:40](api/data.js:40)). This is NIST-acceptable and far
  better than an unsalted hash, though bcrypt/scrypt/argon2 are generally
  preferred for password storage today (PBKDF2 is GPU-parallelizable more
  easily than argon2/scrypt at equivalent settings). **Medium**, not High —
  the implementation is not broken, just not best-in-class.
- **No MFA anywhere** — login is single-factor email+password for both the
  admin (who can mutate financial records) and LPs. **High** — there is no
  step-up authentication for any money-adjacent action (deposit allocation,
  investor edits), and combined with the backdoor token in §2, there are
  effectively *two* single points of failure for account-mutating access.
- **Session tokens**: `base64url(email|exp) + "." + HMAC-SHA256(SYNC_SECRET,
  ...)` ([lib/auth.js:26-30](lib/auth.js:26)), 30-day TTL
  ([lib/auth.js:20](lib/auth.js:20)), verified with `crypto.timingSafeEqual`
  (good — avoids timing attacks, [lib/auth.js:38-39](lib/auth.js:38)). But:
  - **No revocation mechanism** — there is no server-side session store, so a
    stolen/leaked token is valid for up to 30 days with no way to invalidate
    it early (no "log out all devices," no token rotation on password change
    — and there is no password-change flow at all, see below). **High.**
  - **No `admin` claim signed into anything checked against a revocation
    list** — fine, since `verifyToken` re-derives `admin` from
    `USERS[email].admin` server-side each time ([lib/auth.js:42](lib/auth.js:42)),
    so a compromised token can't self-escalate. This part is correctly
    designed.
  - Token is stored in `localStorage`, not an `httpOnly` cookie
    ([index.html:1931](index.html:1931)) — readable by any JS running on the
    page, so any future XSS (see §9) becomes full account takeover with a
    30-day-valid token. **Medium-High.**
- **No password reset flow exists in this codebase at all.** There's no
  forgot-password endpoint, token, or email. This means password rotation is
  presumably a manual, out-of-band (developer-mediated) process — which is a
  smaller attack surface than a typical broken reset flow, but also means
  there's no way for an LP to self-service a compromised password. **Low**
  finding as a gap, but worth flagging since it's unusual for a fund-grade app
  not to have *any* reset path.
- No login rate-limiting/lockout visible in `data.js` — a brute-force
  script could hammer `POST /api/data {action:"login"}` with no throttling.
  **Medium** (Vercel may apply platform-level rate limits — unverified).

---

## 5. Authorization & role design

- **Two roles only: `admin` (Pablo) and investor (Dario, Fernando).** No
  "advisor," "support," or "read-only staff" role exists — so there's no
  over-broad role to flag beyond admin itself, which legitimately needs
  broad access to run the fund.
- **Admin's write access is unscoped by design** (single fund, single admin) —
  appropriate for this fund's size, but worth noting for future growth: there
  is no concept of scoping an admin to "actions on investor X only."
  Combined with §2/§6, there is no way to review admin actions after the
  fact.
  **Medium.**
- **No privilege-escalation path found** — `admin` is never accepted from the
  client (`verifyToken` always re-derives it server-side from the hardcoded
  `USERS` map), and there is no endpoint that writes to a user's own role.
  This is correctly designed.

---

## 6. Encryption & key management

- **TLS**: Enforced by Vercel's platform by default for all deployments —
  **unverified from this repo** (no code here can force/deny TLS; there's no
  custom server). Flag as **unverified — infra-level, needs manual check**
  (confirm HTTPS-only + HSTS in the Vercel project's domain settings).
- **At-rest encryption**: Neon Postgres — encryption at rest is a Neon
  platform feature, not something this codebase configures.
  **Unverified — infra-level.**
- **No field-level encryption anywhere.** Every JSONB document
  (`fund-data.json`, `investors.json`, etc.) is stored as plain JSON — an
  attacker with DB read access (or a leaked `DATABASE_URL`) reads everything
  in cleartext, including every investor's PII and full deposit history.
  **High** for a fund-grade bar, though common for apps this size.
- **Secrets management**: All secrets (`SYNC_SECRET`, `CRON_SECRET`,
  `IB_FLEX_TOKEN`, `RESEND_API_KEY`, `DATABASE_URL`) live in
  `process.env`/Vercel env vars, not a dedicated secrets manager (Vault/AWS
  Secrets Manager/KMS). **Medium** — acceptable for this scale, but no
  rotation policy is evident, and `SYNC_SECRET` doing double duty as both an
  API bypass secret *and* the HMAC signing key for session tokens
  ([lib/auth.js:23](lib/auth.js:23)) means a `SYNC_SECRET` leak compromises
  both the bypass path *and* lets an attacker forge session tokens for any
  user (including admin) by computing a valid HMAC. **High** — this key reuse
  should be split into two independent secrets.
- **No secrets hardcoded in source** except the diagnostic bypass token
  covered in §2 (Critical) — password hashes/salts in `lib/auth.js` are
  intentionally there (hashed, not plaintext) as this is how the auth system
  is designed to work without a users table; this is a design tradeoff, not a
  leak, but it does mean **rotating a password requires a code deploy**
  rather than a self-service or admin-panel flow. **Low-Medium.**
- `.env*` is correctly gitignored ([.gitignore](.gitignore)) — confirmed no
  `.env` files are tracked in git.

---

## 7. Audit trail & recordkeeping (SEC 17a-4 analog)

This is a significant gap relative to fund-grade expectations:

- **There is no dedicated audit-log table or mechanism anywhere in the
  codebase.** The closest analog is the `snapshots` table's `backups` folder,
  written via `backupAndWrite()` ([lib/store.js:56-62](lib/store.js:56)),
  which snapshots a document's *entire prior state* before an overwrite. This
  gives you a rollback trail for `fund-data.json` and `investors.json`, but:
  - It does **not** record *who* made the change (no actor/user field
    anywhere in the snapshot row schema — [lib/store.js:183-190](lib/store.js:183)
    has only `folder, name, data, created_at`).
  - It does **not** record *why* or via *which endpoint*.
  - `writeDoc()` itself (used directly by `sync-data.js`, `import-ib-xml.js`
    position/cash updates, etc.) has **no** pre-write snapshot at all in many
    call sites — only the endpoints that explicitly call `backupAndWrite`
    get one.
- **Snapshots are not tamper-evident or provably append-only at the
  application layer** — any code path with DB write access (which is every
  serverless function, since they all import the same `sql` client with full
  read/write on both tables) could `UPDATE` or `DELETE` a snapshot row.
  Postgres-level protections (e.g., a restricted DB role, WORM storage) would
  need to be configured at the Neon/infra level — **unverified**.
- **No retention policy exists in code** — nothing purges or archives old
  snapshots, so by default everything accumulates indefinitely (which is
  *safer* than deleting too early, but "indefinite by accident" is not the
  same as a defined, defensible retention policy).
- **You cannot reconstruct a specific investor's full record from logs alone
  if the primary `documents` table were compromised/corrupted**, because
  admin actions themselves aren't logged with actor/timestamp/action-type —
  only whole-document snapshots exist, and only for some write paths.
- **Severity: High.** For a registered fund, the inability to answer "who
  allocated this deposit, and when, and what did the record look like
  before" from an audit log (rather than by diffing raw JSON blobs) falls
  well short of a 17a-4-style recordkeeping bar.

---

## 8. Third-party data integrations

- **Interactive Brokers Flex Web Service** — `IB_FLEX_TOKEN` and query IDs
  are read from env vars only ([ib-data.js:466-467](api/ib-data.js:466)), never
  logged or returned to the client. There is **one token for the whole fund
  account**, not per-investor — appropriate, since IB access here is
  fund-level (one custodial account), not per-LP.
  - **No revocation-per-investor concept applies** here since there's only
    one custodial connection for the whole fund; not applicable the way it
    would be for a Plaid-style per-user aggregation.
  - **Cache poisoning / trust risk**: `ib-cache.json` is served with a 6-hour
    TTL and falls back to stale cache on any IB fetch error
    ([ib-data.js:496-511](api/ib-data.js:496)) — reasonable resilience, but
    there's no explicit sanity/bounds check on `totalValue` before it's
    trusted and written as the new NAV point (e.g., no "reject if >50% swing
    from yesterday" guard). A garbled/partial IB response with a plausible
    but wrong `totalValue` would silently mint an incorrect NAV for every
    investor. **Medium.**
- **Yahoo Finance** (`prices.js`, `spx-history.js`) — unauthenticated public
  endpoint, scraped with a spoofed browser User-Agent
  ([prices.js:6-12](api/prices.js:6)). This is fragile (Yahoo can break/block
  it any time) but not itself a security risk to investor data since no
  investor data is sent to Yahoo. Note: this is fetching an **unofficial,
  undocumented API** — a market-data glitch or a Yahoo-side format change
  could silently return `0` or `null`, and the code does check `price > 0`
  before trusting it ([prices.js:20](api/prices.js:20)) — good defensive
  check.
- **Resend (email)** — API key from env, never logged. All statement/deposit
  emails are hardcoded to send to `pablomontoyarobledo@gmail.com` only
  ([ib-data.js:431](api/ib-data.js:431), [send-statements.js:444](api/send-statements.js:444))
  — **investors never receive their own statements by email**; this is a
  business-logic/product gap more than a security one, but worth flagging
  since "the fund can produce a statement" and "the LP receives their
  statement" are not the same thing today.

---

## 9. Data integrity for financial figures

- **NAV/unit math is computed server-side, from IB's authoritative
  `totalValue`, and is well-tested-by-construction** — [lib/nav.js](lib/nav.js)
  is shared across the daily cron ([ib-data.js](api/ib-data.js)), the
  NAV-history rebuild ([ib-nav-history.js](api/ib-nav-history.js)), and the
  deposit-repair action ([allocate-deposit.js](api/allocate-deposit.js)),
  specifically to prevent the three code paths from disagreeing (per the
  file's own header comment). This is good engineering practice.
- **No automated test suite exists** — there is no `test/` directory, no
  test runner in `package.json`, and no CI config in the repo. The NAV math
  is genuinely subtle (unit-settlement windows, pre-money pricing, pending-cash
  neutrality) and is currently verified only by manual reasoning in code
  comments, not by unit tests. Given a bug here directly misprices every
  investor's stake, this is a **Medium-High** finding on its own terms (not a
  "security" bug per se, but a data-integrity control gap explicitly in
  scope per the audit brief, dimension 8).
- **Reconciliation**: `repairDeposits()` in
  [allocate-deposit.js:24-83](api/allocate-deposit.js:24) is a genuine, if
  manually-triggered, reconciliation/self-heal pass (fixes malformed dates,
  re-prices deposits, recomputes the NAV series) — this is a positive
  finding. It's invoked by an admin action, not on a schedule.
- **Client input is never trusted for financial figures** — `allocate-deposit.js`
  accepts a client-supplied `nav` override
  ([allocate-deposit.js:102](api/allocate-deposit.js:102)) but only as a
  *fallback* when no prior NAV point exists; the code otherwise recomputes
  the authoritative pre-money NAV server-side
  ([allocate-deposit.js:148-164](api/allocate-deposit.js:148)). This is a
  reasonable design, though an admin (via UI or a raw API call) could still
  force an arbitrary `nav` in the edge case where `priorNav` is unavailable
  — low likelihood, but worth a stricter guard (e.g., reject if
  `priorNav` couldn't be determined rather than silently falling back to
  client input).

---

## 10. Input validation & injection

- **SQL injection: not found.** Every query in `lib/store.js` uses the Neon
  tagged-template `sql\`...\`` parameterization
  ([lib/store.js:28,34,46,77-93,98-114,144-155,159-163,167-169](lib/store.js:28)) —
  no raw string concatenation into SQL anywhere in the codebase. This is the
  correct pattern and is used consistently.
- **File uploads**: none exist. `import-ib-xml.js` accepts raw XML as a JSON
  string field (`{ xml: "..." }`), parsed with `fast-xml-parser`, not written
  to disk or served back — no path traversal or web-servable-upload risk.
  XML external entity (XXE) risk: `fast-xml-parser` does not resolve
  DOCTYPE/external entities by default (no such option enabled here), so XXE
  is not applicable to this parser as configured.
- **SSRF risk**: `prices.js`/`spx-history.js` construct URLs by concatenating
  a **client-supplied ticker** into a Yahoo Finance URL
  ([prices.js:15,81,91](api/prices.js:15)) but the request always targets a
  hardcoded `query1.finance.yahoo.com`/`query2.finance.yahoo.com` host — the
  ticker only affects the path, not the host, so this is not an open SSRF.
  However, there's **no ticker allowlist/format validation**
  (`.toUpperCase()` only, [prices.js:62](api/prices.js:62)) — a malformed
  ticker string could be used to probe Yahoo's endpoint behavior, but cannot
  redirect the request elsewhere. **Low.**
- **Stored/reflected XSS**: Investor-controlled fields (name, mailing
  address, deposit `description`/`ibDesc` sourced from IB, admin-entered
  investor notes) are inserted into HTML via template literals in
  `index.html` (e.g., [index.html:3388](index.html:3388) `${displaySource}`,
  [index.html:2518-2521](index.html:2518) `${inv.phone}`/`${inv.mailingAddress}`)
  and into the **statement email HTML** in
  [send-statements.js:271,362](api/send-statements.js:271) without any HTML
  escaping. All of these fields are currently admin-entered or come from IB
  (a semi-trusted source), not directly from public/unauthenticated input, so
  exploitability today is low — but there is no defense-in-depth escaping,
  so if any of these fields ever become attacker-influenced (e.g., a future
  self-service investor-profile edit, or a maliciously-crafted IB
  transaction description), this becomes a stored XSS that runs in
  authenticated investor sessions and could exfiltrate the `localStorage`
  session token (see §4). **Medium.**

---

## 11. Logging, monitoring & incident response

- **No structured security-event logging** — no code path logs failed
  logins, 401/403 responses, or admin actions to any queryable store. Vercel
  will capture stdout/stderr per invocation
  (`console.warn` in [lib/store.js:18](lib/store.js:18) being the only
  explicit log line in the whole codebase), but there is no log
  aggregation, retention policy, or alerting configured in this repo.
  **Unverified beyond code** — Vercel's own request logs may capture more at
  the platform level; needs manual check.
- **No anomaly detection** — nothing flags a pattern like "one session token
  pulling `fund-data.json` at a high rate" (which, given §2, would actually
  be the *normal* behavior for any of the three legitimate users, since the
  data isn't scoped in the first place).
- **No documented incident-response process** exists in this repo (no
  `SECURITY.md`, no breach playbook). This is expected to live outside a
  codebase, but its absence here is worth flagging since nothing else in the
  org's tooling was available to check.

---

## 12. Data retention & deletion

- **No account-closure / data-deletion flow exists.** There is no endpoint or
  UI path to close an investor's account or purge their data. Given this is
  a 3-person family fund, this may be a non-issue operationally today, but
  there is no *policy* encoded anywhere (in code or docs) for what happens
  to an LP's data if they redeem fully and leave the fund.
- **Backups (`snapshots` table) are covered by the exact same access control
  as production data** — same Postgres connection, same `DATABASE_URL,` no
  separate credential or restricted role for backup access. A compromised
  `DATABASE_URL` exposes current data *and* the full historical snapshot
  trail in one shot. **Medium.**
- Historical Vercel Blob objects (pre-Neon-migration) — retention/deletion
  status **unverified**, see §1.

---

## 13. Compliance surface scan (informational — not legal advice)

This assesses technical posture only; it does not certify compliance.

- **SEC Regulation S-P** (safeguarding customer records/info): the
  cross-investor deposit-data leak (§2) and lack of field-level encryption
  (§6) are the most directly relevant gaps — Reg S-P expects investor
  financial records to be accessible only to those with a legitimate need,
  which is violated by the current unscoped `fund-data.json` read path.
- **SEC Rule 17a-4 / Advisers Act recordkeeping**: no WORM/immutable storage,
  no actor-attributed audit log (§7) — this is the largest gap for this
  requirement family.
- **GLBA Safeguards Rule** (written InfoSec program): nothing in this repo
  constitutes a written information security program — that's expected to
  be a separate document, but note that several *technical* controls a
  Safeguards-Rule program would typically require (access reviews, MFA,
  encryption at rest for sensitive fields, incident response) are either
  missing or unverified here.
- **State breach-notification triggers**: PII held includes full legal
  names + mailing address + phone + nationality + email, combined with
  financial account data (deposit amounts, ownership %) — this combination
  would very likely trigger breach-notification obligations in most US
  states if exposed. The fact that this data is *already* over-exposed
  internally (§2) somewhat raises the stakes of any further external
  breach.

**All compliance framing above needs review by qualified compliance/legal
counsel — this audit assesses code, not regulatory status.**

---

## What a mutual-fund-grade version of this would additionally require

Outside what a codebase alone can provide:

- **SOC 2 Type II audit** (or equivalent) covering the Vercel + Neon +
  Resend + IB data path.
- **Independent penetration test**, at least annually, specifically probing
  the deposit-data exposure and the diagnostic-bypass pattern found here.
- **WORM-backed backup storage** (e.g., S3 Object Lock, or a Postgres
  logical-replication target with restricted write access) instead of
  same-credential snapshot rows.
- **A written InfoSec program** (GLBA Safeguards Rule) covering access
  review cadence, incident response, vendor risk management for Resend/IB/
  Neon/Vercel, and employee (i.e., admin) offboarding.
- **A dedicated secrets manager** (Vault/AWS Secrets Manager/Vercel's own
  encrypted env vars are a start, but rotation and access-audit trails
  matter more at fund scale).
- **MFA enforcement** for the admin role at minimum, ideally all users.
- **A real audit-log service** (append-only, actor-attributed, immutable)
  separate from the application's own DB credentials.
- **Formal data retention/deletion policy**, reviewed against 17a-4's
  multi-year retention floor, with an actual purge mechanism once the
  retention window lapses (rather than "keep everything forever by
  default").
- **Legal/compliance review** of Reg S-P, 17a-4, GLBA, and state
  breach-notification applicability given the actual custodial/advisory
  structure of the fund (this audit cannot determine that — it's a legal
  question, not a code question).

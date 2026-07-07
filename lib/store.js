// Shared blob-name resolution for all API functions.
//
// Sensitive files (fund financials, investor PII) are stored under names that
// include BLOB_SUFFIX — a random secret set in Vercel env — so their public
// blob URLs are unguessable. Client code never sees these URLs; it reads
// through the authenticated /api/data proxy.
//
// If BLOB_SUFFIX is unset, names resolve to their legacy un-suffixed form.

export const BLOB_BASE = "https://yt6mbeqqdx5ifzj3.public.blob.vercel-storage.com/";

const SFX = process.env.BLOB_SUFFIX || "";

const SENSITIVE = new Set([
  "fund-data.json",
  "investors.json",
  "nav-history.json",
  "pending-deposits.json",
  "trades-history.json",
  "ib-cache.json",
]);

// Resolve a logical file name to its stored blob name
export function bname(name) {
  if (SFX && SENSITIVE.has(name)) return name.replace(/\.json$/, `-${SFX}.json`);
  return name;
}

// Resolve a folder prefix ("backups/", "ib-history/") to its stored form
export function bprefix(prefix) {
  if (!SFX) return prefix;
  return prefix.replace(/\/$/, `-${SFX}/`);
}

// Full public URL for a logical file name
export function burl(name) {
  return BLOB_BASE + bname(name);
}

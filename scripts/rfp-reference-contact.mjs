#!/usr/bin/env node
// Write reference contacts on a box (dev or the production VM), for the
// operator (ARCHITECTURE.md §5.17.10).
//
//   npm run rfp:reference-contact <<'EOF'
//   [
//     { "id": "ref_harbor_light_dental",
//       "contactName": "Priya Anand", "contactTitle": "Practice Manager",
//       "contactPhone": "312-555-0142", "contactEmail": "panand@example.org" },
//     { "id": "ref_cobalt_ridge_credit_union", "contactTitle": null }
//   ]
//   EOF
//
// STDIN is a JSON array of {id, contactName, contactTitle, contactPhone,
// contactEmail}. A field that is omitted is left unchanged; an explicit null
// (or an empty string) clears it. Only LIVE rows (retired_at IS NULL) are
// written. Every value is held to the references contract's caps
// (src/lib/rfp/references-block.ts REFERENCE_LIMITS: name 80, title 80,
// phone 40, email 120) and an email must look like one, because a value the
// contract cannot read would be refused by the picker's answer later. The
// example above is invented data.
//
// SECRETS RULE: this script never prints a contact value and never prints
// DATABASE_URL. It reads DATABASE_URL from the environment, else from ./.env
// in place (never copied, never echoed). Output is one line per item,
// `updated <id>: <fields>` or `no live row: <id>`; a refused item prints
// `invalid <id>: <field>` (the field's NAME, never its value) and nothing is
// written at all. A failure to connect or to write prints the error's CODE
// or class name only: a driver or URL-parser message can quote the whole
// connection string, password included. Exit 1 when the JSON is invalid, any
// item is refused, any id had no live row, or the database failed.
//
// Plain Node (>= 20) and the `postgres` package already in dependencies: no
// tsx, no drizzle, so it runs on the VM with the production node_modules.

import { readFileSync } from "node:fs";
import postgres from "postgres";

const COLUMNS = {
  contactName: "contact_name",
  contactTitle: "contact_title",
  contactPhone: "contact_phone",
  contactEmail: "contact_email",
};

// Lockstep with src/lib/rfp/references-block.ts REFERENCE_LIMITS and EMAIL.
const MAX = { contactName: 80, contactTitle: 80, contactPhone: 40, contactEmail: 120 };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The value of DATABASE_URL in a dotenv text: `export ` prefix accepted,
 *  surrounding quotes stripped, and after a QUOTED value a trailing
 *  ` # comment` dropped (an unquoted value keeps its `#`: a URL may hold one). */
function parseDatabaseUrl(env) {
  const m = env.match(/^[ \t]*(?:export[ \t]+)?DATABASE_URL[ \t]*=[ \t]*(.*)$/m);
  if (!m) return null;
  const raw = m[1].trim();
  const quoted = raw.match(/^(['"])(.*?)\1[ \t]*(?:#.*)?$/);
  return (quoted ? quoted[2] : raw) || null;
}

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  let env;
  try {
    env = readFileSync(".env", "utf8");
  } catch {
    return null;
  }
  return parseDatabaseUrl(env);
}

/** {items} when every item is writable, {invalid: [[id, field], ...]} when
 *  one breaks the contract, null when stdin is not the expected shape. */
function readItems() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const items = [];
  const invalid = [];
  for (const item of raw) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.id !== "string" ||
      !/^[a-z0-9_-]{1,80}$/.test(item.id)
    )
      return null;
    const set = {};
    for (const key of Object.keys(COLUMNS)) {
      if (!(key in item)) continue;
      const v = item[key];
      if (v !== null && typeof v !== "string") return null;
      const value = v === null ? null : v.replace(/\s+/g, " ").trim() || null;
      if (
        value !== null &&
        (value.length > MAX[key] || (key === "contactEmail" && !EMAIL.test(value)))
      ) {
        invalid.push([item.id, key]);
        continue;
      }
      set[COLUMNS[key]] = value;
    }
    if (Object.keys(set).length === 0 && !invalid.some(([id]) => id === item.id))
      return null;
    items.push({ id: item.id, set });
  }
  return invalid.length > 0 ? { invalid } : { items };
}

const read = readItems();
if (!read) {
  console.error(
    "expected a JSON array on stdin of {id, contactName?, contactTitle?, contactPhone?, contactEmail?}, each item with at least one field"
  );
  process.exit(1);
}
if (read.invalid) {
  // The id and the field's name only: never the value that was refused.
  for (const [id, field] of read.invalid) console.error(`invalid ${id}: ${field}`);
  process.exit(1);
}
const url = databaseUrl();
if (!url) {
  console.error("DATABASE_URL is not set and ./.env does not define it");
  process.exit(1);
}

// Everything that touches the connection string sits inside ONE try: a
// malformed DATABASE_URL throws ERR_INVALID_URL whose MESSAGE contains the
// whole URL, password included, and a driver error can quote a row. Only the
// error's code (or its class name) is ever printed.
let sql = null;
let missing = 0;
let failed = false;
try {
  sql = postgres(url, { max: 1, onnotice: () => {} });
  for (const { id, set } of read.items) {
    const rows = await sql`
      update rfp_references set ${sql(set)}
      where id = ${id} and retired_at is null
      returning id
    `;
    if (rows.length === 0) {
      missing += 1;
      console.log(`no live row: ${id}`);
    } else {
      console.log(`updated ${id}: ${Object.keys(set).join(", ")}`);
    }
  }
} catch (err) {
  failed = true;
  const name = err && typeof err === "object" ? (err.code ?? err.name) : null;
  console.error(`database error: ${typeof name === "string" && /^[\w.-]{1,60}$/.test(name) ? name : "Error"}`);
} finally {
  if (sql) await sql.end({ timeout: 5 }).catch(() => {});
}
process.exit(failed || missing > 0 ? 1 : 0);

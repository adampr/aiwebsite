// The tenant-domain boundary check (§5.20 round 2), in its own module for
// one reason: it is needed on BOTH sides of the wire.
//
// url-check.ts is server-only by construction (node:dns, node:http,
// node:https, node:net). platform.ts holds the pure predicates the client
// islands read, so the moment platform.ts imported hostInDomain from
// url-check the client bundle tried to pull node:dns in with it and the
// build failed outright. This module has no imports at all and is safe
// everywhere.
//
// THE BOUNDARY IS THE SECURITY PROPERTY. Rungs 2 and 3 both rest on "this
// address belongs to the tenant", so a sloppy match here hands a counting
// step to anyone who can register a lookalike name.

/** Is this host an IP literal? Written without node:net so the module
 * stays client-safe: v4 dotted quad, or anything containing a colon, which
 * for a URL hostname means IPv6. */
function isIpLiteral(host: string): boolean {
  if (host.includes(":")) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * Is this host the tenant's verified domain, or a subdomain of it?
 *
 * A naive endsWith lets "evilacme.com" pass for "acme.com", which is the
 * classic version of this bug. The dot is what makes it a boundary rather
 * than a suffix. An IP literal never qualifies: a bare private address has
 * no tenant binding at all, and allowing one would let
 * "http://10.0.0.5:8080" count for whoever typed it.
 */
export function hostInDomain(host: string, domain: string | null): boolean {
  if (!host || !domain) return false;
  const h = host.toLowerCase().replace(/\.+$/, "").replace(/^\[|\]$/g, "");
  const d = domain.toLowerCase().replace(/\.+$/, "");
  if (!h || !d) return false;
  if (isIpLiteral(h)) return false;
  return h === d || h.endsWith("." + d);
}

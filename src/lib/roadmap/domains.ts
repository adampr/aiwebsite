// Company-domain classification for the roadmap tenancy boundary (§5.18).
// Pure constants and predicates, importable from anywhere (access gate,
// roadmap db, email intake) with no dependency cycles. Constants live in
// code, never env, so the boundary cannot drift silently (rfp/access.ts
// doctrine).

/** Never companies: xl.net would shadow the staff email-intake lane, and
 * ai.xl.net is this system's OWN automation identity. Mirrored by a DB CHECK
 * (companies_domain_ck, migration 0035). */
export const RESERVED_DOMAINS = ["xl.net", "ai.xl.net"] as const;

/** Consumer/freemail/disposable domains: a companies row on one of these
 * would make every account holder of that provider a computed "member" of a
 * shared workspace. Exact lowercase labels. Enforced at bootstrap AND
 * re-checked by companyForDomain on every routing lookup (defense in depth:
 * a bad row must never open the email lane either). Extend freely; a miss
 * here is a tenancy hole, not a UX nit. */
export const FREEMAIL_DOMAINS = [
  // Google / Microsoft / Yahoo / Apple and ccTLD siblings
  "gmail.com", "googlemail.com",
  "outlook.com", "outlook.de", "outlook.fr", "outlook.es", "outlook.jp",
  "hotmail.com", "hotmail.co.uk", "hotmail.fr", "hotmail.de", "hotmail.es", "hotmail.it",
  "live.com", "live.co.uk", "live.fr", "live.de", "live.nl", "msn.com",
  "yahoo.com", "yahoo.co.uk", "yahoo.fr", "yahoo.de", "yahoo.es", "yahoo.it",
  "yahoo.ca", "yahoo.com.au", "yahoo.com.br", "yahoo.co.in", "yahoo.co.jp", "ymail.com",
  "icloud.com", "me.com", "mac.com",
  // Privacy-first and general providers
  "proton.me", "protonmail.com", "pm.me", "tutanota.com", "tuta.io",
  "gmx.com", "gmx.net", "gmx.de", "gmx.at", "gmx.ch", "mail.com",
  "zoho.com", "zohomail.com", "fastmail.com", "fastmail.fm", "hey.com",
  "duck.com", "aol.com", "aim.com", "hushmail.com", "runbox.com", "posteo.de",
  // European nationals
  "web.de", "t-online.de", "freenet.de", "orange.fr", "wanadoo.fr", "free.fr",
  "laposte.net", "sfr.fr", "libero.it", "virgilio.it", "tiscali.it",
  "seznam.cz", "wp.pl", "onet.pl", "interia.pl", "mail.ru", "bk.ru",
  "inbox.ru", "list.ru", "yandex.com", "yandex.ru", "ukr.net", "abv.bg",
  "btinternet.com", "sky.com", "talktalk.net", "virginmedia.com",
  // Asia-Pacific
  "qq.com", "163.com", "126.com", "yeah.net", "sina.com", "sina.cn",
  "sohu.com", "foxmail.com", "aliyun.com", "naver.com", "daum.net",
  "hanmail.net", "rediffmail.com", "bigpond.com", "optusnet.com.au",
  // North American ISPs
  "comcast.net", "att.net", "verizon.net", "sbcglobal.net", "bellsouth.net",
  "cox.net", "charter.net", "optonline.net", "earthlink.net", "frontier.com",
  "windstream.net", "centurylink.net", "juno.com", "netzero.net",
  "shaw.ca", "sympatico.ca", "rogers.com", "telus.net", "videotron.ca",
  // Disposable
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "yopmail.com",
  "tempmail.com", "temp-mail.org", "sharklasers.com", "getnada.com",
  "dispostable.com", "maildrop.cc", "mytemp.email", "trashmail.com",
] as const;

/** The ONE documented endsWith exception (rfp/access.ts bans suffix tests):
 * anyone can mint a free Entra tenant with "verified" addresses under
 * *.onmicrosoft.com, so the whole suffix is shared-tenant space. Also
 * mirrored by the DB CHECK. */
export const SHARED_TENANT_SUFFIXES = [".onmicrosoft.com"] as const;

const FREEMAIL_SET = new Set<string>(FREEMAIL_DOMAINS);

/** May this domain ever be a company? (Does NOT check whether it is one.) */
export function isCompanyEligibleDomain(domain: string): boolean {
  if (!domain || domain !== domain.toLowerCase()) return false;
  if ((RESERVED_DOMAINS as readonly string[]).includes(domain)) return false;
  if (FREEMAIL_SET.has(domain)) return false;
  for (const suffix of SHARED_TENANT_SUFFIXES) {
    if (domain.endsWith(suffix) || domain === suffix.slice(1)) return false;
  }
  // A bare label ("localhost") is not an email domain a company runs on.
  if (!domain.includes(".")) return false;
  return true;
}

// Secret detection for uploaded archives (§5.16). These patterns mirror the
// pre-commit hook's Gate 1 (scripts/git-hooks/pre-commit) - the hook is bash
// and cannot be imported, so the two lists are maintained side by side; when
// you change one, change the other. Matches are reported as PATHS ONLY,
// never the matched value.

/** Filenames that are refused outright wherever they appear in a zip. */
export const SECRET_FILENAME_PATTERNS: RegExp[] = [
  /^\.env$/i,
  /^\.env\..+/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^credentials\.json$/i,
  /^service-account.*\.json$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
];

/** Content shapes that mark a text file as carrying a credential. */
export const SECRET_CONTENT_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/, // Anthropic
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /sk_live_[A-Za-z0-9]{10,}/, // Stripe live secret
  /\bghp_[A-Za-z0-9]{20,}\b/, // GitHub PAT
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google API key
  /\bre_[A-Za-z0-9]{20,}\b/, // Resend
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:PASSWORD|PASSWD|API_KEY|SECRET_KEY|ACCESS_TOKEN)\s*=\s*["'][^"']{8,}["']/i,
];

export function fileNameLooksSecret(basename: string): boolean {
  return SECRET_FILENAME_PATTERNS.some((re) => re.test(basename));
}

export function textLooksSecret(text: string): boolean {
  return SECRET_CONTENT_PATTERNS.some((re) => re.test(text));
}

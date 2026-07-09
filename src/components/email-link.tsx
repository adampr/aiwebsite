// Mailto link wrapped in Cloudflare's <!--email_off--> comments so the zone's
// Email Address Obfuscation (Scrape Shield) doesn't rewrite it into a
// /cdn-cgi/l/email-protection#… link, which 404s for crawlers and no-JS visitors.
// React only emits HTML comments via dangerouslySetInnerHTML, hence the raw string.
export function EmailLink({
  email,
  label,
  className,
}: {
  email: string;
  label?: string;
  className?: string;
}) {
  const attrs = className ? ` class="${className}"` : "";
  return (
    <span
      dangerouslySetInnerHTML={{
        __html: `<!--email_off--><a href="mailto:${email}"${attrs}>${label ?? email}</a><!--/email_off-->`,
      }}
    />
  );
}

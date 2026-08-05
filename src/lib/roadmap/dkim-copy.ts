// DKIM instruction copy (§5.18, the email-lane sub-surface of step 04):
// the ONE source both the dialog and
// the emailed instructions render from, so they can never drift. Client-safe
// (pure strings). No em dashes. Refutation-hardened wording:
//  - "ok" claims RECORDS PUBLISHED, never "your mail is verified" (DNS
//    cannot see the provider's signing toggle).
//  - missing copy carries the gateway caveat (Mimecast/Proofpoint sign for
//    you under their own selector).
//  - Google copy opens with the custom-selector check so the instructions
//    can never rotate a working key.
//  - unknown copy branches on the REASON; no invented MX facts, and no DIY
//    "email Tron to test" claim (a plain email never reaches the DKIM gate).

import type { DkimCheck } from "@/lib/roadmap/dkim";

export type DkimCopy = {
  heading: string;
  intro: string;
  steps: string[];
  outro: string;
  /** False when the check itself failed: emailing instructions derived from
   * a failed lookup would mislead. */
  emailable: boolean;
};

const GATEWAY_CAVEAT =
  "If a separate email security service (Mimecast, Proofpoint, Barracuda) " +
  "handles your outgoing mail, it may already sign for your domain under " +
  "its own name. Ask them before changing anything, then hit Recheck.";

export function dkimCopy(check: DkimCheck): DkimCopy {
  const d = check.domain;
  if (check.verdict === "ok") {
    return {
      heading: "Signing records are published",
      intro:
        `DKIM signing records for ${d} are published in DNS` +
        (check.selector ? ` (selector "${check.selector}")` : "") +
        `. One thing DNS cannot show: whether signing is switched on at your mail provider.`,
      steps:
        check.provider === "m365"
          ? [
              `In the Microsoft Defender portal (security.microsoft.com), open Email and collaboration, then Policies and rules, then Threat policies, then Email authentication settings, and open the DKIM tab.`,
              `Select ${d} and confirm "Sign messages for this domain with DKIM signatures" is switched ON. If it is off, switch it on; the records are already in place.`,
            ]
          : check.provider === "google"
            ? [
                `In the Google Admin console (admin.google.com), open Apps, then Google Workspace, then Gmail, then Authenticate email.`,
                `Select ${d} and confirm it shows "Authenticating email". If it shows a generated record but authentication has not started, click "Start authentication".`,
              ]
            : [
                `Confirm with your mail provider that DKIM signing is enabled for ${d}.`,
                `If this key belongs to a sending service (such as Resend or SendGrid), it covers the mail that service sends. Mail your team sends from its own mailboxes needs its own signing; confirm that with your mailbox provider too.`,
              ],
      outro:
        "Once signing is on, email submissions from your domain reach your company's roadmap directly.",
      emailable: true,
    };
  }

  if (check.verdict === "missing") {
    if (check.provider === "m365") {
      const cnameDead = check.reason === "m365-cname-dead";
      return {
        heading: "Set up DKIM for your Microsoft 365 domain",
        intro: cnameDead
          ? `The two DKIM records for ${d} are installed in your DNS, but they do not lead to live signing keys yet. That usually means DKIM was never finished in Microsoft 365.`
          : `Your domain ${d} uses Microsoft 365, and the two DNS records DKIM needs are not there yet.`,
        steps: [
          `Sign in to the Microsoft Defender portal (security.microsoft.com) as an admin. Open Email and collaboration, then Policies and rules, then Threat policies, then Email authentication settings, and open the DKIM tab.`,
          `Select ${d}. If it offers "Create DKIM keys", click it. The portal then shows two CNAME values (selector1 and selector2).`,
          `At your DNS host, add the two CNAME records exactly as shown: selector1._domainkey.${d} and selector2._domainkey.${d}, each pointing at the target the portal gave you.`,
          `Back in the Defender portal, switch ON "Sign messages for this domain with DKIM signatures".`,
          `DNS changes can take a few hours to spread. Come back and hit Recheck.`,
          GATEWAY_CAVEAT,
        ],
        outro:
          "When the recheck shows the records are live, email submissions from your domain reach your company's roadmap directly.",
        emailable: true,
      };
    }
    if (check.provider === "google") {
      return {
        heading: "Set up DKIM for your Google Workspace domain",
        intro: `Your domain ${d} uses Google Workspace, and the standard DKIM record is not there yet.`,
        steps: [
          `First, a quick check so nothing working gets replaced: in the Google Admin console (admin.google.com), open Apps, then Google Workspace, then Gmail, then Authenticate email. If it already shows "Authenticating email" for ${d} with a custom selector, DKIM is on; just hit Recheck here and skip the rest.`,
          `Otherwise click "Generate new record" and keep the defaults (2048-bit key, "google" selector).`,
          `At your DNS host, add a TXT record named google._domainkey.${d} with the value the console shows.`,
          `Wait for DNS to spread (up to a few hours), then click "Start authentication" in the same screen.`,
          `Come back and hit Recheck.`,
          GATEWAY_CAVEAT,
        ],
        outro:
          "When the recheck shows the record is live, email submissions from your domain reach your company's roadmap directly.",
        emailable: true,
      };
    }
    // Revoked key on either provider path, or an unexpected combination.
    return {
      heading: "Your DKIM key looks revoked",
      intro: `A DKIM record exists for ${d}, but its key is empty, which mail systems read as "revoked".`,
      steps: [
        `Ask whoever manages your email to generate a fresh DKIM key at your mail provider and update the DNS record for ${d}.`,
        GATEWAY_CAVEAT,
      ],
      outro: "Then come back and hit Recheck.",
      emailable: true,
    };
  }

  // unknown: branch on reason. Never invent MX facts.
  switch (check.reason) {
    case "dns-error":
      return {
        heading: "We could not complete the check",
        intro: `We could not read the DNS records for ${d} just now. This is usually temporary.`,
        steps: [`Wait a moment and hit Recheck.`],
        outro: "",
        emailable: false,
      };
    case "no-mx":
      return {
        heading: "This domain does not appear to receive mail",
        intro: `DNS shows no mail routing (MX records) for ${d}, so we cannot tell how its mail is set up.`,
        steps: [
          `If your company does send mail from ${d}, ask whoever manages your DNS to check the MX records, then hit Recheck.`,
        ],
        outro: "",
        emailable: false,
      };
    case "mx-mixed":
      return {
        heading: "Your mail setup looks mid-migration",
        intro: `The MX records for ${d} point at more than one mail provider, which usually means a migration is in progress.`,
        steps: [
          `Finish the migration first, then set up DKIM at the provider you land on and hit Recheck.`,
        ],
        outro: "",
        emailable: false,
      };
    case "wildcard-dns":
      return {
        heading: "Your DNS answers every name",
        intro: `The DNS zone for ${d} answers queries for names that should not exist, so an outside check cannot tell whether DKIM is really set up.`,
        steps: [
          `Ask whoever manages your DNS or email to confirm DKIM signing is enabled for ${d} at your mail provider.`,
        ],
        outro: "",
        emailable: true,
      };
    default:
      // other-provider. mxVendor "amazon" = EVERY MX exchange is Amazon's
      // inbound-smtp shape (strict; a bare .amazonaws.com suffix would
      // invent facts for self-hosted EC2 mail servers).
      if (check.mxVendor === "amazon") {
        return {
          heading: "Set up DKIM in Amazon SES or WorkMail",
          intro: `Incoming mail for ${d} routes through Amazon (SES or WorkMail). Amazon uses randomized DKIM record names, so an outside check cannot confirm signing; the console can.`,
          steps: [
            `In the AWS console, open Amazon SES (or WorkMail), select the ${d} identity, and open its Authentication or DKIM tab.`,
            `If Easy DKIM is not enabled, enable it; the console shows three CNAME records to add at your DNS host.`,
            `Once the console shows DKIM as verified, mail from ${d} is signed. The Recheck here will still say it cannot verify from outside; the console's word is the one that counts.`,
            GATEWAY_CAVEAT,
          ],
          outro: "",
          emailable: true,
        };
      }
      return {
        heading: "Ask your mail provider about DKIM",
        intro: `Your domain ${d} does not use Microsoft 365 or Google Workspace mail routing, so we cannot check its DKIM selectors from outside.`,
        steps: [
          `Ask whoever runs your email service to confirm DKIM signing is enabled for mail sent as ${d}, and to add it if not. Every major provider supports it.`,
          `Once they confirm, mail from your domain can be verified, and email submissions reach your company's roadmap directly.`,
        ],
        outro: "",
        emailable: true,
      };
  }
}

/** Plain-text rendering for the instructions email. */
export function dkimCopyAsText(check: DkimCheck): string {
  const c = dkimCopy(check);
  return [
    c.heading,
    "",
    c.intro,
    "",
    ...c.steps.map((s, i) => `${i + 1}. ${s}`),
    ...(c.outro ? ["", c.outro] : []),
  ].join("\n");
}

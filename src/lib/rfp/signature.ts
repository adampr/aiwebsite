// The XL.net email signature, as proposal furniture (§5.17.4).
//
// Owner directive 2026-08-02: every XL.netter signs with the SAME block,
// varying only the personal lines (name, title, phone, fax, LinkedIn). The
// shape and colors are taken verbatim from the owner's Gmail signature; the
// company half (XL.net link, the two-tone tagline, the two Forbes bylines)
// is constant and single-sourced here so the workspace letter page and both
// export formats can never drift apart.
//
// Pure data, no server imports: the workspace client island renders from it.

export type PersonSignature = {
  name: string;
  /** Job title line ("CEO"). Null for signers not in the directory. */
  title: string | null;
  /** "847.242.1299" — rendered as "<phone> ph | fax <fax>". */
  phone: string | null;
  fax: string | null;
  linkedinUrl: string | null;
  email: string;
};

/** The constant company half of the signature. */
export const COMPANY_SIGNATURE = {
  name: "XL.net",
  url: "https://www.xl.net/",
  tagline: { orange: "XLerate Your ", navy: "Business" },
  articles: [
    {
      title:
        "Forbes.com: Four Technological Steps For Avoiding Extinction In Business (by XL.net)",
      url: "https://www.forbes.com/sites/forbesbusinesscouncil/2020/10/19/four-technological-steps-for-avoiding-extinction-in-business/",
    },
    {
      title:
        "Forbes.com: Six Steps For Embracing New Tools To Operate More Efficiently (by XL.net)",
      url: "https://www.forbes.com/sites/forbesbusinesscouncil/2020/11/13/six-steps-for-embracing-new-tools-to-operate-more-efficiently",
    },
  ],
} as const;

/** The signature block's palette, from the source email's inline styles.
 *  The anchors there are literally `color:blue`, so link is pure blue. */
export const SIGNATURE_COLORS = {
  person: "#1f497d",
  contact: "#333333",
  link: "#0000ff",
  taglineOrange: "#e36c0a",
  taglineNavy: "#245590",
} as const;

/**
 * Per-person lines, keyed by lowercase email. Staff not listed here still
 * sign correctly: name from their profile, the company half in full, their
 * email standing in for the phone line. Add people as they use /rfp.
 */
const SIGNERS: Record<
  string,
  Omit<PersonSignature, "email" | "name"> & { name?: string }
> = {
  "adam@xl.net": {
    name: "Adam Radulovic",
    title: "CEO",
    phone: "847.242.1299",
    fax: "847.686.0201",
    linkedinUrl: "https://www.linkedin.com/in/adamradulovic",
  },
};

export function signatureFor(email: string, displayName: string): PersonSignature {
  const key = email.trim().toLowerCase();
  const person = SIGNERS[key];
  return {
    name: person?.name ?? displayName,
    title: person?.title ?? null,
    phone: person?.phone ?? null,
    fax: person?.fax ?? null,
    linkedinUrl: person?.linkedinUrl ?? null,
    email: key,
  };
}

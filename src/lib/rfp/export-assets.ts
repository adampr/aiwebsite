// Vendored assets + shared furniture for the /rfp proposal emitters (§5.17.1).
//
// The owner directive behind this module: the downloaded file must read as
// the SAME designed document the workspace shows, so both emitters draw from
// one set of real font files (OFL TTFs of Archivo and Source Serif 4, the
// faces globals.css renders the on-screen sheets with), the brand logo PNGs
// the sheets place, and pre-rendered ornament PNGs for the devices Word
// cannot draw natively (the cover's arc-mark corner, the divider ghost
// numerals). Fonts and ornaments live in public/brand/ and are read from
// process.cwd() — prod runs `next start` from the app dir and the deploy
// ships the whole repo, so public/ is always present.
//
// FURNITURE_* strings are the workspace sheets' own furniture text, kept
// here so screen and file cannot drift apart word by word. None of them may
// contain a currency amount (rule B7) or an em dash (owner ban; '·' is fine).

import fs from "node:fs";
import path from "node:path";

const BRAND = () => path.join(process.cwd(), "public", "brand");

export type RfpExportAssets = {
  fonts: {
    /** Archivo 500 — kickers, metalabels, divider runner, pagefoot. */
    archivoMedium: Buffer;
    /** Archivo 600 — table head caps. */
    archivoSemiBold: Buffer;
    /** Archivo 700 — every display title. */
    archivoBold: Buffer;
    /** Source Serif 4 400 — body prose. */
    serifRegular: Buffer;
    /** Source Serif 4 600 — emphasized serif (first table column, names). */
    serifSemiBold: Buffer;
    /** Source Serif 4 400 italic — captions and notes. */
    serifItalic: Buffer;
  };
  images: {
    /** public/brand/xlnet-logo.png, 152x130. */
    logo: Buffer;
    /** public/brand/xlnet-logo-white-wordmark.png, 632x561. */
    logoWhiteWordmark: Buffer;
    /** Cover arc-mark corner, 231x231pt visible region at 300dpi. */
    arcCorner: Buffer;
    /** Ghost divider numerals, 134x122.4pt at 300dpi. */
    num01: Buffer;
    num02: Buffer;
  };
};

/** Intrinsic aspect ratios the emitters size images with (width / height). */
export const IMAGE_ASPECT = {
  logo: 152 / 130,
  logoWhiteWordmark: 632 / 561,
  arcCorner: 1,
  /** The numeral PNGs were rendered at 112.5pt Archivo Bold plus 3pt pad. */
  num: 134 / 122.4,
} as const;

/** Point size of the ornament assets at their design scale. */
export const ORNAMENT_PT = { arcCorner: 231, numWidth: 134, numHeight: 122.4 } as const;

let cached: RfpExportAssets | null = null;

/** Read (once per process) every file both emitters need. */
export function loadRfpExportAssets(): RfpExportAssets {
  if (cached) return cached;
  const read = (...p: string[]) => fs.readFileSync(path.join(BRAND(), ...p));
  cached = {
    fonts: {
      archivoMedium: read("fonts", "Archivo-Medium.ttf"),
      archivoSemiBold: read("fonts", "Archivo-SemiBold.ttf"),
      archivoBold: read("fonts", "Archivo-Bold.ttf"),
      serifRegular: read("fonts", "SourceSerif4-Regular.ttf"),
      serifSemiBold: read("fonts", "SourceSerif4-SemiBold.ttf"),
      serifItalic: read("fonts", "SourceSerif4-Italic.ttf"),
    },
    images: {
      logo: read("xlnet-logo.png"),
      logoWhiteWordmark: read("xlnet-logo-white-wordmark.png"),
      arcCorner: read("rfp-ornaments", "arc-corner.png"),
      num01: read("rfp-ornaments", "num-01.png"),
      num02: read("rfp-ornaments", "num-02.png"),
    },
  };
  return cached;
}

/* ------------------------------------------------------------------------ */
/* Furniture: the workspace sheets' own text, single-sourced for the files. */
/* ------------------------------------------------------------------------ */

/** Cover kicker over the title (workspace cover sheet). */
export const FURNITURE_COVER_KICKER = "Managed IT Services Proposal";

/** First meta-grid column: the company line above the preparer. */
export const FURNITURE_SUBMITTED_BY = "XL.net Inc.";

/** Running footer on every sheet, left and right. */
export const FURNITURE_FOOT_LEFT = "XL.net · Managed IT Services Proposal";
export const FURNITURE_FOOT_RIGHT = "Confidential";

/** The two part-divider sheets, in screen order. */
export const FURNITURE_DIVIDERS = [
  {
    num: "01" as const,
    title: "Response to the Request for Proposal",
    deck: "The sections of this response, as read from the request.",
  },
  {
    num: "02" as const,
    title: "Investment",
    deck: "Pricing for the services in this proposal, computed from the rate card.",
  },
];

/** Divider running header: "XL.net · Proposal for {client}". */
export function dividerHead(clientName: string): string {
  return clientName ? `XL.net · Proposal for ${clientName}` : "XL.net · Proposal";
}

/** The navy closing sheet's headline (workspace closing sheet). */
export const FURNITURE_CLOSING_HEADLINE =
  "Because our fee is flat, our incentive is to prevent issues, not to bill for them.";

/** Closing meta labels; the third value is constant. */
export const FURNITURE_CLOSING_WEB = "xl.net";

/** Per-illustration minimum note (workspace pricing sheet, minimumApplied). */
export const FURNITURE_MINIMUM_CAPTION =
  "The monthly minimum applies to the fully managed line, so it is billed at the flat minimum rather than the per-user product.";

/** The draft marking, cover line and corner mark. */
export const FURNITURE_DRAFT_LINE = "WORKING DRAFT · not for delivery";
export const FURNITURE_DRAFT_MARK = "WORKING DRAFT";

/** Investment table head, in screen column order. */
export const FURNITURE_TABLE_HEAD = ["Service", "Qty", "Unit", "Monthly"] as const;

/**
 * The workspace's section-kicker rule, replicated verbatim (workspace.tsx
 * secKicker): bare labels get a "Section " prefix, roman numerals are tested
 * as numerals first, already-worded labels pass through.
 */
export function sectionKicker(label: string): string {
  const t = label.trim();
  if (!t) return "Section";
  if (/^M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/i.test(t))
    return `Section ${t}`;
  return /[a-z]{3,}/i.test(t) ? t : `Section ${t}`;
}

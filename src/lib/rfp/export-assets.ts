// Vendored assets + shared furniture for the /rfp proposal emitters (§5.17.1).
//
// The owner directive behind this module: the downloaded file must read as
// the SAME designed document the workspace shows, so both emitters draw from
// one set of real font files (OFL TTFs of Archivo and Source Serif 4, the
// faces globals.css renders the on-screen sheets with), the brand logo PNGs
// the sheets place, and pre-rendered ornament PNGs for the devices Word
// cannot draw natively (the cover's arc-mark corner, the divider ghost
// numerals, the visual blocks' badge mark and timeline dot). Fonts and
// ornaments live in public/brand/ and are read from
// process.cwd() — prod runs `next start` from the app dir and the deploy
// ships the whole repo, so public/ is always present.
//
// FURNITURE_* strings are the workspace sheets' own furniture text, kept
// here so screen and file cannot drift apart word by word. None of them may
// contain a currency amount (rule B7) or an em dash (owner ban; '·' is fine).

import fs from "node:fs";
import path from "node:path";
import { CLOSING_HEADLINE } from "./furniture";

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
    /** Parts 03 and 04 of a brief document (§5.17.21), rendered to the same
     *  geometry as 01/02 (Archivo Bold, navy outline over the ghost fill). */
    num03: Buffer;
    num04: Buffer;
    /** Visual-block marks Word cannot draw (the PDF draws them as vectors):
     *  the badge strip's rotated square, 14px box at 4x, in the order the
     *  strip cycles them (navy, blue, ink). */
    badgeMarks: [Buffer, Buffer, Buffer];
    /** The timeline's 12px step dot at 4x, same color order. */
    stepDots: [Buffer, Buffer, Buffer];
    /** The timeline connector: a hairline stripe that stretches sideways. */
    stepRule: Buffer;
    /** The client echo's numbered circles 1..6 (§5.17.22): a 22px navy
     *  disc with its white Archivo Bold numeral, at 4x. Word cannot draw a
     *  numbered circle; the PDF and the screen draw it as a vector. */
    echoNumbers: [Buffer, Buffer, Buffer, Buffer, Buffer, Buffer];
  };
};

/** Which mark a badge or a timeline step carries (index into badgeMarks /
 *  stepDots). Shared so both emitters and the screen agree on the sequence. */
export const badgeMarkIndex = (i: number): 0 | 1 | 2 => (i % 3) as 0 | 1 | 2;
/** Timeline: the last step is ink, the one before it blue, the rest navy;
 *  a two-step timeline is navy then ink (the screen's first-child rule). */
export const stepDotIndex = (i: number, count: number): 0 | 1 | 2 =>
  i === count - 1 ? 2 : i === count - 2 && i > 0 ? 1 : 0;

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
      num03: read("rfp-ornaments", "num-03.png"),
      num04: read("rfp-ornaments", "num-04.png"),
      badgeMarks: [
        read("rfp-ornaments", "badge-navy.png"),
        read("rfp-ornaments", "badge-blue.png"),
        read("rfp-ornaments", "badge-ink.png"),
      ],
      stepDots: [
        read("rfp-ornaments", "dot-navy.png"),
        read("rfp-ornaments", "dot-blue.png"),
        read("rfp-ornaments", "dot-ink.png"),
      ],
      stepRule: read("rfp-ornaments", "step-rule.png"),
      echoNumbers: [
        read("rfp-ornaments", "echo-1.png"),
        read("rfp-ornaments", "echo-2.png"),
        read("rfp-ornaments", "echo-3.png"),
        read("rfp-ornaments", "echo-4.png"),
        read("rfp-ornaments", "echo-5.png"),
        read("rfp-ornaments", "echo-6.png"),
      ],
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

/** Running footer on every sheet, left and right. "Confidential" is standing
 *  business copy on every sheet of all three surfaces, NOT a draft mark (the
 *  2026-08-28 ruling bans DRAFT marks; §5.17.20 records the difference). */
// Every surface prints furniture.ts pageFootLeft for the left slot, which
// extends the base with "for <who>" (§5.17.20).
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

/** The part dividers for a document's intake form (§5.17.17): a brief was
 *  read from no request, so part 01 says so. Anything but "brief" gets
 *  FURNITURE_DIVIDERS unchanged. */
export function furnitureDividers(intakeForm: string): typeof FURNITURE_DIVIDERS {
  if (intakeForm !== "brief") return FURNITURE_DIVIDERS;
  return FURNITURE_DIVIDERS.map((d) =>
    d.num === "01"
      ? {
          ...d,
          title: "The Proposal",
          deck: "The sections of this proposal, in XL.net's standard order.",
        }
      : d
  );
}

/** Divider running header: "XL.net · Proposal for {client}". */
export function dividerHead(clientName: string): string {
  return clientName ? `XL.net · Proposal for ${clientName}` : "XL.net · Proposal";
}

/** The navy closing sheet's fallback headline (workspace closing sheet): the
 *  letter's thesis replaces it when stored (furniture.ts closingHeadline,
 *  §5.17.20). Single-sourced in the client-safe furniture module. */
export const FURNITURE_CLOSING_HEADLINE = CLOSING_HEADLINE;

/** Closing meta labels; the third value is constant. */
export const FURNITURE_CLOSING_WEB = "xl.net";

/** Per-illustration minimum note (workspace pricing sheet, minimumApplied). */
export const FURNITURE_MINIMUM_CAPTION =
  "The monthly minimum applies to the fully managed line, so it is billed at the flat minimum rather than the per-user product.";

/** Investment table head, in screen column order. */
export const FURNITURE_TABLE_HEAD = ["Service", "Qty", "Unit", "Monthly"] as const;

/**
 * The section-kicker rule, re-exported from the client-safe furniture.ts so
 * the workspace's secKicker and both emitters run ONE function (it was a
 * pinned replica of the workspace's copy before round 33, §5.17.21). Bare
 * labels get a "Section " prefix, roman numerals are tested as numerals
 * first, already-worded labels pass through. A brief document's sheets print
 * the part-relative kicker instead (furniture.ts sheetKicker).
 */
export { sectionKicker } from "./furniture";

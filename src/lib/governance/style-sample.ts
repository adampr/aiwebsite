// Sample-policy upload: text extraction + normalization (§5.12). The user
// uploads an existing company policy so drafts can mirror its formatting
// conventions. Only extracted plain text is ever stored (never the file),
// it rides the project row, and it deletes with the row.
//
// Server-side only (jszip import); the client never parses the file.
//
// Everything here runs synchronously on the request path over content an
// attacker fully controls, so every pass over the XML must be LINEAR: the
// scanners below use indexOf walks, fixed-string splits, and bounded-
// quantifier regexes only. A quadratic corner (e.g. /<[^>]+>/ over "<a<a<a")
// wedged the event loop for minutes per 0.5 KB upload in review testing.

import JSZip from "jszip";
import { CAPS, STYLE_SAMPLE_EXTENSIONS } from "./config";

export type ExtractResult =
  | { ok: true; text: string }
  | { ok: false; message: string };

const UNREADABLE =
  "No usable text was found in that file. Check that it is a valid .docx, .md, or .txt with at least a paragraph or two, and try again.";

const TOO_LARGE =
  "That .docx is too large to read. Export a shorter copy; a few representative pages are plenty.";

// Hard ceiling on inflated document.xml bytes: real policy documents are far
// smaller, and a crafted deflate stream can expand ~1000x (400 KB upload ->
// ~400 MB) if inflation is unbounded.
const MAX_DOCX_XML_BYTES = 5_000_000;

// Stop accumulating extracted text well past the stored cap; keeps the
// structure pass from grinding through megabytes it will never use.
const EXTRACT_STOP_CHARS = 60_000;

/** Decode the five XML entities plus numeric references. Quantifiers are
 * bounded so a hostile entity run cannot trigger quadratic rescans. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_, h: string) =>
      String.fromCodePoint(parseInt(h, 16))
    )
    .replace(/&#(\d{1,7});/g, (_, d: string) => {
      const n = parseInt(d, 10);
      return n <= 0x10ffff ? String.fromCodePoint(n) : "";
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Linear single-pass tag stripper: keeps text, turns w:tab/w:br into
 * whitespace structure, drops everything else. An unterminated tag drops
 * the remainder (malformed input, nothing legitimate to salvage). */
function stripRuns(chunk: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < chunk.length) {
    const lt = chunk.indexOf("<", i);
    if (lt === -1) {
      parts.push(chunk.slice(i));
      break;
    }
    parts.push(chunk.slice(i, lt));
    const gt = chunk.indexOf(">", lt + 1);
    if (gt === -1) break;
    const tag = chunk.slice(lt + 1, Math.min(gt, lt + 8));
    if (tag.startsWith("w:tab")) parts.push("\t");
    else if (tag.startsWith("w:br")) parts.push("\n");
    i = gt + 1;
  }
  return decodeXmlEntities(parts.join(""));
}

/** First w:val="..." after `marker` inside the paragraph-properties region
 * of the chunk, via bounded indexOf walks (no regex over the full chunk). */
function propVal(chunk: string, marker: string): string | null {
  const end = chunk.indexOf("</w:pPr>");
  const region = chunk.slice(0, end === -1 ? Math.min(chunk.length, 2000) : end);
  const at = region.indexOf(marker);
  if (at === -1) return null;
  const near = region.slice(at, at + 200);
  const v = near.indexOf('w:val="');
  if (v === -1) return "";
  const close = near.indexOf('"', v + 7);
  return close === -1 ? "" : near.slice(v + 7, close);
}

/**
 * One OOXML paragraph -> one text line, with the structure the format
 * matcher needs made visible: heading styles (or outline levels, which are
 * locale-independent) become markdown heading prefixes, numbered/bulleted
 * paragraphs (w:numPr; Word keeps the actual numbers in numbering.xml, not
 * in the text) become "- " items.
 */
function paraToLine(p: string): string {
  const text = stripRuns(p).replace(/\s+/g, " ").trim();
  if (!text) return "";
  const style = propVal(p, "<w:pStyle");
  if (style === "Title") return `# ${text}`;
  const styleLevel = /^[Hh]eading([1-6])$/.exec(style ?? "");
  if (styleLevel) return `${"#".repeat(parseInt(styleLevel[1], 10))} ${text}`;
  const outline = propVal(p, "<w:outlineLvl");
  if (outline !== null && /^[0-5]$/.test(outline))
    return `${"#".repeat(parseInt(outline, 10) + 1)} ${text}`;
  if (propVal(p, "<w:numPr") !== null) return `- ${text}`;
  return text;
}

/** indexOf walk for "<w:tbl" followed by whitespace or ">" (skips w:tblPr
 * and friends), starting at `from`. */
function findTableStart(xml: string, from: number): number {
  let i = from;
  while (i < xml.length) {
    const at = xml.indexOf("<w:tbl", i);
    if (at === -1) return -1;
    const boundary = xml.charAt(at + 6);
    if (boundary === ">" || boundary === " " || boundary === "\t" || boundary === "\n" || boundary === "\r")
      return at;
    i = at + 6;
  }
  return -1;
}

/**
 * word/document.xml -> plain text that preserves what the format matcher
 * mirrors: heading hierarchy, list items, and table rows (cells tab-joined,
 * one row per line). Everything else flattens to paragraphs. Linear:
 * indexOf segmentation + fixed-string splits only.
 */
function docxXmlToText(xml: string): string {
  const out: string[] = [];
  let total = 0;
  const push = (line: string): boolean => {
    out.push(line);
    total += line.length;
    return total < EXTRACT_STOP_CHARS;
  };

  let pos = 0;
  while (pos < xml.length) {
    const tblStart = findTableStart(xml, pos);
    const plainEnd = tblStart === -1 ? xml.length : tblStart;

    // Plain segment: paragraphs. The split pattern is fixed-length (no
    // quantifiers), so it cannot backtrack; "<w:p" alone would also split
    // inside <w:pPr>/<w:pStyle> and shred the paragraph.
    const plain = xml.slice(pos, plainEnd);
    for (const p of plain.split(/<w:p[\s>]/)) {
      const line = paraToLine(p);
      if (line && !push(line)) return out.join("\n");
    }
    if (tblStart === -1) break;

    // Table segment: rows -> lines, cells -> tabs. Nested tables degrade to
    // their first close, acceptable for a formatting sample.
    let tblEnd = xml.indexOf("</w:tbl>", tblStart);
    if (tblEnd === -1) tblEnd = xml.length;
    const tbl = xml.slice(tblStart, tblEnd);
    for (const row of tbl.split("</w:tr>")) {
      const cells = row
        .split("</w:tc>")
        .map((c) => stripRuns(c).replace(/\s+/g, " ").trim())
        .filter(Boolean);
      if (cells.length && !push(cells.join("\t"))) return out.join("\n");
    }
    pos = tblEnd + 8;
  }
  return out.join("\n");
}

/**
 * Strip control chars (keep \n and \t), normalize newlines, cap blank runs,
 * and destroy the prompt's fence tokens anywhere they appear: the sample is
 * the one fenced block whose content the user authors directly, and the
 * extractor itself can move a marker off line-start ("- SAMPLE>>>"), so
 * glyph runs are removed globally rather than by line.
 */
function normalize(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/<{3,}|>{3,}/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// JSZip's documented internalStream API is missing from its typings.
interface JsZipStream {
  on(event: "data", cb: (chunk: Uint8Array) => void): JsZipStream;
  on(event: "error", cb: (e: unknown) => void): JsZipStream;
  on(event: "end", cb: () => void): JsZipStream;
  pause(): JsZipStream;
  resume(): JsZipStream;
}

type InflateOutcome =
  | { kind: "ok"; xml: string }
  | { kind: "too_large" }
  | { kind: "error" };

/** Inflate one zip entry with a hard byte cap (decompression-bomb guard).
 * Streams via JSZip's documented internalStream API so a lying central
 * directory cannot force an unbounded in-memory inflate. */
function inflateCapped(
  entry: JSZip.JSZipObject,
  maxBytes: number
): Promise<InflateOutcome> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let settled = false;
    const done = (v: InflateOutcome) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const stream = (
      entry as unknown as {
        internalStream(type: "uint8array"): JsZipStream;
      }
    ).internalStream("uint8array");
    stream.on("data", (chunk: Uint8Array) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        try {
          stream.pause();
        } catch {
          // best effort; we stop accumulating either way
        }
        done({ kind: "too_large" });
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", () => done({ kind: "error" }));
    stream.on("end", () =>
      done({ kind: "ok", xml: Buffer.concat(chunks).toString("utf8") })
    );
    stream.resume();
  });
}

/**
 * Extract plain text from an uploaded sample policy. `.docx` is unzipped and
 * `word/document.xml` converted (headings, lists, and table rows kept
 * visible); `.md`/`.txt` are read as UTF-8. The result is normalized and
 * capped at CAPS.styleSampleMaxChars.
 */
export async function extractStyleSampleText(
  filename: string,
  buf: Buffer
): Promise<ExtractResult> {
  const lower = filename.toLowerCase();
  if (!STYLE_SAMPLE_EXTENSIONS.some((ext) => lower.endsWith(ext)))
    return {
      ok: false,
      message: "Upload a .docx, .md, or .txt file. PDFs are not supported yet.",
    };

  let text: string;
  if (lower.endsWith(".docx")) {
    try {
      const zip = await JSZip.loadAsync(buf);
      const entry = zip.file("word/document.xml");
      if (!entry) return { ok: false, message: UNREADABLE };
      const inflated = await inflateCapped(entry, MAX_DOCX_XML_BYTES);
      if (inflated.kind === "too_large")
        return { ok: false, message: TOO_LARGE };
      if (inflated.kind === "error") return { ok: false, message: UNREADABLE };
      text = docxXmlToText(inflated.xml);
    } catch {
      return { ok: false, message: UNREADABLE };
    }
  } else {
    text = buf.toString("utf8");
  }

  const clean = normalize(text);
  if (clean.length < 40) return { ok: false, message: UNREADABLE };
  return { ok: true, text: clean.slice(0, CAPS.styleSampleMaxChars) };
}

/** Display-safe file name: basename only, control chars out, length-capped. */
export function sanitizeSampleName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "sample";
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (clean || "sample").slice(0, 120);
}

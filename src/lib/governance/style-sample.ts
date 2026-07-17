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
import {
  CAPS,
  STYLE_SAMPLE_EXTENSIONS,
  STYLE_SAMPLE_TYPES_COPY,
} from "./config";

export type ExtractResult =
  | { ok: true; text: string }
  | { ok: false; message: string };

const UNREADABLE = `No usable text was found in that file. Check that it is a valid ${STYLE_SAMPLE_TYPES_COPY} with at least a paragraph or two, and try again.`;

const PDF_NO_TEXT =
  "That PDF has no selectable text (it may be a scan). Export a text-based copy, or save it as .docx, and try again.";

const PDF_TIMEOUT =
  "That PDF took too long to read. Export a shorter copy (a few representative pages are plenty), or save it as .docx, and try again.";

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
 * PDF heading inference (§5.12 structure adoption): getTextContent has no
 * style information, so a PDF template used to reach the prompt as flat
 * paragraphs with NO structure for the model to mirror. Font height is the
 * signal PDFs do carry: lines set clearly larger than the document's median
 * (body) size, short, and not ending like a sentence become markdown
 * headings, two tiers by size. Linear; needs a minimum of lines so a
 * one-page memo does not get fake structure. Exported for tests.
 */
export function markPdfHeadings(
  lines: { text: string; h: number }[]
): string[] {
  const sized = lines
    .map((l) => ({ t: l.text.trim(), h: l.h }))
    .filter((l) => l.t.length > 0 && l.h > 0);
  if (sized.length < 8) return lines.map((l) => l.text);
  const heights = sized.map((l) => l.h).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)];
  if (!(median > 0)) return lines.map((l) => l.text);
  return lines.map((l) => {
    const t = l.text.trim();
    const heading =
      l.h >= median * 1.2 &&
      t.length > 0 &&
      t.length <= 100 &&
      /[A-Za-z]/.test(t) &&
      !/[.;,]$/.test(t);
    if (!heading) return l.text;
    return `${l.h >= median * 1.5 ? "#" : "##"} ${t}`;
  });
}

/**
 * PDF -> plain text via pdf.js getTextContent (no rendering, no canvas, no
 * embedded-JS execution; isEvalSupported off). Hostile-input posture matches
 * the docx path: page cap, char stop, and a hard wall-clock deadline that
 * destroys the loading task (pdf.js parses in yielding async chunks, so
 * destroy() genuinely cancels the work). Lines are joined per text item with
 * y-position breaks, carry their max font height, and get heading markers
 * from markPdfHeadings so structure stays visible to the format matcher.
 */
async function pdfToText(buf: Buffer): Promise<ExtractResult> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdfjs-dist 6.x: PostScript-function eval was removed upstream, so there
  // is no isEvalSupported switch anymore; text extraction runs no PDF JS.
  const task = getDocument({
    data: new Uint8Array(buf),
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
  });
  const deadline = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), CAPS.styleSamplePdfDeadlineMs)
  );
  try {
    const extracted = await Promise.race([
      (async () => {
        const doc = await task.promise;
        const pages = Math.min(doc.numPages, CAPS.styleSamplePdfMaxPages);
        // Lines from ALL pages classify together (one document-wide median);
        // h=0 separator rows keep the page breaks and never classify.
        const allLines: { text: string; h: number }[] = [];
        let total = 0;
        for (let n = 1; n <= pages && total < EXTRACT_STOP_CHARS; n++) {
          const page = await doc.getPage(n);
          const content = await page.getTextContent();
          let lastY: number | null = null;
          let lineH = 0;
          const line: string[] = [];
          const push = () => {
            const text = line.join("");
            allLines.push({ text, h: lineH });
            total += text.length;
            line.length = 0;
            lineH = 0;
          };
          for (const item of content.items) {
            if (!("str" in item)) continue;
            const tf = Array.isArray(item.transform) ? item.transform : null;
            const y = tf ? tf[5] : null;
            // Unrotated text: |d| is the font height; |a| is the fallback
            // for rotated or sheared matrices.
            const h = tf ? Math.abs(tf[3]) || Math.abs(tf[0]) : 0;
            if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) push();
            line.push(item.str);
            if (h > lineH) lineH = h;
            if (item.hasEOL) {
              push();
              lastY = null;
            } else if (y !== null) lastY = y;
          }
          if (line.length) push();
          if (n < pages) allLines.push({ text: "", h: 0 });
        }
        return markPdfHeadings(allLines).join("\n").trim();
      })(),
      deadline,
    ]);
    if (extracted === "timeout") {
      void task.destroy().catch(() => {});
      return { ok: false, message: PDF_TIMEOUT };
    }
    void task.destroy().catch(() => {});
    if (extracted.trim().length < 40) return { ok: false, message: PDF_NO_TEXT };
    return { ok: true, text: extracted };
  } catch {
    void task.destroy().catch(() => {});
    return { ok: false, message: UNREADABLE };
  }
}

/**
 * Extract plain text from an uploaded sample policy. `.docx` is unzipped and
 * `word/document.xml` converted (headings, lists, and table rows kept
 * visible); `.pdf` goes through pdf.js text extraction (deadline + page
 * capped); `.md`/`.txt` are read as UTF-8. The result is normalized and
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
      message: `Upload a ${STYLE_SAMPLE_TYPES_COPY} file.`,
    };

  let text: string;
  if (lower.endsWith(".pdf")) {
    const pdf = await pdfToText(buf);
    if (!pdf.ok) return pdf;
    text = pdf.text;
  } else if (lower.endsWith(".docx")) {
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

// Sample-policy upload: text extraction + normalization (§5.12). The user
// uploads an existing company policy so drafts can mirror its formatting
// conventions. Only extracted plain text is ever stored (never the file),
// it rides the project row, and it deletes with the row.
//
// Server-side only (jszip import); the client never parses the file.

import JSZip from "jszip";
import { CAPS, STYLE_SAMPLE_EXTENSIONS } from "./config";

export type ExtractResult =
  | { ok: true; text: string }
  | { ok: false; message: string };

const UNREADABLE =
  "I could not read text from that file. Save it as .docx, .md, or .txt and try again.";

/** Decode the five XML entities plus numeric references. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) =>
      String.fromCodePoint(parseInt(h, 16))
    )
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** word/document.xml -> plain text with paragraph and tab structure kept. */
function docxXmlToText(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<w:tab[^>]*\/>/g, "\t")
      .replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, "")
  );
}

/** Strip control chars (keep \n and \t), normalize newlines, cap blank runs. */
function normalize(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract plain text from an uploaded sample policy. `.docx` is unzipped and
 * `word/document.xml` flattened; `.md`/`.txt` are read as UTF-8. The result
 * is normalized and capped at CAPS.styleSampleMaxChars.
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
      // Decompression-bomb guard: a small .docx can deflate to hundreds of
      // MB of XML before the char cap ever applies. JSZip only exposes the
      // entry's uncompressed size internally; if the field is present and
      // huge, refuse before inflating. (Fallback: proceed - output is still
      // char-capped after decode.)
      const uncompressedSize = (
        entry as unknown as { _data?: { uncompressedSize?: number } }
      )._data?.uncompressedSize;
      if (typeof uncompressedSize === "number" && uncompressedSize > 5_000_000)
        return {
          ok: false,
          message:
            "That .docx is too large to read. Export a shorter copy; a few representative pages are plenty.",
        };
      const xml = await entry.async("string");
      // Belt to the guard above: zip metadata can lie, so bound the regex
      // work too. 5M chars of XML is far beyond any real policy document.
      text = docxXmlToText(xml.slice(0, 5_000_000));
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

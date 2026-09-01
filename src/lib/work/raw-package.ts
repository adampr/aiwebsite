// §5.16 raw fallback transport (2026-09-01). On 2026-08-27 a submitter's six
// web attempts all died in req.formData(): the multipart body arrived, nginx
// timed ~1s of body receipt, and undici's parser threw every time. The classic
// cause is DLP/TLS-inspection middleware rewriting multipart bodies in
// transit. Multipart is what such middleboxes mangle; an opaque binary body is
// not, so the form retries ONCE with this framing under the content type
// below, and both submission routes accept it as a second wire format.
//
// CLIENT-SAFE ON PURPOSE: no node imports, TextEncoder/TextDecoder/DataView
// only, because the ENCODER runs in the browser (submission-form.tsx) and the
// DECODER runs in the routes (via read-body.ts), and a codec split across two
// files is a codec that drifts. test:worksubmit round-trips it.
//
// Byte layout: 8-byte ASCII magic "WORKRAW1", 4-byte big-endian uint32 = byte
// length of a UTF-8 JSON metadata block, the JSON, the package file bytes,
// then (optional) the standalone doc file bytes. The JSON declares fileName +
// fileSize (and docName + docSize when a doc rides along) plus the text
// fields; every declared length must sum EXACTLY to the body length or the
// decode refuses, so a middlebox that touches THIS body is caught rather than
// silently truncating a file.

/** The fallback's content type. Not multipart and not a registered type, so
 * nothing between the browser and undici has an opinion about its body. */
export const WORK_RAW_CONTENT_TYPE = "application/x-work-package";

export const WORK_RAW_MAGIC = "WORKRAW1";

/** The text fields the multipart form sends; absent = not sent (the update
 * lane never sends title, an empty create form still sends blurb=""). Same
 * semantics as the FormData keys the routes read. */
export interface RawPackageFields {
  title?: string;
  blurb?: string;
  attribution?: string;
  timeSavedHours?: string;
}

const FIELD_KEYS = ["title", "blurb", "attribution", "timeSavedHours"] as const;

/** Plain-ArrayBuffer-backed on purpose: fetch's BodyInit and File's BlobPart
 * both refuse a possibly-SharedArrayBuffer view under TS 5.7's typed-array
 * generics, and every producer here (new Uint8Array(n), arrayBuffer() reads)
 * is plain-backed anyway. */
type RawBytes = Uint8Array<ArrayBuffer>;

/** A part is a Blob (the form passes its File objects straight through, so
 * the browser streams them into the request without a second in-memory copy;
 * at the 100 MB cap the old flat-Uint8Array build peaked at ~200 MB,
 * refuter finding 2026-09-01) or bytes already in hand (tests, small docs). */
interface RawFilePart {
  name: string;
  data: Blob | RawBytes;
}

function partSize(data: Blob | RawBytes): number {
  return data instanceof Blob ? data.size : data.byteLength;
}

/** Returns the request BODY as a Blob (typed with the wire content type, so
 * even a caller that forgets the header sends the right one). BlobPart
 * concatenation is by reference: nothing here reads the file parts, which
 * also means a File that changed on disk since it was chosen fails at SEND
 * time, not here; the form probes readability first (submission-form.tsx)
 * so that failure class keeps its own message. */
export function encodeRawWorkPackage(o: {
  fields: RawPackageFields;
  file: RawFilePart;
  doc?: RawFilePart | null;
}): Blob {
  const enc = new TextEncoder();
  const meta: Record<string, string | number> = {};
  for (const k of FIELD_KEYS) {
    const v = o.fields[k];
    if (v !== undefined) meta[k] = v;
  }
  meta.fileName = o.file.name;
  meta.fileSize = partSize(o.file.data);
  if (o.doc) {
    meta.docName = o.doc.name;
    meta.docSize = partSize(o.doc.data);
  }
  const json = enc.encode(JSON.stringify(meta));
  const header = new Uint8Array(12);
  header.set(enc.encode(WORK_RAW_MAGIC), 0);
  new DataView(header.buffer).setUint32(8, json.byteLength, false);
  return new Blob(
    [header, json, o.file.data, ...(o.doc ? [o.doc.data] : [])],
    { type: WORK_RAW_CONTENT_TYPE }
  );
}

/** What the decoder hands back: always bytes in hand (the server has the
 * whole received body and slices it), unlike the encoder's Blob parts. */
interface DecodedFile {
  name: string;
  bytes: RawBytes;
}

export type RawDecodeResult =
  | {
      ok: true;
      fields: RawPackageFields;
      file: DecodedFile;
      doc: DecodedFile | null;
    }
  | { ok: false; error: string };

/** A non-negative integer that can be a byte length. `Number.isInteger`
 * refuses NaN, Infinity and fractions in one test. */
function isByteLen(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** Strict by design: the whole point of this transport is that a body
 * something tampered with REFUSES instead of parsing into a corrupt file, so
 * every check names what failed (the error string reaches the log line, never
 * the submitter). */
export function decodeRawWorkPackage(body: RawBytes): RawDecodeResult {
  const err = (error: string): RawDecodeResult => ({ ok: false, error });
  if (body.byteLength < 12) return err(`body too short (${body.byteLength} bytes)`);
  const dec = new TextDecoder("utf-8", { fatal: true });
  let magic: string;
  try {
    magic = dec.decode(body.subarray(0, 8));
  } catch {
    return err("magic is not UTF-8");
  }
  if (magic !== WORK_RAW_MAGIC) return err("bad magic");
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const jsonLen = view.getUint32(8, false);
  if (12 + jsonLen > body.byteLength)
    return err(`declared metadata length ${jsonLen} exceeds body`);
  let meta: unknown;
  try {
    meta = JSON.parse(dec.decode(body.subarray(12, 12 + jsonLen)));
  } catch {
    return err("metadata block is not valid UTF-8 JSON");
  }
  if (typeof meta !== "object" || meta === null || Array.isArray(meta))
    return err("metadata is not an object");
  const m = meta as Record<string, unknown>;
  if (typeof m.fileName !== "string" || m.fileName.length === 0)
    return err("fileName missing");
  if (!isByteLen(m.fileSize)) return err("fileSize is not a byte length");
  const hasDocName = m.docName !== undefined;
  const hasDocSize = m.docSize !== undefined;
  if (hasDocName !== hasDocSize) return err("docName and docSize must travel together");
  if (hasDocName && (typeof m.docName !== "string" || m.docName.length === 0))
    return err("docName missing");
  if (hasDocSize && !isByteLen(m.docSize)) return err("docSize is not a byte length");
  const docSize = hasDocSize ? (m.docSize as number) : 0;
  const declared = 12 + jsonLen + m.fileSize + docSize;
  if (declared !== body.byteLength)
    return err(
      `declared lengths sum to ${declared}, body is ${body.byteLength} bytes`
    );
  const fields: RawPackageFields = {};
  for (const k of FIELD_KEYS) {
    const v = m[k];
    if (v === undefined) continue;
    if (typeof v !== "string") return err(`field ${k} is not a string`);
    fields[k] = v;
  }
  const fileStart = 12 + jsonLen;
  const fileEnd = fileStart + m.fileSize;
  return {
    ok: true,
    fields,
    file: { name: m.fileName, bytes: body.subarray(fileStart, fileEnd) },
    doc: hasDocName
      ? {
          name: m.docName as string,
          bytes: body.subarray(fileEnd, fileEnd + docSize),
        }
      : null,
  };
}

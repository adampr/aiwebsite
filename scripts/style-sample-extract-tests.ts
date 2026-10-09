/**
 * Style-sample extraction contract tests (ARCHITECTURE.md governance style
 * sample upload; src/lib/governance/style-sample.ts extractStyleSampleText).
 *
 *   npm run test:samplextract
 *
 * Pure, no server, no network. Builds real files with the libraries this repo
 * ships and reads them back through the production extractor, so an upgrade
 * of any of them is exercised end to end:
 *   - PDF: written by pdfkit (two pages, a bookmark outline), read by
 *     pdfjs-dist's legacy build (getDocument, getOutline, getPage,
 *     getTextContent) inside pdfToText.
 *   - DOCX: written by docx (a heading + body paragraphs), read by jszip
 *     (word/document.xml) inside the .docx branch.
 *   - junk bytes with a .pdf name come back as the UNREADABLE refusal, not a throw.
 * Before this file nothing ran pdfjs-dist at all (no test imported
 * style-sample.ts's PDF path). Added by the 2026-10-09 dependency-upgrade
 * train (pdfjs-dist 6.1.200 -> 6.4.299, pdfkit 0.19 -> 0.20, docx 9.7 -> 9.9).
 */
import { Document, HeadingLevel, Packer, Paragraph } from "docx";
import PDFDocument from "pdfkit";
import { extractStyleSampleText } from "../src/lib/governance/style-sample";

let failures = 0;
function ok(label: string, cond: boolean, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${cond ? "" : `\n     ${detail}`}`);
}

const P1 = "Acceptable Use Policy";
const BODY1 = "Employees must protect company devices and report suspected incidents to the service desk within one business day.";
const P2 = "Password Requirements";
const BODY2 = "Passwords must be at least fourteen characters long and must never be reused across business and personal accounts.";

function makePdf(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 72 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.outline.addItem(P1);
    doc.font("Helvetica-Bold").fontSize(20).text(P1);
    doc.moveDown();
    doc.font("Helvetica").fontSize(11).text(BODY1);
    doc.addPage();
    doc.outline.addItem(P2);
    doc.font("Helvetica-Bold").fontSize(20).text(P2);
    doc.moveDown();
    doc.font("Helvetica").fontSize(11).text(BODY2);
    doc.end();
  });
}

async function makeDocx(): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: P1, heading: HeadingLevel.HEADING_1 }),
          new Paragraph(BODY1),
          new Paragraph({ text: P2, heading: HeadingLevel.HEADING_1 }),
          new Paragraph(BODY2),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

const squash = (s: string) => s.replace(/\s+/g, " ");

async function main() {
  const pdf = await makePdf();
  ok("pdfkit wrote a PDF", pdf.subarray(0, 5).toString("latin1") === "%PDF-", pdf.subarray(0, 8).toString("latin1"));
  const r = await extractStyleSampleText("sample.pdf", pdf);
  ok("pdf: extraction ok", r.ok, JSON.stringify(r).slice(0, 300));
  if (r.ok) {
    const t = squash(r.text);
    ok("pdf: page 1 heading + body present", t.includes(P1) && t.includes(BODY1), t.slice(0, 400));
    ok("pdf: page 2 heading + body present", t.includes(P2) && t.includes(BODY2), t.slice(0, 400));
    ok("pdf: page order kept", t.indexOf(P1) < t.indexOf(P2), t.slice(0, 400));
  }

  const docx = await makeDocx();
  ok("docx wrote a zip", docx.subarray(0, 2).toString("latin1") === "PK", docx.subarray(0, 4).toString("latin1"));
  const d = await extractStyleSampleText("sample.docx", docx);
  ok("docx: extraction ok", d.ok, JSON.stringify(d).slice(0, 300));
  if (d.ok) {
    const t = squash(d.text);
    ok("docx: headings + bodies present in order", t.indexOf(P1) >= 0 && t.indexOf(BODY1) > t.indexOf(P1) && t.indexOf(P2) > t.indexOf(BODY1) && t.indexOf(BODY2) > t.indexOf(P2), t.slice(0, 400));
  }

  const junk = await extractStyleSampleText("junk.pdf", Buffer.from("this is not a pdf at all"));
  ok("junk .pdf: refused, not thrown", junk.ok === false, JSON.stringify(junk));

  console.log(failures ? `\n${failures} FAILED` : "\nall style-sample extraction checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * The framework as a .docx, in the Tax Deed Collective's house style.
 *
 * Word rather than a web page because that is what goes out: the standard this
 * matches is emailed as an attachment, opened in Word or Docs, and often
 * printed. Navy #1F3864 for the county and the section headings, gold #BF9000
 * for the document's own title — read off the standard rather than chosen.
 */
import {
  AlignmentType, BorderStyle, Document, HeadingLevel, Packer, Paragraph,
  Table, TableCell, TableRow, TextRun, WidthType,
} from "docx";
import type { Framework } from "./content";

const NAVY = "1F3864";
const GOLD = "BF9000";
const GREY = "6E766E";
const HAIR = { style: BorderStyle.SINGLE, size: 4, color: "AAAAAA" };
const CELL_BORDERS = { top: HAIR, bottom: HAIR, left: HAIR, right: HAIR };

const p = (text: string, o: any = {}) =>
  new Paragraph({
    alignment: o.align,
    spacing: { after: o.after ?? 120, before: o.before ?? 0 },
    children: [new TextRun({ text, bold: o.bold, color: o.color, size: o.size ?? 22, italics: o.italics })],
  });

function cell(text: string, o: { bold?: boolean; color?: string; width: number }) {
  return new TableCell({
    width: { size: o.width, type: WidthType.PERCENTAGE },
    borders: CELL_BORDERS,
    margins: { top: 60, bottom: 60, left: 90, right: 90 },
    children: [p(text, { bold: o.bold, color: o.color, after: 0, size: 20 })],
  });
}

export async function frameworkDocx(f: Framework): Promise<Buffer> {
  const body: (Paragraph | Table)[] = [];

  body.push(p("THE TAX DEED COLLECTIVE  |  COUNTY FRAMEWORK",
    { align: AlignmentType.RIGHT, bold: true, color: NAVY, size: 16, after: 200 }));
  body.push(p(f.countyLine, { align: AlignmentType.CENTER, bold: true, color: NAVY, size: 40, after: 100 }));
  body.push(p("TAX SALE DUE DILIGENCE FRAMEWORK",
    { align: AlignmentType.CENTER, bold: true, color: GOLD, size: 30, after: 100 }));
  body.push(p(f.auctionLine, { align: AlignmentType.CENTER, bold: true, color: NAVY, size: 26, after: 260 }));

  body.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: f.rows.map((r) => new TableRow({
      children: [
        cell(r.label, { bold: true, color: NAVY, width: 34 }),
        /*
         * The provenance mark sits in the value, not in a column of its own:
         * a ninth column of ticks would be read as decoration, where a value
         * that says it is the state's default is read as part of the fact.
         */
        cell(r.source === "ask" ? `${r.value}  [confirm with the county]`
           : r.source === "statute" ? `${r.value}  [statewide rule]`
           : r.value, { width: 66 }),
      ],
    })),
  }));

  body.push(p("Executive Auction Description",
    { bold: true, color: NAVY, size: 26, before: 320, after: 140 }));
  body.push(p(f.executive, { after: 200 }));

  for (const s of f.sections) {
    body.push(p(s.heading, { bold: true, color: NAVY, size: 26, before: 260, after: 140 }));
    for (const para of s.paragraphs) body.push(p(para, { after: 140 }));
    for (const b of s.bullets ?? []) {
      body.push(new Paragraph({
        bullet: { level: 0 },
        spacing: { after: 80 },
        children: [new TextRun({ text: b, size: 22 })],
      }));
    }
  }

  if (f.sources.length) {
    body.push(p("Sources", { bold: true, color: NAVY, size: 26, before: 260, after: 140 }));
    for (const s of f.sources) {
      body.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 70 },
        children: [new TextRun({ text: s, size: 20, color: GREY })] }));
    }
  }

  body.push(p(
    `Prepared ${f.generated}` +
    (f.asOf ? ` · county research last verified ${f.asOf}` : "") +
    ". This document is a research aid, not legal advice. Confirm every figure with the county " +
    "before committing funds.",
    { before: 320, size: 18, color: GREY, italics: true }));

  return Packer.toBuffer(new Document({
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [{ properties: { page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } },
                 children: body }],
  }));
}

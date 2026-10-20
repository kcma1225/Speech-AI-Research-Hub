import { createWriteStream } from "node:fs";
import yazl from "yazl";

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export type FixtureSlide = { title: string; body?: string; notes?: string[]; hidden?: boolean };

const sp = (type: string, paragraphs: string[]) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="${type}"/><p:cNvSpPr/><p:nvPr><p:ph type="${type}"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paragraphs.map(text => `<a:p><a:r><a:rPr lang="zh-TW"/><a:t>${text}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>`;

/**
 * Builds the XML parts of a minimal PPTX: presentation order deliberately differs from file numbering
 * (slide files are listed in reverse in the rels) so the test proves order comes from `p:sldIdLst`.
 */
export function pptxParts(slides: FixtureSlide[], extra: Record<string, string> = {}): Record<string, string> {
  const files: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`,
    "ppt/presentation.xml": `<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${100 + i}"/>`).join("")}</p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="rId${100 + i}" Type="${REL}/slide" Target="slides/slide${slides.length - i}.xml"/>`).reverse().join("")}</Relationships>`,
  };
  slides.forEach((slide, i) => {
    const n = slides.length - i;
    files[`ppt/slides/slide${n}.xml`] = `<?xml version="1.0"?><p:sld ${NS}${slide.hidden ? ' show="0"' : ""}><p:cSld><p:spTree>${sp("title", [slide.title])}${slide.body ? sp("body", [slide.body]) : ""}</p:spTree></p:cSld></p:sld>`;
    if (slide.notes) {
      files[`ppt/slides/_rels/slide${n}.xml.rels`] = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/></Relationships>`;
      files[`ppt/notesSlides/notesSlide${n}.xml`] = `<?xml version="1.0"?><p:notes ${NS}><p:cSld><p:spTree>${sp("sldImg", [])}${sp("body", slide.notes)}<p:sp><p:nvSpPr><p:cNvPr id="4" name="n"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum" idx="5"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${n}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
    }
  });
  return { ...files, ...extra };
}

export function writeZip(file: string, entries: Record<string, string | Buffer>): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, data] of Object.entries(entries)) zip.addBuffer(Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"), name);
    zip.end();
    zip.outputStream.pipe(createWriteStream(file)).on("close", () => resolve()).on("error", reject);
  });
}

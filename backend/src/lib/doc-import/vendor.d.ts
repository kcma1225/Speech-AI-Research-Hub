// Minimal typings for untyped document-import dependencies (only what doc-import uses).

declare module "@mixmark-io/domino" {
  export interface DomNode {
    nodeName: string;
    textContent: string | null;
    parentNode: DomElement | null;
    nextSibling: DomNode | null;
  }
  export interface DomElement extends DomNode {
    getAttribute(name: string): string | null;
    children: ArrayLike<DomElement>;
    closest(selector: string): DomElement | null;
    querySelector(selector: string): DomElement | null;
    /** HTMLTableElement */
    rows?: ArrayLike<DomElement>;
    /** HTMLTableRowElement */
    cells?: ArrayLike<DomElement>;
  }
  export interface DomDocument {
    title: string;
    body: DomElement | null;
    documentElement: DomElement | null;
    querySelector(selector: string): DomElement | null;
  }
  export function createDocument(html?: string, force?: boolean): DomDocument;
}

declare module "word-extractor" {
  interface WordDocument {
    getBody(options?: { filterUnicode?: boolean }): string;
    getHeaders(options?: { includeFooters?: boolean; filterUnicode?: boolean }): string;
    getFootnotes(options?: { filterUnicode?: boolean }): string;
    getTextboxes(options?: { includeHeadersAndFooters?: boolean; includeBody?: boolean; filterUnicode?: boolean }): string;
  }
  export default class WordExtractor {
    extract(source: string | Buffer): Promise<WordDocument>;
  }
}

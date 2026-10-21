import { XMLParser } from "fast-xml-parser";
import { corrupt } from "./errors.js";

/** A small ordered XML tree (namespace prefixes kept as written, e.g. "text:p"). */
export type XNode = { tag: string; attrs: Record<string, string>; children: XNode[]; text?: string };

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  commentPropName: false,
});

type Raw = Record<string, unknown>;

function convert(items: Raw[]): XNode[] {
  const out: XNode[] = [];
  for (const item of items) {
    for (const key of Object.keys(item)) {
      if (key === ":@") continue;
      if (key === "#text") {
        out.push({ tag: "#text", attrs: {}, children: [], text: String(item[key] ?? "") });
        continue;
      }
      const attrs = (item[":@"] as Record<string, unknown> | undefined) ?? {};
      const children = Array.isArray(item[key]) ? convert(item[key] as Raw[]) : [];
      out.push({ tag: key, attrs: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, String(v)])), children });
    }
  }
  return out;
}

/** Parses XML into a document node (tag "#document"). Throws `corrupt` on malformed XML. */
export function parseXml(xml: string): XNode {
  try {
    return { tag: "#document", attrs: {}, children: convert(parser.parse(xml) as Raw[]) };
  } catch {
    throw corrupt();
  }
}

/** Local name without the namespace prefix. */
export const local = (tag: string) => tag.slice(tag.indexOf(":") + 1);

/** First descendant (depth-first) whose tag matches. */
export function find(node: XNode, tag: string | ((n: XNode) => boolean)): XNode | undefined {
  const match = typeof tag === "string" ? (n: XNode) => n.tag === tag : tag;
  for (const child of node.children) {
    if (match(child)) return child;
    const hit = find(child, match);
    if (hit) return hit;
  }
  return undefined;
}

/** All descendants whose tag matches (does not descend into matches). */
export function findAll(node: XNode, tag: string | ((n: XNode) => boolean), out: XNode[] = []): XNode[] {
  const match = typeof tag === "string" ? (n: XNode) => n.tag === tag : tag;
  for (const child of node.children) {
    if (match(child)) out.push(child);
    else findAll(child, match, out);
  }
  return out;
}

export const childrenNamed = (node: XNode, tag: string) => node.children.filter((c) => c.tag === tag);
export const child = (node: XNode, tag: string) => node.children.find((c) => c.tag === tag);

/** Concatenated text of all descendant text nodes. */
export function textOf(node: XNode): string {
  if (node.tag === "#text") return node.text ?? "";
  return node.children.map(textOf).join("");
}

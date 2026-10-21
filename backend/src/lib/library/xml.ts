import { XMLParser } from "fast-xml-parser";

/** Parsed XML node: every child element is an array (uniform access); attributes are "@_name". */
export type XNode = string | { [k: string]: XNode[] | string | undefined };

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  isArray: (_name, _path, _leaf, isAttribute) => !isAttribute,
});

export function parseXml(text: string): Record<string, XNode[]> {
  return parser.parse(text) as Record<string, XNode[]>;
}

/** Child elements named `name` (namespace prefix included, e.g. "dc:title"). */
export function xKids(node: XNode | undefined, name: string): XNode[] {
  if (!node || typeof node === "string") return [];
  const v = node[name];
  return Array.isArray(v) ? v : [];
}

export const xKid = (node: XNode | undefined, ...path: string[]): XNode | undefined => {
  let cur: XNode | undefined = node;
  for (const p of path) cur = xKids(cur, p)[0];
  return cur;
};

export function xAttr(node: XNode | undefined, name: string): string | undefined {
  if (!node || typeof node === "string") return undefined;
  const v = node[`@_${name}`];
  return typeof v === "string" ? v : undefined;
}

/** All text inside a node (concatenates text and nested elements such as EndNote <style> runs). */
export function xText(node: XNode | undefined): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  let out = "";
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("@_")) continue;
    if (k === "#text") out += Array.isArray(v) ? v.map((x) => xText(x)).join("") : (v ?? "");
    else if (Array.isArray(v)) out += v.map((x) => xText(x)).join("");
  }
  return out;
}

export const xTrim = (node: XNode | undefined): string | undefined => {
  const t = xText(node).replace(/\s+/g, " ").trim();
  return t || undefined;
};

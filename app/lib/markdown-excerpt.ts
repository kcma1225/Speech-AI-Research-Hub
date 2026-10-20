import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { toString } from "mdast-util-to-string";
export function markdownExcerpt(input:string,limit=120){
  const tree=unified().use(remarkParse).use(remarkGfm).parse(input.slice(0,10000));
  return toString(tree).replace(/\s+/g," ").trim().slice(0,limit);
}

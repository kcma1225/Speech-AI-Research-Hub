/** Plain-text preview of Markdown: drops code fences, markup, links' targets and HTML, collapses whitespace. */
export function markdownExcerpt(input: string, limit = 120) {
  return input
    .slice(0, 10_000)
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, " ")
    .replace(/[*_~`|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

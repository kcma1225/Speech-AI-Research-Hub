// Untyped CommonJS plugin (MIT): https://github.com/laurent22/joplin/tree/dev/packages/turndown-plugin-gfm
declare module "@joplin/turndown-plugin-gfm" {
  type Plugin = (service: unknown) => void;
  export const gfm: Plugin;
  export const tables: Plugin;
  export const strikethrough: Plugin;
  export const taskListItems: Plugin;
  export const highlightedCodeBlock: Plugin;
}

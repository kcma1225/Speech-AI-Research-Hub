// Client-safe tag types and constants; no server imports.
export type Tag = { id: string; name: string };
export type TagWithCount = Tag & { count: number };
/** Filter token for notes without any tag. */
export const NO_TAG = "none";

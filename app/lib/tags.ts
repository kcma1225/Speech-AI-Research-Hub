import type { Queryable } from "./db";
import { listStoreTags, noteTags, ownerTags } from "./tag-store";

export { NO_TAG, type Tag, type TagWithCount } from "./tag-types";
export { tagName, isUniqueViolation } from "./tag-store";

export const listTags = (client: Queryable) => listStoreTags(client, noteTags);
export const itemTags = (client: Queryable, itemId: string) => ownerTags(client, noteTags, itemId);

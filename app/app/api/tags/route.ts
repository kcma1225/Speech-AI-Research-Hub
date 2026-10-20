import { noteTags, tagCollectionRoutes } from "@/lib/tag-store";

export const { GET, POST } = tagCollectionRoutes(noteTags);

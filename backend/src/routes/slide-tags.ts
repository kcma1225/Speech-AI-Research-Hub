import type { FastifyPluginAsync } from "fastify";
import { registerTagRoutes, slideTags } from "../lib/notes/tag-store.js";

const routes: FastifyPluginAsync = async app => {
  registerTagRoutes(app, "/slide-tags", slideTags);
};

export default routes;

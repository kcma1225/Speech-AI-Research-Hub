import type { FastifyPluginAsync } from "fastify";
import { noteTags, registerTagRoutes } from "../lib/notes/tag-store.js";

const routes: FastifyPluginAsync = async app => {
  registerTagRoutes(app, "/tags", noteTags);
};

export default routes;

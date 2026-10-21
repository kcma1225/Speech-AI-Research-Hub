/** Core agent tools (import side effects register them). Other modules register theirs from their own files. */
import "./studies.js";
import "./notes.js";
import "./library.js";
import "./search.js";
import "./decks.js";
import "./memory.js";
import "./interview.js";
import "./ask.js";

export * from "./registry.js";
export { setAgentSearchProvider, type AgentSearchHit, type AgentSearchProvider, type AgentSearchQuery } from "./search.js";
export const coreToolsRegistered = true;

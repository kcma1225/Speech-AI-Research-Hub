/** Core agent tools (import side effects register them). Other modules register theirs from their own files. */
import "./studies.js";
import "./notes.js";
import "./library.js";
import "./search.js";
import "./decks.js";
import "./papers-read.js";
import "./deck-create.js";
import "./vision-tools.js";
import "./memory.js";
import "./interview.js";
import "./ask.js";
import "./context-reads.js";
import "./more-writes.js";
import "./plan.js";

export * from "./registry.js";
export { setAgentSearchProvider, type AgentSearchHit, type AgentSearchProvider, type AgentSearchQuery } from "./search.js";
export const coreToolsRegistered = true;

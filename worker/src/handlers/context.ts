import type { Logger } from "pino";
import type { Config } from "../config.js";
import type { Storage } from "../storage.js";

export type HandlerContext = {
  jobId: string;
  config: Config;
  storage: Storage;
  log: Logger;
  /** Aborted on cancel request, lost lease or shutdown; handlers must stop child processes and return. */
  signal: AbortSignal;
  /** Per-job scratch directory (removed by the runner afterwards). */
  workDir: string;
  /** Records stage/progress; persisted with the next heartbeat (stage changes immediately). */
  progress(stage: string, percent?: number): void;
};

export type Handler = (payload: unknown, context: HandlerContext) => Promise<object>;

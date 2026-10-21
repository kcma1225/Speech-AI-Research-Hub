/** Minimal JSON line logger (pino-compatible call shape) for the ai-worker process. */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 20, info: 30, warn: 40, error: 50 };

function serialize(obj: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v instanceof Error ? { type: v.name, message: v.message, stack: v.stack } : v;
  return out;
}

export function createLogger(level: string = process.env.LOG_LEVEL ?? "info", bindings: Record<string, unknown> = {}) {
  const min = ORDER[(level as Level) in ORDER ? (level as Level) : "info"];
  const write = (lvl: Level) => (objOrMsg: unknown, msg?: string) => {
    if (ORDER[lvl] < min) return;
    const base = typeof objOrMsg === "object" && objOrMsg ? serialize(objOrMsg as Record<string, unknown>) : {};
    const text = typeof objOrMsg === "string" ? objOrMsg : msg;
    process.stdout.write(`${JSON.stringify({ level: ORDER[lvl], time: Date.now(), ...bindings, ...base, msg: text })}\n`);
  };
  const logger = {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    child: (b: Record<string, unknown>) => createLogger(level, { ...bindings, ...b }),
  };
  return logger;
}

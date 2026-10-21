/**
 * A failure caused by the job's input (unsafe path, missing manifest or file). Never retried;
 * `message` is shown to users. Anything else thrown by a handler is treated as an infrastructure
 * error and retried with backoff until `max_attempts`.
 */
export class JobInputError extends Error {
    name = "JobInputError";
}
/** Thrown when the job was cancelled or the lease was lost; the runner decides what to record. */
export class JobAbortedError extends Error {
    reason;
    name = "JobAbortedError";
    constructor(reason) {
        super(`job aborted: ${reason}`);
        this.reason = reason;
    }
}
export function abortReason(signal) {
    const reason = signal.reason;
    return reason === "cancelled" || reason === "shutdown" || reason === "lease_lost" ? reason : "cancelled";
}
export function throwIfAborted(signal) {
    if (signal.aborted)
        throw new JobAbortedError(abortReason(signal));
}
/** Delay before the next attempt: 15 s, 30 s, 60 s … capped at 10 min. `attempts` counts the failed attempt. */
export function backoffSeconds(attempts) {
    return Math.min(600, 15 * 2 ** Math.max(0, attempts - 1));
}
/** Keeps the end of a message (where tools put the actual error). */
export function tail(text, max = 4000) {
    return text.length <= max ? text : text.slice(text.length - max);
}
//# sourceMappingURL=errors.js.map
/** Today's date in Asia/Taipei as `YYYY-MM-DD`. */
export function todayTaipei() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** Whole days from today (Asia/Taipei) to `date` (`YYYY-MM-DD`): 0 today, negative when past. */
export function daysUntil(date: string): number {
  const today = Date.parse(`${todayTaipei()}T00:00:00Z`);
  return Math.round((Date.parse(`${date}T00:00:00Z`) - today) / 86_400_000);
}

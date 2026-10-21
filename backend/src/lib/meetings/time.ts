/** Time helpers (Asia/Taipei for dates shown to users). */

const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false });

/** `YYYY-MM-DD` in Asia/Taipei. */
export const taipeiDate = (at: string | Date) => dateFmt.format(new Date(at));
/** `YYYY-MM-DD HH:mm` in Asia/Taipei. */
export const taipeiDateTime = (at: string | Date) => `${taipeiDate(at)} ${timeFmt.format(new Date(at))}`;

/** 75 → "1:15", 3725 → "1:02:05". */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

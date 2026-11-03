/**
 * iPhone / iPad browsers other than Safari (Chrome, Firefox, Edge, in-app browsers such as LINE) run on Apple's embedded
 * web view, which refuses speech recognition (reported as a missing permission) and often motion sensors: the phone
 * remote then says to open the address in Safari instead of asking for a permission that cannot be given.
 */
const OTHERS: [RegExp, string][] = [
  [/CriOS\//, "Chrome"],
  [/FxiOS\//, "Firefox"],
  [/EdgiOS\//, "Edge"],
  [/OPiOS\//, "Opera"],
  [/GSA\//, "Google"],
  [/ Line\//, "LINE"],
  [/FBAN|FBAV/, "Facebook"],
  [/Instagram/, "Instagram"],
];

/** The name of the non-Safari iOS browser this page runs in, else null. */
export function iosOtherBrowser(ua = typeof navigator === "undefined" ? "" : navigator.userAgent): string | null {
  if (!/iPhone|iPad|iPod/.test(ua) && !(/Macintosh/.test(ua) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1)) return null;
  for (const [re, name] of OTHERS) if (re.test(ua)) return name;
  // Safari says "Safari/"; an embedded web view without a known name does not.
  return /Safari\//.test(ua) ? null : "App";
}

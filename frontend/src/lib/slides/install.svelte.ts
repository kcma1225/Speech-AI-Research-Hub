/**
 * 「安裝到主畫面」 for the remote PWA: Chromium's `beforeinstallprompt` (kept until used), and whether we are already
 * running installed (standalone) or on iOS, where installing is the Share sheet's 「加入主畫面」.
 */
type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

let deferred = $state<InstallPrompt | null>(null);
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPrompt;
  });
  window.addEventListener("appinstalled", () => (deferred = null));
}

export const install = {
  get available() {
    return !!deferred;
  },
  get standalone() {
    return typeof window !== "undefined" && (matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true);
  },
  get ios() {
    return typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent);
  },
  async prompt() {
    const e = deferred;
    if (!e) return false;
    deferred = null;
    await e.prompt();
    return (await e.userChoice).outcome === "accepted";
  },
};

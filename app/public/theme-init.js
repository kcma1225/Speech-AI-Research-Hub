(() => {
  const allowed = new Set(["light", "dark", "system"]);
  const stored = localStorage.getItem("theme");
  const preference = stored && allowed.has(stored) ? stored : "system";
  const dark = preference === "dark" || (preference === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.themePreference = preference;
  if (matchMedia("(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui), (display-mode: window-controls-overlay)").matches || navigator.standalone === true) document.documentElement.dataset.pwa = "true";
})();

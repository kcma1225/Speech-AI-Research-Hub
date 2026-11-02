<script lang="ts">
  import qrcode from "qrcode-generator";
  import { Copy, Smartphone, X } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { copyText } from "#lib/slides/util.ts";
  import { remoteUrl, type LinkState } from "#lib/slides/remote.ts";

  /**
   * 「用手機遙控」: the QR code / link of this presentation's phone remote (`/remote/<session>`) and how many phones
   * control it. Drawn inside the player (not in a portal) so it also shows in fullscreen.
   */
  let { sessionId, remotes, link, onclose }: { sessionId: string | null; remotes: number; link: LinkState; onclose: () => void } = $props();

  const url = $derived(sessionId ? remoteUrl(sessionId) : null);
  /** QR modules as SVG path data (no injected markup). */
  const qr = $derived.by(() => {
    if (!url) return null;
    const code = qrcode(0, "M");
    code.addData(url);
    code.make();
    const n = code.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (code.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    return { n, d };
  });
  let copied = $state(false);
  async function copy() {
    if (!url) return;
    copied = await copyText(url);
    setTimeout(() => (copied = false), 1500);
  }
</script>

<div class="w-[min(20rem,calc(100vw-2rem))] rounded-2xl border border-line bg-surface p-4 text-ink shadow-pop" role="dialog" aria-label={t("slides.remote.title")}>
  <div class="mb-3 flex items-start gap-2">
    <span class="grid size-9 shrink-0 place-items-center rounded-xl" style="background:var(--pill-sky);color:var(--pill-sky-ink)"><Smartphone class="size-4" /></span>
    <div class="min-w-0 flex-1">
      <p class="text-[14px] font-semibold">{t("slides.remote.title")}</p>
      <p class="text-[12.5px] leading-snug text-ink-3">{t("slides.remote.hint")}</p>
    </div>
    <button type="button" class="grid size-9 shrink-0 cursor-pointer place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("common.close")} onclick={onclose}><X class="size-4" /></button>
  </div>
  {#if qr && url}
    <div class="mx-auto w-48 rounded-xl bg-white p-2.5">
      <svg viewBox="-2 -2 {qr.n + 4} {qr.n + 4}" class="block size-full" role="img" aria-label={t("slides.remote.qr")} shape-rendering="crispEdges"><path d={qr.d} fill="#111" /></svg>
    </div>
    <div class="mt-3 flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2">
      <span class="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-2">{url.replace(/^https?:\/\//, "")}</span>
      <button type="button" class="inline-flex min-h-9 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2 text-[12.5px] font-medium text-ink-2 hover:bg-surface-3 hover:text-ink" onclick={copy}><Copy class="size-3.5" />{copied ? t("slides.remote.copied") : t("slides.remote.copy")}</button>
    </div>
  {:else}
    <p class="rounded-xl bg-surface-2 px-3 py-6 text-center text-[13px] text-ink-3">{link === "closed" ? t("slides.remote.offline") : t("slides.remote.connecting")}</p>
  {/if}
  <p class="mt-3 flex items-center gap-2 text-[12.5px] {remotes ? 'text-success' : 'text-ink-3'}" aria-live="polite">
    <span class="size-2 shrink-0 rounded-full {remotes ? 'bg-success' : 'bg-ink-3'}"></span>
    {remotes ? t("slides.remote.connected", { n: remotes }) : t("slides.remote.waiting")}
  </p>
</div>

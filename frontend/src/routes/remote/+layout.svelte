<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { ShieldAlert } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Spinner from "#lib/components/ui/Spinner.svelte";

  /**
   * 「簡報遙控器」 PWA (`/remote`, outside the app shell; manifest `static/remote.webmanifest`, the push service worker
   * `/sw.js` makes it installable). Signed-out visitors go to the login page and come back here.
   */
  let { children } = $props();

  $effect(() => {
    if (!session.user) void goto(`/login?next=${encodeURIComponent(page.url.pathname)}`, { replace: true });
  });
  $effect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.getRegistration("/").then((r) => r ?? navigator.serviceWorker.register("/sw.js", { scope: "/" })).catch(() => {});
  });
  // A remote control, not a document: no double-tap or pinch zoom (a quick second tap on 下一頁 zoomed the app).
  // touch-action: manipulation stops double-tap zoom everywhere; the viewport limits stop pinch on Android and focus
  // zoom on iOS; iOS ignores user-scalable for pinch, so its gesture events are cancelled.
  $effect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const before = meta?.content;
    if (meta) meta.content = `${before}, maximum-scale=1, user-scalable=no`;
    document.documentElement.classList.add("no-zoom");
    const stop = (e: Event) => e.preventDefault();
    const pinch = (e: TouchEvent) => e.touches.length > 1 && e.preventDefault();
    for (const g of ["gesturestart", "gesturechange"]) document.addEventListener(g, stop, { passive: false });
    document.addEventListener("touchmove", pinch, { passive: false });
    return () => {
      if (meta && before != null) meta.content = before;
      document.documentElement.classList.remove("no-zoom");
      for (const g of ["gesturestart", "gesturechange"]) document.removeEventListener(g, stop);
      document.removeEventListener("touchmove", pinch);
    };
  });
</script>

<svelte:head>
  <link rel="manifest" href="/remote.webmanifest" />
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-title" content={t("remote.appName")} />
  <meta name="apple-mobile-web-app-status-bar-style" content="default" />
</svelte:head>

{#if !session.user}
  <div class="grid min-h-dvh place-items-center text-ink-3"><Spinner class="size-5" /></div>
{:else if session.user.is_admin}
  <div class="grid min-h-dvh place-items-center px-6">
    <EmptyState title={t("remote.adminTitle")} hint={t("remote.adminHint")}>{#snippet icon()}<ShieldAlert />{/snippet}</EmptyState>
  </div>
{:else}
  {@render children()}
{/if}

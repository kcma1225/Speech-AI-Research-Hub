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

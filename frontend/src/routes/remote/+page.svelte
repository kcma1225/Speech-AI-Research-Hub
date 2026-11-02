<script lang="ts">
  import { ChevronRight, Download, MonitorPlay, RefreshCw, Smartphone } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import { install } from "#lib/slides/install.svelte.ts";
  import type { RemoteSessionInfo } from "#lib/slides/remote.ts";

  /** The account's presentations running right now (a player presenting on some computer); refreshed every 4 s. */
  let sessions = $state<RemoteSessionInfo[] | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);

  async function load() {
    loading = true;
    try {
      sessions = (await api.get<{ sessions: RemoteSessionInfo[] }>("/slides/remote/sessions")).sessions;
      error = null;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    void load();
    const timer = setInterval(() => document.visibilityState === "visible" && void load(), 4000);
    const onShow = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  });

  const since = (iso: string) => {
    const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
    return min < 1 ? t("remote.justNow") : t("remote.minutesAgo", { n: min });
  };
  let showIosHint = $state(false);
</script>

<svelte:head><title>{t("remote.appName")}</title></svelte:head>

<div class="min-h-dvh bg-canvas pb-[calc(24px+env(safe-area-inset-bottom))]">
  <header class="sticky top-0 z-10 border-b border-line bg-canvas/90 pt-[env(safe-area-inset-top)] backdrop-blur">
    <div class="mx-auto flex h-14 max-w-2xl items-center gap-3 px-4">
      <img src="/icons/remote-192.png" alt="" class="size-8 rounded-[10px]" />
      <div class="min-w-0 flex-1">
        <h1 class="truncate text-[15px] font-semibold">{t("remote.appName")}</h1>
        <p class="truncate text-[12px] text-ink-3">{session.user?.name}</p>
      </div>
      <Button size="icon" variant="ghost" aria-label={t("remote.refresh")} disabled={loading} onclick={load}><RefreshCw class={loading ? "animate-spin motion-reduce:animate-none" : ""} /></Button>
    </div>
  </header>

  <main class="mx-auto max-w-2xl px-4 pt-5">
    {#if !install.standalone && (install.available || install.ios)}
      <div class="mb-5 flex items-center gap-3 rounded-2xl border border-line bg-surface p-3.5">
        <span class="grid size-10 shrink-0 place-items-center rounded-xl" style="background:var(--pill-sky);color:var(--pill-sky-ink)"><Smartphone class="size-5" /></span>
        <div class="min-w-0 flex-1">
          <p class="text-[13.5px] font-medium">{t("remote.installTitle")}</p>
          <p class="text-[12.5px] text-ink-3">{showIosHint ? t("remote.installIos") : t("remote.installHint")}</p>
        </div>
        {#if install.available}
          <Button size="sm" variant="secondary" class="min-h-10" onclick={() => install.prompt()}><Download />{t("remote.install")}</Button>
        {:else}
          <Button size="sm" variant="secondary" class="min-h-10" onclick={() => (showIosHint = !showIosHint)}>{t("remote.howTo")}</Button>
        {/if}
      </div>
    {/if}

    <h2 class="mb-3 text-[13px] font-medium text-ink-3">{t("remote.live")}</h2>
    {#if sessions === null && !error}
      <div class="grid place-items-center py-16 text-ink-3"><Spinner class="size-5" /></div>
    {:else if error && !sessions}
      <p class="rounded-2xl bg-danger-soft p-4 text-[13px] text-danger" role="alert">{error}</p>
    {:else if !sessions?.length}
      <div class="rounded-[22px] border border-line bg-surface py-4">
        <EmptyState title={t("remote.noneTitle")} hint={t("remote.noneHint")}>{#snippet icon()}<MonitorPlay />{/snippet}</EmptyState>
      </div>
    {:else}
      <ul class="flex flex-col gap-3">
        {#each sessions as s (s.id)}
          <li>
            <a href="/remote/{s.id}" class="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3 transition-colors hover:bg-surface-2 active:bg-surface-3">
              <img src="/api/slides/{s.deckId}/thumbnail" alt="" class="aspect-[16/10] w-24 shrink-0 rounded-xl bg-surface-3 object-cover sm:w-32" loading="lazy" />
              <div class="min-w-0 flex-1">
                <p class="line-clamp-2 text-[14px] leading-snug font-semibold">{s.title}</p>
                <p class="mt-1 truncate text-[12.5px] text-ink-3">{s.device} · {since(s.startedAt)}</p>
                <p class="mt-0.5 text-[12.5px] text-ink-2 tabular-nums">
                  {s.total ? t("remote.pageOf", { n: s.page, total: s.total }) : t("remote.page", { n: s.page })}{#if s.remotes} · {t("remote.phones", { n: s.remotes })}{/if}
                </p>
              </div>
              <ChevronRight class="size-5 shrink-0 text-ink-3" />
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </main>
</div>

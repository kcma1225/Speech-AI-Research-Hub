<script lang="ts">
  import { Dialog, Portal } from "bits-ui";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { Maximize2, MessageSquarePlus, Rocket, Sparkles, X } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { assistantPanel } from "#lib/agent/panel.svelte.ts";
  import { pageContextFrom } from "#lib/agent/context.ts";
  import ChatView from "./ChatView.svelte";
  import ViewerSplit from "./viewer/ViewerSplit.svelte";
  import DocsMenu from "./viewer/DocsMenu.svelte";
  import { viewer } from "#lib/agent/viewer.ts";

  /**
   * Topbar 「問 AI」 button + the global slide-over assistant (a full-screen sheet on phones). The chat knows the
   * current study / note / deck / meeting from the URL and sends it as a hint with each message.
   */
  $effect(() => assistantPanel.watch());
  const session = assistantPanel.session;
  const context = $derived(pageContextFrom(page.url));
  const onAssistantPage = $derived(page.url.pathname.startsWith("/assistant"));
  // Full-screen editors (LaTeX, deck source) keep their own toolbars at the bottom on phones; no floating button there.
  const fullScreenEditor = $derived(/^\/studies\/[^/]+\/(latex\/[^/]+|decks\/[^/]+\/edit)\/?$/.test(page.url.pathname));
  // /studies/new has its own AI chat (the interview); the floating button would sit on its composer.
  const noFab = $derived(fullScreenEditor || /^\/studies\/new\/?$/.test(page.url.pathname));
  const badge = $derived(assistantPanel.pending + session.pendingCalls.length > 0 ? Math.max(assistantPanel.pending, session.pendingCalls.length) : 0);
  $effect(() => {
    // Keep the badge fresh when the panel's own run asks for approval or finishes.
    void session.run?.status;
    void assistantPanel.refreshPending();
  });

  const starters = $derived(context?.studySlug ? (["agent.suggest.page", "agent.suggest.progress"] as const) : (["agent.suggest.progress", "agent.suggest.tasks"] as const));

  function openPage() {
    const id = session.id;
    assistantPanel.open = false;
    void goto(id ? `/assistant/${id}` : "/assistant");
  }
</script>

{#if !onAssistantPage}
  <!-- Topbar button from `sm` up; on phones a floating button above the tab bar (the topbar has no room). -->
  <button
    type="button"
    onclick={() => (assistantPanel.open = true)}
    aria-label={badge ? `${t("agent.askLong")} (${badge})` : t("agent.askLong")}
    aria-haspopup="dialog"
    class="relative hidden h-10 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-[13px] font-medium text-ink-2 transition-colors hover:text-ink sm:inline-flex"
  >
    <Sparkles class="size-[17px]" /><span>{t("agent.ask")}</span>
    {#if session.conversation?.autopilot}<Rocket class="size-3.5 text-[var(--pill-butter-ink)]" aria-label={t("agent.autopilotOn")} />{/if}
    {#key badge}
      {#if badge}<span class="count absolute -top-1 -right-1 grid h-[18px] min-w-[18px] place-items-center rounded-full border-2 border-canvas bg-ink px-1 text-[10px] font-semibold text-primary-ink">{badge > 9 ? "9+" : badge}</span>{/if}
    {/key}
  </button>
  <!-- Portalled: the sticky topbar uses backdrop-filter, which would anchor `fixed` children to the header. -->
  {#if !noFab}
  <Portal>
  <button
      type="button"
      onclick={() => (assistantPanel.open = true)}
      aria-label={badge ? `${t("agent.askLong")} (${badge})` : t("agent.askLong")}
      aria-haspopup="dialog"
      class="fab fixed right-4 bottom-[calc(84px+env(safe-area-inset-bottom))] z-30 grid size-12 place-items-center rounded-full hero-gradient text-hero-ink shadow-pop sm:hidden"
    >
      <Sparkles class="size-5" />
      {#if session.conversation?.autopilot}<span class="absolute -bottom-0.5 -left-0.5 grid size-5 place-items-center rounded-full border-2 border-canvas bg-[var(--pill-butter)] text-[var(--pill-butter-ink)]"><Rocket class="size-2.5" /></span>{/if}
      {#key badge}
        {#if badge}<span class="count absolute -top-1 -right-1 grid h-[18px] min-w-[18px] place-items-center rounded-full border-2 border-canvas bg-ink px-1 text-[10px] font-semibold text-primary-ink">{badge > 9 ? "9+" : badge}</span>{/if}
      {/key}
    </button>
  </Portal>
  {/if}
{/if}

<Dialog.Root bind:open={() => assistantPanel.open, (v) => (assistantPanel.open = v)}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-[var(--overlay)] backdrop-blur-[1px] data-[state=open]:animate-[fade-in_160ms_ease-out] sm:bg-[rgb(0_0_0/0.12)]" />
    <Dialog.Content
      onOpenAutoFocus={(e) => {
        // Focus the composer, never an approve button.
        e.preventDefault();
        queueMicrotask(() => document.getElementById("agent-composer")?.focus());
      }}
      class="panel fixed inset-0 z-50 flex flex-col overflow-hidden bg-canvas outline-none sm:inset-y-3 sm:right-3 sm:left-auto sm:w-[460px] sm:rounded-[26px] sm:border sm:border-line sm:shadow-pop {viewer.open && viewer.current ? 'with-viewer' : ''}"
    >
      <header class="flex shrink-0 items-center gap-1 border-b border-line bg-surface px-2 pt-[max(8px,env(safe-area-inset-top))] pb-2 sm:pt-2">
        <span class="ml-2 grid size-8 place-items-center rounded-full hero-gradient text-hero-ink"><Sparkles class="size-4" /></span>
        <Dialog.Title class="ml-1 min-w-0 flex-1 truncate text-[14.5px] font-semibold text-ink">{session.conversation?.title || t("agent.title")}</Dialog.Title>
        <DocsMenu {session} compact />
        <button type="button" class="grid size-10 place-items-center rounded-full text-ink-2 hover:bg-surface-3" aria-label={t("agent.newChat")} title={t("agent.newChat")} onclick={() => assistantPanel.newChat()}><MessageSquarePlus class="size-4.5" /></button>
        <button type="button" class="grid size-10 place-items-center rounded-full text-ink-2 hover:bg-surface-3" aria-label={t("agent.openPage")} title={t("agent.openPage")} onclick={openPage}><Maximize2 class="size-4" /></button>
        <Dialog.Close class="grid size-10 place-items-center rounded-full text-ink-2 hover:bg-surface-3" aria-label={t("agent.close")}><X class="size-4.5" /></Dialog.Close>
      </header>
      <div class="min-h-0 flex-1">
        <ViewerSplit {session} variant="panel">
        <ChatView {session} compact {context} onCreated={(id) => assistantPanel.remember(id)}>
          {#snippet empty(send)}
            <div class="flex flex-col items-center px-2 pt-8 text-center">
              <h2 class="font-display text-[26px] leading-tight text-ink">{t("agent.welcome")}</h2>
              <p class="mt-2 text-[13px] leading-relaxed text-ink-3">{t("agent.welcomeHint")}</p>
              <div class="mt-5 flex flex-wrap justify-center gap-2">
                {#each starters as key (key)}
                  <button type="button" class="min-h-10 rounded-full border border-line bg-surface px-3.5 text-[12.5px] text-ink-2 hover:border-line-2 hover:text-ink" onclick={() => send(t(key))}>{t(key)}</button>
                {/each}
              </div>
            </div>
          {/snippet}
        </ChatView>
        </ViewerSplit>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.panel[data-state="open"]) {
    animation: agent-panel-up 240ms cubic-bezier(0.2, 0, 0, 1);
  }
  @media (min-width: 640px) {
    :global(.panel[data-state="open"]) {
      animation-name: agent-panel-left;
    }
  }
  @keyframes -global-agent-panel-left {
    from {
      transform: translateX(100%);
    }
  }
  @keyframes -global-agent-panel-up {
    from {
      transform: translateY(24px);
      opacity: 0;
    }
  }
  /* The document viewer widens the panel into chat | document from `lg`. */
  @media (min-width: 1024px) {
    :global(.panel.with-viewer) {
      width: min(1320px, calc(100vw - 24px));
    }
  }
  .count {
    animation: bump 160ms ease-out;
  }
  @keyframes bump {
    50% {
      transform: scale(1.15);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.panel[data-state="open"]),
    .count {
      animation: none;
    }
  }
</style>

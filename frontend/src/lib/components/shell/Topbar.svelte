<script lang="ts">
  import { Search } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import Kbd from "#lib/components/ui/Kbd.svelte";
  import NotificationsBell from "./NotificationsBell.svelte";
  import AiStatusBadge from "#lib/components/ai/AiStatusBadge.svelte";
  import AskAiButton from "#lib/components/agent/AskAiButton.svelte";
  import AgentRunsIndicator from "./AgentRunsIndicator.svelte";
  import UserMenu from "./UserMenu.svelte";
  import Wordmark from "./Wordmark.svelte";
  import { searchPalette } from "./search.svelte";
  import { session } from "#lib/stores/session.svelte.ts";

  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  // Search and the assistant are workspace features; admin accounts are system-only.
  const workspace = $derived(session.user?.role !== "admin");
</script>

<header class="sticky top-0 z-30 flex items-center gap-3 bg-canvas/85 px-4 pt-[max(12px,env(safe-area-inset-top))] pb-3 backdrop-blur-xl sm:px-6 lg:static lg:bg-transparent lg:px-0 lg:pt-6 lg:pb-0 lg:backdrop-blur-none">
  <div class="lg:hidden"><Wordmark /></div>
  {#if workspace}<button
    type="button"
    onclick={() => (searchPalette.open = true)}
    aria-keyshortcuts={mac ? "Meta+K" : "Control+K"}
    class="hidden h-11 w-full max-w-[440px] items-center gap-2.5 rounded-full border border-line bg-surface pr-2 pl-4 text-left text-sm text-ink-3 transition-colors hover:border-line-2 lg:flex"
  >
    <Search class="size-4" />
    <span class="flex-1">{t("search.placeholder")}</span>
    <Kbd>{mac ? "⌘" : "Ctrl"}</Kbd><Kbd>K</Kbd>
  </button>{/if}
  <div class="ml-auto flex items-center gap-2">
    {#if workspace}<button
      type="button"
      aria-label={t("search.short")}
      onclick={() => (searchPalette.open = true)}
      class="grid size-10 place-items-center rounded-full border border-line bg-surface text-ink-2 lg:hidden"><Search class="size-[18px]" /></button
    >
    <AgentRunsIndicator />
    <AskAiButton />{/if}
    <AiStatusBadge />
    <NotificationsBell />
    <UserMenu />
  </div>
</header>

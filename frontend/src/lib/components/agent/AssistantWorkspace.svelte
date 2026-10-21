<script lang="ts">
  import { goto } from "$app/navigation";
  import { untrack } from "svelte";
  import { MessagesSquare, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, Sparkles, Trash2, MessageSquarePlus } from "@lucide/svelte";
  import { DropdownMenu } from "bits-ui";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { ChatSession } from "#lib/agent/chat.svelte.ts";
  import ChatView from "./ChatView.svelte";
  import ConversationList from "./ConversationList.svelte";

  /**
   * /assistant and /assistant/:id — conversation list (collapsible sidebar from `lg`, remembered, Ctrl/⌘+Shift+B;
   * a sheet below) + chat.
   */
  let { conversationId = null }: { conversationId?: string | null } = $props();
  const session = new ChatSession("chat");
  let listOpen = $state(false);
  let listVersion = $state(0);
  let renameOpen = $state(false);
  let renameValue = $state("");
  let deleteOpen = $state(false);

  const COLLAPSE_KEY = "hub.assistant.sidebarCollapsed";
  let collapsed = $state(readCollapsed());
  function readCollapsed() {
    try {
      return typeof localStorage !== "undefined" && localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  }
  function toggleSidebar() {
    if (!matchMedia("(min-width: 1024px)").matches) {
      listOpen = !listOpen;
      return;
    }
    collapsed = !collapsed;
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      // storage unavailable: the choice lasts for this page only
    }
  }
  function onWindowKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
      e.preventDefault();
      toggleSidebar();
    }
  }

  $effect(() => {
    const id = conversationId;
    untrack(() => {
      if (id && id !== session.id) void session.open(id);
      if (!id && session.id) session.reset();
    });
  });
  $effect(() => () => session.destroy());
  // Refresh the list when a title arrives or a run ends.
  $effect(() => {
    void session.conversation?.title;
    void session.run?.status;
    untrack(() => listVersion++);
  });

  const title = $derived(session.conversation?.title || t("agent.untitled"));
  const menuItem = "flex h-10 cursor-pointer items-center gap-2.5 rounded-xl px-3 text-[13.5px] text-ink outline-none data-[highlighted]:bg-surface-2";

  function select(id: string) {
    listOpen = false;
    void goto(`/assistant/${id}`);
  }
  function newChat() {
    listOpen = false;
    session.reset();
    void goto("/assistant");
  }
  function onRenamed(id: string, value: string) {
    if (id === session.id && session.conversation) session.conversation.title = value;
  }
  function onDeleted(id: string) {
    if (id === session.id) newChat();
  }
  async function rename() {
    const v = renameValue.trim();
    if (!v) return;
    await session.update({ title: v });
    renameOpen = false;
  }
  async function remove() {
    if (!session.id) return;
    await api.del(`/agent/conversations/${session.id}`);
    toasts.show(t("agent.deleted"), "success");
    newChat();
  }
  const starters = ["agent.suggest.progress", "agent.suggest.tasks", "agent.suggest.papers"] as const;
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="workspace grid min-h-0 grid-cols-[minmax(0,1fr)] overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-card" data-collapsed={collapsed || undefined}>
  <aside class="side hidden min-h-0 overflow-hidden bg-surface-2/60 lg:block" aria-hidden={collapsed || undefined} inert={collapsed || undefined}>
    <div class="h-full w-[288px] border-r border-line">
      <ConversationList activeId={session.id} version={listVersion} onSelect={select} onNew={newChat} onRenamed={onRenamed} onDeleted={onDeleted} />
    </div>
  </aside>
  <section class="flex min-h-0 flex-col">
    <header class="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
      <Button variant="ghost" size="icon" class="lg:hidden" aria-label={t("agent.conversations")} onclick={() => (listOpen = true)}><MessagesSquare /></Button>
      <span class="hidden lg:contents"><Button variant="ghost" size="icon" aria-label={collapsed ? t("agent.list.expand") : t("agent.list.collapse")} aria-expanded={!collapsed} aria-keyshortcuts="Control+Shift+B Meta+Shift+B" title={`${collapsed ? t("agent.list.expand") : t("agent.list.collapse")} (Ctrl/⌘+Shift+B)`} onclick={toggleSidebar}>
        {#if collapsed}<PanelLeftOpen />{:else}<PanelLeftClose />{/if}
      </Button></span>
      <h1 class="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{session.id ? title : t("agent.newChat")}</h1>
      <Button variant="ghost" size="icon" class={collapsed ? "" : "lg:hidden"} aria-label={t("agent.newChat")} title={t("agent.newChat")} onclick={newChat}><MessageSquarePlus /></Button>
      {#if session.id}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger class="grid size-10 place-items-center rounded-full text-ink-2 hover:bg-surface-3" aria-label={t("agent.conversations")}><MoreHorizontal class="size-4.5" /></DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={6} class="z-50 min-w-[180px] rounded-2xl border border-line bg-surface p-1.5 shadow-pop data-[state=open]:animate-[pop-in_140ms_ease-out]">
              <DropdownMenu.Item class={menuItem} onSelect={() => ((renameValue = session.conversation?.title ?? ""), (renameOpen = true))}><Pencil class="size-4" />{t("agent.rename")}</DropdownMenu.Item>
              <DropdownMenu.Item class="{menuItem} text-danger" onSelect={() => (deleteOpen = true)}><Trash2 class="size-4" />{t("agent.delete")}</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      {/if}
    </header>
    <div class="min-h-0 flex-1">
      <ChatView {session} onCreated={(id) => void goto(`/assistant/${id}`, { replaceState: true })}>
        {#snippet empty(send)}
          <div class="flex flex-col items-center px-2 pt-[8vh] text-center">
            <span class="grid size-14 place-items-center rounded-full hero-gradient text-hero-ink"><Sparkles class="size-6" /></span>
            <h2 class="mt-4 font-display text-[30px] leading-tight text-ink">{t("agent.welcome")}</h2>
            <p class="mt-2 max-w-md text-[13.5px] leading-relaxed text-ink-3">{t("agent.welcomeHint")}</p>
            <div class="mt-6 flex max-w-xl flex-wrap justify-center gap-2">
              {#each starters as key (key)}
                <button type="button" class="min-h-10 rounded-full border border-line bg-surface px-4 text-[13px] text-ink-2 transition-colors hover:border-line-2 hover:text-ink" onclick={() => send(t(key))}>{t(key)}</button>
              {/each}
            </div>
          </div>
        {/snippet}
      </ChatView>
    </div>
  </section>
</div>

<Sheet bind:open={listOpen} title={t("agent.conversations")}>
  <div class="-mx-5 -mb-5 h-[70dvh] sm:-mx-6"><ConversationList activeId={session.id} version={listVersion} onSelect={select} onNew={newChat} onRenamed={onRenamed} onDeleted={onDeleted} /></div>
</Sheet>

<Sheet bind:open={renameOpen} title={t("agent.renameTitle")} side="center">
  <form
    onsubmit={(e) => {
      e.preventDefault();
      void rename();
    }}
  >
    <TextField label={t("agent.rename")} bind:value={renameValue} maxlength={120} />
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (renameOpen = false)}>{t("agent.memories.cancel")}</Button>
    <Button variant="primary" disabled={!renameValue.trim()} onclick={rename}>{t("agent.memories.save")}</Button>
  {/snippet}
</Sheet>

<ConfirmDialog bind:open={deleteOpen} title={t("agent.deleteConfirm")} description={t("agent.deleteHint")} confirmLabel={t("agent.delete")} onConfirm={remove} />

<style>
  /* Fill the viewport below the top bar (and above the phone tab bar). */
  .workspace {
    height: calc(100dvh - 72px - 104px - env(safe-area-inset-bottom));
    min-height: 420px;
  }
  @media (min-width: 1024px) {
    .workspace {
      height: calc(100dvh - 140px);
      grid-template-columns: 288px minmax(0, 1fr);
      transition: grid-template-columns 220ms cubic-bezier(0.2, 0, 0, 1);
    }
    .workspace[data-collapsed] {
      grid-template-columns: 0px minmax(0, 1fr);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .workspace {
      transition: none;
    }
  }
</style>

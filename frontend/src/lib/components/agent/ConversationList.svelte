<script lang="ts">
  import { DropdownMenu } from "bits-ui";
  import { ChevronDown, Ellipsis, MessageSquarePlus, MessagesSquare, Pencil, Rocket, Search, Workflow, X } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { i18n, t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { menuContent, menuItem } from "#lib/components/ui/menu.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import DeleteMenuItem from "#lib/components/ui/DeleteMenuItem.svelte";
  import type { ConversationListItem } from "#lib/agent/types.ts";
  import { agentActivity } from "#lib/agent/activity.svelte.ts";
  import { deleteConversation, deleteDescription, loadActivity, type ConversationActivity } from "#lib/agent/delete.ts";

  /**
   * Conversation list for /assistant: 「新對話」 and search on top, then one line per conversation (title, status
   * marks, time; ⋯ for rename / delete) grouped by day (今天 / 昨天 / 本週 / 更早, each collapsible and remembered).
   * Status marks: replying (pulsing dot), approvals waiting (count), autopilot, agents / goals running for it (the
   * shell's `agentActivity`). `version` bumps force a reload.
   */
  let { activeId = null, version = 0, onSelect, onNew, onRenamed, onDeleted }: {
    activeId?: string | null;
    version?: number;
    onSelect?: (id: string) => void;
    onNew: () => void;
    onRenamed?: (id: string, title: string) => void;
    onDeleted?: (id: string) => void;
  } = $props();
  let q = $state("");
  let items = $state<ConversationListItem[] | null>(null);
  let error = $state<string | null>(null);
  let reload = $state(0);

  $effect(() => {
    void version;
    void reload;
    const query = q.trim();
    const id = setTimeout(
      () =>
        api.get<{ conversations: ConversationListItem[] }>(`/agent/conversations${query ? `?q=${encodeURIComponent(query)}` : ""}`).then(
          (r) => ((items = r.conversations), (error = null)),
          (e) => (error = (e as Error).message),
        ),
      query ? 250 : 0,
    );
    return () => clearTimeout(id);
  });

  type GroupKey = "today" | "yesterday" | "week" | "earlier";
  type Group = { key: GroupKey; items: ConversationListItem[] };
  const groups = $derived.by((): Group[] => {
    if (!items) return [];
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterday = today - 86_400_000;
    const weekStart = today - ((now.getDay() + 6) % 7) * 86_400_000; // Monday
    const out: Group[] = [
      { key: "today", items: [] },
      { key: "yesterday", items: [] },
      { key: "week", items: [] },
      { key: "earlier", items: [] },
    ];
    for (const c of items) {
      const at = new Date(c.updated_at).getTime();
      out[at >= today ? 0 : at >= yesterday ? 1 : at >= weekStart ? 2 : 3]!.items.push(c);
    }
    return out.filter((g) => g.items.length);
  });

  // Collapsed day groups (remembered; a search shows every group).
  const FOLD_KEY = "hub.assistant.foldedGroups";
  let folded = $state<GroupKey[]>(readFolded());
  function readFolded(): GroupKey[] {
    try {
      const v = JSON.parse(localStorage.getItem(FOLD_KEY) ?? "[]");
      return Array.isArray(v) ? v.filter((x): x is GroupKey => ["today", "yesterday", "week", "earlier"].includes(x)) : [];
    } catch {
      return [];
    }
  }
  function toggleGroup(key: GroupKey) {
    folded = folded.includes(key) ? folded.filter((k) => k !== key) : [...folded, key];
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify(folded));
    } catch {
      // storage unavailable: the choice lasts for this page only
    }
  }
  const isFolded = (g: Group) => !q.trim() && folded.includes(g.key) && !g.items.some((c) => c.id === activeId);

  // Agents / goals running for a conversation (workflows started from it).
  const agentsByConv = $derived.by(() => {
    const m = new Map<string, { n: number; needsYou: boolean }>();
    for (const r of agentActivity.runs) {
      if (!r.conversation_id || r.kind === "assistant") continue;
      const prev = m.get(r.conversation_id) ?? { n: 0, needsYou: false };
      m.set(r.conversation_id, { n: prev.n + 1, needsYou: prev.needsYou || r.needs_you });
    }
    return m;
  });

  /** Today → 14:05, this week → 週二, older → 10/3 (the group heading says which day range). */
  function when(iso: string) {
    const d = new Date(iso);
    const now = new Date();
    const locale = i18n.locale === "en" ? "en-US" : "zh-TW";
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
    if (now.getTime() - d.getTime() < 6 * 86_400_000) return d.toLocaleDateString(locale, { weekday: "short" });
    return d.toLocaleDateString(locale, { month: "numeric", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "2-digit" } : {}) });
  }

  let renameId = $state<string | null>(null);
  let renameOpen = $state(false);
  let renameValue = $state("");
  let deleteId = $state<string | null>(null);
  const deleteTitle = $derived(deleteId ? (items?.find((c) => c.id === deleteId)?.title ?? "") : "");
  let deleteOpen = $state(false);
  let deleteActivity = $state<ConversationActivity | null>(null);
  async function askDelete(id: string) {
    deleteId = id;
    deleteActivity = null;
    deleteOpen = true;
    const a = await loadActivity(id);
    if (deleteId === id) deleteActivity = a;
  }
  let saving = $state(false);

  async function rename() {
    const v = renameValue.trim();
    if (!v || !renameId || saving) return;
    saving = true;
    try {
      await api.patch(`/agent/conversations/${renameId}`, { title: v });
      onRenamed?.(renameId, v);
      renameOpen = false;
      reload++;
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      saving = false;
    }
  }
  async function remove() {
    const id = deleteId;
    if (!id) return;
    try {
      await deleteConversation(id, deleteActivity, (a) => (deleteActivity = a));
      toasts.show(t("agent.deleted"), "success");
      items = items?.filter((c) => c.id !== id) ?? null;
      onDeleted?.(id);
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <div class="flex flex-col gap-1.5 px-2 pt-1 pb-2">
    <button type="button" class="new inline-flex h-9 w-full items-center gap-2 rounded-full border border-line bg-surface px-3.5 text-[13px] font-medium text-ink shadow-card transition-colors hover:border-line-2" onclick={onNew}><MessageSquarePlus class="size-4" />{t("agent.newChat")}</button>
    <label class="relative block">
      <span class="sr-only">{t("agent.searchConversations")}</span>
      <Search class="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-ink-3" />
      <input bind:value={q} type="text" inputmode="search" placeholder={t("agent.searchConversations")} class="h-9 w-full rounded-full border border-transparent bg-[var(--soft)] pr-8 pl-8.5 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-line-2 focus:bg-surface" />
      {#if q}<button type="button" class="absolute top-1/2 right-0.5 grid size-8 -translate-y-1/2 place-items-center rounded-full text-ink-3 hover:text-ink" aria-label={t("common.close")} onclick={() => (q = "")}><X class="size-3.5" /></button>{/if}
    </label>
  </div>
  <nav class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2" aria-label={t("agent.conversations")}>
    {#if error}
      <p class="px-2.5 py-2 text-[13px] text-danger">{error}</p>
    {:else if !items}
      <div class="flex flex-col gap-1 pt-1" aria-busy="true">{#each [0, 1, 2, 3, 4] as i (i)}<div class="h-8 animate-pulse rounded-full bg-[var(--soft)]"></div>{/each}</div>
    {:else if !items.length}
      <div class="flex flex-col items-center px-3 py-8 text-center">
        <span class="grid size-10 place-items-center rounded-full bg-[var(--soft)] text-ink-3"><MessagesSquare class="size-4.5" /></span>
        {#if q.trim()}
          <p class="mt-3 text-[13px] font-medium text-ink-2">{t("agent.list.noMatch")}</p>
        {:else}
          <p class="mt-3 text-[13px] font-medium text-ink-2">{t("agent.noConversations")}</p>
          <p class="mt-1 text-[12px] leading-relaxed text-ink-3">{t("agent.noConversationsHint")}</p>
        {/if}
      </div>
    {:else}
      {#each groups as g (g.key)}
        {@const shut = isFolded(g)}
        <section class="mb-1" aria-labelledby="conv-group-{g.key}">
          <h3 class="sticky top-0 z-[1] bg-[color-mix(in_srgb,var(--list-bg,var(--canvas))_94%,transparent)] backdrop-blur-sm">
            <button
              type="button"
              id="conv-group-{g.key}"
              class="group/h flex h-8 w-full items-center gap-1 rounded-lg px-2.5 text-[11.5px] font-medium tracking-wide text-ink-3 hover:text-ink-2"
              aria-expanded={!shut}
              onclick={() => toggleGroup(g.key)}
            >
              <span>{t(`agent.list.${g.key}`)}</span>
              {#if shut}<span class="tabular-nums opacity-80">· {t("agent.list.groupCount", { n: g.items.length })}</span>{/if}
              <ChevronDown class="ml-auto size-3.5 opacity-0 transition-[transform,opacity] group-hover/h:opacity-100 group-focus-visible/h:opacity-100 {shut ? '-rotate-90 opacity-100' : ''}" aria-hidden="true" />
            </button>
          </h3>
          {#if !shut}
            <ul class="flex flex-col gap-px">
              {#each g.items as c (c.id)}
                {@const agents = agentsByConv.get(c.id)}
                <li class="row group relative">
                  <a
                    href="/assistant/{c.id}"
                    onclick={(e) => {
                      if (onSelect) {
                        e.preventDefault();
                        onSelect(c.id);
                      }
                    }}
                    aria-current={c.id === activeId ? "page" : undefined}
                    title={c.last_text ? `${c.title || t("agent.untitled")}\n${c.last_text}` : undefined}
                    class="link flex h-9 items-center gap-2 rounded-full pr-2.5 pl-3 text-[13px] text-ink-2 transition-colors hover:bg-surface/70 hover:text-ink aria-[current=page]:bg-surface aria-[current=page]:font-medium aria-[current=page]:text-ink aria-[current=page]:shadow-card"
                  >
                    <span class="min-w-0 flex-1 truncate">{c.title || t("agent.untitled")}</span>
                    <span class="marks flex shrink-0 items-center gap-1.5">
                      {#if c.autopilot}<Rocket class="size-3.5 text-[var(--pill-butter-ink)]" aria-label={t("agent.autopilotOn")} />{/if}
                      {#if agents}<span class="inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums {agents.needsYou ? 'text-[var(--pill-peach-ink)]' : 'pulsing text-[var(--pill-sky-ink)]'}" title={agents.needsYou ? t("agent.list.needsYou") : t("agent.list.agents", { n: agents.n })} aria-label={agents.needsYou ? t("agent.list.needsYou") : t("agent.list.agents", { n: agents.n })}><Workflow class="size-3.5" />{#if agents.n > 1}{agents.n}{/if}</span>{/if}
                      {#if c.pending}<span class="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-ink px-1 text-[10.5px] font-semibold text-primary-ink tabular-nums" title={t("agent.list.waiting")} aria-label={t("agent.consent.several", { n: c.pending })}>{c.pending}</span>
                      {:else if c.run_status === "running"}<span class="dot size-2 rounded-full bg-[var(--pill-mint-ink)]" title={t("agent.list.running")} aria-label={t("agent.list.running")}></span>{/if}
                      <span class="time text-[11.5px] text-ink-3 tabular-nums">{when(c.updated_at)}</span>
                    </span>
                  </a>
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger class="more absolute top-1/2 right-1 grid size-7 -translate-y-1/2 place-items-center rounded-full bg-surface text-ink-3 hover:text-ink data-[state=open]:text-ink" aria-label={t("agent.list.actions")}><Ellipsis class="size-4" /></DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content align="end" sideOffset={4} class="{menuContent} w-44">
                        <DropdownMenu.Item class={menuItem} onSelect={() => ((renameId = c.id), (renameValue = c.title ?? ""), (renameOpen = true))}><Pencil />{t("agent.rename")}</DropdownMenu.Item>
                        <DeleteMenuItem label={t("agent.delete")} onSelect={() => askDelete(c.id)} />
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {/each}
    {/if}
  </nav>
  <div class="shrink-0 px-2 pt-1 pb-[max(8px,env(safe-area-inset-bottom))]">
    <a href="/assistant/workflows" class="flex h-9 items-center gap-2 rounded-full px-3 text-[13px] text-ink-3 transition-colors hover:bg-surface/70 hover:text-ink"><Workflow class="size-4" />{t("wf.title")}</a>
  </div>
</div>

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
    <Button variant="primary" loading={saving} disabled={!renameValue.trim()} onclick={rename}>{t("agent.memories.save")}</Button>
  {/snippet}
</Sheet>

<ConfirmDialog bind:open={deleteOpen} title={deleteTitle ? t("crud.conversation.deleteTitle", { title: deleteTitle }) : t("agent.deleteConfirm")} description={deleteDescription(deleteActivity)} confirmLabel={t("agent.delete")} onConfirm={remove} />

<style>
  /* The ⋯ button covers the time: on hover / focus (fine pointers); touch keeps it visible and the time hidden. */
  .row :global(.more) {
    opacity: 0;
    pointer-events: none;
    transition: opacity 120ms;
  }
  .row:hover :global(.more),
  .row:focus-within :global(.more),
  .row :global(.more[data-state="open"]) {
    opacity: 1;
    pointer-events: auto;
  }
  .row:hover .time,
  .row:focus-within .time {
    visibility: hidden;
  }
  @media (pointer: coarse) {
    .link {
      min-height: 44px;
      padding-right: 44px;
    }
    .row :global(.more) {
      opacity: 1;
      pointer-events: auto;
      width: 36px;
      height: 36px;
      background: transparent;
    }
    .row .time,
    .row:hover .time,
    .row:focus-within .time {
      visibility: visible;
    }
  }
  /* The ⋯ button keeps the active row's surface. */
  .row:has(.link[aria-current="page"]) :global(.more) {
    background: var(--surface);
  }
  .row:not(:has(.link[aria-current="page"])):hover :global(.more) {
    background: color-mix(in srgb, var(--surface) 70%, var(--canvas));
  }
  .dot,
  .pulsing {
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot,
    .pulsing {
      animation: none;
    }
    .row :global(.more) {
      transition: none;
    }
  }
</style>

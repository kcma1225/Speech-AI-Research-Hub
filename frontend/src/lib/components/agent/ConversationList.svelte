<script lang="ts">
  import { DropdownMenu } from "bits-ui";
  import { Ellipsis, MessageSquarePlus, MessagesSquare, Pencil, Rocket, Search, Trash2, X } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { relativeTime, t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { menuContent, menuItem } from "#lib/components/ui/menu.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { ConversationListItem } from "#lib/agent/types.ts";

  /**
   * Conversation list for /assistant: search on top, conversations grouped by day (今天 / 昨天 / 本週 / 更早), rename and
   * delete from each row's ⋯ menu, and 「新對話」 in a sticky footer. `version` bumps force a reload.
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

  type Group = { key: "today" | "yesterday" | "week" | "earlier"; items: ConversationListItem[] };
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

  let renameId = $state<string | null>(null);
  let renameOpen = $state(false);
  let renameValue = $state("");
  let deleteId = $state<string | null>(null);
  let deleteOpen = $state(false);
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
      await api.del(`/agent/conversations/${id}`);
      toasts.show(t("agent.deleted"), "success");
      items = items?.filter((c) => c.id !== id) ?? null;
      onDeleted?.(id);
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <div class="p-3 pb-2">
    <label class="relative block">
      <span class="sr-only">{t("agent.searchConversations")}</span>
      <Search class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-3" />
      <input bind:value={q} type="text" inputmode="search" placeholder={t("agent.searchConversations")} class="h-10 w-full rounded-full border border-line bg-surface pr-9 pl-10 text-[14px] text-ink outline-none placeholder:text-ink-3 focus:border-ink" />
      {#if q}<button type="button" class="absolute top-1/2 right-1 grid size-8 -translate-y-1/2 place-items-center rounded-full text-ink-3 hover:text-ink" aria-label={t("common.close")} onclick={() => (q = "")}><X class="size-3.5" /></button>{/if}
    </label>
  </div>
  <nav class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3" aria-label={t("agent.conversations")}>
    {#if error}
      <p class="px-3 py-2 text-[13px] text-danger">{error}</p>
    {:else if !items}
      <div class="flex flex-col gap-2 px-1" aria-busy="true">{#each [0, 1, 2, 3] as i (i)}<div class="h-14 animate-pulse rounded-2xl bg-surface-2"></div>{/each}</div>
    {:else if !items.length}
      <div class="flex flex-col items-center px-4 py-10 text-center">
        <span class="grid size-12 place-items-center rounded-full bg-surface-3 text-ink-3"><MessagesSquare class="size-5" /></span>
        {#if q.trim()}
          <p class="mt-3 text-[13.5px] font-medium text-ink-2">{t("agent.list.noMatch")}</p>
        {:else}
          <p class="mt-3 text-[13.5px] font-medium text-ink-2">{t("agent.noConversations")}</p>
          <p class="mt-1 text-[12.5px] leading-relaxed text-ink-3">{t("agent.noConversationsHint")}</p>
        {/if}
      </div>
    {:else}
      {#each groups as g (g.key)}
        <section class="mb-2" aria-labelledby="conv-group-{g.key}">
          <h3 id="conv-group-{g.key}" class="sticky top-0 z-[1] bg-[color-mix(in_srgb,var(--surface-2)_92%,transparent)] px-3 pt-2 pb-1 text-[11.5px] font-semibold tracking-wide text-ink-3 backdrop-blur-sm">{t(`agent.list.${g.key}`)}</h3>
          <ul class="flex flex-col gap-0.5">
            {#each g.items as c (c.id)}
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
                  class="flex min-h-14 flex-col justify-center gap-0.5 rounded-2xl py-2 pr-11 pl-3 transition-colors hover:bg-surface-3/70 aria-[current=page]:bg-surface-3"
                >
                  <span class="flex items-center gap-1.5">
                    <span class="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{c.title || t("agent.untitled")}</span>
                    {#if c.autopilot}<Rocket class="size-3.5 shrink-0 text-[var(--pill-butter-ink)]" aria-label={t("agent.autopilotOn")} />{/if}
                    {#if c.pending}<span class="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-ink px-1.5 text-[11px] font-semibold text-primary-ink" title={t("agent.list.waiting")} aria-label={t("agent.consent.several", { n: c.pending })}>{c.pending}</span>
                    {:else if c.run_status === "running"}<span class="dot size-2 shrink-0 rounded-full bg-[var(--pill-mint-ink)]" title={t("agent.list.running")} aria-label={t("agent.list.running")}></span>{/if}
                  </span>
                  <span class="flex items-center gap-2 text-[12px] text-ink-3"><span class="min-w-0 flex-1 truncate">{c.last_text ?? ""}</span><span class="shrink-0 tabular-nums">{relativeTime(c.updated_at)}</span></span>
                </a>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger class="more absolute top-1/2 right-1.5 grid size-9 -translate-y-1/2 place-items-center rounded-full text-ink-3 hover:bg-surface hover:text-ink data-[state=open]:bg-surface data-[state=open]:opacity-100" aria-label={t("agent.list.actions")}><Ellipsis class="size-4" /></DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content align="end" sideOffset={4} class="{menuContent} w-44">
                      <DropdownMenu.Item class={menuItem} onSelect={() => ((renameId = c.id), (renameValue = c.title ?? ""), (renameOpen = true))}><Pencil />{t("agent.rename")}</DropdownMenu.Item>
                      <DropdownMenu.Item class="{menuItem} text-danger [&_svg]:text-danger" onSelect={() => ((deleteId = c.id), (deleteOpen = true))}><Trash2 />{t("agent.delete")}</DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    {/if}
  </nav>
  <div class="sticky bottom-0 shrink-0 border-t border-line bg-[color-mix(in_srgb,var(--surface-2)_94%,transparent)] p-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur-sm">
    <button type="button" class="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-ink px-4 text-sm font-medium text-primary-ink transition-opacity hover:opacity-90" onclick={onNew}><MessageSquarePlus class="size-4" />{t("agent.newChat")}</button>
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

<ConfirmDialog bind:open={deleteOpen} title={t("agent.deleteConfirm")} description={t("agent.deleteHint")} confirmLabel={t("agent.delete")} onConfirm={remove} />

<style>
  /* Fine pointers: the ⋯ button appears on hover / focus; touch keeps it visible. */
  @media (pointer: fine) {
    .row :global(.more) {
      opacity: 0;
      transition: opacity 120ms;
    }
    .row:hover :global(.more),
    .row:focus-within :global(.more) {
      opacity: 1;
    }
  }
  .dot {
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot {
      animation: none;
    }
    .row :global(.more) {
      transition: none;
    }
  }
</style>

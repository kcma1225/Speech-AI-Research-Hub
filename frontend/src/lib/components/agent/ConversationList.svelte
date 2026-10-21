<script lang="ts">
  import { MessageSquarePlus, Search, Rocket } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { relativeTime, t } from "#lib/i18n.svelte.ts";
  import type { ConversationListItem } from "#lib/agent/types.ts";

  /** Conversation list for /assistant (newest first, searchable). `version` bumps force a reload. */
  let { activeId = null, version = 0, onSelect, onNew }: { activeId?: string | null; version?: number; onSelect?: (id: string) => void; onNew: () => void } = $props();
  let q = $state("");
  let items = $state<ConversationListItem[] | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    void version;
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
</script>

<div class="flex h-full min-h-0 flex-col">
  <div class="flex flex-col gap-2 p-3">
    <button type="button" class="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-ink px-4 text-sm font-medium text-primary-ink" onclick={onNew}><MessageSquarePlus class="size-4" />{t("agent.newChat")}</button>
    <label class="relative block">
      <span class="sr-only">{t("agent.searchConversations")}</span>
      <Search class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-3" />
      <input bind:value={q} type="search" placeholder={t("agent.searchConversations")} class="h-10 w-full rounded-full border border-line bg-surface pr-3 pl-10 text-[14px] text-ink outline-none placeholder:text-ink-3 focus:border-ink" />
    </label>
  </div>
  <nav class="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label={t("agent.conversations")}>
    {#if error}
      <p class="px-3 py-2 text-[13px] text-danger">{error}</p>
    {:else if !items}
      <div class="flex flex-col gap-2 px-1" aria-busy="true">{#each [0, 1, 2] as i (i)}<div class="h-14 animate-pulse rounded-2xl bg-surface-2"></div>{/each}</div>
    {:else if !items.length}
      <div class="px-3 py-6 text-center"><p class="text-[13.5px] font-medium text-ink-2">{t("agent.noConversations")}</p><p class="mt-1 text-[12.5px] text-ink-3">{t("agent.noConversationsHint")}</p></div>
    {:else}
      <ul class="flex flex-col gap-0.5">
        {#each items as c (c.id)}
          <li>
            <a
              href="/assistant/{c.id}"
              onclick={(e) => {
                if (onSelect) {
                  e.preventDefault();
                  onSelect(c.id);
                }
              }}
              aria-current={c.id === activeId ? "page" : undefined}
              class="flex min-h-14 flex-col justify-center gap-0.5 rounded-2xl px-3 py-2 transition-colors hover:bg-surface-2 aria-[current=page]:bg-surface-3"
            >
              <span class="flex items-center gap-1.5">
                <span class="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{c.title || t("agent.untitled")}</span>
                {#if c.autopilot}<Rocket class="size-3.5 shrink-0 text-[var(--pill-butter-ink)]" aria-label={t("agent.autopilotOn")} />{/if}
                {#if c.pending}<span class="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-ink px-1.5 text-[11px] font-semibold text-primary-ink" aria-label={t("agent.consent.several", { n: c.pending })}>{c.pending}</span>{/if}
              </span>
              <span class="flex items-center gap-2 text-[12px] text-ink-3"><span class="min-w-0 flex-1 truncate">{c.last_text ?? ""}</span><span class="shrink-0">{relativeTime(c.updated_at)}</span></span>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </nav>
</div>

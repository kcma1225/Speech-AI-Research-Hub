<script lang="ts">
  import { Bot, Check, CheckCheck, Sparkles, User, X } from "@lucide/svelte";
  import { relativeTime, t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import type { SuggestionReview } from "./review.svelte.ts";
  import type { LiveHunk } from "./types.ts";
  import WordDiff from "./WordDiff.svelte";

  /**
   * Side list of pending suggestions (shared by every editor that reviews suggestions): per suggestion a header
   * with 全部接受 / 全部拒絕 and 「剩 N 處」, per hunk a word diff with 接受 / 拒絕; stale hunks can only be rejected.
   * `onReveal` scrolls the editor to a hunk.
   */
  let { review, onReveal }: { review: SuggestionReview; onReveal?: (h: LiveHunk) => void } = $props();

  const groups = $derived(
    review.list
      .map(s => ({ s, hunks: review.live.filter(h => h.suggestionId === s.id) }))
      .filter(g => g.hunks.length),
  );
  const sourceIcon = { ai: Sparkles, autopilot: Bot, user: User } as const;
</script>

<div class="flex flex-col gap-3">
  {#if !review.canReview && groups.length}
    <p class="rounded-xl bg-surface-2 px-3 py-2 text-[12.5px] text-ink-3">{t("suggest.readOnly")}</p>
  {/if}
  {#each groups as { s, hunks } (s.id)}
    {@const Icon = sourceIcon[s.source]}
    {@const open = hunks.filter(h => !h.stale).length}
    <section class="rounded-2xl border border-line bg-surface p-3" aria-label={s.title || t("suggest.untitled")}>
      <header class="flex items-start gap-2">
        <span class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-surface-2 text-ink-2"><Icon class="size-3.5" /></span>
        <div class="min-w-0 flex-1">
          <p class="truncate text-[13.5px] font-semibold text-ink">{s.title || t("suggest.untitled")}</p>
          <p class="text-[12px] text-ink-3">{t(`suggest.source.${s.source}`)}{s.creator_name ? ` · ${s.creator_name}` : ""} · {relativeTime(s.created_at)}</p>
        </div>
        <Pill size="sm" tone={open ? "butter" : "stone"}>{t("suggest.left", { n: open })}</Pill>
      </header>
      {#if review.canReview}
        <div class="mt-2.5 flex flex-wrap gap-1.5">
          <Button size="sm" variant="primary" disabled={!open || review.busy} onclick={() => review.acceptAll(s.id)}><CheckCheck />{t("suggest.acceptAll")}</Button>
          <Button size="sm" variant="ghost" disabled={review.busy} onclick={() => review.rejectAll(s.id)}><X />{t("suggest.rejectAll")}</Button>
        </div>
      {/if}
      <ol class="mt-2.5 flex flex-col gap-2">
        {#each hunks as h (h.hunkId)}
          <li class="group rounded-xl border px-2.5 py-2 transition-colors {review.focus === h.hunkId ? 'border-ink/40 bg-surface-2' : 'border-line/70'} {h.stale ? 'opacity-80' : ''}">
            <button type="button" class="block w-full text-left" onclick={() => { review.setFocus(h.hunkId); onReveal?.(h); }} aria-label={t("suggest.reveal")}>
              <WordDiff before={h.before} after={h.after} />
            </button>
            <div class="mt-1.5 flex items-center gap-1.5">
              {#if h.stale}<span class="mr-auto text-[11.5px] font-medium text-ink-3">{t("suggest.stale")}</span>{:else}<span class="mr-auto"></span>{/if}
              {#if review.canReview}
                {#if !h.stale}
                  <button type="button" class="inline-flex h-10 min-w-10 items-center justify-center gap-1 rounded-full px-3 text-[12.5px] font-semibold text-ink hover:bg-surface-3 disabled:opacity-50 sm:h-8" disabled={review.busy} onclick={() => review.accept(h)}><Check class="size-3.5" />{t("suggest.accept")}</button>
                {/if}
                <button type="button" class="inline-flex h-10 min-w-10 items-center justify-center gap-1 rounded-full px-3 text-[12.5px] font-medium text-ink-3 hover:bg-surface-3 hover:text-ink disabled:opacity-50 sm:h-8" disabled={review.busy} onclick={() => review.reject(h)}><X class="size-3.5" />{t("suggest.reject")}</button>
              {/if}
            </div>
          </li>
        {/each}
      </ol>
    </section>
  {:else}
    <p class="px-1 py-6 text-center text-[13px] text-ink-3">{t("suggest.none")}</p>
  {/each}
</div>

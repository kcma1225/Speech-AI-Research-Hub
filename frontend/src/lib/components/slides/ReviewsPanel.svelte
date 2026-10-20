<script lang="ts">
  import { MessageSquareQuote, Reply } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { formatDate, relativeTime, t } from "#lib/i18n.svelte.ts";
  import Avatar from "#lib/components/ui/Avatar.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Textarea from "#lib/components/ui/Textarea.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { SlideReply, SlideReview } from "#lib/slides/types.ts";

  let { projectId, reviews = $bindable(), canReview, canReply, highlight = null }: {
    projectId: string;
    reviews: SlideReview[];
    canReview: boolean;
    canReply: boolean;
    highlight?: string | null;
  } = $props();

  let draft = $state("");
  let posting = $state(false);
  let replyingTo = $state<string | null>(null);
  let replyDraft = $state("");
  let replying = $state(false);

  async function post() {
    if (!draft.trim()) return;
    posting = true;
    try {
      const { review } = await api.post<{ review: SlideReview }>(`/slides/${projectId}/reviews`, { body: draft.trim() });
      reviews = [...reviews, review];
      draft = "";
      toasts.show(t("slides.review.added"), "success");
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      posting = false;
    }
  }

  async function reply(review: SlideReview) {
    if (!replyDraft.trim()) return;
    replying = true;
    try {
      const { reply } = await api.post<{ reply: SlideReply }>(`/slides/${projectId}/reviews/${review.id}/replies`, { body: replyDraft.trim() });
      reviews = reviews.map(r => (r.id === review.id ? { ...r, replies: [...r.replies, reply] } : r));
      replyDraft = "";
      replyingTo = null;
      toasts.show(t("slides.review.replied"), "success");
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      replying = false;
    }
  }

  const submitOnMod = (fn: () => void) => (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      fn();
    }
  };
</script>

{#snippet entry(author: string, at: string, body: string, small = false)}
  <div class="flex gap-3">
    <Avatar name={author} size={small ? 26 : 32} class="ring-0" />
    <div class="min-w-0 flex-1">
      <div class="flex items-baseline gap-2">
        <span class="truncate text-[13.5px] font-medium text-ink">{author}</span>
        <time class="shrink-0 text-[12px] text-ink-3" datetime={at} title={formatDate(at, { dateStyle: "medium", timeStyle: "short" })}>{relativeTime(at)}</time>
      </div>
      <p class="mt-1 text-[13.5px] leading-relaxed break-words whitespace-pre-wrap text-ink-2">{body}</p>
    </div>
  </div>
{/snippet}

<div class="flex flex-col gap-4">
  {#if !reviews.length}
    <EmptyState title={t("slides.review.empty")} hint={canReview ? undefined : t("slides.review.emptyHint")}>{#snippet icon()}<MessageSquareQuote />{/snippet}</EmptyState>
  {:else}
    <ul class="flex flex-col gap-3">
      {#each reviews as review (review.id)}
        <li
          id="review-{review.id}"
          class="scroll-mt-24 rounded-2xl border p-3.5 transition-[border-color,box-shadow,background-color] duration-700 {highlight === review.id ? 'border-ink bg-surface-2 shadow-[0_0_0_3px_var(--surface-3)]' : 'border-line'}"
        >
          {@render entry(review.author, review.created_at, review.body)}
          {#if review.replies.length}
            <ul class="mt-3 ml-4 flex flex-col gap-3 border-l-2 border-line pl-3.5">
              {#each review.replies as r (r.id)}<li>{@render entry(r.author, r.created_at, r.body, true)}</li>{/each}
            </ul>
          {/if}
          {#if canReply}
            {#if replyingTo === review.id}
              <div class="mt-3 flex flex-col gap-2">
                <Textarea bind:value={replyDraft} rows={3} placeholder={t("slides.review.replyPlaceholder")} maxlength={10000} onkeydown={submitOnMod(() => reply(review))} />
                <div class="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onclick={() => (replyingTo = null)}>{t("action.cancel")}</Button>
                  <Button size="sm" variant="primary" loading={replying} disabled={!replyDraft.trim()} onclick={() => reply(review)}>{t("slides.review.replySubmit")}</Button>
                </div>
              </div>
            {:else}
              <div class="mt-2.5 flex items-center gap-2 pl-11">
                <Button size="sm" variant="ghost" class="-ml-3" onclick={() => ((replyingTo = review.id), (replyDraft = ""))}><Reply />{t("slides.review.reply")}</Button>
                {#if !review.replies.length}<Pill tone="butter" size="sm">{t("slides.review.pending")}</Pill>{/if}
              </div>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if canReview}
    <div class="flex flex-col gap-2 border-t border-line pt-4">
      <Textarea bind:value={draft} rows={3} placeholder={t("slides.review.placeholder")} maxlength={10000} onkeydown={submitOnMod(post)} />
      <div class="flex justify-end">
        <Button variant="primary" size="sm" loading={posting} disabled={!draft.trim()} onclick={post}>{t("slides.review.submit")}</Button>
      </div>
    </div>
  {/if}
</div>

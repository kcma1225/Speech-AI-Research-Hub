<script lang="ts">
  import { DropdownMenu } from "bits-ui";
  import { Ellipsis, FileText, MessageSquareQuote, PencilLine, Reply, Trash2 } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { formatDate, relativeTime, t } from "#lib/i18n.svelte.ts";
  import Avatar from "#lib/components/ui/Avatar.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Switch from "#lib/components/ui/Switch.svelte";
  import Textarea from "#lib/components/ui/Textarea.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import { menuContent, menuItem, menuSeparator } from "#lib/components/ui/menu.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import type { SlideReply, SlideReview, SlideVersion } from "#lib/slides/types.ts";

  /**
   * Reviews of a deck. Page reviews are grouped by (version, page) — the shown version first — and
   * general reviews (no page, including all reviews written before pages existed) come last.
   * `onJump` moves the player to a review's page.
   */
  let { projectId, reviews = $bindable(), canReview, canReply, highlight = null, version = null, versions = [], page = 1, onJump }: {
    projectId: string;
    reviews: SlideReview[];
    canReview: boolean;
    canReply: boolean;
    highlight?: string | null;
    /** The version shown in the player (its pages are what the composer refers to). */
    version?: SlideVersion | null;
    versions?: SlideVersion[];
    /** Current page of the player. */
    page?: number;
    onJump?: (review: SlideReview) => void;
  } = $props();

  const pageCount = $derived(version?.pageCount ?? 0);
  let filter = $state<"all" | "page">("all");
  let onPage = $state(true);
  const versionNumber = (id: string | null) => versions.find(v => v.id === id)?.version ?? null;

  type Group = { key: string; page: number | null; versionId: string | null; current: boolean; items: SlideReview[] };
  const groups = $derived.by(() => {
    const map = new Map<string, Group>();
    for (const r of reviews) {
      if (filter === "page" && !(r.page === page && r.versionId === version?.id)) continue;
      const key = r.page === null ? "general" : `${r.versionId ?? "-"}:${r.page}`;
      let g = map.get(key);
      if (!g) map.set(key, (g = { key, page: r.page, versionId: r.versionId, current: r.versionId === version?.id, items: [] }));
      g.items.push(r);
    }
    const rank = (g: Group) => (g.page === null ? 3 : g.current ? 0 : versionNumber(g.versionId) !== null ? 1 : 2);
    return [...map.values()].sort((a, b) => rank(a) - rank(b) || (versionNumber(b.versionId) ?? 0) - (versionNumber(a.versionId) ?? 0) || (a.page ?? 0) - (b.page ?? 0));
  });
  const onThisPage = $derived(reviews.filter(r => r.page === page && r.versionId === version?.id).length);
  function groupLabel(g: Group) {
    if (g.page === null) return t("slides.review.general");
    const n = versionNumber(g.versionId);
    return g.current || n === null ? t("slides.review.pageN", { n: g.page }) : t("slides.review.pageOf", { n: g.page, v: n });
  }
  const canJump = (g: Group) => g.page !== null && Boolean(onJump) && (g.current || versions.some(v => v.id === g.versionId && v.pageCount));

  let draft = $state("");
  let posting = $state(false);
  let replyingTo = $state<string | null>(null);
  let replyDraft = $state("");
  let replying = $state(false);

  async function post() {
    if (!draft.trim()) return;
    posting = true;
    try {
      const bindPage = Boolean(pageCount && onPage && version);
      const body = bindPage ? { body: draft.trim(), page, versionId: version!.id } : { body: draft.trim() };
      const { review } = await api.post<{ review: SlideReview }>(`/slides/${projectId}/reviews`, body);
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

  // Own content: the author edits or deletes their review / reply (the server enforces it too).
  type Target = { kind: "review" | "reply"; id: string; reviewId: string; body: string };
  let editing = $state<Target | null>(null);
  let editDraft = $state("");
  let saving = $state(false);
  let removing = $state<Target | null>(null);
  let removeOpen = $state(false);
  const mine = (authorId: string) => authorId === session.user?.id;
  const targetUrl = (x: Target) => `/slides/${projectId}/reviews/${x.reviewId}${x.kind === "reply" ? `/replies/${x.id}` : ""}`;

  async function saveEdit() {
    const x = editing;
    if (!x || !editDraft.trim()) return;
    saving = true;
    try {
      const result = await api.patch<{ review?: { body: string; edited_at: string }; reply?: { body: string; edited_at: string } }>(targetUrl(x), { body: editDraft.trim() });
      const updated = (result.review ?? result.reply)!;
      reviews = reviews.map(r =>
        x.kind === "review"
          ? r.id === x.id ? { ...r, ...updated } : r
          : r.id === x.reviewId ? { ...r, replies: r.replies.map(p => (p.id === x.id ? { ...p, ...updated } : p)) } : r,
      );
      editing = null;
      toasts.show(t(x.kind === "review" ? "crud.review.saved" : "crud.reply.saved"), "success");
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      saving = false;
    }
  }
  async function remove() {
    const x = removing;
    if (!x) return;
    await api.del(targetUrl(x));
    reviews = x.kind === "review" ? reviews.filter(r => r.id !== x.id) : reviews.map(r => (r.id === x.reviewId ? { ...r, replies: r.replies.filter(p => p.id !== x.id) } : r));
    toasts.show(t(x.kind === "review" ? "crud.review.deleted" : "crud.reply.deleted"), "success");
  }

  const submitOnMod = (fn: () => void) => (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      fn();
    }
  };
</script>

{#snippet item(review: SlideReview)}
  <li
    id="review-{review.id}"
    class="scroll-mt-24 rounded-2xl border p-3.5 transition-[border-color,box-shadow,background-color] duration-700 {highlight === review.id ? 'border-ink bg-surface-2 shadow-[0_0_0_3px_var(--surface-3)]' : 'border-line'}"
  >
    {@render entry({ kind: "review", id: review.id, reviewId: review.id, body: review.body }, review.author, review.author_id, review.created_at, review.edited_at ?? null)}
    {#if review.replies.length}
      <ul class="mt-3 ml-4 flex flex-col gap-3 border-l-2 border-line pl-3.5">
        {#each review.replies as r (r.id)}<li>{@render entry({ kind: "reply", id: r.id, reviewId: review.id, body: r.body }, r.author, r.author_id, r.created_at, r.edited_at ?? null, true)}</li>{/each}
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
{/snippet}

{#snippet entry(x: Target, author: string, authorId: string, at: string, editedAt: string | null, small = false)}
  <div class="flex gap-3">
    <Avatar name={author} size={small ? 26 : 32} class="ring-0" />
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2">
        <span class="truncate text-[13.5px] font-medium text-ink">{author}</span>
        <time class="shrink-0 text-[12px] text-ink-3" datetime={at} title={formatDate(at, { dateStyle: "medium", timeStyle: "short" })}>{relativeTime(at)}</time>
        {#if editedAt}<span class="shrink-0 text-[12px] text-ink-3" title={formatDate(editedAt, { dateStyle: "medium", timeStyle: "short" })}>· {t("crud.edited")}</span>{/if}
        {#if mine(authorId) && editing?.id !== x.id}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger class="-my-2 -mr-2 ml-auto grid size-10 shrink-0 cursor-pointer place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={t("crud.more")} title={t("crud.more")}>
              <Ellipsis class="size-4" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={4} class={menuContent}>
                <DropdownMenu.Item class={menuItem} onSelect={() => ((editing = x), (editDraft = x.body))}><PencilLine />{t(x.kind === "review" ? "crud.review.edit" : "crud.reply.edit")}</DropdownMenu.Item>
                <DropdownMenu.Separator class={menuSeparator} />
                <DropdownMenu.Item class="{menuItem} text-danger [&_svg]:text-danger" onSelect={() => ((removing = x), (removeOpen = true))}><Trash2 />{t(x.kind === "review" ? "crud.review.delete" : "crud.reply.delete")}</DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        {/if}
      </div>
      {#if editing?.id === x.id}
        <div class="mt-2 flex flex-col gap-2">
          <Textarea bind:value={editDraft} rows={3} maxlength={10000} aria-label={t(x.kind === "review" ? "crud.review.edit" : "crud.reply.edit")} onkeydown={submitOnMod(saveEdit)} />
          <div class="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onclick={() => (editing = null)}>{t("action.cancel")}</Button>
            <Button size="sm" variant="primary" loading={saving} disabled={!editDraft.trim() || editDraft.trim() === x.body} onclick={saveEdit}>{t("crud.save")}</Button>
          </div>
        </div>
      {:else}
        <p class="mt-1 text-[13.5px] leading-relaxed break-words whitespace-pre-wrap text-ink-2">{x.body}</p>
      {/if}
    </div>
  </div>
{/snippet}

<div class="flex flex-col gap-4">
  {#if pageCount && reviews.length}
    <Segmented
      bind:value={filter}
      label={t("slides.review.filter")}
      class="w-full"
      options={[
        { value: "all", label: t("slides.review.filterAll", { n: reviews.length }) },
        { value: "page", label: t("slides.review.filterPage", { n: page, count: onThisPage }) },
      ]}
    />
  {/if}
  {#if !reviews.length}
    <EmptyState title={t("slides.review.empty")} hint={canReview ? undefined : t("slides.review.emptyHint")}>{#snippet icon()}<MessageSquareQuote />{/snippet}</EmptyState>
  {:else if !groups.length}
    <p class="py-6 text-center text-[13px] text-ink-3">{t("slides.review.noneOnPage", { n: page })}</p>
  {:else}
    <div class="flex flex-col gap-5">
      {#each groups as g (g.key)}
        <section class="flex flex-col gap-2.5">
          <div class="flex items-center gap-2 px-0.5">
            {#if canJump(g)}
              <button
                type="button"
                class="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium transition-colors {g.current && g.page === page ? 'bg-ink text-canvas' : 'bg-surface-3 text-ink-2 hover:text-ink'}"
                title={t("slides.review.jump")}
                onclick={() => onJump?.(g.items[0]!)}
              >
                <FileText class="size-3.5" />{groupLabel(g)}
              </button>
            {:else}
              <span class="inline-flex h-7 items-center rounded-full px-1 text-[12.5px] font-medium text-ink-3">{groupLabel(g)}</span>
            {/if}
            <span class="h-px flex-1 bg-line"></span>
            <span class="text-[12px] text-ink-3 tabular-nums">{g.items.length}</span>
          </div>
          <ul class="flex flex-col gap-3">
            {#each g.items as review (review.id)}
              {@render item(review)}
            {/each}
          </ul>
        </section>
      {/each}
    </div>
  {/if}

  {#if canReview}
    <div class="flex flex-col gap-2 border-t border-line pt-4">
      {#if pageCount}
        <div class="flex items-center justify-between gap-3 px-0.5">
          <span class="text-[13px] text-ink-2">{onPage ? t("slides.review.aboutPage", { n: page }) : t("slides.review.aboutDeck")}</span>
          <Switch bind:checked={onPage} label={t("slides.review.bindPage")} />
        </div>
      {/if}
      <Textarea bind:value={draft} rows={3} placeholder={pageCount && onPage ? t("slides.review.placeholderPage", { n: page }) : t("slides.review.placeholder")} maxlength={10000} onkeydown={submitOnMod(post)} />
      <div class="flex justify-end">
        <Button variant="primary" size="sm" loading={posting} disabled={!draft.trim()} onclick={post}>{t("slides.review.submit")}</Button>
      </div>
    </div>
  {/if}
</div>

<ConfirmDialog
  bind:open={removeOpen}
  title={t(removing?.kind === "reply" ? "crud.reply.deleteTitle" : "crud.review.deleteTitle")}
  description={t(removing?.kind === "reply" ? "crud.reply.deleteDescription" : "crud.review.deleteDescription")}
  confirmLabel={t("crud.delete")}
  onConfirm={remove}
/>

<script lang="ts" module>
  export type ReviewFix = { file_id: string; path: string; find: string; replace: string; line: number };
  export type ReviewIssue = {
    id: string;
    page: number | null;
    severity: "high" | "medium" | "low";
    category: string;
    title: string;
    detail: string;
    suggestion: string;
    path: string | null;
    line: number | null;
    fix: ReviewFix | null;
  };
  export type LayoutReview = { summary: string; issues: ReviewIssue[]; pages: number[]; truncated: boolean; created_at: string };
</script>

<script lang="ts">
  import { Check, FileCode2, Lightbulb, SquareArrowOutUpRight, WandSparkles } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Pill, { type Tone } from "#lib/components/ui/Pill.svelte";

  /** Results of an AI layout review: summary + issues (severity, page, category, source location, optional fix). */
  let {
    review,
    onSuggest,
    onGoto,
    onPage,
    thumb,
  }: {
    review: LayoutReview;
    /** Creates a suggestion from a verified fix; resolves when done. */
    onSuggest?: (issue: ReviewIssue) => Promise<void>;
    onGoto?: (issue: ReviewIssue) => void;
    onPage?: (page: number) => void;
    /** Image URL of a page (small preview next to the issue). */
    thumb?: (page: number) => string | null;
  } = $props();

  let busy = $state<string | null>(null);
  let done = $state<Set<string>>(new Set());
  const tone: Record<ReviewIssue["severity"], Tone> = { high: "rose", medium: "butter", low: "stone" };

  async function suggest(issue: ReviewIssue) {
    if (!onSuggest) return;
    busy = issue.id;
    try {
      await onSuggest(issue);
      done = new Set([...done, issue.id]);
    } finally {
      busy = null;
    }
  }
</script>

<div class="flex flex-col gap-4">
  <div class="rounded-2xl bg-surface-2 p-4">
    <p class="text-[12px] font-semibold tracking-wide text-ink-3 uppercase">{t("vision.summary")}</p>
    <p class="mt-1 text-[14px] leading-relaxed whitespace-pre-line text-ink">{review.summary || t("vision.noIssues")}</p>
    {#if review.truncated}<p class="mt-2 text-[12.5px] text-ink-3">{t("vision.truncatedNote")}</p>{/if}
  </div>

  <p class="text-[13px] font-semibold text-ink-2" aria-live="polite">{review.issues.length ? t("vision.issues", { n: review.issues.length }) : t("vision.noIssues")}</p>

  <ol class="flex flex-col gap-3">
    {#each review.issues as issue (issue.id)}
      {@const img = issue.page && thumb ? thumb(issue.page) : null}
      <li class="rounded-2xl border border-line bg-surface p-3.5">
        <div class="flex gap-3">
          {#if img}
            <button type="button" class="hidden h-[54px] w-24 shrink-0 overflow-hidden rounded-lg border border-line bg-surface-3 sm:block" aria-label={t("vision.gotoPage")} onclick={() => issue.page && onPage?.(issue.page)}>
              <img src={img} alt="" loading="lazy" class="h-full w-full object-cover object-top" />
            </button>
          {/if}
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-1.5">
              <Pill size="sm" tone={tone[issue.severity]}>{t(`vision.severity.${issue.severity}` as MessageKey)}</Pill>
              <Pill size="sm">{t(`vision.cat.${issue.category}` as MessageKey)}</Pill>
              {#if issue.page}
                {#if onPage}
                  <button type="button" class="inline-flex h-7 items-center gap-1 rounded-full px-2 text-[12px] font-medium text-ink-2 underline-offset-2 hover:underline" onclick={() => onPage?.(issue.page!)}>
                    {t("vision.pageN", { n: issue.page })}<SquareArrowOutUpRight class="size-3" aria-hidden="true" />
                  </button>
                {:else}
                  <span class="text-[12px] text-ink-3">{t("vision.pageN", { n: issue.page })}</span>
                {/if}
              {:else}
                <span class="text-[12px] text-ink-3">{t("vision.generalIssue")}</span>
              {/if}
            </div>
            <p class="mt-1.5 text-[14px] font-semibold text-ink">{issue.title}</p>
            {#if issue.detail}<p class="mt-1 text-[13px] leading-relaxed text-ink-2">{issue.detail}</p>{/if}
            {#if issue.suggestion}
              <p class="mt-2 flex gap-1.5 text-[13px] leading-relaxed text-ink-2">
                <Lightbulb class="mt-0.5 size-3.5 shrink-0 text-ink-3" aria-hidden="true" /><span><span class="sr-only">{t("vision.howToFix")}：</span>{issue.suggestion}</span>
              </p>
            {/if}
            {#if issue.fix}
              <div class="mt-2 overflow-hidden rounded-xl border border-line text-[12px]">
                <pre class="max-h-28 overflow-auto bg-danger-soft/60 px-3 py-2 font-mono break-all whitespace-pre-wrap text-ink-2"><span class="select-none text-danger">− </span>{issue.fix.find}</pre>
                <pre class="max-h-28 overflow-auto bg-[var(--pill-mint)] px-3 py-2 font-mono break-all whitespace-pre-wrap text-ink-2"><span class="select-none text-success">+ </span>{issue.fix.replace}</pre>
              </div>
            {/if}
            {#if issue.path || issue.fix}
              <div class="mt-2.5 flex flex-wrap items-center gap-2">
                {#if issue.path}
                  {#if onGoto}
                    <Button size="sm" variant="ghost" onclick={() => onGoto?.(issue)}><FileCode2 />{issue.line ? t("vision.at", { path: issue.path, line: issue.line }) : issue.path}</Button>
                  {:else}
                    <span class="font-mono text-[12px] text-ink-3">{issue.line ? t("vision.at", { path: issue.path, line: issue.line }) : issue.path}</span>
                  {/if}
                {/if}
                {#if issue.fix && onSuggest}
                  {#if done.has(issue.id)}
                    <span class="inline-flex h-9 items-center gap-1.5 text-[13px] font-medium text-success"><Check class="size-4" />{t("vision.suggested")}</span>
                  {:else}
                    <Button size="sm" variant="secondary" loading={busy === issue.id} disabled={busy !== null && busy !== issue.id} onclick={() => suggest(issue)}><WandSparkles />{t("vision.suggest")}</Button>
                  {/if}
                {/if}
              </div>
            {/if}
          </div>
        </div>
      </li>
    {/each}
  </ol>
  <p class="text-[12px] text-ink-3">{t("vision.disclaimer")}</p>
</div>

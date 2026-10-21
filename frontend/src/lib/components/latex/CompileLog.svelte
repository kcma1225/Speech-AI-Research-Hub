<script lang="ts">
  import { CircleCheck, CircleX, ExternalLink, LoaderCircle, Sparkles, TriangleAlert } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import AiGate from "#lib/components/ai/AiGate.svelte";
  import type { Compile, Diagnostic } from "#lib/latex/types.ts";
  import CompileBadge from "./CompileBadge.svelte";

  /**
   * Parsed compile result: errors first (with the zh-TW hint), then warnings. Clicking a row jumps to its file/line;
   * 「請 AI 解釋並修正」 asks the backend for an explanation and a suggestion on the offending lines.
   */
  let { compile, canEdit, onJump, onFix }: {
    compile: Compile | null;
    canEdit: boolean;
    onJump: (d: Diagnostic) => void;
    onFix: (d: Diagnostic, index: number) => Promise<{ explanation: string; suggested: boolean } | null>;
  } = $props();

  let fixing = $state<number | null>(null);
  let answers = $state<Record<string, { explanation: string; suggested: boolean }>>({});
  let showWarnings = $state(false);
  $effect(() => {
    void compile?.id;
    answers = {};
    fixing = null;
  });

  const jumpable = (d: Diagnostic) => !!d.file && !!d.line && !d.generated && !d.file.startsWith("<texmf>");
  async function fix(d: Diagnostic, i: number) {
    fixing = i;
    try {
      const r = await onFix(d, i);
      if (r && compile) answers = { ...answers, [`${compile.id}:${i}`]: r };
    } finally {
      fixing = null;
    }
  }
</script>

<div class="flex min-h-0 flex-col">
  {#if !compile}
    <p class="p-6 text-center text-[13px] text-ink-3">{t("latex.neverCompiled")}</p>
  {:else}
    <div class="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
      <CompileBadge status={compile.status} />
      {#if compile.duration_ms}<span class="text-[12px] text-ink-3 tabular-nums">{(compile.duration_ms / 1000).toFixed(1)} s</span>{/if}
      <span class="text-[12px] text-ink-3">{t("latex.log.counts", { errors: compile.errors.length, warnings: compile.warning_count })}</span>
      {#if compile.log_url}
        <a href={compile.log_url} target="_blank" rel="noopener" class="ml-auto inline-flex h-10 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-medium text-ink-2 hover:bg-surface-3 lg:h-8"><ExternalLink class="size-3.5" />{t("latex.log.raw")}</a>
      {/if}
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto p-2">
      {#if compile.error && (compile.status === "failed" || compile.status === "cancelled")}
        <p class="m-1 rounded-xl bg-danger-soft px-3 py-2.5 text-[13px] text-danger">{compile.error}</p>
      {/if}
      {#if compile.status === "success" && !compile.warning_count}
        <p class="flex items-center gap-2 p-4 text-[13px] text-ink-2"><CircleCheck class="size-4 text-success" />{t("latex.log.none")}</p>
      {/if}
      <ul class="flex flex-col gap-1.5" role="list">
        {#each compile.errors as d, i (i)}
          {@const answer = answers[`${compile.id}:${i}`]}
          <li class="rounded-2xl border border-line bg-surface p-3">
            <button type="button" class="flex w-full min-w-0 items-start gap-2.5 text-left disabled:cursor-default" disabled={!jumpable(d)} onclick={() => onJump(d)}>
              <CircleX class="mt-0.5 size-4 shrink-0 text-danger" />
              <span class="min-w-0 flex-1">
                <span class="block text-[13.5px] font-semibold text-ink">{d.title_zh ?? d.message}</span>
                {#if d.file}<span class="mt-0.5 block font-mono text-[11.5px] text-ink-3 {jumpable(d) ? 'underline decoration-dotted underline-offset-2' : ''}">{d.file}{d.line ? `:${d.line}` : ""}</span>{/if}
                {#if d.title_zh}<span class="mt-1 block font-mono text-[11.5px] break-words text-ink-3">{d.message}</span>{/if}
                {#if d.hint_zh}<span class="mt-1.5 block text-[12.5px] leading-relaxed text-ink-2">{d.hint_zh}</span>{/if}
                {#if d.context}<code class="mt-1.5 block overflow-x-auto rounded-lg bg-surface-2 px-2 py-1.5 font-mono text-[11.5px] whitespace-pre text-ink-2">{d.context}</code>{/if}
              </span>
            </button>
            {#if canEdit}
              <div class="mt-2 flex flex-wrap items-center gap-2 pl-6.5">
                <AiGate role="writing" inline>
                  <button
                    type="button"
                    class="inline-flex h-10 items-center gap-1.5 rounded-full bg-ink px-3 text-[12.5px] font-semibold text-surface hover:opacity-90 disabled:opacity-50 lg:h-8"
                    disabled={fixing !== null}
                    onclick={() => fix(d, i)}
                  >
                    {#if fixing === i}<LoaderCircle class="size-3.5 animate-spin motion-reduce:animate-none" />{t("latex.log.aiWorking")}{:else}<Sparkles class="size-3.5" />{t("latex.log.ai")}{/if}
                  </button>
                </AiGate>
              </div>
            {/if}
            {#if answer}
              <div class="mt-2 ml-6.5 rounded-xl bg-surface-2 p-2.5 text-[12.5px] leading-relaxed text-ink-2" role="status">
                <p class="mb-1 text-[11.5px] font-semibold text-ink-3">{t("latex.log.explanation")}</p>
                <p class="whitespace-pre-wrap">{answer.explanation}</p>
                <p class="mt-1.5 font-medium {answer.suggested ? 'text-ink' : 'text-ink-3'}">{answer.suggested ? t("latex.log.suggested") : t("latex.log.noFix")}</p>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
      {#if compile.warnings.length}
        <button type="button" class="mt-2 inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium text-ink-2 hover:bg-surface-3" aria-expanded={showWarnings} onclick={() => (showWarnings = !showWarnings)}>
          <TriangleAlert class="size-3.5" style="color:var(--pill-butter-ink)" />{t("latex.log.warnings", { n: compile.warning_count })}
        </button>
        {#if showWarnings}
          <ul class="mt-1 flex flex-col gap-1" role="list">
            {#each compile.warnings as d, i (i)}
              <li>
                <button type="button" class="flex w-full min-w-0 items-start gap-2 rounded-xl px-2.5 py-2 text-left hover:bg-surface-2 disabled:cursor-default" disabled={!jumpable(d)} onclick={() => onJump(d)}>
                  <TriangleAlert class="mt-0.5 size-3.5 shrink-0" style="color:var(--pill-butter-ink)" />
                  <span class="min-w-0 flex-1 text-[12.5px] text-ink-2">
                    {d.title_zh ?? d.message}
                    {#if d.file}<span class="ml-1 font-mono text-[11px] text-ink-3">{d.file}{d.line ? `:${d.line}` : ""}</span>{/if}
                    {#if d.hint_zh}<span class="mt-0.5 block text-[12px] text-ink-3">{d.hint_zh}</span>{/if}
                  </span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </div>
  {/if}
</div>

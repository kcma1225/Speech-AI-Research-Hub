<script lang="ts">
  import { untrack } from "svelte";
  import { Brain, ExternalLink, Globe, PenLine, Trash2, ChevronRight, Info } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Textarea from "#lib/components/ui/Textarea.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import { cardKind, toolIcon, toolTitle } from "#lib/agent/tools.ts";
  import type { ToolCall } from "#lib/agent/types.ts";

  /**
   * Consent card for one pending call (docs/research/agent-harness.md §4.1). Never auto-focuses an approve button;
   * deletes need two steps (「刪除…」 → 「確認刪除」 for 4 s); memory text is editable before saving.
   */
  let { call, onDecide, compact = false }: {
    call: ToolCall;
    onDecide: (decision: "approve" | "approve_conversation" | "deny", opts?: { reason?: string; editedArgs?: Record<string, unknown> }) => Promise<void>;
    compact?: boolean;
  } = $props();

  const kind = $derived(cardKind(call));
  const Icon = $derived(toolIcon(call.tool));
  const uid = $props.id();
  let busy = $state(false);
  let denying = $state(false);
  let reason = $state("");
  let armed = $state(false);
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let showDetails = $state(false);
  // Memory: editable text, starts with the proposal.
  let memoryText = $state(untrack(() => String(call.args.content ?? "")));
  const memoryEdited = $derived(kind === "memory" && memoryText.trim() !== String(call.args.content ?? "").trim());
  const instructionLike = $derived(/(ignore|always|never|忽略|一律|永遠|務必|https?:\/\/)/i.test(memoryText));

  const badge = $derived(
    {
      write: { label: t("agent.consent.risk.write"), cls: "bg-[var(--pill-butter)] text-[var(--pill-butter-ink)]", icon: PenLine },
      destructive: { label: t("agent.consent.risk.destructive"), cls: "bg-danger-soft text-danger", icon: Trash2 },
      memory: { label: t("agent.consent.risk.memory"), cls: "bg-[var(--pill-lilac)] text-[var(--pill-lilac-ink)]", icon: Brain },
      outbound: { label: t("agent.consent.risk.outbound"), cls: "bg-[var(--pill-sky)] text-[var(--pill-sky-ink)]", icon: Globe },
    }[kind],
  );
  const BadgeIcon = $derived(badge.icon);
  const why = $derived(typeof call.args.reason === "string" && call.args.reason ? call.args.reason : null);
  const reasonText = $derived(
    call.status === "deferred" ? t("agent.consent.reason.deferred") : call.approval_reason === "tainted" ? t("agent.consent.reason.tainted") : call.approval_reason === "outbound" ? t("agent.consent.reason.outbound") : call.approval_reason === "autopilot_limit" ? t("agent.consent.reason.autopilot_limit") : null,
  );
  const scopedLabel = $derived(call.target?.studyId ? t("agent.consent.allowConversationScoped", { target: call.target.label.split(" · ")[0]!, tool: toolTitle(call) }) : t("agent.consent.allowConversation"));
  const edits = $derived(Array.isArray(call.args.edits) ? (call.args.edits as { before: string; after: string }[]) : []);

  async function run(decision: "approve" | "approve_conversation" | "deny", opts: { reason?: string; editedArgs?: Record<string, unknown> } = {}) {
    busy = true;
    try {
      await onDecide(decision, opts);
    } catch (e) {
      toasts.show(`${t("agent.consent.failed")}：${(e as Error).message}`, "error");
    } finally {
      busy = false;
    }
  }
  function armDelete() {
    if (armed) {
      clearTimeout(armTimer);
      armed = false;
      void run("approve");
      return;
    }
    armed = true;
    armTimer = setTimeout(() => (armed = false), 4000);
  }
  $effect(() => () => clearTimeout(armTimer));
  function remember() {
    const content = memoryText.trim();
    if (!content) return;
    void run("approve", memoryEdited ? { editedArgs: { ...call.args, content } } : {});
  }
</script>

<section class="card {compact ? 'p-3.5' : 'p-4 sm:p-5'}" aria-labelledby="consent-{uid}" data-kind={kind}>
  <p class="sr-only" aria-live="polite">{t("agent.consent.announce", { tool: toolTitle(call) })}</p>
  <header class="flex items-start gap-3">
    <span class="grid size-9 shrink-0 place-items-center rounded-full bg-surface-3 text-ink"><Icon class="size-4" /></span>
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-2">
        <h3 id="consent-{uid}" class="text-[14.5px] font-semibold text-ink">{toolTitle(call)}</h3>
        <span class="inline-flex h-6 items-center gap-1 rounded-full px-2 text-[11.5px] font-semibold {badge.cls}"><BadgeIcon class="size-3" />{badge.label}</span>
      </div>
      {#if call.summary && call.summary !== toolTitle(call) && call.summary !== call.title}<p class="mt-1 text-[13.5px] leading-relaxed text-ink-2">{call.summary}</p>{/if}
    </div>
  </header>

  {#if call.target}
    <div class="mt-3">
      {#if call.target.url}
        <a href={call.target.url} target="_blank" rel="noopener" class="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[12.5px] font-medium text-ink hover:border-line-2">
          <span class="truncate">{call.target.label}</span><ExternalLink class="size-3 shrink-0 text-ink-3" />
        </a>
      {:else}
        <span class="inline-flex min-h-8 max-w-full items-center rounded-full border border-line bg-surface px-3 text-[12.5px] font-medium text-ink"><span class="truncate">{call.target.label}</span></span>
      {/if}
    </div>
  {/if}

  <!-- Preview -->
  {#if kind === "memory"}
    <div class="mt-3">
      <Textarea label={t("agent.consent.memoryText")} bind:value={memoryText} rows={2} maxlength={300} hint={t("agent.consent.memoryHint")} />
      {#if instructionLike}<p class="mt-1.5 text-[12.5px] text-danger">{t("agent.consent.instructionWarning")}</p>{/if}
    </div>
  {:else if call.tool === "search_papers_online" || call.open_world}
    <div class="mt-3 rounded-2xl bg-surface-2 p-3 text-[13px]">
      <p class="text-[12px] text-ink-3">{t("agent.consent.query")}</p>
      <p class="mt-0.5 font-medium break-words text-ink">{String(call.args.query ?? call.args.identifier ?? "")}</p>
    </div>
  {:else if edits.length}
    <ul class="mt-3 flex flex-col gap-1.5">
      {#each edits.slice(0, 3) as e, i (i)}
        <li class="rounded-2xl bg-surface-2 p-3 text-[12.5px] leading-relaxed">
          <del class="block text-danger/90 decoration-danger/50">{e.before.slice(0, 200)}</del>
          <ins class="block text-success no-underline">{e.after.slice(0, 200)}</ins>
        </li>
      {/each}
    </ul>
  {:else if typeof call.args.content_md === "string" || typeof call.args.summary_md === "string"}
    <p class="mt-3 line-clamp-4 rounded-2xl bg-surface-2 p-3 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-2">{String(call.args.content_md ?? call.args.summary_md).slice(0, 600)}</p>
  {:else if typeof call.args.detail_md === "string" && call.args.detail_md}
    <p class="mt-3 line-clamp-3 rounded-2xl bg-surface-2 p-3 text-[12.5px] text-ink-2">{call.args.detail_md}</p>
  {/if}

  {#if reasonText}
    <p class="mt-3 flex gap-2 text-[12.5px] leading-relaxed text-ink-2"><Info class="mt-0.5 size-3.5 shrink-0 text-ink-3" /><span>{reasonText}{#if call.provenance.length} {t("agent.consent.provenance", { source: call.provenance.map((p) => `〈${p}〉`).join("、") })}{/if}</span></p>
  {/if}
  {#if why}
    <p class="mt-2 text-[12.5px] text-ink-3"><span class="font-medium">{t("agent.consent.why")}：</span>{why}</p>
  {/if}

  <button type="button" class="mt-2 inline-flex min-h-8 items-center gap-1 rounded-full text-[12.5px] text-ink-3 hover:text-ink" aria-expanded={showDetails} onclick={() => (showDetails = !showDetails)}>
    <ChevronRight class="size-3.5 transition-transform duration-150 {showDetails ? 'rotate-90' : ''}" />{t("agent.tool.details")}
  </button>
  {#if showDetails}
    <pre class="mt-1 max-h-48 overflow-auto rounded-xl bg-surface-2 p-2.5 text-[12px] leading-relaxed whitespace-pre-wrap text-ink-2">{JSON.stringify(call.args, null, 2)}</pre>
  {/if}

  <!-- Actions (no autofocus anywhere) -->
  {#if denying}
    <div class="mt-3 flex flex-col gap-2">
      <TextField label={t("agent.consent.denyReason")} bind:value={reason} maxlength={500} />
      <div class="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" onclick={() => (denying = false)} disabled={busy}>{t("agent.memories.cancel")}</Button>
        <Button variant="secondary" size="sm" loading={busy} onclick={() => run("deny", { reason: reason.trim() || undefined })}>{t("agent.consent.denySend")}</Button>
      </div>
    </div>
  {:else}
    <div class="mt-3 flex flex-wrap items-center justify-end gap-2">
      {#if kind === "memory"}
        <Button variant="ghost" size="sm" disabled={busy} onclick={() => run("deny")}>{t("agent.consent.dontRemember")}</Button>
        <Button variant="primary" size="sm" loading={busy} disabled={!memoryText.trim()} onclick={remember}>{memoryEdited ? t("agent.consent.rememberEdited") : t("agent.consent.remember")}</Button>
      {:else if kind === "destructive"}
        <Button variant="ghost" size="sm" disabled={busy} onclick={() => (denying = true)}>{t("agent.consent.deny")}</Button>
        <Button variant="danger" size="sm" loading={busy} onclick={armDelete} aria-live="polite">{armed ? t("agent.consent.confirmDelete") : t("agent.consent.delete")}</Button>
      {:else}
        <Button variant="ghost" size="sm" disabled={busy} onclick={() => (denying = true)}>{t("agent.consent.deny")}</Button>
        {#if call.grantable}
          <Button variant="secondary" size="sm" disabled={busy} onclick={() => run("approve_conversation")} title={scopedLabel} class="max-w-full"><span class="truncate">{compact ? t("agent.consent.allowConversation") : scopedLabel}</span></Button>
        {/if}
        <Button variant="primary" size="sm" loading={busy} onclick={() => run("approve")}>{t("agent.consent.allow")}</Button>
      {/if}
    </div>
  {/if}
</section>

<style>
  .card {
    border-radius: 22px;
    border: 1px solid var(--line-2);
    background: var(--raised);
    box-shadow: var(--shadow-card);
    animation:
      card-in 200ms cubic-bezier(0.2, 0, 0, 1),
      attention 600ms ease-in-out 220ms 2;
  }
  .card[data-kind="destructive"] {
    border-color: color-mix(in oklab, var(--danger) 45%, var(--line));
  }
  .card[data-kind="memory"] {
    border-color: color-mix(in oklab, var(--pill-lilac-ink) 40%, var(--line));
  }
  @keyframes card-in {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }
  @keyframes attention {
    50% {
      box-shadow:
        0 0 0 4px color-mix(in oklab, var(--ink) 10%, transparent),
        var(--shadow-card);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .card {
      animation: card-fade 100ms linear;
      box-shadow:
        0 0 0 2px color-mix(in oklab, var(--ink) 12%, transparent),
        var(--shadow-card);
    }
    @keyframes card-fade {
      from {
        opacity: 0;
      }
    }
  }
</style>

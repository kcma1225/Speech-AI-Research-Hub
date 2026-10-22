<script lang="ts">
  import { Popover, Portal } from "bits-ui";
  import { page } from "$app/state";
  import { ArrowRight, Bot, ExternalLink, MessageSquare, Pause, Play, Square } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t, relativeTime } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { viewport } from "#lib/media.svelte.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import { agentActivity, type ActiveAgentRun } from "#lib/agent/activity.svelte.ts";
  import { workflowsApi } from "#lib/workflows/api.ts";
  import { ACTION_LABEL } from "#lib/agent/focus.ts";
  import { STATUS_TONE } from "#lib/components/workflows/meta.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import Pill, { type Tone } from "#lib/components/ui/Pill.svelte";
  import Progress from "#lib/components/ui/Progress.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";

  /**
   * 「N 個 Agent 執行中」 in the topbar (only while something runs or waits): opens a live overview of my workflow runs
   * and assistant runs — status, current sub-agent + activity, progress, budget, links and 暫停/繼續/停止.
   */
  const workspace = $derived(!!session.user && session.user.role !== "admin");
  $effect(() => {
    if (workspace) agentActivity.start();
    else agentActivity.stop();
  });

  let open = $state(false);
  $effect(() => agentActivity.setOpen(open));
  const runs = $derived(agentActivity.runs);
  const needs = $derived(agentActivity.needsYou);
  let busy = $state<string | null>(null);
  let stopTarget = $state<ActiveAgentRun | null>(null);
  let stopOpen = $state(false);

  const ASSISTANT_TONE: Record<string, Tone> = { running: "sky", awaiting_approval: "butter", awaiting_llm: "stone", awaiting_input: "butter" };
  const statusLabel = (r: ActiveAgentRun) => t((r.kind === "workflow" ? `wf.status.${r.status}` : `agentRuns.status.${r.status}`) as MessageKey);
  const tone = (r: ActiveAgentRun): Tone => (r.kind === "workflow" ? (STATUS_TONE[r.status as keyof typeof STATUS_TONE] ?? "stone") : (ASSISTANT_TONE[r.status] ?? "stone"));
  const roleLabel = (r: ActiveAgentRun) => {
    const role = r.current?.role;
    if (!role) return "";
    if (r.kind === "workflow") {
      const key = `wf.role.${role}` as MessageKey;
      const text = t(key);
      return text === key ? "" : text;
    }
    return "";
  };
  // Phones on /assistant: the composer sits right above the tab bar, so the floating pill rides above the composer
  // (opposite the question navigator) instead of covering its toolbar.
  let floatBottom = $state<number | null>(null);
  const onAssistant = $derived(page.url.pathname.startsWith("/assistant"));
  $effect(() => {
    if (!onAssistant || viewport.desktop || typeof ResizeObserver === "undefined") return void (floatBottom = null);
    let el: Element | null = null;
    const measure = () => {
      el = document.querySelector("main [data-chat-root] [data-chat-bottom]");
      floatBottom = el ? Math.max(0, Math.round(window.innerHeight - el.getBoundingClientRect().top + 12)) : null;
    };
    const ro = new ResizeObserver(measure);
    const mo = new MutationObserver(() => {
      const next = document.querySelector("main [data-chat-root] [data-chat-bottom]");
      if (next !== el) {
        ro.disconnect();
        if (next) ro.observe(next);
        measure();
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    measure();
    if (el) ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", measure);
    };
  });
  const progressOf = (r: ActiveAgentRun) => r.progress ?? (r.plan ? { done: r.plan.done, total: r.plan.total } : null);

  async function act(r: ActiveAgentRun, name: string, fn: () => Promise<unknown>) {
    busy = `${r.id}:${name}`;
    try {
      await fn();
      await agentActivity.refresh();
    } catch (e) {
      toasts.show(`${t("agentRuns.actionFailed")}：${(e as Error).message}`, "error");
    } finally {
      busy = null;
    }
  }
  function stop(r: ActiveAgentRun) {
    if (r.kind === "assistant" && r.conversation_id) return void act(r, "stop", () => api.post(`/agent/conversations/${r.conversation_id}/cancel`));
    stopTarget = r;
    // Close the overview first: the popover sits above the dialog layer and would swallow its clicks.
    open = false;
    stopOpen = true;
  }
  const label = $derived(needs ? `${t("agentRuns.indicator", { n: runs.length })} · ${t("agentRuns.needsYou", { n: needs })}` : t("agentRuns.indicator", { n: runs.length }));
</script>

{#snippet trigger(props: Record<string, unknown>, extra = "inline-flex")}
  <button
    {...props}
    type="button"
    aria-label={label}
    title={label}
    data-agent-indicator
    class="{extra} relative h-10 shrink-0 items-center gap-2 rounded-full border px-3 text-[13px] font-medium transition-colors {needs
      ? 'border-transparent bg-[var(--pill-butter)] text-[var(--pill-butter-ink)]'
      : 'border-line bg-surface text-ink-2 hover:text-ink'} data-[state=open]:border-ink-3"
  >
    <span class="relative grid size-4 place-items-center">
      <Bot class="size-4" />
      <span class="pulse absolute -top-0.5 -right-0.5 size-2 rounded-full {needs ? 'bg-[var(--pill-butter-ink)]' : 'bg-success'}" aria-hidden="true"></span>
    </span>
    <span class="tabular-nums sm:hidden">{runs.length}</span>
    <span class="hidden tabular-nums sm:inline">{needs ? t("agentRuns.needsYou", { n: needs }) : t("agentRuns.indicatorShort", { n: runs.length })}</span>
  </button>
{/snippet}

{#snippet list()}
  {#if !runs.length}
    <p class="px-2 py-6 text-center text-[13px] text-ink-3">{agentActivity.error ? `${t("agentRuns.loadFailed")}：${agentActivity.error}` : t("agentRuns.empty")}</p>
  {:else}
    <ul class="flex flex-col gap-2">
      {#each runs as r (r.kind + r.id)}
        {@const p = progressOf(r)}
        {@const working = r.status === "running" || r.status === "planning" || r.status === "verifying"}
        <li class="rounded-2xl border bg-surface p-3 {r.needs_you ? 'border-[var(--pill-butter-ink)]/40' : 'border-line'}" data-run-kind={r.kind}>
          <div class="flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <p class="text-[11px] tracking-wide text-ink-3 uppercase">{t(`agentRuns.kind.${r.kind}`)}{#if r.study} · {r.study.title}{/if}</p>
              <a href={r.href} class="block truncate text-[14px] font-semibold text-ink hover:underline" onclick={() => (open = false)}>{r.title || r.objective || t("agent.untitled")}</a>
            </div>
            <Pill tone={tone(r)} size="sm" dot={working}>{statusLabel(r)}</Pill>
          </div>
          {#if r.objective && r.objective !== r.title}<p class="mt-1 line-clamp-2 text-[12.5px] text-ink-2">{r.objective}</p>{/if}
          {#if r.current}
            <p class="mt-1.5 truncate text-[12.5px] text-ink-2" aria-live="polite">{#if roleLabel(r)}<span class="font-medium text-ink">{roleLabel(r)}</span> · {/if}{r.current.text}</p>
          {:else if r.plan?.current}
            <p class="mt-1.5 truncate text-[12.5px] text-ink-2">{t("agent.activity.now", { what: r.plan.current })}</p>
          {/if}
          {#if p}
            <div class="mt-2"><Progress value={p.total ? Math.round((p.done / p.total) * 100) : 0} label={r.progress ? t("agentRuns.steps", { done: p.done, total: p.total }) : t("agentRuns.plan", { done: p.done, total: p.total })} /></div>
          {/if}
          <p class="mt-1.5 flex flex-wrap gap-x-2 text-[11.5px] text-ink-3 tabular-nums">
            {#if p}<span>{r.progress ? t("agentRuns.steps", { done: p.done, total: p.total }) : t("agentRuns.plan", { done: p.done, total: p.total })}</span>{/if}
            {#if r.step}<span>{t("agentRuns.step", { step: r.step.step, max: r.step.max })}</span>{/if}
            {#if r.budget_pct !== null}<span>{t("agentRuns.budget", { pct: r.budget_pct })}</span>{/if}
            {#if r.tokens}<span>{t("agentRuns.tokens", { n: r.tokens.toLocaleString() })}</span>{/if}
            <span>{t("agentRuns.updated", { time: relativeTime(r.updated_at) })}</span>
          </p>
          <div class="mt-2 flex flex-wrap items-center gap-1">
            <!-- Deep link to the card that waits (plan / question / consent card), scrolled to and pulsed there. -->
            {#if r.action}
              <Button size="sm" variant="primary" class="min-h-10" href={r.href} data-agent-go={r.action} onclick={() => (open = false)}><ArrowRight />{t(ACTION_LABEL[r.action])}</Button>
              {#if r.kind === "workflow" && r.action === "approve_plan"}
                <Button size="sm" variant="ghost" class="min-h-10" title={t("agentRuns.quickApproveHint")} loading={busy === `${r.id}:approve`} onclick={() => act(r, "approve", async () => { await workflowsApi.approve(r.id, {}); toasts.show(t("agentRuns.quickApproved"), "success"); })}><Play />{t("agentRuns.quickApprove")}</Button>
              {/if}
            {:else}
              <Button size="sm" variant="ghost" class="min-h-10" href={r.href} onclick={() => (open = false)}><MessageSquare />{t(r.conversation_id ? "agentRuns.openConversation" : "agentRuns.go.open")}</Button>
            {/if}
            {#each r.artifacts.slice(0, 2) as a (a.kind + a.id)}
              <Button size="sm" variant="ghost" class="min-h-10 max-w-[180px]" href={a.url} onclick={() => (open = false)}><ExternalLink /><span class="truncate">{a.title}</span></Button>
            {/each}
            <span class="flex-1"></span>
            {#if r.kind === "workflow" && working}
              <Button size="sm" variant="ghost" class="min-h-10" loading={busy === `${r.id}:pause`} onclick={() => act(r, "pause", () => workflowsApi.pause(r.id))}><Pause />{t("wf.pause")}</Button>
            {:else if r.kind === "workflow" && r.status === "paused"}
              <Button size="sm" variant="ghost" class="min-h-10" loading={busy === `${r.id}:resume`} onclick={() => act(r, "resume", () => workflowsApi.resume(r.id))}><Play />{t("wf.resume")}</Button>
            {/if}
            {#if r.kind === "workflow" || r.status !== "awaiting_input"}
              <Button size="sm" variant="ghost" class="min-h-10 text-danger" loading={busy === `${r.id}:stop`} onclick={() => stop(r)}><Square />{t("agentRuns.stop")}</Button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
  <a href="/assistant/workflows" class="mt-2 flex min-h-10 items-center justify-center rounded-full text-[12.5px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink" onclick={() => (open = false)}>{t("agentRuns.viewAll")}</a>
{/snippet}

{#if workspace && (runs.length || open)}
  {#if viewport.desktop}
    <Popover.Root bind:open>
      <Popover.Trigger>
        {#snippet child({ props })}{@render trigger(props)}{/snippet}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={10} class="z-50 flex max-h-[min(620px,80dvh)] w-[420px] flex-col rounded-[24px] border border-line bg-surface-2 shadow-pop outline-none data-[state=open]:animate-[pop-in_140ms_ease-out]">
          <div class="border-b border-line px-4 py-3">
            <p class="text-[15px] font-semibold text-ink">{t("agentRuns.title")}</p>
            <p class="text-[12px] text-ink-3">{t("agentRuns.subtitle")}</p>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto p-2.5">{@render list()}</div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  {:else}
    <!-- Tablets: in the topbar. Phones: the topbar is full, so a pill floats above the tab bar (left of the Ask-AI button). -->
    {@render trigger({ onclick: () => (open = true), "data-state": open ? "open" : "closed" }, "hidden sm:inline-flex")}
    <Portal>
      <div class="fixed bottom-[calc(88px+env(safe-area-inset-bottom))] left-4 z-30 sm:hidden" style={floatBottom !== null ? `bottom:${floatBottom}px` : undefined}>
        {@render trigger({ onclick: () => (open = true), "data-state": open ? "open" : "closed" }, "inline-flex shadow-pop")}
      </div>
    </Portal>
    <Sheet bind:open title={t("agentRuns.title")} description={t("agentRuns.subtitle")}>
      <div class="-mx-1">{@render list()}</div>
    </Sheet>
  {/if}
{/if}

<ConfirmDialog
  bind:open={stopOpen}
  title={t("wf.stopConfirm")}
  description={t("wf.stopDesc")}
  confirmLabel={t("wf.stop")}
  onConfirm={() => {
    const r = stopTarget;
    if (r) void act(r, "stop", () => workflowsApi.cancel(r.id));
  }}
/>

<style>
  .pulse {
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pulse {
      animation: none;
    }
  }
</style>

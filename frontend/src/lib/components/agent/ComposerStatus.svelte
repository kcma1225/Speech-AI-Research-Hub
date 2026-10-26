<script lang="ts">
  import { CircleHelp, Clock, MessageSquare, ShieldAlert, Workflow } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import { clipLine, pendingNames, type ComposerMode } from "#lib/agent/composer.ts";

  /**
   * One line above the composer saying what the next send does (lib/agent/composer.ts), the 「改成一般對話」 toggle
   * for a workflow that waits for an answer, and the inline confirmation before a send would cancel consent cards
   * (取消它並送出 / 先處理卡片) or skip a question card.
   */
  let {
    mode,
    chatOnly = null,
    confirm = null,
    sending = false,
    onToggleChat,
    onConfirm,
    onCancelConfirm,
    onGoCard,
  }: {
    mode: ComposerMode;
    /** The waiting workflow the user switched away from (shows 「改回回答工作流程」). */
    chatOnly?: { title: string } | null;
    /** A send waiting for the user's confirmation. */
    confirm?: "pending" | "ask" | null;
    sending?: boolean;
    onToggleChat?: (chat: boolean) => void;
    onConfirm?: () => void;
    onCancelConfirm?: () => void;
    onGoCard?: () => void;
  } = $props();

  const line = $derived.by(() => {
    switch (mode.kind) {
      case "queue":
        return { icon: Clock, text: t(mode.appending ? "agent.compose.statusQueueAppend" : "agent.compose.statusQueue") };
      case "confirm_pending":
        return { icon: ShieldAlert, text: t("agent.compose.statusPending", { n: mode.items.length, names: pendingNames(mode.items) }) };
      case "answer_ask":
        return { icon: CircleHelp, text: t("agent.compose.statusAnswer", { question: clipLine(mode.question) }) };
      case "confirm_ask":
        return { icon: CircleHelp, text: t("agent.compose.statusAsk", { question: clipLine(mode.question, 50) }) };
      case "answer_workflow":
        return { icon: Workflow, text: t("agent.compose.statusWorkflow", { question: clipLine(mode.question, 120) }) };
      case "workflow_card":
        return { icon: Workflow, text: t("agent.compose.statusWorkflowCard", { question: clipLine(mode.question, 80) }) };
      default:
        return chatOnly ? { icon: MessageSquare, text: t("agent.compose.statusChatOnly") } : null;
    }
  });
</script>

{#if confirm && (mode.kind === "confirm_pending" || mode.kind === "confirm_ask")}
  <div class="mb-2 flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--pill-butter-ink)]/30 bg-[var(--pill-butter)] px-3.5 py-2.5 text-[13px] text-[var(--pill-butter-ink)]" role="alertdialog" aria-live="assertive" aria-label={t("agent.compose.handleCard")}>
    <ShieldAlert class="size-4 shrink-0" />
    <span class="min-w-0 flex-1 basis-56 font-medium">
      {mode.kind === "confirm_pending" ? t("agent.compose.confirmPending", { names: pendingNames(mode.items) }) : t("agent.compose.confirmAsk", { question: clipLine(mode.question, 60) })}
    </span>
    <span class="flex flex-wrap gap-1.5">
      <Button size="sm" variant="primary" loading={sending} onclick={onConfirm}>{t(mode.kind === "confirm_pending" ? "agent.compose.confirmPendingGo" : "agent.compose.confirmAskGo")}</Button>
      <Button size="sm" variant="outline" class="bg-surface" onclick={() => { onCancelConfirm?.(); onGoCard?.(); }}>{t(mode.kind === "confirm_pending" ? "agent.compose.handleCard" : "agent.compose.answerCard")}</Button>
    </span>
  </div>
{:else if line}
  {@const Icon = line.icon}
  <div class="mb-1.5 flex flex-wrap items-start gap-x-1.5 gap-y-1 px-2 text-[12.5px] leading-snug text-ink-3" role="status" aria-live="polite" data-composer-status={mode.kind}>
    <span class="flex min-w-0 flex-1 basis-[16rem] items-start gap-1.5"><Icon class="mt-px size-3.5 shrink-0" />
    <span class="min-w-0 flex-1 {mode.kind === 'answer_workflow' || mode.kind === 'answer_ask' ? 'font-medium text-ink-2' : ''}">{line.text}</span></span>
    {#if (mode.kind === "answer_workflow" || mode.kind === "workflow_card") && onGoCard}
      <button type="button" class="shrink-0 rounded-full px-2 py-0.5 font-medium text-ink-2 underline-offset-2 hover:underline pointer-coarse:py-2" onclick={onGoCard}>{t("agent.compose.goCard")}</button>
    {/if}
    {#if mode.kind === "answer_workflow" && onToggleChat}
      <button type="button" class="shrink-0 rounded-full border border-line px-2.5 py-0.5 font-medium text-ink-2 hover:bg-surface-3 pointer-coarse:py-2" aria-pressed="false" onclick={() => onToggleChat(true)}>{t("agent.compose.toChat")}</button>
    {:else if chatOnly && onToggleChat && mode.kind === "send"}
      <button type="button" class="shrink-0 rounded-full border border-line px-2.5 py-0.5 font-medium text-ink-2 hover:bg-surface-3 pointer-coarse:py-2" aria-pressed="true" onclick={() => onToggleChat(false)}>{t("agent.compose.toWorkflow")}</button>
    {/if}
  </div>
{/if}

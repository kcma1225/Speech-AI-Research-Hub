<script lang="ts">
  import { Clock, Paperclip, Pencil, Send, Square, Trash2 } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Textarea from "#lib/components/ui/Textarea.svelte";
  import type { QueuedMessage } from "#lib/agent/types.ts";
  import type { QueuedState } from "#lib/agent/composer.ts";

  /**
   * The message queued while the assistant was replying (server-side, `conversations.queued`): shown under the stream
   * as a dashed 「排隊中」 bubble. It can be edited, removed, or sent now — 「停止並立即送出」 while the reply runs; when a
   * card holds it, the actions of that card's rule (取消它並送出 / 先處理卡片, 當一般訊息送出 / 先回答卡片).
   */
  let {
    queued,
    status,
    pendingNames = "",
    onEdit,
    onRemove,
    onSend,
    onGoCard,
  }: {
    queued: QueuedMessage;
    status: QueuedState;
    pendingNames?: string;
    onEdit: (text: string) => Promise<void>;
    onRemove: () => Promise<void>;
    /** `supersede`: cancel the pending consent cards (the user confirmed). */
    onSend: (opts: { supersede?: boolean }) => Promise<void>;
    onGoCard?: () => void;
  } = $props();

  let editing = $state(false);
  let draft = $state("");
  let busy = $state<string | null>(null);
  let editor = $state<HTMLTextAreaElement | null>(null);

  async function act(key: string, fn: () => Promise<void>) {
    busy = key;
    try {
      await fn();
    } finally {
      busy = null;
    }
  }
  function startEdit() {
    draft = queued.text;
    editing = true;
    queueMicrotask(() => editor?.focus());
  }
  async function save() {
    if (!draft.trim()) return;
    await act("save", () => onEdit(draft.trim()));
    editing = false;
  }
  function keys(e: KeyboardEvent) {
    if (e.key === "Escape") editing = false;
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    }
  }
  const held = $derived(status !== "waiting");
</script>

<div class="flex justify-end" data-queued-message>
  <div class="flex w-full max-w-[min(92%,720px)] flex-col items-end gap-1.5">
    <div class="w-full rounded-[20px] rounded-br-md border border-dashed border-line-2 bg-surface-2 px-4 py-2.5" role="status" aria-live="polite">
      <p class="mb-1 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
        <span class="inline-flex h-6 items-center gap-1 rounded-full bg-[var(--pill-butter)] px-2 font-semibold text-[var(--pill-butter-ink)]"><Clock class="size-3.5" />{t("agent.queued.label")}</span>
        <span class={held ? "font-medium text-ink-2" : ""}>
          {#if status === "waiting"}{t("agent.queued.waiting")}
          {:else if status === "held_approval"}{t("agent.queued.heldApproval", { names: pendingNames })}
          {:else if status === "held_question"}{t("agent.queued.heldQuestion")}
          {:else}{t("agent.queued.heldError", { error: queued.error ?? "" })}{/if}
        </span>
      </p>
      {#if editing}
        <Textarea bind:value={draft} bind:ref={editor} rows={3} maxlength={20000} aria-label={t("agent.queued.edit")} onkeydown={keys} class="[&_textarea]:bg-surface" />
        <div class="flex justify-end gap-2 pt-1.5">
          <Button size="sm" variant="ghost" onclick={() => (editing = false)}>{t("agent.queued.cancelEdit")}</Button>
          <Button size="sm" variant="primary" loading={busy === "save"} disabled={!draft.trim()} onclick={() => void save()}>{t("agent.queued.save")}</Button>
        </div>
      {:else}
        <p class="text-[14.5px] leading-relaxed whitespace-pre-wrap break-words text-ink">{queued.text}</p>
        {#if queued.attachments.length}
          <p class="mt-1 flex items-center gap-1 text-[12px] text-ink-3" title={queued.attachments.map((a) => a.title).join("、")}><Paperclip class="size-3.5" />{t("agent.queued.attachments", { n: queued.attachments.length })}：<span class="truncate">{queued.attachments.map((a) => a.title).join("、")}</span></p>
        {/if}
      {/if}
    </div>
    {#if !editing}
      <div class="flex flex-wrap justify-end gap-1.5">
        {#if status === "waiting"}
          <Button size="sm" variant="outline" loading={busy === "send"} onclick={() => void act("send", () => onSend({}))}><Square class="size-3 fill-current" />{t("agent.queued.stopSend")}</Button>
        {:else if status === "held_approval"}
          <Button size="sm" variant="primary" loading={busy === "send"} onclick={() => void act("send", () => onSend({ supersede: true }))}><Send />{t("agent.compose.confirmPendingGo")}</Button>
          {#if onGoCard}<Button size="sm" variant="outline" onclick={onGoCard}>{t("agent.compose.handleCard")}</Button>{/if}
        {:else if status === "held_question"}
          <Button size="sm" variant="primary" loading={busy === "send"} onclick={() => void act("send", () => onSend({}))}><Send />{t("agent.queued.sendAsMessage")}</Button>
          {#if onGoCard}<Button size="sm" variant="outline" onclick={onGoCard}>{t("agent.compose.answerCard")}</Button>{/if}
        {:else}
          <Button size="sm" variant="primary" loading={busy === "send"} onclick={() => void act("send", () => onSend({}))}><Send />{t("agent.queued.sendNow")}</Button>
        {/if}
        <Button size="sm" variant="ghost" onclick={startEdit}><Pencil />{t("agent.queued.edit")}</Button>
        <Button size="sm" variant="ghost" loading={busy === "remove"} onclick={() => void act("remove", onRemove)}><Trash2 />{t("agent.queued.remove")}</Button>
      </div>
    {/if}
  </div>
</div>

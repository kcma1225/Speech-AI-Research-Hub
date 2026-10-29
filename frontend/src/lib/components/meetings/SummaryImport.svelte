<script lang="ts">
  import { untrack } from "svelte";
  import { FileUp, ListTodo } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Textarea from "#lib/components/ui/Textarea.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { MeetingDetail } from "#lib/meetings/types.ts";

  /**
   * Import a meeting summary written on another platform (Markdown, pasted or read from a .md / .txt file):
   * PUT /meetings/:id/summary. With studies, the analysis turns it into per-study drafts; every action item in it
   * becomes a proposed task whose assignee can be changed before the tasks are created.
   */
  let { meetingId, initial = "", hasStudies = true, onDone, onCancel }: {
    meetingId: string;
    initial?: string;
    hasStudies?: boolean;
    onDone: (next: MeetingDetail) => void | Promise<void>;
    onCancel?: () => void;
  } = $props();

  let text = $state(untrack(() => initial));
  let busy = $state(false);
  let picker = $state<HTMLInputElement | null>(null);
  const MAX = 100_000;

  async function readFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    input.value = "";
    if (!f) return;
    if (f.size > MAX * 4) return toasts.show(t("meet.sum.tooLong"), "error");
    text = (await f.text()).replace(/^﻿/, "");
  }
  async function submit() {
    busy = true;
    try {
      const next = await api.put<MeetingDetail>(`/meetings/${meetingId}/summary`, { summary_md: text });
      toasts.show(hasStudies ? t("meet.sum.importedAnalyzing") : t("meet.sum.imported"), "success");
      await onDone(next);
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex flex-col gap-3">
  <p class="text-[13px] leading-relaxed text-ink-3">{t("meet.sum.hint")}</p>
  <Textarea bind:value={text} rows={12} maxlength={MAX} label={t("meet.sum.label")} placeholder={t("meet.sum.placeholder")} class="[&_textarea]:font-mono [&_textarea]:text-[13px]" />
  <div class="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
    <div class="flex gap-2">
      <input bind:this={picker} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" class="hidden" onchange={readFile} />
      <Button variant="ghost" onclick={() => picker?.click()}><FileUp />{t("meet.sum.readFile")}</Button>
      {#if onCancel}<Button variant="ghost" onclick={onCancel}>{t("meet.cancel")}</Button>{/if}
    </div>
    <Button variant="primary" loading={busy} disabled={!text.trim() && !initial} onclick={submit}><ListTodo />{text.trim() ? (hasStudies ? t("meet.sum.convert") : t("meet.sum.save")) : t("meet.sum.remove")}</Button>
  </div>
</div>

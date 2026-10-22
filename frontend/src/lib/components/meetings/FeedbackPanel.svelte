<script lang="ts">
  import { displayName } from "#lib/people.svelte.ts";
  import { Paperclip, Pencil, Send, Trash2, X } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { relativeTime, t } from "#lib/i18n.svelte.ts";
  import MarkdownView from "#lib/components/markdown/MarkdownView.svelte";
  import Avatar from "#lib/components/ui/Avatar.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Textarea from "#lib/components/ui/Textarea.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { Feedback, MeetingDetail } from "#lib/meetings/types.ts";
  import { FEEDBACK_ACCEPT } from "#lib/meetings/util.ts";

  /** Feedback (typically the professor's): typed/pasted text and/or a file (TXT/MD/DOCX/PDF, text extracted for the analysis). */
  let { detail, onChanged }: { detail: MeetingDetail; onChanged: (next?: MeetingDetail) => void | Promise<void> } = $props();

  let body = $state("");
  let file = $state<File | null>(null);
  let input = $state<HTMLInputElement | null>(null);
  let sending = $state(false);
  let editing = $state<string | null>(null);
  let editBody = $state("");
  let removing = $state<Feedback | null>(null);
  let confirmOpen = $state(false);

  async function send() {
    if (!body.trim() && !file) return;
    sending = true;
    try {
      let next: MeetingDetail;
      if (file) {
        const form = new FormData();
        form.append("body_md", body);
        form.append("file", file, file.name);
        next = await api.post<MeetingDetail>(`/meetings/${detail.meeting.id}/feedback`, form);
      } else next = await api.post<MeetingDetail>(`/meetings/${detail.meeting.id}/feedback`, { body_md: body });
      body = "";
      file = null;
      toasts.show(t("meet.fb.sent"), "success");
      await onChanged(next);
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      sending = false;
    }
  }
  async function saveEdit(f: Feedback) {
    try {
      await onChanged(await api.patch<MeetingDetail>(`/meetings/${detail.meeting.id}/feedback/${f.id}`, { body_md: editBody }));
      editing = null;
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
  async function remove() {
    if (!removing) return;
    await onChanged(await api.del<MeetingDetail>(`/meetings/${detail.meeting.id}/feedback/${removing.id}`));
    removing = null;
  }
</script>

<div class="flex flex-col gap-4">
  {#if detail.feedback.length}
    <ul class="flex flex-col gap-3">
      {#each detail.feedback as f (f.id)}
        <li class="rounded-2xl border border-line/80 p-3.5">
          <div class="mb-2 flex items-center gap-2">
            <Avatar name={f.author_name ?? "?"} size={26} />
            <span class="min-w-0 truncate text-[13.5px] font-medium text-ink">{f.author_name ? displayName(f.author_name) : t("meet.fb.deleted")}</span>
            {#if f.author_role === "professor"}<Pill tone="lilac" size="sm">{t("meet.fb.professor")}</Pill>{/if}
            <span class="ml-auto shrink-0 text-[12px] text-ink-3">{relativeTime(f.created_at)}</span>
            {#if f.can_edit && editing !== f.id}
              <Button variant="ghost" size="icon-sm" aria-label={t("meet.fb.edit")} onclick={() => ((editing = f.id), (editBody = f.body_md))}><Pencil /></Button>
              <Button variant="ghost" size="icon-sm" aria-label={t("meet.fb.delete")} onclick={() => ((removing = f), (confirmOpen = true))}><Trash2 /></Button>
            {/if}
          </div>
          {#if editing === f.id}
            <Textarea label={t("meet.fb.edit")} bind:value={editBody} rows={4} />
            <div class="mt-2 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onclick={() => (editing = null)}>{t("meet.cancel")}</Button>
              <Button variant="primary" size="sm" onclick={() => saveEdit(f)}>{t("meet.save")}</Button>
            </div>
          {:else if f.body_md}
            <MarkdownView source={f.body_md} class="text-[14px]" />
          {/if}
          {#if f.has_file}
            <a href={f.file_url} class="mt-2 inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full border border-line-2 px-3 text-[12.5px] text-ink-2 hover:bg-surface-2">
              <Paperclip class="size-3.5 shrink-0" /><span class="truncate">{f.file_name}</span>
              {#if f.has_text}<span class="shrink-0 text-ink-3">· {t("meet.fb.textRead")}</span>{/if}
            </a>
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <p class="text-[13px] text-ink-3">{t("meet.fb.empty")}</p>
  {/if}

  <div class="flex flex-col gap-2 rounded-2xl bg-surface-2 p-3">
    <Textarea label={t("meet.fb.add")} bind:value={body} rows={3} placeholder={t("meet.fb.placeholder")} maxlength={50000} />
    <input bind:this={input} type="file" accept={FEEDBACK_ACCEPT} class="hidden" onchange={e => (file = (e.currentTarget as HTMLInputElement).files?.[0] ?? null)} />
    <div class="flex flex-wrap items-center justify-between gap-2">
      {#if file}
        <span class="inline-flex min-h-9 max-w-full items-center gap-1 rounded-full bg-surface px-3 text-[12.5px] text-ink-2">
          <Paperclip class="size-3.5 shrink-0" /><span class="truncate">{file.name}</span>
          <button type="button" class="-mr-1 grid size-8 place-items-center rounded-full hover:bg-surface-3" aria-label={t("meet.fb.removeFile")} onclick={() => (file = null)}><X class="size-3.5" /></button>
        </span>
      {:else}
        <Button variant="ghost" size="sm" onclick={() => input?.click()}><Paperclip />{t("meet.fb.attach")}</Button>
      {/if}
      <Button variant="primary" size="sm" loading={sending} disabled={!body.trim() && !file} onclick={send}><Send />{t("meet.fb.send")}</Button>
    </div>
  </div>
</div>

<ConfirmDialog bind:open={confirmOpen} title={t("meet.fb.deleteTitle")} confirmLabel={t("meet.fb.delete")} danger onConfirm={remove} />

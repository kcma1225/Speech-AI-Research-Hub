<script lang="ts">
  import { displayName } from "#lib/people.svelte.ts";
  import { diffLines } from "diff";
  import { ArrowLeft, Bot, History, RotateCcw, Sparkles } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { formatDate, relativeTime, t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import EmptyState from "#lib/components/ui/EmptyState.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { NoteVersion } from "./types.ts";

  /** Version history: list, line diff against the current text, restore (applied as a change to the live document). */
  let { open = $bindable(false), noteId, current, canEdit, onRestored }: { open?: boolean; noteId: string; current: () => string; canEdit: boolean; onRestored?: () => void } = $props();

  let versions = $state<NoteVersion[] | null>(null);
  let selected = $state<NoteVersion | null>(null);
  let loadingVersion = $state(false);
  let confirm = $state(false);
  let error = $state<string | null>(null);

  async function load() {
    try {
      versions = (await api.get<{ versions: NoteVersion[] }>(`/notes/${noteId}/versions`)).versions;
      error = null;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  $effect(() => {
    if (open) {
      selected = null;
      versions = null;
      void load();
    }
  });

  async function pick(v: NoteVersion) {
    loadingVersion = true;
    try {
      selected = (await api.get<{ version: NoteVersion }>(`/notes/${noteId}/versions/${v.id}`)).version;
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      loadingVersion = false;
    }
  }

  const parts = $derived(selected?.content_md !== undefined ? diffLines(current(), selected.content_md) : []);
  const same = $derived(parts.every(p => !p.added && !p.removed));

  async function restore() {
    if (!selected) return;
    try {
      await api.post(`/notes/${noteId}/versions/${selected.id}/restore`);
      toasts.show(t("versions.restored", { n: selected.version }), "success");
      open = false;
      onRestored?.();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
  const kindLabel = (v: NoteVersion) => v.label || t(`versions.kind.${v.kind}` as MessageKey);
</script>

<Sheet bind:open title={t("versions.title")} description={t("versions.hint")} side="right">
  {#if error}
    <EmptyState title={t("common.error")} hint={error} />
  {:else if !versions}
    <div class="flex flex-col gap-2">{#each [0, 1, 2, 3] as i (i)}<Skeleton class="h-14" />{/each}</div>
  {:else if !versions.length}
    <EmptyState title={t("versions.empty")}>{#snippet icon()}<History />{/snippet}</EmptyState>
  {:else if selected}
    <div class="flex flex-col gap-3">
      <button type="button" class="-ml-2 inline-flex h-10 items-center gap-1.5 self-start rounded-full px-2 text-[13px] font-medium text-ink-3 hover:text-ink" onclick={() => (selected = null)}>
        <ArrowLeft class="size-4" />{t("versions.back")}
      </button>
      <div>
        <p class="text-[14px] font-semibold text-ink">{t("versions.number", { n: selected.version })} · {kindLabel(selected)}</p>
        <p class="text-[12.5px] text-ink-3">{formatDate(selected.created_at, { dateStyle: "medium", timeStyle: "short" })}{selected.actor_name ? ` · ${displayName(selected.actor_name)}` : ""}</p>
      </div>
      <p class="text-[12.5px] font-medium text-ink-2">{t("versions.diffHint")}</p>
      <div class="max-h-[50dvh] overflow-auto rounded-xl border border-line bg-surface-2/50 p-2 font-mono text-[12.5px] leading-relaxed">
        {#if same}
          <p class="p-2 text-ink-3">{t("versions.same")}</p>
        {:else}
          {#each parts as part, i (i)}
            {#if part.added}
              <pre class="rounded bg-[color-mix(in_srgb,var(--success)_14%,transparent)] px-2 break-words whitespace-pre-wrap text-ink"><span class="select-none text-success">+ </span>{part.value}</pre>
            {:else if part.removed}
              <pre class="rounded bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] px-2 break-words whitespace-pre-wrap text-ink-2 line-through decoration-[color-mix(in_srgb,var(--danger)_50%,transparent)]"><span class="select-none text-danger no-underline">− </span>{part.value}</pre>
            {:else}
              <pre class="px-2 break-words whitespace-pre-wrap text-ink-3">{part.value.split("\n").length > 7 ? `${part.value.split("\n").slice(0, 3).join("\n")}\n⋯\n${part.value.split("\n").slice(-4).join("\n")}` : part.value}</pre>
            {/if}
          {/each}
        {/if}
      </div>
      {#if canEdit}
        <Button variant="primary" class="self-start" disabled={same || loadingVersion} onclick={() => (confirm = true)}><RotateCcw />{t("versions.restore")}</Button>
      {/if}
    </div>
  {:else}
    <ol class="flex flex-col gap-1">
      {#each versions as v (v.id)}
        <li>
          <button type="button" class="flex min-h-14 w-full items-center gap-3 rounded-2xl px-3 py-2 text-left hover:bg-surface-2" onclick={() => pick(v)}>
            <span class="grid size-8 shrink-0 place-items-center rounded-full bg-surface-3 text-[12px] font-semibold text-ink-2 tabular-nums">{v.version}</span>
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.5 text-[13.5px] font-medium text-ink">
                <span class="truncate">{kindLabel(v)}</span>
                {#if v.kind === "autopilot"}<Pill size="sm" tone="lilac"><Bot class="size-3" />{t("versions.autopilot")}</Pill>{:else if v.author === "ai"}<Pill size="sm" tone="sky"><Sparkles class="size-3" />AI</Pill>{/if}
              </span>
              <span class="block text-[12px] text-ink-3">{relativeTime(v.created_at)}{v.actor_name ? ` · ${displayName(v.actor_name)}` : ""}</span>
            </span>
          </button>
        </li>
      {/each}
    </ol>
  {/if}
</Sheet>

<ConfirmDialog bind:open={confirm} title={t("versions.confirmTitle", { n: selected?.version ?? 0 })} description={t("versions.confirmBody")} confirmLabel={t("versions.restore")} danger={false} onConfirm={restore} />

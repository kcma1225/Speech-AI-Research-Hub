<script lang="ts">
  import { DropdownMenu } from "bits-ui";
  import { Check, FileStack, PencilLine } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { menuContent, menuItem, menuLabel, menuSeparator } from "#lib/components/ui/menu.ts";
  import KindIcon from "../attach/KindIcon.svelte";
  import type { ChatSession } from "#lib/agent/chat.svelte.ts";
  import { artifactKey, conversationArtifacts, openArtifact, viewer, type ArtifactFocus, type ArtifactRef } from "#lib/agent/viewer.ts";

  /**
   * 「文件」: the documents this conversation attached or touched (newest first) → open one in the viewer; plus the
   * 「AI 修改時自動開啟」 setting.
   */
  let { session, compact = false }: { session: ChatSession; compact?: boolean } = $props();

  type Item = { ref: ArtifactRef; title: string; write: boolean; focus: ArtifactFocus };
  const items = $derived.by((): Item[] => {
    const list: Item[] = conversationArtifacts(session.messages, session.toolCalls).reverse();
    const seen = new Set(list.map((x) => artifactKey(x.ref)));
    for (const r of viewer.recent) if (!seen.has(artifactKey(r))) list.push({ ref: r, title: "", write: false, focus: {} });
    return list.slice(0, 20);
  });
  const label = (it: Item) => viewer.titleOf(it.ref) || it.title || t(`attach.kind.${it.ref.kind}` as MessageKey);
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class={compact
      ? "relative grid size-10 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-surface-3 data-[state=open]:bg-surface-3"
      : "relative inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-ink-2 hover:bg-surface-3 hover:text-ink data-[state=open]:bg-surface-3"}
    aria-label={items.length ? t("viewer.docsCount", { n: items.length }) : t("viewer.docs")}
    title={t("viewer.docsHint")}
  >
    <FileStack class="size-4.5" />
    {#if !compact}<span class="hidden sm:inline">{t("viewer.docs")}</span>{/if}
    {#if items.length}<span class="count absolute top-0.5 right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-ink px-1 text-[10px] font-semibold text-primary-ink tabular-nums {compact ? '' : 'sm:static sm:h-5 sm:min-w-5'}">{items.length}</span>{/if}
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content align="end" sideOffset={6} class="{menuContent} w-[min(340px,calc(100vw-24px))]">
      <div class={menuLabel}>{t("viewer.docsTitle")}</div>
      {#if !items.length}
        <p class="px-2.5 pt-1 pb-2 text-[12.5px] leading-relaxed text-ink-3">{t("viewer.docsEmpty")}</p>
      {/if}
      <div class="max-h-[50dvh] overflow-y-auto">
        {#each items as it (artifactKey(it.ref))}
          <DropdownMenu.Item class="{menuItem} h-auto min-h-10 py-1.5" onSelect={() => openArtifact(it.ref, { focus: it.focus })}>
            <KindIcon kind={it.ref.kind} class="size-4" />
            <span class="flex min-w-0 flex-1 flex-col leading-tight">
              <span class="truncate text-[13px]">{label(it)}</span>
              <span class="truncate text-[11px] text-ink-3">{t(`attach.kind.${it.ref.kind}` as MessageKey)}</span>
            </span>
            {#if it.write}<span class="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--pill-butter)] px-1.5 text-[10.5px] font-medium text-[var(--pill-butter-ink)]"><PencilLine class="!size-3 !text-[var(--pill-butter-ink)]" />{t("viewer.aiEdited")}</span>{/if}
            {#if viewer.isCurrent(it.ref)}<Check class="shrink-0" />{/if}
          </DropdownMenu.Item>
        {/each}
      </div>
      <div class={menuSeparator}></div>
      <DropdownMenu.CheckboxItem class="{menuItem} h-auto min-h-10 py-1.5" bind:checked={() => viewer.autoOpen, (v) => (viewer.autoOpen = v)} closeOnSelect={false}>
        {#snippet children({ checked })}
          <span class="grid size-4 shrink-0 place-items-center rounded-[5px] border {checked ? 'border-ink bg-ink text-primary-ink' : 'border-line-2'}">{#if checked}<Check class="!size-3 !text-primary-ink" />{/if}</span>
          <span class="flex min-w-0 flex-col leading-tight">
            <span class="text-[13px]">{t("viewer.autoOpen")}</span>
            <span class="text-[11px] text-ink-3">{t("viewer.autoOpenHint")}</span>
          </span>
        {/snippet}
      </DropdownMenu.CheckboxItem>
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>

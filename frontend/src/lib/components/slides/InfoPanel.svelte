<script lang="ts">
  import { Copy, Download, ExternalLink, FileText, Link2, RefreshCw, Star, Trash2 } from "@lucide/svelte";
  import { untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { api } from "#lib/api.ts";
  import { formatDate, t } from "#lib/i18n.svelte.ts";
  import Avatar from "#lib/components/ui/Avatar.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import FileDrop from "#lib/components/ui/FileDrop.svelte";
  import Pill, { tagTone, toneFor } from "#lib/components/ui/Pill.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Switch from "#lib/components/ui/Switch.svelte";
  import TagPicker from "#lib/components/ui/TagPicker.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { SlideDetail } from "#lib/slides/types.ts";
  import { absoluteUrl, copyText, DEFAULT_LIMITS, formatBytes, SLUG_RE, uploadForm } from "#lib/slides/util.ts";

  let { detail, onChanged }: { detail: SlideDetail; onChanged: () => void | Promise<void> } = $props();
  const p = $derived(detail.project);
  const manage = $derived(detail.permissions.manage);
  const limits = $derived(detail.limits ?? DEFAULT_LIMITS);

  // Details form (editors). Re-seeded whenever the server copy changes.
  let title = $state("");
  let slug = $state("");
  let tagIds = $state<string[]>([]);
  let tagNames = $state<Record<string, string>>({});
  let saving = $state(false);
  $effect(() => {
    title = p.title;
    slug = p.slug;
    tagIds = detail.tags.map(tag => tag.id);
    const known = Object.fromEntries(detail.tags.map(tag => [tag.id, tag.name]));
    untrack(() => (tagNames = { ...tagNames, ...known }));
  });
  const slugError = $derived(slug && (!SLUG_RE.test(slug) || slug.length > 80) ? t("slides.upload.slugInvalid") : null);
  const sameTags = $derived(tagIds.length === detail.tags.length && detail.tags.every(tag => tagIds.includes(tag.id)));
  const dirty = $derived(title.trim() !== p.title || slug !== p.slug || !sameTags);

  async function loadTagNames() {
    if (tagIds.every(id => tagNames[id])) return;
    const { tags } = await api.get<{ tags: { id: string; name: string }[] }>("/slide-tags");
    tagNames = Object.fromEntries(tags.map(tag => [tag.id, tag.name]));
  }

  async function save() {
    saving = true;
    try {
      const patch: Record<string, unknown> = {};
      if (title.trim() !== p.title) patch.title = title.trim();
      if (slug !== p.slug) patch.slug = slug;
      if (!sameTags) patch.tagIds = tagIds;
      await api.patch(`/slides/${p.id}`, patch);
      toasts.show(t("slides.info.saved"), "success");
      await onChanged();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      saving = false;
    }
  }

  async function setPublic(value: boolean) {
    try {
      await api.patch(`/slides/${p.id}`, { public_view: value });
      toasts.show(value ? t("slides.info.publicSet") : t("slides.info.privateSet"), "success");
      await onChanged();
    } catch (e) {
      toasts.show((e as Error).message, "error");
      await onChanged();
    }
  }

  let rotateOpen = $state(false);
  async function rotate() {
    await api.patch(`/slides/${p.id}`, { rotateShareKey: true }).catch(e => {
      toasts.show((e as Error).message, "error");
      throw e;
    });
    toasts.show(t("slides.info.rotated"), "success");
    await onChanged();
  }
  async function copy(url: string) {
    const ok = await copyText(absoluteUrl(url));
    toasts.show(ok ? t("slides.info.copied") : t("slides.info.copyFailed"), ok ? "success" : "error");
  }

  // References
  let refKind = $state<"file" | "url">("file");
  let refTitle = $state("");
  let refUrl = $state("");
  let refFile = $state<File | null>(null);
  let refBusy = $state(false);
  const refReady = $derived(Boolean(refTitle.trim() && (refKind === "file" ? refFile : /^https?:\/\/\S+$/i.test(refUrl.trim()))));
  $effect(() => {
    if (refFile && !refTitle.trim()) refTitle = refFile.name.replace(/\.pdf$/i, "");
  });

  async function addReference() {
    refBusy = true;
    try {
      if (refKind === "file" && refFile) {
        const form = new FormData();
        form.append("title", refTitle.trim());
        form.append("file", refFile, refFile.name);
        await uploadForm(`/slides/${p.id}/references`, form);
      } else {
        await api.post(`/slides/${p.id}/references`, { title: refTitle.trim(), url: refUrl.trim() });
      }
      refTitle = refUrl = "";
      refFile = null;
      toasts.show(t("slides.info.refAdded"), "success");
      await onChanged();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      refBusy = false;
    }
  }
  async function refAction(fn: () => Promise<unknown>, message?: string) {
    try {
      await fn();
      if (message) toasts.show(message, "success");
      await onChanged();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }

  let deleteOpen = $state(false);
  async function removeDeck() {
    await api.del(`/slides/${p.id}`).catch(e => {
      toasts.show((e as Error).message, "error");
      throw e;
    });
    toasts.show(t("slides.info.deleted"), "success");
    await goto("/slides");
  }

  const section = "flex flex-col gap-3 border-t border-line pt-5 first:border-0 first:pt-0";
  const heading = "text-[12px] font-semibold tracking-wide text-ink-3 uppercase";
</script>

<div class="flex flex-col gap-5">
  <!-- Details -->
  <section class={section}>
    <h3 class={heading}>{t("slides.info.details")}</h3>
    {#if manage}
      <TextField label={t("slides.info.name")} bind:value={title} maxlength={160} />
      <TextField label={t("slides.info.slug")} bind:value={slug} maxlength={80} autocapitalize="off" spellcheck={false} error={slugError} />
      <div class="flex flex-col gap-2">
        <span class="text-[13px] font-medium text-ink-2">{t("slides.info.tags")}</span>
        <div class="flex flex-wrap items-center gap-1.5">
          {#each tagIds as id (id)}{#if tagNames[id]}<Pill tone={toneFor(id)} size="sm">{tagNames[id]}</Pill>{/if}{/each}
          <TagPicker endpoint="/slide-tags" bind:selected={tagIds} label={t("slides.info.addTag")} onChange={() => void loadTagNames()} />
        </div>
      </div>
      {#if dirty}
        <div class="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onclick={() => ((title = p.title), (slug = p.slug), (tagIds = detail.tags.map(tag => tag.id)))}>{t("action.cancel")}</Button>
          <Button size="sm" variant="primary" loading={saving} disabled={!title.trim() || !slug || Boolean(slugError)} onclick={save}>{t("action.save")}</Button>
        </div>
      {/if}
    {:else}
      <dl class="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13.5px]">
        <dt class="text-ink-3">{t("slides.info.name")}</dt><dd class="min-w-0 break-words">{p.title}</dd>
        <dt class="text-ink-3">{t("slides.info.slug")}</dt><dd class="min-w-0 truncate font-mono text-[12.5px]">{p.slug}</dd>
        <dt class="text-ink-3">{t("slides.info.tags")}</dt>
        <dd class="flex flex-wrap gap-1.5">
          {#each detail.tags as tag (tag.id)}<Pill tone={tagTone(tag)} size="sm">{tag.name}</Pill>{:else}<span class="text-ink-3">{t("slides.info.noTags")}</span>{/each}
        </dd>
      </dl>
    {/if}
    <dl class="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
      {#if p.creator_name}
        <dt class="text-ink-3">{t("slides.info.creator")}</dt>
        <dd class="flex min-w-0 items-center gap-1.5"><Avatar name={p.creator_name} size={18} class="ring-0" /><span class="truncate">{p.creator_name}</span></dd>
      {/if}
      <dt class="text-ink-3">{t("slides.info.created")}</dt><dd>{formatDate(p.created_at)}</dd>
      <dt class="text-ink-3">{t("slides.info.updated")}</dt><dd>{formatDate(p.updated_at, { dateStyle: "medium", timeStyle: "short" })}</dd>
    </dl>
  </section>

  <!-- Sharing -->
  <section class={section}>
    <h3 class={heading}>{t("slides.info.visibility")}</h3>
    <div class="flex items-center justify-between gap-4">
      <div class="min-w-0">
        <p class="text-sm font-medium">{t("slides.info.public")}</p>
        <p class="mt-0.5 text-[12.5px] text-ink-3">{p.public_view ? t("slides.info.publicOn") : t("slides.info.publicOff")}</p>
      </div>
      <Switch checked={p.public_view} disabled={!manage} label={t("slides.info.public")} onCheckedChange={setPublic} />
    </div>
    <div class="flex flex-col gap-1.5">
      <span class="text-[13px] font-medium text-ink-2">{t("slides.info.playerLink")}</span>
      <div class="flex items-center gap-1.5">
        <code class="h-9 min-w-0 flex-1 truncate rounded-xl bg-surface-2 px-3 text-[12px] leading-9 text-ink-2">{absoluteUrl(p.playerUrl)}</code>
        <Button size="icon-sm" variant="ghost" aria-label={t("slides.info.copy")} title={t("slides.info.copy")} onclick={() => copy(p.playerUrl)}><Copy /></Button>
        <Button size="icon-sm" variant="ghost" href={p.playerUrl} aria-label={t("slides.openPlayer")} title={t("slides.openPlayer")}><ExternalLink /></Button>
      </div>
    </div>
    {#if p.shareUrl}
      <div class="flex flex-col gap-1.5">
        <span class="text-[13px] font-medium text-ink-2">{t("slides.info.shareLink")}</span>
        <div class="flex items-center gap-1.5">
          <code class="h-9 min-w-0 flex-1 truncate rounded-xl bg-surface-2 px-3 text-[12px] leading-9 text-ink-2">{absoluteUrl(p.shareUrl)}</code>
          <Button size="icon-sm" variant="ghost" aria-label={t("slides.info.copy")} title={t("slides.info.copy")} onclick={() => copy(p.shareUrl!)}><Copy /></Button>
          <Button size="icon-sm" variant="ghost" aria-label={t("slides.info.rotate")} title={t("slides.info.rotate")} onclick={() => (rotateOpen = true)}><RefreshCw /></Button>
        </div>
        <p class="text-[12px] text-ink-3">{t("slides.info.shareHint")}</p>
      </div>
    {/if}
  </section>

  <!-- Downloads & references -->
  <section class={section}>
    <h3 class={heading}>{t("slides.info.downloads")}</h3>
    {#if detail.pdfUrl}
      <Button variant="secondary" href={detail.pdfUrl} class="w-full"><Download />{t("slides.pdf")}</Button>
    {:else}
      <p class="text-[13px] text-ink-3">{t("slides.info.noPdf")}</p>
    {/if}
  </section>

  <section class={section}>
    <h3 class={heading}>{t("slides.info.references")}</h3>
    {#if detail.references.length}
      <ul class="flex flex-col gap-1.5">
        {#each detail.references as ref (ref.id)}
          <li class="flex items-center gap-2.5 rounded-xl border border-line p-2.5">
            <span class="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-2">{#if ref.kind === "file"}<FileText class="size-4" />{:else}<Link2 class="size-4" />{/if}</span>
            <a href={ref.href} target="_blank" rel="noopener noreferrer" class="min-w-0 flex-1 hover:underline">
              <span class="block truncate text-[13.5px] font-medium">{ref.title}</span>
              <span class="block truncate text-[11.5px] text-ink-3">{ref.kind === "file" ? `${ref.file_name ?? "PDF"}${ref.file_bytes ? ` · ${formatBytes(ref.file_bytes)}` : ""}` : ref.url}</span>
            </a>
            {#if ref.is_default}<Pill tone="butter" size="sm">{t("slides.info.default")}</Pill>{/if}
            {#if manage}
              {#if !ref.is_default}
                <Button size="icon-sm" variant="ghost" aria-label={t("slides.info.makeDefault")} title={t("slides.info.makeDefault")} onclick={() => refAction(() => api.patch(`/slides/${p.id}/references/${ref.id}`, { isDefault: true }))}><Star /></Button>
              {/if}
              <Button size="icon-sm" variant="ghost" aria-label={t("slides.info.deleteRef")} title={t("slides.info.deleteRef")} onclick={() => refAction(() => api.del(`/slides/${p.id}/references/${ref.id}`), t("slides.info.refDeleted"))}><Trash2 /></Button>
            {/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="text-[13px] text-ink-3">{t("slides.info.noReferences")}</p>
    {/if}
    {#if manage}
      <div class="flex flex-col gap-3 rounded-2xl border border-dashed border-line-2 p-3.5">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[13px] font-medium">{t("slides.info.addRef")}</span>
          <Segmented bind:value={refKind} label={t("slides.info.addRef")} options={[{ value: "file", label: t("slides.info.refKind.file") }, { value: "url", label: t("slides.info.refKind.url") }]} />
        </div>
        {#if refKind === "file"}
          <FileDrop bind:file={refFile} accept=".pdf" label={t("slides.info.refFile")} hint={t("slides.info.refFileHint", { size: formatBytes(limits.referenceBytes) })} maxBytes={limits.referenceBytes} onError={m => toasts.show(m, "error")} />
        {:else}
          <TextField label={t("slides.info.refUrl")} type="url" placeholder="https://" bind:value={refUrl} />
        {/if}
        <TextField label={t("slides.info.refTitle")} placeholder={t("slides.info.refTitlePlaceholder")} bind:value={refTitle} maxlength={300} />
        <Button variant="primary" size="sm" class="self-end" loading={refBusy} disabled={!refReady} onclick={addReference}>{t("slides.info.refAdd")}</Button>
      </div>
    {/if}
  </section>

  {#if manage}
    <section class={section}>
      <h3 class={heading}>{t("slides.info.danger")}</h3>
      <p class="text-[12.5px] text-ink-3">{t("slides.info.dangerHint")}</p>
      <Button variant="danger" class="w-full" onclick={() => (deleteOpen = true)}><Trash2 />{t("slides.info.delete")}</Button>
    </section>
  {/if}
</div>

<ConfirmDialog bind:open={rotateOpen} title={t("slides.info.rotateTitle")} description={t("slides.info.rotateDescription")} confirmLabel={t("slides.info.rotate")} onConfirm={rotate} />
<ConfirmDialog bind:open={deleteOpen} title={t("slides.info.deleteTitle", { title: p.title })} description={t("slides.info.deleteDescription")} confirmLabel={t("slides.info.delete")} onConfirm={removeDeck} />

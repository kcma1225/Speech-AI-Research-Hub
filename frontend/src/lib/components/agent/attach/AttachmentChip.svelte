<script lang="ts">
  import { goto } from "$app/navigation";
  import { TriangleAlert, X } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import KindIcon from "./KindIcon.svelte";
  import type { ChipItem } from "./types.ts";

  /**
   * One attachment: type icon, title, study (or version), optional remove ×. Clicking opens the item (uploads open
   * the file in a new tab). `tone="dark"` for chips inside the user's (ink) bubble.
   */
  let { item, pending = false, progress = null, error = null, onRemove, tone = "light", onOpen }: {
    item: ChipItem;
    pending?: boolean;
    /** 0–1 while uploading (null = queued / unknown): a bar along the chip's bottom edge. */
    progress?: number | null;
    error?: string | null;
    onRemove?: () => void;
    tone?: "light" | "dark";
    /** Called before navigating (e.g. to close the slide-over on phones). */
    onOpen?: () => void;
  } = $props();

  const kindLabel = $derived(t(`attach.kind.${item.kind === "upload" ? (item.upload_kind === "image" ? "image" : "upload") : item.kind}` as MessageKey));
  const sub = $derived(error ?? [item.version_label, item.study?.title].filter(Boolean).join(" · "));
  const href = $derived(pending || error ? null : item.url);

  function open(e: MouseEvent) {
    if (!href) return;
    if (item.kind === "upload" || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // new tab / download
    e.preventDefault();
    onOpen?.();
    void goto(href);
  }
</script>

<span
  class="chip relative inline-flex h-10 overflow-hidden max-w-[260px] min-w-0 items-center gap-2 rounded-xl border pr-1 pl-2.5 text-left {tone === 'dark' ? 'border-white/15 bg-white/10 text-primary-ink' : error ? 'border-danger/40 bg-danger-soft text-danger' : 'border-line bg-surface-2 text-ink'} {onRemove ? '' : 'pr-2.5'}"
  data-kind={item.kind}
>
  <span class="grid size-6 shrink-0 place-items-center rounded-lg {tone === 'dark' ? 'bg-white/10' : 'bg-surface text-ink-2'}">
    {#if pending}<Spinner class="size-3.5" />{:else if error}<TriangleAlert class="size-3.5" />{:else}<KindIcon kind={item.kind} upload={item.upload_kind} class="size-3.5" />{/if}
  </span>
  {#if href}
    <a {href} target={item.kind === "upload" ? "_blank" : undefined} rel={item.kind === "upload" ? "noopener" : undefined} class="flex min-w-0 flex-col leading-tight outline-none focus-visible:underline" onclick={open} title={`${kindLabel}：${item.title}`}>
      <span class="truncate text-[12.5px] font-medium">{item.title}</span>
      <span class="truncate text-[11px] {tone === 'dark' ? 'opacity-70' : 'text-ink-3'}">{sub || kindLabel}</span>
    </a>
  {:else}
    <span class="flex min-w-0 flex-col leading-tight" title={error ?? item.title}>
      <span class="truncate text-[12.5px] font-medium">{item.title}</span>
      <span class="truncate text-[11px] {tone === 'dark' ? 'opacity-70' : error ? '' : 'text-ink-3'}">{pending ? (progress == null ? t("attach.uploading") : t("attach.uploadingPct", { pct: Math.round(progress * 100) })) : sub || kindLabel}</span>
    </span>
  {/if}
  {#if pending}
    <span class="absolute inset-x-0 bottom-0 h-[3px] bg-line" role="progressbar" aria-label={t("attach.uploading")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress == null ? undefined : Math.round(progress * 100)}>
      <span class="bar block h-full bg-ink {progress == null ? 'indeterminate' : ''}" style={progress == null ? undefined : `width:${Math.max(3, progress * 100)}%`}></span>
    </span>
  {/if}
  {#if onRemove}
    <button type="button" class="ml-auto grid size-8 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label={pending ? t("attach.cancelUpload", { title: item.title }) : t("attach.remove", { title: item.title })} onclick={onRemove}><X class="size-3.5" /></button>
  {/if}
</span>

<style>
  .chip {
    animation: chip-in 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @keyframes chip-in {
    from {
      opacity: 0;
      transform: scale(0.96);
    }
  }
  .bar {
    transition: width 200ms ease-out;
  }
  .bar.indeterminate {
    width: 30%;
    animation: slide 1.2s ease-in-out infinite;
  }
  @keyframes slide {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(340%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .chip,
    .bar.indeterminate {
      animation: none;
    }
    .bar {
      transition: none;
    }
  }
</style>

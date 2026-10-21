<script lang="ts">
  import { CloudOff, Eye, Lock, RefreshCw } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import type { CollabSession } from "./session.svelte.ts";

  /**
   * Connection state of a collaborative document: 已同步 / 同步中 / 離線（變更會在連線後送出）/ 唯讀 / 無法開啟.
   * Offline edits stay in the browser's copy of the document and merge when the socket reconnects.
   */
  let { session, compact = false }: { session: CollabSession; compact?: boolean } = $props();

  const state = $derived.by(() => {
    if (session.status === "denied") return { key: "denied", icon: Lock, tone: "text-danger", label: t("collab.denied") };
    if (session.status === "offline") return { key: "offline", icon: CloudOff, tone: "text-danger", label: session.unsynced ? t("collab.offlinePending") : t("collab.offline") };
    if (session.status === "connecting" || !session.synced) return { key: "connecting", icon: RefreshCw, tone: "text-ink-3", label: t("collab.connecting") };
    if (session.readOnly) return { key: "readonly", icon: Eye, tone: "text-ink-3", label: t("collab.readOnly") };
    if (session.unsynced) return { key: "saving", icon: null, tone: "text-ink-3", label: t("collab.saving") };
    return { key: "saved", icon: null, tone: "text-ink-3", label: t("collab.saved") };
  });
</script>

<span class="inline-flex h-8 shrink-0 items-center gap-1.5 text-[12.5px] font-medium {state.tone}" role="status" aria-live="polite" title={state.label}>
  {#if state.icon}
    <state.icon class="size-3.5 {state.key === 'connecting' ? 'animate-spin motion-reduce:animate-none' : ''}" />
  {:else}
    <span class="size-2 rounded-full {state.key === 'saving' ? 'bg-[var(--pill-butter-ink)]' : 'bg-success'}"></span>
  {/if}
  <span class={compact ? "sr-only sm:not-sr-only" : ""}>{state.label}</span>
</span>

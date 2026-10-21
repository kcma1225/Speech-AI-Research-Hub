<script lang="ts">
  import { CircleAlert, CircleCheck, CircleX, Clock, LoaderCircle, TriangleAlert } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import type { CompileStatus } from "#lib/latex/types.ts";

  /** Compile status pill (cards, top bar). */
  let { status, class: cls = "" }: { status: CompileStatus | null; class?: string } = $props();
  const look = $derived.by(() => {
    switch (status) {
      case "queued": return { icon: Clock, tone: "stone", spin: false };
      case "running": return { icon: LoaderCircle, tone: "sky", spin: true };
      case "success": return { icon: CircleCheck, tone: "mint", spin: false };
      case "partial": return { icon: TriangleAlert, tone: "butter", spin: false };
      case "failure": case "timeout": case "failed": return { icon: CircleX, tone: "rose", spin: false };
      case "cancelled": return { icon: CircleAlert, tone: "stone", spin: false };
      default: return { icon: Clock, tone: "stone", spin: false };
    }
  });
</script>

<span
  class="inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[11.5px] font-semibold {cls}"
  style="background:var(--pill-{look.tone});color:var(--pill-{look.tone}-ink)"
>
  <look.icon class="size-3.5 {look.spin ? 'animate-spin motion-reduce:animate-none' : ''}" />{status ? t(`latex.status.${status}` as MessageKey) : t("latex.neverCompiled")}
</span>

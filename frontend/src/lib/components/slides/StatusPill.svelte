<script lang="ts">
  import { LoaderCircle } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import Pill from "#lib/components/ui/Pill.svelte";
  import type { VersionStatus } from "#lib/slides/types.ts";
  import { isBusy, statusTone } from "#lib/slides/util.ts";

  let { status, size = "sm", class: cls = "" }: { status: VersionStatus; size?: "sm" | "md"; class?: string } = $props();
</script>

<Pill tone={statusTone[status]} {size} dot={!isBusy(status)} class={cls}>
  {#if isBusy(status)}<LoaderCircle class="size-3 animate-spin" />{/if}
  {t(`slides.status.${status}`)}
</Pill>

<script lang="ts">
  import { t } from "#lib/i18n.svelte.ts";
  import Pill from "#lib/components/ui/Pill.svelte";
  import type { MeetingStatus } from "#lib/meetings/types.ts";
  import { STATUS_LABEL, STATUS_TONE } from "#lib/meetings/util.ts";

  let { status, size = "md" }: { status: MeetingStatus; size?: "sm" | "md" } = $props();
</script>

<Pill tone={STATUS_TONE[status]} {size} dot={status === "processing" || status === "analyzing"}>{t(STATUS_LABEL[status])}</Pill>

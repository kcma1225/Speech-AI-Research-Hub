<script lang="ts">
  import "../app.css";
  import { Tooltip } from "bits-ui";
  import { syncTheme } from "#lib/theme.svelte.ts";
  import { session } from "#lib/stores/session.svelte.ts";
  import Toaster from "#lib/components/ui/Toaster.svelte";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import { t } from "#lib/i18n.svelte.ts";

  let { children } = $props();
  syncTheme();
  const ready = session.load();
</script>

<Tooltip.Provider delayDuration={300}>
  {#await ready}
    <div class="grid min-h-dvh place-items-center text-ink-3"><Spinner class="size-5" /></div>
  {:then}
    {@render children()}
  {:catch}
    <div class="grid min-h-dvh place-items-center px-6 text-center">
      <div>
        <p class="text-sm font-medium">{t("common.error")}</p>
        <p class="mt-1 text-[13px] text-ink-3">{t("common.offline")}</p>
        <Button class="mt-4" variant="primary" onclick={() => location.reload()}>{t("action.retry")}</Button>
      </div>
    </div>
  {/await}
</Tooltip.Provider>
<Toaster />

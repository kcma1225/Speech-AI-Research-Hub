<script lang="ts">
  import { Download, ShieldAlert, Upload } from "@lucide/svelte";
  import { formatDate, t } from "#lib/i18n.svelte.ts";
  import { aiApi, toErrorBody, type AiErrorBody } from "#lib/ai/admin.ts";
  import { adminStore } from "#lib/ai/admin-store.svelte.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import FileDrop from "#lib/components/ui/FileDrop.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Switch from "#lib/components/ui/Switch.svelte";
  import AiErrorPanel from "../AiErrorPanel.svelte";

  /** Export (secrets only when ticked; the file is then named …-SECRET.json) and import (merge by name). */
  let { open = $bindable(false), mode }: { open?: boolean; mode: "export" | "import" } = $props();
  let withSecrets = $state(false);
  let file = $state<File | null>(null);
  let parsed = $state<{ secret?: boolean; exported_at?: string; providers?: unknown[]; routes?: unknown[] } | null>(null);
  let importSecrets = $state(false);
  let busy = $state(false);
  let error = $state<AiErrorBody | null>(null);

  $effect(() => {
    if (!open) {
      file = null;
      parsed = null;
      error = null;
      withSecrets = importSecrets = false;
    }
  });
  $effect(() => {
    const f = file;
    parsed = null;
    error = null;
    if (!f) return;
    f.text().then(
      text => {
        try {
          parsed = JSON.parse(text);
        } catch {
          error = { error: t("aiAdmin.transfer.badFile"), code: "import_invalid" };
        }
      },
      () => (error = { error: t("aiAdmin.transfer.badFile"), code: "import_invalid" }),
    );
  });

  async function run() {
    if (!parsed) return;
    busy = true;
    error = null;
    try {
      const r = await aiApi.post<{ providers_created: number; providers_updated: number; routes_created: number; routes_updated: number; warnings: string[] }>("/admin/ai/import", {
        file: parsed,
        include_secrets: importSecrets && parsed.secret === true,
      });
      toasts.show(t("aiAdmin.transfer.imported", { pc: r.providers_created, pu: r.providers_updated, rc: r.routes_created, ru: r.routes_updated }), "success", 5000);
      for (const w of r.warnings) toasts.show(w, "default", 7000);
      await adminStore.reloadAll();
      open = false;
    } catch (e) {
      error = toErrorBody(e);
    } finally {
      busy = false;
    }
  }
</script>

<Sheet bind:open side="center" title={mode === "export" ? t("aiAdmin.transfer.exportTitle") : t("aiAdmin.transfer.importTitle")} description={mode === "export" ? t("aiAdmin.transfer.exportHint") : t("aiAdmin.transfer.importHint")}>
  {#snippet children()}
    <div class="flex flex-col gap-4 pt-1">
      {#if mode === "export"}
        <div class="flex items-center justify-between gap-4 rounded-xl border border-line px-3.5 py-3">
          <span class="text-[13.5px] font-medium">{t("aiAdmin.transfer.includeSecrets")}</span>
          <Switch bind:checked={withSecrets} label={t("aiAdmin.transfer.includeSecrets")} />
        </div>
        {#if withSecrets}
          <p class="flex items-start gap-2 rounded-2xl bg-danger-soft/70 p-3.5 text-[13px] text-danger"><ShieldAlert class="mt-0.5 size-4 shrink-0" />{t("aiAdmin.transfer.secretWarn")}</p>
        {/if}
      {:else}
        <FileDrop bind:file accept="application/json,.json" label={t("aiAdmin.transfer.pick")} maxBytes={1024 * 1024} onError={m => (error = { error: m, code: "import_invalid" })} />
        {#if parsed}
          <p class="text-[13px] text-ink-2">
            {t("aiAdmin.transfer.fileInfo", { date: parsed.exported_at ? formatDate(parsed.exported_at) : "?", providers: parsed.providers?.length ?? 0, routes: parsed.routes?.length ?? 0 })}
          </p>
          {#if parsed.secret}
            <div class="flex items-center justify-between gap-4 rounded-xl border border-danger/30 px-3.5 py-3">
              <span class="flex items-center gap-2 text-[13.5px] font-medium text-danger"><ShieldAlert class="size-4" />{t("aiAdmin.transfer.importSecrets")}</span>
              <Switch bind:checked={importSecrets} label={t("aiAdmin.transfer.importSecrets")} />
            </div>
          {/if}
        {/if}
      {/if}
      {#if error}<AiErrorPanel compact {error} />{/if}
    </div>
  {/snippet}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{t("action.cancel")}</Button>
    {#if mode === "export"}
      <a
        href="/api/admin/ai/export?include_secrets={withSecrets ? 1 : 0}"
        download
        data-sveltekit-reload
        onclick={() => setTimeout(() => (open = false), 300)}
        class="inline-flex h-10 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium transition-colors [&_svg]:size-[1.05em] {withSecrets ? 'bg-danger-soft text-danger hover:brightness-95' : 'bg-primary text-primary-ink hover:bg-primary-hover'}"
        ><Download />{t("aiAdmin.transfer.download")}</a
      >
    {:else}
      <Button variant="primary" loading={busy} disabled={!parsed} onclick={run}><Upload />{t("aiAdmin.transfer.run")}</Button>
    {/if}
  {/snippet}
</Sheet>

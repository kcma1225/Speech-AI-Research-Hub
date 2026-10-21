<script lang="ts">
  import { RotateCcw, Trash2 } from "@lucide/svelte";
  import { relativeTime, t } from "#lib/i18n.svelte.ts";
  import { aiApi, toErrorBody, type AiErrorBody, type ModelProfile, type ProfileField } from "#lib/ai/admin.ts";
  import { adminStore } from "#lib/ai/admin-store.svelte.ts";
  import { tokens } from "#lib/ai/routing.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Switch from "#lib/components/ui/Switch.svelte";
  import AiErrorPanel from "../AiErrorPanel.svelte";
  import SourceTag from "./SourceTag.svelte";

  /** One model profile: every field with its source; type a value to override it, reset to go back to provider/catalog data. */
  let { open = $bindable(false), model }: { open?: boolean; model: ModelProfile | null } = $props();

  type Kind = "text" | "int" | "num" | "bool" | "cap";
  const FIELDS: Array<{ key: ProfileField; kind: Kind; chatOnly?: boolean; embOnly?: boolean }> = [
    { key: "display_name", kind: "text" },
    { key: "capability", kind: "cap" },
    { key: "context_window", kind: "int" },
    { key: "max_output_tokens", kind: "int", chatOnly: true },
    { key: "vision", kind: "bool", chatOnly: true },
    { key: "tools", kind: "bool", chatOnly: true },
    { key: "reasoning", kind: "bool", chatOnly: true },
    { key: "json_schema", kind: "bool", chatOnly: true },
    { key: "embedding_dims", kind: "int", embOnly: true },
    { key: "input_price", kind: "num" },
    { key: "output_price", kind: "num" },
  ];

  let draft = $state<Record<string, string>>({});
  let enabled = $state(true);
  let saving = $state(false);
  let error = $state<AiErrorBody | null>(null);

  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen && model) {
      const o = model.overrides as Record<string, unknown>;
      draft = Object.fromEntries(FIELDS.map(f => [f.key, o[f.key] === undefined ? "" : String(o[f.key])]));
      enabled = model.enabled;
      error = null;
    }
    wasOpen = open;
  });

  const cap = $derived((draft.capability || model?.fields.capability) ?? "chat");
  const shown = $derived(FIELDS.filter(f => (!f.chatOnly || cap === "chat") && (!f.embOnly || cap === "embedding") && !(model?.provider_family === "asr" && f.key !== "display_name")));
  const label = (k: ProfileField) => t(`aiAdmin.field.${k}` as MessageKey);
  const isAsr = $derived(model?.provider_family === "asr");

  function fmt(k: ProfileField, v: unknown): string {
    if (v === undefined || v === null || v === "") return "—";
    if (typeof v === "boolean") return v ? t("aiAdmin.models.yes") : t("aiAdmin.models.no");
    if (k === "capability") return t(`aiAdmin.cap.${v}` as MessageKey);
    if (k === "context_window" || k === "max_output_tokens") return `${tokens(Number(v))} (${Number(v).toLocaleString()})`;
    if (k === "input_price" || k === "output_price") return `$${v} / 1M`;
    return String(v);
  }
  /** Value without the manual layer: provider listing, else catalog (what "reset" goes back to). */
  const underlying = (k: ProfileField) => (model?.api as Record<string, unknown>)?.[k] ?? (model?.catalog as Record<string, unknown>)?.[k];
  const underSrc = (k: ProfileField) => ((model?.api as Record<string, unknown>)?.[k] !== undefined ? "provider_api" : (model?.catalog as Record<string, unknown>)?.[k] !== undefined ? "catalog" : undefined);

  function patch(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const o = (model?.overrides ?? {}) as Record<string, unknown>;
    for (const f of FIELDS) {
      const raw = (draft[f.key] ?? "").trim();
      const before = o[f.key] === undefined ? "" : String(o[f.key]);
      if (raw === before) continue;
      if (!raw) out[f.key] = null;
      else if (f.kind === "int" || f.kind === "num") out[f.key] = Number(raw);
      else if (f.kind === "bool") out[f.key] = raw === "true";
      else out[f.key] = raw;
    }
    return out;
  }

  async function save() {
    if (!model) return;
    saving = true;
    error = null;
    try {
      const overrides = patch();
      const r = await aiApi.patch<{ model: ModelProfile }>(`/admin/ai/models/${model.id}`, { enabled, ...(Object.keys(overrides).length ? { overrides } : {}) });
      adminStore.putModel(r.model);
      toasts.show(t("aiAdmin.models.saved", { name: model.model_id }), "success");
      open = false;
      void adminStore.reloadBindings();
    } catch (e) {
      error = toErrorBody(e);
    } finally {
      saving = false;
    }
  }

  async function remove() {
    if (!model) return;
    saving = true;
    error = null;
    try {
      await aiApi.del(`/admin/ai/models/${model.id}`);
      toasts.show(t("aiAdmin.models.deleted", { name: model.model_id }), "success");
      open = false;
      await adminStore.reloadModels();
    } catch (e) {
      error = toErrorBody(e);
    } finally {
      saving = false;
    }
  }
</script>

<Sheet bind:open title={model?.model_id ?? ""} description={model ? `${model.provider_name ?? ""}${model.catalog_id ? ` · ${t("aiAdmin.models.catalogMatch", { id: model.catalog_id })}` : ""}` : undefined} side="right">
  {#if model}
    <div class="flex flex-col gap-4">
      <div class="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-3.5 py-2.5">
        <div class="min-w-0">
          <p class="text-[13.5px] font-medium">{t("aiAdmin.models.showInPickers")}</p>
          <p class="text-[12px] text-ink-3">{model.listed ? t("aiAdmin.models.listedAt", { time: model.refreshed_at ? relativeTime(model.refreshed_at) : "—" }) : t("aiAdmin.models.notListed")}</p>
        </div>
        <Switch bind:checked={enabled} label={t("aiAdmin.models.showInPickers")} />
      </div>
      {#if !isAsr}<p class="text-[12.5px] text-ink-3">{t("aiAdmin.models.overrideHint")}</p>{/if}
      <ul class="flex flex-col divide-y divide-line">
        {#each shown as f (f.key)}
          <li class="flex flex-col gap-1.5 py-2.5">
            <div class="flex items-center gap-2">
              <span class="text-[13px] font-medium text-ink-2">{label(f.key)}</span>
              <SourceTag source={draft[f.key] ? "manual" : underSrc(f.key)} />
              <span class="ml-auto truncate text-[12px] text-ink-3" title={t("aiAdmin.models.underlying")}>{fmt(f.key, underlying(f.key))}</span>
            </div>
            <div class="flex items-center gap-1.5">
              {#if f.kind === "bool"}
                <Select
                  value={draft[f.key] ?? ""}
                  label={label(f.key)}
                  class="w-full"
                  options={[
                    { value: "", label: t("aiAdmin.models.auto", { v: fmt(f.key, underlying(f.key)) }) },
                    { value: "true", label: t("aiAdmin.models.yes") },
                    { value: "false", label: t("aiAdmin.models.no") },
                  ]}
                  onValueChange={v => (draft = { ...draft, [f.key]: v })}
                />
              {:else if f.kind === "cap"}
                <Select
                  value={draft[f.key] ?? ""}
                  label={label(f.key)}
                  class="w-full"
                  options={[
                    { value: "", label: t("aiAdmin.models.auto", { v: fmt(f.key, underlying(f.key)) }) },
                    { value: "chat", label: t("aiAdmin.cap.chat") },
                    { value: "embedding", label: t("aiAdmin.cap.embedding") },
                  ]}
                  onValueChange={v => (draft = { ...draft, [f.key]: v })}
                />
              {:else}
                <input
                  value={draft[f.key] ?? ""}
                  oninput={e => (draft = { ...draft, [f.key]: (e.currentTarget as HTMLInputElement).value })}
                  inputmode={f.kind === "text" ? "text" : "decimal"}
                  placeholder={fmt(f.key, underlying(f.key))}
                  aria-label={label(f.key)}
                  class="h-10 min-w-0 flex-1 rounded-xl border border-line-2 bg-surface px-3 text-[14px] tabular-nums outline-none placeholder:text-ink-3 focus:border-ink"
                />
              {/if}
              <button
                type="button"
                class="grid size-10 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink disabled:opacity-30"
                disabled={!draft[f.key]}
                aria-label={t("aiAdmin.models.reset", { field: label(f.key) })}
                title={t("aiAdmin.models.reset", { field: label(f.key) })}
                onclick={() => (draft = { ...draft, [f.key]: "" })}><RotateCcw class="size-4" /></button
              >
            </div>
          </li>
        {/each}
      </ul>
      {#if model.used_by.length}
        <p class="text-[12.5px] text-ink-3">{t("aiAdmin.models.usedBy", { names: model.used_by.map(u => u.name).join("、") })}</p>
      {/if}
      {#if error}<AiErrorPanel compact {error} />{/if}
      <div class="flex flex-wrap justify-between gap-2 pt-1">
        <Button variant="ghost" class="text-danger" disabled={saving || model.used_by.length > 0} onclick={remove}><Trash2 />{t("aiAdmin.models.delete")}</Button>
        <div class="flex gap-2">
          <Button variant="ghost" onclick={() => (open = false)}>{t("action.cancel")}</Button>
          <Button variant="primary" loading={saving} onclick={save}>{t("aiAdmin.models.save")}</Button>
        </div>
      </div>
    </div>
  {/if}
</Sheet>

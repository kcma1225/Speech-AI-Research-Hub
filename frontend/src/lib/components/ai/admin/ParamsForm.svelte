<script lang="ts">
  import { t } from "#lib/i18n.svelte.ts";
  import type { ParamField } from "#lib/ai/admin.ts";
  import { L, type RawValues } from "#lib/ai/form.ts";
  import Select from "#lib/components/ui/Select.svelte";
  import Textarea from "#lib/components/ui/Textarea.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";

  /** Member params from the whitelist. Empty = use the default; booleans are a 3-way select (default / on / off). */
  let { fields, raw = $bindable(), errors = {} }: { fields: ParamField[]; raw: RawValues; errors?: Record<string, string> } = $props();
  const platform = $derived(fields.filter(f => f.scope !== "vendor"));
  const vendor = $derived(fields.filter(f => f.scope === "vendor"));
  const set = (k: string, v: string) => (raw = { ...raw, [k]: v });
  const def = (f: ParamField) => (f.default !== undefined ? `${t("aiAdmin.routes.paramDefault")}：${typeof f.default === "object" ? JSON.stringify(f.default) : String(f.default)}` : t("aiAdmin.routes.paramDefault"));
</script>

{#snippet one(f: ParamField)}
  {#if f.type === "boolean" || f.type === "select"}
    <div class="flex flex-col gap-1.5">
      <span class="text-[13px] font-medium text-ink-2">{L(f.label)}</span>
      <Select
        value={String(raw[f.key] ?? "")}
        label={L(f.label)}
        class="w-full"
        options={[
          { value: "", label: f.default_label ? L(f.default_label) : def(f) },
          ...(f.type === "boolean" ? [{ value: "true", label: t("aiAdmin.param.on") }, { value: "false", label: t("aiAdmin.param.off") }] : (f.options ?? []).map(o => ({ value: o, label: f.option_labels?.[o] ? L(f.option_labels[o]) : o }))),
        ]}
        onValueChange={v => set(f.key, v)}
      />
      {#if f.help_zh}<p class="text-[12px] text-ink-3">{f.help_zh}</p>{/if}
    </div>
  {:else if f.type === "json" || f.multiline}
    <Textarea
      label={L(f.label)}
      value={String(raw[f.key] ?? "")}
      oninput={e => set(f.key, (e.currentTarget as HTMLTextAreaElement).value)}
      rows={2}
      placeholder={def(f)}
      hint={f.help_zh}
      error={errors[f.key] ? t("aiAdmin.param.invalid") : null}
      spellcheck="false"
    />
  {:else}
    <TextField
      label={L(f.label)}
      type={f.type === "string" ? "text" : "number"}
      step={f.type === "integer" ? "1" : "any"}
      min={f.min}
      max={f.max}
      value={String(raw[f.key] ?? "")}
      oninput={e => set(f.key, (e.currentTarget as HTMLInputElement).value)}
      placeholder={def(f)}
      hint={f.help_zh}
      error={errors[f.key] ? t("aiAdmin.param.invalid") : null}
    />
  {/if}
{/snippet}

<div class="grid gap-3 sm:grid-cols-2">
  {#each platform as f (f.key)}{@render one(f)}{/each}
</div>
{#if vendor.length}
  <p class="mt-4 mb-2 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">{t("aiAdmin.routes.paramVendor")}</p>
  <div class="grid gap-3 sm:grid-cols-2">
    {#each vendor as f (f.key)}{@render one(f)}{/each}
  </div>
{/if}

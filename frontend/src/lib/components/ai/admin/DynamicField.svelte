<script lang="ts">
  import { t } from "#lib/i18n.svelte.ts";
  import type { FormField } from "#lib/ai/admin.ts";
  import { L } from "#lib/ai/form.ts";
  import Select from "#lib/components/ui/Select.svelte";
  import Switch from "#lib/components/ui/Switch.svelte";
  import Textarea from "#lib/components/ui/Textarea.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";

  /** One registry form field (provider account forms). Values are raw strings/booleans; see lib/ai/form.ts. */
  let {
    field,
    value = $bindable(),
    secretSet = false,
    cleared = false,
    onClear,
    error = null,
  }: { field: FormField; value: string | boolean; secretSet?: boolean; cleared?: boolean; onClear?: () => void; error?: string | null } = $props();

  const label = $derived(`${L(field.label)}${field.required ? " *" : ""}`);
  const placeholder = $derived(field.type === "secret" && secretSet && !cleared ? t("aiAdmin.sheet.secretSet") : (field.placeholder ?? (field.default !== undefined && typeof field.default !== "object" ? String(field.default) : "")));
  const uid = $props.id();
</script>

{#if field.type === "boolean"}
  <div class="flex items-start justify-between gap-4 rounded-xl border border-line px-3.5 py-3">
    <div class="min-w-0">
      <p id="lbl-{uid}" class="text-[13.5px] font-medium text-ink">{L(field.label)}</p>
      {#if field.help_zh}<p class="mt-0.5 text-[12.5px] leading-snug text-ink-3">{field.help_zh}</p>{/if}
    </div>
    <Switch checked={Boolean(value)} label={L(field.label)} onCheckedChange={v => (value = v)} />
  </div>
{:else if field.type === "select"}
  <div class="flex flex-col gap-1.5">
    <span class="text-[13px] font-medium text-ink-2">{label}</span>
    <Select
      value={String(value ?? "")}
      label={L(field.label)}
      class="w-full"
      options={(field.options ?? []).map(o => ({ value: o.value, label: L(o.label) }))}
      onValueChange={v => (value = v)}
    />
    {#if error}<p class="text-[12.5px] text-danger" role="alert">{error}</p>{:else if field.help_zh}<p class="text-[12.5px] text-ink-3">{field.help_zh}</p>{/if}
  </div>
{:else if field.multiline || field.type === "json"}
  <Textarea
    {label}
    value={String(value ?? "")}
    oninput={e => (value = (e.currentTarget as HTMLTextAreaElement).value)}
    rows={field.type === "json" ? 3 : 5}
    {placeholder}
    hint={field.help_zh}
    {error}
    spellcheck="false"
    class="font-mono [&_textarea]:font-mono [&_textarea]:text-[12.5px]"
  />
  {#if field.type === "secret" && secretSet && onClear}
    <button type="button" class="-mt-1 self-start text-[12.5px] text-ink-3 underline-offset-2 hover:text-danger hover:underline" onclick={onClear}>
      {cleared ? t("aiAdmin.sheet.secretCleared") : t("aiAdmin.sheet.secretClear")}
    </button>
  {/if}
{:else}
  <div class="flex flex-col gap-1">
    <TextField
      {label}
      type={field.type === "secret" ? "password" : field.type === "number" ? "number" : field.type === "url" ? "url" : "text"}
      value={String(value ?? "")}
      oninput={e => (value = (e.currentTarget as HTMLInputElement).value)}
      {placeholder}
      hint={field.help_zh}
      {error}
      autocomplete={field.type === "secret" ? "new-password" : "off"}
      spellcheck="false"
    />
    {#if field.type === "secret" && secretSet && onClear}
      <button type="button" class="self-start text-[12.5px] text-ink-3 underline-offset-2 hover:text-danger hover:underline" onclick={onClear}>
        {cleared ? t("aiAdmin.sheet.secretCleared") : t("aiAdmin.sheet.secretClear")}
      </button>
    {/if}
  </div>
{/if}

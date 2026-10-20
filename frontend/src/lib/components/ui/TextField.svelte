<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";
  import { Eye, EyeOff } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";

  type Props = Omit<HTMLInputAttributes, "value"> & { label?: string; hint?: string; error?: string | null; value?: string; ref?: HTMLInputElement | null };
  let { label, hint, error = null, value = $bindable(""), type = "text", id, class: cls = "", ref = $bindable(null), ...rest }: Props = $props();
  const uid = $props.id();
  const inputId = $derived(id ?? `tf-${uid}`);
  let reveal = $state(false);
</script>

<div class="flex flex-col gap-1.5 {cls}">
  {#if label}<label for={inputId} class="text-[13px] font-medium text-ink-2">{label}</label>{/if}
  <div class="relative">
    <input
      bind:this={ref}
      id={inputId}
      type={type === "password" && reveal ? "text" : type}
      bind:value
      aria-invalid={error ? true : undefined}
      aria-describedby={error || hint ? `${inputId}-desc` : undefined}
      class="h-11 w-full rounded-xl border bg-surface px-3.5 text-[15px] text-ink outline-none transition-[border-color,box-shadow] placeholder:text-ink-3 focus:border-ink focus:shadow-[0_0_0_3px_var(--surface-3)] sm:text-sm {error ? 'border-danger' : 'border-line-2'} {type === 'password' ? 'pr-11' : ''}"
      {...rest}
    />
    {#if type === "password"}
      <button
        type="button"
        class="absolute top-1/2 right-1.5 grid size-8 -translate-y-1/2 place-items-center rounded-lg text-ink-3 hover:bg-surface-3 hover:text-ink [&_svg]:size-4"
        aria-label={reveal ? t("common.hidePassword") : t("common.showPassword")}
        onclick={() => (reveal = !reveal)}
      >
        {#if reveal}<EyeOff />{:else}<Eye />{/if}
      </button>
    {/if}
  </div>
  {#if error}
    <p id="{inputId}-desc" class="text-[12.5px] text-danger">{error}</p>
  {:else if hint}
    <p id="{inputId}-desc" class="text-[12.5px] text-ink-3">{hint}</p>
  {/if}
</div>

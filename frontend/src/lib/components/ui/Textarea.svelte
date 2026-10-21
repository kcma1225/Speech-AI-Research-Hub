<script lang="ts">
  import type { HTMLTextareaAttributes } from "svelte/elements";
  type Props = Omit<HTMLTextareaAttributes, "value"> & { label?: string; hint?: string; error?: string | null; value?: string; ref?: HTMLTextAreaElement | null };
  let { label, hint, error = null, value = $bindable(""), id, class: cls = "", rows = 4, ref = $bindable(null), ...rest }: Props = $props();
  const uid = $props.id();
  const inputId = $derived(id ?? `ta-${uid}`);
</script>

<div class="flex flex-col gap-1.5 {cls}">
  {#if label}<label for={inputId} class="text-[13px] font-medium text-ink-2">{label}</label>{/if}
  <textarea
    bind:this={ref}
    id={inputId}
    bind:value
    {rows}
    aria-invalid={error ? true : undefined}
    aria-describedby={error || hint ? `${inputId}-desc` : undefined}
    class="w-full resize-y rounded-xl border bg-raised px-3.5 py-2.5 text-[15px] leading-relaxed text-ink outline-none transition-[border-color,box-shadow] placeholder:text-ink-3 focus:border-ink focus:shadow-[0_0_0_3px_var(--surface-3)] sm:text-sm {error ? 'border-danger' : 'border-field-line'}"
    {...rest}
  ></textarea>
  {#if error}<p id="{inputId}-desc" class="text-[12.5px] text-danger" role="alert">{error}</p>{:else if hint}<p id="{inputId}-desc" class="text-[12.5px] text-ink-3">{hint}</p>{/if}
</div>

<script lang="ts">
  import { Check } from "@lucide/svelte";

  /** Round check toggle (tasks, milestones): a `role="checkbox"` button with a 40px hit area around a 22px circle. */
  let { checked = false, label, disabled = false, onToggle }: { checked?: boolean; label: string; disabled?: boolean; onToggle?: (next: boolean) => void } = $props();
</script>

<button
  type="button"
  role="checkbox"
  aria-checked={checked}
  aria-label={label}
  {disabled}
  onclick={() => onToggle?.(!checked)}
  class="group -m-2 grid size-10 shrink-0 place-items-center rounded-full disabled:cursor-default"
>
  <span
    class="grid size-[22px] place-items-center rounded-full border-[1.5px] transition-[background-color,border-color,transform] duration-150 group-active:scale-90 motion-reduce:transition-none {checked
      ? 'border-ink bg-ink text-surface'
      : 'border-line-2 text-transparent group-enabled:group-hover:border-ink-3'}"
  >
    <Check class="size-3.5" strokeWidth={3} />
  </span>
</button>

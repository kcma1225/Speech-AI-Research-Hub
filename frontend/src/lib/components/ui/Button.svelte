<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";
  import Spinner from "./Spinner.svelte";

  type Props = HTMLButtonAttributes & {
    variant?: "primary" | "secondary" | "outline" | "ghost" | "danger";
    size?: "sm" | "md" | "lg" | "icon" | "icon-sm";
    href?: string;
    target?: string;
    loading?: boolean;
    children?: Snippet;
    ref?: HTMLElement | null;
  };
  let { variant = "secondary", size = "md", href, target, loading = false, children, class: cls = "", disabled, ref = $bindable(null), ...rest }: Props = $props();

  const variants = {
    primary: "bg-primary text-primary-ink hover:bg-primary-hover",
    secondary: "bg-surface text-ink border border-line hover:bg-surface-2 hover:border-line-2",
    outline: "bg-transparent text-ink border border-line-2 hover:bg-surface",
    ghost: "bg-transparent text-ink-2 hover:bg-surface-3 hover:text-ink",
    danger: "bg-danger-soft text-danger hover:brightness-95",
  };
  const sizes = {
    sm: "h-8 px-3 text-[13px] gap-1.5",
    md: "h-10 px-4 text-sm gap-2",
    lg: "h-12 px-6 text-[15px] gap-2",
    icon: "size-10 justify-center",
    "icon-sm": "size-8 justify-center",
  };
  const classes = $derived(
    `inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium whitespace-nowrap transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-[1.05em] [&_svg]:shrink-0 ${variants[variant]} ${sizes[size]} ${cls}`,
  );
</script>

{#if href}
  <a bind:this={ref} {href} {target} rel={target === "_blank" ? "noopener noreferrer" : undefined} class={classes} {...rest as Record<string, unknown>}>
    {@render children?.()}
  </a>
{:else}
  <button bind:this={ref} type="button" class={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
    {#if loading}<Spinner />{/if}
    {@render children?.()}
  </button>
{/if}

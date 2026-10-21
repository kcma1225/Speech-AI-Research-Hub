<script lang="ts">
  import MarkdownView from "#lib/components/markdown/MarkdownView.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { safeChatMarkdown } from "#lib/agent/tools.ts";

  /**
   * Assistant Markdown: remote images become links, citation markers are stripped, and external links open only
   * after a confirm that shows the full URL (the text may echo injected content).
   */
  let { source, streaming = false }: { source: string; streaming?: boolean } = $props();
  const text = $derived(safeChatMarkdown(source));
  let pending = $state<URL | null>(null);
  let open = $state(false);

  function onclick(e: MouseEvent) {
    const a = (e.target as HTMLElement | null)?.closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    let url: URL;
    try {
      url = new URL(href, location.href);
    } catch {
      return;
    }
    if (url.origin === location.origin) return;
    e.preventDefault();
    pending = url;
    open = true;
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div {onclick} class="min-w-0" data-streaming={streaming || undefined}>
  <MarkdownView source={text} fontSize={14.5} />
</div>

<ConfirmDialog
  bind:open
  danger={false}
  title={t("agent.link.title")}
  description={pending ? `${pending.hostname.startsWith("xn--") || pending.hostname.includes(".xn--") ? `${t("agent.link.punycode")}\n` : ""}${pending.href}` : ""}
  confirmLabel={t("agent.link.open")}
  onConfirm={() => {
    if (pending) window.open(pending.href, "_blank", "noopener,noreferrer");
  }}
/>

<style>
  /* Streaming caret after the last block (static under reduced motion). */
  [data-streaming] :global(.md > :last-child::after) {
    content: "";
    display: inline-block;
    width: 7px;
    height: 1em;
    margin-left: 3px;
    vertical-align: -0.15em;
    border-radius: 2px;
    background: var(--ink-2);
    animation: blink 1s steps(2, start) infinite;
  }
  @keyframes blink {
    to {
      visibility: hidden;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    [data-streaming] :global(.md > :last-child::after) {
      animation: none;
    }
  }
</style>

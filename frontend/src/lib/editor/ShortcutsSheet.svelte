<script lang="ts">
  import { t } from "#lib/i18n.svelte.ts";
  import Kbd from "#lib/components/ui/Kbd.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import { formatKey, type EditorAction } from "./editor-actions.ts";

  /** Keyboard shortcut and Markdown syntax cheat sheet (Mod-/ or the 「?」 button). */
  let { open = $bindable(false), actions }: { open?: boolean; actions: EditorAction[] } = $props();

  const groups = $derived([
    { title: t("mdx.keys.format"), items: actions.filter(a => a.key && (a.group === "inline" || a.group === "history")).map(a => ({ label: a.label, key: a.key! })) },
    { title: t("mdx.keys.blocks"), items: actions.filter(a => a.key && (a.group === "block" || a.group === "insert")).map(a => ({ label: a.label, key: a.key! })) },
    {
      title: t("mdx.keys.editing"),
      items: [
        { label: t("mdx.find"), key: "Mod-f" },
        { label: t("mdx.keys.slash"), key: "/" },
        { label: t("mdx.keys.tableNext"), key: "Tab" },
        { label: t("mdx.keys.tablePrev"), key: "Shift-Tab" },
        { label: t("mdx.keys.tableRow"), key: "Mod-Enter" },
        { label: t("mdx.keys.indent"), key: "Mod-]" },
        { label: t("mdx.keys.outdent"), key: "Mod-[" },
        { label: t("mdx.fullscreen"), key: "Mod-Shift-f" },
        { label: t("mdx.shortcuts"), key: "Mod-/" },
      ],
    },
  ]);
  const syntax = $derived([
    ["# / ## / ###", t("mdx.syntax.heading")],
    [t("mdx.syntax.inlineCode"), t("mdx.syntax.inline")],
    [t("mdx.syntax.listsCode"), t("mdx.syntax.lists")],
    [t("mdx.syntax.linksCode"), t("mdx.syntax.links")],
    ["$E=mc^2$ / $$…$$", t("mdx.syntax.math")],
    ["> [!NOTE] / [!TIP] / [!WARNING]", t("mdx.syntax.callout")],
    [t("mdx.syntax.footnoteCode"), t("mdx.syntax.footnote")],
    ["```mermaid", t("mdx.syntax.mermaid")],
  ]);
</script>

<Sheet bind:open title={t("mdx.shortcuts")} description={t("mdx.shortcutsHint")} side="right">
  <div class="flex flex-col gap-5 pt-1">
    {#each groups as group (group.title)}
      <section>
        <h3 class="mb-1.5 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">{group.title}</h3>
        <dl class="flex flex-col">
          {#each group.items as item (item.label + item.key)}
            <div class="flex items-center justify-between gap-3 border-b border-line py-2 last:border-0">
              <dt class="text-[13.5px] text-ink">{item.label}</dt>
              <dd class="flex shrink-0 gap-1">{#each formatKey(item.key).split(/(?<=[^+])\+(?=.)/) as part, i (i)}<Kbd>{part}</Kbd>{/each}</dd>
            </div>
          {/each}
        </dl>
      </section>
    {/each}
    <section>
      <h3 class="mb-1.5 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">{t("mdx.keys.syntax")}</h3>
      <dl class="flex flex-col">
        {#each syntax as [code, label] (label)}
          <div class="flex flex-col gap-0.5 border-b border-line py-2 last:border-0">
            <dt class="font-mono text-[12.5px] text-ink-2">{code}</dt>
            <dd class="text-[12.5px] text-ink-3">{label}</dd>
          </div>
        {/each}
      </dl>
    </section>
  </div>
</Sheet>

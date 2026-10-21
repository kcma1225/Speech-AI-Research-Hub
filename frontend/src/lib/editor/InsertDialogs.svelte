<script lang="ts">
  import type { EditorView } from "@codemirror/view";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { md } from "./markdown-commands.ts";

  /**
   * Dialogs for actions that need input: link (or image by URL), table size, code block language.
   * `open(kind, view)` is called by the toolbar / slash menu / shortcuts; the edit goes to that view.
   */
  type Kind = "link" | "image" | "table" | "code";
  let kind = $state<Kind | null>(null);
  let open = $state(false);
  let target: EditorView | null = null;
  let range: { from: number; to: number } | null = null;

  let linkText = $state("");
  let linkUrl = $state("");
  let rows = $state("3");
  let cols = $state("3");
  let lang = $state("python");
  let urlError = $state<string | null>(null);

  export function show(next: Kind, view: EditorView) {
    target = view;
    const sel = view.state.selection.main;
    range = { from: sel.from, to: sel.to };
    const selected = view.state.sliceDoc(sel.from, sel.to);
    kind = next;
    urlError = null;
    if (next === "link" || next === "image") {
      const looksUrl = /^(https?:\/\/|\/)\S+$/.test(selected.trim());
      linkText = looksUrl ? "" : selected.split("\n")[0]!.slice(0, 200);
      linkUrl = looksUrl ? selected.trim() : "";
    }
    open = true;
  }

  function restore(view: EditorView) {
    if (range && range.to <= view.state.doc.length) view.dispatch({ selection: { anchor: range.from, head: range.to } });
  }

  function validUrl(url: string) {
    return /^(https?:\/\/[^\s]+|\/[^\s]*|#[^\s]*|mailto:[^\s]+)$/i.test(url.trim());
  }

  function submit(e?: SubmitEvent) {
    e?.preventDefault();
    const view = target;
    if (!view || !kind) return;
    if (kind === "link" || kind === "image") {
      if (!validUrl(linkUrl)) {
        urlError = t("mdx.urlInvalid");
        return;
      }
      restore(view);
      if (kind === "link") md.link(view, t("md.linkText"), linkUrl.trim(), linkText.trim() || undefined);
      else md.image(view, linkUrl.trim(), linkText.trim());
    } else if (kind === "table") {
      restore(view);
      const r = Math.max(1, Math.min(50, Number(rows) || 3));
      const c = Math.max(1, Math.min(12, Number(cols) || 3));
      md.table(view, r, c, i => t("mdx.tableHeader", { n: i + 1 }));
    } else if (kind === "code") {
      restore(view);
      md.codeBlock(view, lang === "plain" ? "" : lang);
    }
    open = false;
  }

  const languages = [
    "plain", "python", "bash", "javascript", "typescript", "json", "yaml", "latex", "markdown", "c", "cpp", "java", "rust", "go", "r", "matlab", "sql", "html", "css", "diff", "text",
  ].map(value => ({ value, label: value === "plain" ? t("mdx.codePlain") : value }));
  const title = $derived(
    kind === "link" ? t("mdx.insertLink") : kind === "image" ? t("mdx.insertImageUrl") : kind === "table" ? t("mdx.insertTable") : t("mdx.insertCode"),
  );
</script>

<Sheet bind:open {title} side="center" onCloseAutoFocus={e => (e.preventDefault(), target?.focus())}>
  <form id="md-insert-form" class="flex flex-col gap-4 pt-1" onsubmit={submit}>
    {#if kind === "link" || kind === "image"}
      <TextField label={kind === "image" ? t("mdx.imageAlt") : t("mdx.linkTextLabel")} bind:value={linkText} maxlength={300} placeholder={kind === "image" ? t("mdx.imageAltPlaceholder") : t("md.linkText")} />
      <TextField label={kind === "image" ? t("mdx.imageUrl") : t("mdx.linkUrl")} bind:value={linkUrl} type="url" inputmode="url" required placeholder="https://" error={urlError} hint={kind === "image" ? t("mdx.imageUrlHint") : undefined} />
    {:else if kind === "table"}
      <div class="grid grid-cols-2 gap-3">
        <TextField label={t("mdx.tableRows")} bind:value={rows} type="number" min="1" max="50" inputmode="numeric" />
        <TextField label={t("mdx.tableCols")} bind:value={cols} type="number" min="1" max="12" inputmode="numeric" />
      </div>
      <p class="text-[12.5px] text-ink-3">{t("mdx.tableHint")}</p>
    {:else if kind === "code"}
      <div class="flex flex-col gap-1.5">
        <span class="text-[13px] font-medium text-ink-2">{t("mdx.codeLanguage")}</span>
        <Select bind:value={lang} options={languages} label={t("mdx.codeLanguage")} class="w-full" />
      </div>
    {/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{t("action.cancel")}</Button>
    <Button variant="primary" type="submit" form="md-insert-form">{t("mdx.insert")}</Button>
  {/snippet}
</Sheet>

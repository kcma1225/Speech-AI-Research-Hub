<script lang="ts">
  import { Brain, Download, Pencil, Plus, Rocket, Trash2 } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { formatDate, relativeTime, t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import CardHeader from "#lib/components/ui/CardHeader.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import Switch from "#lib/components/ui/Switch.svelte";
  import Textarea from "#lib/components/ui/Textarea.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import McpTokens from "./McpTokens.svelte";
  import type { AgentSettings, Memory } from "#lib/agent/types.ts";

  /** Settings → AI 助理: memory on/off (default off), default autopilot, the memory list, MCP tokens. */
  let settings = $state<AgentSettings | null>(null);
  let memories = $state<Memory[] | null>(null);
  let studies = $state<{ id: string; slug: string; title: string }[]>([]);
  let scope = $state<"all" | "global" | "study">("all");
  let q = $state("");
  let adding = $state(false);
  let draft = $state("");
  let draftScope = $state<"global" | "study">("global");
  let draftStudy = $state("");
  let editing = $state<string | null>(null);
  let editText = $state("");
  let deleting = $state<Memory | null>(null);
  let deleteOpen = $state(false);
  let deleteAllOpen = $state(false);

  $effect(() => {
    api.get<{ settings: AgentSettings }>("/agent/settings").then((r) => (settings = r.settings), (e) => toasts.show(e.message, "error"));
    api.get<{ studies: { id: string; slug: string; title: string }[] }>("/studies?member=me").then((r) => (studies = r.studies), () => {});
  });
  $effect(() => {
    const params = new URLSearchParams();
    if (scope !== "all") params.set("scope", scope);
    if (q.trim()) params.set("q", q.trim());
    const id = setTimeout(() => void load(params), q ? 250 : 0);
    return () => clearTimeout(id);
  });
  async function load(params = new URLSearchParams()) {
    try {
      memories = (await api.get<{ memories: Memory[] }>(`/memories${params.size ? `?${params}` : ""}`)).memories;
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
  async function saveSetting(patch: Partial<AgentSettings>) {
    try {
      settings = (await api.patch<{ settings: AgentSettings }>("/agent/settings", patch)).settings;
      toasts.show(t("agent.settings.saved"), "success");
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
  async function add() {
    const content = draft.trim();
    if (!content) return;
    try {
      await api.post("/memories", { content, scope: draftScope, ...(draftScope === "study" ? { study: draftStudy } : {}) });
      draft = "";
      adding = false;
      await load();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
  async function saveEdit(m: Memory) {
    try {
      await api.patch(`/memories/${m.id}`, { content: editText.trim() });
      editing = null;
      await load();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
  async function remove() {
    if (!deleting) return;
    await api.del(`/memories/${deleting.id}`);
    memories = memories?.filter((m) => m.id !== deleting!.id) ?? null;
    toasts.show(t("crud.memory.deleted"), "success");
  }
  async function removeAll() {
    await api.del("/memories");
    memories = [];
    toasts.show(t("crud.memory.cleared"), "success");
  }
</script>

<div class="flex flex-col gap-5">
  <Card>
    <CardHeader title={t("agent.settings.title")} />
    {#if !settings}
      <Skeleton class="h-24 w-full rounded-2xl" />
    {:else}
      <div class="flex flex-col divide-y divide-line">
        <div class="flex items-start justify-between gap-4 pb-4">
          <div class="flex gap-3.5">
            <span class="grid size-10 shrink-0 place-items-center rounded-xl" style="background:var(--pill-lilac);color:var(--pill-lilac-ink)"><Brain class="size-[18px]" /></span>
            <div>
              <p class="text-[14px] font-medium">{t("agent.settings.memory")}</p>
              <p class="mt-0.5 max-w-lg text-[13px] leading-relaxed text-ink-3">{t("agent.settings.memoryHint")}</p>
              <p class="mt-1.5 max-w-lg text-[12.5px] leading-relaxed text-ink-3">{t("agent.settings.privacy")}</p>
            </div>
          </div>
          <Switch label={t("agent.settings.memory")} checked={settings.memory_enabled} onCheckedChange={(v) => saveSetting({ memory_enabled: v })} />
        </div>
        <div class="flex items-start justify-between gap-4 pt-4">
          <div class="flex gap-3.5">
            <span class="grid size-10 shrink-0 place-items-center rounded-xl" style="background:var(--pill-butter);color:var(--pill-butter-ink)"><Rocket class="size-[18px]" /></span>
            <div>
              <p class="text-[14px] font-medium">{t("agent.settings.autopilot")}</p>
              <p class="mt-0.5 max-w-lg text-[13px] leading-relaxed text-ink-3">{t("agent.settings.autopilotHint")}</p>
            </div>
          </div>
          <Switch label={t("agent.settings.autopilot")} checked={settings.autopilot_default} onCheckedChange={(v) => saveSetting({ autopilot_default: v, ...(v ? { autopilot_explained: true } : {}) })} />
        </div>
      </div>
    {/if}
  </Card>

  <Card>
    <CardHeader title={t("agent.memories")} subtitle={memories ? t("agent.memories.count", { n: memories.length }) : undefined}>
      {#snippet actions()}
        <Button size="sm" variant="ghost" href="/api/memories/export" target="_blank"><Download />{t("agent.memories.export")}</Button>
      {/snippet}
    </CardHeader>
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
      <Segmented bind:value={scope} label={t("agent.memories.scope")} options={[{ value: "all", label: t("agent.memories.scopeAll") }, { value: "global", label: t("agent.memories.scopeGlobal") }, { value: "study", label: t("agent.memories.scopeStudy") }]} />
      <TextField class="sm:flex-1" bind:value={q} placeholder={t("agent.memories.search")} aria-label={t("agent.memories.search")} type="search" />
      <Button variant="secondary" onclick={() => (adding = !adding)}><Plus />{t("agent.memories.add")}</Button>
    </div>

    {#if adding}
      <form
        class="mt-4 flex flex-col gap-3 rounded-2xl bg-surface-2 p-4"
        onsubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <Textarea label={t("agent.memories.add")} bind:value={draft} rows={2} maxlength={300} placeholder={t("agent.memories.addPlaceholder")} />
        <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Segmented bind:value={draftScope} label={t("agent.memories.scope")} options={[{ value: "global", label: t("agent.memories.scopeGlobal") }, { value: "study", label: t("agent.memories.scopeStudy") }]} />
          {#if draftScope === "study"}
            <Select bind:value={draftStudy} label={t("agent.memories.study")} class="w-full sm:w-64" options={[{ value: "", label: t("agent.memories.pickStudy") }, ...studies.map((s) => ({ value: s.slug, label: s.title }))]} />
          {/if}
          <span class="flex-1"></span>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" onclick={() => (adding = false)}>{t("agent.memories.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={!draft.trim() || (draftScope === "study" && !draftStudy)}>{t("agent.memories.save")}</Button>
          </div>
        </div>
      </form>
    {/if}

    <div class="mt-4">
      {#if !memories}
        <div class="flex flex-col gap-2">{#each [0, 1] as i (i)}<Skeleton class="h-16 w-full rounded-2xl" />{/each}</div>
      {:else if !memories.length}
        <div class="rounded-2xl border border-dashed border-line-2 px-4 py-8 text-center">
          <p class="text-[14px] font-medium text-ink-2">{t("agent.memories.empty")}</p>
          <p class="mt-1 text-[13px] text-ink-3">{t("agent.memories.emptyHint")}</p>
        </div>
      {:else}
        <ul class="flex flex-col divide-y divide-line">
          {#each memories as m (m.id)}
            <li class="flex flex-col gap-2 py-3 sm:flex-row sm:items-start">
              <div class="min-w-0 flex-1">
                {#if editing === m.id}
                  <Textarea label={t("agent.memories.edit")} bind:value={editText} rows={2} maxlength={300} />
                  <div class="mt-2 flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onclick={() => (editing = null)}>{t("agent.memories.cancel")}</Button>
                    <Button size="sm" variant="primary" disabled={!editText.trim()} onclick={() => saveEdit(m)}>{t("agent.memories.save")}</Button>
                  </div>
                {:else}
                  <p class="text-[14px] leading-relaxed break-words text-ink">{m.content}</p>
                  <p class="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
                    <Pill size="sm" tone={m.scope === "study" ? "sky" : "stone"}>{m.scope === "study" ? (m.study?.title ?? t("agent.memories.scopeStudy")) : t("agent.memories.scopeGlobal")}</Pill>
                    <span>{m.source === "agent" ? t("agent.memories.fromAgent") : t("agent.memories.fromUser")}</span>
                    {#if m.source_conversation_id}
                      {#if m.source_deleted}<span>· {t("agent.memories.conversationDeleted")}</span>{:else}<a class="underline decoration-line-2 underline-offset-2 hover:text-ink" href="/assistant/{m.source_conversation_id}">· {m.source_conversation_title || t("agent.untitled")}</a>{/if}
                    {/if}
                    <span title={formatDate(m.updated_at)}>· {relativeTime(m.updated_at)}</span>
                  </p>
                {/if}
              </div>
              {#if editing !== m.id}
                <div class="flex shrink-0 gap-1 self-end sm:self-start">
                  <Button size="icon" variant="ghost" aria-label={t("agent.memories.edit")} onclick={() => ((editing = m.id), (editText = m.content))}><Pencil /></Button>
                  <Button size="icon" variant="ghost" aria-label={t("agent.memories.delete")} onclick={() => ((deleting = m), (deleteOpen = true))}><Trash2 /></Button>
                </div>
              {/if}
            </li>
          {/each}
        </ul>
        <div class="mt-3 flex justify-end"><Button size="sm" variant="danger" onclick={() => (deleteAllOpen = true)}><Trash2 />{t("agent.memories.deleteAll")}</Button></div>
      {/if}
    </div>
  </Card>

  <McpTokens />
</div>

<ConfirmDialog bind:open={deleteOpen} title={t("agent.memories.delete")} description={deleting?.content} confirmLabel={t("agent.memories.delete")} onConfirm={remove} />
<ConfirmDialog bind:open={deleteAllOpen} title={t("agent.memories.deleteAllConfirm")} description={t("agent.memories.deleteAllHint")} confirmLabel={t("agent.memories.deleteAll")} onConfirm={removeAll} />

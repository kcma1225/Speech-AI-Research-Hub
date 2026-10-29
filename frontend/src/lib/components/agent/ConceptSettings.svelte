<script lang="ts">
  import { GraduationCap, Trash2 } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { formatDate, relativeTime, t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import CardHeader from "#lib/components/ui/CardHeader.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import Switch from "#lib/components/ui/Switch.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { AgentSettings, ConceptLevel, UserConcept } from "#lib/agent/types.ts";

  /**
   * Settings → AI 助理 → 懂的概念 (`/api/concepts`): what 「先確認先備知識」 remembered; change the level or delete; the
   * 「記住我懂的概念」 switch (`/agent/settings` concept_memory).
   */
  let concepts = $state<UserConcept[] | null>(null);
  let remember = $state<boolean | null>(null);
  let deleteAllOpen = $state(false);
  const levelOptions = $derived((["known", "heard", "unknown"] as const).map((v) => ({ value: v, label: t(`agent.tutor.${v}`) })));

  $effect(() => {
    api.get<{ concepts: UserConcept[] }>("/concepts").then((r) => (concepts = r.concepts), (e) => toasts.show(e.message, "error"));
    api.get<{ settings: AgentSettings }>("/agent/settings").then((r) => (remember = r.settings.concept_memory ?? true), () => {});
  });
  async function setRemember(v: boolean) {
    const before = remember;
    remember = v;
    try {
      remember = (await api.patch<{ settings: AgentSettings }>("/agent/settings", { concept_memory: v })).settings.concept_memory;
      toasts.show(t("agent.tutor.saved"), "success");
    } catch (e) {
      remember = before;
      toasts.show((e as Error).message, "error");
    }
  }
  const path = (c: UserConcept) => `/concepts/${encodeURIComponent(c.key)}`;
  async function setLevel(c: UserConcept, level: ConceptLevel) {
    if (level === c.level) return;
    try {
      const r = await api.patch<{ concept: UserConcept }>(path(c), { level });
      concepts = concepts?.map((x) => (x.key === c.key ? r.concept : x)) ?? null;
      toasts.show(t("agent.tutor.saved"), "success");
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
  async function remove(c: UserConcept) {
    try {
      await api.del(path(c));
      concepts = concepts?.filter((x) => x.key !== c.key) ?? null;
      toasts.show(t("agent.tutor.deleted"), "success");
    } catch (e) {
      toasts.show((e as Error).message, "error");
    }
  }
  async function removeAll() {
    await api.del("/concepts");
    concepts = [];
    toasts.show(t("agent.tutor.deleted"), "success");
  }
</script>

<div id="concepts" class="scroll-mt-20">
  <Card>
    <CardHeader title={t("agent.tutor.concepts")} subtitle={concepts ? String(concepts.length) : undefined} />
    <p class="-mt-1 mb-3 max-w-2xl text-[13px] leading-relaxed text-ink-3">{t("agent.tutor.conceptsHint")}</p>
    {#if remember !== null}
      <div class="mb-3 flex items-start justify-between gap-4 rounded-2xl border border-line px-4 py-3">
        <div>
          <p class="text-[14px] font-medium">{t("agent.tutor.memorySwitch")}</p>
          <p class="mt-0.5 max-w-lg text-[12.5px] leading-relaxed text-ink-3">{t("agent.tutor.memorySwitchHint")}</p>
        </div>
        <Switch label={t("agent.tutor.memorySwitch")} checked={remember} onCheckedChange={(v) => void setRemember(v)} />
      </div>
    {/if}
    {#if !concepts}
      <div class="flex flex-col gap-2">{#each [0, 1] as i (i)}<Skeleton class="h-14 w-full rounded-2xl" />{/each}</div>
    {:else if !concepts.length}
      <div class="rounded-2xl border border-dashed border-line-2 px-4 py-8 text-center">
        <GraduationCap class="mx-auto mb-2 size-5 text-ink-3" />
        <p class="text-[14px] font-medium text-ink-2">{t("agent.tutor.conceptsEmpty")}</p>
        <p class="mt-1 text-[13px] text-ink-3">{t("agent.tutor.conceptsEmptyHint")}</p>
      </div>
    {:else}
      <ul class="flex flex-col divide-y divide-line">
        {#each concepts as c (c.key)}
          <li class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
            <div class="min-w-0 flex-1">
              <p class="flex flex-wrap items-baseline gap-x-1.5">
                <span class="text-[14px] font-medium break-words">{c.term_zh || c.term_en || c.key}</span>
                {#if c.term_zh && c.term_en}<span class="text-[12.5px] break-words text-ink-3">{c.term_en}</span>{/if}
              </p>
              <p class="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
                <Pill size="sm" tone={c.source === "checked" ? "mint" : "stone"}>{c.source === "checked" ? t("agent.tutor.checked") : t("agent.tutor.selfReport")}</Pill>
                {#if c.paper}<a class="truncate underline decoration-line-2 underline-offset-2 hover:text-ink" href="/library?paper={c.paper.id}">{t("agent.tutor.fromPaper", { title: c.paper.title })}</a>{/if}
                <span title={formatDate(c.updated_at)}>· {relativeTime(c.updated_at)}</span>
              </p>
            </div>
            <div class="flex shrink-0 items-center gap-1 self-end sm:self-center">
              <Select label={t("agent.tutor.levelFor", { term: c.term_zh || c.term_en || c.key })} value={c.level as ConceptLevel} options={levelOptions} onValueChange={(v) => void setLevel(c, v)} />
              <Button size="icon" variant="ghost" aria-label={t("agent.tutor.delete")} onclick={() => void remove(c)}><Trash2 /></Button>
            </div>
          </li>
        {/each}
      </ul>
      <div class="mt-3 flex justify-end"><Button size="sm" variant="danger" onclick={() => (deleteAllOpen = true)}><Trash2 />{t("agent.tutor.deleteAll")}</Button></div>
    {/if}
  </Card>
</div>

<ConfirmDialog bind:open={deleteAllOpen} title={t("agent.tutor.deleteAllConfirm")} description={t("agent.tutor.deleteAllHint")} confirmLabel={t("agent.tutor.deleteAll")} onConfirm={removeAll} />

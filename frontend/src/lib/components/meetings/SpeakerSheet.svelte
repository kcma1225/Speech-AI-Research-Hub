<script lang="ts">
  import { Sparkles } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import type { Tone } from "#lib/components/ui/Pill.svelte";
  import Button from "#lib/components/ui/Button.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { MeetingDetail } from "#lib/meetings/types.ts";

  /**
   * Speaker mapping: 語者 1/2/… → a participant / study member, or a free name. Shows a sample line per speaker and the
   * AI's guess from the analysis (manual decision; nothing is applied automatically).
   */
  let { open = $bindable(false), detail, speakers, onChanged }: {
    open?: boolean;
    detail: MeetingDetail;
    speakers: Map<string, { name: string; tone: Tone; mapped: boolean; index: number }>;
    onChanged: (next?: MeetingDetail) => void | Promise<void>;
  } = $props();

  type Row = { label: string; choice: string; name: string };
  let rows = $state<Row[]>([]);
  let saving = $state(false);

  const people = $derived.by(() => {
    const map = new Map<string, string>();
    for (const p of detail.participants) map.set(p.id, p.name);
    for (const s of detail.studies) for (const m of s.members) map.set(m.id, m.name);
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  });
  const options = $derived([
    { value: "", label: t("meet.sp.unassigned") },
    ...people.map(p => ({ value: p.id, label: p.name })),
    { value: "__name", label: t("meet.sp.other") },
  ]);
  const guesses = $derived(new Map((detail.analysis?.speaker_guesses ?? []).map(g => [g.label, g])));

  // (Re)build the rows each time the sheet opens.
  $effect(() => {
    if (!open) return;
    const map = new Map(detail.speaker_map.map(m => [m.speaker_label, m]));
    rows = [...speakers.keys()].map(label => {
      const m = map.get(label);
      return { label, choice: m?.user_id ?? (m?.name ? "__name" : ""), name: m?.name ?? "" };
    });
  });

  const sample = (label: string) => detail.transcript?.segments.find(s => s.speaker === label && s.text.length > 6)?.text ?? detail.transcript?.segments.find(s => s.speaker === label)?.text ?? "";
  const count = (label: string) => detail.transcript?.segments.filter(s => s.speaker === label).length ?? 0;

  function adopt(row: Row) {
    const g = guesses.get(row.label);
    if (!g) return;
    if (g.user_id) row.choice = g.user_id;
    else if (g.name) {
      row.choice = "__name";
      row.name = g.name;
    }
  }

  async function save() {
    saving = true;
    try {
      await api.put(`/meetings/${detail.meeting.id}/speakers`, {
        speakers: rows.map(r => ({ label: r.label, user_id: r.choice && r.choice !== "__name" ? r.choice : null, name: r.choice === "__name" && r.name.trim() ? r.name.trim() : null })),
      });
      toasts.show(t("meet.sp.saved"), "success");
      open = false;
      await onChanged();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      saving = false;
    }
  }
</script>

<Sheet bind:open title={t("meet.sp.title")} description={t("meet.sp.hint")} side="right">
  <ul class="flex flex-col gap-4">
    {#each rows as row (row.label)}
      {@const info = speakers.get(row.label)}
      {@const guess = guesses.get(row.label)}
      <li class="flex flex-col gap-2 rounded-2xl border border-line/80 p-3">
        <div class="flex items-center justify-between gap-2">
          <span class="inline-flex items-center gap-1.5 text-[13px] font-semibold" style="color: var(--pill-{info?.tone ?? 'stone'}-ink)">
            <span class="size-2.5 rounded-full" style="background: var(--pill-{info?.tone ?? 'stone'}-ink)"></span>{t("meet.tr.speakerN", { n: info?.index ?? 0 })}
          </span>
          <span class="text-[12px] text-ink-3">{t("meet.sp.lines", { n: count(row.label) })}</span>
        </div>
        {#if sample(row.label)}<p class="line-clamp-2 text-[13px] text-ink-2">「{sample(row.label)}」</p>{/if}
        <Select bind:value={row.choice} label={t("meet.sp.who", { n: info?.index ?? 0 })} options={options} class="w-full" />
        {#if row.choice === "__name"}<TextField label={t("meet.sp.name")} bind:value={row.name} maxlength={80} />{/if}
        {#if guess && (guess.user_id ? guess.user_id !== row.choice : guess.name !== row.name)}
          <button type="button" class="flex min-h-10 items-start gap-2 rounded-xl bg-surface-2 px-3 py-2 text-left text-[12.5px] text-ink-2 hover:bg-surface-3" onclick={() => adopt(row)}>
            <Sparkles class="mt-0.5 size-3.5 shrink-0" />
            <span>{t("meet.sp.guess", { name: people.find(p => p.id === guess.user_id)?.name ?? guess.name ?? "" })}{guess.reason ? `：${guess.reason}` : ""}<span class="ml-1 font-medium text-ink underline">{t("meet.sp.adopt")}</span></span>
          </button>
        {/if}
      </li>
    {/each}
  </ul>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>{t("meet.cancel")}</Button>
    <Button variant="primary" loading={saving} onclick={save}>{t("meet.save")}</Button>
  {/snippet}
</Sheet>

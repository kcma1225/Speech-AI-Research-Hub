<script lang="ts">
  import { ArrowLeft } from "@lucide/svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import PageHeader from "#lib/components/ui/PageHeader.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import MeetingForm from "#lib/components/meetings/MeetingForm.svelte";
  import type { MeetingDetail } from "#lib/meetings/types.ts";
  import { formDefaults } from "#lib/meetings/util.ts";
  import type { StudyCard } from "#lib/studies/types.ts";

  let value = $state(formDefaults());
  let busy = $state(false);

  // `?study=<slug>` (from a study's 會議 tab) preselects that study and its members.
  $effect(() => {
    const ref = page.url.searchParams.get("study");
    if (!ref) return;
    api.get<{ studies: StudyCard[] }>(`/studies?status=all`).then(r => {
      const s = r.studies.find(x => x.slug === ref || x.id === ref);
      if (s && !value.studies.some(x => x.id === s.id)) {
        value.studies = [...value.studies, { id: s.id, slug: s.slug, title: s.title, owner: s.members.find(m => m.role === "owner")?.name ?? null, members: s.members.map(m => ({ id: m.id, name: m.name, role: m.role })) }];
        value.participants = [...new Set([...value.participants, ...s.members.map(m => m.id)])];
      }
    }, () => {});
  });

  async function create(body: Record<string, unknown>) {
    busy = true;
    try {
      const r = await api.post<MeetingDetail>("/meetings", body);
      toasts.show(t("meet.created"), "success");
      await goto(`/meetings/${r.meeting.id}`);
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>{t("meet.new")} · Speech-AI Hub</title></svelte:head>

<div class="mx-auto w-full max-w-3xl">
  <Button variant="ghost" size="sm" href="/meetings" class="-ml-2 mb-3"><ArrowLeft />{t("pages.meetings.title")}</Button>
  <PageHeader title={t("meet.new")} subtitle={t("meet.newSubtitle")} />
  <Card>
    <MeetingForm bind:value submitLabel={t("meet.form.create")} {busy} onSubmit={create} />
  </Card>
</div>

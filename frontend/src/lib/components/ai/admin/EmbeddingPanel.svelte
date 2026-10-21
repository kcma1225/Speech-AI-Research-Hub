<script lang="ts">
  import { onDestroy } from "svelte";
  import { Check, CircleCheck, CircleX, Database, Fingerprint, Search, Trash2 } from "@lucide/svelte";
  import { formatDate, t } from "#lib/i18n.svelte.ts";
  import { aiApi, toErrorBody, type AiErrorBody, type EmbeddingOverview, type EmbeddingSpace, type Precheck } from "#lib/ai/admin.ts";
  import { adminStore } from "#lib/ai/admin-store.svelte.ts";
  import { aiStatus } from "#lib/ai/status.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import CardHeader from "#lib/components/ui/CardHeader.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Progress from "#lib/components/ui/Progress.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import AiErrorPanel from "../AiErrorPanel.svelte";

  let overview = $state<EmbeddingOverview | null>(null);
  let loadError = $state<AiErrorBody | null>(null);
  let routeId = $state("");
  let pre = $state<Precheck | null>(null);
  let busy = $state<"check" | "start" | "flip" | "bind" | null>(null);
  let error = $state<AiErrorBody | null>(null);
  let confirmCancel = $state(false);
  let confirmDelete = $state(false);
  let target = $state<EmbeddingSpace | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;

  async function load() {
    try {
      overview = await aiApi.get<EmbeddingOverview>("/admin/ai/embedding");
      loadError = null;
    } catch (e) {
      loadError = toErrorBody(e);
    }
  }
  $effect(() => {
    void load();
    timer = setInterval(() => {
      if (!document.hidden && overview?.spaces.some(s => s.status === "building")) void load();
    }, 3000);
    return () => clearInterval(timer);
  });
  onDestroy(() => clearInterval(timer));

  const active = $derived(overview?.spaces.find(s => s.id === overview?.activeSpaceId) ?? null);
  const pending = $derived(overview?.spaces.find(s => s.status === "building" || s.status === "ready" || s.status === "failed") ?? null);
  const embRoutes = $derived((adminStore.routes ?? []).filter(r => r.capability === "embedding" && r.id !== active?.route_id));
  const step = $derived(pending ? (pending.status === "ready" ? 3 : 2) : pre ? 1 : 0);

  async function precheck() {
    if (!routeId) return;
    busy = "check";
    error = null;
    pre = null;
    try {
      pre = await aiApi.post<Precheck>("/admin/ai/embedding/precheck", { route_id: routeId });
    } catch (e) {
      error = toErrorBody(e);
    } finally {
      busy = null;
    }
  }
  async function bindDirect() {
    busy = "bind";
    error = null;
    try {
      await aiApi.put("/admin/ai/roles/embedding", { route_id: routeId });
      toasts.show(t("aiAdmin.emb.bound"), "success");
      pre = null;
      routeId = "";
      await Promise.all([load(), adminStore.reloadRoles(), adminStore.reloadRoutes()]);
    } catch (e) {
      error = toErrorBody(e);
    } finally {
      busy = null;
    }
  }
  async function start() {
    busy = "start";
    error = null;
    try {
      await aiApi.post("/admin/ai/embedding/switch", { route_id: routeId });
      pre = null;
      await load();
    } catch (e) {
      error = toErrorBody(e);
    } finally {
      busy = null;
    }
  }
  async function flip() {
    if (!pending) return;
    busy = "flip";
    error = null;
    try {
      overview = await aiApi.post<EmbeddingOverview>(`/admin/ai/embedding/spaces/${pending.id}/flip`);
      toasts.show(t("aiAdmin.emb.flipped"), "success");
      routeId = "";
      await Promise.all([adminStore.reloadRoles(), adminStore.reloadRoutes()]);
      void aiStatus.refresh();
    } catch (e) {
      error = toErrorBody(e);
    } finally {
      busy = null;
    }
  }
  async function cancel() {
    if (!pending) return;
    overview = await aiApi.post<EmbeddingOverview>(`/admin/ai/embedding/spaces/${pending.id}/cancel`);
    toasts.show(t("aiAdmin.emb.cancelled"), "success");
  }
  async function del() {
    if (!target) return;
    overview = await aiApi.del<EmbeddingOverview>(`/admin/ai/embedding/spaces/${target.id}`);
    toasts.show(t("aiAdmin.emb.deleted"), "success");
  }

  const statusKey = (s: EmbeddingSpace["status"]) => `aiAdmin.emb.status.${s}` as MessageKey;
  const statusTone = { building: "sky", ready: "butter", active: "mint", retired: "stone", failed: "rose" } as const;
  const progress = (s: EmbeddingSpace) => (s.items_total ? Math.round((s.items_done / s.items_total) * 100) : s.status === "ready" ? 100 : 0);
  const steps: MessageKey[] = ["aiAdmin.emb.step.choose", "aiAdmin.emb.step.check", "aiAdmin.emb.step.build", "aiAdmin.emb.step.flip"];
</script>

<section class="flex flex-col gap-4">
  {#if loadError}<AiErrorPanel error={loadError} />{/if}
  <Card>
    <CardHeader title={t("aiAdmin.emb.identity")} />
    {#if !overview}<Skeleton class="h-24" />
    {:else if !active}
      <div class="flex items-start gap-3 rounded-2xl bg-surface-2 p-4">
        <Search class="mt-0.5 size-5 shrink-0 text-ink-3" />
        <div>
          <p class="text-[14px] font-medium">{t("aiAdmin.emb.none")}</p>
          <p class="mt-1 text-[13px] text-ink-3">{t("aiAdmin.emb.noneHint")}</p>
        </div>
      </div>
    {:else}
      <div class="flex flex-col gap-4 sm:flex-row sm:items-center">
        <span class="grid size-12 shrink-0 place-items-center rounded-2xl bg-[var(--pill-lilac)] text-[var(--pill-lilac-ink)]"><Fingerprint class="size-6" /></span>
        <div class="min-w-0 flex-1">
          <p class="truncate text-[16px] font-semibold">{active.label}</p>
          <p class="mt-0.5 text-[13px] text-ink-3">
            <span class="font-mono">{active.model}</span> · {t("aiAdmin.emb.dims", { n: active.dims })} · {t("aiAdmin.emb.items", { done: active.items_done, total: active.items_total })}
          </p>
        </div>
        <Pill tone={overview.mode === "semantic" ? "mint" : "butter"} dot>{overview.mode === "semantic" ? t("aiAdmin.emb.mode.semantic") : t("aiAdmin.emb.mode.keyword")}</Pill>
      </div>
      {#if overview.reason_zh && overview.mode !== "semantic"}<p class="mt-2 text-[12.5px] text-ink-3">{overview.reason_zh}</p>{/if}
    {/if}
  </Card>

  <Card>
    <CardHeader title={t("aiAdmin.emb.wizard")} subtitle={t("aiAdmin.emb.wizardHint")} />
    <ol class="mb-5 grid grid-cols-4 gap-1.5" aria-label={t("aiAdmin.emb.wizard")}>
      {#each steps as s, i (s)}
        <li class="flex flex-col gap-1.5" aria-current={i === step ? "step" : undefined}>
          <span class="h-1 rounded-full {i <= step ? 'bg-ink' : 'bg-line-2'}"></span>
          <span class="text-[11.5px] {i === step ? 'font-semibold text-ink' : 'text-ink-3'}">{i + 1}. {t(s)}</span>
        </li>
      {/each}
    </ol>

    {#if pending}
      <div class="rounded-2xl border border-line p-4" aria-live="polite">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="min-w-0 truncate text-[14px] font-medium">{pending.label}</p>
          <Pill tone={statusTone[pending.status]} size="sm">{t(statusKey(pending.status))}</Pill>
        </div>
        <Progress value={progress(pending)} class="mt-3" />
        <p class="mt-2 text-[12.5px] text-ink-3">
          {pending.status === "building" ? t("aiAdmin.emb.building") : pending.status === "ready" ? t("aiAdmin.emb.ready") : (pending.error ?? "")}
          · {t("aiAdmin.emb.items", { done: pending.items_done, total: pending.items_total })}
        </p>
        <div class="mt-3 flex flex-wrap gap-2">
          {#if pending.status === "ready"}<Button variant="primary" loading={busy === "flip"} onclick={flip}><Check />{t("aiAdmin.emb.flip")}</Button>{/if}
          <Button variant="ghost" onclick={() => (confirmCancel = true)}>{t("aiAdmin.emb.cancel")}</Button>
        </div>
      </div>
    {:else if !active}
      <p class="text-[13px] text-ink-3">{t("aiAdmin.emb.firstSpace")}</p>
    {:else if !embRoutes.length}
      <p class="text-[13px] text-ink-3">{t("aiAdmin.emb.noRoutes")}</p>
    {:else}
      <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div class="flex min-w-0 flex-1 flex-col gap-1.5">
          <span class="text-[13px] font-medium text-ink-2">{t("aiAdmin.emb.pickRoute")}</span>
          <Select
            bind:value={routeId}
            label={t("aiAdmin.emb.pickRoute")}
            class="w-full"
            options={[{ value: "", label: t("aiAdmin.routes.member.pickChild") }, ...embRoutes.map(r => ({ value: r.id, label: r.name }))]}
            onValueChange={() => (pre = null)}
          />
        </div>
        <Button variant="secondary" disabled={!routeId} loading={busy === "check"} onclick={precheck}><Fingerprint />{t("aiAdmin.emb.precheck")}</Button>
      </div>
      {#if pre}
        <div class="mt-4 rounded-2xl border border-line p-4" aria-live="polite">
          <p class="flex items-start gap-2 text-[14px] font-medium">
            {#if pre.same_identity}<CircleCheck class="mt-0.5 size-4.5 shrink-0 text-success" />{t("aiAdmin.emb.same")}{:else}<CircleX class="mt-0.5 size-4.5 shrink-0 text-[var(--pill-butter-ink)]" />{t("aiAdmin.emb.different")}{/if}
          </p>
          {#if pre.comparison}
            <p class="mt-1.5 text-[12.5px] text-ink-3">
              {t("aiAdmin.emb.cosine", { min: pre.comparison.minCosine.toFixed(3), mean: pre.comparison.meanCosine.toFixed(3) })} · {t("aiAdmin.emb.dimsCompare", { a: pre.comparison.dims[0], b: pre.comparison.dims[1] })}
            </p>
          {/if}
          <ul class="mt-3 flex flex-col gap-1.5">
            {#each pre.candidate.members as m (m.memberId)}
              <li class="flex items-start gap-2 text-[12.5px]">
                {#if m.ok && (!m.comparison || m.comparison.same)}<CircleCheck class="mt-0.5 size-3.5 shrink-0 text-success" />{:else}<CircleX class="mt-0.5 size-3.5 shrink-0 text-danger" />{/if}
                <span class="min-w-0"><span class="text-ink-3">{m.providerName} /</span> <span class="font-mono">{m.model}</span>
                  {#if m.dims} · {t("aiAdmin.emb.dims", { n: m.dims })}{/if}
                  {#if m.error} · <span class="text-danger">{m.error.message_zh}</span>{:else if m.comparison && !m.comparison.same} · <span class="text-danger">{t("aiAdmin.emb.memberMismatch")}</span>{/if}</span>
              </li>
            {/each}
          </ul>
          <div class="mt-4 flex flex-wrap gap-2">
            {#if pre.same_identity}
              <Button variant="primary" loading={busy === "bind"} onclick={bindDirect}>{t("aiAdmin.emb.bindDirect")}</Button>
            {:else}
              <Button variant="primary" loading={busy === "start"} disabled={!pre.candidate.consistent || pre.candidate.members.some(m => !m.ok)} onclick={start}><Database />{t("aiAdmin.emb.start")}</Button>
            {/if}
          </div>
        </div>
      {/if}
    {/if}
    {#if error}<AiErrorPanel class="mt-4" {error} />{/if}
  </Card>

  {#if overview?.spaces.length}
    <Card>
      <CardHeader title={t("aiAdmin.emb.spaces")} />
      <ul class="flex flex-col divide-y divide-line/70">
        {#each overview.spaces as s (s.id)}
          <li class="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
            <div class="min-w-0 flex-1">
              <p class="truncate text-[14px] font-medium">{s.label}</p>
              <p class="text-[12px] text-ink-3">{formatDate(s.created_at)} · {t("aiAdmin.emb.items", { done: s.items_done, total: s.items_total })}</p>
            </div>
            <Pill tone={statusTone[s.status]} size="sm">{t(statusKey(s.status))}</Pill>
            {#if s.status === "retired"}
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("aiAdmin.emb.deleteTitle")}
                onclick={() => {
                  target = s;
                  confirmDelete = true;
                }}><Trash2 /></Button
              >
            {/if}
          </li>
        {/each}
      </ul>
    </Card>
  {/if}
</section>

<ConfirmDialog bind:open={confirmCancel} title={t("aiAdmin.emb.cancelTitle")} description={t("aiAdmin.emb.cancelHint")} confirmLabel={t("aiAdmin.emb.cancel")} onConfirm={cancel} />
<ConfirmDialog bind:open={confirmDelete} title={t("aiAdmin.emb.deleteTitle")} description={t("aiAdmin.emb.deleteHint")} confirmLabel={t("aiAdmin.providers.delete")} onConfirm={del} />

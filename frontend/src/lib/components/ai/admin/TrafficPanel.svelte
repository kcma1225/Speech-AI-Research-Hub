<script lang="ts">
  import { CircleCheck, CircleX, ShieldCheck } from "@lucide/svelte";
  import { formatDate, relativeTime, t } from "#lib/i18n.svelte.ts";
  import { aiApi, ROLE_KEYS, toErrorBody, type AiErrorBody, type CallRow, type StatRow, type Stats } from "#lib/ai/admin.ts";
  import { adminStore } from "#lib/ai/admin-store.svelte.ts";
  import { AI_ROLES, type AiRole } from "#lib/ai/status.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import CardHeader from "#lib/components/ui/CardHeader.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Skeleton from "#lib/components/ui/Skeleton.svelte";
  import AiErrorPanel from "../AiErrorPanel.svelte";

  type Win = "1h" | "24h" | "7d" | "30d";
  let win = $state<Win>("24h");
  let stats = $state<Stats | null>(null);
  let statsError = $state<AiErrorBody | null>(null);
  let calls = $state<CallRow[] | null>(null);
  let next = $state<number | null>(null);
  let loadingMore = $state(false);
  let fRole = $state<"" | AiRole>("");
  let fOk = $state<"" | "true" | "false">("");
  let fProvider = $state("");

  $effect(() => {
    const w = win;
    stats = null;
    statsError = null;
    aiApi.get<Stats>(`/admin/ai/stats?window=${w}`).then(
      s => (stats = s),
      e => (statsError = toErrorBody(e)),
    );
  });

  function query(before?: number) {
    const q = new URLSearchParams({ limit: "40" });
    if (fRole) q.set("role", fRole);
    if (fOk) q.set("ok", fOk);
    if (fProvider) q.set("provider_id", fProvider);
    if (before) q.set("before", String(before));
    return `/admin/ai/calls?${q}`;
  }
  $effect(() => {
    void fRole;
    void fOk;
    void fProvider;
    calls = null;
    aiApi.get<{ calls: CallRow[]; next: number | null }>(query()).then(r => ((calls = r.calls), (next = r.next)), () => (calls = []));
  });
  async function more() {
    if (!next) return;
    loadingMore = true;
    try {
      const r = await aiApi.get<{ calls: CallRow[]; next: number | null }>(query(next));
      calls = [...(calls ?? []), ...r.calls];
      next = r.next;
    } finally {
      loadingMore = false;
    }
  }

  const pct = (r: StatRow) => (r.success_rate == null ? "—" : `${Math.round(r.success_rate * 1000) / 10}%`);
  const ms = (v: number | null) => (v == null ? "—" : v >= 1_000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);
  const num = (v: number) => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 10_000 ? `${Math.round(v / 1000)}k` : String(v));
  const roleLabel = (r: AiRole | null | undefined) => (r ? t(ROLE_KEYS[r].label) : t("aiAdmin.traffic.noRole"));
  const maxErr = $derived(Math.max(1, ...(stats?.errors.map(e => e.count) ?? [1])));
  const windows: Win[] = ["1h", "24h", "7d", "30d"];
  const winLabel = { "1h": "aiAdmin.traffic.window.1h", "24h": "aiAdmin.traffic.window.24h", "7d": "aiAdmin.traffic.window.7d", "30d": "aiAdmin.traffic.window.30d" } as const;
</script>

{#snippet rateBar(r: StatRow)}
  <span class="inline-flex items-center gap-2">
    <span class="tabular-nums">{pct(r)}</span>
    <span class="hidden h-1.5 w-14 overflow-hidden rounded-full bg-surface-3 sm:inline-block" aria-hidden="true">
      <span class="block h-full rounded-full {r.success_rate != null && r.success_rate < 0.9 ? 'bg-danger' : 'bg-success'}" style="width: {Math.round((r.success_rate ?? 0) * 100)}%"></span>
    </span>
  </span>
{/snippet}

{#snippet statTable(rows: StatRow[], kind: "role" | "member")}
  {#if !rows.length}
    <p class="py-6 text-center text-[13px] text-ink-3">{t("aiAdmin.traffic.noData")}</p>
  {:else}
    <!-- Desktop table -->
    <div class="hidden overflow-x-auto md:block">
      <table class="w-full text-[13px]">
        <thead class="text-left text-[12px] text-ink-3">
          <tr class="border-b border-line">
            <th class="py-2 pr-3 font-medium">{kind === "role" ? t("aiAdmin.traffic.role") : t("aiAdmin.traffic.model")}</th>
            <th class="px-3 py-2 text-right font-medium">{t("aiAdmin.traffic.calls")}</th>
            <th class="px-3 py-2 font-medium">{t("aiAdmin.traffic.success")}</th>
            <th class="px-3 py-2 text-right font-medium">{t("aiAdmin.traffic.p50")}</th>
            <th class="px-3 py-2 text-right font-medium">{t("aiAdmin.traffic.p95")}</th>
            <th class="px-3 py-2 text-right font-medium">{t("aiAdmin.traffic.tokens")}</th>
            {#if kind === "role"}<th class="py-2 pl-3 text-right font-medium">{t("aiAdmin.traffic.fallbacks")}</th>{/if}
          </tr>
        </thead>
        <tbody>
          {#each rows as r, i (i)}
            <tr class="border-b border-line/60 last:border-0">
              <td class="max-w-72 truncate py-2.5 pr-3">
                {#if kind === "role"}{roleLabel(r.role)}{:else}<span class="text-ink-3">{r.provider_name ?? r.provider_kind}</span> / <span class="font-mono text-[12px]">{r.model}</span>{/if}
              </td>
              <td class="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{r.calls}</td>
              <td class="px-3 py-2.5">{@render rateBar(r)}</td>
              <td class="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{ms(r.p50_ms)}</td>
              <td class="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{ms(r.p95_ms)}</td>
              <td class="px-3 py-2.5 text-right text-ink-2 tabular-nums whitespace-nowrap">{num(r.tokens_in)} / {num(r.tokens_out)}</td>
              {#if kind === "role"}<td class="py-2.5 pl-3 text-right tabular-nums">{r.fallbacks ?? 0}</td>{/if}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <!-- Phone list -->
    <ul class="flex flex-col divide-y divide-line/70 md:hidden">
      {#each rows as r, i (i)}
        <li class="py-3">
          <p class="truncate text-[14px] font-medium">
            {#if kind === "role"}{roleLabel(r.role)}{:else}{r.provider_name ?? r.provider_kind} / <span class="font-mono text-[12.5px]">{r.model}</span>{/if}
          </p>
          <dl class="mt-1.5 grid grid-cols-3 gap-x-3 gap-y-1 text-[12px]">
            <div><dt class="text-ink-3">{t("aiAdmin.traffic.calls")}</dt><dd class="tabular-nums">{r.calls}</dd></div>
            <div><dt class="text-ink-3">{t("aiAdmin.traffic.success")}</dt><dd>{@render rateBar(r)}</dd></div>
            <div><dt class="text-ink-3">p50 / p95</dt><dd class="tabular-nums">{ms(r.p50_ms)} / {ms(r.p95_ms)}</dd></div>
            <div class="col-span-2"><dt class="text-ink-3">{t("aiAdmin.traffic.tokens")}</dt><dd class="tabular-nums">{num(r.tokens_in)} / {num(r.tokens_out)}</dd></div>
            {#if kind === "role"}<div><dt class="text-ink-3">{t("aiAdmin.traffic.fallbacks")}</dt><dd class="tabular-nums">{r.fallbacks ?? 0}</dd></div>{/if}
          </dl>
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

<section class="flex flex-col gap-4">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <p class="flex items-start gap-2 text-[12.5px] text-ink-3"><ShieldCheck class="mt-0.5 size-4 shrink-0" />{t("aiAdmin.traffic.privacy")}</p>
    <Segmented bind:value={win} label={t("aiAdmin.traffic.window")} options={windows.map(w => ({ value: w, label: t(winLabel[w]) }))} />
  </div>
  {#if statsError}<AiErrorPanel error={statsError} />{/if}
  <div class="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
    <Card>
      <CardHeader title={t("aiAdmin.traffic.byRole")} />
      {#if stats}{@render statTable(stats.roles, "role")}{:else}<Skeleton class="h-32" />{/if}
    </Card>
    <Card>
      <CardHeader title={t("aiAdmin.traffic.errors")} />
      {#if !stats}<Skeleton class="h-32" />
      {:else if !stats.errors.length}<p class="py-6 text-center text-[13px] text-ink-3">{t("aiAdmin.traffic.noErrors")}</p>
      {:else}
        <ul class="flex flex-col gap-2.5">
          {#each stats.errors as e (e.error_code)}
            <li>
              <div class="flex items-baseline justify-between gap-2 text-[12.5px]"><code class="truncate text-ink-2">{e.error_code}</code><span class="tabular-nums text-ink">{e.count}</span></div>
              <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden="true"><div class="h-full rounded-full bg-ink-2" style="width: {Math.max(4, (e.count / maxErr) * 100)}%"></div></div>
            </li>
          {/each}
        </ul>
      {/if}
    </Card>
  </div>
  <Card>
    <CardHeader title={t("aiAdmin.traffic.byMember")} />
    {#if stats}{@render statTable(stats.members, "member")}{:else}<Skeleton class="h-32" />{/if}
  </Card>

  <Card>
    <CardHeader title={t("aiAdmin.traffic.recent")} />
    <div class="mb-3 grid gap-2 sm:grid-cols-3">
      <Select bind:value={fRole} label={t("aiAdmin.traffic.role")} class="w-full" options={[{ value: "", label: `${t("aiAdmin.traffic.role")}：${t("aiAdmin.traffic.all")}` }, ...AI_ROLES.map(r => ({ value: r, label: t(ROLE_KEYS[r].label) }))]} />
      <Select bind:value={fOk} label={t("aiAdmin.traffic.result")} class="w-full" options={[{ value: "", label: `${t("aiAdmin.traffic.result")}：${t("aiAdmin.traffic.all")}` }, { value: "true", label: t("aiAdmin.traffic.okOnly") }, { value: "false", label: t("aiAdmin.traffic.failedOnly") }]} />
      <Select bind:value={fProvider} label={t("aiAdmin.traffic.model")} class="w-full" options={[{ value: "", label: `${t("aiAdmin.tab.providers")}：${t("aiAdmin.traffic.all")}` }, ...(adminStore.providers ?? []).map(p => ({ value: p.id, label: p.name }))]} />
    </div>
    {#if !calls}<Skeleton class="h-40" />
    {:else if !calls.length}<p class="py-6 text-center text-[13px] text-ink-3">{t("aiAdmin.traffic.noData")}</p>
    {:else}
      <ul class="flex flex-col divide-y divide-line/70">
        {#each calls as c (c.id)}
          <li class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5 py-2.5 text-[13px]">
            <span class="mt-0.5">{#if c.ok}<CircleCheck class="size-4 text-success" aria-label={t("aiAdmin.traffic.ok")} />{:else}<CircleX class="size-4 text-danger" aria-label={c.error_code ?? ""} />{/if}</span>
            <div class="min-w-0">
              <p class="truncate">
                <span class="font-medium">{roleLabel(c.role)}</span>
                {#if c.provider_name}<span class="text-ink-3"> · {c.provider_name} / </span><span class="font-mono text-[12px]">{c.model}</span>{/if}{#if c.group_name}<span class="text-ink-3"> · {t("aiAdmin.traffic.inGroup", { name: c.group_name })}</span>{/if}
              </p>
              <p class="truncate text-[12px] text-ink-3">
                <time datetime={c.started_at} title={formatDate(c.started_at)}>{relativeTime(c.started_at)}</time>
                {#if !c.ok && c.error_code} · <code class="text-danger">{c.error_code}</code>{/if}
                {#if c.fallback_index > 0} · {t("aiAdmin.traffic.fallbackN", { n: c.fallback_index })}{/if}
                {#if c.retries} · {t("aiAdmin.traffic.retries", { n: c.retries })}{/if}
                {#if c.user_name} · {c.user_name}{:else if c.job_id} · {t("aiAdmin.traffic.job")}{/if}
              </p>
            </div>
            <div class="text-right text-[12px] tabular-nums text-ink-2">
              <p>{ms(c.latency_ms)}</p>
              {#if c.tokens_in != null || c.tokens_out != null}<p class="text-ink-3">{num(c.tokens_in ?? 0)} / {num(c.tokens_out ?? 0)}</p>{/if}
            </div>
          </li>
        {/each}
      </ul>
      {#if next}<div class="mt-3 flex justify-center"><Button variant="ghost" loading={loadingMore} onclick={more}>{t("aiAdmin.traffic.loadMore")}</Button></div>{/if}
    {/if}
  </Card>
</section>

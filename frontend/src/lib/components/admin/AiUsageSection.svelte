<script lang="ts">
  import { displayName } from "#lib/people.svelte.ts";
  import { RefreshCw } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
    import Segmented from "#lib/components/ui/Segmented.svelte";
  import { fmtTokens } from "#lib/components/workflows/meta.ts";

  /** /admin/system 「AI 用量」: aggregates of the AI call log and workflow runs (`GET /api/admin/ai/usage`). Numbers only. */
  type Agg = { calls: number; attempts: number; errors: number; tokens_in: number; tokens_out: number };
  type Usage = {
    days: number;
    totals: Agg & { users: number };
    by_role: (Agg & { role: string })[];
    by_model: (Agg & { provider_kind: string | null; provider_name: string | null; model: string })[];
    by_account_role: (Agg & { account_role: string })[];
    by_user: (Agg & { user: { id: string; name: string; username: string; role: string | null } | null })[];
    top_users: (Agg & { user: { id: string; name: string; username: string; role: string | null } })[];
    workflows: { status: string; runs: number; tokens: number }[];
  };
  let days = $state<"7" | "30">("7");
  let data = $state<Usage | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);
  async function load() {
    loading = true;
    try {
      data = await api.get<Usage>(`/admin/ai/usage?days=${days}`);
      error = null;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    void days;
    void load();
  });
  const label = (key: string) => {
    const text = t(key as MessageKey);
    return text === key ? "" : text;
  };
  const roleName = (r: string) => label(`aiAdmin.role.${r}`) || r || "—";
  const accountName = (r: string) => (r === "system" ? t("aiUsage.system") : label(`role.${r}`) || r);
  const maxUserTokens = $derived(Math.max(1, ...(data?.top_users ?? []).map((u) => u.tokens_in + u.tokens_out)));
</script>

<Card>
  <!-- Own header (not CardHeader): on phones the range controls wrap under the title instead of squeezing the subtitle. -->
  <header class="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
    <div class="min-w-0 basis-64 grow">
      <h2 class="text-[15px] font-semibold tracking-[-0.01em] text-ink">{t("aiUsage.title")}</h2>
      <p class="mt-0.5 text-[13px] text-ink-3">{t("aiUsage.subtitle")}</p>
    </div>
    <div class="flex shrink-0 items-center gap-1">
      <Segmented bind:value={days} guardIgnore label={t("aiUsage.range")} options={[{ value: "7", label: t("aiUsage.range7") }, { value: "30", label: t("aiUsage.range30") }]} />
      <Button variant="ghost" size="icon" aria-label={t("aiUsage.refresh")} title={t("aiUsage.refresh")} loading={loading} onclick={load}><RefreshCw /></Button>
    </div>
  </header>

  {#if error}
    <p class="mt-3 rounded-2xl bg-danger-soft p-3 text-[13px] text-danger" role="alert">{t("aiUsage.loadFailed")}：{error}</p>
  {:else if !data}
    <div class="mt-4 h-24 animate-pulse rounded-2xl bg-surface-2"></div>
  {:else}
    <dl class="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
      {#each [["aiUsage.calls", data.totals.calls.toLocaleString()], ["aiUsage.tokensIn", fmtTokens(data.totals.tokens_in)], ["aiUsage.tokensOut", fmtTokens(data.totals.tokens_out)], ["aiUsage.errors", data.totals.errors.toLocaleString()], ["aiUsage.activeUsers", String(data.totals.users)]] as [k, v], i (k)}
        <div class="rounded-2xl bg-surface-2 px-3 py-2.5 {i === 4 ? 'col-span-2 sm:col-span-1' : ''}">
          <dt class="text-[12px] text-ink-3">{t(k as MessageKey)}</dt>
          <dd class="text-[20px] font-semibold text-ink tabular-nums">{v}</dd>
        </div>
      {/each}
    </dl>

    {#if !data.totals.attempts}
      <p class="mt-4 text-[13px] text-ink-3">{t("aiUsage.empty")}</p>
    {:else}
      <div class="mt-5 grid gap-x-8 gap-y-6 lg:grid-cols-2 2xl:grid-cols-3">
        {#snippet table(title: string, col: string, rows: { key: string; name: string; sub?: string; agg: Agg }[])}
          <section class="min-w-0">
            <h3 class="mb-2 text-[13px] font-semibold text-ink-2">{title}</h3>
            <div class="overflow-x-auto">
              <table class="w-full table-fixed text-[13px]">
                <thead><tr class="text-left text-[12px] text-ink-3"><th class="py-1 pr-2 font-medium">{col}</th><th class="w-16 py-1 pr-2 text-right font-medium sm:w-[5.5rem]">{t("aiUsage.colCalls")}</th><th class="w-24 py-1 text-right font-medium sm:w-[7.5rem]">{t("aiUsage.colTokens")}</th></tr></thead>
                <tbody>
                  {#each rows as r (r.key)}
                    <tr class="border-t border-line">
                      <td class="py-1.5 pr-2"><span class="block truncate text-ink" title={r.name}>{r.name}</span>{#if r.sub}<span class="block truncate text-[11.5px] text-ink-3" title={r.sub}>{r.sub}</span>{/if}</td>
                      <td class="py-1.5 pr-2 text-right whitespace-nowrap tabular-nums">{r.agg.calls}{#if r.agg.errors}<span class="text-danger"> ({r.agg.errors})</span>{/if}</td>
                      <td class="py-1.5 text-right whitespace-nowrap tabular-nums">{fmtTokens(r.agg.tokens_in)} / {fmtTokens(r.agg.tokens_out)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </section>
        {/snippet}

        <!-- Column 1 stacks the short lists; the long per-role and per-model tables get their own columns on wide screens. -->
        <div class="flex min-w-0 flex-col gap-6">
        <section class="min-w-0">
          <h3 class="mb-2 text-[13px] font-semibold text-ink-2">{t("aiUsage.topUsers")}</h3>
          <ul class="flex flex-col gap-2">
            {#each data.top_users as u (u.user.id)}
              {@const total = u.tokens_in + u.tokens_out}
              <li>
                <div class="flex items-baseline gap-2 text-[13px]">
                  <span class="min-w-0 flex-1 truncate text-ink">{displayName(u.user)} <span class="text-ink-3">@{u.user.username}</span></span>
                  <span class="shrink-0 text-ink-3 tabular-nums">{u.calls} · {fmtTokens(u.tokens_in)} / {fmtTokens(u.tokens_out)}</span>
                </div>
                <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3"><div class="h-full rounded-full bg-ink" style="width:{Math.max(2, (total / maxUserTokens) * 100)}%"></div></div>
              </li>
            {/each}
          </ul>
        </section>

        {@render table(t("aiUsage.byUserRole"), t("aiUsage.colUser"), data.by_account_role.map((r) => ({ key: r.account_role, name: accountName(r.account_role), agg: r })))}
        <section class="min-w-0">
          <h3 class="mb-2 text-[13px] font-semibold text-ink-2">{t("aiUsage.workflows")}</h3>
          {#if data.workflows.length}
            <ul class="flex flex-wrap gap-2">
              {#each data.workflows as w (w.status)}
                <li class="rounded-2xl bg-surface-2 px-3 py-2 text-[13px]"><span class="text-ink-3">{label(`wf.status.${w.status}`) || w.status}</span> <span class="font-semibold text-ink tabular-nums">{w.runs}</span> <span class="text-[11.5px] text-ink-3 tabular-nums">· {fmtTokens(w.tokens)}</span></li>
              {/each}
            </ul>
          {:else}
            <p class="text-[13px] text-ink-3">{t("aiUsage.workflowsNone")}</p>
          {/if}
        </section>
        </div>
        {@render table(t("aiUsage.byRole"), t("aiUsage.colRole"), data.by_role.map((r) => ({ key: r.role, name: roleName(r.role), agg: r })))}
        <div class="min-w-0 lg:col-span-2 2xl:col-span-1">
          {@render table(t("aiUsage.byModel"), t("aiUsage.colModel"), data.by_model.map((r) => ({ key: `${r.provider_kind}/${r.provider_name}/${r.model}`, name: r.model || t("aiUsage.unknownModel"), sub: r.provider_name ?? r.provider_kind ?? "", agg: r })))}
        </div>
      </div>
    {/if}
  {/if}
</Card>

<script lang="ts">
  import { Copy, KeyRound, Plus } from "@lucide/svelte";
  import { api } from "#lib/api.ts";
  import { formatDate, relativeTime, t } from "#lib/i18n.svelte.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Card from "#lib/components/ui/Card.svelte";
  import CardHeader from "#lib/components/ui/CardHeader.svelte";
  import ConfirmDialog from "#lib/components/ui/ConfirmDialog.svelte";
  import Pill from "#lib/components/ui/Pill.svelte";
  import Select from "#lib/components/ui/Select.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Switch from "#lib/components/ui/Switch.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import { toasts } from "#lib/components/ui/toast.svelte.ts";
  import type { McpToken } from "#lib/agent/types.ts";

  /** Personal MCP tokens (read, or read + suggest). The raw token is shown once after creation. */
  let tokens = $state<McpToken[] | null>(null);
  let endpoint = $state("");
  let createOpen = $state(false);
  let name = $state("");
  let suggest = $state(false);
  let expires = $state<"30" | "90" | "365" | "never">("90");
  let secret = $state<string | null>(null);
  let busy = $state(false);
  let revoking = $state<McpToken | null>(null);
  let revokeOpen = $state(false);

  async function load() {
    const r = await api.get<{ tokens: McpToken[]; endpoint: string }>("/agent/mcp-tokens");
    tokens = r.tokens;
    endpoint = r.endpoint;
  }
  $effect(() => {
    load().catch((e) => toasts.show(e.message, "error"));
  });
  async function create() {
    busy = true;
    try {
      const r = await api.post<{ secret: string }>("/agent/mcp-tokens", { name: name.trim(), scopes: suggest ? ["read", "suggest"] : ["read"], expires_in_days: expires === "never" ? null : Number(expires) });
      secret = r.secret;
      name = "";
      await load();
    } catch (e) {
      toasts.show((e as Error).message, "error");
    } finally {
      busy = false;
    }
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toasts.show(t("agent.copied"), "success");
    } catch {
      // clipboard unavailable
    }
  }
  async function revoke() {
    if (!revoking) return;
    await api.del(`/agent/mcp-tokens/${revoking.id}`);
    toasts.show(t("crud.mcp.revoked"), "success");
    await load();
  }
</script>

<Card>
  <CardHeader title={t("agent.mcp.title")} subtitle={t("agent.mcp.hint")}>
    {#snippet actions()}
      <Button size="sm" variant="secondary" onclick={() => ((secret = null), (createOpen = true))}><Plus />{t("agent.mcp.create")}</Button>
    {/snippet}
  </CardHeader>
  {#if endpoint}
    <div class="mb-4 flex items-center gap-2 rounded-2xl bg-surface-2 px-3.5 py-2.5 text-[13px]">
      <span class="shrink-0 text-ink-3">{t("agent.mcp.endpoint")}</span>
      <code class="min-w-0 flex-1 truncate text-ink">{endpoint}</code>
      <Button size="icon-sm" variant="ghost" aria-label={t("agent.copy")} onclick={() => copy(endpoint)}><Copy /></Button>
    </div>
  {/if}
  {#if tokens && !tokens.length}
    <p class="rounded-2xl border border-dashed border-line-2 px-4 py-6 text-center text-[13px] text-ink-3">{t("agent.mcp.empty")}</p>
  {:else if tokens}
    <ul class="flex flex-col divide-y divide-line">
      {#each tokens as tk (tk.id)}
        <li class="flex items-center gap-3 py-3">
          <span class="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-3 text-ink-2"><KeyRound class="size-4" /></span>
          <div class="min-w-0 flex-1">
            <p class="truncate text-[14px] font-medium text-ink">{tk.name}</p>
            <p class="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
              <code>{tk.prefix}…</code>
              <Pill size="sm" tone={tk.scopes.includes("suggest") ? "butter" : "stone"}>{tk.scopes.includes("suggest") ? t("agent.mcp.scopeSuggest") : t("agent.mcp.scopeRead")}</Pill>
              <span>{tk.last_used_at ? t("agent.mcp.lastUsed", { when: relativeTime(tk.last_used_at) }) : t("agent.mcp.neverUsed")}</span>
              {#if tk.expires_at}<span><span aria-hidden="true" class="max-sm:hidden">· </span>{t("agent.mcp.expiresAt", { date: formatDate(tk.expires_at) })}</span>{/if}
            </p>
          </div>
          <Button size="sm" variant="ghost" onclick={() => ((revoking = tk), (revokeOpen = true))}>{t("agent.mcp.revoke")}</Button>
        </li>
      {/each}
    </ul>
  {/if}
</Card>

<Sheet bind:open={createOpen} dirty={secret ? false : undefined} title={t("agent.mcp.create")} side="center">
  {#if secret}
    <div class="flex flex-col gap-3">
      <p class="text-[13px] text-ink-2">{t("agent.mcp.created")}</p>
      <code class="block rounded-2xl bg-surface-2 p-3 text-[12.5px] break-all text-ink">{secret}</code>
    </div>
  {:else}
    <form
      class="flex flex-col gap-4"
      onsubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <TextField label={t("agent.mcp.name")} bind:value={name} maxlength={80} placeholder={t("agent.mcp.namePlaceholder")} />
      <div class="flex items-center justify-between gap-3">
        <span class="text-[13.5px] text-ink-2">{t("agent.mcp.allowSuggest")}</span>
        <Switch label={t("agent.mcp.allowSuggest")} bind:checked={suggest} />
      </div>
      <Select bind:value={expires} label={t("agent.mcp.expires")} options={[{ value: "30", label: t("agent.mcp.expires30") }, { value: "90", label: t("agent.mcp.expires90") }, { value: "365", label: t("agent.mcp.expires365") }, { value: "never", label: t("agent.mcp.expiresNever") }]} />
    </form>
  {/if}
  {#snippet footer()}
    {#if secret}
      <Button variant="ghost" onclick={() => (createOpen = false)}>{t("common.close")}</Button>
      <Button variant="primary" onclick={() => copy(secret!)}><Copy />{t("agent.mcp.copy")}</Button>
    {:else}
      <Button variant="ghost" onclick={() => (createOpen = false)}>{t("agent.memories.cancel")}</Button>
      <Button variant="primary" loading={busy} disabled={!name.trim()} onclick={create}>{t("agent.mcp.create")}</Button>
    {/if}
  {/snippet}
</Sheet>

<ConfirmDialog bind:open={revokeOpen} title={t("agent.mcp.revokeConfirm")} description={t("agent.mcp.revokeHint")} confirmLabel={t("agent.mcp.revoke")} onConfirm={revoke} />

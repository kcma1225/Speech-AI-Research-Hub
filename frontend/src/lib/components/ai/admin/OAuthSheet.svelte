<script lang="ts">
  import { onDestroy } from "svelte";
  import { CircleCheck, Copy, ExternalLink, TriangleAlert } from "@lucide/svelte";
  import { relativeTime, t } from "#lib/i18n.svelte.ts";
  import { aiApi, toErrorBody, type AiErrorBody, type OAuthMeta, type Provider } from "#lib/ai/admin.ts";
  import Button from "#lib/components/ui/Button.svelte";
  import Sheet from "#lib/components/ui/Sheet.svelte";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import Textarea from "#lib/components/ui/Textarea.svelte";
  import TextField from "#lib/components/ui/TextField.svelte";
  import AiErrorPanel from "../AiErrorPanel.svelte";

  /** Subscription sign-in: ChatGPT device code (polled) or Claude copy-code / setup-token. */
  let { open = $bindable(false), provider, onDone }: { open?: boolean; provider: Provider | null; onDone: () => void } = $props();

  type Start =
    | { session_id: string; flow: "chatgpt_device"; user_code: string; verification_url: string; interval_sec: number; expires_at: string }
    | { session_id: string; flow: "claude_pkce"; authorize_url: string; expires_at: string };
  let start = $state<Start | null>(null);
  let busy = $state(false);
  let error = $state<AiErrorBody | null>(null);
  let done = $state<OAuthMeta | null>(null);
  let code = $state("");
  let token = $state("");
  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      start = null;
      error = null;
      done = null;
      code = token = "";
    }
    if (!open) clearTimeout(timer);
    wasOpen = open;
  });
  onDestroy(() => clearTimeout(timer));

  async function begin() {
    if (!provider) return;
    busy = true;
    error = null;
    try {
      start = await aiApi.post<Start>(`/admin/ai/providers/${provider.id}/oauth/start`);
      if (start.flow === "chatgpt_device") schedule(start.interval_sec);
    } catch (e) {
      error = toErrorBody(e);
    } finally {
      busy = false;
    }
  }

  function schedule(sec: number) {
    clearTimeout(timer);
    timer = setTimeout(poll, Math.max(2, sec) * 1000);
  }

  async function poll() {
    if (!open || !start || start.flow !== "chatgpt_device") return;
    try {
      const r = await aiApi.post<{ status: "pending" | "complete"; oauth?: OAuthMeta }>(`/admin/ai/oauth/sessions/${start.session_id}/poll`);
      if (r.status === "complete") finish(r.oauth ?? { status: "connected" });
      else schedule(start.interval_sec);
    } catch (e) {
      error = toErrorBody(e);
      start = null;
    }
  }

  function finish(meta: OAuthMeta) {
    done = meta;
    clearTimeout(timer);
    onDone();
  }

  async function submitCode() {
    if (!start || start.flow !== "claude_pkce" || !code.trim()) return;
    busy = true;
    error = null;
    try {
      const r = await aiApi.post<{ oauth: OAuthMeta }>(`/admin/ai/oauth/sessions/${start.session_id}/complete`, { code: code.trim() });
      finish(r.oauth);
    } catch (e) {
      error = toErrorBody(e);
    } finally {
      busy = false;
    }
  }

  async function submitToken() {
    if (!provider || !token.trim()) return;
    busy = true;
    error = null;
    try {
      const r = await aiApi.post<{ oauth: OAuthMeta }>(`/admin/ai/providers/${provider.id}/oauth/token`, { token: token.trim() });
      token = "";
      finish(r.oauth);
    } catch (e) {
      error = toErrorBody(e);
    } finally {
      busy = false;
    }
  }

  async function copyCode(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {}
  }
</script>

<Sheet bind:open side="right" title={t("aiAdmin.oauth.title", { name: provider?.name ?? "" })} description={provider?.label ? (provider.label.zh) : undefined}>
  {#snippet children()}
    {#if provider}
      <div class="flex flex-col gap-4 pt-1">
        {#if provider.warnings_zh.length}
          <div class="rounded-2xl border border-[var(--pill-butter-ink)]/25 bg-[var(--pill-butter)] p-3.5 text-[13px] text-[var(--pill-butter-ink)]">
            <p class="mb-1.5 flex items-center gap-1.5 font-semibold"><TriangleAlert class="size-4" />{t("aiAdmin.sheet.warnings")}</p>
            <ul class="list-disc space-y-1 pl-5 leading-snug">{#each provider.warnings_zh as w (w)}<li>{w}</li>{/each}</ul>
          </div>
        {/if}

        {#if done}
          <div class="flex flex-col items-center gap-2 rounded-2xl bg-surface-2 px-4 py-8 text-center" aria-live="polite">
            <CircleCheck class="size-8 text-success" />
            <p class="text-[15px] font-semibold">{t("aiAdmin.oauth.done")}</p>
            {#if done.email || done.planType}<p class="text-[13px] text-ink-3">{[done.email, done.planType].filter(Boolean).join(" · ")}</p>{/if}
          </div>
        {:else if provider.kind === "chatgpt"}
          {#if start?.flow === "chatgpt_device"}
            <div class="rounded-2xl bg-surface-2 p-4">
              <p class="text-[13px] text-ink-2">{t("aiAdmin.oauth.chatgptCode")}</p>
              <a href={start.verification_url} target="_blank" rel="noopener noreferrer" class="mt-1 block truncate text-[13px] font-medium text-ink underline underline-offset-2">{start.verification_url}</a>
              <div class="mt-3 flex items-center gap-2">
                <code class="flex-1 rounded-xl border border-line bg-surface px-4 py-3 text-center font-mono text-[22px] font-semibold tracking-[0.18em] text-ink">{start.user_code}</code>
                <Button size="icon" variant="outline" aria-label={copied ? t("aiAdmin.oauth.copied") : t("aiAdmin.oauth.copy")} onclick={() => copyCode(start?.flow === "chatgpt_device" ? start.user_code : "")}><Copy /></Button>
              </div>
              <div class="mt-3 flex flex-wrap items-center gap-3">
                <Button variant="primary" href={start.verification_url} target="_blank">{t("aiAdmin.oauth.openLink")}<ExternalLink /></Button>
                <span class="inline-flex items-center gap-2 text-[12.5px] text-ink-3" aria-live="polite"><Spinner class="size-3.5" />{t("aiAdmin.oauth.waiting")}</span>
              </div>
              <p class="mt-2 text-[12px] text-ink-3">{t("aiAdmin.oauth.expires", { time: relativeTime(start.expires_at) })}</p>
            </div>
          {:else}
            <Button variant="primary" loading={busy} onclick={begin}>{t("aiAdmin.oauth.start")}</Button>
          {/if}
        {:else if provider.kind === "claude-oauth"}
          {#if start?.flow === "claude_pkce"}
            <ol class="flex flex-col gap-4">
              <li class="rounded-2xl bg-surface-2 p-4">
                <p class="text-[13.5px] font-medium">1. {t("aiAdmin.oauth.claudeStep1")}</p>
                <Button class="mt-3" variant="primary" href={start.authorize_url} target="_blank">{t("aiAdmin.oauth.openLink")}<ExternalLink /></Button>
                <p class="mt-2 text-[12px] text-ink-3">{t("aiAdmin.oauth.expires", { time: relativeTime(start.expires_at) })}</p>
              </li>
              <li class="rounded-2xl bg-surface-2 p-4">
                <p class="mb-2 text-[13.5px] font-medium">2. {t("aiAdmin.oauth.claudeStep2")}</p>
                <Textarea label={t("aiAdmin.oauth.codeLabel")} bind:value={code} rows={2} spellcheck="false" autocomplete="off" />
                <Button class="mt-3" variant="primary" loading={busy} disabled={!code.trim()} onclick={submitCode}>{t("aiAdmin.oauth.submit")}</Button>
              </li>
            </ol>
          {:else}
            <Button variant="primary" loading={busy} onclick={begin}>{t("aiAdmin.oauth.start")}</Button>
          {/if}
          <div class="border-t border-line pt-4">
            <p class="mb-2 text-[13px] font-medium text-ink-2">{t("aiAdmin.oauth.orToken")}</p>
            <TextField label={t("aiAdmin.oauth.tokenLabel")} type="password" bind:value={token} autocomplete="off" />
            <Button class="mt-3" variant="outline" loading={busy && !start} disabled={!token.trim()} onclick={submitToken}>{t("aiAdmin.oauth.useToken")}</Button>
          </div>
        {:else}
          <p class="text-[13px] text-ink-3">{t("aiAdmin.oauth.cliNote")}</p>
        {/if}
        {#if error}<AiErrorPanel compact {error} />{/if}
      </div>
    {/if}
  {/snippet}
  {#snippet footer()}
    <Button variant={done ? "primary" : "ghost"} onclick={() => (open = false)}>{t("common.close")}</Button>
  {/snippet}
</Sheet>

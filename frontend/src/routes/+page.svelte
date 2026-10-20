<script lang="ts">
  type Ready = { ok: boolean; db: boolean; storage: boolean };
  let status = $state<Ready | null>(null);
  let failed = $state(false);

  $effect(() => {
    fetch("/api/health/ready", { cache: "no-store" })
      .then(response => response.json() as Promise<Ready>)
      .then(body => (status = body))
      .catch(() => (failed = true));
  });

  const label = (ok: boolean | undefined) => (ok ? "正常" : "異常");
</script>

<svelte:head><title>Speech-AI Research Hub</title></svelte:head>

<main class="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 px-4">
  <h1 class="text-2xl font-semibold">Speech-AI Research Hub — v2 前端開發中</h1>
  <section aria-live="polite" class="text-sm">
    {#if failed}
      <p>無法連線至後端。</p>
    {:else if !status}
      <p>檢查服務狀態…</p>
    {:else}
      <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt>後端</dt><dd>{label(status.ok)}</dd>
        <dt>資料庫</dt><dd>{label(status.db)}</dd>
        <dt>物件儲存</dt><dd>{label(status.storage)}</dd>
      </dl>
    {/if}
  </section>
</main>

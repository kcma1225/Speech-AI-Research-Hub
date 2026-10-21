<script lang="ts" module>
  import { aiApi, type VisionSource } from "#lib/ai/admin.ts";

  /** Detection per account + model, shared by every badge (GET /admin/ai/vision re-reads stale model lists). */
  const cache = new Map<string, Promise<{ detected: boolean; source: VisionSource }>>();
  function detect(providerId: string, model: string) {
    const key = `${providerId}\u0000${model}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = aiApi.get<{ detected: boolean; source: VisionSource }>(`/admin/ai/vision?provider_id=${encodeURIComponent(providerId)}&model=${encodeURIComponent(model)}`);
      hit.catch(() => cache.delete(key));
      cache.set(key, hit);
    }
    return hit;
  }
</script>

<script lang="ts">
  import { Eye, EyeOff } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import type { MessageKey } from "#lib/messages.ts";

  /**
   * 「視覺」 badge of a route member: the admin's override (`params.vision` = yes | no) wins, else auto-detection.
   * Pass `vision` directly (role bindings already know it) or `providerId` + `model` to detect.
   */
  let { providerId = "", model = "", override = "", vision, source }: { providerId?: string; model?: string; override?: string; vision?: boolean; source?: VisionSource } = $props();

  let detected = $state<{ detected: boolean; source: VisionSource } | null>(null);
  $effect(() => {
    if (vision !== undefined || !providerId || !model.trim()) return void (detected = null);
    let alive = true;
    const timer = setTimeout(() => {
      detect(providerId, model.trim()).then(r => alive && (detected = r), () => alive && (detected = null));
    }, 400);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  });

  const manual = $derived(override === "yes" || override === "no");
  const on = $derived(manual ? override === "yes" : (vision ?? detected?.detected ?? false));
  const why = $derived(manual ? "override" : (source ?? detected?.source ?? "unknown"));
</script>

{#if on}
  <span class="inline-flex h-6 items-center gap-1 rounded-full bg-[var(--pill-sky)] px-2 text-[11.5px] font-semibold text-[var(--pill-sky-ink)]" title={t(`vision.source.${why}` as MessageKey)}>
    <Eye class="size-3.5" aria-hidden="true" />{manual ? t("vision.badgeManual") : t("vision.badge")}
  </span>
{:else if manual}
  <span class="inline-flex h-6 items-center gap-1 rounded-full bg-surface-3 px-2 text-[11.5px] font-medium text-ink-3" title={t("vision.source.override")}>
    <EyeOff class="size-3.5" aria-hidden="true" />{t("vision.badgeNo")}
  </span>
{/if}

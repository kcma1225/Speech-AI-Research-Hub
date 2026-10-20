<script lang="ts">
  import { DropdownMenu } from "bits-ui";
  import { Check, Pause, Play, RotateCcw, RotateCw, Volume1, Volume2, VolumeX } from "@lucide/svelte";
  import { t } from "#lib/i18n.svelte.ts";
  import { formatClock } from "#lib/recordings/types.ts";
  import { menuContent, menuItem, menuLabel } from "#lib/components/ui/menu.ts";
  import Spinner from "#lib/components/ui/Spinner.svelte";
  import Waveform from "./Waveform.svelte";
  import VolumeSlider from "./VolumeSlider.svelte";

  /**
   * Custom audio player: a hidden <audio> element drives a waveform seek bar and custom controls.
   * `currentTime` / `playing` are bindable so a transcript can follow along; call `seek()` from outside.
   * `shortcuts` installs page-level keys (Space/K play-pause, J/L ±10 s, ←/→ ±5 s).
   */
  let {
    src,
    title,
    artist = "",
    peaks = null,
    duration: durationHint = null,
    currentTime = $bindable(0),
    playing = $bindable(false),
    shortcuts = true,
    compact = false,
    class: cls = "",
  }: {
    src: string;
    title: string;
    artist?: string;
    peaks?: number[] | null;
    duration?: number | null;
    currentTime?: number;
    playing?: boolean;
    shortcuts?: boolean;
    /** Smaller waveform and tighter controls (phone sticky bar). */
    compact?: boolean;
    class?: string;
  } = $props();

  const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
  const SKIP = 10;

  let audio = $state<HTMLAudioElement | null>(null);
  let mediaDuration = $state<number | null>(null);
  let buffering = $state(false);
  let failed = $state(false);
  let rate = $state(readNumber("hub-audio-rate", 1, v => RATES.includes(v)));
  let volume = $state(readNumber("hub-audio-volume", 1, v => v >= 0 && v <= 1));
  let muted = $state(false);
  let frame = 0;

  const duration = $derived(mediaDuration ?? durationHint ?? 0);

  function readNumber(key: string, fallback: number, ok: (v: number) => boolean) {
    try {
      const v = Number(localStorage.getItem(key));
      return localStorage.getItem(key) !== null && ok(v) ? v : fallback;
    } catch {
      return fallback;
    }
  }
  function store(key: string, value: number) {
    try {
      localStorage.setItem(key, String(value));
    } catch {}
  }

  export function seek(time: number, play = false) {
    if (!audio) return;
    const target = Math.max(0, Math.min(duration || Infinity, time));
    audio.currentTime = target;
    currentTime = target;
    if (play && audio.paused) void start();
    updatePosition();
  }
  export function toggle() {
    if (!audio) return;
    if (audio.paused) void start();
    else audio.pause();
  }
  async function start() {
    try {
      failed = false;
      await audio!.play();
    } catch (e) {
      if ((e as DOMException)?.name !== "AbortError") failed = audio?.error != null;
    }
  }
  const skip = (delta: number) => seek((audio?.currentTime ?? currentTime) + delta);

  function setRate(v: number) {
    rate = v;
    store("hub-audio-rate", v);
  }
  function setVolume(v: number) {
    volume = v;
    muted = v === 0;
    store("hub-audio-volume", v);
  }

  // Keep the element in sync with our state.
  $effect(() => {
    if (audio) audio.playbackRate = rate;
  });
  $effect(() => {
    if (!audio) return;
    audio.volume = volume;
    audio.muted = muted;
  });

  // Smooth progress while playing (timeupdate only fires ~4×/s).
  function tick() {
    if (audio) currentTime = audio.currentTime;
    frame = requestAnimationFrame(tick);
  }
  $effect(() => {
    if (!playing) return;
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  });

  // Media Session: lock-screen / headset controls.
  function updatePosition() {
    if (!("mediaSession" in navigator) || !audio || !duration) return;
    try {
      navigator.mediaSession.setPositionState({ duration, playbackRate: rate, position: Math.min(duration, audio.currentTime) });
    } catch {}
  }
  $effect(() => {
    if (!("mediaSession" in navigator) || !audio) return;
    const ms = navigator.mediaSession;
    ms.metadata = new MediaMetadata({ title, artist, album: "Speech-AI Hub" });
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => void start()],
      ["pause", () => audio?.pause()],
      ["seekbackward", d => skip(-(d.seekOffset ?? SKIP))],
      ["seekforward", d => skip(d.seekOffset ?? SKIP)],
      ["seekto", d => d.seekTime != null && seek(d.seekTime)],
    ];
    for (const [action, handler] of handlers) {
      try {
        ms.setActionHandler(action, handler);
      } catch {}
    }
    return () => {
      for (const [action] of handlers) {
        try {
          ms.setActionHandler(action, null);
        } catch {}
      }
      ms.metadata = null;
    };
  });
  $effect(() => {
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  });

  function editable(target: EventTarget | null) {
    const el = target as HTMLElement | null;
    return !!el?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='dialog'], [role='menu'], [role='listbox']");
  }
  function onWindowKey(e: KeyboardEvent) {
    if (!shortcuts || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || editable(e.target)) return;
    const el = e.target as HTMLElement | null;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === " ") {
      // Space on a focused button/link activates it natively.
      if (el?.closest?.("button, a, [role='menuitem'], [role='menuitemradio']")) return;
      e.preventDefault();
      toggle();
    } else if (key === "k") {
      e.preventDefault();
      toggle();
    } else if (key === "j") skip(-SKIP);
    else if (key === "l") skip(SKIP);
    else if (key === "ArrowLeft" || key === "ArrowRight") {
      if (el?.closest?.("[role='slider']")) return;
      e.preventDefault();
      skip(key === "ArrowLeft" ? -5 : 5);
    }
  }

  const VolumeIcon = $derived(muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2);
  const rateLabel = (v: number) => `${v}×`;
  const iconBtn = "relative grid place-items-center rounded-full text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink active:scale-95";
</script>

<svelte:window onkeydown={onWindowKey} />

<!-- No `controls`: the element is invisible and only drives the custom UI. -->
<audio
  bind:this={audio}
  {src}
  preload="metadata"
  class="hidden"
  onloadedmetadata={() => {
    if (audio && Number.isFinite(audio.duration)) mediaDuration = audio.duration;
    if (audio) audio.playbackRate = rate;
  }}
  ondurationchange={() => audio && Number.isFinite(audio.duration) && (mediaDuration = audio.duration)}
  onplay={() => (playing = true)}
  onpause={() => {
    playing = false;
    if (audio) currentTime = audio.currentTime;
  }}
  onended={() => (playing = false)}
  ontimeupdate={() => !playing && audio && (currentTime = audio.currentTime)}
  onseeked={() => {
    if (audio) currentTime = audio.currentTime;
    updatePosition();
  }}
  onratechange={updatePosition}
  onwaiting={() => (buffering = true)}
  onplaying={() => {
    buffering = false;
    updatePosition();
  }}
  oncanplay={() => (buffering = false)}
  onerror={() => {
    failed = true;
    buffering = false;
  }}
></audio>

<div class="flex flex-col {compact ? 'gap-2' : 'gap-4'} {cls}">
  <Waveform
    {peaks}
    {duration}
    {currentTime}
    onSeek={time => seek(time)}
    label={t("recordings.player.seek")}
    height={compact ? 40 : 88}
    barWidth={compact ? 2 : 2.5}
    gap={compact ? 1.5 : 1.75}
  />

  <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
    <p class="text-[12.5px] text-ink-3 tabular-nums" aria-live="off">
      <span class="font-medium text-ink">{formatClock(currentTime)}</span>
      <span class="mx-0.5">/</span>{formatClock(duration)}
    </p>

    <div class="flex items-center {compact ? 'gap-1' : 'gap-2'}">
      <button type="button" class="{iconBtn} {compact ? 'size-9' : 'size-10'}" aria-label={t("recordings.player.back", { n: SKIP })} title={t("recordings.player.backHint")} onclick={() => skip(-SKIP)}>
        <RotateCcw class="size-[22px]" strokeWidth={1.6} />
        <span class="absolute inset-0 grid place-items-center pt-px text-[8.5px] font-bold tabular-nums">{SKIP}</span>
      </button>
      <button
        type="button"
        class="grid place-items-center rounded-full bg-primary text-primary-ink shadow-card transition-[transform,background-color] hover:bg-primary-hover active:scale-95 {compact ? 'size-11' : 'size-14'}"
        aria-label={playing ? t("recordings.player.pause") : t("recordings.player.play")}
        title={t("recordings.player.playHint")}
        onclick={toggle}
      >
        {#if buffering && playing}
          <Spinner class="size-5" />
        {:else if playing}
          <Pause class={compact ? "size-5" : "size-6"} fill="currentColor" strokeWidth={0} />
        {:else}
          <Play class="{compact ? 'size-5' : 'size-6'} translate-x-[1.5px]" fill="currentColor" strokeWidth={0} />
        {/if}
      </button>
      <button type="button" class="{iconBtn} {compact ? 'size-9' : 'size-10'}" aria-label={t("recordings.player.forward", { n: SKIP })} title={t("recordings.player.forwardHint")} onclick={() => skip(SKIP)}>
        <RotateCw class="size-[22px]" strokeWidth={1.6} />
        <span class="absolute inset-0 grid place-items-center pt-px text-[8.5px] font-bold tabular-nums">{SKIP}</span>
      </button>
    </div>

    <div class="flex items-center justify-end gap-1">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          class="inline-flex h-8 min-w-12 items-center justify-center rounded-full border border-line px-2.5 text-[12.5px] font-semibold text-ink-2 tabular-nums transition-colors hover:border-line-2 hover:text-ink data-[state=open]:border-ink-3 data-[state=open]:text-ink"
          aria-label={t("recordings.player.speed", { rate: rateLabel(rate) })}
        >
          {rateLabel(rate)}
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" side="top" sideOffset={8} class="{menuContent} min-w-40">
            <DropdownMenu.Group>
              <DropdownMenu.GroupHeading class={menuLabel}>{t("recordings.player.speedTitle")}</DropdownMenu.GroupHeading>
              <DropdownMenu.RadioGroup value={String(rate)} onValueChange={v => setRate(Number(v))}>
                {#each RATES as option (option)}
                  <DropdownMenu.RadioItem value={String(option)} class={menuItem}>
                    {#snippet children({ checked })}
                      <span class="flex-1 tabular-nums">{rateLabel(option)}{#if option === 1}<span class="ml-2 text-ink-3">{t("recordings.player.normal")}</span>{/if}</span>
                      {#if checked}<Check class="!text-ink" />{/if}
                    {/snippet}
                  </DropdownMenu.RadioItem>
                {/each}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Group>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <div class="hidden items-center gap-1 lg:flex">
        <button type="button" class="{iconBtn} size-8" aria-label={muted ? t("recordings.player.unmute") : t("recordings.player.mute")} aria-pressed={muted} onclick={() => (muted = !muted)}>
          <VolumeIcon class="size-[18px]" />
        </button>
        <VolumeSlider value={muted ? 0 : volume} onChange={setVolume} label={t("recordings.player.volume")} class="w-20" />
      </div>
    </div>
  </div>

  {#if failed}
    <p class="text-[12.5px] text-danger" role="alert">{t("recordings.player.error")}</p>
  {/if}
</div>

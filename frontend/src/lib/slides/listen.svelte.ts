/**
 * The phone's ears for 「提問助手」: the browser's own speech recognition (Chrome / Android: Google; Safari / iOS: Apple),
 * so the server needs no ASR. Both engines behave differently in continuous mode (Android ends after a silence, iOS
 * rarely marks results final and may refuse a start that is not a tap), so one rule serves both: an utterance is the
 * text heard since the last one, committed after ~1.3 s without new words, while the same recognition keeps running.
 * Recognition that ends by itself restarts while listening; a restart the browser refuses asks for a tap.
 */
type Rec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
};
type RecCtor = new () => Rec;

const ctor = (): RecCtor | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

export type ListenError = "unsupported" | "not-allowed" | "service-not-allowed" | "audio-capture" | "network" | "other";

/** Silence that ends an utterance. */
const SILENCE_MS = 1300;

export class Listener {
  listening = $state(false);
  /** Words of the utterance being heard (not committed yet). */
  interim = $state("");
  error = $state<ListenError | null>(null);
  readonly supported = !!ctor();

  private rec: Rec | null = null;
  private want = false;
  private text = "";
  /** Characters of this recognition's transcript already committed. */
  private committed = 0;
  private full = "";
  /** A recognition of this listening session has started (a later refusal is not a missing permission). */
  private started = false;
  private silence: ReturnType<typeof setTimeout> | undefined;
  private restarts = 0;
  private lastStart = 0;

  constructor(
    private readonly onUtterance: (text: string) => void,
    public lang = "zh-TW",
  ) {}

  start() {
    const Ctor = ctor();
    if (!Ctor) {
      this.error = "unsupported";
      return;
    }
    this.error = null;
    this.want = true;
    this.restarts = 0;
    this.started = false;
    this.spawn(Ctor);
  }

  stop() {
    this.want = false;
    this.commit();
    clearTimeout(this.silence);
    try {
      this.rec?.abort();
    } catch {}
    this.rec = null;
    this.listening = false;
  }

  /** The current utterance now (「回答這題」 while the speaker is still finishing). */
  flush(): string {
    return this.commit();
  }

  private spawn(Ctor: RecCtor) {
    const rec = new Ctor();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onstart = () => {
      this.listening = true;
      this.started = true;
      this.lastStart = Date.now();
    };
    this.committed = 0;
    this.full = "";
    rec.onresult = (e) => {
      let s = "";
      for (let i = 0; i < e.results.length; i++) s += e.results[i]![0]?.transcript ?? "";
      this.full = s;
      // An engine that revised already committed words: start over from what it has now.
      if (s.length < this.committed) this.committed = 0;
      this.text = s.slice(this.committed).trim();
      this.interim = this.text;
      clearTimeout(this.silence);
      this.silence = setTimeout(() => this.commit(), SILENCE_MS);
    };
    rec.onerror = (e) => {
      // Silence / an abort we asked for are not errors.
      if (e.error === "no-speech" || e.error === "aborted") return;
      if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "audio-capture") {
        // Refused after it already ran (a restart without a tap, iOS): ask for a tap, not for a permission.
        this.error = this.started && e.error === "not-allowed" ? "other" : e.error;
        this.want = false;
      } else if (e.error === "network") this.error = "network";
      else this.error = "other";
    };
    rec.onend = () => {
      if (this.rec !== rec) return;
      this.commit();
      this.rec = null;
      if (!this.want) {
        this.listening = false;
        return;
      }
      // Ended by itself (silence, time limit, a network blip): start again; back off when it keeps failing at once.
      const quick = Date.now() - this.lastStart < 1500;
      this.restarts = quick ? this.restarts + 1 : 0;
      if (this.restarts > 6) {
        this.want = false;
        this.listening = false;
        this.error ??= "other";
        return;
      }
      setTimeout(() => this.want && !this.rec && this.spawn(Ctor), quick ? 400 * this.restarts : 50);
    };
    this.rec = rec;
    try {
      rec.start();
    } catch {
      this.error = "other";
    }
  }

  /** Hands the heard text on (once) and clears it. */
  private commit(): string {
    clearTimeout(this.silence);
    const t = this.text.trim();
    this.committed = this.full.length;
    this.text = "";
    this.interim = "";
    if (t) this.onUtterance(t);
    return t;
  }
}

// @ts-nocheck — AudioWorkletGlobalScope script (no DOM lib types for it).
// AudioWorklet for live captions: downsamples the microphone to 16 kHz mono and posts PCM16 frames of 100 ms
// (ArrayBuffer, transferable) to the main thread, which forwards them to /api/meetings/:id/live.
// Loaded with `audioWorklet.addModule(url)` from a same-origin asset (the SPA CSP has no blob: scripts).
class Pcm16Downsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.frame = new Int16Array(1600);
    this.filled = 0;
    this.paused = false;
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.paused === "boolean") this.paused = e.data.paused;
    };
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || this.paused) return true;
    // Averaging decimator: good enough for speech recognition, cheap on phones.
    while (this.pos < channel.length) {
      const start = Math.floor(this.pos);
      const end = Math.min(channel.length, Math.max(start + 1, Math.floor(this.pos + this.ratio)));
      let sum = 0;
      for (let i = start; i < end; i++) sum += channel[i];
      const v = Math.max(-1, Math.min(1, sum / (end - start)));
      this.frame[this.filled++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.filled === this.frame.length) {
        const out = this.frame.buffer;
        this.port.postMessage(out, [out]);
        this.frame = new Int16Array(1600);
        this.filled = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= channel.length;
    return true;
  }
}
registerProcessor("pcm16-downsampler", Pcm16Downsampler);

import type { RadioTrackId } from '../../../../shared/radio';

// Original, deterministic instrumental compositions and synthesized soundscapes.
// They play entirely in the browser; no copyrighted recordings are redistributed.
const LOOP_SECONDS = 32;
const RATE = 22_050;
export function composeSamples(track: RadioTrackId): Float32Array {
  const data = new Float32Array(RATE * LOOP_SECONDS);
  let seed = [...track].reduce((n, c) => n + c.charCodeAt(0), 41);
  const noise = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2147483648 - 1; };
  const note = (midi: number, start: number, duration: number, volume: number, mellow = false) => {
    const frequency = 440 * 2 ** ((midi - 69) / 12);
    for (let i = 0; i < duration * RATE; i++) {
      const t = i / RATE;
      const envelope = Math.min(1, t / .025) * Math.exp(-t * (mellow ? 1.2 : 3.2)) * Math.min(1, (duration - t) / .15);
      const wave = Math.sin(2 * Math.PI * frequency * t) + .18 * Math.sin(4 * Math.PI * frequency * t) + .06 * Math.sin(6 * Math.PI * frequency * t);
      const at = (Math.floor(start * RATE) + i) % data.length;
      data[at] += wave * envelope * volume;
    }
  };
  if (track === 'rain' || track === 'cafe') {
    let low = 0;
    for (let i = 0; i < data.length; i++) {
      const n = noise(); low = .97 * low + .03 * n;
      const t = i / RATE;
      data[i] = track === 'rain' ? (.08 * n + .7 * low) * (.8 + .15 * Math.sin(2 * Math.PI * t / 16))
        : .7 * low * (.7 + .2 * Math.sin(2 * Math.PI * t / 8));
    }
    if (track === 'cafe') for (const t of [3, 10, 18, 27]) { note(93, t, .2, .022); note(101, t + .12, .12, .01); }
  } else {
    const transpose = track === 'soft-morning' ? 5 : track === 'window-seat' ? -2 : 0;
    const chords = [[57, 60, 64, 67], [53, 57, 60, 64], [48, 52, 55, 59], [55, 59, 62, 65]];
    for (let bar = 0; bar < 8; bar++) {
      const chord = chords[bar % 4];
      chord.forEach((n, index) => note(n + transpose, bar * 4 + index * .045, 3.95, .075, true));
      note(chord[0] - 12 + transpose, bar * 4, 1.6, .1, true);
      note(chord[0] - 12 + transpose, bar * 4 + 2, 1.5, .065, true);
      for (let beat = 0; beat < 4; beat++) {
        if (beat % 2 === 0) note(chord[(beat + bar) % 4] + 12 + transpose, bar * 4 + beat + .45, .7, .045);
        // Gentle kick and brushed snare, deliberately quieter than the chords.
        for (let i = 0; i < RATE * .15; i++) {
          const t = i / RATE, at = Math.floor((bar * 4 + beat + .04) * RATE) + i;
          data[at % data.length] += beat % 2 ? noise() * Math.exp(-t * 35) * .035
            : Math.sin(2 * Math.PI * (50 * t + 3 * (1 - Math.exp(-t * 30)))) * Math.exp(-t * 22) * .07;
        }
      }
    }
  }
  // Short seam fade avoids clicks on all loop boundaries.
  for (let i = 0; i < data.length; i++) data[i] = Math.tanh(data[i]) * Math.min(1, i / (RATE * .02), (data.length - 1 - i) / (RATE * .02));
  return data;
}

export class RadioAudio {
  private context?: AudioContext;
  private gain?: GainNode;
  private source?: AudioBufferSourceNode;
  private buffers = new Map<RadioTrackId, AudioBuffer>();
  private current?: { track: RadioTrackId; startedAt: number; offset: number };
  get active() { return this.context?.state === 'running'; }
  async enable() {
    if (!this.context) { this.context = new AudioContext(); this.gain = this.context.createGain(); this.gain.gain.value = 0; this.gain.connect(this.context.destination); }
    await this.context.resume();
    if (!this.active) throw new Error('Tap Listen again to enable audio in this browser.');
  }
  volume(value: number) { if (this.context && this.gain) this.gain.gain.setTargetAtTime(value, this.context.currentTime, .04); }
  sync(track: RadioTrackId, playing: boolean, positionMs: number) {
    if (!this.context || !this.active || !this.gain) return;
    if (!playing || positionMs >= 96_000) { this.stop(); return; }
    const offset = positionMs / 1000 % LOOP_SECONDS;
    const actual = this.current ? (this.current.offset + this.context.currentTime - this.current.startedAt) % LOOP_SECONDS : -1;
    const delta = Math.abs(actual - offset);
    if (this.current?.track === track && Math.min(delta, LOOP_SECONDS - delta) < .45) return;
    this.stop();
    let buffer = this.buffers.get(track);
    if (!buffer) {
      const samples = composeSamples(track); buffer = this.context.createBuffer(1, samples.length, RATE);
      buffer.getChannelData(0).set(samples); this.buffers.set(track, buffer);
    }
    this.source = this.context.createBufferSource(); this.source.buffer = buffer; this.source.loop = true;
    this.source.connect(this.gain); this.source.start(0, offset);
    this.current = { track, offset, startedAt: this.context.currentTime };
  }
  stop() { this.source?.stop(); this.source?.disconnect(); this.source = undefined; this.current = undefined; }
  dispose() { this.stop(); if (this.context) void this.context.close(); this.context = undefined; this.buffers.clear(); }
}

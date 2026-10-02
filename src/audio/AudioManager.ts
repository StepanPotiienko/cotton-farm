import type { EventBus, GameEvents } from '../core/Events';

/** Plays the bundled track and keeps a procedural Web Audio fallback. */
export class AudioManager {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: number | null = null;
  private track: HTMLAudioElement | null = null;
  private step = 0;
  private enabled = false;

  get isEnabled(): boolean { return this.enabled; }

  bindEvents(events: EventBus<GameEvents>): void {
    events.on('trap:triggered', () => this.effect('trap'));
    events.on('item:moved', () => this.effect('move'));
    events.on('borshch:sold', () => this.effect('sell'));
    events.on('base:destroyed', () => this.effect('success'));
  }

  effect(kind: 'trap' | 'move' | 'sell' | 'success'): void {
    if (!this.enabled || !this.context || !this.master) return;
    const tones = { trap: 180, move: 320, sell: 520, success: 740 };
    this.note(tones[kind], this.context.currentTime, 0.16, kind === 'trap' ? 'square' : 'sine', 0.35);
  }

  toggle(): boolean {
    if (this.enabled) {
      this.stop();
      return false;
    }
    this.start();
    return true;
  }

  start(): void {
    if (this.enabled || typeof window === 'undefined') return;
    this.enabled = true;
    this.track = new Audio(`${import.meta.env.BASE_URL}audio/beautiful-lofi.mp3`);
    this.track.loop = true;
    this.track.volume = 0.35;
    void this.track.play().catch(() => {
      this.track = null;
      this.startProceduralFallback();
    });
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.track?.pause();
    if (this.track) this.track.currentTime = 0;
    this.track = null;
    this.enabled = false;
    void this.context?.close();
    this.context = null;
    this.master = null;
    this.step = 0;
  }

  private startProceduralFallback(): void {
    if (!this.enabled || typeof window === 'undefined') return;
    const AudioContextCtor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;
    this.context = new AudioContextCtor();
    this.master = this.context.createGain();
    this.master.gain.value = 0.045;
    this.master.connect(this.context.destination);
    this.playStep();
    this.timer = window.setInterval(() => this.playStep(), 900);
  }

  private playStep(): void {
    if (!this.context || !this.master) return;
    const melody = [261.63, 329.63, 392, 329.63, 293.66, 349.23, 440, 349.23];
    const bass = [130.81, 130.81, 146.83, 146.83, 174.61, 174.61, 146.83, 146.83];
    const now = this.context.currentTime;
    this.note(melody[this.step % melody.length] ?? 261.63, now, 0.72, 'sine', 0.7);
    this.note(bass[this.step % bass.length] ?? 130.81, now, 0.72, 'triangle', 0.35);
    this.step += 1;
  }

  private note(frequency: number, start: number, duration: number, type: OscillatorType, level: number): void {
    if (!this.context || !this.master) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(level, start + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain).connect(this.master);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.03);
  }
}

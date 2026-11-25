/**
 * All game audio: synthesized sound effects and two looping chiptune tracks
 * (a calm menu theme, an upbeat battle theme), generated at runtime with the
 * Web Audio API. Nothing is sampled - every sound is original work authored
 * in this file, so there are no third-party licenses or attribution
 * requirements (free for commercial use by construction).
 *
 * Two independent settings persist across sessions: 'sound' gates effects,
 * 'music' gates both tracks. The AudioContext is created/resumed on the
 * first user gesture (browser autoplay policy); anything played before that
 * is a silent no-op.
 */

const SFX_KEY = 'sound';
const MUSIC_KEY = 'music';
const SFX_VOL_KEY = 'soundVol';
const MUSIC_VOL_KEY = 'musicVol';

/** Base bus gains at 100% volume; the sliders scale these down. */
const SFX_BUS_GAIN = 0.8;
const MUSIC_BUS_GAIN = 0.4;

function storedVolume(key: string): number {
  const raw = localStorage.getItem(key);
  const v = raw === null ? NaN : Number(raw);
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 1;
}

/**
 * Automated browsers (headless Chrome, Playwright/Puppeteer sessions) default
 * to silent so test runs don't blare audio; an explicit 'on' still wins.
 */
const isAutomated =
  navigator.webdriver === true || /\bHeadlessChrome\b/.test(navigator.userAgent);

function storedToggle(key: string): boolean {
  return isAutomated ? localStorage.getItem(key) === 'on' : localStorage.getItem(key) !== 'off';
}

let sfxOn = storedToggle(SFX_KEY);
let musicOn = storedToggle(MUSIC_KEY);
let sfxVol = storedVolume(SFX_VOL_KEY);
let musicVol = storedVolume(MUSIC_VOL_KEY);

export function soundEnabled(): boolean {
  return sfxOn;
}

export function setSoundEnabled(on: boolean): void {
  sfxOn = on;
  localStorage.setItem(SFX_KEY, on ? 'on' : 'off');
}

export function musicEnabled(): boolean {
  return musicOn;
}

export function setMusicEnabled(on: boolean): void {
  musicOn = on;
  localStorage.setItem(MUSIC_KEY, on ? 'on' : 'off');
  audio.reconcileMusic();
}

export function soundVolume(): number {
  return sfxVol;
}

export function setSoundVolume(v: number): void {
  sfxVol = Math.min(Math.max(v, 0), 1);
  localStorage.setItem(SFX_VOL_KEY, String(sfxVol));
  audio.applyVolumes();
}

export function musicVolume(): number {
  return musicVol;
}

export function setMusicVolume(v: number): void {
  musicVol = Math.min(Math.max(v, 0), 1);
  localStorage.setItem(MUSIC_VOL_KEY, String(musicVol));
  audio.applyVolumes();
}

// --- Music scores (original compositions) ---

/** 8th-note steps per bar. */
const BAR = 8;
/** Battle chord roots per bar, looped: Am F C G (MIDI). */
const ROOTS = [45, 41, 48, 43];
/** Battle lead, one MIDI note per 8th, 8 bars (arpeggios over the chords). */
// prettier-ignore
const LEAD = [
  69, 72, 76, 72, 69, 72, 76, 79,
  65, 69, 72, 69, 65, 69, 72, 76,
  72, 76, 79, 76, 72, 76, 79, 76,
  71, 74, 79, 74, 71, 74, 79, 77,
  69, 72, 76, 72, 69, 72, 76, 79,
  65, 69, 72, 69, 65, 69, 72, 76,
  72, 76, 79, 76, 81, 79, 76, 72,
  71, 74, 79, 74, 71, 67, 64, 62,
];
const BPM_NORMAL = 132;
const BPM_SUDDEN_DEATH = 158;

/** Menu chord roots per bar, looped: C Am F G (MIDI). */
const MENU_ROOTS = [48, 45, 41, 43];
/** Menu lead, one MIDI note per 8th (null = rest): a slow, mellow noodle. */
// prettier-ignore
const MENU_LEAD: Array<number | null> = [
  72, null, 76, null, 79, null, 76, null,
  69, null, 72, null, 76, null, 72, null,
  65, null, 69, null, 72, null, 69, null,
  67, null, 71, null, 74, null, 71, null,
  72, null, 76, null, 79, null, 84, null,
  81, null, 79, null, 76, null, 72, null,
  77, null, 76, null, 72, null, 69, null,
  74, null, 71, null, 67, null, 71, null,
];
const BPM_MENU = 92;

type MusicTrack = 'menu' | 'battle';

function midiHz(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

class AudioEngine {
  private ctx: AudioContext | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;

  /**
   * Which track the app wants right now. Menus want 'menu', a running round
   * wants 'battle', round-end wants silence. Defaults to 'menu' so the
   * landing screen has music from the first user gesture on.
   */
  private track: MusicTrack | null = 'menu';
  /** Music is only running as a volume-slider preview. */
  private previewing = false;
  private previewTimer: number | null = null;
  private suddenDeath = false;
  private schedulerId: number | null = null;
  /** Loop position; survives stop/start so a track resumes, not restarts. */
  private step = 0;
  private nextStepAt = 0;
  /** Which track the current step position belongs to. */
  private stepTrack: MusicTrack | null = null;

  constructor() {
    // Autoplay policy: the context only starts inside a user gesture. Keep
    // the listeners forever - they also recover from OS-level suspensions.
    const unlock = (): void => {
      this.ensure();
      if (this.ctx && this.ctx.state !== 'running') {
        // resume() is async: reconcile again once the context actually runs,
        // or music waits for the next state change instead of starting now.
        void this.ctx.resume().then(() => this.reconcileMusic());
      }
      this.reconcileMusic();
    };
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    // Background tabs throttle timers below the scheduler lookahead, which
    // would turn the loop into stuttering bursts: pause music while hidden.
    document.addEventListener('visibilitychange', () => this.reconcileMusic());
  }

  private ensure(): void {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
    } catch {
      return; // no audio support: every call below stays a no-op
    }
    const master = this.ctx.createGain();
    master.gain.value = 0.6;
    master.connect(this.ctx.destination);
    this.sfxBus = this.ctx.createGain();
    this.sfxBus.connect(master);
    this.musicBus = this.ctx.createGain();
    this.musicBus.connect(master);
    this.applyVolumes();
    // 1s of white noise, reused by every percussive sound.
    const len = this.ctx.sampleRate;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  private get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /** Push the volume sliders onto the buses (squared for a perceptual feel). */
  applyVolumes(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.sfxBus?.gain.setTargetAtTime(SFX_BUS_GAIN * sfxVol * sfxVol, t, 0.02);
    this.musicBus?.gain.setTargetAtTime(MUSIC_BUS_GAIN * musicVol * musicVol, t, 0.02);
  }

  /** Slider feedback: a short blip so the chosen SFX level is audible. */
  previewSfx(): void {
    this.pickup(true);
  }

  /**
   * Slider feedback: run the music loop briefly so the level is audible
   * outside a match. A real match starting mid-preview takes over cleanly.
   */
  previewMusic(): void {
    if (this.track !== null) {
      this.reconcileMusic(); // already playing for real (menu or match)
      return;
    }
    this.previewing = true;
    this.setTrack('menu');
    if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      if (this.previewing) {
        this.previewing = false;
        this.setTrack(null);
      }
    }, 1800);
  }

  // --- Synth building blocks ---

  /** One oscillator note with a pitch glide and a fast attack/decay envelope. */
  private tone(
    bus: GainNode,
    at: number,
    opts: {
      type: OscillatorType;
      from: number;
      to?: number;
      dur: number;
      vol: number;
    },
  ): void {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    osc.type = opts.type;
    osc.frequency.setValueAtTime(opts.from, at);
    if (opts.to !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(opts.to, 1), at + opts.dur);
    }
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(opts.vol, at + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, at + opts.dur);
    osc.connect(gain);
    gain.connect(bus);
    osc.start(at);
    osc.stop(at + opts.dur + 0.02);
  }

  /** Filtered noise burst (explosions, crates, drums). */
  private noise(
    bus: GainNode,
    at: number,
    opts: { dur: number; vol: number; filter: BiquadFilterType; freq: number },
  ): void {
    if (!this.ctx || !this.noiseBuf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = opts.filter;
    filter.frequency.value = opts.freq;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(opts.vol, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + opts.dur);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(bus);
    src.start(at);
    src.stop(at + opts.dur + 0.02);
  }

  // --- Sound effects (own = caused by a player on this device) ---

  bombPlaced(own: boolean): void {
    if (!sfxOn || !this.ready || !this.sfxBus) return;
    const t = this.ctx!.currentTime;
    this.tone(this.sfxBus, t, { type: 'square', from: 240, to: 170, dur: 0.09, vol: own ? 0.25 : 0.12 });
  }

  explosion(own: boolean): void {
    if (!sfxOn || !this.ready || !this.sfxBus) return;
    const t = this.ctx!.currentTime;
    const vol = own ? 1 : 0.55;
    this.noise(this.sfxBus, t, { dur: 0.45, vol: 0.5 * vol, filter: 'lowpass', freq: 900 });
    this.tone(this.sfxBus, t, { type: 'sine', from: 130, to: 35, dur: 0.35, vol: 0.6 * vol });
  }

  crateBroken(): void {
    if (!sfxOn || !this.ready || !this.sfxBus) return;
    const t = this.ctx!.currentTime;
    this.noise(this.sfxBus, t, { dur: 0.16, vol: 0.2, filter: 'bandpass', freq: 1400 });
  }

  pickup(own: boolean): void {
    if (!sfxOn || !this.ready || !this.sfxBus) return;
    const t = this.ctx!.currentTime;
    const vol = own ? 0.22 : 0.08;
    this.tone(this.sfxBus, t, { type: 'square', from: 660, dur: 0.07, vol });
    this.tone(this.sfxBus, t + 0.08, { type: 'square', from: 990, dur: 0.1, vol });
  }

  death(own: boolean): void {
    if (!sfxOn || !this.ready || !this.sfxBus) return;
    const t = this.ctx!.currentTime;
    if (own) {
      // Long sad slide, unmistakably "that was you".
      this.tone(this.sfxBus, t, { type: 'sawtooth', from: 520, to: 70, dur: 0.6, vol: 0.3 });
      this.tone(this.sfxBus, t + 0.15, { type: 'square', from: 260, to: 60, dur: 0.45, vol: 0.18 });
    } else {
      this.tone(this.sfxBus, t, { type: 'square', from: 320, to: 110, dur: 0.25, vol: 0.16 });
    }
  }

  suddenDeathAlarm(): void {
    if (!sfxOn || !this.ready || !this.sfxBus) return;
    const t = this.ctx!.currentTime;
    for (let i = 0; i < 3; i++) {
      this.tone(this.sfxBus, t + i * 0.22, { type: 'triangle', from: 554, dur: 0.1, vol: 0.3 });
      this.tone(this.sfxBus, t + i * 0.22 + 0.11, { type: 'triangle', from: 440, dur: 0.1, vol: 0.3 });
    }
  }

  crushLanded(): void {
    if (!sfxOn || !this.ready || !this.sfxBus) return;
    const t = this.ctx!.currentTime;
    this.tone(this.sfxBus, t, { type: 'sine', from: 90, to: 28, dur: 0.22, vol: 0.5 });
    this.noise(this.sfxBus, t, { dur: 0.12, vol: 0.22, filter: 'lowpass', freq: 500 });
  }

  /**
   * UI button press: a tiny rising blip. Only needs the context to exist
   * (not 'running'): the very first click of a visit fires while resume()
   * from the pointerdown unlock is still pending, and notes queued on a
   * suspended context play the moment it starts.
   */
  uiClick(): void {
    if (!sfxOn) return;
    this.ensure();
    if (!this.ctx || !this.sfxBus) return;
    const t = this.ctx.currentTime;
    this.tone(this.sfxBus, t, { type: 'square', from: 620, to: 880, dur: 0.05, vol: 0.12 });
  }

  /** Faint, soft tick when the pointer lands on a branded brick. */
  uiHover(): void {
    if (!sfxOn) return;
    this.ensure();
    if (!this.ctx || !this.sfxBus) return;
    const t = this.ctx.currentTime;
    this.tone(this.sfxBus, t, { type: 'sine', from: 880, to: 1180, dur: 0.04, vol: 0.05 });
  }

  /** One short blip per lobby-countdown second; the final one rings higher. */
  countdownTick(last: boolean): void {
    if (!sfxOn || !this.ready || !this.sfxBus) return;
    const t = this.ctx!.currentTime;
    this.tone(this.sfxBus, t, {
      type: 'square',
      from: last ? 990 : 660,
      dur: last ? 0.18 : 0.09,
      vol: 0.16,
    });
  }

  /** READY... beep now, GO! beep when the banner flips (one second later). */
  roundStart(): void {
    if (!sfxOn || !this.ready || !this.sfxBus) return;
    const t = this.ctx!.currentTime;
    this.tone(this.sfxBus, t, { type: 'square', from: 440, dur: 0.12, vol: 0.2 });
    this.tone(this.sfxBus, t + 1.0, { type: 'square', from: 880, dur: 0.25, vol: 0.22 });
  }

  victory(): void {
    if (!sfxOn || !this.ready || !this.sfxBus) return;
    const t = this.ctx!.currentTime;
    const notes = [72, 76, 79, 84];
    notes.forEach((n, i) => {
      this.tone(this.sfxBus!, t + i * 0.13, {
        type: 'square',
        from: midiHz(n),
        dur: i === notes.length - 1 ? 0.5 : 0.12,
        vol: 0.2,
      });
    });
  }

  // --- Music ---

  /** A round started: the battle track takes over (also kills any preview). */
  startMusic(): void {
    this.previewing = false;
    this.setTrack('battle');
  }

  /** On any menu screen (landing, lobby, settings, ...): the calm theme. */
  startMenuMusic(): void {
    this.previewing = false;
    this.suddenDeath = false;
    this.setTrack('menu');
  }

  stopMusic(): void {
    this.previewing = false;
    this.suddenDeath = false;
    this.setTrack(null);
  }

  /** Sudden death cranks the tempo. */
  setSuddenDeath(on: boolean): void {
    this.suddenDeath = on;
  }

  private setTrack(track: MusicTrack | null): void {
    this.track = track;
    this.reconcileMusic();
  }

  /** Start/stop the sequencer to match settings + app state + tab visibility. */
  reconcileMusic(): void {
    const should = this.track !== null && musicOn && this.ready && !document.hidden;
    if (should) {
      this.syncPosition();
      if (this.schedulerId === null) {
        this.schedulerId = window.setInterval(this.musicTick, 60);
      }
    } else if (this.schedulerId !== null) {
      window.clearInterval(this.schedulerId);
      this.schedulerId = null;
    }
  }

  /**
   * Align the loop position with the wanted track without restarting it.
   * Screen changes bounce through stop+start (e.g. joining a lobby), and the
   * menu theme must sail straight through those, so only an actual track
   * switch rewinds to the top; a same-track resume keeps its place and just
   * gets a fresh clock if the pause outran the lookahead.
   */
  private syncPosition(): void {
    const now = this.ctx!.currentTime;
    if (this.stepTrack !== this.track) {
      this.stepTrack = this.track;
      this.step = 0;
      this.nextStepAt = now + 0.06;
    } else if (this.nextStepAt < now) {
      this.nextStepAt = now + 0.06;
    }
  }

  /** Lookahead scheduler: queue every step that falls in the next ~200ms. */
  private musicTick = (): void => {
    if (!this.ctx) return;
    const menu = this.track === 'menu';
    const steps = menu ? MENU_LEAD.length : LEAD.length;
    const bpm = menu ? BPM_MENU : this.suddenDeath ? BPM_SUDDEN_DEATH : BPM_NORMAL;
    const horizon = this.ctx.currentTime + 0.2;
    while (this.nextStepAt < horizon) {
      if (menu) this.scheduleMenuStep(this.step, this.nextStepAt);
      else this.scheduleBattleStep(this.step, this.nextStepAt);
      this.nextStepAt += 60 / bpm / 2; // 8th notes
      this.step = (this.step + 1) % steps;
    }
  };

  private scheduleBattleStep(i: number, at: number): void {
    const bus = this.musicBus;
    if (!bus) return;
    const pos = i % BAR;
    const root = ROOTS[Math.floor(i / BAR) % ROOTS.length] ?? 45;
    const lead = LEAD[i];
    if (lead !== undefined) {
      this.tone(bus, at, { type: 'square', from: midiHz(lead), dur: 0.18, vol: 0.12 });
    }
    // Bass bounces root / octave on alternating 8ths.
    this.tone(bus, at, {
      type: 'triangle',
      from: midiHz(pos % 2 === 0 ? root : root + 12),
      dur: 0.16,
      vol: 0.18,
    });
    if (pos === 0 || pos === 4) {
      this.tone(bus, at, { type: 'sine', from: 120, to: 45, dur: 0.1, vol: 0.45 }); // kick
    }
    if (pos === 2 || pos === 6) {
      this.noise(bus, at, { dur: 0.07, vol: 0.18, filter: 'highpass', freq: 2000 }); // snare
    }
    this.noise(bus, at, {
      dur: 0.025,
      vol: pos % 2 === 0 ? 0.07 : 0.04,
      filter: 'highpass',
      freq: 7000,
    }); // hat
  }

  /** Menu theme: soft triangle lead over a sparse sine bass, barely-there hats. */
  private scheduleMenuStep(i: number, at: number): void {
    const bus = this.musicBus;
    if (!bus) return;
    const pos = i % BAR;
    const root = MENU_ROOTS[Math.floor(i / BAR) % MENU_ROOTS.length] ?? 48;
    const lead = MENU_LEAD[i];
    if (lead !== null && lead !== undefined) {
      this.tone(bus, at, { type: 'triangle', from: midiHz(lead), dur: 0.45, vol: 0.16 });
    }
    if (pos === 0) {
      this.tone(bus, at, { type: 'sine', from: midiHz(root - 12), dur: 0.9, vol: 0.22 });
    }
    if (pos === 4) {
      this.tone(bus, at, { type: 'sine', from: midiHz(root), dur: 0.7, vol: 0.15 });
    }
    if (pos === 2 || pos === 6) {
      this.noise(bus, at, { dur: 0.02, vol: 0.025, filter: 'highpass', freq: 8000 }); // tick
    }
  }
}

export const audio = new AudioEngine();

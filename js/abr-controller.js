// Motor de qualidade adaptativa: uma instância por RTCPeerConnection (por viewer).
// Vídeo se ajusta em degraus de bitrate/escala; o áudio é mantido blindado em prioridade alta.

import { StatsMonitor, readOutboundStats, LOSS_CRITICAL, RTT_WARNING_MS } from './stats.js';

export const ABR_DEFAULTS = Object.freeze({
  intervalMs: 2000,
  minBitrate: 2_500_000,
  maxBitrate: 20_000_000,
  lossThreshold: LOSS_CRITICAL,
  rttThresholdMs: RTT_WARNING_MS,
  stableWindowMs: 6000,
  stepDownFactor: 0.8,
  stepUpRatio: 0.1,
  minStepUp: 750_000,
  scaleSteps: Object.freeze([1, 1.25, 1.5, 2]),
  congestedTicksBeforeScale: 2,
  audioMaxBitrate: 192_000,
});

export class AdaptiveQualityController {
  #pc;
  #videoSender;
  #audioSender;
  #opts;
  #monitor;
  #onUpdate;

  #mode;
  #maxBitrate;
  #bitrateCap = null;
  #bitrate;
  #scaleIndex = 0;
  #maxFramerate;
  #degradation;
  #displayCap;

  #stableSince = null;
  #floorTicks = 0;
  #queue = Promise.resolve();
  #stopped = false;
  #degradationSupported = true;
  #audioPrioritySupported = true;
  #snapshot = null;

  constructor({
    pc,
    videoSender,
    audioSender = null,
    mode = 'auto',
    maxBitrate = ABR_DEFAULTS.maxBitrate,
    maxFramerate = 60,
    degradationPreference = 'balanced',
    displayCap = null,
    onUpdate = null,
    ...overrides
  }) {
    this.#displayCap = displayCap;
    this.#pc = pc;
    this.#videoSender = videoSender;
    this.#audioSender = audioSender;
    this.#opts = { ...ABR_DEFAULTS, ...overrides };
    this.#onUpdate = onUpdate;
    this.#mode = mode === 'manual' ? 'manual' : 'auto';
    this.#maxBitrate = Math.max(this.#opts.minBitrate, maxBitrate);
    this.#bitrate = this.#maxBitrate;
    this.#maxFramerate = maxFramerate;
    this.#degradation = degradationPreference;
    this.#monitor = new StatsMonitor((prev) => readOutboundStats(this.#pc, prev), {
      intervalMs: this.#opts.intervalMs,
      onSample: (sample) => this.#onSample(sample),
    });
  }

  get snapshot() {
    return this.#snapshot;
  }

  get targetBitrate() {
    return this.#bitrate;
  }

  /** Escala efetiva: ajuste à tela do viewer × degrau de congestionamento. */
  get scale() {
    return Math.round(this.#displayScale * this.#opts.scaleSteps[this.#scaleIndex] * 100) / 100;
  }

  // Reduz a captura até caber na tela do aparelho (ex.: 1440p → ~1080p num celular).
  get #displayScale() {
    const cap = this.#displayCap;
    const { width, height } = this.#videoSender?.track?.getSettings?.() ?? {};
    if (!cap || !width || !height) return 1;
    const ratio = Math.max(Math.max(width, height) / cap.long, Math.min(width, height) / cap.short);
    return ratio > 1.05 ? ratio : 1;
  }

  get #ceiling() {
    return this.#bitrateCap ? Math.min(this.#maxBitrate, this.#bitrateCap) : this.#maxBitrate;
  }

  get #effectiveFramerate() {
    const capFps = this.#displayCap?.maxFps;
    return capFps ? Math.min(this.#maxFramerate, capFps) : this.#maxFramerate;
  }

  get #canScale() {
    return this.#mode === 'auto' && this.#degradation !== 'maintain-resolution';
  }

  start() {
    this.#stopped = false;
    this.reapply();
    this.#monitor.start();
  }

  stop() {
    this.#stopped = true;
    this.#monitor.stop();
  }

  /** Reaplica parâmetros (útil após a negociação, quando os encodings passam a existir em todos os navegadores). */
  reapply() {
    return Promise.all([this.#applyVideo(), this.shieldAudio()]);
  }

  setMode(mode) {
    this.#mode = mode === 'manual' ? 'manual' : 'auto';
    this.#stableSince = null;
    this.#floorTicks = 0;
    if (this.#mode === 'manual') {
      this.#bitrate = this.#ceiling;
      this.#scaleIndex = 0;
    }
    return this.#applyVideo();
  }

  setMaxBitrate(bps) {
    this.#maxBitrate = Math.max(this.#opts.minBitrate, bps);
    // Em modo automático, ao subir o teto, o controlador sobe sozinho após a janela de estabilidade.
    if (this.#mode === 'manual' || this.#bitrate > this.#ceiling) this.#bitrate = this.#ceiling;
    return this.#applyVideo();
  }

  /** Teto extra pedido pelo viewer (modo economia de dados); null remove o teto. */
  setBitrateCap(bps) {
    this.#bitrateCap = Number.isFinite(bps) && bps > 0 ? Math.max(this.#opts.minBitrate, bps) : null;
    if (this.#mode === 'manual' || this.#bitrate > this.#ceiling) this.#bitrate = this.#ceiling;
    return this.#applyVideo();
  }

  setMaxFramerate(fps) {
    this.#maxFramerate = fps;
    return this.#applyVideo();
  }

  setDegradationPreference(preference) {
    this.#degradation = preference;
    if (!this.#canScale) this.#scaleIndex = 0;
    return this.#applyVideo();
  }

  /** Blindagem de áudio: prioridade alta de CPU/rede e bitrate Opus fixo, reafirmados a cada ciclo. */
  shieldAudio() {
    const sender = this.#audioSender;
    if (!sender?.track || this.#stopped) return Promise.resolve();
    return this.#enqueue(async () => {
      const target = this.#opts.audioMaxBitrate;
      const params = sender.getParameters();
      if (!params.encodings?.length) return;
      const needsUpdate = params.encodings.some(
        (enc) =>
          enc.maxBitrate !== target ||
          (this.#audioPrioritySupported && (enc.priority !== 'high' || enc.networkPriority !== 'high')),
      );
      if (!needsUpdate) return;

      for (const enc of params.encodings) {
        enc.maxBitrate = target;
        if (this.#audioPrioritySupported) {
          enc.priority = 'high';
          enc.networkPriority = 'high';
        }
      }
      try {
        await sender.setParameters(params);
      } catch (err) {
        if (!this.#audioPrioritySupported) throw err;
        this.#audioPrioritySupported = false;
        const fallback = sender.getParameters();
        for (const enc of fallback.encodings ?? []) enc.maxBitrate = target;
        await sender.setParameters(fallback);
      }
    });
  }

  async #onSample(sample) {
    if (this.#stopped) return;
    if (!sample.ready) {
      this.#emit(sample, 'idle', 'warmup', false, false);
      return;
    }

    await this.shieldAudio();

    const lossy = (sample.lossRate ?? 0) > this.#opts.lossThreshold;
    const slow = sample.rttMs != null && sample.rttMs > this.#opts.rttThresholdMs;
    const congested = lossy || slow;

    let action = 'hold';
    if (this.#mode === 'auto') {
      action = this.#decide(congested, performance.now());
      if (action !== 'hold') await this.#applyVideo();
    }

    const degraded = this.#mode === 'auto' && (this.#bitrate < this.#ceiling || this.#scaleIndex > 0);
    const health = lossy ? 'critical' : congested || degraded ? 'adjusting' : 'good';
    this.#emit(sample, health, action, lossy, slow);
  }

  #decide(congested, now) {
    const o = this.#opts;

    if (congested) {
      this.#stableSince = null;
      if (this.#bitrate > o.minBitrate) {
        this.#bitrate = Math.max(o.minBitrate, Math.round(this.#bitrate * o.stepDownFactor));
        this.#floorTicks = 0;
        return 'bitrate-down';
      }
      // Já no piso de 2.5 Mbps e ainda congestionado: reduz a resolução interna para preservar o FPS.
      if (this.#canScale && this.#scaleIndex < o.scaleSteps.length - 1) {
        this.#floorTicks += 1;
        if (this.#floorTicks >= o.congestedTicksBeforeScale) {
          this.#floorTicks = 0;
          this.#scaleIndex += 1;
          return 'scale-down';
        }
      }
      return 'hold';
    }

    this.#floorTicks = 0;
    // A amostra limpa já cobre o intervalo anterior inteiro.
    this.#stableSince ??= now - o.intervalMs;
    if (now - this.#stableSince < o.stableWindowMs) return 'hold';

    if (this.#scaleIndex > 0) {
      this.#scaleIndex -= 1;
      return 'scale-up';
    }
    if (this.#bitrate < this.#ceiling) {
      const step = Math.max(o.minStepUp, this.#ceiling * o.stepUpRatio);
      this.#bitrate = Math.min(this.#ceiling, Math.round(this.#bitrate + step));
      return 'bitrate-up';
    }
    return 'hold';
  }

  #buildVideoParams(includeDegradation) {
    const params = this.#videoSender.getParameters();
    if (!params.encodings?.length) return null;
    for (const enc of params.encodings) {
      enc.active = true;
      enc.maxBitrate = Math.round(this.#bitrate);
      enc.maxFramerate = this.#effectiveFramerate;
      enc.scaleResolutionDownBy = this.scale;
    }
    if (includeDegradation && this.#degradation) params.degradationPreference = this.#degradation;
    return params;
  }

  #applyVideo() {
    if (!this.#videoSender || this.#stopped) return Promise.resolve();
    return this.#enqueue(async () => {
      if (this.#pc.signalingState === 'closed') return;
      const params = this.#buildVideoParams(this.#degradationSupported);
      if (!params) return;
      try {
        await this.#videoSender.setParameters(params);
      } catch (err) {
        if (!this.#degradationSupported) throw err;
        this.#degradationSupported = false;
        const fallback = this.#buildVideoParams(false);
        if (fallback) await this.#videoSender.setParameters(fallback);
      }
    });
  }

  // setParameters exige getParameters fresco (transactionId); serializa todas as chamadas.
  #enqueue(task) {
    const run = this.#queue.then(task);
    this.#queue = run.catch((err) => console.warn('[ABR] setParameters falhou', err));
    return this.#queue;
  }

  #emit(sample, health, action, lossy, slow) {
    this.#snapshot = {
      mode: this.#mode,
      health,
      action,
      lossy,
      slow,
      targetBitrate: this.#bitrate,
      maxBitrate: this.#ceiling,
      bitrateCap: this.#bitrateCap,
      minBitrate: this.#opts.minBitrate,
      scale: this.scale,
      degradationPreference: this.#degradation,
      sample,
      timestamp: Date.now(),
    };
    this.#onUpdate?.(this.#snapshot);
  }
}

export { AdaptiveQualityController as AdaptiveBitrateController };

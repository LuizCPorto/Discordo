// Leitura de RTCStatsReport para o HUD (viewer/host) e para o motor ABR.

export const LOSS_CRITICAL = 0.02;
export const LOSS_WARNING = 0.005;
export const RTT_WARNING_MS = 150;

export const HEALTH_LABELS = Object.freeze({
  idle: 'Aguardando dados',
  good: 'Estável',
  adjusting: 'Ajustando qualidade',
  critical: 'Perda de pacotes',
});

const HEALTH_ORDER = Object.freeze({ idle: 0, good: 1, adjusting: 2, critical: 3 });

const H264_PROFILES = Object.freeze({ 42: 'Baseline', '4d': 'Main', 58: 'Extended', 64: 'High', f4: 'High 4:4:4' });

const kindOf = (stat) => stat.kind ?? stat.mediaType;

function delta(current, previous) {
  return Number.isFinite(current) && Number.isFinite(previous) ? current - previous : null;
}

function perSecond(amount, elapsedMs) {
  return amount != null && elapsedMs > 0 ? (amount * 1000) / elapsedMs : null;
}

export function worstHealth(a, b) {
  return (HEALTH_ORDER[b] ?? 0) > (HEALTH_ORDER[a] ?? 0) ? b : a;
}

export function formatMbps(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return '0 kbps';
  if (bps < 1e6) return `${Math.round(bps / 1000)} kbps`;
  return `${(bps / 1e6).toFixed(bps >= 1e7 ? 1 : 2)} Mbps`;
}

export function formatResolution(width, height) {
  return width && height ? `${width}x${height}` : '—';
}

export function formatFps(fps) {
  return Number.isFinite(fps) ? `${Math.round(fps)}fps` : '—';
}

export function formatPercent(ratio) {
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(ratio < 0.1 ? 1 : 0)}%`;
}

export function formatMs(ms) {
  return Number.isFinite(ms) ? `${Math.round(ms)} ms` : '—';
}

export function codecLabel(codec) {
  if (!codec?.mimeType) return '—';
  const name = (codec.mimeType.split('/')[1] ?? '').toUpperCase();
  const fmtp = codec.sdpFmtpLine ?? '';
  if (name === 'AV1X') return 'AV1';
  if (name === 'VP9' && /profile-id=2/.test(fmtp)) return 'VP9 10-bit';
  if (name === 'H264') {
    const match = /profile-level-id=([0-9a-f]{2})/i.exec(fmtp);
    const profile = match ? H264_PROFILES[match[1].toLowerCase()] : null;
    return profile ? `H264 ${profile}` : 'H264';
  }
  return name || '—';
}

export function getSelectedCandidatePair(report) {
  let pair = null;
  report.forEach((stat) => {
    if (!pair && stat.type === 'transport' && stat.selectedCandidatePairId) {
      pair = report.get(stat.selectedCandidatePairId) ?? null;
    }
  });
  if (pair) return pair;
  // Firefox não expõe "transport"; usa o par marcado como selecionado/nomeado.
  report.forEach((stat) => {
    if (!pair && stat.type === 'candidate-pair' && (stat.selected || (stat.nominated && stat.state === 'succeeded'))) {
      pair = stat;
    }
  });
  return pair;
}

function rttFromPair(pair) {
  return Number.isFinite(pair?.currentRoundTripTime) ? pair.currentRoundTripTime * 1000 : null;
}

/** Estatísticas de recepção (viewer): resolução, FPS decodificado, codec, bitrate, perda e RTT. */
export async function readInboundStats(pc, previous = null) {
  const report = await pc.getStats();
  let video = null;
  let audio = null;
  report.forEach((stat) => {
    if (stat.type !== 'inbound-rtp') return;
    const kind = kindOf(stat);
    if (kind === 'video' && (!video || (stat.bytesReceived ?? 0) > (video.bytesReceived ?? 0))) video = stat;
    else if (kind === 'audio' && (!audio || (stat.bytesReceived ?? 0) > (audio.bytesReceived ?? 0))) audio = stat;
  });

  const pair = getSelectedCandidatePair(report);
  const raw = {
    time: video?.timestamp ?? audio?.timestamp ?? performance.now(),
    videoBytes: video?.bytesReceived ?? null,
    audioBytes: audio?.bytesReceived ?? null,
    packetsLost: video?.packetsLost ?? null,
    packetsReceived: video?.packetsReceived ?? null,
    framesDecoded: video?.framesDecoded ?? null,
    concealedSamples: audio?.concealedSamples ?? null,
    totalSamples: audio?.totalSamplesReceived ?? null,
  };

  const elapsed = previous ? raw.time - previous.time : 0;
  const ready = Boolean(previous) && elapsed > 0 && video != null;

  let lossRate = null;
  if (ready) {
    const lost = delta(raw.packetsLost, previous.packetsLost);
    const received = delta(raw.packetsReceived, previous.packetsReceived);
    if (lost != null && received != null) {
      const total = Math.max(0, lost) + Math.max(0, received);
      lossRate = total > 0 ? Math.max(0, lost) / total : 0;
    }
  }

  let fps = Number.isFinite(video?.framesPerSecond) ? video.framesPerSecond : null;
  if (fps == null && ready) fps = perSecond(delta(raw.framesDecoded, previous.framesDecoded), elapsed);

  let audioConcealment = null;
  if (ready) {
    const concealed = delta(raw.concealedSamples, previous.concealedSamples);
    const samples = delta(raw.totalSamples, previous.totalSamples);
    if (concealed != null && samples > 0) audioConcealment = Math.max(0, concealed) / samples;
  }

  const videoBytes = ready ? delta(raw.videoBytes, previous.videoBytes) : null;
  const audioBytes = ready ? delta(raw.audioBytes, previous.audioBytes) : null;
  const codec = video?.codecId ? report.get(video.codecId) : null;

  return {
    ready,
    raw,
    width: video?.frameWidth ?? null,
    height: video?.frameHeight ?? null,
    fps,
    codec: codecLabel(codec),
    codecMime: codec?.mimeType ?? null,
    videoBitrate: videoBytes != null ? perSecond(videoBytes * 8, elapsed) : null,
    audioBitrate: audioBytes != null ? perSecond(audioBytes * 8, elapsed) : null,
    lossRate,
    rttMs: rttFromPair(pair),
    jitterMs: Number.isFinite(video?.jitter) ? video.jitter * 1000 : null,
    freezeCount: video?.freezeCount ?? null,
    audioConcealment,
    hasAudio: audio != null,
  };
}

/** Estatísticas de envio (host, por conexão): base de decisão do ABR. */
export async function readOutboundStats(pc, previous = null) {
  const report = await pc.getStats();
  let video = null;
  let audio = null;
  report.forEach((stat) => {
    if (stat.type !== 'outbound-rtp') return;
    const kind = kindOf(stat);
    if (kind === 'video' && (!video || (stat.bytesSent ?? 0) > (video.bytesSent ?? 0))) video = stat;
    else if (kind === 'audio' && (!audio || (stat.bytesSent ?? 0) > (audio.bytesSent ?? 0))) audio = stat;
  });

  let remoteVideo = video?.remoteId ? report.get(video.remoteId) ?? null : null;
  if (!remoteVideo) {
    report.forEach((stat) => {
      if (!remoteVideo && stat.type === 'remote-inbound-rtp' && kindOf(stat) === 'video') remoteVideo = stat;
    });
  }

  const pair = getSelectedCandidatePair(report);
  const raw = {
    time: video?.timestamp ?? audio?.timestamp ?? performance.now(),
    videoBytes: video?.bytesSent ?? null,
    audioBytes: audio?.bytesSent ?? null,
    packetsSent: video?.packetsSent ?? null,
    remotePacketsLost: remoteVideo?.packetsLost ?? null,
  };

  const elapsed = previous ? raw.time - previous.time : 0;
  const ready = Boolean(previous) && elapsed > 0 && video != null;

  let lossRate = null;
  if (ready) {
    const lost = delta(raw.remotePacketsLost, previous.remotePacketsLost);
    const sent = delta(raw.packetsSent, previous.packetsSent);
    if (lost != null && sent > 0) lossRate = Math.min(1, Math.max(0, lost) / sent);
    else if (Number.isFinite(remoteVideo?.fractionLost)) lossRate = remoteVideo.fractionLost;
    else lossRate = 0;
  }

  let rttMs = rttFromPair(pair);
  if (rttMs == null && Number.isFinite(remoteVideo?.roundTripTime)) rttMs = remoteVideo.roundTripTime * 1000;

  const videoBytes = ready ? delta(raw.videoBytes, previous.videoBytes) : null;
  const audioBytes = ready ? delta(raw.audioBytes, previous.audioBytes) : null;
  const codec = video?.codecId ? report.get(video.codecId) : null;

  return {
    ready,
    raw,
    width: video?.frameWidth ?? null,
    height: video?.frameHeight ?? null,
    fps: Number.isFinite(video?.framesPerSecond) ? video.framesPerSecond : null,
    codec: codecLabel(codec),
    codecMime: codec?.mimeType ?? null,
    encoder: video?.encoderImplementation ?? null,
    qualityLimitation: video?.qualityLimitationReason ?? null,
    videoBitrate: videoBytes != null ? perSecond(videoBytes * 8, elapsed) : null,
    audioBitrate: audioBytes != null ? perSecond(audioBytes * 8, elapsed) : null,
    availableBitrate: Number.isFinite(pair?.availableOutgoingBitrate) ? pair.availableOutgoingBitrate : null,
    lossRate,
    rttMs,
  };
}

/** Verde = estável, amarelo = ajustando qualidade, vermelho = perda de pacotes. */
export function evaluateHealth({ lossRate = null, rttMs = null, abrHealth = null, frozen = false } = {}) {
  if (lossRate == null && rttMs == null && !abrHealth) return 'idle';
  if ((lossRate ?? 0) > LOSS_CRITICAL || abrHealth === 'critical') return 'critical';
  if (frozen || abrHealth === 'adjusting' || (rttMs ?? 0) > RTT_WARNING_MS || (lossRate ?? 0) > LOSS_WARNING) {
    return 'adjusting';
  }
  return 'good';
}

/** Loop de amostragem sem sobreposição: cada leitura espera a anterior (e o callback) terminar. */
export class StatsMonitor {
  #reader;
  #intervalMs;
  #onSample;
  #previous = null;
  #timer = null;
  #running = false;

  constructor(reader, { intervalMs = 1000, onSample } = {}) {
    this.#reader = reader;
    this.#intervalMs = intervalMs;
    this.#onSample = onSample;
  }

  get running() {
    return this.#running;
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#previous = null;
    this.#loop();
  }

  stop() {
    this.#running = false;
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  async #loop() {
    if (!this.#running) return;
    try {
      const sample = await this.#reader(this.#previous);
      if (!this.#running) return;
      this.#previous = sample.raw;
      await this.#onSample?.(sample);
    } catch (err) {
      console.debug('[stats] leitura falhou', err);
    } finally {
      if (this.#running) this.#timer = setTimeout(() => this.#loop(), this.#intervalMs);
    }
  }
}

/** Liga elementos [data-hud="campo"] dentro de um contêiner a valores formatados. */
export class StatsHUD {
  #fields = new Map();

  constructor(root) {
    this.root = root;
    root.querySelectorAll('[data-hud]').forEach((el) => this.#fields.set(el.dataset.hud, el));
    this.setHealth('idle');
  }

  get visible() {
    return !this.root.classList.contains('is-hidden');
  }

  setVisible(visible) {
    this.root.classList.toggle('is-hidden', !visible);
    this.root.setAttribute('aria-hidden', String(!visible));
  }

  set(key, value) {
    const el = this.#fields.get(key);
    const text = value == null ? '—' : String(value);
    if (el && el.textContent !== text) el.textContent = text;
  }

  setHealth(health, label = HEALTH_LABELS[health] ?? health) {
    if (this.root.dataset.health !== health) this.root.dataset.health = health;
    this.set('health', label);
  }

  renderInbound(sample, health) {
    if (!sample) return;
    this.set('resolution', formatResolution(sample.width, sample.height));
    this.set('fps', formatFps(sample.fps));
    this.set('codec', sample.codec);
    this.set('bitrate', sample.ready ? formatMbps((sample.videoBitrate ?? 0) + (sample.audioBitrate ?? 0)) : '—');
    this.set('rtt', formatMs(sample.rttMs));
    this.set('loss', formatPercent(sample.lossRate));
    this.set('audio', sample.hasAudio ? (sample.ready ? formatMbps(sample.audioBitrate) : '…') : 'sem áudio');
    this.setHealth(health);
  }
}

// Viewer: conecta ao host pela sala, responde à oferta e reproduz o stream com suporte a Safari/iOS.

import { createPeer, applyCodecPreferences, setLocalDescriptionTuned } from './webrtc-host.js';
import { StatsMonitor, readInboundStats, evaluateHealth } from './stats.js';

const RETRY_DELAY_MS = 3000;
const DIAL_TIMEOUT_MS = 12000;
const FAILED_GRACE_MS = 15000;
const ABR_FRESHNESS_MS = 6000;
// Celulares não ganham nada acima de Full HD/60: o Safari limita páginas a 60 Hz e a tela é pequena.
const MOBILE_SHORT_SIDE_CAP = 1080;
const MOBILE_MAX_FPS = 60;
const DEVICE_CODEC_PROBES = Object.freeze([
  ['vp9', 'video/VP9'],
  ['av1', 'video/AV1'],
  ['h264', 'video/H264'],
]);

export function isMobileDevice() {
  const ua = navigator.userAgent;
  const byUa = /iPhone|iPad|iPod|Android|Mobile/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return navigator.userAgentData?.mobile || byUa;
}

/** Limites de exibição enviados ao host para que ele não codifique pixels/quadros que o aparelho descarta. */
export function describeDisplay() {
  if (!isMobileDevice()) return null;
  const dpr = window.devicePixelRatio || 1;
  const long = Math.round(Math.max(screen.width, screen.height) * dpr);
  const short = Math.round(Math.min(screen.width, screen.height) * dpr);
  const cappedShort = Math.min(short, MOBILE_SHORT_SIDE_CAP);
  return { long: Math.round((long * cappedShort) / short), short: cappedShort, maxFps: MOBILE_MAX_FPS };
}

/**
 * Em celulares, escolhe o primeiro codec decodificado por hardware (powerEfficient);
 * decodificar VP9/AV1 por software esquenta o aparelho e derruba quadros. H.264 é o fallback.
 * Em desktops retorna null e a ordem automática do host é mantida.
 */
async function preferredCodecForDevice() {
  if (!isMobileDevice()) return null;
  const capabilities = navigator.mediaCapabilities;
  if (typeof capabilities?.decodingInfo !== 'function') return 'h264';
  for (const [mode, contentType] of DEVICE_CODEC_PROBES) {
    try {
      const info = await capabilities.decodingInfo({
        type: 'webrtc',
        video: { contentType, width: 1920, height: 1080, bitrate: 8_000_000, framerate: 60 },
      });
      if (info.supported && info.powerEfficient) return mode;
    } catch {
      break;
    }
  }
  return 'h264';
}

export function describeClient() {
  const ua = navigator.userAgent;
  let device = 'Desktop';
  if (/iPhone/.test(ua)) device = 'iPhone';
  else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) device = 'iPad';
  else if (/Android/.test(ua)) device = 'Android';
  else if (/CrOS/.test(ua)) device = 'ChromeOS';
  else if (/Windows/.test(ua)) device = 'Windows';
  else if (/Mac OS X/.test(ua)) device = 'Mac';
  else if (/Linux/.test(ua)) device = 'Linux';

  let browser = 'Navegador';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  else if (/Firefox|FxiOS/.test(ua)) browser = 'Firefox';
  else if (/CriOS|Chrome/.test(ua)) browser = 'Chrome';
  else if (/Safari/.test(ua)) browser = 'Safari';

  return `${device} · ${browser}`;
}

export class ViewerSession extends EventTarget {
  #peer = null;
  #conn = null;
  #pc = null;
  #monitor = null;
  #chain = Promise.resolve();
  #pendingCandidates = [];
  #retryTimer = null;
  #dialTimer = null;
  #failTimer = null;
  #destroyed = false;
  #ended = false;
  #hostAbr = null;
  #state = 'idle';
  #playPending = false;
  #audioBlocked = false;
  #muted = false;
  #volume = 1;
  #statsEnabled = false;
  #deviceCodec;

  constructor({ roomId, hostPeerId, iceServers, video }) {
    super();
    this.roomId = roomId;
    this.hostPeerId = hostPeerId;
    this.iceServers = iceServers;
    this.video = video;
    this.#deviceCodec = preferredCodecForDevice().catch(() => null);
  }

  /** As estatísticas só são lidas com o HUD visível, para não gastar CPU à toa no celular. */
  setStatsEnabled(enabled) {
    this.#statsEnabled = enabled;
    if (!this.#monitor) return;
    if (enabled && this.#pc?.connectionState === 'connected') this.#monitor.start();
    else if (!enabled) this.#monitor.stop();
  }

  get state() {
    return this.#state;
  }

  get audioBlocked() {
    return this.#audioBlocked;
  }

  get muted() {
    return this.video.muted;
  }

  async connect() {
    if (this.#destroyed) return;
    this.#ended = false;
    this.#setStatus('connecting', 'Conectando ao servidor de sinalização…');
    try {
      this.#peer = await createPeer(null, this.iceServers);
    } catch (err) {
      console.warn('[viewer] PeerJS indisponível', err);
      this.#setStatus('error', 'Não foi possível alcançar o servidor de sinalização. Verifique sua conexão.');
      this.#scheduleRetry(() => this.connect(), RETRY_DELAY_MS * 2);
      return;
    }
    if (this.#destroyed) {
      this.#peer.destroy();
      return;
    }

    const peer = this.#peer;
    peer.on('error', (err) => this.#onPeerError(err));
    peer.on('disconnected', () => {
      if (this.#destroyed || peer.destroyed) return;
      setTimeout(() => {
        if (!this.#destroyed && !peer.destroyed && peer.disconnected) peer.reconnect();
      }, 1500);
    });

    this.#dial();
  }

  /** Repetir após erro ou fim de transmissão (botão "Tentar novamente"). */
  retry() {
    if (this.#destroyed) return;
    this.#ended = false;
    clearTimeout(this.#retryTimer);
    if (!this.#peer || this.#peer.destroyed) this.connect();
    else this.#dial();
  }

  /** Deve ser chamado dentro de um gesto do usuário (toque/clique) para destravar o áudio. */
  unlockAudio() {
    const video = this.video;
    this.#audioBlocked = false;
    this.#muted = false;
    video.muted = false;
    video.volume = this.#volume;
    return Promise.resolve(video.play())
      .then(() => {
        this.#emit('audio-unlocked');
        return true;
      })
      .catch((err) => {
        console.warn('[viewer] áudio ainda bloqueado', err);
        this.#audioBlocked = true;
        video.muted = true;
        video.play().catch(() => {});
        return false;
      });
  }

  setMuted(muted) {
    if (!muted && this.#audioBlocked) return this.unlockAudio();
    this.#muted = muted;
    this.video.muted = muted;
    return Promise.resolve(true);
  }

  setVolume(volume) {
    this.#volume = Math.min(1, Math.max(0, volume));
    this.video.volume = this.#volume;
  }

  /** Retoma a reprodução quando a aba volta ao primeiro plano (iOS pausa vídeos em segundo plano). */
  resume() {
    if (this.video.srcObject && this.video.paused) this.#requestPlay();
  }

  destroy() {
    if (this.#destroyed) return;
    this.#send({ type: 'bye' });
    this.#destroyed = true;
    clearTimeout(this.#retryTimer);
    this.#teardownConnection();
    this.#peer?.destroy();
    this.#peer = null;
  }

  #dial() {
    if (this.#destroyed || this.#ended || !this.#peer || this.#peer.destroyed) return;
    clearTimeout(this.#retryTimer);
    this.#teardownConnection();

    if (this.#peer.disconnected) {
      this.#peer.reconnect();
      this.#scheduleRetry(() => this.#dial());
      return;
    }

    if (this.#state !== 'waiting') this.#setStatus('connecting', `Procurando a sala ${this.roomId}…`);

    const conn = this.#peer.connect(this.hostPeerId, {
      serialization: 'json',
      reliable: true,
      metadata: { device: describeClient(), display: describeDisplay() },
    });
    this.#conn = conn;

    this.#dialTimer = setTimeout(() => {
      if (this.#conn !== conn || conn.open) return;
      this.#teardownConnection();
      this.#setStatus('waiting', 'Aguardando o host iniciar a transmissão…');
      this.#scheduleRetry(() => this.#dial());
    }, DIAL_TIMEOUT_MS);

    conn.on('open', () => {
      if (this.#conn !== conn) return;
      clearTimeout(this.#dialTimer);
      this.#setStatus('negotiating', 'Conectado à sala. Negociando vídeo…');
      conn.send({ type: 'hello', device: describeClient() });
    });
    conn.on('data', (message) => {
      if (this.#conn === conn) this.#handle(message);
    });
    conn.on('close', () => {
      if (this.#conn === conn) this.#onLinkLost();
    });
    conn.on('error', (err) => {
      if (this.#conn !== conn) return;
      console.warn('[viewer] erro no canal de sinalização', err);
      this.#onLinkLost();
    });
  }

  #onPeerError(err) {
    if (this.#destroyed) return;
    switch (err?.type) {
      case 'peer-unavailable':
        this.#teardownConnection();
        this.#setStatus('waiting', 'Aguardando o host iniciar a transmissão…');
        this.#scheduleRetry(() => this.#dial());
        break;
      case 'network':
      case 'server-error':
      case 'socket-error':
      case 'socket-closed':
        if (this.#state !== 'live') this.#setStatus('reconnecting', 'Sem contato com o servidor de sinalização. Reconectando…');
        this.#scheduleRetry(() => this.#dial(), RETRY_DELAY_MS * 2);
        break;
      default:
        console.warn('[viewer] erro do PeerJS', err);
    }
  }

  #onLinkLost() {
    if (this.#ended || this.#destroyed) return;
    this.#teardownConnection();
    this.#setStatus('reconnecting', 'Conexão com o host perdida. Tentando reconectar…');
    this.#scheduleRetry(() => this.#dial());
  }

  #onHostEnded() {
    this.#ended = true;
    clearTimeout(this.#retryTimer);
    this.#teardownConnection();
    this.video.srcObject = null;
    this.#setStatus('ended', 'O host encerrou a transmissão.');
  }

  #handle(message) {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'offer':
        this.#serialize(() => this.#onOffer(message));
        break;
      case 'ice':
        this.#serialize(() => this.#onRemoteCandidate(message.candidate));
        break;
      case 'abr':
        this.#hostAbr = { ...message, receivedAt: Date.now() };
        break;
      case 'ended':
        this.#onHostEnded();
        break;
      default:
        break;
    }
  }

  async #onOffer(message) {
    const pc = this.#pc ?? this.#createPeerConnection();
    await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });

    // O answer define o codec que o host vai usar para enviar. No modo automático, celulares
    // priorizam o codec com decodificação por hardware; uma escolha manual do host é respeitada.
    const hostMode = message.codec ?? 'auto';
    const mode = hostMode === 'auto' ? (await this.#deviceCodec) ?? 'auto' : hostMode;
    const videoTransceiver = pc.getTransceivers().find((t) => t.receiver.track?.kind === 'video');
    if (videoTransceiver) applyCodecPreferences(videoTransceiver, mode, { direction: 'recv' });

    const answer = await pc.createAnswer();
    await setLocalDescriptionTuned(pc, answer);
    this.#send({ type: 'answer', sdp: pc.localDescription.sdp });

    const pending = this.#pendingCandidates.splice(0);
    for (const candidate of pending) await this.#addCandidate(candidate);
  }

  async #onRemoteCandidate(candidate) {
    if (!candidate) return;
    if (!this.#pc?.remoteDescription) {
      this.#pendingCandidates.push(candidate);
      return;
    }
    await this.#addCandidate(candidate);
  }

  async #addCandidate(candidate) {
    try {
      await this.#pc?.addIceCandidate(candidate);
    } catch (err) {
      console.debug('[viewer] candidato ICE ignorado', err);
    }
  }

  #createPeerConnection() {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
    this.#pc = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) this.#send({ type: 'ice', candidate: event.candidate.toJSON() });
    };
    pc.ontrack = (event) => this.#onTrack(event);
    pc.onconnectionstatechange = () => this.#onConnectionState(pc);

    this.#monitor = new StatsMonitor((previous) => readInboundStats(pc, previous), {
      intervalMs: 1000,
      onSample: (sample) => this.#onStats(sample),
    });
    return pc;
  }

  #onTrack(event) {
    let stream = event.streams[0];
    if (!stream) {
      stream = this.video.srcObject instanceof MediaStream ? this.video.srcObject : new MediaStream();
      stream.addTrack(event.track);
    }
    if (this.video.srcObject !== stream) this.video.srcObject = stream;
    event.track.addEventListener('unmute', () => this.#requestPlay());
    this.#requestPlay();
  }

  #onConnectionState(pc) {
    if (pc !== this.#pc) return;
    const state = pc.connectionState;
    if (state !== 'failed') clearTimeout(this.#failTimer);

    if (state === 'connected') {
      this.#setStatus('live', 'Ao vivo');
      if (this.#statsEnabled) this.#monitor.start();
      this.#requestPlay();
    } else if (state === 'disconnected') {
      this.#setStatus('reconnecting', 'Instabilidade na rede. Reconectando…');
    } else if (state === 'failed') {
      // O host tenta um ICE restart; se não recuperar a tempo, refazemos a conexão do zero.
      this.#setStatus('reconnecting', 'Conexão interrompida. Tentando recuperar…');
      clearTimeout(this.#failTimer);
      this.#failTimer = setTimeout(() => {
        if (this.#pc === pc && pc.connectionState === 'failed') this.#onLinkLost();
      }, FAILED_GRACE_MS);
    }
  }

  #onStats(sample) {
    const abr = this.#hostAbr && Date.now() - this.#hostAbr.receivedAt < ABR_FRESHNESS_MS ? this.#hostAbr : null;
    const frozen = sample.ready && sample.fps === 0;
    const health = evaluateHealth({
      lossRate: sample.lossRate,
      rttMs: sample.rttMs,
      abrHealth: abr?.health ?? null,
      frozen,
    });
    this.#emit('stats', { sample, health, hostAbr: abr });
  }

  #requestPlay() {
    if (this.#playPending) return;
    this.#playPending = true;
    queueMicrotask(() => {
      this.#playPending = false;
      this.#play();
    });
  }

  async #play() {
    const video = this.video;
    if (!video.srcObject) return;
    video.muted = this.#muted || this.#audioBlocked;
    video.volume = this.#volume;
    try {
      await video.play();
      this.#emit('playing', { muted: video.muted });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      // Autoplay com som bloqueado: toca mudo para exibir o vídeo e pede um toque para liberar o áudio.
      this.#audioBlocked = true;
      video.muted = true;
      try {
        await video.play();
      } catch (mutedErr) {
        console.warn('[viewer] reprodução bloqueada mesmo sem som', mutedErr);
      }
      this.#emit('autoplay-blocked', { videoPlaying: !video.paused });
    }
  }

  #send(message) {
    if (!this.#conn?.open) return;
    try {
      this.#conn.send(message);
    } catch (err) {
      console.warn('[viewer] falha ao enviar sinalização', err);
    }
  }

  #teardownConnection() {
    clearTimeout(this.#dialTimer);
    clearTimeout(this.#failTimer);
    this.#monitor?.stop();
    this.#monitor = null;
    if (this.#pc) {
      this.#pc.ontrack = null;
      this.#pc.onicecandidate = null;
      this.#pc.onconnectionstatechange = null;
      this.#pc.close();
      this.#pc = null;
    }
    const conn = this.#conn;
    this.#conn = null;
    conn?.close();
    this.#pendingCandidates = [];
    this.#chain = Promise.resolve();
    this.#hostAbr = null;
  }

  #scheduleRetry(fn, delay = RETRY_DELAY_MS) {
    clearTimeout(this.#retryTimer);
    if (this.#destroyed || this.#ended) return;
    this.#retryTimer = setTimeout(fn, delay);
  }

  #serialize(task) {
    const run = this.#chain.then(task);
    this.#chain = run.catch((err) => console.warn('[viewer] erro de negociação', err));
    return this.#chain;
  }

  #setStatus(state, message) {
    this.#state = state;
    this.#emit('status', { state, message });
  }

  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

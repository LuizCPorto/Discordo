// Host: captura de tela, um RTCPeerConnection por viewer (topologia estrela) e negociação de codecs.
// O PeerJS é usado como canal de sinalização (DataConnection JSON); a mídia trafega em uma
// RTCPeerConnection própria para que codecs e encodings sejam configurados antes da oferta SDP.

import { AdaptiveQualityController, ABR_DEFAULTS } from './abr-controller.js';
import { worstHealth } from './stats.js';

export const RESOLUTION_PRESETS = Object.freeze({
  native: null,
  1440: Object.freeze({ width: 2560, height: 1440 }),
  1080: Object.freeze({ width: 1920, height: 1080 }),
});

export const DEFAULT_HOST_SETTINGS = Object.freeze({
  qualityMode: 'auto',
  resolution: 'native',
  fps: 60,
  maxBitrate: 20_000_000,
  codec: 'auto',
  degradationPreference: 'balanced',
  contentHint: 'motion',
  audioSource: 'tab',
});

const CLEAN_AUDIO_CONSTRAINTS = Object.freeze({
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: { ideal: 2 },
  sampleRate: { ideal: 48000 },
  suppressLocalAudioPlayback: false,
});

const SDP_TUNING = Object.freeze({
  audioBitrate: ABR_DEFAULTS.audioMaxBitrate,
  videoStartKbps: 6000,
  // Teto alto e fixo no SDP: o limite efetivo é o maxBitrate do ABR via setParameters.
  videoMaxKbps: 100_000,
});

const AUTO_CODEC_ORDER = Object.freeze(['VIDEO/VP9', 'VIDEO/AV1', 'VIDEO/H264', 'VIDEO/VP8']);
const MANUAL_CODECS = Object.freeze({ av1: 'VIDEO/AV1', vp9: 'VIDEO/VP9', h264: 'VIDEO/H264' });
const AUX_CODECS = new Set(['VIDEO/RTX', 'VIDEO/RED', 'VIDEO/ULPFEC', 'VIDEO/FLEXFEC-03']);
const ROOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const DISCONNECT_GRACE_MS = 4000;
const FAILED_DROP_MS = 25000;
const ENDED_FLUSH_MS = 250;

export function isScreenCaptureSupported() {
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

export function generateRoomId(length = 8) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join('');
}

/* ----------------------------------------------------------------------------
 * Codecs
 * ------------------------------------------------------------------------- */

const codecKey = (codec) => {
  const mime = String(codec.mimeType).toUpperCase();
  return mime === 'VIDEO/AV1X' ? 'VIDEO/AV1' : mime;
};

export function codecOrderFor(mode = 'auto') {
  const preferred = MANUAL_CODECS[mode];
  return preferred ? [preferred, ...AUTO_CODEC_ORDER.filter((m) => m !== preferred)] : [...AUTO_CODEC_ORDER];
}

// Dentro do mesmo codec, prefere as variantes de maior compatibilidade (8-bit, packetization-mode=1).
function variantRank(codec) {
  const fmtp = codec.sdpFmtpLine ?? '';
  switch (codecKey(codec)) {
    case 'VIDEO/VP9':
      return /profile-id=[1-3]/.test(fmtp) ? 1 : 0;
    case 'VIDEO/AV1':
      return /profile=[12]/.test(fmtp) ? 1 : 0;
    case 'VIDEO/H264':
      return /packetization-mode=1/.test(fmtp) ? 0 : 1;
    default:
      return 0;
  }
}

export function sortCodecs(codecs, mode = 'auto', { sendable = null } = {}) {
  const order = codecOrderFor(mode);
  const primary = [];
  const auxiliary = [];
  codecs.forEach((codec, index) => {
    const key = codecKey(codec);
    if (AUX_CODECS.has(key)) {
      auxiliary.push(codec);
      return;
    }
    if (sendable && !sendable.has(key)) return;
    const rank = order.indexOf(key);
    primary.push({ codec, rank: rank === -1 ? order.length : rank, variant: variantRank(codec), index });
  });
  primary.sort((a, b) => a.rank - b.rank || a.variant - b.variant || a.index - b.index);
  return [...primary.map((entry) => entry.codec), ...auxiliary];
}

/**
 * Ordena os codecs do transceiver de vídeo. Auto: VP9 → AV1 → H264 → VP8 (fallback universal).
 * Manual: o codec escolhido vai primeiro e os demais continuam como fallback para não falhar a conexão.
 * direction 'send' descarta codecs que este navegador consegue decodificar mas não codificar.
 */
export function applyCodecPreferences(transceiver, mode = 'auto', { direction = 'send' } = {}) {
  if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return null;
  const capabilities = globalThis.RTCRtpReceiver?.getCapabilities?.('video');
  if (!capabilities?.codecs?.length) return null;

  let sendable = null;
  if (direction === 'send') {
    const sendCaps = globalThis.RTCRtpSender?.getCapabilities?.('video');
    if (sendCaps?.codecs?.length) sendable = new Set(sendCaps.codecs.map(codecKey));
  }

  const sorted = sortCodecs(capabilities.codecs, mode, { sendable });
  const first = sorted.find((codec) => !AUX_CODECS.has(codecKey(codec)));
  if (!first) return null;

  try {
    transceiver.setCodecPreferences(sorted);
    return codecKey(first).slice('VIDEO/'.length);
  } catch (err) {
    console.warn('[codec] setCodecPreferences recusado; usando a ordem padrão do navegador', err);
    return null;
  }
}

/* ----------------------------------------------------------------------------
 * SDP: Opus estéreo de alto bitrate e bitrate inicial de vídeo alto
 * ------------------------------------------------------------------------- */

const TUNABLE_VIDEO = new Set(['vp8', 'vp9', 'av1', 'av1x', 'h264', 'h265']);

function mergeFmtp(existing, extra) {
  const params = new Map();
  for (const part of existing.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) params.set(trimmed, null);
    else params.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return Array.from(params, ([key, value]) => (value == null ? key : `${key}=${value}`)).join(';');
}

function tuneSection(lines, options) {
  const codecs = new Map();
  const withFmtp = new Set();
  for (const line of lines) {
    const rtpmap = /^a=rtpmap:(\d+) ([^/\s]+)\//.exec(line);
    if (rtpmap) codecs.set(rtpmap[1], rtpmap[2].toLowerCase());
    const fmtp = /^a=fmtp:(\d+) /.exec(line);
    if (fmtp) withFmtp.add(fmtp[1]);
  }

  const extraFor = (pt) => {
    const name = codecs.get(pt);
    if (name === 'opus') {
      return {
        stereo: '1',
        'sprop-stereo': '1',
        maxaveragebitrate: String(options.audioBitrate),
        maxplaybackrate: '48000',
        useinbandfec: '1',
        usedtx: '0',
      };
    }
    if (TUNABLE_VIDEO.has(name)) {
      return {
        'x-google-start-bitrate': String(options.videoStartKbps),
        'x-google-max-bitrate': String(options.videoMaxKbps),
      };
    }
    return null;
  };

  const out = [];
  for (const line of lines) {
    const fmtp = /^a=fmtp:(\d+) (.*)$/.exec(line);
    if (fmtp) {
      const extra = extraFor(fmtp[1]);
      out.push(extra ? `a=fmtp:${fmtp[1]} ${mergeFmtp(fmtp[2], extra)}` : line);
      continue;
    }
    out.push(line);
    const rtpmap = /^a=rtpmap:(\d+) /.exec(line);
    if (rtpmap && !withFmtp.has(rtpmap[1])) {
      const extra = extraFor(rtpmap[1]);
      if (extra) out.push(`a=fmtp:${rtpmap[1]} ${mergeFmtp('', extra)}`);
    }
  }
  return out;
}

export function tuneSdp(sdp, overrides = {}) {
  const options = { ...SDP_TUNING, ...overrides };
  const lines = sdp.split('\r\n');
  const sections = [[]];
  for (const line of lines) {
    if (line.startsWith('m=')) sections.push([]);
    sections[sections.length - 1].push(line);
  }
  const [session, ...media] = sections;
  return [...session, ...media.flatMap((section) => tuneSection(section, options))].join('\r\n');
}

/** setLocalDescription com SDP ajustado; se o navegador recusar o ajuste, usa o SDP original. */
export async function setLocalDescriptionTuned(pc, description, overrides) {
  try {
    await pc.setLocalDescription({ type: description.type, sdp: tuneSdp(description.sdp, overrides) });
  } catch (err) {
    console.warn('[sdp] ajuste recusado; usando SDP original', err);
    await pc.setLocalDescription(description);
  }
}

/* ----------------------------------------------------------------------------
 * PeerJS
 * ------------------------------------------------------------------------- */

export function createPeer(id, iceServers, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const PeerCtor = globalThis.Peer;
    if (typeof PeerCtor !== 'function') {
      reject(Object.assign(new Error('PeerJS não foi carregado.'), { type: 'peerjs-missing' }));
      return;
    }
    const options = { debug: 1, config: { iceServers: iceServers.map((server) => ({ ...server })) } };
    const peer = id ? new PeerCtor(id, options) : new PeerCtor(options);

    const timer = setTimeout(() => {
      fail(Object.assign(new Error('Tempo esgotado ao conectar ao servidor de sinalização.'), { type: 'timeout' }));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      peer.off('open', onOpen);
      peer.off('error', fail);
    }
    function onOpen() {
      cleanup();
      resolve(peer);
    }
    function fail(err) {
      cleanup();
      peer.destroy();
      reject(err);
    }

    peer.on('open', onOpen);
    peer.on('error', fail);
  });
}

/* ----------------------------------------------------------------------------
 * Captura
 * ------------------------------------------------------------------------- */

export function buildVideoConstraints({ resolution, fps }) {
  const constraints = { frameRate: { ideal: fps, max: fps } };
  const preset = RESOLUTION_PRESETS[resolution];
  if (preset) {
    constraints.width = { max: preset.width };
    constraints.height = { max: preset.height };
  }
  return constraints;
}

/**
 * Deve ser chamada de forma síncrona dentro do gesto do usuário (exigência do Safari).
 * audioSource 'tab': o seletor abre na aba de guias e o áudio do sistema não é oferecido,
 * então só o som da guia escolhida é transmitido.
 */
export function captureScreen(settings) {
  if (!isScreenCaptureSupported()) {
    return Promise.reject(
      Object.assign(new Error('Este navegador não permite compartilhar a tela.'), { name: 'NotSupportedError' }),
    );
  }
  const source = settings.audioSource ?? DEFAULT_HOST_SETTINGS.audioSource;
  const includeSystem = source === 'system';
  return navigator.mediaDevices.getDisplayMedia({
    video: { ...buildVideoConstraints(settings), displaySurface: source === 'tab' ? 'browser' : 'monitor' },
    audio: source === 'none' ? false : { ...CLEAN_AUDIO_CONSTRAINTS },
    systemAudio: includeSystem ? 'include' : 'exclude',
    windowAudio: includeSystem ? 'system' : 'exclude',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include',
  });
}

// Limites de tela informados pelo viewer (só celulares enviam); valores fora da faixa são ignorados.
function sanitizeDisplayCap(display) {
  const inRange = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
  if (!display || !inRange(display.long, 320, 8192) || !inRange(display.short, 240, 8192)) return null;
  return {
    long: Math.max(display.long, display.short),
    short: Math.min(display.long, display.short),
    maxFps: inRange(display.maxFps, 15, 240) ? display.maxFps : null,
  };
}

function addTransceiverSafe(pc, trackOrKind, init) {
  try {
    return pc.addTransceiver(trackOrKind, init);
  } catch (err) {
    console.warn('[host] sendEncodings recusado; criando transceiver sem encodings', err);
    const { sendEncodings, ...rest } = init;
    return pc.addTransceiver(trackOrKind, rest);
  }
}

/* ----------------------------------------------------------------------------
 * Conexão com um viewer
 * ------------------------------------------------------------------------- */

class HostPeerLink {
  #session;
  #chain = Promise.resolve();
  #pendingCandidates = [];
  #renegotiate = false;
  #restartPending = false;
  #closed = false;
  #disconnectTimer = null;
  #failTimer = null;

  constructor(session, conn) {
    this.#session = session;
    this.conn = conn;
    this.id = conn.peer;
    this.label = conn.metadata?.device || 'Espectador';
    this.displayCap = sanitizeDisplayCap(conn.metadata?.display);
    this.pc = null;
    this.video = null;
    this.audio = null;
    this.abr = null;
    this.codec = null;
    this.snapshot = null;
    this.joinedAt = Date.now();
  }

  get connectionState() {
    return this.pc?.connectionState ?? 'new';
  }

  start() {
    const { stream, settings, iceServers } = this.#session;
    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
    this.pc = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) this.send({ type: 'ice', candidate: event.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => this.#onConnectionState();

    const [videoTrack] = stream.getVideoTracks();
    const [audioTrack] = stream.getAudioTracks();

    this.video = addTransceiverSafe(pc, videoTrack, {
      direction: 'sendonly',
      streams: [stream],
      sendEncodings: [{ maxBitrate: settings.maxBitrate, maxFramerate: settings.fps, scaleResolutionDownBy: 1 }],
    });
    // O transceiver de áudio existe mesmo sem faixa, para permitir trocar a fonte depois via replaceTrack.
    this.audio = addTransceiverSafe(pc, audioTrack ?? 'audio', {
      direction: 'sendonly',
      streams: [stream],
      sendEncodings: [{ maxBitrate: ABR_DEFAULTS.audioMaxBitrate, priority: 'high', networkPriority: 'high' }],
    });

    this.codec = applyCodecPreferences(this.video, settings.codec);

    this.abr = new AdaptiveQualityController({
      pc,
      videoSender: this.video.sender,
      audioSender: this.audio.sender,
      mode: settings.qualityMode,
      maxBitrate: settings.maxBitrate,
      maxFramerate: settings.fps,
      degradationPreference: settings.degradationPreference,
      displayCap: this.displayCap,
      onUpdate: (snapshot) => this.#onAbrUpdate(snapshot),
    });
    this.abr.start();

    return this.negotiate();
  }

  negotiate({ iceRestart = false } = {}) {
    return this.#serialize(async () => {
      if (this.#closed) return;
      if (this.pc.signalingState !== 'stable') {
        this.#renegotiate = true;
        this.#restartPending ||= iceRestart;
        return;
      }
      const offer = await this.pc.createOffer({ iceRestart });
      await setLocalDescriptionTuned(this.pc, offer);
      this.send({
        type: 'offer',
        sdp: this.pc.localDescription.sdp,
        codec: this.#session.settings.codec,
      });
    });
  }

  handle(message) {
    if (!message || typeof message !== 'object' || this.#closed) return;
    switch (message.type) {
      case 'answer':
        this.#serialize(() => this.#onAnswer(message.sdp));
        break;
      case 'ice':
        this.#serialize(() => this.#onRemoteCandidate(message.candidate));
        break;
      case 'hello':
        if (typeof message.device === 'string' && message.device) this.label = message.device.slice(0, 60);
        this.#session.notifyViewersChanged();
        break;
      case 'bye':
        this.#session.dropLink(this);
        break;
      default:
        break;
    }
  }

  applySettings(previous, next) {
    if (!this.abr || this.#closed) return;
    if (previous.qualityMode !== next.qualityMode) this.abr.setMode(next.qualityMode);
    if (previous.maxBitrate !== next.maxBitrate) this.abr.setMaxBitrate(next.maxBitrate);
    if (previous.fps !== next.fps) this.abr.setMaxFramerate(next.fps);
    else if (previous.resolution !== next.resolution) this.abr.reapply();
    if (previous.degradationPreference !== next.degradationPreference) {
      this.abr.setDegradationPreference(next.degradationPreference);
    }
    if (previous.codec !== next.codec) {
      this.codec = applyCodecPreferences(this.video, next.codec);
      this.negotiate();
    }
  }

  async replaceTracks(stream) {
    if (this.#closed) return;
    const [videoTrack] = stream.getVideoTracks();
    const [audioTrack] = stream.getAudioTracks();
    await Promise.all([
      this.video.sender.replaceTrack(videoTrack ?? null),
      this.audio.sender.replaceTrack(audioTrack ?? null),
    ]);
    this.abr?.reapply();
  }

  send(message) {
    if (this.#closed || !this.conn.open) return;
    try {
      this.conn.send(message);
    } catch (err) {
      console.warn('[host] falha ao enviar sinalização', err);
    }
  }

  close({ notify = false, reason = 'host-stopped' } = {}) {
    if (this.#closed) return;
    if (notify) this.send({ type: 'ended', reason });
    this.#closed = true;
    clearTimeout(this.#disconnectTimer);
    clearTimeout(this.#failTimer);
    this.abr?.stop();
    this.pc?.close();
    const { conn } = this;
    if (notify) setTimeout(() => conn.close(), ENDED_FLUSH_MS);
    else conn.close();
  }

  async #onAnswer(sdp) {
    if (this.pc.signalingState !== 'have-local-offer') return;
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
    const pending = this.#pendingCandidates.splice(0);
    for (const candidate of pending) await this.#addCandidate(candidate);
    if (this.#renegotiate) {
      const iceRestart = this.#restartPending;
      this.#renegotiate = false;
      this.#restartPending = false;
      this.negotiate({ iceRestart });
    }
  }

  async #onRemoteCandidate(candidate) {
    if (!candidate) return;
    if (!this.pc.remoteDescription) {
      this.#pendingCandidates.push(candidate);
      return;
    }
    await this.#addCandidate(candidate);
  }

  async #addCandidate(candidate) {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      console.debug('[host] candidato ICE ignorado', err);
    }
  }

  #onConnectionState() {
    const state = this.pc.connectionState;
    clearTimeout(this.#disconnectTimer);
    if (state !== 'failed') clearTimeout(this.#failTimer);

    if (state === 'connected') {
      this.abr.reapply();
    } else if (state === 'disconnected') {
      this.#disconnectTimer = setTimeout(() => {
        if (this.pc.connectionState === 'disconnected') this.negotiate({ iceRestart: true });
      }, DISCONNECT_GRACE_MS);
    } else if (state === 'failed') {
      this.negotiate({ iceRestart: true });
      clearTimeout(this.#failTimer);
      this.#failTimer = setTimeout(() => {
        if (this.pc.connectionState === 'failed') this.#session.dropLink(this);
      }, FAILED_DROP_MS);
    }
    this.#session.notifyViewersChanged();
  }

  #onAbrUpdate(snapshot) {
    this.snapshot = snapshot;
    this.send({
      type: 'abr',
      mode: snapshot.mode,
      health: snapshot.health,
      action: snapshot.action,
      targetBitrate: snapshot.targetBitrate,
      maxBitrate: snapshot.maxBitrate,
      scale: snapshot.scale,
    });
    this.#session.notifyLinkStats(this);
  }

  #serialize(task) {
    const run = this.#chain.then(task);
    this.#chain = run.catch((err) => console.warn(`[host] erro de negociação com ${this.id}`, err));
    return this.#chain;
  }
}

/* ----------------------------------------------------------------------------
 * Sessão do host
 * ------------------------------------------------------------------------- */

export class HostSession extends EventTarget {
  #iceServers;
  #peerPrefix;
  #peer = null;
  #roomId = null;
  #stream = null;
  #links = new Map();
  #ended = false;
  #reconnectTimer = null;
  #reconnectAttempts = 0;

  constructor({ iceServers, peerPrefix, settings = {} }) {
    super();
    this.#iceServers = iceServers;
    this.#peerPrefix = peerPrefix;
    this.settings = { ...DEFAULT_HOST_SETTINGS, ...settings };
  }

  get iceServers() {
    return this.#iceServers;
  }

  get roomId() {
    return this.#roomId;
  }

  get stream() {
    return this.#stream;
  }

  get videoTrack() {
    return this.#stream?.getVideoTracks()[0] ?? null;
  }

  get audioTrack() {
    return this.#stream?.getAudioTracks()[0] ?? null;
  }

  get viewers() {
    return Array.from(this.#links.values());
  }

  get active() {
    return Boolean(this.#peer) && !this.#ended;
  }

  /** A captura acontece antes de qualquer await para preservar o gesto do usuário. */
  async start() {
    const stream = await captureScreen(this.settings);
    this.#stream = stream;
    this.#prepareStream(stream);

    try {
      const { peer, roomId } = await this.#openPeer();
      this.#peer = peer;
      this.#roomId = roomId;
    } catch (err) {
      stream.getTracks().forEach((track) => track.stop());
      this.#stream = null;
      throw err;
    }

    if (this.#ended) {
      this.#peer.destroy();
      throw Object.assign(new Error('Transmissão encerrada durante a inicialização.'), { name: 'AbortError' });
    }

    this.#bindPeer(this.#peer);
    return this.#roomId;
  }

  async switchSource() {
    if (!this.active) return;
    const stream = await captureScreen(this.settings);
    const previous = this.#stream;
    this.#stream = stream;
    this.#prepareStream(stream);
    await Promise.all(this.viewers.map((link) => link.replaceTracks(stream).catch((err) => console.warn(err))));
    previous?.getTracks().forEach((track) => track.stop());
    this.#emit('stream', { stream });
  }

  async updateSettings(patch) {
    const previous = this.settings;
    const next = { ...previous, ...patch };
    this.settings = next;

    const videoTrack = this.videoTrack;
    if (videoTrack && (previous.fps !== next.fps || previous.resolution !== next.resolution)) {
      try {
        await videoTrack.applyConstraints(buildVideoConstraints(next));
      } catch (err) {
        console.warn('[host] applyConstraints recusado', err);
      }
    }
    if (videoTrack && previous.contentHint !== next.contentHint && 'contentHint' in videoTrack) {
      videoTrack.contentHint = next.contentHint;
    }
    for (const link of this.#links.values()) link.applySettings(previous, next);
  }

  summary() {
    const settings = this.videoTrack?.getSettings?.() ?? {};
    let uploadBps = 0;
    let health = 'idle';
    for (const link of this.#links.values()) {
      const snapshot = link.snapshot;
      if (!snapshot) continue;
      if (snapshot.sample?.ready) uploadBps += (snapshot.sample.videoBitrate ?? 0) + (snapshot.sample.audioBitrate ?? 0);
      health = worstHealth(health, snapshot.health);
    }
    const audioTrack = this.audioTrack;
    return {
      width: settings.width ?? null,
      height: settings.height ?? null,
      frameRate: settings.frameRate ?? null,
      surface: settings.displaySurface ?? null,
      viewers: this.#links.size,
      uploadBps,
      health,
      hasAudio: Boolean(audioTrack && audioTrack.readyState === 'live'),
    };
  }

  stop(reason = 'host-stopped') {
    if (this.#ended) return;
    this.#ended = true;
    clearTimeout(this.#reconnectTimer);
    for (const link of this.#links.values()) link.close({ notify: true, reason });
    this.#links.clear();
    this.#stream?.getTracks().forEach((track) => track.stop());
    const peer = this.#peer;
    if (peer) setTimeout(() => peer.destroy(), ENDED_FLUSH_MS * 2);
    this.#emit('ended', { reason });
  }

  dropLink(link) {
    if (this.#links.get(link.id) === link) this.#links.delete(link.id);
    link.close();
    this.notifyViewersChanged();
  }

  notifyViewersChanged() {
    this.#emit('viewers', { viewers: this.viewers });
  }

  notifyLinkStats(link) {
    this.#emit('viewer-stats', { link });
  }

  async #openPeer() {
    let lastError = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const roomId = generateRoomId();
      try {
        const peer = await createPeer(this.#peerPrefix + roomId, this.#iceServers);
        return { peer, roomId };
      } catch (err) {
        lastError = err;
        if (err?.type !== 'unavailable-id') break;
      }
    }
    throw lastError;
  }

  #bindPeer(peer) {
    peer.on('connection', (conn) => this.#accept(conn));
    peer.on('open', () => {
      this.#reconnectAttempts = 0;
      this.#emit('signaling', { state: 'online' });
    });
    peer.on('disconnected', () => {
      if (this.#ended || peer.destroyed) return;
      this.#emit('signaling', { state: 'reconnecting' });
      this.#scheduleReconnect(peer);
    });
    peer.on('error', (err) => {
      if (err?.type === 'peer-unavailable') return;
      console.warn('[host] erro do PeerJS', err);
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err?.type)) {
        this.#scheduleReconnect(peer);
      }
    });
  }

  // Viewers já conectados seguem assistindo; o servidor de sinalização só é necessário para novas entradas.
  #scheduleReconnect(peer) {
    clearTimeout(this.#reconnectTimer);
    const delay = Math.min(15000, 1000 * 2 ** this.#reconnectAttempts);
    this.#reconnectAttempts += 1;
    this.#reconnectTimer = setTimeout(() => {
      if (!this.#ended && !peer.destroyed && peer.disconnected) peer.reconnect();
    }, delay);
  }

  #accept(conn) {
    conn.on('open', () => {
      if (this.#ended) {
        conn.close();
        return;
      }
      this.#links.get(conn.peer)?.close();
      const link = new HostPeerLink(this, conn);
      this.#links.set(conn.peer, link);

      conn.on('data', (message) => link.handle(message));
      conn.on('close', () => this.dropLink(link));
      conn.on('error', (err) => {
        console.warn('[host] erro no canal de sinalização', err);
        this.dropLink(link);
      });

      link.start().catch((err) => {
        console.error('[host] falha ao iniciar conexão com viewer', err);
        this.dropLink(link);
      });
      this.notifyViewersChanged();
    });
  }

  #prepareStream(stream) {
    const [videoTrack] = stream.getVideoTracks();
    const [audioTrack] = stream.getAudioTracks();
    if (videoTrack) {
      if ('contentHint' in videoTrack) videoTrack.contentHint = this.settings.contentHint;
      videoTrack.addEventListener(
        'ended',
        () => {
          if (this.#stream === stream) this.stop('capture-ended');
        },
        { once: true },
      );
    }
    if (audioTrack) {
      if ('contentHint' in audioTrack) audioTrack.contentHint = 'music';
      audioTrack
        .applyConstraints({ echoCancellation: false, noiseSuppression: false, autoGainControl: false })
        .catch(() => {});
    }
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

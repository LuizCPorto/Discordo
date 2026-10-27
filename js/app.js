// Roteamento (?room=...), estado da UI e inicialização das sessões de host/viewer.

import { HostSession, DEFAULT_HOST_SETTINGS, DATA_SAVER_BITRATE, isScreenCaptureSupported } from './webrtc-host.js';
import { ViewerSession, isMobileDevice } from './webrtc-viewer.js';
import {
  StatsHUD,
  HEALTH_LABELS,
  formatMbps,
  formatResolution,
  formatFps,
  formatPercent,
  formatMs,
} from './stats.js';

// STUN gratuito e ilimitado. O TURN (necessário em 4G/5G) vem do Worker em /api/turn, com limite mensal.
const BASE_ICE_SERVERS = Object.freeze([
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
]);
const RELAY_REFRESH_MS = 3 * 60 * 60 * 1000;
const RELAY_FETCH_TIMEOUT_MS = 4000;

const PEER_PREFIX = 'discordo-v1-';
const ROOM_PATTERN = /^[a-z0-9]{4,32}$/;
const CONTROLS_IDLE_MS = 2800;

const OPTIONS = Object.freeze({
  qualityMode: [
    ['auto', 'Automático inteligente'],
    ['manual', 'Manual (bitrate fixo)'],
  ],
  resolution: [
    ['native', 'Nativa (sem redimensionar)'],
    ['1440', '1440p (QHD)'],
    ['1080', '1080p (Full HD)'],
  ],
  fps: [
    ['60', '60 FPS'],
    ['120', '120 FPS'],
  ],
  maxBitrate: [
    ['10', '10 Mbps'],
    ['15', '15 Mbps'],
    ['20', '20 Mbps'],
    ['30', '30 Mbps'],
    ['50', '50 Mbps'],
    ['80', '80 Mbps'],
  ],
  codec: [
    ['auto', 'Automático (Adaptativo Universal)'],
    ['av1', 'AV1'],
    ['vp9', 'VP9'],
    ['h264', 'H.264 (Máxima compatibilidade)'],
  ],
  degradationPreference: [
    ['balanced', 'Equilibrado (recomendado)'],
    ['maintain-framerate', 'Manter FPS'],
    ['maintain-resolution', 'Manter nitidez'],
  ],
  contentHint: [
    ['motion', 'Movimento (jogos, vídeos)'],
    ['detail', 'Detalhe (texto, código)'],
  ],
  audioSource: [
    ['tab', 'Somente da guia (navegador)'],
    ['system', 'Sistema inteiro (tela ou janela)'],
    ['none', 'Sem áudio'],
  ],
});

const STATE_LABELS = Object.freeze({
  new: 'Conectando…',
  connecting: 'Conectando…',
  disconnected: 'Instável',
  failed: 'Reconectando…',
  closed: 'Encerrado',
});

const $ = (selector, root = document) => root.querySelector(selector);

const storage = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(`discordo:${key}`);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`discordo:${key}`, JSON.stringify(value));
    } catch {
      /* armazenamento indisponível (modo privado): preferências ficam só nesta sessão */
    }
  },
};

/* ----------------------------------------------------------------------------
 * Utilidades de UI
 * ------------------------------------------------------------------------- */

function showView(name) {
  document.querySelectorAll('.view').forEach((view) => {
    view.hidden = view.dataset.view !== name;
  });
  document.body.dataset.view = name;
}

let toastTimer = null;
function toast(message, tone = 'info', duration = 3600) {
  const el = $('#toast');
  el.textContent = message;
  el.dataset.tone = tone;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), duration);
}

function populateSelects(root) {
  root.querySelectorAll('select[data-options]').forEach((select) => {
    if (select.options.length) return;
    for (const [value, label] of OPTIONS[select.dataset.options] ?? []) {
      select.add(new Option(label, value));
    }
  });
}

function readSettings(form) {
  const data = new FormData(form);
  const settings = {};
  const text = (name) => (data.has(name) ? String(data.get(name)) : null);
  if (text('qualityMode')) settings.qualityMode = text('qualityMode');
  if (text('resolution')) settings.resolution = text('resolution');
  if (text('fps')) settings.fps = Number(text('fps'));
  if (text('maxBitrate')) settings.maxBitrate = Number(text('maxBitrate')) * 1e6;
  if (text('codec')) settings.codec = text('codec');
  if (text('degradationPreference')) settings.degradationPreference = text('degradationPreference');
  if (text('contentHint')) settings.contentHint = text('contentHint');
  if (text('audioSource')) settings.audioSource = text('audioSource');
  return settings;
}

// Preferências salvas antes do seletor de áudio usavam um checkbox "captureAudio".
function loadSavedSettings() {
  const { captureAudio, ...saved } = storage.get('host-settings', {});
  if (!saved.audioSource && captureAudio === false) saved.audioSource = 'none';
  return { ...DEFAULT_HOST_SETTINGS, ...saved };
}

function writeSettings(form, settings) {
  const values = {
    ...settings,
    fps: String(settings.fps),
    maxBitrate: String(Math.round(settings.maxBitrate / 1e6)),
  };
  for (const [name, value] of Object.entries(values)) {
    const field = form.elements[name];
    if (!field) continue;
    if (field instanceof RadioNodeList) {
      for (const radio of field) radio.checked = radio.value === value;
    } else if (field.type === 'checkbox') {
      field.checked = Boolean(value);
    } else if ([...(field.options ?? [])].some((option) => option.value === value)) {
      field.value = value;
    }
  }
}

function syncModeLabels(form) {
  const manual = new FormData(form).get('qualityMode') === 'manual';
  form.querySelectorAll('[data-bitrate-label]').forEach((el) => {
    el.textContent = manual ? 'Bitrate fixo' : 'Teto de bitrate';
  });
  form.querySelectorAll('[data-mode-hint]').forEach((el) => {
    el.textContent = manual
      ? 'Bitrate constante para todos. Use só se todos tiverem conexão rápida e estável.'
      : 'Cada espectador tem seu próprio ajuste: começa no teto e reduz em degraus se houver perda ou latência, sem nunca baixar de 2.5 Mbps.';
  });
}

function sanitizeRoom(value) {
  const room = String(value ?? '').trim().toLowerCase();
  return ROOM_PATTERN.test(room) ? room : null;
}

function roomFromInput(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw, location.href);
    const fromQuery = sanitizeRoom(url.searchParams.get('room'));
    if (fromQuery) return fromQuery;
  } catch {
    /* não é URL: tenta como código puro */
  }
  return sanitizeRoom(raw);
}

function roomLink(roomId) {
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set('room', roomId);
  return url.toString();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.append(field);
    field.select();
    const ok = document.execCommand('copy');
    field.remove();
    return ok;
  }
}

function describeStartError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
      return 'Compartilhamento cancelado ou bloqueado pelo navegador.';
    case 'NotFoundError':
      return 'Nenhuma tela disponível para captura.';
    case 'NotReadableError':
      return 'Não foi possível capturar a tela. Outro app pode estar bloqueando a captura.';
    case 'NotSupportedError':
      return 'Este navegador não permite compartilhar a tela. Use Chrome, Edge ou Firefox no computador.';
    case 'AbortError':
      return 'Transmissão cancelada.';
    default:
      break;
  }
  if (err?.type === 'peerjs-missing') return 'Uma parte do site não carregou. Desative bloqueadores de anúncio e recarregue a página.';
  if (err?.type) return 'Não foi possível abrir a sala. Verifique sua internet e tente novamente.';
  return 'Não foi possível iniciar a transmissão.';
}

/* ----------------------------------------------------------------------------
 * Servidor de apoio (TURN) para quem está em 4G/5G
 * ------------------------------------------------------------------------- */

const relay = {
  status: null,
  servers: [...BASE_ICE_SERVERS],
  listeners: new Set(),
};

async function fetchRelayStatus() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELAY_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch('/api/turn', { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    console.warn('[app] servidor de apoio indisponível', err);
    return { turn: false, reason: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

async function loadRelay() {
  const status = await fetchRelayStatus();
  relay.status = status;
  relay.servers = status.turn ? [...BASE_ICE_SERVERS, ...status.iceServers] : [...BASE_ICE_SERVERS];
  relay.listeners.forEach((listener) => listener(relay));
  return relay;
}

// As credenciais expiram em 4 h; renova a cada 3 h para transmissões longas não caírem.
function keepRelayFresh() {
  setInterval(loadRelay, RELAY_REFRESH_MS);
}

function formatDay(iso) {
  return iso ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '';
}

function describeRelay(status) {
  if (!status) return { tone: 'idle', text: 'Verificando conexão para 4G/5G…' };
  if (status.turn) {
    return { tone: 'good', text: `Conexão para 4G/5G ativa · ${status.usedGB ?? 0} de ${status.limitGB} GB usados neste mês` };
  }
  switch (status.reason) {
    case 'limit':
      return {
        tone: 'warn',
        text: `Conexão para 4G/5G desativada: o limite mensal de ${status.limitGB} GB foi atingido. Volta em ${formatDay(status.resetsAt)}. Quem está no Wi-Fi assiste normalmente.`,
      };
    case 'usage-unknown':
      return {
        tone: 'warn',
        text: 'Conexão para 4G/5G desativada por segurança: não foi possível verificar o consumo do mês. Quem está no Wi-Fi assiste normalmente.',
      };
    case 'not-configured':
      return { tone: 'warn', text: 'Conexão para 4G/5G não configurada. Por enquanto, só Wi-Fi.' };
    default:
      return { tone: 'warn', text: 'Conexão para 4G/5G indisponível no momento. Quem está no Wi-Fi assiste normalmente.' };
  }
}

/** Mensagem para o viewer quando a conexão de vídeo não consegue ser estabelecida. */
function connectionFailureHint(status) {
  if (status?.reason === 'limit') {
    return `Não foi possível conectar. Assistir pelo 4G/5G está desativado até ${formatDay(status.resetsAt)} porque o limite mensal foi atingido. Tente pelo Wi-Fi.`;
  }
  if (status && !status.turn) return 'Não foi possível conectar. Assistir pelo 4G/5G está indisponível agora; tente pelo Wi-Fi.';
  return 'Não foi possível conectar ao vídeo. Tentando de novo…';
}

/* ----------------------------------------------------------------------------
 * Host
 * ------------------------------------------------------------------------- */

const host = {
  session: null,
  hud: null,
  hudTimer: null,
  starting: false,
};

function setupHost() {
  showView('host-setup');
  populateSelects(document);

  const form = $('#host-form');
  const liveForm = $('#live-form');
  const startButton = $('#start-btn');

  writeSettings(form, loadSavedSettings());
  syncModeLabels(form);

  if (!isScreenCaptureSupported()) {
    const notice = $('#host-support');
    notice.hidden = false;
    notice.textContent =
      'Este dispositivo não consegue transmitir a tela pelo navegador. Para assistir, abra o link que o host enviou.';
    startButton.disabled = true;
  }

  form.addEventListener('change', () => {
    syncModeLabels(form);
    storage.set('host-settings', readSettings(form));
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!host.starting) startBroadcast(readSettings(form));
  });

  $('#join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const room = roomFromInput($('#join-input').value);
    if (!room) {
      toast('Código de sala inválido.', 'error');
      return;
    }
    location.href = roomLink(room);
  });

  liveForm.addEventListener('change', (event) => {
    if (!host.session) return;
    syncModeLabels(liveForm);
    const patch = readSettings(liveForm);
    host.session.updateSettings(patch);
    storage.set('host-settings', { ...host.session.settings });
    if (event.target.name === 'codec') toast('Renegociando codec com os espectadores…');
  });

  $('#copy-link').addEventListener('click', async () => {
    const ok = await copyText($('#share-link').value);
    toast(ok ? 'Link copiado.' : 'Não foi possível copiar. Selecione o link manualmente.', ok ? 'success' : 'error');
  });

  const shareButton = $('#share-native');
  if (typeof navigator.share === 'function') {
    shareButton.hidden = false;
    shareButton.addEventListener('click', () => {
      navigator
        .share({ title: 'Assista minha tela', url: $('#share-link').value })
        .catch(() => {});
    });
  }

  $('#switch-source').addEventListener('click', () => {
    host.session?.switchSource().catch((err) => {
      if (err?.name !== 'NotAllowedError') toast(describeStartError(err), 'error');
    });
  });

  $('#toggle-preview').addEventListener('click', (event) => {
    const preview = $('#host-preview');
    const hidden = !preview.hidden;
    preview.hidden = hidden;
    $('#preview-off').hidden = !hidden;
    if (hidden) preview.srcObject = null;
    else if (host.session) {
      preview.srcObject = host.session.stream;
      preview.play().catch(() => {});
    }
    event.currentTarget.textContent = hidden ? 'Mostrar prévia' : 'Ocultar prévia';
    event.currentTarget.setAttribute('aria-pressed', String(hidden));
  });

  $('#toggle-stats').addEventListener('click', () => {
    if (!host.hud) return;
    setHostStatsVisible(!host.hud.visible);
    storage.set('stats-visible', host.hud.visible);
  });

  $('#stop-broadcast').addEventListener('click', () => host.session?.stop('host-stopped'));

  relay.listeners.add(({ status, servers }) => {
    renderRelayStatus(status);
    // Só repassa credenciais válidas: sem TURN, as conexões atuais seguem até as credenciais expirarem.
    if (status.turn) host.session?.setIceServers(servers);
  });
  renderRelayStatus(null);
  loadRelay();
  keepRelayFresh();

  window.addEventListener('pagehide', () => host.session?.stop('host-left'));
  window.addEventListener('beforeunload', (event) => {
    if (host.session?.active && host.session.viewers.length) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

function startBroadcast(settings) {
  const button = $('#start-btn');
  host.starting = true;
  button.disabled = true;
  button.textContent = 'Escolha a tela…';

  const session = new HostSession({ iceServers: relay.servers, peerPrefix: PEER_PREFIX, settings });
  const started = session.start();
  // A partir daqui a captura já foi solicitada; o restante pode ser assíncrono.
  button.textContent = 'Abrindo sala…';

  started
    .then(() => enterLive(session))
    .catch((err) => {
      console.error('[app] falha ao iniciar transmissão', err);
      toast(describeStartError(err), 'error', 5000);
    })
    .finally(() => {
      host.starting = false;
      button.disabled = !isScreenCaptureSupported();
      button.textContent = 'Iniciar transmissão';
    });
}

function enterLive(session) {
  host.session = session;
  showView('host-live');
  $('#live-badge').hidden = false;

  const link = roomLink(session.roomId);
  $('#share-link').value = link;
  $('#room-code').textContent = session.roomId;
  document.title = `Ao vivo · sala ${session.roomId} · Discordo`;

  const preview = $('#host-preview');
  if (!preview.hidden) {
    preview.srcObject = session.stream;
    preview.play().catch(() => {});
  }

  const liveForm = $('#live-form');
  writeSettings(liveForm, session.settings);
  syncModeLabels(liveForm);
  renderViewerList(session);

  session.addEventListener('viewers', () => renderViewerList(session));
  session.addEventListener('viewer-stats', (event) => updateViewerItem(event.detail.link));
  session.addEventListener('stream', (event) => {
    if (!preview.hidden) preview.srcObject = event.detail.stream;
    toast('Fonte de captura trocada.', 'success');
    warnAboutAudio(session);
  });
  session.addEventListener('signaling', (event) => {
    if (event.detail.state === 'reconnecting') toast('A conexão com o servidor caiu. Quem já está assistindo continua; reconectando…', 'warn');
    else toast('Conexão com o servidor restabelecida.', 'success');
  });
  session.addEventListener('ended', (event) => leaveLive(event.detail.reason), { once: true });

  host.hud = new StatsHUD($('#host-hud'));
  setHostStatsVisible(storage.get('stats-visible', false));
  renderHostHud();
  host.hudTimer = setInterval(renderHostHud, 1000);
  warnAboutAudio(session);
}

function renderRelayStatus(status) {
  const el = $('#relay-status');
  const { tone, text } = describeRelay(status);
  el.dataset.tone = tone;
  el.textContent = text;
}

function setHostStatsVisible(visible) {
  host.hud.setVisible(visible);
  const button = $('#toggle-stats');
  button.textContent = visible ? 'Ocultar estatísticas' : 'Mostrar estatísticas';
  button.setAttribute('aria-pressed', String(visible));
}

function warnAboutAudio(session) {
  const { audioSource } = session.settings;
  const { surface, hasAudio } = session.summary();
  if (audioSource === 'none' || hasAudio) return;
  const message =
    audioSource === 'tab' && surface && surface !== 'browser'
      ? 'Sem áudio: no modo "Somente da guia" o som só vai junto ao compartilhar uma guia do navegador. Use "Trocar tela" e escolha uma guia.'
      : 'Transmitindo sem áudio. Use "Trocar tela" e marque a opção de compartilhar áudio no seletor.';
  toast(message, 'warn', 7000);
}

function leaveLive(reason) {
  clearInterval(host.hudTimer);
  host.hudTimer = null;
  host.session = null;
  host.hud = null;
  $('#host-preview').srcObject = null;
  $('#viewer-list').replaceChildren();
  $('#live-badge').hidden = true;
  document.title = 'Discordo · Compartilhar tela';
  showView('host-setup');
  toast(reason === 'capture-ended' ? 'A captura da tela foi interrompida. Transmissão encerrada.' : 'Transmissão encerrada.');
}

function renderHostHud() {
  const { session, hud } = host;
  if (!session || !hud) return;
  const summary = session.summary();
  hud.set('resolution', formatResolution(summary.width, summary.height));
  hud.set('fps', formatFps(summary.frameRate));
  hud.set('viewers', String(summary.viewers));
  hud.set('upload', formatMbps(summary.uploadBps));
  hud.set('audio', summary.hasAudio ? (summary.surface === 'browser' ? 'da guia' : 'do sistema') : 'sem áudio');
  if (summary.viewers === 0) hud.setHealth('idle', 'Sem espectadores');
  else hud.setHealth(summary.health);
}

function renderViewerList(session) {
  const list = $('#viewer-list');
  const viewers = session.viewers;
  $('#viewer-count').textContent = String(viewers.length);

  const ids = new Set(viewers.map((link) => link.id));
  list.querySelectorAll('.viewer').forEach((item) => {
    if (!ids.has(item.dataset.id)) item.remove();
  });

  for (const link of viewers) {
    let item = list.querySelector(`.viewer[data-id="${CSS.escape(link.id)}"]`);
    if (!item) {
      item = $('#viewer-item-template').content.firstElementChild.cloneNode(true);
      item.dataset.id = link.id;
      list.append(item);
    }
    updateViewerItem(link, item);
  }

  $('#viewer-empty').hidden = viewers.length > 0;
}

function updateViewerItem(link, item = $(`#viewer-list .viewer[data-id="${CSS.escape(link.id)}"]`)) {
  if (!item) return;
  const field = (name) => item.querySelector(`[data-field="${name}"]`);
  const snapshot = link.snapshot;
  const sample = snapshot?.sample;
  const connected = link.connectionState === 'connected';

  field('name').textContent = link.label;
  field('codec').textContent = sample?.codec && sample.codec !== '—' ? sample.codec : link.codec ?? '…';

  if (!connected || !sample?.ready) {
    item.dataset.health = 'idle';
    field('state').textContent = STATE_LABELS[link.connectionState] ?? 'Conectando…';
    field('bitrate').textContent = '—';
    field('resolution').textContent = '—';
    field('rtt').textContent = '—';
    field('loss').textContent = '—';
    item.style.setProperty('--fill', '0');
    return;
  }

  item.dataset.health = snapshot.health;
  const notes = [];
  if (snapshot.mode === 'manual') notes.push('manual');
  if (link.dataSaver) notes.push('economia de dados');
  if (snapshot.scale > 1) notes.push(`escala ÷${snapshot.scale}`);
  if (sample.qualityLimitation === 'cpu') notes.push('limitado por CPU');
  const base = snapshot.mode === 'manual' ? 'Bitrate fixo' : HEALTH_LABELS[snapshot.health];
  field('state').textContent = notes.length ? `${base} · ${notes.join(' · ')}` : base;

  field('bitrate').textContent = `${formatMbps(sample.videoBitrate)} / ${formatMbps(snapshot.targetBitrate)}`;
  field('resolution').textContent = `${formatResolution(sample.width, sample.height)} @ ${formatFps(sample.fps)}`;
  field('rtt').textContent = formatMs(sample.rttMs);
  field('loss').textContent = formatPercent(sample.lossRate);
  item.style.setProperty('--fill', String(Math.min(1, snapshot.targetBitrate / snapshot.maxBitrate)));
}

/* ----------------------------------------------------------------------------
 * Viewer
 * ------------------------------------------------------------------------- */

const canSetVolume = (() => {
  const probe = document.createElement('video');
  probe.volume = 0.5;
  return probe.volume === 0.5;
})();

function startViewer(room) {
  showView('viewer');
  document.title = `Sala ${room} · Discordo`;

  const stage = $('#viewer-stage');
  const video = $('#viewer-video');
  const unlock = $('#unlock-overlay');
  const muteButton = $('#btn-mute');
  const volume = $('#volume');
  const hudButton = $('#btn-hud');
  const pipButton = $('#btn-pip');
  const hud = new StatsHUD($('#viewer-hud'));

  $('#viewer-room').textContent = room;
  hud.setVisible(storage.get('stats-visible', false));
  hudButton.setAttribute('aria-pressed', String(hud.visible));

  const session = new ViewerSession({
    roomId: room,
    hostPeerId: PEER_PREFIX + room,
    iceServers: relay.servers,
    video,
  });

  session.setStatsEnabled(hud.visible);

  // Economia de dados: ligada por padrão no celular, já que boa parte usa 4G/5G.
  const saverButton = $('#btn-saver');
  const syncSaver = (enabled) => {
    saverButton.setAttribute('aria-pressed', String(enabled));
    saverButton.title = enabled ? 'Economia de dados: ligada' : 'Economia de dados: desligada';
  };
  let dataSaver = storage.get('data-saver', isMobileDevice() || navigator.connection?.saveData === true);
  session.setDataSaver(dataSaver);
  syncSaver(dataSaver);
  saverButton.addEventListener('click', () => {
    dataSaver = !dataSaver;
    session.setDataSaver(dataSaver);
    syncSaver(dataSaver);
    storage.set('data-saver', dataSaver);
    const mbps = DATA_SAVER_BITRATE / 1e6;
    toast(
      dataSaver
        ? `Economia de dados ligada: até ${mbps} Mbps (cerca de ${((DATA_SAVER_BITRATE * 3600) / 8 / 1e9).toFixed(1)} GB por hora).`
        : 'Economia de dados desligada: qualidade máxima.',
    );
  });

  // Credenciais renovadas entram nas conexões já abertas.
  relay.listeners.add(({ status, servers }) => {
    if (status.turn) session.setIceServers(servers);
  });
  let iceFailed = false;

  const syncMute = () => {
    const muted = video.muted;
    muteButton.dataset.muted = String(muted);
    muteButton.setAttribute('aria-label', muted ? 'Ativar som' : 'Silenciar');
    muteButton.title = muted ? 'Ativar som (M)' : 'Silenciar (M)';
  };

  session.addEventListener('status', (event) => {
    const { state, message, reason } = event.detail;
    if (reason === 'ice-failed') iceFailed = true;
    if (state === 'live' || state === 'ended') iceFailed = false;
    stage.dataset.state = state;
    $('#viewer-status').hidden = state === 'live';
    // Depois de uma falha de conexão de vídeo, mantém a explicação (ex.: 4G sem servidor de apoio) até conectar.
    $('#viewer-status-text').textContent = iceFailed ? connectionFailureHint(relay.status) : message;
    $('#viewer-retry').hidden = !(state === 'ended' || state === 'error');
    if (state === 'ended') unlock.hidden = true;
  });
  session.addEventListener('stats', (event) => hud.renderInbound(event.detail.sample, event.detail.health));
  session.addEventListener('autoplay-blocked', () => {
    unlock.hidden = false;
    syncMute();
  });
  session.addEventListener('audio-unlocked', () => {
    unlock.hidden = true;
    syncMute();
  });
  session.addEventListener('playing', () => {
    syncMute();
    requestWakeLock();
  });

  unlock.addEventListener('click', () => {
    session.unlockAudio().then((ok) => {
      if (ok) unlock.hidden = true;
      else toast('O navegador ainda bloqueou o som. Toque novamente.', 'warn');
      syncMute();
    });
  });

  $('#viewer-retry').addEventListener('click', () => session.retry());

  const toggleMute = () => {
    session.setMuted(!video.muted).then(() => {
      if (!video.muted) unlock.hidden = true;
      syncMute();
    });
  };
  muteButton.addEventListener('click', toggleMute);

  if (canSetVolume) {
    volume.value = String(storage.get('volume', 1));
    session.setVolume(Number(volume.value));
    volume.addEventListener('input', () => {
      session.setVolume(Number(volume.value));
      storage.set('volume', Number(volume.value));
      if (video.muted && Number(volume.value) > 0) toggleMute();
    });
  } else {
    volume.hidden = true;
  }

  const toggleHud = () => {
    hud.setVisible(!hud.visible);
    session.setStatsEnabled(hud.visible);
    hudButton.setAttribute('aria-pressed', String(hud.visible));
    storage.set('stats-visible', hud.visible);
  };
  hudButton.addEventListener('click', toggleHud);

  if (document.pictureInPictureEnabled && !video.disablePictureInPicture) {
    pipButton.hidden = false;
    pipButton.addEventListener('click', () => {
      const action = document.pictureInPictureElement
        ? document.exitPictureInPicture()
        : video.requestPictureInPicture();
      action.catch(() => toast('Picture-in-picture indisponível agora.', 'warn'));
    });
  }

  const toggleFullscreen = () => {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen ?? document.webkitExitFullscreen).call(document);
      return;
    }
    if (stage.requestFullscreen) {
      stage
        .requestFullscreen({ navigationUI: 'hide' })
        .then(() => screen.orientation?.lock?.('landscape').catch(() => {}))
        .catch(() => video.webkitEnterFullscreen?.());
    } else if (stage.webkitRequestFullscreen) {
      stage.webkitRequestFullscreen();
    } else if (video.webkitEnterFullscreen) {
      // iPhone: apenas o próprio <video> pode entrar em tela cheia.
      video.webkitEnterFullscreen();
    }
  };
  $('#btn-fullscreen').addEventListener('click', toggleFullscreen);
  video.addEventListener('dblclick', toggleFullscreen);

  // Controles somem após inatividade (modo cinema) e voltam com qualquer interação.
  let idleTimer = null;
  const wake = () => {
    stage.classList.remove('is-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stage.classList.add('is-idle'), CONTROLS_IDLE_MS);
  };
  stage.addEventListener('pointermove', wake);
  stage.addEventListener('pointerdown', wake);
  $('#viewer-controls').addEventListener('pointerenter', () => clearTimeout(idleTimer));
  wake();

  document.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'f') toggleFullscreen();
    else if (key === 'm') toggleMute();
    else if (key === 'h') toggleHud();
    else return;
    wake();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    session.resume();
    requestWakeLock();
  });

  window.addEventListener('pagehide', () => session.destroy());
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload();
  });

  syncMute();
  // O servidor de apoio precisa estar carregado antes de conectar; sem resposta em 4 s, segue só com STUN.
  loadRelay().then(() => {
    session.setIceServers(relay.servers);
    session.connect();
  });
  keepRelayFresh();
}

let wakeLock = null;
async function requestWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null;
  }
}

/* ----------------------------------------------------------------------------
 * Inicialização
 * ------------------------------------------------------------------------- */

function main() {
  if (typeof window.Peer !== 'function') {
    showView('fatal');
    return;
  }
  const room = sanitizeRoom(new URLSearchParams(location.search).get('room'));
  if (room) startViewer(room);
  else setupHost();
}

main();

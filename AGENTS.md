# AGENTS.md - Diretrizes para o Assistente de Código

## Visão Geral do Projeto
Aplicação web P2P (Peer-to-Peer) minimalista e de alta performance para compartilhamento de tela e áudio em tempo real entre amigos. O objetivo é permitir transmissões em **resolução nativa (1080p/1440p/4K) a 60 ou 120 FPS** com custo zero de hospedagem, adaptação automática às condições de rede e compatibilidade universal entre dispositivos (Desktop, Android e iOS/Safari).

## Stack Tecnológica
- **Frontend:** HTML5, CSS3 (Dark Mode / Theater Mode) e Vanilla JavaScript (ES6+ Modules).
- **Hospedagem:** Cloudflare Workers com Static Assets (site estático + um Worker mínimo em `worker/index.js` só para emitir credenciais TURN).
- **Comunicação P2P & Sinalização:** PeerJS (broker público gratuito, usado só como canal de sinalização) + STUN do Google/Cloudflare + TURN da Cloudflare Realtime via `/api/turn`, com bloqueio automático ao atingir 900 GB/mês (franquia gratuita: 1.000 GB).
- **APIs Nativas:** `navigator.mediaDevices.getDisplayMedia`, `RTCPeerConnection`, `RTCRtpTransceiver` e `RTCStatsReport`.

## Regras Críticas de Implementação (WebRTC High-Performance & Adaptativo)
A IA DEVE seguir estas regras rigorosamente ao escrever a lógica de transmissão:

1. **Destravamento e Adaptação Automática de Bitrate (ABR por Viewer):**
   - Por padrão, navegadores limitam o compartilhamento de tela a ~2 Mbps.
   - Implemente um controlador dinâmico via `RTCRtpSender.setParameters()` que inicie com um teto alto (ex: `20 Mbps`) e monitore `getStats()` a cada 2 segundos para CADA conexão individualmente.
   - Se detectar perda de pacotes (`packetsLost` crescendo > 2%) ou latência subindo (`currentRoundTripTime` > 150ms), reduza o `maxBitrate` gradualmente em degraus (sem nunca baixar de 2.5 Mbps). Quando a rede estabilizar sem perdas por 6 segundos, suba o bitrate gradualmente de volta até o teto máximo.

2. **Seleção Automática de Codec com Compatibilidade Universal (`setCodecPreferences`):**
   - Ofereça na UI do Host um seletor de Codec com a opção padrão **"Automático (Adaptativo Universal)"**, além de opções manuais (AV1, VP9, H.264).
   - No modo Automático, ordene a preferência de codecs no `RTCRtpTransceiver` priorizando eficiência e fallback universal nesta ordem: `video/VP9` -> `video/AV1` -> `video/H264` -> `video/VP8`.
   - Dessa forma, PCs modernos negociam VP9/AV1 (alta qualidade com menos banda), enquanto iPhones/iPads ou dispositivos antigos fazem fallback transparente para H.264 sem falhar a conexão.

3. **Proteção Absoluta de Áudio (`Audio Priority`):**
   - Na captura (`getDisplayMedia`), desative filtros de voz: `echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`.
   - No `RTCRtpSender` de áudio, configure `priority: 'high'` e `networkPriority: 'high'` (e aumente o bitrate de áudio Opus para ~128-256 kbps no SDP se possível) para garantir que, mesmo se a internet cair drasticamente, o som nunca picote enquanto o vídeo se ajusta.

4. **Otimização de Fluidez e Escalonamento (`contentHint` & `degradationPreference`):**
   - Defina `videoTrack.contentHint = "motion"` por padrão.
   - Configure `degradationPreference = "balanced"` (ou permita alternar para `"maintain-framerate"`). O modo `balanced` permite ao navegador reduzir levemente a resolução interna (`scaleResolutionDownBy`) se a rede ou a CPU do celular receptor não aguentar, mantendo os 60/120 FPS fluidos sem congelar a tela.

5. **Compatibilidade Mobile e Autoplay (iOS/Android):**
   - O elemento `<video>` do Viewer DEVE conter os atributos `playsinline`, `autoplay` e `webkit-playsinline` para não quebrar no Safari/iOS.
   - Trate rejeições da Promise `video.play()` exibindo um overlay amigável ("Toque para assistir com som") para destravar o contexto de áudio do navegador.
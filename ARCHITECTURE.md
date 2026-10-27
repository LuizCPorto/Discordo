# ARCHITECTURE.md - Especificação Técnica do Sistema

## 1. Arquitetura e Topologia de Rede
Topologia **Star centralizada no Host (1-para-N)** puramente client-side, onde cada conexão P2P possui seu próprio ciclo de adaptação de qualidade independente (se o Amigo A tiver internet ruim, apenas o stream do Amigo A reduz o bitrate/resolução; o Amigo B continua assistindo em 4K/120fps no talo).

---

## 2. Fluxo de Funcionamento

### Fluxo A: O Host (Transmissor)
1. **Painel de Configuração Inicial:**
   - **Modo de Qualidade:** `Automático Inteligente (Recomendado)` ou `Manual`.
   - **Resolução Máxima:** Nativa, 1440p ou 1080p.
   - **FPS Alvo:** 60 FPS ou 120 FPS.
   - **Codec Preferencial:** `Auto (VP9/H.264 Fallback)`, `AV1`, `VP9` ou `H.264 (Máxima Compatibilidade)`.
2. Ao clicar em **"Iniciar Transmissão"**, captura a tela via `getDisplayMedia` com áudio limpo e `contentHint = 'motion'`.
3. Para cada Viewer que se conecta:
   - Aplica a preferência de Codecs (`applyCodecPreferences`) antes de fechar a negociação SDP.
   - Inicia a conexão com o teto de bitrate escolhido (ex: 20 Mbps) e prioridade alta para o áudio.
   - Inicia uma instância do **AdaptiveBitrateController (ABR)** exclusiva para aquele `RTCPeerConnection`.

### Fluxo B: O Viewer (Qualquer Dispositivo: PC, Android, iOS)
1. Acessa o link `?room=ID_DA_SALA`.
2. Conecta ao Host via PeerJS recebendo o stream dentro de um `<video playsinline autoplay>`.
3. Exibe um HUD discreto (ocultável) mostrando:
   - Resolução Real Atual e FPS decodificado (ex: `1920x1080 @ 60fps`).
   - Codec ativo negociado pelo aparelho (ex: `VP9` no PC ou `H264` no iPhone).
   - Bitrate atual em Mbps e indicador de saúde da rede (Verde = Estável, Amarelo = Ajustando qualidade, Vermelho = Perda de pacotes).

---

## 3. Estrutura de Arquivos
```text
/
├── index.html            # Interface responsiva (Desktop/Mobile) com visão Host e Viewer
├── css/
│   └── style.css         # Dark/Theater Mode, responsivo para telas verticais e horizontais
├── js/
│   ├── app.js            # Roteamento (?room=...) e controle de eventos da UI
│   ├── webrtc-host.js    # Captura de tela, gerenciamento de peers e negociação de codecs
│   ├── abr-controller.js # Motor de ajuste automático de bitrate/resolução baseado na rede
│   ├── webrtc-viewer.js  # Player compatível com mobile/Safari e desbloqueio de áudio
│   └── stats.js          # Leitura de getStats() para o HUD e alimentação do motor ABR
├── worker/
│   └── index.js          # Serve os arquivos estáticos e emite credenciais TURN (/api/turn) com limite mensal
├── wrangler.jsonc        # Configuração do deploy no Cloudflare Workers
├── AGENTS.md
└── ARCHITECTURE.md
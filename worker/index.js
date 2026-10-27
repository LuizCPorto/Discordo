// Worker do Discordo: serve o site estático e emite credenciais TURN da Cloudflare (Realtime)
// com um limitador mensal de consumo, para nunca sair da franquia gratuita.
//
// Secrets necessários (Workers → discordo → Settings → Variables and Secrets, tipo "Secret"):
//   TURN_KEY_ID         ID da chave TURN (Realtime → TURN Server)
//   TURN_KEY_API_TOKEN  API token da chave TURN
//   CF_ACCOUNT_ID       ID da conta Cloudflare
//   CF_ANALYTICS_TOKEN  API token com permissão "Account Analytics: Read"
// Opcionais:
//   TURN_LIMIT_GB       Limite de bloqueio (padrão 900; a franquia gratuita é 1000 GB/mês)
//   TURN_BILLING_DAY    Dia em que o ciclo de cobrança da conta vira (padrão 1)

const DEFAULT_LIMIT_GB = 900;
const CREDENTIAL_TTL_SECONDS = 4 * 60 * 60;
const USAGE_CACHE_MS = 5 * 60 * 1000;
const GB = 1e9;

// Cache por isolate: evita consultar a API de analytics a cada entrada de espectador.
let usageCache = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/turn') return handleTurn(request, env);
    return env.ASSETS.fetch(request);
  },
};

async function handleTurn(request, env) {
  if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405);
  if (!isSameOrigin(request)) return json({ error: 'forbidden' }, 403);

  const limitGB = positiveNumber(env.TURN_LIMIT_GB, DEFAULT_LIMIT_GB);
  const period = billingPeriod(new Date(), positiveNumber(env.TURN_BILLING_DAY, 1));
  const base = { limitGB, resetsAt: period.end.toISOString() };

  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return json({ ...base, turn: false, reason: 'not-configured' });

  let usedBytes;
  try {
    usedBytes = await monthlyEgressBytes(env, period);
  } catch (err) {
    // Sem saber o consumo, não arrisca cobrança: o TURN fica desligado até a consulta voltar a funcionar.
    console.error('Falha ao consultar o consumo do TURN', err);
    return json({ ...base, turn: false, reason: 'usage-unknown' });
  }

  const usedGB = round(usedBytes / GB);
  if (usedBytes >= limitGB * GB) return json({ ...base, usedGB, turn: false, reason: 'limit' });

  try {
    const iceServers = await generateIceServers(env);
    return json({ ...base, usedGB, turn: true, ttl: CREDENTIAL_TTL_SECONDS, iceServers });
  } catch (err) {
    console.error('Falha ao gerar credenciais TURN', err);
    return json({ ...base, usedGB, turn: false, reason: 'credentials-failed' });
  }
}

async function generateIceServers(env) {
  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: CREDENTIAL_TTL_SECONDS }),
    },
  );
  if (!response.ok) throw new Error(`generate-ice-servers HTTP ${response.status}`);
  const { iceServers } = await response.json();
  // A porta alternativa 53 é bloqueada pelos navegadores e só atrasaria a conexão.
  return iceServers.map((server) => ({
    ...server,
    urls: [].concat(server.urls).filter((url) => !/:53(\?|$)/.test(url)),
  }));
}

async function monthlyEgressBytes(env, period) {
  const key = period.start.toISOString();
  if (usageCache?.key === key && Date.now() - usageCache.at < USAGE_CACHE_MS) return usageCache.bytes;

  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) throw new Error('CF_ACCOUNT_ID/CF_ANALYTICS_TOKEN ausentes');
  const account = String(env.CF_ACCOUNT_ID).replace(/[^a-f0-9]/gi, '');
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${account}" }) {
        callsTurnUsageAdaptiveGroups(
          limit: 1
          filter: { datetimeMinute_geq: "${period.start.toISOString()}", datetimeMinute_lt: "${new Date().toISOString()}" }
        ) {
          sum { egressBytes }
        }
      }
    }
  }`;

  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) throw new Error(`GraphQL HTTP ${response.status}`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);

  const groups = body.data?.viewer?.accounts?.[0]?.callsTurnUsageAdaptiveGroups ?? [];
  const bytes = groups.reduce((total, group) => total + (group.sum?.egressBytes ?? 0), 0);
  usageCache = { key, at: Date.now(), bytes };
  return bytes;
}

/** Ciclo atual de cobrança: do último "dia de virada" (UTC) até o próximo. */
function billingPeriod(now, billingDay) {
  const day = Math.min(28, Math.max(1, Math.floor(billingDay)));
  let start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day));
  if (start > now) start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, day));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, day));
  return { start, end };
}

// Barreira simples contra uso das credenciais por outros sites (não substitui o limitador de consumo).
function isSameOrigin(request) {
  const site = request.headers.get('Sec-Fetch-Site');
  if (site) return site === 'same-origin';
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

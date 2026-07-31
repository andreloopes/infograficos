// coleta.mjs — coletor do agregador de pesquisas (ExameLab) · v3
// Node 18+ (fetch nativo, zero dependências). Roda pela GitHub Action.
//
// ESTRATÉGIA EM DOIS ESTÁGIOS:
//  A) 1º TURNO (preferido): Eleição em Dados (E²D). Como a API deles não tem
//     documentação aberta, o coletor DESCOBRE o endereço sozinho: baixa a
//     página do agregador, extrai URLs da API de dentro do HTML/JS, testa cada
//     uma e usa a primeira que devolver dados de candidatos. Também tenta ler
//     dados embutidos no próprio HTML (a página é renderizada no servidor).
//  B) FALLBACK (2º turno): Agregador 2026 (Filtro de Kalman) de Joaquim
//     Bermudes, via arquivo público no GitHub — fonte já testada e estável.
//
// Seja qual for o estágio que funcionar, a saída tem o MESMO formato e a página
// se adapta (ranking multi-candidato ou cabeça a cabeça).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DADOS = join(ROOT, "dados");

const E2D_PAGE = "https://eleicaoemdados.com.br/agregador";
const E2D_HOST = "api-core-4p7x5p4kza-rj.a.run.app";
const E2D_GUESSES = [
  `https://${E2D_HOST}/api/agregador`,
  `https://${E2D_HOST}/api/v1/agregador`,
  `https://${E2D_HOST}/api/agregado`,
  `https://${E2D_HOST}/api/v1/agregado`,
  `https://${E2D_HOST}/api/aggregate`,
  `https://${E2D_HOST}/api/pesquisas/agregado`,
];
const KALMAN_RAW = "https://raw.githubusercontent.com/joaquimbermudes/Agregador_2026/main";

const hoje = () => new Date().toISOString().slice(0, 10);
const num = (v) => { const n = Number(String(v ?? "").replace("%","").replace(",", ".")); return Number.isFinite(n) ? n : NaN; };
const pct1 = (x) => Math.round(Number(x) * 1000) / 10;
const r1 = (x) => Math.round(Number(x) * 10) / 10;

async function tryFetch(url, asJson = true, timeoutMs = 15000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, { headers: { accept: asJson ? "application/json" : "*/*", "user-agent": "ExameLab-agregador/1.0 (uso editorial; contato via exame.com)" }, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, body: asJson ? await r.json().catch(() => null) : await r.text() };
  } catch (e) { return { ok: false, err: e.message }; }
}

/* ---------- ESTÁGIO A: E²D (1º turno) ---------- */

// procura, em qualquer JSON, um array de objetos que pareça "lista de candidatos"
function findCandidateArray(node, depth = 0) {
  if (depth > 6 || node == null) return null;
  if (Array.isArray(node)) {
    const ok = node.length >= 3 && node.filter((it) => {
      if (!it || typeof it !== "object") return false;
      const keys = Object.keys(it).map((k) => k.toLowerCase());
      const hasName = keys.some((k) => ["nome","candidato","name","candidate"].includes(k));
      const hasVal = keys.some((k) => ["media","mean","valor","estimativa","pct","percentual","value"].includes(k));
      return hasName && hasVal;
    }).length >= 3;
    if (ok) return node;
    for (const it of node) { const f = findCandidateArray(it, depth + 1); if (f) return f; }
    return null;
  }
  if (typeof node === "object") {
    for (const v of Object.values(node)) { const f = findCandidateArray(v, depth + 1); if (f) return f; }
  }
  return null;
}

function low(o){ const m={}; for(const[k,v] of Object.entries(o)) m[k.toLowerCase()]=v; return m; }

function mapE2D(rawArr, rawRoot) {
  const cands = rawArr.map((c0) => {
    const c = low(c0);
    const media = num(c.media ?? c.mean ?? c.valor ?? c.estimativa ?? c.pct ?? c.percentual ?? c.value);
    return {
      nome: String(c.nome ?? c.candidato ?? c.name ?? c.candidate ?? "").trim(),
      partido: String(c.partido ?? c.party ?? "").trim(),
      media: r1(media),
      ic_min: r1(num(c.ic_min ?? c.ci_low ?? c.lower ?? c.ic95_lo) || Math.max(0, media - 4)),
      ic_max: r1(num(c.ic_max ?? c.ci_high ?? c.upper ?? c.ic95_hi) || media + 4),
      tendencia_14d: 0,
    };
  }).filter((c) => c.nome && Number.isFinite(c.media) && c.media > 0)
    .sort((a, b) => b.media - a.media);
  if (cands.length < 3) return null;
  const root = rawRoot && typeof rawRoot === "object" ? low(rawRoot) : {};
  return {
    cenario: "1º turno · Brasil (nacional)",
    metodologia: "Média ponderada por recência e amostra (E²D)",
    corte: String(root.corte ?? root.cutoff ?? hoje()).slice(0, 10),
    indecisos: r1(num(root.indecisos ?? root.undecided) || 0) || null,
    fonte: "Eleição em Dados (E²D) — média ponderada de pesquisas registradas no TSE",
    fonte_url: "https://eleicaoemdados.com.br/agregador",
    candidatos: cands,
    prob_vitoria: null,
    ultima_pesquisa: null,
    ultimas_pesquisas: [],
  };
}

async function stageA(log) {
  // 1) baixa a página e garimpa endereços de API + JSON embutido
  const page = await tryFetch(E2D_PAGE, false);
  const urls = new Set(E2D_GUESSES);
  if (page.ok && typeof page.body === "string") {
    const html = page.body;
    // URLs completas da API citadas no HTML/JS inline
    for (const m of html.matchAll(new RegExp(`https://${E2D_HOST.replace(/[.-]/g,"\\$&")}[^"'\\s\\\\<>)]*`, "g"))) urls.add(m[0]);
    // caminhos relativos /api/... dentro de scripts
    for (const m of html.matchAll(/["'](\/api\/[a-zA-Z0-9/_\-?&=.]{2,80})["']/g)) urls.add(`https://${E2D_HOST}${m[1]}`);
    // JSON embutido (SSR): __NEXT_DATA__ ou <script type="application/json">
    for (const m of html.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/g)) {
      try {
        const j = JSON.parse(m[1]);
        const arr = findCandidateArray(j);
        if (arr) { log(`E²D: dados embutidos no HTML (${arr.length} candidatos)`); const ag = mapE2D(arr, j); if (ag) return ag; }
      } catch {}
    }
    // scripts externos do próprio site — garimpa a API neles também (máx 8)
    const srcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1])
      .map((s) => s.startsWith("http") ? s : `https://eleicaoemdados.com.br${s.startsWith("/") ? "" : "/"}${s}`)
      .filter((s) => s.includes("eleicaoemdados")).slice(0, 8);
    for (const s of srcs) {
      const js = await tryFetch(s, false, 10000);
      if (js.ok && typeof js.body === "string") {
        for (const m of js.body.matchAll(new RegExp(`https://${E2D_HOST.replace(/[.-]/g,"\\$&")}[^"'\\s\\\\<>)]*`, "g"))) urls.add(m[0]);
        for (const m of js.body.matchAll(/["'](\/api\/[a-zA-Z0-9/_\-?&=.]{2,80})["']/g)) urls.add(`https://${E2D_HOST}${m[1]}`);
      }
    }
  } else {
    log(`E²D: página inacessível (${page.status || page.err}) — tentando endereços conhecidos`);
  }

  // 2) testa cada endereço candidato
  const lista = [...urls].filter((u) => !u.includes("/docs")).slice(0, 25);
  log(`E²D: testando ${lista.length} endereço(s) de API…`);
  for (const u of lista) {
    const r = await tryFetch(u, true, 12000);
    if (r.ok && r.body) {
      const arr = findCandidateArray(r.body);
      if (arr) { log(`E²D: FUNCIONOU → ${u} (${arr.length} candidatos)`); const ag = mapE2D(arr, r.body); if (ag) return ag; }
    }
  }
  log("E²D: nenhum endereço devolveu dados de candidatos.");
  return null;
}

/* ---------- ESTÁGIO B: fallback Kalman (2º turno, testado) ---------- */

async function stageB(log) {
  const [k, snap] = await Promise.all([
    tryFetch(`${KALMAN_RAW}/kalman_filtro_resultados.json`),
    tryFetch(`${KALMAN_RAW}/snapshot_pesquisas.json`),
  ]);
  if (!k.ok || !k.body) throw new Error("fallback Kalman também falhou: " + (k.status || k.err));
  const kb = k.body;
  const corte = String(kb.data_ultima_pesquisa || hoje()).slice(0, 10);
  const cand = (nome, partido, o) => ({ nome, partido, media: pct1(o.estimativa), ic_min: pct1(o.ic95_lo), ic_max: pct1(o.ic95_hi), tendencia_14d: 0 });
  const pesquisas = Object.values(snap.ok && snap.body ? (snap.body.records || {}) : {}).slice(0, 6).map((p) => ({
    instituto: p["Contratante"] || "—",
    coleta_label: p["Data(s) de Pesquisa"] || "",
    amostra: parseInt(String(p["Tamanho da Amostra"]).replace(/\D/g, ""), 10) || 0,
    detalhe: `Lula ${p["Lula (PT) %"]}% × Flávio ${p["Flávio (PL) %"]}%`,
  }));
  log("Fallback Kalman: OK");
  return {
    cenario: "2º turno · Lula × Flávio",
    metodologia: "Filtro de Kalman sobre pesquisas registradas",
    corte,
    indecisos: null,
    fonte: "Agregador 2026 (Filtro de Kalman) — Joaquim Bermudes, a partir de pesquisas registradas no TSE",
    fonte_url: "https://joaquimbermudes.github.io/Agregador_2026/",
    candidatos: [cand("Lula", "PT", kb.intencao_voto_lula), cand("Flávio Bolsonaro", "PL", kb.intencao_voto_flavio)],
    prob_vitoria: { "Lula": pct1(kb.probabilidade_vitoria?.lula_acima_50pct ?? 0), "Flávio Bolsonaro": pct1(kb.probabilidade_vitoria?.flavio_acima_50pct ?? 0) },
    ultima_pesquisa: `${kb.instituto_ultima_pesquisa || "—"} (${corte.split("-").reverse().join("/")})`,
    ultimas_pesquisas: pesquisas,
  };
}

/* ---------- série histórica + tendência ---------- */

function atualizaHistorico(ag) {
  const hp = join(DADOS, "historico.json");
  const hist = existsSync(hp) ? JSON.parse(readFileSync(hp, "utf8")) : { pontos: [] };
  hist.pontos = (hist.pontos || []).map((p) => ({ cenario: p.cenario || "2º turno · Lula × Flávio", ...p }));
  const valores = {};
  ag.candidatos.slice(0, 3).forEach((c) => { valores[c.nome] = c.media; });
  const idx = hist.pontos.findIndex((p) => p.data === ag.corte && p.cenario === ag.cenario);
  if (idx >= 0) hist.pontos[idx].valores = valores;
  else hist.pontos.push({ data: ag.corte, cenario: ag.cenario, valores });
  hist.pontos.sort((a, b) => a.data.localeCompare(b.data));

  const doCenario = hist.pontos.filter((p) => p.cenario === ag.cenario);
  const alvo = new Date(new Date(ag.corte).getTime() - 14 * 864e5).toISOString().slice(0, 10);
  for (const c of ag.candidatos) {
    const antes = doCenario.filter((p) => p.data <= alvo && p.valores[c.nome] != null);
    c.tendencia_14d = antes.length ? r1(c.media - antes[antes.length - 1].valores[c.nome]) : 0;
  }
  writeFileSync(hp, JSON.stringify(hist, null, 2) + "\n");
  return doCenario.length;
}

/* ---------- main ---------- */

async function main() {
  const logs = [];
  const log = (s) => { logs.push(s); console.log(s); };

  let ag = null;
  try { ag = await stageA(log); } catch (e) { log("E²D: erro — " + e.message); }
  if (!ag) ag = await stageB(log);

  ag.atualizado_em = hoje();
  const nPontos = atualizaHistorico(ag);

  writeFileSync(join(DADOS, "agregado.json"), JSON.stringify(ag, null, 2) + "\n");
  writeFileSync(join(DADOS, "_status.json"), JSON.stringify({
    ultima_execucao: new Date().toISOString(), cenario: ag.cenario, corte: ag.corte,
    candidatos: ag.candidatos.length, pontos_na_serie: nPontos, log: logs,
  }, null, 2) + "\n");

  console.log(`OK — ${ag.cenario} · ${ag.candidatos.slice(0,2).map((c) => `${c.nome} ${c.media}%`).join(" × ")} · corte ${ag.corte} · ${nPontos} ponto(s) na série.`);
}

main().catch((e) => { console.error("FALHA:", e.message); process.exit(1); });

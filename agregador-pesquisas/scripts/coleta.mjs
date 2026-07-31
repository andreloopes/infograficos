// coleta.mjs — coletor do agregador de pesquisas (ExameLab) · v4 "CNN-like"
// Node 18+ (fetch nativo, zero dependências). Roda pela GitHub Action.
//
// TRÊS SEÇÕES, cada uma com seu arquivo em dados/:
//   1) PRESIDENTE  -> dados/agregado.json
//      A: 1º turno via E²D (autodescoberta de endpoint/JSON embutido)
//      B: fallback testado — Agregador 2026 (Kalman, J. Bermudes), 2º turno
//   2) APROVAÇÃO   -> dados/aprovacao.json
//      Garimpa a lista de pesquisas do E²D, entra nas fichas de "Aprovação do
//      governo" e extrai aprova/desaprova. Média simples das últimas N
//      (rotulada como tal — transparência editorial).
//   3) GOVERNADORES -> dados/governadores.json
//      Lista as pesquisas estaduais mais recentes do E²D (metadados + link).
//
// Se uma seção falhar, as outras seguem — e a página mostra "aguardando".

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DADOS = join(ROOT, "dados");

const E2D = "https://eleicaoemdados.com.br";
const E2D_HOST = "api-core-4p7x5p4kza-rj.a.run.app";
const E2D_GUESSES = [
  `https://${E2D_HOST}/api/agregador`, `https://${E2D_HOST}/api/v1/agregador`,
  `https://${E2D_HOST}/api/agregado`,  `https://${E2D_HOST}/api/v1/agregado`,
  `https://${E2D_HOST}/api/aggregate`, `https://${E2D_HOST}/api/pesquisas/agregado`,
];
const KALMAN_RAW = "https://raw.githubusercontent.com/joaquimbermudes/Agregador_2026/main";
const UFS = ["Acre","Alagoas","Amapá","Amazonas","Bahia","Ceará","Distrito Federal","Espírito Santo","Goiás","Maranhão","Mato Grosso","Mato Grosso do Sul","Minas Gerais","Pará","Paraíba","Paraná","Pernambuco","Piauí","Rio de Janeiro","Rio Grande do Norte","Rio Grande do Sul","Rondônia","Roraima","Santa Catarina","São Paulo","Sergipe","Tocantins"];

const hoje = () => new Date().toISOString().slice(0, 10);
const num = (v) => { const n = Number(String(v ?? "").replace("%","").replace(",", ".")); return Number.isFinite(n) ? n : NaN; };
const pct1 = (x) => Math.round(Number(x) * 1000) / 10;
const r1 = (x) => Math.round(Number(x) * 10) / 10;
const stripTags = (h) => String(h)
  .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

async function tryFetch(url, asJson = true, timeoutMs = 15000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, { headers: { accept: asJson ? "application/json" : "*/*", "user-agent": "ExameLab-agregador/1.0 (uso editorial)" }, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, body: asJson ? await r.json().catch(() => null) : await r.text() };
  } catch (e) { return { ok: false, err: e.message }; }
}

/* ================= SEÇÃO 1 — PRESIDENTE ================= */

function findCandidateArray(node, depth = 0) {
  if (depth > 6 || node == null) return null;
  if (Array.isArray(node)) {
    const ok = node.length >= 3 && node.filter((it) => {
      if (!it || typeof it !== "object") return false;
      const keys = Object.keys(it).map((k) => k.toLowerCase());
      return keys.some((k) => ["nome","candidato","name","candidate"].includes(k))
          && keys.some((k) => ["media","mean","valor","estimativa","pct","percentual","value"].includes(k));
    }).length >= 3;
    if (ok) return node;
    for (const it of node) { const f = findCandidateArray(it, depth + 1); if (f) return f; }
    return null;
  }
  if (typeof node === "object")
    for (const v of Object.values(node)) { const f = findCandidateArray(v, depth + 1); if (f) return f; }
  return null;
}
const low = (o) => { const m = {}; for (const [k, v] of Object.entries(o)) m[k.toLowerCase()] = v; return m; };

function mapE2D(rawArr, rawRoot) {
  const cands = rawArr.map((c0) => {
    const c = low(c0);
    const media = num(c.media ?? c.mean ?? c.valor ?? c.estimativa ?? c.pct ?? c.percentual ?? c.value);
    return { nome: String(c.nome ?? c.candidato ?? c.name ?? c.candidate ?? "").trim(),
      partido: String(c.partido ?? c.party ?? "").trim(), media: r1(media),
      ic_min: r1(num(c.ic_min ?? c.ci_low ?? c.lower ?? c.ic95_lo) || Math.max(0, media - 4)),
      ic_max: r1(num(c.ic_max ?? c.ci_high ?? c.upper ?? c.ic95_hi) || media + 4), tendencia_14d: 0 };
  }).filter((c) => c.nome && Number.isFinite(c.media) && c.media > 0).sort((a, b) => b.media - a.media);
  if (cands.length < 3) return null;
  const root = rawRoot && typeof rawRoot === "object" ? low(rawRoot) : {};
  return { cenario: "1º turno · Brasil (nacional)", metodologia: "Média ponderada por recência e amostra (E²D)",
    corte: String(root.corte ?? root.cutoff ?? hoje()).slice(0, 10),
    indecisos: r1(num(root.indecisos ?? root.undecided) || 0) || null,
    fonte: "Eleição em Dados (E²D) — média ponderada de pesquisas registradas no TSE",
    fonte_url: `${E2D}/agregador`, candidatos: cands, prob_vitoria: null, ultima_pesquisa: null, ultimas_pesquisas: [] };
}


function presidenteA2(html, log) {
  // Plano C: a página /agregador vem renderizada no servidor — a tabela do
  // agregado está no TEXTO. Extraímos linhas "Nome 40.1% 34.7 – 46.0%".
  const txt = stripTags(html);
  const rows = [];
  const re = /([A-ZÀ-Ú][A-Za-zÀ-ú. ]{1,28}?)\s+(\d{1,2}(?:[.,]\d)?)\s*%\s+(\d{1,2}(?:[.,]\d)?)\s*[–—-]\s*(\d{1,2}(?:[.,]\d)?)\s*%/g;
  let m;
  while ((m = re.exec(txt)) && rows.length < 20) {
    const nome = m[1].trim().replace(/\s+/g, " ");
    if (/cen[áa]rio|lidera|top|m[ée]dia|ic 9|amostra|coleta|indecis/i.test(nome)) continue;
    rows.push({ nome, media: num(m[2]), ic_min: num(m[3]), ic_max: num(m[4]) });
  }
  const seen = new Set();
  const cands = rows.filter((r) => Number.isFinite(r.media) && r.media > 0 && !seen.has(r.nome) && seen.add(r.nome))
    .map((r) => ({ ...r, partido: "", tendencia_14d: 0 }));
  if (cands.length < 3) { log(`Presidente/E²D(A2): só ${cands.length} linha(s) de tabela no texto.`); return null; }
  const soma = cands.reduce((s, c) => s + c.media, 0);
  if (soma < 20 || soma > 115) { log(`Presidente/E²D(A2): soma implausível (${r1(soma)}).`); return null; }
  cands.sort((a, b) => b.media - a.media);
  const ind = (txt.match(/Indecisos\s+(\d{1,2}(?:[.,]\d)?)\s*%/i) || [])[1];
  const corteBr = (txt.match(/corte em (\d{2})\/(\d{2})\/(\d{4})/i) || []);
  const corte = corteBr.length ? `${corteBr[3]}-${corteBr[2]}-${corteBr[1]}` : hoje();
  log(`Presidente/E²D(A2): FUNCIONOU — tabela SSR com ${cands.length} candidatos.`);
  return { cenario: "1º turno · Brasil (nacional)", metodologia: "Média ponderada por recência e amostra (E²D)",
    corte, indecisos: ind ? num(ind) : null,
    fonte: "Eleição em Dados (E²D) — média ponderada de pesquisas registradas no TSE",
    fonte_url: `${E2D}/agregador`, candidatos: cands, prob_vitoria: null, ultima_pesquisa: null, ultimas_pesquisas: [] };
}

async function presidenteA(log, pageCache) {
  const page = pageCache.agregador ?? (pageCache.agregador = await tryFetch(`${E2D}/agregador`, false));
  const urls = new Set(E2D_GUESSES);
  if (page.ok && typeof page.body === "string") {
    const html = page.body;
    for (const m of html.matchAll(new RegExp(`https://${E2D_HOST.replace(/[.-]/g, "\\$&")}[^"'\\s\\\\<>)]*`, "g"))) urls.add(m[0]);
    for (const m of html.matchAll(/["'](\/api\/[a-zA-Z0-9/_\-?&=.]{2,80})["']/g)) urls.add(`https://${E2D_HOST}${m[1]}`);
    for (const m of html.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/g)) {
      try { const j = JSON.parse(m[1]); const arr = findCandidateArray(j);
        if (arr) { log(`Presidente/E²D: dados embutidos no HTML (${arr.length} candidatos)`); const ag = mapE2D(arr, j); if (ag) return ag; } } catch {}
    }
    const srcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1])
      .map((s) => s.startsWith("http") ? s : `${E2D}${s.startsWith("/") ? "" : "/"}${s}`)
      .filter((s) => s.includes("eleicaoemdados")).slice(0, 8);
    for (const s of srcs) {
      const js = await tryFetch(s, false, 10000);
      if (js.ok && typeof js.body === "string") {
        for (const m of js.body.matchAll(new RegExp(`https://${E2D_HOST.replace(/[.-]/g, "\\$&")}[^"'\\s\\\\<>)]*`, "g"))) urls.add(m[0]);
        for (const m of js.body.matchAll(/["'](\/api\/[a-zA-Z0-9/_\-?&=.]{2,80})["']/g)) urls.add(`https://${E2D_HOST}${m[1]}`);
      }
    }
  } else log(`Presidente/E²D: página inacessível (${page.status || page.err})`);
  const lista = [...urls].filter((u) => !u.includes("/docs")).slice(0, 25);
  log(`Presidente/E²D: testando ${lista.length} endereço(s)…`);
  for (const u of lista) {
    const r = await tryFetch(u, true, 12000);
    if (r.ok && r.body) { const arr = findCandidateArray(r.body);
      if (arr) { log(`Presidente/E²D: FUNCIONOU → ${u}`); const ag = mapE2D(arr, r.body); if (ag) return ag; } }
  }
  if (page.ok && typeof page.body === "string") {
    const a2 = presidenteA2(page.body, log);
    if (a2) return a2;
  }
  log("Presidente/E²D: sem dados — usando fallback Kalman.");
  return null;
}

async function presidenteB(log) {
  const [k, snap] = await Promise.all([
    tryFetch(`${KALMAN_RAW}/kalman_filtro_resultados.json`), tryFetch(`${KALMAN_RAW}/snapshot_pesquisas.json`)]);
  if (!k.ok || !k.body) throw new Error("fallback Kalman falhou: " + (k.status || k.err));
  const kb = k.body, corte = String(kb.data_ultima_pesquisa || hoje()).slice(0, 10);
  const cand = (nome, partido, o) => ({ nome, partido, media: pct1(o.estimativa), ic_min: pct1(o.ic95_lo), ic_max: pct1(o.ic95_hi), tendencia_14d: 0 });
  const pesquisas = Object.values(snap.ok && snap.body ? (snap.body.records || {}) : {}).slice(0, 6).map((p) => ({
    instituto: p["Contratante"] || "—", coleta_label: p["Data(s) de Pesquisa"] || "",
    amostra: parseInt(String(p["Tamanho da Amostra"]).replace(/\D/g, ""), 10) || 0,
    detalhe: `Lula ${p["Lula (PT) %"]}% × Flávio ${p["Flávio (PL) %"]}%` }));
  log("Presidente: fallback Kalman OK");
  return { cenario: "2º turno · Lula × Flávio", metodologia: "Filtro de Kalman sobre pesquisas registradas", corte,
    indecisos: null,
    fonte: "Agregador 2026 (Filtro de Kalman) — Joaquim Bermudes, a partir de pesquisas registradas no TSE",
    fonte_url: "https://joaquimbermudes.github.io/Agregador_2026/",
    candidatos: [cand("Lula", "PT", kb.intencao_voto_lula), cand("Flávio Bolsonaro", "PL", kb.intencao_voto_flavio)],
    prob_vitoria: { "Lula": pct1(kb.probabilidade_vitoria?.lula_acima_50pct ?? 0), "Flávio Bolsonaro": pct1(kb.probabilidade_vitoria?.flavio_acima_50pct ?? 0) },
    ultima_pesquisa: `${kb.instituto_ultima_pesquisa || "—"} (${corte.split("-").reverse().join("/")})`,
    ultimas_pesquisas: pesquisas };
}

/* ============ varredura de fichas do E²D (alimenta seções 2 e 3) ============ */

const SIGLA2UF = { AC:"Acre",AL:"Alagoas",AP:"Amapá",AM:"Amazonas",BA:"Bahia",CE:"Ceará",DF:"Distrito Federal",
  ES:"Espírito Santo",GO:"Goiás",MA:"Maranhão",MT:"Mato Grosso",MS:"Mato Grosso do Sul",MG:"Minas Gerais",
  PA:"Pará",PB:"Paraíba",PR:"Paraná",PE:"Pernambuco",PI:"Piauí",RJ:"Rio de Janeiro",RN:"Rio Grande do Norte",
  RS:"Rio Grande do Sul",RO:"Rondônia",RR:"Roraima",SC:"Santa Catarina",SP:"São Paulo",SE:"Sergipe",TO:"Tocantins" };

// procura, em qualquer JSON, um array de {rótulo, pct} — serve p/ candidatos E opções de aprovação
function acharResultados(node, depth = 0) {
  if (depth > 6 || node == null) return null;
  if (Array.isArray(node)) {
    const mapped = node.map((it) => {
      if (!it || typeof it !== "object") return null;
      const c = low(it);
      const label = c.nome ?? c.candidato ?? c.opcao ?? c["opção"] ?? c.resposta ?? c.option ?? c.label ?? c.name;
      const pct = num(c.percentual ?? c.pct ?? c.valor ?? c.value ?? c.resultado ?? c.media ?? c.mean);
      return label != null && Number.isFinite(pct) ? { label: String(label).trim(), pct } : null;
    }).filter(Boolean);
    if (mapped.length >= 2) return mapped;
    for (const it of node) { const f = acharResultados(it, depth + 1); if (f) return f; }
    return null;
  }
  if (typeof node === "object")
    for (const v of Object.values(node)) { const f = acharResultados(v, depth + 1); if (f) return f; }
  return null;
}

const acha = (res, rx) => res && res.find((r) => rx.test(r.label));
const somaOpc = (res, rxs) => rxs.map((rx) => acha(res, rx)).filter(Boolean).reduce((s, r) => s + r.pct, 0) || null;
const topCands = (res, n) => (res || []).filter((r) => !/branco|nulo|indecis|n[ãa]o sabe|nenhum|outros|n[ãa]o respond/i.test(r.label))
  .sort((a, b) => b.pct - a.pct).slice(0, n);

async function varreduraFichas(log, pageCache) {
  if (pageCache.fichas) return pageCache.fichas;
  const fontes = [];
  for (const path of ["/", "/pesquisas"]) {
    const p = await tryFetch(`${E2D}${path}`, false);
    if (p.ok && typeof p.body === "string") fontes.push({ path, html: p.body });
    else log(`Fichas/E²D: ${path} inacessível (${p.status || p.err}).`);
  }
  const ids = [...new Set(fontes.flatMap((f) => [...f.html.matchAll(/\/pesquisas\/(\d+)/g)].map((m) => m[1])))];
  log(`Fichas/E²D: ${ids.length} ficha(s) com link.`);
  const aprov = [], gov = [], nac = [];
  let telemetria = null;
  for (const id of ids.slice(0, 14)) {
    if (aprov.length >= 5 && gov.length >= 8 && nac.length >= 6) break;
    const det = await tryFetch(`${E2D}/pesquisas/${id}`, false, 10000);
    if (!det.ok) continue;
    const t = stripTags(det.body);
    if (!telemetria) telemetria = t.slice(0, 240);
    const coleta = (t.match(/(?:Coleta(?:\s+em)?|[–—-])\s+(\d{2}\/\d{2}\/\d{4})/) || [])[1] || "";
    const amostra = (t.match(/Amostra\s*:?\s*([\d.\s]+)/i) || [])[1];
    const tse = (t.match(/TSE\s+([A-Z]{2}-\d+\/\d{4})/) || [])[1] || "";
    const inst = (t.match(/Pesquisa\s+(.{2,50}?)\s+[–—-]\s+\d{2}\/\d{2}\/\d{4}/) || [])[1]
      || (t.match(/([A-ZÀ-Ú][\wÀ-ú&.\/-]*(?:\s+[A-ZÀ-Ú&][\wÀ-ú&.\/-]*){0,4})\s*(?:—|·)\s*\d{2}\/\d{2}\/\d{4}/) || [])[1] || "—";
    // escopo: "· Brasil (nacional) · BR" ou "· São Paulo · SP"
    const sc = t.match(/·\s*([A-Za-zÀ-ú()\s]+?)\s*·\s*([A-Z]{2})\b/);
    const sigla = sc ? sc[2] : null;
    const estado = sigla && sigla !== "BR" ? (SIGLA2UF[sigla] || sc[1].trim()) : null;
    // dado estruturado: link "JSON" do botão Exportar Dados
    let res = null;
    const jl = [...det.body.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>\s*JSON\s*<\/a>/gi)][0];
    if (jl) {
      const jurl = jl[1].startsWith("http") ? jl[1] : `${E2D}${jl[1].startsWith("/") ? "" : "/"}${jl[1]}`;
      const j = await tryFetch(jurl, true, 10000);
      if (j.ok && j.body) {
        res = acharResultados(j.body);
        if (!res) log(`Fichas/E²D: JSON da ficha ${id} sem resultados mapeáveis (chaves: ${Object.keys(j.body).slice(0, 8).join(",")}).`);
      } else log(`Fichas/E²D: export JSON da ficha ${id} falhou (${j.status || j.err}).`);
    }
    const base = { instituto: inst.trim(), coleta, tse,
      amostra: amostra ? parseInt(amostra.replace(/\D/g, ""), 10) : 0, url: `${E2D}/pesquisas/${id}` };
    const ehAprov = /aprova[çc][ãa]o/i.test(t) || !!acha(res, /^aprova/i);
    if (ehAprov && aprov.length < 5) {
      let ap = acha(res, /^aprova/i)?.pct, de = acha(res, /^desaprova/i)?.pct, combinada = false;
      if (ap == null || de == null) {
        const otimoBom = somaOpc(res, [/[óo]timo/i, /^bom/i]);
        const ruimPessimo = somaOpc(res, [/^ruim/i, /p[ée]ssimo/i]);
        if (otimoBom && ruimPessimo) { ap = r1(otimoBom); de = r1(ruimPessimo); combinada = true; }
      }
      if (ap == null || de == null) {
        ap = num((t.match(/(?<!des)aprova\w*\D{0,40}?(\d{1,2}(?:[.,]\d)?)\s*%/i) || [])[1]);
        de = num((t.match(/desaprova\w*\D{0,40}?(\d{1,2}(?:[.,]\d)?)\s*%/i) || [])[1]);
      }
      if (Number.isFinite(ap) && Number.isFinite(de)) {
        aprov.push({ ...base, aprova: r1(ap), desaprova: r1(de), combinada });
        log(`Fichas/E²D: ${id} → aprovação ${base.instituto} ${r1(ap)}%×${r1(de)}%${combinada ? " (ótimo+bom)" : ""}`);
      } else log(`Fichas/E²D: ${id} é aprovação mas sem números extraíveis.`);
    } else if (estado && gov.length < 8) {
      const top = topCands(res, 2);
      const detalhe = top.length === 2 ? `${top[0].label} ${nfBR(top[0].pct)}% × ${top[1].label} ${nfBR(top[1].pct)}%` : "";
      gov.push({ ...base, estado, detalhe });
      log(`Fichas/E²D: ${id} → estadual ${estado} (${base.instituto})${detalhe ? " " + detalhe : ""}`);
    } else if (!estado && res && nac.length < 6) {
      const top = topCands(res, 2);
      if (top.length === 2) nac.push({ instituto: base.instituto, coleta_label: coleta, amostra: base.amostra,
        detalhe: `${top[0].label} ${nfBR(top[0].pct)}% × ${top[1].label} ${nfBR(top[1].pct)}%` });
    }
  }
  if (!aprov.length && !gov.length && telemetria)
    log(`Fichas/E²D: amostra de texto de ficha p/ diagnóstico: "${telemetria}"`);
  return (pageCache.fichas = { aprov, gov, nac });
}

const nfBR = (n) => String(r1(n)).replace(".", ",");

/* ================= SEÇÃO 2 — APROVAÇÃO ================= */

async function coletaAprovacao(log, pageCache) {
  const { aprov } = await varreduraFichas(log, pageCache);
  if (!aprov.length) { log("Aprovação/E²D: nenhuma ficha com números nesta rodada."); return null; }
  const media = (k) => r1(aprov.reduce((s, p) => s + p[k], 0) / aprov.length);
  const temCombinada = aprov.some((p) => p.combinada);
  return { atualizado_em: hoje(), titulo: "Aprovação do governo federal",
    metodologia: `Média simples das últimas ${aprov.length} pesquisas de aprovação (ExameLab)`
      + (temCombinada ? "; em parte delas, aprovação = ótimo+bom" : ""),
    aprova_media: media("aprova"), desaprova_media: media("desaprova"), itens: aprov,
    fonte: "Fichas de pesquisas do Eleição em Dados (E²D), registradas no TSE", fonte_url: `${E2D}/pesquisas` };
}

/* ================= SEÇÃO 3 — GOVERNADORES ================= */

async function coletaGovernadores(log, pageCache) {
  const { gov } = await varreduraFichas(log, pageCache);
  if (!gov.length) { log("Governadores/E²D: nenhuma pesquisa estadual nesta rodada."); return null; }
  return { atualizado_em: hoje(), titulo: "Corridas estaduais — pesquisas recentes",
    nota: "Monitor de pesquisas estaduais registradas; resultados completos na ficha de cada pesquisa.",
    itens: gov, fonte: "Fichas de pesquisas do Eleição em Dados (E²D)", fonte_url: `${E2D}/pesquisas` };
}

/* ================= histórico + main ================= */

function atualizaHistorico(ag, aprov) {
  const hp = join(DADOS, "historico.json");
  const hist = existsSync(hp) ? JSON.parse(readFileSync(hp, "utf8")) : { pontos: [] };
  hist.pontos = (hist.pontos || []).map((p) => ({ cenario: p.cenario || "2º turno · Lula × Flávio", ...p }));
  // autocura: um 2º turno com 2 candidatos soma ~100; ponto contaminado (ex.:
  // semente de 1º turno etiquetada errado) soma bem menos — descarta.
  hist.pontos = hist.pontos.filter((p) => {
    if (!/2º turno/.test(p.cenario)) return true;
    const soma = Object.values(p.valores || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    return soma >= 85;
  });
  const upsert = (data, cenario, valores) => {
    const i = hist.pontos.findIndex((p) => p.data === data && p.cenario === cenario);
    if (i >= 0) hist.pontos[i].valores = valores; else hist.pontos.push({ data, cenario, valores });
  };
  const valores = {}; ag.candidatos.slice(0, 3).forEach((c) => { valores[c.nome] = c.media; });
  upsert(ag.corte, ag.cenario, valores);
  if (aprov) upsert(hoje(), "Aprovação do governo", { "Aprova": aprov.aprova_media, "Desaprova": aprov.desaprova_media });
  hist.pontos.sort((a, b) => a.data.localeCompare(b.data));
  const doCen = hist.pontos.filter((p) => p.cenario === ag.cenario);
  const alvo = new Date(new Date(ag.corte).getTime() - 14 * 864e5).toISOString().slice(0, 10);
  for (const c of ag.candidatos) {
    const antes = doCen.filter((p) => p.data <= alvo && p.valores[c.nome] != null);
    c.tendencia_14d = antes.length ? r1(c.media - antes[antes.length - 1].valores[c.nome]) : 0;
  }
  writeFileSync(hp, JSON.stringify(hist, null, 2) + "\n");
  return hist.pontos.length;
}

async function main() {
  const logs = []; const log = (s) => { logs.push(s); console.log(s); };
  const pageCache = {};

  let ag = null;
  try { ag = await presidenteA(log, pageCache); } catch (e) { log("Presidente/E²D: erro — " + e.message); }
  if (!ag) ag = await presidenteB(log);
  ag.atualizado_em = hoje();

  let aprov = null, gov = null;
  try { aprov = await coletaAprovacao(log, pageCache); } catch (e) { log("Aprovação: erro — " + e.message); }
  try { gov = await coletaGovernadores(log, pageCache); } catch (e) { log("Governadores: erro — " + e.message); }

  const fichas = pageCache.fichas;
  if (fichas?.nac?.length && (!ag.ultimas_pesquisas || !ag.ultimas_pesquisas.length))
    ag.ultimas_pesquisas = fichas.nac.slice(0, 6);

  const nPontos = atualizaHistorico(ag, aprov);
  writeFileSync(join(DADOS, "agregado.json"), JSON.stringify(ag, null, 2) + "\n");
  if (aprov) writeFileSync(join(DADOS, "aprovacao.json"), JSON.stringify(aprov, null, 2) + "\n");
  if (gov) writeFileSync(join(DADOS, "governadores.json"), JSON.stringify(gov, null, 2) + "\n");
  writeFileSync(join(DADOS, "_status.json"), JSON.stringify({
    ultima_execucao: new Date().toISOString(), presidente: ag.cenario,
    aprovacao: aprov ? `${aprov.itens.length} pesquisas` : "sem dados nesta rodada",
    governadores: gov ? `${gov.itens.length} pesquisas` : "sem dados nesta rodada",
    pontos_na_serie: nPontos, log: logs }, null, 2) + "\n");

  console.log(`OK — Presidente: ${ag.cenario} (${ag.candidatos.slice(0,2).map(c=>`${c.nome} ${c.media}%`).join(" × ")}) | Aprovação: ${aprov?`${aprov.aprova_media}%×${aprov.desaprova_media}%`:"—"} | Governadores: ${gov?gov.itens.length+" itens":"—"}`);
}

main().catch((e) => { console.error("FALHA:", e.message); process.exit(1); });

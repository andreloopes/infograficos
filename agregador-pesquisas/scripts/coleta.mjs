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

/* ============ lista de pesquisas do E²D (base p/ seções 2 e 3) ============ */

function parseListaPesquisas(html) {
  // Trabalha sobre TEXTO (sem tags) — robusto a mudanças de markup.
  // Estrutura observada: [ESTADO] [Tipo da pesquisa] [Instituto] "Coleta em dd/mm/aaaa" [TSE xx] [Amostra n]
  const ids = [...new Set([...String(html).matchAll(/\/pesquisas\/(\d+)/g)].map((m) => m[1]))];
  const txt = stripTags(html);
  // 1) âncoras: todas as datas de coleta
  const marks = [];
  const re = /Coleta em (\d{2}\/\d{2}\/\d{4})(?:\D{0,10}TSE ([A-Z]{2}-\d+\/\d{4}))?/g;
  let m;
  while ((m = re.exec(txt)) && marks.length < 60) marks.push({ idx: m.index, end: re.lastIndex, coleta: m[1], tse: m[2] || "" });
  // 2) cada item lê só a fatia entre o fim do item anterior e a sua âncora
  const itens = marks.map((mk, i) => {
    const antes = txt.slice(i ? marks[i - 1].end : Math.max(0, mk.idx - 220), mk.idx).slice(-220);
    const depois = txt.slice(mk.end, mk.end + 60);
    const amostra = (depois.match(/Amostra\s+([\d.\s]+)/i) || [])[1];
    let tipo = "outro", estado = null, instituto = "—";
    const tm = antes.match(/(Aprova[çc][ãa]o do governo|Pesquisa de candidatos)/i);
    if (tm) {
      tipo = /aprova/i.test(tm[0]) ? "aprovacao" : "candidatos";
      const pre = antes.slice(0, tm.index);                 // estado vem ANTES do tipo
      const post = antes.slice(tm.index + tm[0].length);    // instituto vem DEPOIS do tipo
      estado = UFS.find((uf) => pre.includes(uf)) || (/Nacional/i.test(pre) ? "Nacional" : null);
      instituto = post.replace(/Ver detalhe/gi, " ").replace(/\s+/g, " ").trim() || "—";
    }
    return { tipo, estado, instituto, coleta: mk.coleta, tse: mk.tse,
      amostra: amostra ? parseInt(amostra.replace(/\D/g, ""), 10) : 0 };
  });
  return { ids, itens };
}

/* ================= SEÇÃO 2 — APROVAÇÃO ================= */

async function coletaAprovacao(log, pageCache) {
  const page = pageCache.pesquisas ?? (pageCache.pesquisas = await tryFetch(`${E2D}/pesquisas`, false));
  if (!page.ok) { log(`Aprovação/E²D: lista inacessível (${page.status || page.err})`); return null; }
  const { ids, itens } = parseListaPesquisas(page.body);
  const aprovIdx = itens.map((it, i) => it.tipo === "aprovacao" ? i : -1).filter((i) => i >= 0);
  log(`Aprovação/E²D: ${itens.length} pesquisas na lista, ${aprovIdx.length} de aprovação, ${ids.length} fichas com link.`);
  const out = [];
  // visita fichas até achar 5 de aprovação com números (cap 12 fetches)
  for (const id of ids.slice(0, 12)) {
    if (out.length >= 5) break;
    const det = await tryFetch(`${E2D}/pesquisas/${id}`, false, 10000);
    if (!det.ok) continue;
    const t = stripTags(det.body);
    if (!/Aprova[çc][ãa]o do governo/i.test(t)) continue;
    const ap = (t.match(/(?<!des)aprova\w*\D{0,40}?(\d{1,2}(?:[.,]\d)?)\s*%/i) || [])[1];
    const de = (t.match(/desaprova\w*\D{0,40}?(\d{1,2}(?:[.,]\d)?)\s*%/i) || [])[1];
    if (!ap || !de) continue;
    const inst = (t.match(/(?:por|Instituto)\s+([A-ZÀ-Ú][\wÀ-ú&./ -]{2,40}?)\s+(?:Coleta|em \d)/) || [])[1]
      || (t.match(/([A-ZÀ-Ú][\wÀ-ú&./-]*(?:\s+[A-ZÀ-Ú&][\wÀ-ú&./-]*){0,4})\s*Coleta em/) || [])[1] || "—";
    const coleta = (t.match(/Coleta em (\d{2}\/\d{2}\/\d{4})/) || [])[1] || "";
    const amostra = (t.match(/Amostra\s+([\d.\s]+)/i) || [])[1];
    out.push({ instituto: inst.trim(), coleta, amostra: amostra ? parseInt(amostra.replace(/\D/g, ""), 10) : 0,
      aprova: num(ap), desaprova: num(de), url: `${E2D}/pesquisas/${id}` });
    log(`Aprovação/E²D: ficha ${id} → ${inst.trim()} aprova ${ap}% × desaprova ${de}%`);
  }
  if (!out.length) { log("Aprovação/E²D: nenhuma ficha com números extraíveis."); return null; }
  const media = (k) => r1(out.reduce((s, p) => s + p[k], 0) / out.length);
  return { atualizado_em: hoje(), titulo: "Aprovação do governo federal",
    metodologia: `Média simples das últimas ${out.length} pesquisas de aprovação (ExameLab)`,
    aprova_media: media("aprova"), desaprova_media: media("desaprova"), itens: out,
    fonte: "Fichas de pesquisas do Eleição em Dados (E²D), registradas no TSE", fonte_url: `${E2D}/pesquisas` };
}

/* ================= SEÇÃO 3 — GOVERNADORES ================= */

async function coletaGovernadores(log, pageCache) {
  const page = pageCache.pesquisas ?? (pageCache.pesquisas = await tryFetch(`${E2D}/pesquisas`, false));
  if (!page.ok) { log(`Governadores/E²D: lista inacessível (${page.status || page.err})`); return null; }
  const { itens } = parseListaPesquisas(page.body);
  const estaduais = itens.filter((it) => it.estado && it.estado !== "Nacional").slice(0, 10)
    .map((it) => ({ estado: it.estado, instituto: it.instituto, coleta: it.coleta, amostra: it.amostra, tse: it.tse }));
  log(`Governadores/E²D: ${estaduais.length} pesquisa(s) estadual(is) na lista.`);
  if (!estaduais.length) return null;
  return { atualizado_em: hoje(), titulo: "Corridas estaduais — pesquisas recentes",
    nota: "Monitor de pesquisas estaduais registradas; resultados completos na ficha de cada pesquisa.",
    itens: estaduais, fonte: "Lista de pesquisas do Eleição em Dados (E²D)", fonte_url: `${E2D}/pesquisas` };
}

/* ================= histórico + main ================= */

function atualizaHistorico(ag, aprov) {
  const hp = join(DADOS, "historico.json");
  const hist = existsSync(hp) ? JSON.parse(readFileSync(hp, "utf8")) : { pontos: [] };
  hist.pontos = (hist.pontos || []).map((p) => ({ cenario: p.cenario || "2º turno · Lula × Flávio", ...p }));
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

// coleta.mjs — coletor do agregador de pesquisas (ExameLab)
// Node 18+ (usa fetch nativo, zero dependências).
// Roda pela GitHub Action ou local: `node scripts/coleta.mjs`
//
// O QUE FAZ: busca o agregado atual numa fonte pública, normaliza para o
// formato que a página consome (dados/agregado.json) e ACRESCENTA um ponto do
// dia em dados/historico.json — é isso que constrói a sua série de tendência.
//
// >>> AJUSTE AQUI <<<
// A API do Eleição em Dados é pública, mas os nomes de campos/rotas precisam ser
// conferidos no Swagger: https://api-core-4p7x5p4kza-rj.a.run.app/api/docs
// Preencha ENDPOINT e adapte mapAggregate() ao JSON real que a rota devolver.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DADOS = join(ROOT, "dados");

const CONFIG = {
  // Rota do agregado. Confirme o caminho exato no Swagger acima.
  ENDPOINT: "https://api-core-4p7x5p4kza-rj.a.run.app/api/agregado",
  CENARIO: "Brasil (nacional) — 1º turno",
  FONTE: "Eleição em Dados (E²D) — média ponderada de pesquisas registradas no TSE",
  FONTE_URL: "https://eleicaoemdados.com.br/agregador",
  TOP_SERIE: 2, // quantos candidatos entram na série histórica de tendência
};

// Converte o JSON cru da API para o formato da página.
// AJUSTE os caminhos de campo conforme o retorno real da API.
function mapAggregate(raw) {
  const lista = raw.candidatos ?? raw.candidates ?? raw.resultados ?? [];
  const candidatos = lista.map((c) => ({
    nome: c.nome ?? c.candidato ?? c.name,
    partido: c.partido ?? c.party ?? "",
    media: num(c.media ?? c.mean ?? c.valor),
    ic_min: num(c.ic_min ?? c.ci_low ?? c.lower),
    ic_max: num(c.ic_max ?? c.ci_high ?? c.upper),
    tendencia_14d: num(c.tendencia_14d ?? c.trend ?? 0),
  })).filter((c) => c.nome && Number.isFinite(c.media));

  return {
    atualizado_em: hoje(),
    corte: (raw.corte ?? raw.cutoff ?? hoje()).slice(0, 10),
    cenario: CONFIG.CENARIO,
    pesquisas_no_calculo: num(raw.pesquisas_no_calculo ?? raw.n ?? candidatos.length),
    indecisos: num(raw.indecisos ?? raw.undecided ?? 0),
    fonte: CONFIG.FONTE,
    fonte_url: CONFIG.FONTE_URL,
    candidatos,
    ultimas_pesquisas: (raw.ultimas_pesquisas ?? raw.polls ?? []).slice(0, 6).map((p) => ({
      instituto: p.instituto ?? p.institute ?? p.empresa,
      coleta: (p.coleta ?? p.field_end ?? p.data ?? "").slice(0, 10),
      tse: p.tse ?? p.registro ?? p.protocolo ?? "",
      amostra: num(p.amostra ?? p.sample ?? 0),
      tipo: p.tipo ?? p.type ?? "Candidatos",
    })),
  };
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const hoje = () => new Date().toISOString().slice(0, 10);

async function main() {
  const res = await fetch(CONFIG.ENDPOINT, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`API respondeu ${res.status} ${res.statusText}`);
  const raw = await res.json();

  const ag = mapAggregate(raw);
  if (!ag.candidatos.length) throw new Error("Nenhum candidato após o mapeamento — confira mapAggregate().");

  // grava o agregado atual
  writeFileSync(join(DADOS, "agregado.json"), JSON.stringify(ag, null, 2) + "\n");

  // acrescenta ponto do dia na série (dedupe por data; nunca apaga histórico)
  const hp = join(DADOS, "historico.json");
  const hist = existsSync(hp) ? JSON.parse(readFileSync(hp, "utf8")) : { pontos: [] };
  const valores = {};
  ag.candidatos.slice(0, CONFIG.TOP_SERIE).forEach((c) => { valores[c.nome] = c.media; });
  const idx = hist.pontos.findIndex((p) => p.data === ag.corte);
  if (idx >= 0) hist.pontos[idx].valores = valores;
  else hist.pontos.push({ data: ag.corte, valores });
  hist.pontos.sort((a, b) => a.data.localeCompare(b.data));
  writeFileSync(hp, JSON.stringify(hist, null, 2) + "\n");

  // batimento diário: muda todo dia, garantindo um commit por execução
  // (é isso que mantém o robô do GitHub "acordado" — ver README).
  writeFileSync(join(DADOS, "_status.json"), JSON.stringify({
    ultima_execucao: new Date().toISOString(),
    corte: ag.corte,
    candidatos: ag.candidatos.length,
    pontos_na_serie: hist.pontos.length,
  }, null, 2) + "\n");

  console.log(`OK — ${ag.candidatos.length} candidatos, corte ${ag.corte}, ${hist.pontos.length} ponto(s) na série.`);
}

main().catch((e) => { console.error("FALHA:", e.message); process.exit(1); });

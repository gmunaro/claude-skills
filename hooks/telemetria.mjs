#!/usr/bin/env node
// Subagent telemetry: model, effort and tokens of each subagent, in ~/.claude/telemetria.jsonl.
//
// Usage:
//   SubagentStop hook (settings.json): node ~/.claude/hooks/telemetria.mjs   (reads the hook JSON from stdin)
//   node ~/.claude/hooks/telemetria.mjs --historico       imports the transcripts that already exist (skips ids already recorded)
//   node ~/.claude/hooks/telemetria.mjs --resumo [--desde YYYY-MM-DD] [--sem-condutor]
//       table by model, effort and agent type; includes the conductor (main sessions) in the period.
//
// The hook never fails the session: any error exits with code 0 and one line on stderr.
// Tokens come from message.usage in the transcript, deduplicated by message.id (each content block repeats the line).

import { createReadStream, existsSync, readFileSync, appendFileSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";

const CLAUDE = join(homedir(), ".claude");
const SAIDA = join(CLAUDE, "telemetria.jsonl");
const PROJETOS = join(CLAUDE, "projects");

const expandir = (p) => (p?.startsWith("~") ? join(homedir(), p.slice(1)) : p);

/** Sums the usage of a transcript (subagent or main session). */
async function lerTranscript(caminho) {
  const msgs = new Map();
  const modelos = new Map();
  let esforco = null, inicio = null, fim = null;
  const rl = createInterface({ input: createReadStream(caminho), crlfDelay: Infinity });
  for await (const linha of rl) {
    if (!linha.includes('"usage"') || !linha.includes('"assistant"')) continue;
    let j;
    try { j = JSON.parse(linha); } catch { continue; }
    if (j.type !== "assistant" || !j.message?.usage) continue;
    if (j.timestamp) { inicio ??= j.timestamp; fim = j.timestamp; }
    if (j.effort) esforco = j.effort;
    const id = j.message.id ?? j.uuid;
    if (msgs.has(id)) continue;
    const m = j.message.model ?? "?";
    if (m === "<synthetic>") continue;
    msgs.set(id, j.message.usage);
    modelos.set(m, (modelos.get(m) ?? 0) + 1);
  }
  const t = { entrada: 0, saida: 0, cache_leitura: 0, cache_escrita: 0, raciocinio: 0 };
  for (const u of msgs.values()) {
    t.entrada += u.input_tokens ?? 0;
    t.saida += u.output_tokens ?? 0;
    t.cache_leitura += u.cache_read_input_tokens ?? 0;
    t.cache_escrita += u.cache_creation_input_tokens ?? 0;
    t.raciocinio += u.output_tokens_details?.thinking_tokens ?? 0;
  }
  const ordem = [...modelos.entries()].sort((a, b) => b[1] - a[1]);
  return {
    modelo: ordem[0]?.[0] ?? null,
    outros_modelos: ordem.slice(1).map(([m]) => m),
    esforco,
    inicio,
    fim,
    duracao_s: inicio && fim ? Math.round((Date.parse(fim) - Date.parse(inicio)) / 1000) : null,
    turnos: msgs.size,
    ...t,
  };
}

/** Builds the record of one subagent from the transcript path. */
async function registro(caminho, extra = {}) {
  const meta = caminho.replace(/\.jsonl$/, ".meta.json");
  let m = {};
  if (existsSync(meta)) { try { m = JSON.parse(readFileSync(meta, "utf8")); } catch {} }
  const sessaoDir = dirname(dirname(caminho));
  return {
    agent_id: basename(caminho, ".jsonl").replace(/^agent-/, ""),
    session_id: basename(sessaoDir),
    projeto: basename(dirname(sessaoDir)),
    agent_type: extra.agent_type || m.agentType || null,
    descricao: m.description ?? null,
    profundidade: m.spawnDepth ?? null,
    ...(await lerTranscript(caminho)),
    origem: extra.origem ?? "historico",
  };
}

function idsGravados() {
  const ids = new Set();
  if (!existsSync(SAIDA)) return ids;
  for (const l of readFileSync(SAIDA, "utf8").split("\n")) {
    if (!l) continue;
    try { ids.add(JSON.parse(l).agent_id); } catch {}
  }
  return ids;
}

function* transcriptsDeSubagentes() {
  for (const proj of readdirSync(PROJETOS)) {
    const pp = join(PROJETOS, proj);
    let sessoes;
    try { sessoes = readdirSync(pp); } catch { continue; }
    for (const s of sessoes) {
      const sub = join(pp, s, "subagents");
      if (!existsSync(sub)) continue;
      for (const f of readdirSync(sub)) if (f.startsWith("agent-") && f.endsWith(".jsonl")) yield join(sub, f);
    }
  }
}

async function historico() {
  const ja = idsGravados();
  let novos = 0, pulados = 0;
  for (const c of transcriptsDeSubagentes()) {
    const id = basename(c, ".jsonl").replace(/^agent-/, "");
    if (ja.has(id)) { pulados++; continue; }
    const r = await registro(c);
    if (!r.turnos) continue;
    appendFileSync(SAIDA, JSON.stringify(r) + "\n");
    novos++;
  }
  console.log(`history: ${novos} recorded, ${pulados} already existed -> ${SAIDA}`);
}

async function hook() {
  let s = "";
  for await (const ch of process.stdin) s += ch;
  const e = JSON.parse(s);
  const caminho = expandir(e.agent_transcript_path);
  if (!caminho || !existsSync(caminho)) return;
  const r = await registro(caminho, { agent_type: e.agent_type, origem: "hook" });
  if (r.turnos) appendFileSync(SAIDA, JSON.stringify(r) + "\n");
}

// US$ per million tokens, first-party API (claude-api skill, table of 2026-10-06).
// Estimates: Haiku cache read = 0.1x input; cache write (5 min) = 1.25x input on all models.
// On the Max plan this is not a bill: it is for comparing how much each model weighs on the limit.
const PRECOS = {
  "claude-haiku-5-5": { e: 0.1, s: 0.5, cl: 0.01 },
  "claude-sonnet-5-5": { e: 2, s: 10, cl: 0.2 },
  "claude-opus-5-5": { e: 4, s: 20, cl: 0.2 },
  "claude-fable-5-1": { e: 10, s: 50, cl: 0.25 },
};
const custo = (r) => {
  const p = PRECOS[r.modelo];
  if (!p) return 0;
  return (r.entrada * p.e + r.saida * p.s + r.cache_leitura * p.cl + r.cache_escrita * p.e * 1.25) / 1e6;
};

const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n));

async function resumo(desde, comCondutor) {
  // The last record of each agent_id wins (the hook rewrites it when an agent continues via SendMessage).
  const porId = new Map();
  if (existsSync(SAIDA)) {
    for (const l of readFileSync(SAIDA, "utf8").split("\n")) {
      if (!l) continue;
      try { const r = JSON.parse(l); porId.set(r.agent_id, r); } catch {}
    }
  }
  const linhas = new Map();
  const somar = (chave, r) => {
    const a = linhas.get(chave) ?? { n: 0, saida: 0, entrada_total: 0, cache_leitura: 0, dur: 0, usd: 0 };
    a.n++;
    a.usd += custo(r);
    a.saida += r.saida;
    a.entrada_total += r.entrada + r.cache_leitura + r.cache_escrita;
    a.cache_leitura += r.cache_leitura;
    a.dur += r.duracao_s ?? 0;
    linhas.set(chave, a);
  };
  for (const r of porId.values()) {
    if (desde && (r.fim ?? "") < desde) continue;
    somar(`sub | ${r.modelo} | ${r.esforco ?? "?"} | ${r.agent_type ?? "?"}`, r);
  }
  if (comCondutor) {
    const limite = desde ? Date.parse(desde) : 0;
    for (const proj of readdirSync(PROJETOS)) {
      const pp = join(PROJETOS, proj);
      let fs;
      try { fs = readdirSync(pp); } catch { continue; }
      for (const f of fs) {
        if (!f.endsWith(".jsonl")) continue;
        const c = join(pp, f);
        if (statSync(c).mtimeMs < limite) continue;
        const r = await lerTranscript(c);
        if (!r.turnos || (desde && (r.fim ?? "") < desde)) continue;
        somar(`conductor | ${r.modelo} | ${r.esforco ?? "?"} | session`, r);
      }
    }
  }
  const ord = [...linhas.entries()].sort((a, b) => b[1].usd - a[1].usd);
  const tot = ord.reduce((s, [, a]) => s + a.usd, 0) || 1;
  console.log(`Telemetry${desde ? " since " + desde : ""}. US$ = API-price equivalent (estimate, not a bill). Input includes cache.`);
  console.log("role | model | effort | type | n | US$ | % US$ | US$/agent | output | input | avg output | avg duration");
  for (const [ch, a] of ord) {
    console.log(`${ch} | ${a.n} | ${a.usd.toFixed(0)} | ${((a.usd / tot) * 100).toFixed(1)}% | ${(a.usd / a.n).toFixed(2)} | ${k(a.saida)} | ${k(a.entrada_total)} | ${k(Math.round(a.saida / a.n))} | ${Math.round(a.dur / a.n)}s`);
  }
  console.log(`total: US$ ${tot.toFixed(0)}`);
}

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
try {
  if (args.includes("--historico")) await historico();
  else if (args.includes("--resumo")) await resumo(opt("--desde"), !args.includes("--sem-condutor"));
  else await hook();
} catch (err) {
  console.error(`telemetria: ${err?.message ?? err}`);
  process.exit(0);
}

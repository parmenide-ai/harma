import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, cpSync, rmSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { loadCatalog, harnesses } from './catalog.mjs';
import { parseTarget, effortValues, launchSpec, resumeArgv, meta, herdrKind, headlessOf, headlessSpec } from './harness.mjs';
import {
  projectRoot, loadConfig, saveConfig, appendEvent, readEvents, agentsFromEvents,
  writeCache, readCache, hasProject, DEFAULT_CONFIG, ensureGitignore, readText,
} from './state.mjs';
import { AGY_NEON, agyModelIds, inventory } from './inventory.mjs';
import { collectCredits } from './credits.mjs';
import { rankRows, refreshFromAA } from './rank.mjs';
import { route, taskProfile, TASK_PROFILES } from './route.mjs';
import { selectBackend, HerdrBackend, HcBackend, projectId, checkAgentName, isCliCommand, LAYOUTS } from './backends.mjs';
import { trustableFolder, trustPolicy, TRUST_LEVELS, readTrustDialog } from './trust.mjs';
import { answerPolicy, answerGate, ANSWER_LEVELS, ANSWER_KINDS } from './answers.mjs';
import { usageFor, estimateCost, findCodexSession } from './usage.mjs';
import { museSessions, findMuseSession, replacedMuseSession } from './sessions.mjs';
import { table, HarmaError, now, which, readJson, run, shq } from './util.mjs';
import { modelOptions, selectionRows, applySelection, parseSetSpec, describe, describePick, ORCHESTRATOR, rosterPicks, choosePick } from './roster.mjs';
import { initState, runTui } from './tui.mjs';
import { statePath } from './state.mjs';
import { fileURLToPath } from 'node:url';

export const EXIT_NEEDS_CONFIRM = 3;
export const EXIT_BLOCKED = 4; // agent waits on a dialog, or a task did not reach it
export const EXIT_STILL_WORKING = 5; // harma wait ran out of time
const CREDIT_TTL_MS = 15 * 60_000;
const HEADLESS_MAX_SEC = 3600; // a headless job is stopped after an hour unless --max-time says otherwise

function ctx(opts) {
  const env = opts.env ?? process.env;
  const root = projectRoot(opts.cwd ?? process.cwd());
  const catalog = loadCatalog({ env });
  return { env, root, catalog, out: opts.out ?? ((s) => process.stdout.write(s + '\n')) };
}

/** Is the CLI that runs this harness on PATH? */
function installedHarness(c, harness) {
  const h = harnesses(c.catalog)[harness];
  if (!h) return false;
  return Boolean(which(meta(harness).interactiveBinary ?? h.binary.split(' ')[0], c.env));
}

const emit = (c, flags, data, text) => c.out(flags.json ? JSON.stringify(data, null, 2) : text());

// 1 ─ orchestrator ─────────────────────────────────────────────────────────
export async function cmdInit(flags, opts = {}) {
  const c = ctx(opts);
  const root = resolve(opts.cwd ?? process.cwd());
  const cfg = loadConfig(root);
  if (!flags.orchestrator) throw new HarmaError('Manca --orchestrator <harness>:<model>', { hint: 'es. harma init --orchestrator claude:claude-opus-5-5 --effort high' });
  const t = parseTarget(flags.orchestrator, c.catalog);
  const allowed = effortValues(t.harness, t.model, c.catalog);
  const effort = flags.effort ?? c.catalog.models?.[t.model]?.effort_default ?? null;
  if (effort && allowed.length && !allowed.includes(effort)) {
    throw new HarmaError(`Effort ${effort} non supportato da ${t.harness}:${t.model}`, { hint: `Valori: ${allowed.join(', ')}` });
  }
  cfg.orchestrator = { harness: t.harness, model: t.model, effort, set_at: now() };
  if (flags.backend) cfg.backend = flags.backend;
  if (flags.layout) {
    if (!LAYOUTS.includes(String(flags.layout).split(':')[0])) throw new HarmaError(`--layout: ${LAYOUTS.join(' | ')} (split:down per dividere in basso)`);
    cfg.herdr = { ...(cfg.herdr ?? {}), layout: flags.layout };
  }
  if (flags['trust-project']) { cfg.trust = 'on'; delete cfg.trust_project; }
  if (flags['worktree-copy'] !== undefined) cfg.worktree_copy = parseCopyList(flags['worktree-copy']);
  if (flags.policy) {
    if (!['confirm', 'auto-within-budget'].includes(flags.policy)) throw new HarmaError('--policy: confirm | auto-within-budget');
    cfg.dispatch_policy = flags.policy;
  }
  saveConfig(root, cfg);
  appendEvent(root, { type: 'orchestrator', ...cfg.orchestrator });
  if (flags['trust-project']) appendEvent(root, { type: 'trust_policy', value: 'on', by: 'utente (harma init --trust-project)' });
  emit({ ...c, root }, flags, cfg, () => [
    `Progetto harma: ${root}`,
    `Orchestratore: ${t.harness}:${t.model} @ ${effort ?? 'default'}`,
    `Backend: ${cfg.backend} · Layout herdr: ${cfg.herdr?.layout ?? 'auto'} · Policy di delega: ${cfg.dispatch_policy}`,
    `Fiducia nella cartella: ${TRUST_TEXT[trustPolicy(cfg, readEvents(root))]}`,
    `Risposte agli agenti bloccati: ${ANSWER_TEXT[answerPolicy(cfg)]}`,
    ...(cfg.worktree_copy?.length ? [`Copiati in ogni worktree: ${cfg.worktree_copy.join(', ')}`] : []),
    'Prossimi passi: harma models · harma credits · harma rank',
  ].join('\n'));
  return cfg;
}

const TRUST_TEXT = {
  off: 'la dà sempre l\'utente (harma trust worktrees o on per delegarla a harma)',
  worktrees: 'harma risponde per i worktree che crea, l\'utente per il resto (harma trust off per disattivare, on per includere il progetto)',
  on: 'harma risponde per il progetto e i worktree che crea (harma trust worktrees o off per restringere)',
};

const ANSWER_TEXT = {
  off: 'l\'orchestratore non risponde: domande e permessi restano all\'utente',
  questions: 'l\'orchestratore risponde alle domande sul lavoro; i permessi restano all\'utente',
  permissions: 'l\'orchestratore risponde alle domande e approva i permessi una volta, a giudizio; un permesso che resta (es. «non chiedere più») lo dà l\'utente',
  all: 'l\'orchestratore risponde a tutto, anche ai permessi che restano',
};

/**
 * The project's answer policy: how far the orchestrator may answer agents
 * that wait on a question or a permission. The user's decision.
 */
export async function cmdAnswers(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root, { required: true });
  const want = flags._[0];
  if (want && !ANSWER_LEVELS.includes(want)) throw new HarmaError(`Uso: harma answers [${ANSWER_LEVELS.join('|')}]`);
  if (want) {
    cfg.answers = want;
    saveConfig(c.root, cfg);
    appendEvent(c.root, { type: 'answer_policy', value: want, by: `utente (harma answers ${want})` });
  }
  const level = answerPolicy(cfg);
  emit(c, flags, { answers: level, root: c.root }, () => `Risposte agli agenti bloccati per ${c.root}: ${ANSWER_TEXT[level]}.\nIl dialogo di fiducia nella cartella segue harma trust.`);
  return { answers: level };
}

/**
 * Answer an agent that waits on a question or a permission request: pick the
 * option named (checked on screen before Enter), type a free answer, or send
 * keys. Recorded in the event log with the reason.
 */
export async function cmdAnswer(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root, { required: true });
  const name = flags._[0];
  const usage = 'Uso: harma answer <nome> --kind question|permission (--option "<testo o numero>" [--text "…"] | --text "…" | --keys "down,enter") [--reason "…"]';
  const agent = openAgent(c, name);
  if (agent.mode === 'headless') throw new HarmaError(`${name} è un lavoro non interattivo: non aspetta risposte`);
  const kind = flags.kind;
  if (!ANSWER_KINDS.includes(kind)) {
    throw new HarmaError(usage, { hint: 'question: una domanda sul lavoro; permission: una richiesta di permesso (eseguire un comando, scrivere un file, usare la rete)' });
  }
  const option = flags.option != null && flags.option !== true ? String(flags.option) : null;
  const text = flags.text != null && flags.text !== true ? String(flags.text) : null;
  const keys = flags.keys ? String(flags.keys).split(/[\s,]+/).filter(Boolean) : null;
  if (!option && text == null && !keys) throw new HarmaError(usage);
  if (keys && (option || text != null)) throw new HarmaError('--keys va usato da solo', { hint: usage });

  const level = answerPolicy(cfg);
  const confirmed = Boolean(flags.yes);
  const refuse = (reason, extra = {}) => {
    const data = { needs_confirmation: true, reason, agent: name, kind, option: extra.chosen ?? option, policy: level };
    emit(c, flags, data, () => `CONFERMA RICHIESTA — nessuna risposta data a ${name}.\nMotivo: ${reason}\nChiedi all'utente: se approva questa risposta, ripeti con --yes; altrimenti risponde lui nel terminale dell'agente.`);
    return { needsConfirmation: true, exitCode: EXIT_NEEDS_CONFIRM };
  };
  const pre = answerGate(level, { kind, keys: Boolean(keys), confirmed });
  if (!pre.allowed) return refuse(pre.reason);

  const backend = opts.backend ?? backendFor(agent, cfg, c.env);
  if (typeof backend.answer !== 'function') {
    throw new HarmaError(`harma answer funziona con herdr; ${name} gira su ${backend.name}`, { hint: 'Chiedi all\'utente di rispondere nel terminale dell\'agente' });
  }
  const target = agent.target?.name ?? name;
  const kindOf = herdrKind(agent.harness);
  if (kindOf && !confirmed && readTrustDialog(kindOf, await backend.screen(target), agent.target?.cwd ?? c.root).dialog) {
    return refuse(`è il dialogo di fiducia nella cartella: lo regola harma trust (policy ${trustPolicy(cfg, readEvents(c.root))})`);
  }
  let by = pre.by;
  const res = await backend.answer({
    target, option, text, keys,
    allow: (chosen) => {
      const g = answerGate(level, { kind, option: chosen, confirmed });
      if (g.allowed) by = g.by;
      return g;
    },
  });
  if (res.code === 'needs_confirmation') return refuse(res.detail, res);
  if (!res.ok) {
    throw new HarmaError(`Nessuna risposta data a ${name}: ${res.detail}`, {
      exitCode: res.code === 'not_blocked' ? 1 : EXIT_BLOCKED,
      hint: res.options?.length ? `Opzioni sullo schermo: ${res.options.join(' | ')}` : `Leggi lo schermo: harma read ${name} --lines 40`,
    });
  }
  const answer = [res.chosen && `«${res.chosen}»`, text != null && `testo (${text.length} caratteri)`, keys && `tasti ${keys.join(' ')}`].filter(Boolean).join(' + ');
  appendEvent(c.root, {
    type: 'answered', agent: name, kind, option: res.chosen ?? null, text: text != null ? text.slice(0, 500) : null, keys,
    reason: flags.reason && flags.reason !== true ? String(flags.reason) : null, by, state_after: res.state,
  });
  const tail = (res.screen ?? '').split('\n').filter((l) => l.trim()).slice(-15).join('\n');
  const data = { answered: true, agent: name, kind, option: res.chosen ?? null, options: res.options, state: res.state, still_blocked: res.state === 'blocked', by, screen: res.state === 'blocked' ? tail : null };
  emit(c, flags, data, () => [
    `Risposto a ${name} (${kind === 'question' ? 'domanda' : 'permesso'}, ${by}): ${answer}.`,
    res.state === 'blocked' ? `${name} aspetta ancora una risposta. Ultime righe:\n${tail}`
      : res.state === 'chiuso' ? `${name} non è più in herdr: il suo processo è terminato.`
        : `Ora ${name} è ${res.state ?? 'in stato sconosciuto'}.`,
    'Di\' all\'utente che cosa hai risposto e perché.',
  ].join('\n'));
  return data;
}

/**
 * The project's trust policy: whose folder-trust dialog harma answers.
 * The user's decision; an orchestrator never changes it by itself.
 */
export async function cmdTrust(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root, { required: true });
  const want = flags._[0];
  if (want && !TRUST_LEVELS.includes(want)) throw new HarmaError('Uso: harma trust [off|worktrees|on]');
  if (want) {
    cfg.trust = want;
    delete cfg.trust_project;
    saveConfig(c.root, cfg);
    appendEvent(c.root, { type: 'trust_policy', value: want, by: `utente (harma trust ${want})` });
  }
  const level = trustPolicy(cfg, readEvents(c.root));
  const data = { trust: level, trust_project: level === 'on', root: c.root };
  emit(c, flags, data, () => `Fiducia nella cartella per ${c.root}: ${TRUST_TEXT[level]}. Vale per il dialogo "ti fidi di questa cartella?" di Claude Code, Codex e Antigravity; i permessi sugli strumenti restano all'utente.`);
  return data;
}

/** "a, b" → ['a', 'b']: paths relative to the project, never outside it. */
function parseCopyList(spec) {
  const list = String(spec).split(',').map((s) => s.trim()).filter(Boolean);
  for (const p of list) {
    if (p.startsWith('/') || p.startsWith('~') || p.split(/[\\/]/).includes('..')) {
      throw new HarmaError(`--worktree-copy: ${p} non è un percorso dentro il progetto`, { hint: 'Percorsi relativi alla radice del progetto, es. .env,.env.local,config/secrets.yml' });
    }
  }
  return list;
}

// 2 ─ inventory ────────────────────────────────────────────────────────────
export async function cmdModels(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root);
  const inv = await inventory({ catalog: c.catalog, env: c.env, config: cfg });
  if (hasProject(c.root)) writeCache(c.root, 'inventory', { ...inv, catalog_fingerprint: c.catalog.catalog_fingerprint });
  emit(c, flags, inv, () => [
    'CLI di agenti',
    table(inv.clis, ['harness', 'state', 'version', 'billing', 'effort_via']),
    '',
    'Modelli utilizzabili',
    table(inv.models.map((m) => ({ ...m, efforts: m.efforts.join(','), in_catalog: m.in_catalog ? 'sì' : 'no' })),
      ['harness', 'model', 'efforts', 'default_effort', 'in_catalog', 'source']),
  ].join('\n'));
  return inv;
}

async function currentInventory(c, cfg, { fresh = false } = {}) {
  const cached = !fresh && hasProject(c.root) ? readCache(c.root, 'inventory') : null;
  if (cached?.catalog_fingerprint === c.catalog.catalog_fingerprint) return cached;
  return inventory({ catalog: c.catalog, env: c.env, config: cfg, versions: false });
}

// 3 ─ credits ──────────────────────────────────────────────────────────────
export async function cmdCredits(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root);
  const inv = await currentInventory(c, cfg);
  const names = inv.clis.filter((x) => x.state === 'installato').map((x) => x.harness);
  const credits = await collectCredits({ harnessNames: names, config: cfg, catalog: c.catalog, env: c.env, codexbar: opts.codexbar });
  if (hasProject(c.root)) writeCache(c.root, 'credits', credits);
  emit(c, flags, credits, () => [
    `Crediti (${credits.fetched_at}; codexbar: ${credits.codexbar})`,
    table(credits.rows.map((r) => ({
      harness: r.harness,
      provider: r.provider,
      residuo: r.remaining_pct === null ? 'sconosciuto' : `${r.remaining_pct}%`,
      stato: r.status,
      finestre: r.windows.map((w) => `${w.window} ${w.used_pct}%`).join(' ') || null,
      'stima 7g': r.estimate ? `$${r.estimate.usd}` : null,
      fonte: r.source ?? r.detail,
    }))),
    '',
    'Stima 7g = token dei log locali × listino API: per un abbonamento non è l\'addebito reale.',
  ].join('\n'));
  return credits;
}

async function currentCredits(c, cfg, inv, opts) {
  const cached = hasProject(c.root) ? readCache(c.root, 'credits') : null;
  if (cached && Date.now() - Date.parse(cached.fetched_at) < CREDIT_TTL_MS) return cached;
  const names = inv.clis.filter((x) => x.state === 'installato').map((x) => x.harness);
  const credits = await collectCredits({ harnessNames: names, config: cfg, catalog: c.catalog, env: c.env, codexbar: opts.codexbar });
  if (hasProject(c.root)) writeCache(c.root, 'credits', credits);
  return credits;
}

// 4 ─ intelligence ─────────────────────────────────────────────────────────
export async function cmdRank(flags, opts = {}) {
  let c = ctx(opts);
  let refresh = null;
  if (flags.refresh) {
    refresh = await refreshFromAA(c.catalog, { env: c.env, fetchImpl: opts.fetchImpl });
    c = ctx(opts);
  }
  const cfg = loadConfig(c.root);
  const inv = await currentInventory(c, cfg);
  const rows = rankRows(c.catalog, inv.models);
  const top = Number(flags.top ?? rows.length);
  const data = { catalog: { origin: c.catalog.origin, generated_at: c.catalog.generated_at, attribution: c.catalog.attribution }, refresh, rows: rows.slice(0, top) };
  if (hasProject(c.root)) writeCache(c.root, 'rank', { fetched_at: now(), ...data });
  emit(c, flags, data, () => [
    `Intelligenza per modello × effort — ${c.catalog.attribution}`,
    `Catalogo: ${c.catalog.origin === 'bundled' ? `snapshot incluso (registro ${c.catalog.registry_updated})` : `aggiornato da AA il ${c.catalog.generated_at}`}${refresh ? ` · aggiornati ${refresh.changes.filter((x) => x.change === 'indice aggiornato').length} modelli` : ''}`,
    table(rows.slice(0, top).map((r) => ({
      harness: r.harness, model: r.model, effort: r.effort,
      indice: r.index ?? 'sconosciuto', 'costo/task': r.cost_per_task === null ? '—' : `$${r.cost_per_task}`, 'data AA': r.aa_date,
    }))),
  ].join('\n'));
  return data;
}

// 5 ─ routing ──────────────────────────────────────────────────────────────
export async function cmdRoute(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root);
  const type = flags._[0];
  if (!type) throw new HarmaError('Manca il tipo di lavoro', { hint: `Tipi: ${Object.keys(TASK_PROFILES).join(', ')}` });
  const inv = await currentInventory(c, cfg);
  const credits = await currentCredits(c, cfg, inv, opts);
  const author = flags.author ? authorOf(flags.author, c.catalog) : null;
  const res = route(type, { rankRows: rankRows(c.catalog, inv.models), credits: credits.rows, config: cfg, author, top: Number(flags.top ?? 5) });
  if (!res) throw new HarmaError(`Tipo di lavoro sconosciuto: ${type}`, { hint: `Tipi: ${Object.keys(TASK_PROFILES).join(', ')}` });
  res.user_choice = cfg.roster?.[res.profile.type] ?? null;
  if (res.user_choice && !res.user_choice.none) {
    const chosen = choosePick(rosterPicks(res.user_choice), credits.rows, { installed: (h) => installedHarness(c, h) });
    res.user_pick = chosen.pick ? { ...chosen.pick, notes: chosen.notes } : null;
  }
  emit(c, flags, res, () => [
    `Routing — ${res.profile.label}`,
    !res.user_choice ? 'Nessuna scelta dell\'utente per questo lavoro: proponila con harma select.'
      : res.user_choice.none ? 'L\'utente ha scelto: nessun modello per questo lavoro.'
        : `Scelta dell'utente (harma select): ${describe(res.user_choice)}\n  ora dispatch --task-type ${res.profile.type} userebbe: ${res.user_pick ? `${describePick(res.user_pick)} (n.${res.user_pick.position})${res.user_pick.notes.length ? ` — ${res.user_pick.notes.join('; ')}` : ''}` : 'nessuno: tutti i modelli scelti sono senza crediti o non installati'}`,
    table(res.candidates.map((r, i) => ({ '#': i + 1, modello: `${r.harness}:${r.model}`, effort: r.effort, punteggio: r.score, motivi: r.why }))),
    res.candidates.length ? `\nPer avviarlo: harma dispatch --name <nome> --task-type ${res.profile.type} --model ${res.candidates[0].harness}:${res.candidates[0].model} --effort ${res.candidates[0].effort} --prompt "<compito>"` : '\nNessun candidato: abbassa min_index in .harma/config.json routing o controlla crediti e CLI.',
  ].join('\n'));
  return res;
}

function authorOf(spec, catalog) {
  const t = parseTarget(spec, catalog);
  return { ...t, provider: catalog.models?.[t.model]?.provider ?? null };
}

// 5b ─ dispatch ────────────────────────────────────────────────────────────
export async function cmdDispatch(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root, { required: true });
  checkAgentName(flags.name);
  const existing = agentsFromEvents(readEvents(c.root)).find((a) => a.name === flags.name && a.state === 'open');
  if (existing) throw new HarmaError(`L'agente ${flags.name} è già aperto`, { hint: 'Scegli un altro nome, o `harma send` per dargli altro lavoro' });

  let pick;
  if (flags.model) {
    const t = parseTarget(flags.model, c.catalog);
    pick = { harness: t.harness, model: t.model, effort: flags.effort ?? c.catalog.models?.[t.model]?.effort_default ?? null, why: 'scelto esplicitamente' };
  } else if (flags['task-type'] && cfg.roster?.[taskProfile(flags['task-type'], cfg)?.type]) {
    const type = taskProfile(flags['task-type'], cfg).type;
    const chosen = cfg.roster[type];
    if (chosen.none) throw new HarmaError(`Per ${type} l'utente ha scelto di non usare nessun modello`, { hint: 'Cambia la scelta con harma select, o passa --model esplicitamente' });
    const picks = rosterPicks(chosen);
    const inv = await currentInventory(c, cfg);
    const credits = await currentCredits(c, cfg, inv, opts);
    const { pick: p, rated, notes } = choosePick(picks, credits.rows, { installed: (h) => installedHarness(c, h) });
    if (!p) {
      throw new HarmaError(`Nessuno dei modelli scelti per ${type} è utilizzabile ora`, {
        hint: `${rated.map((r) => `n.${r.position} ${describePick(r)}: ${r.skip}`).join('; ')} — cambia la lista con harma select, o passa --model esplicitamente`,
      });
    }
    const where = picks.length > 1 ? `n.${p.position} di ${picks.length}` : 'unica';
    pick = { harness: p.harness, model: p.model, effort: flags.effort ?? p.effort, why: `scelta dell'utente per ${type} (harma select, ${chosen.source}; ${where}, crediti ${p.credit})${notes.length ? ` — ${notes.join('; ')}` : ''}` };
  } else {
    if (!flags['task-type']) throw new HarmaError('Serve --model <harness>:<model> oppure --task-type <tipo>');
    const inv = await currentInventory(c, cfg);
    const credits = await currentCredits(c, cfg, inv, opts);
    const res = route(flags['task-type'], { rankRows: rankRows(c.catalog, inv.models), credits: credits.rows, config: cfg, author: flags.author ? authorOf(flags.author, c.catalog) : null, top: 1 });
    if (!res?.candidates.length) throw new HarmaError(`Nessun modello adatto per ${flags['task-type']}`);
    pick = { ...res.candidates[0], why: `routing ${res.profile.type}: ${res.candidates[0].why}` };
  }
  const prompt = flags['prompt-file'] ? readFileSync(flags['prompt-file'], 'utf8') : flags.prompt ?? null;
  const machine = flags.machine ?? null;
  const backendChoice = flags.backend ?? (cfg.backend && cfg.backend !== 'auto' ? cfg.backend : null);
  // herdr drives only the CLIs it recognizes: any other one runs headless there.
  const autoHeadless = !flags.headless && !herdrKind(pick.harness) && Boolean(headlessOf(pick.harness)) && backendChoice !== 'hc';
  const headless = Boolean(flags.headless) || autoHeadless;
  if (headless && !headlessOf(pick.harness)) throw new HarmaError(`${pick.harness} non ha una modalità non interattiva nota a harma`);
  if (headless && !prompt) throw new HarmaError('Un lavoro non interattivo parte con il suo compito: passa --prompt o --prompt-file');
  if (machine) {
    if (backendChoice === 'hc') throw new HarmaError('--machine funziona con il backend herdr');
    if (headless) throw new HarmaError(`--machine non supporta i lavori non interattivi: ${autoHeadless ? `herdr non riconosce ${pick.harness} come agente` : 'togli --headless'}`);
    if (!/^(\/|~)/.test(flags.cwd ?? '')) throw new HarmaError('--machine richiede --cwd con la cartella del progetto su quella macchina', { hint: 'Un percorso assoluto o che inizia con ~, es. --cwd ~/work/progetto' });
  }
  const cwd = machine ? flags.cwd : resolve(flags.cwd ?? c.root);
  const spec = launchSpec(pick, c.catalog);
  const binary = which(spec.argv[0], c.env);
  if (!binary && !machine) {
    throw new HarmaError(`${spec.argv[0]} non è installato su questa macchina`, { hint: 'Vedi harma models per le CLI disponibili' });
  }
  const hs = headless ? headlessSpec(pick.harness, spec) : null;
  const notes = [...spec.notes];
  if (autoHeadless) notes.push(`herdr non riconosce ${pick.harness} come agente: lavoro non interattivo, un compito e una risposta`);
  if (machine) notes.push(`CLI e modelli non verificati su ${machine}: harma conosce solo quelli di questa macchina`);
  const plan = {
    agent: flags.name, task_type: flags['task-type'] ?? null,
    harness: pick.harness, model: pick.model, effort: pick.effort, why: pick.why,
    cwd, argv: hs ? hs.argv : spec.argv, env: spec.env, notes,
    mode: headless ? 'headless' : 'interactive', machine,
    prompt_chars: prompt?.length ?? 0, policy: cfg.dispatch_policy,
    layout: flags.worktree ? 'worktree' : (flags.layout ?? cfg.herdr?.layout ?? 'auto'),
    worktree: flags.worktree ? { branch: flags.branch ?? `harma/${flags.name}`, ...(flags.base ? { base: flags.base } : {}) } : null,
    trust: trustPolicy(cfg, readEvents(c.root)),
  };
  if (flags.base && !flags.worktree) throw new HarmaError('--base vale solo con --worktree', { hint: `harma dispatch --name ${flags.name} … --worktree --base ${flags.base}` });
  if (plan.worktree?.base && !machine) Object.assign(plan.worktree, await baseOf(c, plan.worktree.base));
  if (plan.worktree && !machine) {
    const check = await worktreeCheck(c, cfg, plan.worktree);
    plan.uncommitted = check.uncommitted;
    notes.push(...check.notes);
  }
  if (plan.worktree && machine && cfg.worktree_copy?.length) notes.push(`worktree_copy non si applica su ${machine}: i file restano su questa macchina`);
  const trustBy = headless ? 'non serve' : machine ? 'la dà l\'utente (altra macchina)'
    : plan.worktree?.base_own === false ? `la dà l'utente (${plan.worktree.base} non è in un branch del progetto)`
      : plan.trust === 'on' || (plan.trust === 'worktrees' && plan.worktree) ? `la dà harma (policy trust ${plan.trust})` : 'la dà l\'utente';

  const gate = await dispatchGate(c, cfg, pick.harness, flags, opts);
  if (!gate.allowed) {
    emit(c, flags, { needs_confirmation: true, reason: gate.reason, plan }, () => [
      'CONFERMA RICHIESTA — nessun agente è stato avviato.',
      `Motivo: ${gate.reason}`,
      `Agente ${plan.agent}: ${plan.harness}:${plan.model} @ ${plan.effort ?? 'default'} (${plan.why})`,
      `Comando: ${plan.argv.join(' ')}${hs ? ` ${promptHint(hs.prompt)}` : ''}${Object.keys(plan.env).length ? `  env ${JSON.stringify(plan.env)}` : ''}`,
      `Modo: ${headless ? 'non interattivo (un compito, una risposta; nessuno risponde alle richieste di permesso)' : 'interattivo'}${machine ? ` · macchina: ${machine}` : ''}`,
      `Dove: ${plan.worktree ? `worktree su branch ${plan.worktree.branch}${plan.worktree.base ? ` da ${plan.worktree.base}` : ''}` : `layout ${plan.layout}`} · fiducia nella cartella: ${trustBy}`,
      ...plan.notes.map((n) => `Nota: ${n}`),
      'Se l\'utente approva, ripeti lo stesso comando con --yes.',
    ].join('\n'));
    return { needsConfirmation: true, plan, exitCode: EXIT_NEEDS_CONFIRM };
  }

  if (pick.harness === 'agy' && pick.model === AGY_NEON && !machine) {
    const models = await agyModelIds(binary, c.env);
    if (!models.has(spec.modelId)) {
      throw new HarmaError(`agy models non espone ${spec.modelId}`, { hint: 'Verifica il livello e il piano Antigravity del tuo account' });
    }
  }
  const backend = opts.backend ?? await selectBackend({ choice: machine ? 'herdr' : flags.backend, config: cfg, env: c.env, machine });
  const project = projectId(c.root);
  const startedMs = Date.now();
  if (plan.worktree && backend.name !== 'herdr') throw new HarmaError('--worktree richiede il backend herdr');
  const layout = plan.layout === 'worktree' ? undefined : plan.layout;
  // Files git does not track (e.g. .env) go into a new worktree before the agent starts.
  const prepareWorktree = plan.worktree && !machine && cfg.worktree_copy?.length ? (path) => copyIntoWorktree(c.root, path, cfg.worktree_copy) : null;
  // Muse lists its running sessions: the agent's is the one that appears now.
  const museBefore = pick.harness === 'muse' && !headless && !machine ? (await museSessions(c.env)).map((x) => x.sessionId) : [];
  let runDir = null;
  let started;
  if (headless) {
    runDir = statePath(c.root, 'runs', `${flags.name}-${now().replace(/[:.]/g, '-')}`);
    mkdirSync(runDir, { recursive: true });
    ensureGitignore(c.root);
    const promptFile = join(runDir, 'prompt.md');
    writeFileSync(promptFile, prompt);
    const job = {
      name: flags.name, harness: pick.harness, model: pick.model, argv: hs.argv, env: spec.env,
      prompt: hs.prompt, prompt_file: promptFile, run_dir: runDir, cwd: null,
      report: backend.name === 'herdr', keep_alive: backend.name === 'herdr',
      session_id: spec.sessionId, resume_argv: resumeArgv(pick.harness, spec.sessionId),
      session_pattern: hs.sessionPattern?.source ?? null, timeout_sec: Number(flags['max-time'] ?? HEADLESS_MAX_SEC),
    };
    const jobFile = join(runDir, 'job.json');
    writeFileSync(jobFile, JSON.stringify(job, null, 2) + '\n');
    started = await backend.startHeadless({
      name: flags.name, cwd, root: c.root, project, layout, worktree: plan.worktree, prepareWorktree, command: [process.execPath, BIN, '_run', jobFile],
    });
  } else {
    started = await backend.start({
      name: flags.name, cwd, argv: spec.argv, env: spec.env, harness: pick.harness, root: c.root, project, layout, worktree: plan.worktree, prepareWorktree,
    });
  }
  rememberWorkspace(c, cfg, started);
  // Where the worktree started from, and whether that code is the project's own: maybeTrust reads it, and so does resume.
  if (started.worktree && plan.worktree?.base) {
    const { base, base_commit = null, base_own = null } = plan.worktree;
    Object.assign(started.worktree, { base, base_commit, base_own });
  }
  const agentCwd = started.cwd ?? cwd;
  appendEvent(c.root, {
    type: 'started', agent: flags.name, harness: pick.harness, model: pick.model, effort: pick.effort,
    task_type: flags['task-type'] ?? null, backend: backend.name, target: targetOf(started), mode: plan.mode, run_dir: runDir,
    cwd: agentCwd, worktree: started.worktree ?? null, session_id: spec.sessionId, why: pick.why, confirmed_by: gate.by, started_ms: startedMs,
    ...(museBefore.length ? { muse_before: museBefore } : {}),
  });
  if (flags.keep) appendEvent(c.root, { type: 'keep', agent: flags.name, on: true, by: 'dispatch --keep' });
  if (headless) return headlessStarted(c, flags, { plan, started, pick, backend, runDir, sid: spec.sessionId, prompt, pollMs: opts.pollMs });
  const trusted = await maybeTrust(c, cfg, backend, { agent: flags.name, harness: pick.harness, cwd: agentCwd, started });
  const look = { name: started.target, harness: pick.harness, cwd: agentCwd, sinceMs: startedMs, env: c.env, exclude: [...knownSessions(c.root), ...museBefore] };
  let sid = spec.sessionId ?? await discoverSession(backend, look);
  if (sid && sid !== spec.sessionId) appendEvent(c.root, { type: 'session', agent: flags.name, session_id: sid, source: sessionSource(backend, pick.harness) });
  let promptState = prompt ? 'sent' : 'none';
  let delivery = null;
  if (prompt) {
    try {
      delivery = await deliverTask(backend, started.target, prompt, { wait: Boolean(flags.wait), timeoutSec: Number(flags.timeout ?? 600), harness: pick.harness });
      if (delivery.delivered) appendEvent(c.root, { type: 'prompted', agent: flags.name, chars: prompt.length, retried: delivery.retried, ...unverified(delivery) });
      else {
        promptState = 'lost';
        keepAside(c, flags.name, prompt, `l'agente ${notTaken(delivery)}`);
      }
    } catch (e) {
      if (e.code !== 'agent_blocked') throw e;
      // Started and recorded, but waiting on a dialog (e.g. folder trust): the task waits for it.
      promptState = 'blocked';
      appendEvent(c.root, { type: 'blocked', agent: flags.name, detail: 'prompt non inviato: l\'agente aspetta un input' });
      keepAside(c, flags.name, prompt, 'l\'agente aspettava una risposta');
    }
  }
  if (!sid && promptState === 'sent') {
    // Codex registers its session on the first turn: look again now.
    sid = await discoverSession(backend, look);
    if (sid) appendEvent(c.root, { type: 'session', agent: flags.name, session_id: sid, source: sessionSource(backend, pick.harness) });
  } else if (sid && sid !== spec.sessionId && pick.harness === 'muse' && !machine) {
    // Found before the task went out: a Muse that restarted since (after updating itself) runs a new session.
    const fresh = await replacedMuseSession({ env: c.env, cwd: agentCwd, sid, exclude: look.exclude });
    if (fresh) {
      sid = fresh;
      appendEvent(c.root, { type: 'session', agent: flags.name, session_id: sid, source: sessionSource(backend, pick.harness) });
    }
  }
  const undelivered = promptState === 'blocked' || promptState === 'lost';
  const result = { started: true, plan, target: started, session_id: sid ?? null, prompt: promptState, delivery, pending: undelivered, keep: Boolean(flags.keep), trust: trusted, exitCode: undelivered ? EXIT_BLOCKED : 0 };
  emit(c, flags, result, () => [
    `Avviato ${flags.name}: ${pick.harness}:${pick.model} @ ${pick.effort ?? 'default'} su ${backend.name} (${where(started)})`,
    ...worktreeLines(started),
    ...(trusted ? [`Fiducia nella cartella: ${trusted.ok ? `data da harma (policy trust ${trustPolicy(cfg, readEvents(c.root))})` : `non data — ${trusted.detail}`}`] : []),
    `Sessione: ${sid ?? 'non ancora nota (verrà letta alla chiusura)'}`,
    promptState === 'sent' ? `Compito consegnato (${prompt.length} caratteri)${retryNote(delivery)}${flags.wait ? '; atteso fino a stato stabile' : ''}.`
      : promptState === 'blocked' ? `BLOCCATO: ${flags.name} aspetta una risposta (es. fiducia nella cartella) e il compito NON è stato consegnato: harma lo tiene da parte.\nLeggi con: harma read ${flags.name} --lines 40. Il dialogo di fiducia nella cartella segue harma trust: chiedi all'utente di rispondere nel suo terminale. Un'altra domanda: harma answer ${flags.name} (policy answers ${answerPolicy(cfg)}). Poi harma wait ${flags.name} consegna il compito appena l'agente è libero (oppure harma send ${flags.name} --pending).`
        : promptState === 'lost' ? `COMPITO NON PARTITO: ${flags.name} ${notTaken(delivery)}; harma tiene da parte il compito.\nLeggi lo schermo con harma read ${flags.name} --lines 40, poi harma send ${flags.name} --pending.`
          : 'Nessun compito inviato: usa harma send.',
    ...(flags.keep ? [`Tenuto: harma cleanup non chiude ${flags.name} finché non lo nomini (harma keep ${flags.name} --off per togliere il segno).`] : []),
    ...plan.notes.map((n) => `Nota: ${n}`),
  ].join('\n'));
  return result;
}

/** What the event log keeps of a started terminal. */
function targetOf(started) {
  return {
    name: started.target, tab: started.tab ?? null, pane: started.pane ?? null, address: started.address ?? null,
    layout: started.layout ?? null, workspace: started.workspace ?? null, machine: started.machine ?? null,
  };
}

function worktreeLines(started) {
  const w = started.worktree;
  if (!w) return [];
  return [
    `Worktree: ${w.path} (branch ${w.branch}${w.base ? `, da ${w.base}` : ''})`,
    ...(w.base_own === false ? [`Fiducia nella cartella: ${w.base} non è in un branch del progetto, quindi il dialogo di fiducia lo lascia all'utente`] : []),
    ...(w.copy?.copied.length ? [`Copiati nel worktree: ${w.copy.copied.join(', ')}`] : []),
    ...(w.copy?.skipped.length ? [`Non copiati: ${w.copy.skipped.join('; ')}`] : []),
  ];
}

/**
 * Before a worktree: what the agent won't find there. It starts from the last
 * commit, so uncommitted changes stay behind (harma's own .harma/ excepted),
 * and files git ignores, such as .env, are missing unless worktree_copy lists them.
 */
async function worktreeCheck(c, cfg, worktree = {}) {
  const notes = [];
  if (worktree.base) notes.push(`il worktree parte da ${worktree.base} (${String(worktree.base_commit ?? '').slice(0, 7)}), non dal lavoro nella cartella del progetto`);
  if (!which('git', c.env)) return { uncommitted: null, notes };
  const st = await run('git', ['-C', c.root, 'status', '--porcelain', '--untracked-files=all'], { env: c.env });
  if (!st.ok) return { uncommitted: null, notes };
  const lines = st.stdout.split('\n').filter(Boolean).filter((l) => !l.slice(3).startsWith('.harma/'));
  const untracked = lines.filter((l) => l.startsWith('??')).length;
  const changed = lines.length - untracked;
  if ((changed || untracked) && !worktree.base) {
    const parts = [changed ? `${changed} file modificati` : null, untracked ? `${untracked} file nuovi` : null].filter(Boolean).join(' e ');
    notes.push(`il worktree parte dall'ultimo commit: ${parts} non committati non ci saranno. Se all'agente servono, committali prima; per una review del lavoro in corso, non usare --worktree`);
  }
  const env = await run('git', ['-C', c.root, 'ls-files', '--others', '--', '.env*'], { env: c.env });
  const copy = cfg.worktree_copy ?? [];
  const missing = env.ok ? env.stdout.split('\n').filter((f) => f && !f.includes('/') && !copy.includes(f)) : [];
  if (missing.length) notes.push(`${missing.join(', ')}: git non li traccia, quindi nel worktree mancheranno. Per copiarli in ogni worktree: harma worktree --copy "${[...copy, ...missing].join(',')}"`);
  return { uncommitted: { changed, untracked }, notes };
}

/**
 * The commit a worktree starts from (--base), and whether it is the
 * project's own: already in a branch on origin, in a tag, or in a local
 * branch that doesn't track another remote and isn't a worktree harma made
 * from foreign code. A pull request from a fork (refs/pull/…, another
 * remote, the branch gh pr checkout makes for it) is not: when the agent's
 * CLI trusts the folder, that code can load hooks and settings.
 */
async function baseOf(c, ref) {
  if (!which('git', c.env)) throw new HarmaError('--base richiede git');
  const sha = await run('git', ['-C', c.root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { env: c.env });
  const commit = sha.ok ? sha.stdout.trim() : '';
  if (!commit) {
    throw new HarmaError(`--base: ${ref} non è un commit di questo repository`, {
      hint: 'Per il branch di una pull request: git fetch origin <branch>, poi --base origin/<branch>',
    });
  }
  const foreign = new Set(agentsFromEvents(readEvents(c.root)).filter((a) => a.worktree?.base_own === false).map((a) => `refs/heads/${a.worktree.branch}`));
  const refs = await run('git', ['-C', c.root, 'for-each-ref', '--contains', commit, '--format=%(refname)%09%(upstream:remotename)', 'refs/heads', 'refs/remotes/origin', 'refs/tags'], { env: c.env });
  const own = refs.ok && refs.stdout.split('\n').filter(Boolean).some((line) => {
    const [name, remote = ''] = line.split('\t');
    if (name.startsWith('refs/remotes/origin/') || name.startsWith('refs/tags/')) return true;
    return name.startsWith('refs/heads/') && ['', 'origin'].includes(remote) && !foreign.has(name);
  });
  return { base_commit: commit, base_own: own };
}

/** Copy the listed paths from the project into a new worktree; never overwrite a file already there. */
export function copyIntoWorktree(root, dest, list) {
  const copied = [];
  const skipped = [];
  for (const rel of list) {
    const from = join(root, rel);
    const to = join(dest, rel);
    if (!existsSync(from)) { skipped.push(`${rel} (non c'è nel progetto)`); continue; }
    const folder = statSync(from).isDirectory();
    if (!folder && existsSync(to)) { skipped.push(`${rel} (già nel worktree)`); continue; }
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
    copied.push(rel);
  }
  return { copied, skipped };
}

/** harma worktree [--copy "a,b"]: what harma copies into each worktree it creates. */
export async function cmdWorktree(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root, { required: true });
  if (flags.copy !== undefined) {
    cfg.worktree_copy = parseCopyList(flags.copy);
    saveConfig(c.root, cfg);
    appendEvent(c.root, { type: 'worktree_copy', value: cfg.worktree_copy, by: 'utente (harma worktree --copy)' });
  }
  const data = { copy: cfg.worktree_copy ?? [] };
  emit(c, flags, data, () => (data.copy.length
    ? `In ogni worktree che harma crea copia dal progetto: ${data.copy.join(', ')} (mai sopra un file già presente). Per non copiare niente: harma worktree --copy ""`
    : 'harma non copia niente nei worktree che crea. Per copiare file che git non traccia, come .env: harma worktree --copy ".env,.env.local"'));
  return data;
}

/** A workspace harma just created: remember it, per machine, so the next agents join it. */
function rememberWorkspace(c, cfg, started) {
  if (!started.workspaceCreated) return;
  cfg.herdr = { ...(cfg.herdr ?? {}) };
  if (started.machine) cfg.herdr.machines = { ...(cfg.herdr.machines ?? {}), [started.machine]: { workspace_id: started.workspace } };
  else cfg.herdr.workspace_id = started.workspace;
  saveConfig(c.root, cfg);
}

const promptHint = (p) => (p.via === 'stdin' ? '< prompt.md' : p.via === 'file' ? `${p.flag} prompt.md` : `${p.flag} "<compito>"`);

/** A headless job's result.json, once the runner has finished. */
function runResult(a) {
  return a.run_dir ? readJson(join(a.run_dir, 'result.json')) : null;
}

function resultLabel(r) {
  if (r.error) return `non partito: ${r.error}`;
  if (r.timed_out) return 'fermato (tempo massimo)';
  return r.exit_code === 0 ? 'done' : `errore (exit ${r.exit_code ?? r.signal})`;
}

/** After a headless start: optionally wait for the answer, then report. */
async function headlessStarted(c, flags, { plan, started, pick, backend, runDir, sid, prompt, pollMs = 1000 }) {
  let result = null;
  if (flags.wait) {
    const deadline = Date.now() + Number(flags.timeout ?? 600) * 1000;
    while (!(result = runResult({ run_dir: runDir })) && Date.now() < deadline) await new Promise((r) => setTimeout(r, pollMs));
  }
  appendEvent(c.root, { type: 'prompted', agent: flags.name, chars: prompt.length });
  if (result?.session_id && result.session_id !== sid) appendEvent(c.root, { type: 'session', agent: flags.name, session_id: result.session_id, source: 'harma _run' });
  const output = join(runDir, 'output.md');
  const answer = result ? readFileSync(output, 'utf8') : null;
  const data = { started: true, plan, target: started, mode: 'headless', session_id: result?.session_id ?? sid ?? null, output, result, answer, exitCode: 0 };
  emit(c, flags, data, () => [
    `Avviato ${flags.name} (non interattivo): ${pick.harness}:${pick.model} @ ${pick.effort ?? 'default'} su ${backend.name} (${where(started)})`,
    ...worktreeLines(started),
    `Compito inviato (${prompt.length} caratteri). Risposta in ${output}`,
    ...(flags.wait ? [result ? `Esito: ${resultLabel(result)}` : `Ancora in corso dopo ${flags.timeout ?? 600} s: leggi più tardi con harma read ${flags.name}`] : [`Leggi la risposta con: harma read ${flags.name}`]),
    ...plan.notes.map((n) => `Nota: ${n}`),
    ...(answer !== null ? ['', answer.trimEnd()] : []),
  ].join('\n'));
  return data;
}

function where(started) {
  if (started.machine) return `tab ${started.tab} su ${started.machine}`;
  if (started.layout === 'split') return `pane ${started.pane} accanto all'orchestratore`;
  if (started.layout === 'tab') return `tab ${started.tab} nel workspace dell'orchestratore`;
  if (started.layout === 'worktree') return `tab ${started.tab} nel workspace del worktree`;
  return started.tab ?? started.address ?? started.target;
}

/**
 * Started but blocked: as the project's trust policy allows, answer the
 * folder-trust dialog (and only that one) for the agent's own worktree or,
 * with "on", the project folder. Returns null when nothing was attempted.
 */
async function maybeTrust(c, cfg, backend, { agent, harness, cwd, started }) {
  const level = trustPolicy(cfg, readEvents(c.root));
  if (!started.blocked || level === 'off' || started.machine || typeof backend.answerTrust !== 'function') return null;
  const wt = started.worktree?.path ?? null;
  if (level === 'worktrees' && !wt) return null; // the project folder stays with the user
  // A worktree from code that isn't the project's own (a fork's pull request) stays with the user, under any policy.
  const foreign = wt && started.worktree.base && started.worktree.base_own !== true;
  const allowed = !foreign && (level === 'on' ? trustableFolder(cwd, c.root, wt) : trustableFolder(cwd, wt));
  // The dialog is the CLI's own: a Claude Code variant (claude-zai, …) shows Claude Code's.
  const res = allowed
    ? await backend.answerTrust({ target: started.target, harness: herdrKind(harness) ?? harness, cwd })
    : foreign ? { ok: false, detail: `il worktree parte da ${started.worktree.base}, che non è in un branch del progetto: la fiducia la dà l'utente` }
      : { ok: false, detail: `${cwd} è fuori ${level === 'on' ? 'dal progetto' : 'dal worktree dell\'agente'}` };
  appendEvent(c.root, { type: res.ok ? 'trusted' : 'trust_skipped', agent, cwd, detail: res.detail, by: `policy trust ${level}` });
  if (res.ok) started.blocked = false;
  return res;
}

/** Policy check. confirm: only --yes. auto-within-budget: provider credits ok/ampio. */
async function dispatchGate(c, cfg, harness, flags, opts) {
  if (flags.yes) return { allowed: true, by: 'utente (--yes)' };
  if (cfg.dispatch_policy !== 'auto-within-budget') {
    return { allowed: false, reason: 'policy "confirm": ogni avvio di agente richiede il consenso esplicito dell\'utente' };
  }
  const inv = await currentInventory(c, cfg);
  const credits = await currentCredits(c, cfg, inv, opts);
  const row = credits.rows.find((r) => r.harness === harness);
  if (row && ['ok', 'ampio'].includes(row.status)) return { allowed: true, by: `policy auto-within-budget (crediti ${row.status})` };
  return { allowed: false, reason: `policy auto-within-budget: crediti ${harness} ${row?.status ?? 'sconosciuti'}` };
}

async function discoverSession(backend, { name, harness, cwd, sinceMs, env, exclude = [] }) {
  if (backend.name === 'herdr') {
    try {
      const live = (await backend.list()).find((a) => a.name === name || a.target === name);
      if (live?.sessionId) return live.sessionId;
    } catch { /* fall through */ }
  }
  // Codex's logs and Muse's session list are on this machine: no use for an agent on another one.
  if (harness === 'codex' && !backend.machine) return findCodexSession({ env, cwd, sinceMs });
  if (harness === 'muse' && !backend.machine) return findMuseSession({ env, cwd, exclude });
  return null;
}

const sessionSource = (backend, harness) => (harness === 'muse' ? 'muse sessions' : backend.name);

/** Every session ID in the registry: an agent's new session is none of these. */
function knownSessions(root) {
  return agentsFromEvents(readEvents(root)).map((a) => a.session_id).filter(Boolean);
}

/**
 * Send a task to an interactive agent. On herdr harma checks that the agent
 * took it (see HerdrBackend.deliver); hc only sends.
 * Returns {delivered, state, retried}.
 */
async function deliverTask(backend, target, text, { wait = false, timeoutSec = 600, harness = null } = {}) {
  if (typeof backend.deliver !== 'function') {
    await backend.prompt(target, text, { wait, timeoutSec });
    return { delivered: true, state: null, retried: null, verified: null };
  }
  const res = await backend.deliver(target, text, { kind: harness ? herdrKind(harness) : null });
  res.command = isCliCommand(text);
  if (res.delivered && wait) res.state = await backend.waitStopped(target, timeoutSec) ?? res.state;
  return res;
}

function retryNote(d) {
  const notes = [];
  if (d?.retried === 'enter') notes.push('il primo Invio non era arrivato, harma l\'ha ripetuto');
  if (d?.retried === 'text') notes.push('l\'agente aveva perso il testo (es. si è riavviato dopo un aggiornamento) e harma l\'ha rimandato');
  if (d?.verified === false) {
    notes.push(d.state === 'unknown' && !d.command
      ? 'herdr non legge lo stato di quest\'agente: il testo è sullo schermo, ma che sia partito non è verificato'
      : 'un comando della CLI può non avviare un turno: inviato una volta, senza controllo');
  }
  return notes.length ? `: ${notes.join('; ')}` : '';
}

/** A delivery herdr's state could not confirm, as the registry records it. */
const unverified = (d) => (d?.verified === false ? { verified: false } : {});

/** Why a task did not reach its agent, after "<agent> ": it stayed where it was, or herdr no longer has it. */
const notTaken = (d) => (d?.state === 'chiuso' ? 'non è più in herdr' : 'è rimasto fermo anche dopo il secondo invio');

/** A task that did not reach its agent: kept in .harma/prompts/ until harma wait or send --pending delivers it. */
function keepAside(c, name, text, reason) {
  const dir = statePath(c.root, 'prompts');
  mkdirSync(dir, { recursive: true });
  ensureGitignore(c.root);
  const file = join(dir, `${name}-${now().replace(/[:.]/g, '-')}.md`);
  writeFileSync(file, text);
  appendEvent(c.root, { type: 'pending', agent: name, file, chars: text.length, reason });
  return file;
}

/**
 * The text of a task kept aside, or null when its file is gone (git clean -X
 * removes what git ignores). In a project folder that has moved, the file is
 * looked for under the new path.
 */
function pendingText(c, p) {
  return readText(p.file) ?? readText(statePath(c.root, 'prompts', basename(p.file)));
}

/** Is the harma that wrote this claim still running? */
function holderAlive(lock) {
  try {
    process.kill(Number(readFileSync(lock, 'utf8').trim()), 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // running, as another user
  }
}

/**
 * Hold an agent's task kept aside while it goes out, so that a harma wait in
 * the background and a harma send don't both deliver it. Returns
 * {pending, release} with the task as the registry has it now, {busy: true}
 * while another harma holds it, or null when nothing is kept aside any more.
 */
function claimPending(c, name) {
  const pendingNow = () => agentsFromEvents(readEvents(c.root)).find((x) => x.name === name)?.pending ?? null;
  if (!pendingNow()) return null;
  const dir = statePath(c.root, 'prompts');
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, `${name}.sending`);
  try {
    writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (holderAlive(lock)) return { busy: true };
    writeFileSync(lock, `${process.pid}\n`); // left by a harma that ended mid-delivery
  }
  const release = () => rmSync(lock, { force: true });
  // Read again under the claim: a delivery that ended just before it has cleared the task.
  const pending = pendingNow();
  if (!pending) { release(); return null; }
  return { pending, release };
}

/**
 * A terminal one listing doesn't show may still be there: herdr between two
 * detections of the agent (Muse restarting after an update), or an hc label
 * that no longer matches because the project folder moved. Ask the backend
 * for that one terminal before recording it closed.
 */
async function reallyGone(c, cfg, a, opts) {
  const b = backendOf(c, cfg, a, opts);
  try {
    if (typeof b.agentInfo === 'function') return !(await b.agentInfo(a.target?.name ?? a.name));
    return !findLive(a, await b.list());
  } catch {
    return false;
  }
}

// send / read ──────────────────────────────────────────────────────────────
export async function cmdSend(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root, { required: true });
  const [name, ...rest] = flags._;
  const agent = openAgent(c, name);
  if (agent.mode === 'headless') {
    throw new HarmaError(`${name} è un lavoro non interattivo: ha già il suo compito e non riceve altri messaggi`, {
      hint: `Leggi la risposta con harma read ${name}; per continuare la conversazione: harma cleanup --agent ${name}, poi harma resume ${name}`,
    });
  }
  const fromPending = Boolean(flags.pending);
  if (fromPending && (rest.length || flags['prompt-file'])) throw new HarmaError('--pending manda il compito tenuto da parte: non passare altro testo');
  if (fromPending && !agent.pending) throw new HarmaError(`${name} non ha un compito tenuto da parte`, { hint: 'Vedi harma status, colonna compito' });
  let text = fromPending ? null : flags['prompt-file'] ? readFileSync(flags['prompt-file'], 'utf8') : rest.join(' ');
  if (!fromPending && !text) throw new HarmaError('Manca il testo da inviare');
  // A task kept aside was approved when it was dispatched or sent: it needs no new yes.
  const gate = fromPending ? { allowed: true, by: 'consenso già dato a quel compito' } : await dispatchGate(c, cfg, agent.harness, flags, opts);
  if (!gate.allowed) {
    emit(c, flags, { needs_confirmation: true, reason: gate.reason, agent: name, chars: text.length }, () =>
      `CONFERMA RICHIESTA — nulla è stato inviato a ${name}.\nMotivo: ${gate.reason}\nSe l'utente approva, ripeti con --yes.`);
    return { needsConfirmation: true, exitCode: EXIT_NEEDS_CONFIRM };
  }
  // A task kept aside goes out once: a harma wait in the background may be delivering it right now.
  const held = agent.pending ? claimPending(c, name) : null;
  if (held?.busy) {
    throw new HarmaError(`Il compito tenuto da parte per ${name} sta partendo ora con un altro harma (harma wait)`, {
      hint: `Vedi harma status, colonna compito${fromPending ? '' : `; poi ripeti harma send ${name}`}`,
    });
  }
  try {
    const kept = held?.pending ?? null; // the task kept aside now, if any
    if (fromPending) {
      if (!kept) throw new HarmaError(`${name} non ha più un compito tenuto da parte: è appena stato consegnato`, { hint: 'Vedi harma status, colonna compito' });
      text = pendingText(c, kept);
      if (text == null) {
        throw new HarmaError(`Il compito tenuto da parte per ${name} non c'è più: manca il file ${kept.file}`, {
          hint: `Rimandalo con harma send ${name} "<compito>" --yes: sostituisce quello tenuto da parte`,
        });
      }
      if (!text) throw new HarmaError('Manca il testo da inviare');
    }
    const replaced = fromPending ? null : kept;
    const replacedNote = replaced ? ` Sostituisce il compito tenuto da parte prima (${replaced.chars} caratteri, in ${replaced.file}).` : '';
    const backend = opts.backend ?? backendFor(agent, cfg, c.env);
    let delivery;
    try {
      delivery = await deliverTask(backend, agent.target?.name ?? name, text, { wait: Boolean(flags.wait), timeoutSec: Number(flags.timeout ?? 600), harness: agent.harness });
    } catch (e) {
      if (e.code !== 'agent_blocked') throw e;
      if (!fromPending) keepAside(c, name, text, 'l\'agente aspettava una risposta');
      throw new HarmaError(`${name} aspetta una risposta: il messaggio NON è stato consegnato, harma lo tiene da parte.${replacedNote}`, {
        exitCode: EXIT_BLOCKED,
        hint: `Leggi la domanda con harma read ${name} --lines 40 e rispondi con harma answer ${name} --kind question|permission …; poi harma wait ${name} consegna il messaggio (oppure harma send ${name} --pending)`,
      });
    }
    if (!delivery.delivered) {
      if (!fromPending) keepAside(c, name, text, `l'agente ${notTaken(delivery)}`);
      throw new HarmaError(`${name} ${notTaken(delivery)}: il messaggio non è partito, harma lo tiene da parte.${replacedNote}`, {
        exitCode: EXIT_BLOCKED, hint: `Leggi lo schermo con harma read ${name} --lines 40, poi harma send ${name} --pending`,
      });
    }
    appendEvent(c.root, { type: 'prompted', agent: name, chars: text.length, confirmed_by: gate.by, retried: delivery.retried, pending: fromPending, ...unverified(delivery) });
    const data = { sent: true, state: delivery.state, retried: delivery.retried, verified: delivery.verified ?? null, replaced_pending: replaced?.file ?? null };
    emit(c, flags, data, () => [
      `Consegnato a ${name} (${text.length} caratteri${fromPending ? ', il compito tenuto da parte' : ''})${retryNote(delivery)}.`,
      ...(replaced ? [`Nota: il compito tenuto da parte (${replaced.chars} caratteri) non verrà più consegnato: questo messaggio lo sostituisce. Se serve ancora: harma send ${name} --prompt-file ${replaced.file} --yes`] : []),
    ].join('\n'));
    return data;
  } finally {
    held?.release?.();
  }
}

/** Mark an open agent so that cleanup leaves it open until it is named, or unmark it. */
export async function cmdKeep(flags, opts = {}) {
  const c = ctx(opts);
  loadConfig(c.root, { required: true });
  const name = flags._[0];
  openAgent(c, name);
  const on = !flags.off;
  appendEvent(c.root, { type: 'keep', agent: name, on, by: on ? 'harma keep' : 'harma keep --off' });
  emit(c, flags, { agent: name, keep: on }, () => (on
    ? `${name} resta aperto: harma cleanup lo salta finché non lo nomini (cleanup --agent ${name}) o non togli il segno (harma keep ${name} --off).`
    : `${name} non è più tenuto: harma cleanup lo chiude quando ha finito.`));
  return { agent: name, keep: on };
}

/**
 * Wait until agents stop: idle or done at two checks in a row, a headless
 * job with its result, or a terminal that is gone. A task kept aside is
 * delivered as soon as its agent is free. An agent that waits on a question
 * or a permission ends the wait (exit 4), so the orchestrator can answer;
 * the folder-trust dialog doesn't, since the user answers it.
 */
export async function cmdWait(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root, { required: true });
  const known = agentsFromEvents(readEvents(c.root));
  // A named agent that closed meanwhile has stopped: only a name harma doesn't know is an error.
  for (const n of flags._) {
    if (!known.some((a) => a.name === n)) throw new HarmaError(`Agente sconosciuto: ${n}`, { hint: 'Vedi harma status' });
  }
  const names = flags._.length ? flags._ : known.filter((a) => a.state === 'open').map((a) => a.name);
  if (!names.length) {
    emit(c, flags, { agents: [] }, () => 'Nessun agente aperto.');
    return { agents: [] };
  }
  const timeoutSec = Number(flags.timeout ?? 540);
  if (!Number.isFinite(timeoutSec) || timeoutSec < 0) throw new HarmaError(`--timeout vuole i secondi, es. --timeout 540 (non «${flags.timeout}»)`);
  const pollMs = opts.pollMs ?? 5000;
  const deadline = Date.now() + timeoutSec * 1000;
  const calm = {};
  let rows;
  for (let first = true; ; first = false) {
    // The last look falls on the deadline, not after it.
    if (!first) await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
    const agents = agentsFromEvents(readEvents(c.root)).filter((a) => names.includes(a.name));
    const live = await liveByBackend(c, cfg, agents, opts);
    rows = [];
    for (const a of agents) rows.push(await waitRow(c, cfg, a, live, calm, opts));
    const act = rows.filter((r) => r.act);
    const done = flags.any ? rows.some((r) => r.stopped) : rows.every((r) => r.stopped);
    if (act.length || done || Date.now() >= deadline) break;
  }
  const act = rows.filter((r) => r.act);
  const busy = rows.filter((r) => !r.stopped);
  const exitCode = act.length ? EXIT_BLOCKED : (flags.any ? rows.some((r) => r.stopped) : !busy.length) ? 0 : EXIT_STILL_WORKING;
  const data = { agents: rows, timed_out: exitCode === EXIT_STILL_WORKING, exitCode };
  // Out of time: who still works, and who has not stopped for another reason (the user's trust dialog, an unreachable backend).
  const working = busy.filter((r) => r.state === 'working');
  const other = busy.filter((r) => r.state !== 'working');
  emit(c, flags, data, () => [
    table(rows.map((r) => ({ agente: r.agent, stato: r.state, nota: r.note ?? '' }))),
    ...act.map((r) => r.next),
    ...(exitCode === EXIT_STILL_WORKING ? [
      ...(working.length ? [`Dopo ${timeoutSec} s lavorano ancora: ${working.map((r) => r.agent).join(', ')}.`] : []),
      ...(other.length ? [`Dopo ${timeoutSec} s non si sono ancora fermati: ${other.map((r) => `${r.agent} (${r.note ?? r.state})`).join(', ')}.`] : []),
      'Ripeti harma wait per continuare ad aspettare.',
    ] : []),
  ].join('\n'));
  return data;
}

/** One agent's line in harma wait: {agent, state, stopped, act, note, next}. */
async function waitRow(c, cfg, a, live, calm, opts) {
  const row = (state, extra = {}) => ({ agent: a.name, state, stopped: false, act: false, note: null, next: null, ...extra });
  if (a.state !== 'open') return row('chiuso', { stopped: true });
  const list = live[liveKey(a)];
  if (!list) return row('backend non raggiungibile');
  if (!findLive(a, list)) {
    if (!(await reallyGone(c, cfg, a, opts))) return row('non trovato', { note: 'non elencato dal backend, ma ancora lì' });
    closeGone(c, a);
    return row('chiuso', { stopped: true, note: 'terminale chiuso fuori da harma' });
  }
  const state = statusOf(a, live);
  if (a.mode === 'headless') return row(state, { stopped: Boolean(runResult(a)) });
  const backend = backendOf(c, cfg, a, opts);
  const target = a.target?.name ?? a.name;
  const kind = herdrKind(a.harness);
  // The folder-trust dialog is the user's: the wait goes on through it.
  const onTrustDialog = async () => Boolean(kind && typeof backend.screen === 'function' && readTrustDialog(kind, await backend.screen(target), a.cwd).dialog);
  const userTrusts = () => {
    calm[a.name] = 0;
    return row('blocked', { note: 'aspetta che l\'utente dia fiducia alla cartella' });
  };
  if (state === 'blocked') {
    if (await onTrustDialog()) return userTrusts();
    return row(state, {
      stopped: true, act: true, note: 'aspetta una risposta',
      next: `${a.name} aspetta una risposta: leggila con harma read ${a.name} --lines 40 e rispondi con harma answer ${a.name} (policy answers ${answerPolicy(cfg)}).${a.pending ? ' Il compito tenuto da parte parte dopo, con harma wait.' : ''}`,
    });
  }
  if (['idle', 'done'].includes(state) && a.pending?.tried) {
    // One automatic try: an agent that didn't take the task then won't take it on every wait.
    return row(state, {
      stopped: true, act: true, note: 'compito tenuto da parte: harma wait l\'ha già provato',
      next: `${a.name} non ha preso il compito tenuto da parte nemmeno con harma wait: leggi lo schermo con harma read ${a.name} --lines 40; quando è pronto, harma send ${a.name} --pending.`,
    });
  }
  if (['idle', 'done'].includes(state) && a.pending) {
    const held = claimPending(c, a.name);
    if (held?.busy) return row(state, { note: 'compito tenuto da parte: sta partendo con un altro harma' });
    if (!held) {
      calm[a.name] = 0;
      return row(state, { note: 'compito tenuto da parte già consegnato' });
    }
    try {
      const text = pendingText(c, held.pending);
      if (text == null) {
        return row(state, {
          stopped: true, act: true, note: 'compito tenuto da parte perso',
          next: `Il compito tenuto da parte per ${a.name} non c'è più (manca ${held.pending.file}): rimandalo con harma send ${a.name} "<compito>" --yes, che lo sostituisce.`,
        });
      }
      const d = await deliverTask(backend, target, text, { harness: a.harness });
      if (!d.delivered) {
        appendEvent(c.root, { type: 'undelivered', agent: a.name, state: d.state, by: 'harma wait' });
        return row(state, { stopped: true, act: true, note: 'compito non partito', next: `${a.name} ${notTaken(d)}: leggi lo schermo con harma read ${a.name} --lines 40, poi harma send ${a.name} --pending.` });
      }
      appendEvent(c.root, { type: 'prompted', agent: a.name, chars: held.pending.chars, confirmed_by: 'consenso già dato a quel compito', retried: d.retried, pending: true, by: 'harma wait', ...unverified(d) });
      calm[a.name] = 0;
      return row(d.state, { note: `compito consegnato${retryNote(d)}` });
    } catch (e) {
      if (e.code === 'agent_blocked') {
        if (await onTrustDialog()) return userTrusts();
        return row('blocked', { stopped: true, act: true, note: 'aspetta una risposta', next: `${a.name} aspetta una risposta: harma read ${a.name} --lines 40, poi harma answer ${a.name}.` });
      }
      if (!(e instanceof HarmaError)) throw e;
      // One agent's backend error doesn't end the wait for the others.
      return row(state, { stopped: true, act: true, note: 'consegna fallita', next: `${a.name}: il compito tenuto da parte non è partito (${e.message}). Leggi lo schermo con harma read ${a.name} --lines 40, poi harma send ${a.name} --pending.` });
    } finally {
      held.release();
    }
  }
  const still = ['idle', 'done', 'finished'].includes(state);
  calm[a.name] = still ? (calm[a.name] ?? 0) + 1 : 0;
  return row(state, { stopped: calm[a.name] >= 2 });
}

/** The backend object for an agent: the one passed in (tests), when it matches, else the agent's own. */
function backendOf(c, cfg, a, opts) {
  return opts.backend?.name === a.backend && (opts.backend.machine ?? null) === (a.target?.machine ?? null) ? opts.backend : backendFor(a, cfg, c.env);
}

/**
 * A terminal closed outside harma (herdr answers and no longer has it): the
 * registry records it closed, with the session ID if harma can still find one.
 */
function closeGone(c, a) {
  const sid = a.session_id ?? (a.harness === 'codex' && !a.target?.machine ? findCodexSession({ env: c.env, cwd: a.cwd, sinceMs: Date.parse(a.started_at) }) : null);
  if (sid && sid !== a.session_id) appendEvent(c.root, { type: 'session', agent: a.name, session_id: sid, source: 'log codex' });
  appendEvent(c.root, { type: 'closed', agent: a.name, session_id: sid ?? null, last_status: 'non trovato', by: 'fuori da harma' });
}

export async function cmdRead(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root, { required: true });
  const agent = openAgent(c, flags._[0]);
  if (agent.mode === 'headless') return readHeadless(c, flags, agent);
  const backend = opts.backend ?? backendFor(agent, cfg, c.env);
  const text = await backend.read(agent.target?.name ?? agent.name, Number(flags.lines ?? 120));
  c.out(text);
  return text;
}

/** A headless job's answer: the whole file, or its last --lines lines. */
function readHeadless(c, flags, agent) {
  const result = runResult(agent);
  let text = '';
  try { text = readFileSync(join(agent.run_dir, 'output.md'), 'utf8'); } catch { /* not written yet */ }
  if (flags.lines) text = text.split('\n').slice(-Number(flags.lines)).join('\n');
  const head = result ? `(${agent.name}: ${resultLabel(result)})` : `(${agent.name}: in corso, risposta parziale)`;
  c.out(`${head}\n${text}`);
  return text;
}

function openAgent(c, name) {
  if (!name) throw new HarmaError('Manca il nome dell\'agente');
  const a = agentsFromEvents(readEvents(c.root)).find((x) => x.name === name);
  if (!a) throw new HarmaError(`Agente sconosciuto: ${name}`, { hint: 'Vedi harma status' });
  if (a.state !== 'open') throw new HarmaError(`L'agente ${name} è chiuso`, { hint: `harma resume ${name}` });
  return a;
}

/** The backend that drives a registered agent: its own, on its machine. */
function backendFor(agent, cfg, env) {
  return agent.backend === 'hc' ? new HcBackend({ env }) : new HerdrBackend({ env, config: cfg, machine: agent.target?.machine ?? null });
}

/** Agents on one backend and machine share one live listing. */
const liveKey = (a) => (a.target?.machine ? `${a.backend}@${a.target.machine}` : a.backend);

/** Live status: a finished headless job reports its result, whatever its terminal says. */
function statusOf(a, live) {
  const r = a.mode === 'headless' ? runResult(a) : null;
  if (r) return resultLabel(r);
  const l = findLive(a, live[liveKey(a)]);
  return l ? (l.status ?? 'nessuno stato') : (live[liveKey(a)] ? 'non trovato' : 'backend non raggiungibile');
}

// 6 ─ monitoring ───────────────────────────────────────────────────────────
export async function cmdStatus(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root, { required: true });
  let agents = agentsFromEvents(readEvents(c.root));
  const live = await liveByBackend(c, cfg, agents, opts);
  const gone = [];
  for (const a of agents.filter((x) => x.state === 'open' && live[liveKey(x)] && !findLive(x, live[liveKey(x)]))) {
    if (await reallyGone(c, cfg, a, opts)) gone.push(a);
  }
  for (const a of gone) closeGone(c, a);
  if (gone.length) agents = agentsFromEvents(readEvents(c.root));
  const rows = agents.filter((a) => flags.all || a.state === 'open' || gone.some((g) => g.name === a.name)).map((a) => {
    const l = findLive(a, live[liveKey(a)]);
    return {
      agente: a.name,
      modello: `${a.harness}:${a.model}`,
      effort: a.effort,
      lavoro: a.task_type,
      modo: a.mode === 'headless' ? 'non interattivo' : 'interattivo',
      registro: a.state === 'open' ? 'aperto' : a.closed_by === 'fuori da harma' ? 'chiuso fuori da harma' : 'chiuso',
      stato: a.state === 'closed' ? '—' : statusOf(a, live),
      compito: a.state === 'closed' ? '—' : a.pending ? 'NON consegnato' : a.prompted_at ? `consegnato ${ago(a.prompted_at)} fa` : 'nessuno',
      tenuto: a.keep ? 'sì' : '',
      backend: `${liveKey(a)} ${a.target?.tab ?? a.target?.address ?? ''}`.trim(),
      da: a.started_at ? ago(a.started_at) : null,
      sessione: a.session_id ? a.session_id.slice(0, 8) + '…' : (l?.sessionId ? l.sessionId.slice(0, 8) + '…' : null),
    };
  });
  const data = { orchestrator: cfg.orchestrator, policy: cfg.dispatch_policy, agents: rows };
  const pending = rows.filter((r) => r.compito === 'NON consegnato').map((r) => r.agente);
  emit(c, flags, data, () => [
    `Orchestratore: ${cfg.orchestrator ? `${cfg.orchestrator.harness}:${cfg.orchestrator.model} @ ${cfg.orchestrator.effort}` : 'non impostato'} · policy ${cfg.dispatch_policy}`,
    table(rows),
    ...(pending.length ? [`Compiti non consegnati: harma wait ${pending.join(' ')} li consegna appena gli agenti sono liberi.`] : []),
    ...(gone.length ? [`Chiusi fuori da harma, ora registrati come chiusi: ${gone.map((a) => a.name).join(', ')}.`] : []),
  ].join('\n'));
  return data;
}

async function liveByBackend(c, cfg, agents, opts) {
  const out = {};
  for (const a of agents.filter((x) => x.state === 'open')) {
    const key = liveKey(a);
    if (key in out) continue;
    try { out[key] = await backendOf(c, cfg, a, opts).list(projectId(c.root)); } catch { out[key] = null; }
  }
  return out;
}

/** Drop `flag` and the value after it; with no flag, return args unchanged. */
export function withoutFlag(args, flag) {
  if (!flag) return [...args];
  const i = args.indexOf(flag);
  return i < 0 ? [...args] : [...args.slice(0, i), ...args.slice(i + 2)];
}

/** The live terminal of a registered agent: by pane (herdr), address (hc), then name. */
export function findLive(a, list) {
  if (!list) return null;
  const t = a.target ?? {};
  return list.find((x) => t.pane && x.pane === t.pane)
    ?? list.find((x) => t.address && x.address === t.address)
    ?? list.find((x) => x.name && x.name === (t.name ?? a.name))
    ?? null;
}

function ago(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} g`;
}

// 7 ─ costs ────────────────────────────────────────────────────────────────
export async function cmdCosts(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root, { required: true });
  const agents = agentsFromEvents(readEvents(c.root));
  // An open agent's id may be known to the backend before harma records it.
  const live = await liveByBackend(c, cfg, agents.filter((a) => !a.session_id), opts);
  for (const a of agents) {
    if (!a.session_id && a.state === 'open') a.session_id = findLive(a, live[liveKey(a)])?.sessionId ?? null;
  }
  const perAgent = [];
  for (const a of agents) {
    if (a.target?.machine) {
      perAgent.push({ agente: a.name, modello: `${a.harness}:${a.model}`, token: null, stima: null, nota: `log su ${a.target.machine}, non su questa macchina` });
      continue;
    }
    if (!a.session_id || !meta(a.harness).logs) {
      perAgent.push({ agente: a.name, modello: `${a.harness}:${a.model}`, token: null, stima: null, nota: a.session_id ? `nessun log locale per ${a.harness}` : 'id di sessione non ancora noto' });
      continue;
    }
    const s = usageFor(a.harness, { env: c.env, sessionIds: [a.session_id] })[0];
    if (!s) { perAgent.push({ agente: a.name, modello: `${a.harness}:${a.model}`, token: 0, stima: null, nota: 'sessione senza consumi registrati' }); continue; }
    const est = estimateCost(s, c.catalog);
    const tokens = (s.input ?? 0) + (s.output ?? 0) + (s.cache_read ?? 0) + (s.cache_write_5m ?? 0) + (s.cache_write_1h ?? 0);
    perAgent.push({ agente: a.name, modello: `${a.harness}:${s.model ?? a.model}`, token: tokens, stima: est.usd === null ? null : `$${est.usd}`, nota: est.note });
  }
  const inv = await currentInventory(c, cfg);
  const credits = await currentCredits(c, cfg, inv, opts);
  const advice = adviceFor(credits.rows, agents);
  const data = { agents: perAgent, providers: credits.rows, advice };
  emit(c, flags, data, () => [
    'Costo per agente (stima a listino API dai log locali)',
    table(perAgent),
    '',
    'Crediti per provider',
    table(credits.rows.map((r) => ({ harness: r.harness, residuo: r.remaining_pct === null ? 'sconosciuto' : `${r.remaining_pct}%`, stato: r.status, fonte: r.source ?? r.detail }))),
    '',
    'Indicazioni di delega',
    ...advice.map((x) => `- ${x}`),
  ].join('\n'));
  return data;
}

export function adviceFor(rows, agents = []) {
  const open = new Map();
  for (const a of agents) if (a.state === 'open') open.set(a.harness, (open.get(a.harness) ?? 0) + 1);
  const roomy = rows.filter((r) => r.status === 'ampio').map((r) => r.harness);
  const out = [];
  for (const r of rows) {
    const n = open.get(r.harness) ?? 0;
    const busy = n ? ` (agenti aperti: ${n})` : '';
    if (r.status === 'esaurito') {
      const reset = r.windows?.map((w) => w.resets_at).filter(Boolean).sort()[0];
      out.push(`${r.harness}: crediti esauriti${busy} — non delegare${reset ? ` fino a ${reset}` : ''}${roomy.length ? `; sposta il lavoro su ${roomy.join(', ')}` : ''}.`);
    } else if (r.status === 'scarso') {
      out.push(`${r.harness}: crediti scarsi (${r.remaining_pct}%)${busy} — delega di meno${roomy.length ? `; preferisci ${roomy.join(', ')}` : ''}.`);
    } else if (r.status === 'ampio') {
      out.push(`${r.harness}: margine ampio (${r.remaining_pct}%)${busy} — può prendere più lavoro.`);
    } else if (r.status === 'sconosciuto') {
      out.push(`${r.harness}: crediti sconosciuti — attiva ${r.provider ?? 'il provider'} in CodexBar o dichiara un budget in .harma/config.json → budgets.${r.provider ?? '<provider>'}.`);
    }
  }
  return out;
}

// 8 ─ cleanup and resume ───────────────────────────────────────────────────
export async function cmdCleanup(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root, { required: true });
  const agents = agentsFromEvents(readEvents(c.root)).filter((a) => a.state === 'open' && (!flags.agent || a.name === flags.agent));
  const live = await liveByBackend(c, cfg, agents, opts);
  const report = [];
  for (const a of agents) {
    const l = findLive(a, live[liveKey(a)]);
    const result = a.mode === 'headless' ? runResult(a) : null;
    const status = result ? resultLabel(result) : (l?.status ?? (live[liveKey(a)] ? 'non trovato' : 'backend non raggiungibile'));
    if (!live[liveKey(a)]) { report.push({ agente: a.name, azione: 'saltato', motivo: status }); continue; }
    const named = flags.agent === a.name;
    if (a.keep && !named && status !== 'non trovato') {
      report.push({ agente: a.name, azione: 'tenuto', motivo: `segnato con harma keep: chiudilo con cleanup --agent ${a.name}, o togli il segno con harma keep ${a.name} --off` });
      continue;
    }
    if (a.pending && !named && !flags.force && status !== 'non trovato') {
      report.push({ agente: a.name, azione: 'tenuto', motivo: `il suo compito non è ancora stato consegnato: harma wait ${a.name} lo consegna; --agent ${a.name} per chiuderlo` });
      continue;
    }
    if (['working', 'blocked'].includes(status) && !flags.force) {
      report.push({ agente: a.name, azione: 'tenuto', motivo: status === 'working' ? 'sta lavorando' : 'aspetta una risposta (blocked): leggilo con harma read' });
      continue;
    }
    let sid = a.session_id ?? result?.session_id ?? l?.sessionId ?? null;
    let source = a.session_id ? 'registro' : result?.session_id ? 'harma _run' : (l?.sessionId ? a.backend : null);
    if (!sid && a.harness === 'codex' && !a.target?.machine) { sid = findCodexSession({ env: c.env, cwd: a.cwd, sinceMs: Date.parse(a.started_at) }); source = sid ? 'log codex' : null; }
    if (a.harness === 'muse' && a.mode !== 'headless' && !a.target?.machine && status !== 'non trovato') {
      // Never a session that ran before the agent started (the user's own, an orchestrator's), nor another agent's.
      const exclude = [...knownSessions(c.root), ...(a.muse_before ?? [])];
      if (!sid) {
        sid = await findMuseSession({ env: c.env, cwd: a.cwd, exclude });
        source = sid ? 'muse sessions' : null;
      } else if (sid === a.session_id) {
        const fresh = await replacedMuseSession({ env: c.env, cwd: a.cwd, sid, exclude });
        if (fresh) { sid = fresh; source = 'muse sessions'; }
      }
    }
    // A finished headless job keeps its answer on disk: no session is needed to close it.
    if (!sid && !flags.force && status !== 'non trovato' && !result) {
      report.push({ agente: a.name, azione: 'tenuto', motivo: 'id di sessione non trovato: chiudendo si perde il contesto (usa --force per chiudere comunque)' });
      continue;
    }
    if (flags['dry-run']) { report.push({ agente: a.name, azione: 'da chiudere', motivo: status, sessione: sid }); continue; }
    if (sid && sid !== a.session_id) appendEvent(c.root, { type: 'session', agent: a.name, session_id: sid, source });
    let closed = { ok: true, detail: 'già chiuso nel backend' };
    if (status !== 'non trovato') {
      closed = await backendOf(c, cfg, a, opts).close({ ...(a.target ?? {}), target: a.target?.name ?? a.name });
    }
    if (closed.ok) appendEvent(c.root, { type: 'closed', agent: a.name, session_id: sid, last_status: status });
    const kept = (closed.ok && a.worktree ? ` · worktree lasciato in ${a.worktree.path} (branch ${a.worktree.branch}): integra il lavoro, poi git worktree remove` : '')
      + (closed.ok && a.run_dir ? ` · risposta in ${join(a.run_dir, 'output.md')}` : '');
    report.push({ agente: a.name, azione: closed.ok ? 'chiuso' : 'errore', motivo: closed.detail + kept, sessione: sid });
  }
  // --workspace: close harma's own herdr workspaces (here and on each machine) once no harma agent is open there.
  if (flags.workspace && !flags['dry-run']) {
    const open = agentsFromEvents(readEvents(c.root)).filter((a) => a.state === 'open' && a.backend === 'herdr');
    const spaces = [
      ...(cfg.herdr?.workspace_id ? [{ machine: null, id: cfg.herdr.workspace_id }] : []),
      ...Object.entries(cfg.herdr?.machines ?? {}).filter(([, v]) => v?.workspace_id).map(([m, v]) => ({ machine: m, id: v.workspace_id })),
    ];
    for (const sp of spaces) {
      const label = sp.machine ? `(workspace su ${sp.machine})` : '(workspace)';
      const here = open.filter((a) => (a.target?.machine ?? null) === sp.machine);
      if (here.length) { report.push({ agente: label, azione: 'tenuto', motivo: `agenti ancora aperti: ${here.map((a) => a.name).join(', ')}` }); continue; }
      const b = opts.backend?.name === 'herdr' && (opts.backend.machine ?? null) === sp.machine ? opts.backend : new HerdrBackend({ env: c.env, config: cfg, machine: sp.machine });
      const res = await b.closeWorkspace(sp.id);
      if (res.ok) {
        if (sp.machine) delete cfg.herdr.machines[sp.machine];
        else delete cfg.herdr.workspace_id;
        saveConfig(c.root, cfg);
      }
      report.push({ agente: label, azione: res.ok ? 'chiuso' : 'errore', motivo: res.detail });
    }
  }
  emit(c, flags, { report }, () => [
    flags['dry-run'] ? 'Anteprima pulizia (nulla è stato chiuso)' : 'Pulizia agenti',
    table(report),
    'harma chiude solo terminali e tab che ha creato; ogni id di sessione resta in .harma/agents.jsonl.',
  ].join('\n'));
  return { report };
}

export async function cmdResume(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root, { required: true });
  const name = flags._[0];
  const a = agentsFromEvents(readEvents(c.root)).find((x) => x.name === name);
  if (!a) throw new HarmaError(`Agente sconosciuto: ${name}`);
  if (a.state === 'open') throw new HarmaError(`${name} è già aperto`, { hint: `harma read ${name}` });
  if (!a.session_id) throw new HarmaError(`Nessun id di sessione salvato per ${name}`);
  const base = resumeArgv(a.harness, a.session_id);
  if (!base) throw new HarmaError(`Non so riprendere sessioni di ${a.harness}`, { hint: `id salvato: ${a.session_id}` });
  const spec = launchSpec({ harness: a.harness, model: a.model, effort: a.effort }, c.catalog, { sessionId: a.session_id });
  // resume argv + model/effort flags, without the "new session id" flag and its value
  const flagsOnly = withoutFlag(spec.argv.slice(1), meta(a.harness).presetSession);
  const argv = [...base, ...flagsOnly];
  const gate = await dispatchGate(c, cfg, a.harness, flags, opts);
  if (!gate.allowed || flags['print-only']) {
    emit(c, flags, { needs_confirmation: !gate.allowed, argv, cwd: a.cwd }, () => [
      gate.allowed ? 'Comando di ripresa:' : `CONFERMA RICHIESTA — ${gate.reason}`,
      `cd ${a.cwd} && ${argv.join(' ')}`,
      gate.allowed ? '' : 'Se l\'utente approva, ripeti con --yes per riaprirlo in un nuovo terminale.',
    ].join('\n').trim());
    return { needsConfirmation: !gate.allowed, argv, exitCode: gate.allowed ? 0 : EXIT_NEEDS_CONFIRM };
  }
  const machine = a.target?.machine ?? null;
  const backend = opts.backend ?? await selectBackend({ choice: machine ? 'herdr' : flags.backend ?? a.backend, config: cfg, env: c.env, machine });
  const started = await backend.start({ name, cwd: a.cwd, argv, env: spec.env, harness: a.harness, root: c.root, project: projectId(c.root), layout: machine ? undefined : flags.layout ?? cfg.herdr?.layout ?? 'auto' });
  rememberWorkspace(c, cfg, started);
  appendEvent(c.root, { type: 'resumed', agent: name, session_id: a.session_id, backend: backend.name, target: targetOf(started), confirmed_by: gate.by });
  const trusted = await maybeTrust(c, cfg, backend, { agent: name, harness: a.harness, cwd: a.cwd, started: { ...started, worktree: a.worktree } });
  c.out(flags.json ? JSON.stringify({ resumed: true, argv, trust: trusted }) : `Ripreso ${name} (sessione ${a.session_id}) su ${backend.name} (${where(started)}).`);
  return { resumed: true, argv };
}

// select ─ the user validates or picks model + effort per job ─────────────
const BIN = fileURLToPath(new URL('../bin/harma.mjs', import.meta.url));

export async function cmdSelect(flags, opts = {}) {
  const c = ctx(opts);
  const cfg = loadConfig(c.root, { required: true });
  if (flags.open) return openSelect(c, cfg, flags, opts);

  if (!flags.json && !flags.show) c.out('Carico modelli, crediti e proposte…');
  const inv = await currentInventory(c, cfg);
  const credits = await currentCredits(c, cfg, inv, opts);
  const rr = rankRows(c.catalog, inv.models);
  const rows = selectionRows({ cfg, rankRowsArr: rr, credits: credits.rows });
  const models = modelOptions(inv.models, rr, credits.rows);

  if (flags.show) return showSelection(c, flags, rows);

  let outcome;
  let finalRows = rows;
  if (flags.accept || flags.set) {
    if (flags.accept) {
      finalRows = finalRows.map((r) => (r.proposal ? { ...r, choice: { picks: [...r.proposal.picks], source: 'proposta' } } : r));
    }
    if (flags.set) {
      const parsed = parseSetSpec(flags.set, { catalog: c.catalog, parseTarget, effortValues });
      finalRows = finalRows.map((r) => (parsed[r.type] ? { ...r, choice: parsed[r.type] } : r));
    }
    outcome = 'save';
  } else {
    const input = opts.input ?? process.stdin;
    const output = opts.output ?? process.stdout;
    if (!input.isTTY || !output.isTTY) {
      throw new HarmaError('harma select è interattivo e qui non c\'è un terminale', {
        hint: 'Apri la TUI in un tab herdr con: harma select --open --wait · oppure senza TUI: harma select --accept | --set "sviluppo=codex:gpt-6.2-sol@high,…" | --show',
      });
    }
    const orch = cfg.orchestrator ? describe(cfg.orchestrator) : 'non impostato';
    const end = await (opts.runTui ?? runTui)(initState({ rows, models, title: 'harma · modelli del progetto', subtitle: `orchestratore ${orch} · ${c.root}` }), { input, output });
    outcome = end.done;
    finalRows = end.rows;
  }

  if (outcome !== 'save') {
    writeCache(c.root, 'select-status', { state: 'cancelled', at: now() });
    c.out(flags.json ? JSON.stringify({ saved: false }) : 'Nessuna modifica salvata.');
    await closeOwnTab(flags, c.env);
    return { saved: false };
  }
  const roster = applySelection(cfg, finalRows);
  saveConfig(c.root, cfg);
  appendEvent(c.root, { type: 'roster', orchestrator: cfg.orchestrator, roster });
  writeCache(c.root, 'select-status', { state: 'saved', at: cfg.roster_updated_at });
  showSelection(c, flags, finalRows, 'Scelte salvate in .harma/config.json');
  await closeOwnTab(flags, c.env);
  return { saved: true, orchestrator: cfg.orchestrator, roster };
}

function showSelection(c, flags, rows, heading = 'Modelli per lavoro') {
  const data = rows.map((r) => ({
    lavoro: r.type,
    proposta: describe(r.proposal),
    scelta: describe(r.choice),
    fonte: !r.choice ? '—' : r.type === ORCHESTRATOR ? 'configurato' : (r.choice.none ? 'utente' : r.choice.source === 'proposta' ? 'proposta accettata' : 'utente'),
  }));
  // One block per job: the choice can be several models long, a table would wrap.
  emit(c, flags, { rows: data }, () => [heading, ...data.flatMap((d) => [
    `${d.lavoro}: ${d.scelta}${d.fonte !== '—' ? `  (${d.fonte})` : ''}`,
    ...(d.proposta !== d.scelta ? [`  proposta: ${d.proposta}`] : []),
  ])].join('\n'));
  return { rows: data };
}

/** Inside a herdr tab opened by --open: close it when the TUI ends. */
async function closeOwnTab(flags, env) {
  if (flags['close-tab'] && env.HERDR_TAB_ID) await run('herdr', ['tab', 'close', env.HERDR_TAB_ID], { env });
}

/** Open the TUI where the user can see it (a focused herdr tab, or an hc terminal); optionally wait. */
async function openSelect(c, cfg, flags, opts) {
  const startedAt = now();
  const cmd = [process.execPath, BIN, 'select', '--close-tab'].map(shq).join(' ');
  const backend = opts.backend ?? await selectBackend({ choice: flags.backend, config: cfg, env: c.env });
  let where;
  if (backend.name === 'herdr') {
    const tab = await backend.openTab({ root: c.root, project: projectId(c.root), label: 'harma-select', command: cmd, layout: flags.layout ?? cfg.herdr?.layout ?? 'auto' });
    if (tab.workspaceCreated) {
      // Re-read: the TUI may already have saved choices into config.json.
      const fresh = loadConfig(c.root);
      fresh.herdr = { ...(fresh.herdr ?? {}), workspace_id: tab.workspace };
      saveConfig(c.root, fresh);
    }
    where = tab.layout === 'split' ? `pane herdr ${tab.pane} (in primo piano)` : `tab herdr ${tab.tab} (in primo piano)`;
  } else {
    await backend.exec(['run', '--bg', '--json', '--name', 'harma-select', '--cwd', c.root, '--no-parent', '--', process.execPath, BIN, 'select']);
    where = 'terminale hc "harma-select": aprilo con  hc attach harma-select';
  }
  if (!flags.wait) {
    emit(c, flags, { opened: true, where }, () => `Selezione aperta nel ${where}. Quando l'utente salva: harma select --show`);
    return { opened: true };
  }
  if (!flags.json) c.out(`Selezione aperta nel ${where}. Attendo che l'utente salvi o esca…`);
  const timeoutMs = Number(flags.timeout ?? 900) * 1000;
  const deadline = Date.now() + timeoutMs;
  const poll = opts.pollMs ?? 1500;
  while (Date.now() < deadline) {
    const st = readJson(statePath(c.root, 'cache', 'select-status.json'));
    if (st && st.at > startedAt) {
      if (st.state !== 'saved') {
        emit(c, flags, { saved: false }, () => 'L\'utente è uscito senza salvare.');
        return { saved: false };
      }
      const fresh = loadConfig(c.root);
      const data = { saved: true, orchestrator: fresh.orchestrator, roster: fresh.roster };
      emit(c, flags, data, () => ['Scelte dell\'utente:', `orchestratore: ${describe(fresh.orchestrator)}`,
        ...Object.entries(fresh.roster ?? {}).map(([t, v]) => `${t}: ${describe(v)} (${v.source})`)].join('\n'));
      return data;
    }
    await new Promise((r) => setTimeout(r, poll));
  }
  throw new HarmaError(`Nessuna risposta dalla selezione entro ${timeoutMs / 1000}s`, { hint: 'Il tab resta aperto: riprova con harma select --show più tardi' });
}

export { DEFAULT_CONFIG, taskProfile };

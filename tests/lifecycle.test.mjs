// An agent's life after dispatch: the task must reach it (Muse restarts after
// updating itself; a dialog can stop it first), harma wait watches it, keep
// holds it open, a tab closed by hand is noticed, and Muse's session is saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { sandbox } from './helpers.mjs';
import { main } from '../src/cli.mjs';
import { readEvents, agentsFromEvents } from '../src/state.mjs';
import { HerdrBackend, showsTask } from '../src/backends.mjs';
import { pickOption, selectedOption } from '../src/answers.mjs';
import { readTrustDialog } from '../src/trust.mjs';

const BRIEF = 'Review PR 12: read the diff, run the tests';
const MUSE = ['--model', 'muse:muse-wonder-full-1.0', '--effort', 'max'];

const events = (sb, type) => readEvents(sb.project).filter((e) => e.type === type);
const agent = (sb, name) => agentsFromEvents(readEvents(sb.project)).find((a) => a.name === name);

// A herdr backend that doesn't wait: the fake herdr answers at once.
function fast(sb, env) {
  const b = new HerdrBackend({ env });
  b.settleMs = 0;
  b.settlePollMs = 0;
  b.trustPollMs = 0;
  return b;
}
const run = (sb, args, env = {}) => {
  const e = { ...sb.env, ...env };
  return main(args, sb.opts({ env: e, backend: fast(sb, e), pollMs: 0 }));
};
const json = (sb) => JSON.parse(sb.output());

async function project() {
  const sb = sandbox({ bins: ['herdr', 'hc', 'codexbar', 'claude', 'codex', 'muse'] });
  await main(['init', '--orchestrator', 'claude:claude-opus-5-5', '--effort', 'high', '--backend', 'herdr'], sb.opts());
  sb.clear();
  return sb;
}
const dispatch = (sb, name, extra = [], env = {}) => run(sb, ['dispatch', '--name', name, ...MUSE, '--prompt', BRIEF, '--yes', ...extra], env);

/** Change the fake agent as a person or the CLI would. */
function setAgent(sb, name, change) {
  const st = sb.state();
  change(st.herdr.agents.find((x) => x.name === name), st.herdr);
  writeFileSync(sb.statePath, JSON.stringify(st));
}

test('a task the agent lost while restarting is sent once more', async () => {
  const sb = await project();
  assert.equal(await dispatch(sb, 'rev', [], { FAKE_PROMPT_LOST: '1' }), 0);
  const h = sb.state().herdr;
  assert.deepEqual(h.lost, [BRIEF]);
  assert.deepEqual(h.delivered, [BRIEF]);
  assert.equal(events(sb, 'prompted')[0].retried, 'text');
  assert.match(sb.output(), /aveva perso il testo/);
});

test('a message to an agent that is done already: done again without a state change is not taken', async () => {
  const sb = await project();
  await dispatch(sb, 'rev'); // its turn ends: done
  setAgent(sb, 'rev', (ag, h) => { h.loseNext = 1; });
  sb.clear();
  assert.equal(await run(sb, ['send', 'rev', 'Now check the tests', '--yes', '--json']), 0);
  assert.equal(json(sb).retried, 'text');
  assert.deepEqual(sb.state().herdr.delivered, [BRIEF, 'Now check the tests']);
});

test('a task typed but not submitted gets Enter again, not a second copy', async () => {
  const sb = await project();
  assert.equal(await dispatch(sb, 'rev', [], { FAKE_PROMPT_NO_ENTER: '1' }), 0);
  const h = sb.state().herdr;
  assert.deepEqual(h.delivered, [BRIEF]);
  assert.equal(h.keys.filter((k) => k === 'enter').length, 1);
  assert.equal(events(sb, 'prompted')[0].retried, 'enter');
});

test('a task lost twice is kept aside: exit 4, status and cleanup say so, send --pending delivers it', async () => {
  const sb = await project();
  assert.equal(await dispatch(sb, 'rev', [], { FAKE_PROMPT_LOST: '2' }), 4);
  assert.match(sb.output(), /COMPITO NON PARTITO[\s\S]*harma send rev --pending/);
  const kept = agent(sb, 'rev').pending;
  assert.equal(readFileSync(kept.file, 'utf8'), BRIEF);
  assert.equal(events(sb, 'prompted').length, 0);

  sb.clear();
  await run(sb, ['status', '--json']);
  assert.equal(json(sb).agents[0].compito, 'NON consegnato');
  sb.clear();
  await run(sb, ['cleanup', '--json']);
  assert.match(json(sb).report[0].motivo, /non è ancora stato consegnato/);

  sb.clear();
  assert.equal(await run(sb, ['send', 'rev', '--pending']), 0); // approved at dispatch: no new --yes
  assert.deepEqual(sb.state().herdr.delivered, [BRIEF]);
  assert.equal(agent(sb, 'rev').pending, null);
  assert.equal(events(sb, 'prompted')[0].pending, true);
  assert.equal(await run(sb, ['send', 'rev', '--pending']), 1); // nothing left aside
});

test('a new message replaces a task kept aside, and says where the old one is', async () => {
  const sb = await project();
  await dispatch(sb, 'rev', [], { FAKE_PROMPT_LOST: '2' });
  const file = agent(sb, 'rev').pending.file;
  sb.clear();
  assert.equal(await run(sb, ['send', 'rev', 'Only check the tests', '--yes']), 0);
  assert.match(sb.output(), new RegExp(`non verrà più consegnato[\\s\\S]*--prompt-file ${file}`));
  assert.equal(agent(sb, 'rev').pending, null);
});

test('Muse\'s trust dialog in a folder harma did not create: the task waits aside, harma wait delivers it once the user trusts', async () => {
  const sb = await project();
  assert.equal(await dispatch(sb, 'rev', [], { FAKE_START_BLOCKED: 'muse' }), 4);
  assert.match(sb.output(), /BLOCCATO[\s\S]*harma lo tiene da parte[\s\S]*harma wait rev/);
  assert.ok(agent(sb, 'rev').pending);

  sb.clear();
  assert.equal(await run(sb, ['wait', 'rev', '--timeout', '0']), 5); // the dialog is the user's: wait goes on
  assert.match(sb.output(), /fiducia alla cartella/);
  assert.equal(sb.state().herdr.trusted, undefined);

  setAgent(sb, 'rev', (ag) => { ag.dialog = null; ag.agent_status = 'idle'; }); // the user trusts the folder
  sb.clear();
  assert.equal(await run(sb, ['wait', 'rev', '--json']), 0);
  assert.deepEqual(sb.state().herdr.delivered, [BRIEF]);
  assert.equal(events(sb, 'prompted')[0].by, 'harma wait');
  assert.equal(agent(sb, 'rev').pending, null);
});

test('harma answers Muse\'s trust dialog in a worktree it created', async () => {
  const sb = await project();
  assert.equal(await dispatch(sb, 'rev', ['--worktree'], { FAKE_START_BLOCKED: 'muse' }), 0);
  const h = sb.state().herdr;
  assert.deepEqual(h.trusted, ['rev']);
  assert.deepEqual(h.delivered, [BRIEF]);
});

test('harma wait: a question ends it (exit 4), working agents run out the time (exit 5), --any returns on the first stop', async () => {
  const sb = await project();
  await dispatch(sb, 'a', [], { FAKE_AFTER_PROMPT: 'working' });
  await dispatch(sb, 'b', [], { FAKE_AFTER_PROMPT: 'working' });
  sb.clear();
  assert.equal(await run(sb, ['wait', 'a', 'b', '--timeout', '0']), 5);
  assert.match(sb.output(), /lavorano ancora: a, b/);

  setAgent(sb, 'a', (ag) => { ag.agent_status = 'blocked'; ag.ask = { q: 'Which currency?', mark: '›', options: ['1. EUR', '2. USD'], sel: 0 }; });
  sb.clear();
  assert.equal(await run(sb, ['wait', 'a', 'b', '--timeout', '60']), 4);
  assert.match(sb.output(), /a aspetta una risposta[\s\S]*harma answer a/);

  setAgent(sb, 'a', (ag) => { ag.ask = null; ag.agent_status = 'idle'; });
  sb.clear();
  assert.equal(await run(sb, ['wait', 'a', 'b', '--any', '--timeout', '60', '--json']), 0);
  assert.deepEqual(json(sb).agents.map((r) => [r.agent, r.stopped]), [['a', true], ['b', false]]);
});

test('keep: cleanup leaves a kept agent open until it is named or unmarked', async () => {
  const sb = await project();
  await dispatch(sb, 'build', ['--keep']);
  await dispatch(sb, 'rev');
  assert.match(sb.output(), /Tenuto: harma cleanup non chiude build/);
  sb.clear();
  await run(sb, ['status', '--json']);
  assert.deepEqual(json(sb).agents.map((r) => [r.agente, r.tenuto]), [['build', 'sì'], ['rev', '']]);

  sb.clear();
  await run(sb, ['cleanup', '--json']);
  assert.deepEqual(json(sb).report.map((r) => [r.agente, r.azione]), [['build', 'tenuto'], ['rev', 'chiuso']]);
  assert.equal(await run(sb, ['keep', 'build', '--off']), 0);
  assert.equal(agent(sb, 'build').keep, false);
  assert.equal(await run(sb, ['keep', 'build']), 0);
  sb.clear();
  await run(sb, ['cleanup', '--agent', 'build', '--json']);
  assert.equal(json(sb).report[0].azione, 'chiuso');
});

test('Muse sessions: found at dispatch among the new ones, saved at cleanup, resumed with muse resume', async () => {
  const sb = await project();
  await dispatch(sb, 'one');
  await dispatch(sb, 'two'); // same folder: its session is the new one, not one's
  assert.deepEqual(['one', 'two'].map((n) => agent(sb, n).session_id), ['muse-sess-1', 'muse-sess-2']);
  assert.equal(events(sb, 'session')[0].source, 'muse sessions');
  sb.clear();
  await run(sb, ['cleanup', '--json']);
  assert.deepEqual(json(sb).report.map((r) => [r.azione, r.sessione]), [['chiuso', 'muse-sess-1'], ['chiuso', 'muse-sess-2']]);
  sb.clear();
  assert.equal(await run(sb, ['resume', 'one', '--print-only', '--yes']), 0);
  assert.match(sb.output(), /muse resume muse-sess-1 --model muse-wonder-full-1\.0 --reasoning-effort max/);
});

test('a Muse session harma cannot tell apart is not guessed', async () => {
  const sb = await project();
  await dispatch(sb, 'rev', [], { FAKE_MUSE_NO_SESSION: '1' });
  assert.equal(agent(sb, 'rev').session_id, null);
  sb.clear();
  await run(sb, ['cleanup', '--json']);
  assert.match(json(sb).report[0].motivo, /id di sessione non trovato/);
});

test('status notices a tab closed by hand and records the agent closed, keeping its session', async () => {
  const sb = await project();
  await dispatch(sb, 'rev');
  setAgent(sb, 'rev', (ag, h) => { h.agents = h.agents.filter((x) => x !== ag); });
  sb.clear();
  await run(sb, ['status', '--json']);
  assert.equal(json(sb).agents[0].registro, 'chiuso fuori da harma');
  const [closed] = events(sb, 'closed');
  assert.deepEqual([closed.by, closed.session_id], ['fuori da harma', 'muse-sess-1']);
  sb.clear();
  await run(sb, ['status', '--json']);
  assert.deepEqual(json(sb).agents, []);
});

test('reading screens: a task on screen, Muse\'s marker, numbers and dialog', () => {
  assert.ok(showsTask('❯ Review PR 12: read the\ndiff, run the tests', BRIEF)); // wrapped by the terminal
  assert.ok(showsTask('> [Pasted text #1 +40 lines]', 'a long brief'));
  assert.ok(!showsTask('❯ \n  muse-wonder-full-1.0 · max', BRIEF));
  const muse = ['Do you trust this workspace?', 'Workspace: /w/t1-llm-eu', '⟩ 1  Trust and continue', '  2  Quit'].join('\n');
  assert.equal(selectedOption(muse), '1  Trust and continue');
  assert.equal(pickOption(['1  Trust and continue', '2  Quit'], '2').index, 1);
  assert.equal(pickOption(['1  Trust and continue', '2  Quit'], 'Trust and continue').index, 0);
  assert.deepEqual(readTrustDialog('muse', muse, '/w/t1-llm-eu'), { dialog: true, path: true, selected: true, line: '1  Trust and continue' });
});

// Session IDs a CLI reports outside herdr and outside its logs. Muse lists
// the sessions running on this machine (`muse sessions --json`, Muse Code
// 1.4.24): an agent's session is the one harma doesn't know yet whose
// workspace is the agent's folder. Muse names the workspace by the folder's
// last path segment.
import { basename } from 'node:path';
import { run, which, parseJson } from './util.mjs';

/** Muse's running sessions: [{sessionId, name, workspaceLabel, openedBy, …}]. */
export async function museSessions(env = process.env) {
  if (!which('muse', env)) return [];
  const res = await run('muse', ['sessions', '--json'], { env, timeout: 15_000 });
  return res.ok ? (parseJson(res.stdout)?.sessions ?? []) : [];
}

/**
 * The one Muse session in folder `cwd` that is not in `exclude`, or null when
 * none or several fit. A side chat (`sideOf`) is not a session to resume.
 */
export async function findMuseSession({ env, cwd, exclude = [] }) {
  if (!cwd) return null;
  const skip = new Set(exclude);
  const hits = (await museSessions(env)).filter((s) => s.sessionId && !s.sideOf && s.workspaceLabel === basename(cwd) && !skip.has(s.sessionId));
  return hits.length === 1 ? hits[0].sessionId : null;
}

/**
 * A live Muse agent runs its session, so a recorded session Muse no longer
 * lists is from before a restart (Muse updates itself at launch). Returns the
 * agent's new session, the one new session in its folder, or null to keep `sid`.
 */
export async function replacedMuseSession({ env, cwd, sid, exclude = [] }) {
  const running = (await museSessions(env)).map((s) => s.sessionId);
  if (!running.length || running.includes(sid)) return null;
  return findMuseSession({ env, cwd, exclude: [...exclude, sid] });
}

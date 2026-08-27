// Per-project runtime state: the claimed task, and the written-down exemption.
//
// This lives in ~/.claude/clickup-flow/state/, NOT in the project. The three repos this tool
// generalises all kept `.claude/.tarea-actual` inside the checkout, which meant every
// participating repo needed a .gitignore entry and every `git status` had a stray file in it.
// Central state costs nothing and keeps the tool out of the user's diff.
//
// Everything here degrades to "no state" on any error. A hook that cannot read its state file
// must behave like a hook with no state, never like a hook that crashes.

import fs from 'node:fs';
import path from 'node:path';
import { projectStateFile, statePath, canonicalProjectKey, writeJsonAtomic } from './paths.mjs';

function emptyState() {
  return { claim: null, exemption: null };
}

export function readState(projectDir) {
  const file = projectStateFile(projectDir);
  if (!fs.existsSync(file)) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      claim: parsed?.claim ?? null,
      exemption: parsed?.exemption ?? null,
    };
  } catch {
    return emptyState();
  }
}

function writeState(projectDir, state) {
  fs.mkdirSync(statePath(), { recursive: true });
  const file = projectStateFile(projectDir);
  const payload = {
    project: canonicalProjectKey(projectDir),
    updated_at: new Date().toISOString(),
    ...state,
  };
  return writeJsonAtomic(file, payload);
}

/**
 * Record a claimed task. This is what unlocks writing.
 *
 * `role` matters as much as the id: `in progress` alone never says whether backend or frontend
 * is holding the task, which is the single most reliable way to misread a shared board.
 */
export function setClaim(projectDir, claim) {
  const state = readState(projectDir);
  state.claim = {
    task_id: claim.taskId ?? null,
    title: claim.title ?? null,
    url: claim.url ?? (claim.taskId ? `https://app.clickup.com/t/${claim.taskId}` : null),
    role: claim.role ?? null,
    git_email: claim.gitEmail ?? null,
    claimed_at: claim.claimedAt ?? new Date().toISOString(),
  };
  // Claiming a task retires any standing exemption: the two states are alternatives, and an
  // exemption left behind would keep the lock open after the task is closed.
  state.exemption = null;
  return writeState(projectDir, state);
}

export function clearClaim(projectDir) {
  const state = readState(projectDir);
  const had = Boolean(state.claim);
  state.claim = null;
  writeState(projectDir, state);
  return had;
}

/**
 * Record the written-down decision that this work does not deserve a task.
 *
 * It expires, and that is the whole point. A forgotten exemption would disable the lock
 * permanently and silently — precisely the failure the lock exists to prevent.
 */
export function setExemption(projectDir, reason, hours) {
  const state = readState(projectDir);
  state.exemption = {
    reason: String(reason ?? '').trim() || 'sin motivo declarado',
    declared_at: new Date().toISOString(),
    hours: Number.isFinite(hours) && hours > 0 ? hours : 8,
  };
  return writeState(projectDir, state);
}

export function clearExemption(projectDir) {
  const state = readState(projectDir);
  const had = Boolean(state.exemption);
  state.exemption = null;
  writeState(projectDir, state);
  return had;
}

/** `{ active, expired, ageHours, reason }` for the current exemption. */
export function exemptionStatus(state, defaultHours = 8) {
  const ex = state?.exemption;
  if (!ex || !ex.declared_at) return { active: false, expired: false, ageHours: 0, reason: null };
  const declared = Date.parse(ex.declared_at);
  if (!Number.isFinite(declared)) {
    // An unreadable timestamp is treated as expired. Failing closed is the right default for
    // something whose only job is to hold a lock open.
    return { active: false, expired: true, ageHours: Infinity, reason: ex.reason ?? null };
  }
  const limitHours = Number.isFinite(ex.hours) && ex.hours > 0 ? ex.hours : defaultHours;
  const ageHours = (Date.now() - declared) / 3_600_000;

  // Una exención fechada en el FUTURO se trata como vencida.
  //
  // Sin esto, la edad sale negativa y `negativa >= limite` es false: la exención quedaba vigente
  // hasta que el reloj la alcanzara. Con un `declared_at` en 2099 eso son décadas de candado
  // abierto. Pasa por desfase de reloj, por una VM suspendida, o porque alguien editó el archivo
  // — y en los tres casos la respuesta correcta es la misma: fallar cerrado.
  const expired = ageHours < 0 || ageHours >= limitHours;
  return {
    active: !expired,
    expired,
    ageHours,
    limitHours,
    reason: ex.reason ?? null,
  };
}

/** Remove a project's state file entirely (used by uninstall and by `project forget`). */
export function dropState(projectDir) {
  const file = projectStateFile(projectDir);
  try {
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      return true;
    }
  } catch {
    /* nothing worth reporting: the file is cache-like by nature */
  }
  return false;
}

/** Every state file on disk, for `doctor`. */
export function listStateFiles() {
  const dir = statePath();
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

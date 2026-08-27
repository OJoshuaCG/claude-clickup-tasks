// The configuration file: read, migrate, resolve, write.
//
// Two rules govern everything here:
//
//   1. Reading NEVER throws. A corrupt or missing config has to degrade into "not configured",
//      because the hooks read this file on every prompt and on every write, and a hook that
//      throws is a hook that breaks the user's session.
//   2. Writing NEVER drops unknown keys. The file is meant to be hand-edited, and a user who
//      adds a field they care about should not lose it because this version didn't know it.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { configPath, toolHome, canonicalProjectKey } from './paths.mjs';

export const CONFIG_VERSION = 1;

/** Modes a project can be in. `excluded` is a real, recorded answer — not the absence of one. */
export const MODES = Object.freeze({
  TASKS: 'tasks', // several normal tasks in a list (mensajeria-style)
  UMBRELLA: 'umbrella', // one parent task, work happens in subtasks (frontend/backend-style)
  EXCLUDED: 'excluded', // the user said no. Recorded so we never ask again.
});

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    // Versión de la HERRAMIENTA (distinta de `version`, que es el esquema del archivo). Sirve
    // para que `doctor` diga qué hay instalado y para que el instalador sepa si está
    // actualizando, reinstalando o volviendo atrás.
    installed_version: null,
    installed_at: new Date().toISOString(),
    // Rutas relativas a la carpeta de Claude Code que puso la instalación. Ver el manifiesto en
    // installer.mjs: es lo que permite borrar un comando que una versión nueva ya no trae.
    installed_files: [],
    identity: {
      // The numeric ClickUp user id. THIS is what gets assigned — never the string "me".
      clickup_user_id: null,
      clickup_email: null,
      clickup_username: null,
      confirmed: false,
      resolved_via: null, // 'api' | 'mcp' | 'manual'
      resolved_at: null,
      // Git emails known to belong to this same human. Used to recognise your own INICIO
      // comments instead of reading them as somebody else's collision.
      git_emails: [],
    },
    defaults: {
      workspace_id: null,
      use_dates: true,
      use_priorities: true,
      auto_assign: true,
      // Where the completion date is written.
      //   'description'  → a `**Finalizado:** YYYY-MM-DD` line + ClickUp's own date_closed.
      //   'due_date'     → overwrite due_date (only for boards that already use it that way).
      //   'custom_field' → a Date custom field literally named "Fecha de fin", if it exists.
      end_date_field: 'description',
      search_window_days: 30,
      // The PreToolUse lock. Only ever applies to registered, non-excluded projects.
      block_writes_without_task: true,
      exemption_hours: 8,
    },
    // Keyed by canonical project path. `git_remote` lets the same repo be recognised in a
    // second checkout without asking again.
    projects: {},
    // git email -> ClickUp identity, for assigning work to teammates. Mirrors the
    // clickup-usuarios.json idea from the frontend repo, including its `confirmed` flag.
    team: {},
  };
}

/** True solo para un objeto plano: `null` y los arrays NO cuentan, aunque sean `typeof object`. */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deep merge que rellena los defaults ausentes sin pisar nada que el usuario haya puesto.
 *
 * La clave está en la rama del medio: si una sección DEBERÍA ser un objeto y en el archivo es
 * `null` o un array, se reemplaza por el default. La versión anterior recursaba sobre ese valor,
 * `fillDefaults(null, {...})` salía inmediatamente, y `config.defaults` se quedaba en `null` — con
 * lo cual todo lo que lee `config.defaults.algo` explotaba después, lejos de la causa.
 */
function fillDefaults(target, defaults) {
  if (!isPlainObject(target)) return target;
  for (const [k, v] of Object.entries(defaults)) {
    if (!(k in target)) {
      target[k] = structuredClone(v);
    } else if (isPlainObject(v)) {
      target[k] = isPlainObject(target[k]) ? fillDefaults(target[k], v) : structuredClone(v);
    }
  }
  return target;
}

/**
 * Load the config. Returns `{ config, ok, error, existed }`.
 *
 * On a parse failure it hands back defaults with `ok:false` rather than throwing: the caller
 * (usually a hook) then knows to stay quiet instead of blocking the user over a typo in JSON.
 */
export function loadConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) {
    return { config: defaultConfig(), ok: true, existed: false, error: null };
  }
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    // `isPlainObject`, no `typeof === 'object'`: un `[]` en la raíz pasaba la validación anterior
    // y después `config.projects` era `undefined` en un lugar muy lejano al archivo.
    if (!isPlainObject(parsed)) throw new Error('la raíz del config no es un objeto');
    const config = fillDefaults(parsed, defaultConfig());
    config.version = CONFIG_VERSION;
    return { config, ok: true, existed: true, error: null };
  } catch (err) {
    return {
      config: defaultConfig(),
      ok: false,
      existed: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Atomic-ish write: temp file then rename, so a crash mid-write cannot leave a truncated config. */
export function saveConfig(config) {
  fs.mkdirSync(toolHome(), { recursive: true });
  const file = configPath();
  const tmp = `${file}.tmp-${process.pid}`;
  config.updated_at = new Date().toISOString();
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/** `git config user.email` for a directory. Null when there is no git or no email set. */
export function gitEmail(dir) {
  return runGit(dir, ['config', 'user.email']);
}

/** First remote URL, normalised so ssh and https forms of the same repo compare equal. */
export function gitRemote(dir) {
  const url = runGit(dir, ['remote', 'get-url', 'origin']);
  return url ? normaliseRemote(url) : null;
}

/** Repository root, so a subdirectory of a registered project still resolves to that project. */
export function gitRoot(dir) {
  const root = runGit(dir, ['rev-parse', '--show-toplevel']);
  return root ? canonicalProjectKey(root) : null;
}

function runGit(dir, args) {
  try {
    const out = execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
    const value = out.trim();
    return value || null;
  } catch {
    return null;
  }
}

export function normaliseRemote(url) {
  let u = String(url).trim().toLowerCase();
  u = u.replace(/\.git$/, '');
  u = u.replace(/^git\+/, '');
  // git@host:owner/repo  ->  host/owner/repo
  u = u.replace(/^[a-z0-9._-]+@([^:]+):/, '$1/');
  // scheme://[user@]host/...  ->  host/...
  u = u.replace(/^[a-z]+:\/\/(?:[^@/]+@)?/, '');
  u = u.replace(/\/+$/, '');
  return u;
}

/**
 * Find the project entry for a directory.
 *
 * Three ways in, deliberately ordered:
 *   1. Exact canonical path.
 *   2. Nearest registered ancestor — so `repo/src/api` resolves to `repo`.
 *   3. Same git remote — so a second clone of the same repo inherits the setup instead of
 *      asking again. This one only matches non-excluded entries: "I don't want ClickUp in
 *      that checkout" should not silently spread to every other clone.
 */
export function resolveProject(config, dir) {
  const key = canonicalProjectKey(dir);
  if (!key) return { key: '', entry: null, matchedBy: null, matchedKey: null };

  const projects = config.projects || {};

  if (projects[key]) return { key, entry: projects[key], matchedBy: 'path', matchedKey: key };

  let bestKey = null;
  for (const candidate of Object.keys(projects)) {
    if (key === candidate || key.startsWith(`${candidate}/`)) {
      if (!bestKey || candidate.length > bestKey.length) bestKey = candidate;
    }
  }
  if (bestKey) {
    return { key, entry: projects[bestKey], matchedBy: 'ancestor', matchedKey: bestKey };
  }

  // Only pay for a git subprocess if some project was actually recorded with a remote. On a
  // fresh install, and in every repo that is not registered, this skips the spawn entirely —
  // and "not registered" is the common case for a tool installed globally.
  const withRemote = Object.entries(projects).filter(
    ([, entry]) => entry && entry.git_remote && entry.mode !== MODES.EXCLUDED,
  );
  if (withRemote.length) {
    const remote = gitRemote(dir);
    if (remote) {
      for (const [candidate, entry] of withRemote) {
        if (entry.git_remote === remote) {
          return { key, entry, matchedBy: 'remote', matchedKey: candidate };
        }
      }
    }
  }

  return { key, entry: null, matchedBy: null, matchedKey: null };
}

/** Write (or overwrite) a project entry, preserving fields the caller did not mention. */
export function upsertProject(config, dir, patch) {
  const key = canonicalProjectKey(dir);
  config.projects = config.projects || {};
  const previous = config.projects[key] || {};
  const entry = {
    ...previous,
    ...patch,
    name: patch.name ?? previous.name ?? path.basename(key) ?? key,
    path: key,
    registered_at: previous.registered_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (!entry.git_remote) {
    const remote = gitRemote(dir);
    if (remote) entry.git_remote = remote;
  }
  config.projects[key] = entry;
  return entry;
}

/**
 * The five roles the protocol needs from a board's status set, and the names it falls back to.
 *
 * These defaults are the names used by the boards this tool was built against. They are only
 * FALLBACKS: a space is free to call its statuses anything, and a status name that does not
 * exist makes every `clickup_update_task` fail. So `/clickup-setup` reads the real names from
 * the list (`clickup_get_list` returns them) and records the mapping per project.
 *
 * Verified against a real board: statuses carry a `type` — `open`, `custom`, `done` or
 * `closed` — and ClickUp only stamps `date_closed` on `type: closed`. A status of type
 * `done` (on that board, `reviewed`) closes the task in the UI but leaves `date_closed`
 * null, which is why `done` here means "the closed-group status the protocol actually uses",
 * and why the completion date is never left to `date_closed` alone.
 */
export const STATUS_ROLES = Object.freeze({
  todo: 'to do',
  in_progress: 'in progress',
  on_hold: 'on hold',
  handoff: 'update required',
  done: 'complete',
});

/** The status names in effect for a project: its recorded map, with the fallbacks filled in. */
export function effectiveStatuses(entry) {
  const map = isPlainObject(entry?.statuses) ? entry.statuses : {};
  const out = {};
  for (const [role, fallback] of Object.entries(STATUS_ROLES)) {
    const value = map[role];
    out[role] = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  }
  // Whether the names were actually confirmed against the board, or are just the defaults.
  out.__recorded = Object.keys(map).length > 0;
  return out;
}

/**
 * Settings a project may override locally.
 *
 * This exists because the same machine legitimately needs different answers per board. The three
 * repos this tool generalises proved it: two of them wrote the completion date into `due_date`,
 * while the third forbade touching that field at all — their team uses it as a real deadline, so
 * writing there silently destroys somebody else's due date. A single global answer would have to
 * be wrong for one of them, and "wrong" here means data loss.
 *
 * Anything NOT in this list stays global on purpose: the identity and the lock are properties of
 * the person and the machine, not of the board.
 */
export const OVERRIDABLE = Object.freeze([
  'use_dates',
  'use_priorities',
  'auto_assign',
  'end_date_field',
  'search_window_days',
]);

/** Global defaults with a project's overrides applied on top. */
export function effectiveDefaults(config, entry) {
  const base = { ...(config?.defaults || {}) };
  const overrides = entry?.overrides;
  if (isPlainObject(overrides)) {
    for (const key of OVERRIDABLE) {
      if (overrides[key] !== undefined && overrides[key] !== null) base[key] = overrides[key];
    }
  }
  return base;
}

/** True when the identity is usable for assigning work. Anything less means "stop and ask". */
export function identityReady(config) {
  const id = config?.identity?.clickup_user_id;
  return Boolean(id && String(id).trim() && config.identity.confirmed);
}

/** Record a git email as belonging to this human, so their own comments read as their own. */
export function rememberGitEmail(config, email) {
  if (!email) return false;
  const normalised = String(email).trim().toLowerCase();
  if (!normalised) return false;
  config.identity.git_emails = config.identity.git_emails || [];
  const known = config.identity.git_emails.map((e) => String(e).toLowerCase());
  if (known.includes(normalised)) return false;
  config.identity.git_emails.push(normalised);
  return true;
}

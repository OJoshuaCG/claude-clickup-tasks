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
import { configPath, toolHome, canonicalProjectKey, writeJsonAtomic } from './paths.mjs';

export const CONFIG_VERSION = 1;

/** Modes a project can be in. `excluded` is a real, recorded answer — not the absence of one. */
export const MODES = Object.freeze({
  TASKS: 'tasks', // several normal tasks in a list (mensajeria-style)
  UMBRELLA: 'umbrella', // one parent task, work happens in subtasks (frontend/backend-style)
  EXCLUDED: 'excluded', // the user said no. Recorded so we never ask again.
});

/**
 * El ROL de un proyecto dentro de la cadena de entrega.
 *
 * Reemplaza al booleano `handoff`, que no alcanzaba por dos motivos:
 *
 *   1. No tenía DIRECCIÓN. El flujo es asimétrico: un backend entrega dejando la tarea en el
 *      estado de handoff, donde el frontend la va a buscar; un frontend que necesita algo del
 *      backend NO usa ese estado —devolverla ahí la deja en el filtro de quien ya terminó, y
 *      nadie del backend se enteraría— sino `on hold` con un pedido concreto.
 *   2. No sabía si había alguien del otro lado. Un backend que parkea una tarea en el estado de
 *      handoff sin un frontend que mire ese filtro deja la tarea esperando a NADIE. Parece que
 *      entregó, y en realidad la perdió.
 */
export const ROLES = Object.freeze({
  BACKEND: 'backend',
  FRONTEND: 'frontend',
  FULLSTACK: 'fullstack',
});

/**
 * Qué puede hacer un proyecto al cerrar y dónde busca su trabajo, derivado de rol + contraparte.
 *
 * La asimetría es deliberada y sale del flujo real:
 *
 * - Un BACKEND sin contraparte registrada **no puede parkear en handoff**: no hay quien mire ese
 *   estado, así que cierra. Es la regla que evita la tarea que espera a nadie.
 * - Un FRONTEND **sí puede pedirle trabajo al backend aunque su repo no esté registrado**, porque
 *   el pedido es a una persona, no a un repositorio: una tarea en `on hold` con un pedido escrito
 *   la encuentra cualquiera, no hace falta que nadie vigile un filtro.
 */
export function roleBehaviour(entry, config = null) {
  const role = [ROLES.BACKEND, ROLES.FRONTEND, ROLES.FULLSTACK].includes(entry?.role)
    ? entry.role
    : ROLES.FULLSTACK;
  const counterpart = entry?.counterpart || null;

  // Una contraparte declarada no basta: tiene que poder RECIBIR.
  //
  // Si `be` declara a `fe` como contraparte pero `fe` es fullstack, o está excluido, o mira otra
  // lista, entonces `be` parkea tareas que nadie va a levantar. Es el mismo fallo que el modelo
  // de rol vino a evitar, un nivel más arriba: la herramienta cree que entregó y en realidad
  // perdió la tarea.
  //
  // Cuando se pasa el config, la contraparte se VALIDA y `canHandoff` degrada solo. Sin config
  // (llamadas sueltas, tests unitarios) se confía en lo declarado.
  let counterpartProblem = null;
  if (counterpart && config) {
    const otro = config.projects?.[counterpart];
    if (!otro) {
      counterpartProblem = 'no está registrada';
    } else if (otro.mode === MODES.EXCLUDED) {
      counterpartProblem = 'está EXCLUIDA de ClickUp: no gestiona tareas';
    } else if (otro.role === ROLES.FULLSTACK || !otro.role) {
      counterpartProblem = `es \`${otro.role || 'fullstack'}\`: no mira el estado de handoff`;
    } else if (otro.role === role) {
      counterpartProblem = `tiene el MISMO rol (\`${role}\`): nadie recibe la entrega`;
    } else if (entry.list_id && otro.list_id && entry.list_id !== otro.list_id) {
      counterpartProblem =
        `mira otra lista (\`${otro.list_id}\` vs \`${entry.list_id}\`): el handoff ocurre sobre ` +
        'la MISMA tarea, así que en listas distintas no llega nunca';
    }
  }

  switch (role) {
    case ROLES.BACKEND:
      return {
        role,
        counterpart,
        // Contraparte declarada Y usable: si no puede recibir, parkear pierde la tarea.
        canHandoff: Boolean(counterpart) && !counterpartProblem,
        counterpartProblem,
        // Su bandeja es el backlog más los pedidos que le dejó el otro lado.
        inbox: 'todo',
        canRequestFromOther: false,
        closesChain: !counterpart || Boolean(counterpartProblem),
      };
    case ROLES.FRONTEND:
      return {
        role,
        counterpart,
        // El frontend es el final de la cadena: no entrega hacia adelante, cierra.
        canHandoff: false,
        // Su entrada natural es el estado de handoff, NO `to do` (eso es backlog del backend).
        inbox: 'handoff',
        // Opción (b): puede pedirle trabajo al backend exista o no su repo.
        canRequestFromOther: true,
        closesChain: true,
        counterpartProblem,
      };
    default:
      return {
        role: ROLES.FULLSTACK,
        // Un fullstack no tiene contraparte por definición: hace las dos puntas.
        counterpart: null,
        canHandoff: false,
        inbox: 'todo',
        canRequestFromOther: false,
        closesChain: true,
        counterpartProblem: null,
      };
  }
}

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
    BASELINE.set(config, structuredClone(config));
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

/**
 * Los bytes de los que salió cada objeto de config, para poder distinguir "esto lo cambié yo"
 * de "esto ya estaba así". Es un WeakMap: si el caller suelta el config, la baseline se va con él.
 */
const BASELINE = new WeakMap();

/** Espera bloqueante sin dependencias ni busy-loop. */
function dormir(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const hasta = Date.now() + ms;
    while (Date.now() < hasta) {
      /* último recurso: SharedArrayBuffer deshabilitado */
    }
  }
}

/**
 * Lock entre procesos con `mkdir`, que es atómico en POSIX y en Windows y no necesita nada
 * instalado. Un lock viejo se rompe: si el proceso que lo tomó murió, nadie lo va a soltar.
 *
 * Si el lock no se consigue dentro del timeout se escribe igual. Perder una escritura por
 * contención sería peor que el problema que el lock resuelve: el usuario dio una orden y la
 * orden tiene que tener efecto. En el peor caso se degrada al comportamiento de antes.
 */
function conLock(fn, { timeoutMs = 5000, staleMs = 30000 } = {}) {
  const dir = `${configPath()}.lock`;
  const desde = Date.now();
  let tomado = false;
  while (Date.now() - desde < timeoutMs) {
    try {
      fs.mkdirSync(dir);
      tomado = true;
      break;
    } catch (err) {
      if (err && err.code !== 'EEXIST') break; // un problema de permisos no se resuelve esperando
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > staleMs) {
          fs.rmSync(dir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // el lock se soltó entre el statSync y nosotros: reintentar ya
      }
      dormir(10 + Math.floor(Math.random() * 30));
    }
  }
  try {
    return fn();
  } finally {
    if (tomado) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* si no se puede borrar, el staleMs lo recicla */
      }
    }
  }
}

/**
 * Aplica sobre `fresco` sólo lo que cambió entre `base` (lo que este proceso leyó) y
 * `propuesto` (lo que este proceso quiere escribir).
 *
 * Esto es lo que separa una fusión ciega de una correcta: una fusión ciega resucitaría la
 * entrada que `project forget` acaba de borrar. Acá el borrado es una intención explícita
 * (estaba en base, no está en propuesto) y se respeta, mientras que las claves que otro
 * proceso agregó — que no están ni en base ni en propuesto — sobreviven intactas.
 */
function aplicarIntencion(fresco, base, propuesto) {
  for (const k of Object.keys(propuesto)) {
    const nuevo = propuesto[k];
    const viejo = base ? base[k] : undefined;
    if (isPlainObject(nuevo) && isPlainObject(viejo) && isPlainObject(fresco[k])) {
      aplicarIntencion(fresco[k], viejo, nuevo);
    } else if (JSON.stringify(nuevo) !== JSON.stringify(viejo)) {
      fresco[k] = structuredClone(nuevo);
    }
  }
  if (!base) return fresco;
  for (const k of Object.keys(base)) {
    if (!(k in propuesto)) delete fresco[k];
  }
  return fresco;
}

/**
 * Escritura atómica (archivo temporal + rename) bajo lock, reconciliada contra el disco.
 *
 * El rename atómico por sí solo evita un archivo truncado, pero NO evita el lost update: dos
 * sesiones de Claude Code en proyectos distintos leen el mismo config, cada una agrega su
 * proyecto, y el último rename borra el trabajo de la otra. Medido: 12 de 20 registros
 * simultáneos se perdían. Por eso se relee el disco DENTRO del lock y se aplica sólo la
 * intención de este proceso.
 */
export function saveConfig(config) {
  fs.mkdirSync(toolHome(), { recursive: true });
  const file = configPath();
  return conLock(() => {
    const base = BASELINE.get(config);
    let salida = config;
    if (base) {
      const disco = loadConfigSinBaseline();
      // Un config ilegible en disco no se reconcilia: fusionar contra defaults borraría lo que
      // el usuario tiene escrito a mano. Se escribe lo que este proceso decidió, sin más.
      if (disco.ok && disco.existed) {
        salida = aplicarIntencion(disco.config, base, config);
      }
    }
    salida.updated_at = new Date().toISOString();
    writeJsonAtomic(file, salida);
    // El caller sigue teniendo su objeto en la mano y a veces imprime desde él: se sincroniza
    // con lo que realmente quedó escrito, para que no muestre algo distinto del archivo.
    if (salida !== config) {
      for (const k of Object.keys(config)) if (!(k in salida)) delete config[k];
      Object.assign(config, structuredClone(salida));
    }
    BASELINE.set(config, structuredClone(salida));
    return file;
  });
}

/** loadConfig sin registrar baseline: la relectura de dentro del lock no es la del caller. */
function loadConfigSinBaseline() {
  const file = configPath();
  if (!fs.existsSync(file)) return { config: defaultConfig(), ok: true, existed: false };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isPlainObject(parsed)) throw new Error('la raíz del config no es un objeto');
    const config = fillDefaults(parsed, defaultConfig());
    config.version = CONFIG_VERSION;
    return { config, ok: true, existed: true };
  } catch {
    return { config: defaultConfig(), ok: false, existed: true };
  }
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

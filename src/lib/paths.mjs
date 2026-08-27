// Resolution of every path the tool touches.
//
// Single source of truth on purpose: the installer, the runtime CLI and the hooks all have to
// agree on where the config lives, and a second copy of this logic is how you get an installer
// that writes to one place and a hook that reads another.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/** Root of the user's Claude Code configuration. `CLAUDE_CONFIG_DIR` is respected — some people move it. */
export function claudeHome() {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), '.claude');
}

/** Self-contained install dir: engine + config + state. Removing it removes the tool's own data. */
export function toolHome() {
  return path.join(claudeHome(), 'clickup-flow');
}

export function configPath() {
  return path.join(toolHome(), 'config.json');
}

export function statePath() {
  return path.join(toolHome(), 'state');
}

export function settingsPath() {
  return path.join(claudeHome(), 'settings.json');
}

export function skillsDir() {
  return path.join(claudeHome(), 'skills');
}

export function commandsDir() {
  return path.join(claudeHome(), 'commands');
}

export function backupsDir() {
  return path.join(toolHome(), 'backups');
}

/**
 * Canonical key for a project directory.
 *
 * Forward slashes and a lowercased Windows drive letter, because the same project reaches us
 * as `C:\Users\x\p` from a Windows hook and `/mnt/c/Users/x/p` from WSL. Those stay different
 * keys — they genuinely are different checkouts — but at least the same checkout always
 * produces the same string instead of one key per capitalisation of the drive.
 */
export function canonicalProjectKey(dir) {
  if (!dir) return '';
  let p = String(dir).replace(/\\/g, '/');

  // Collapse repeated separators. These show up in real life from concatenating a path that
  // already ended in one, and two spellings of the same directory must not become two config
  // entries. The leading `//` of a UNC path (`\\server\share`) is preserved: there it is part
  // of the address, not an accident.
  const uncPrefix = p.startsWith('//') ? '//' : '';
  p = uncPrefix + p.slice(uncPrefix.length).replace(/\/{2,}/g, '/');

  // Drop a trailing separator, but keep a bare root (`/`, `C:/`) intact.
  if (p.length > 1 && p.endsWith('/') && !/^[A-Za-z]:\/$/.test(p)) p = p.slice(0, -1);

  p = p.replace(/^([A-Za-z]):\//, (_m, d) => `${d.toLowerCase()}:/`);
  return p;
}

/** Stable, filesystem-safe filename for a project's local state. */
export function projectStateFile(projectKey) {
  const hash = fnv1a32(canonicalProjectKey(projectKey));
  const slug =
    canonicalProjectKey(projectKey)
      .split('/')
      .filter(Boolean)
      .pop()
      ?.replace(/[^A-Za-z0-9._-]/g, '-')
      .slice(0, 40) || 'project';
  return path.join(statePath(), `${slug}-${hash}.json`);
}

/**
 * FNV-1a, 32-bit, hex. Not a security primitive — it only has to be stable across platforms
 * and node versions so a project's state file keeps the same name forever.
 */
export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Absolute POSIX-style path — what goes into settings.json hook commands (works in sh, cmd and pwsh). */
export function forwardSlash(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * How the agent should invoke this CLI, as a shell-ready string.
 *
 * Written into the skill and the slash commands at install time and used by `protocol.mjs`, so
 * nothing the agent reads ever depends on a `clickup-flow` shim being on PATH. A bare command
 * name would work on the machine that installed it and fail silently on the next one — and the
 * failure would look like "the protocol did nothing", which is the worst way for this to break.
 *
 * `config.cli_invocation` overrides it, so a user who does put a shim on PATH gets the short form.
 */
export function cliInvocation(config) {
  const override = config?.cli_invocation;
  if (typeof override === 'string' && override.trim()) return override.trim();
  return `node "${forwardSlash(path.join(toolHome(), 'src', 'cli.mjs'))}"`;
}

/**
 * Escritura atómica de JSON: archivo temporal y después rename.
 *
 * El rename es lo que evita que una caída en el medio deje un archivo truncado. En Windows, sin
 * embargo, `rename` sobre un archivo existente falla con EPERM/EACCES si CUALQUIER otro proceso
 * lo tiene abierto — aunque sea sólo para leer. Y acá eso pasa seguido: los hooks leen el config
 * en cada prompt, así que un `project set` podía fallar de forma intermitente sin que el usuario
 * entendiera por qué.
 *
 * Medido: con 20 procesos escribiendo a la vez, 1 fallaba con EPERM en Windows y ninguno en Linux.
 * El reintento con espera creciente cubre la ventana en la que el lector suelta el archivo.
 */
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  try {
    renameConReintentos(tmp, file);
  } catch (err) {
    // El temporal no puede quedar tirado: acumularlos convierte un fallo transitorio en basura
    // permanente al lado del config del usuario.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* si tampoco se puede borrar, el error de arriba es el que importa */
    }
    throw err;
  }
  return file;
}

/** Los errno que en Windows significan "alguien lo tiene abierto, probá de nuevo". */
const REINTENTABLES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function renameConReintentos(desde, hacia, intentos = 12) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(desde, hacia);
      return;
    } catch (err) {
      if (i >= intentos - 1 || !REINTENTABLES.has(err?.code)) throw err;
      dormir(5 + i * 10 + Math.floor(Math.random() * 10));
    }
  }
}

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

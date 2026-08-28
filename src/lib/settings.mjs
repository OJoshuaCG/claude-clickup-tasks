// Merging into ~/.claude/settings.json.
//
// This is the only file in the tool that edits something the user already owns, so it is written
// defensively on purpose:
//
//   * Every write is preceded by a timestamped backup.
//   * Only keys this tool put there are ever removed. Unknown keys, other people's hooks and
//     the user's permission lists are carried through untouched.
//   * Install is idempotent: our hooks are matched by the marker in their command string, so
//     running the installer twice registers them once.
//
// Identifying our own entries by a marker substring rather than a custom JSON field is
// deliberate — a field the settings schema does not know about is a field a future version of
// Claude Code is free to strip, and then uninstall could no longer find what to remove.

import fs from 'node:fs';
import path from 'node:path';
import { settingsPath, backupsDir, forwardSlash, writeJsonAtomic } from './paths.mjs';

/** Appears in every hook command we register. Both idempotency and uninstall key off it. */
export const HOOK_MARKER = 'clickup-flow/src/cli.mjs';

/** MCP tools the protocol calls constantly and that only read. Pre-allowing them removes the
 *  prompt storm without granting anything that can modify a shared board. */
export const READONLY_MCP_PERMISSIONS = [
  'mcp__claude_ai_ClickUp__clickup_get_workspace_hierarchy',
  'mcp__claude_ai_ClickUp__clickup_get_workspace_members',
  'mcp__claude_ai_ClickUp__clickup_find_member_by_name',
  'mcp__claude_ai_ClickUp__clickup_resolve_assignees',
  'mcp__claude_ai_ClickUp__clickup_filter_tasks',
  'mcp__claude_ai_ClickUp__clickup_search',
  'mcp__claude_ai_ClickUp__clickup_get_task',
  'mcp__claude_ai_ClickUp__clickup_get_task_comments',
  'mcp__claude_ai_ClickUp__clickup_get_list',
  'mcp__claude_ai_ClickUp__clickup_get_folder',
  'mcp__claude_ai_ClickUp__clickup_get_custom_fields',
];

export function readSettings() {
  const file = settingsPath();
  if (!fs.existsSync(file)) return { settings: {}, existed: false, error: null };
  try {
    let raw = fs.readFileSync(file, 'utf8');
    // Quitar el BOM antes de parsear. Varios editores de Windows lo escriben, y `JSON.parse` lo
    // rechaza: sin esto el instalador aborta con "settings.json inválido" sobre un archivo que
    // está perfectamente bien, en la máquina donde más probable es que aparezca.
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    if (!raw.trim()) return { settings: {}, existed: true, error: null };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('settings.json root is not an object');
    }
    return { settings: parsed, existed: true, error: null };
  } catch (err) {
    return {
      settings: null,
      existed: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Cuántos backups de settings.json se conservan. Suficientes para volver atrás, no infinitos. */
const KEEP_BACKUPS = 10;

export function backupSettings() {
  const file = settingsPath();
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(backupsDir(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupsDir(), `settings-${stamp}.json`);
  fs.copyFileSync(file, dest);
  pruneBackups();
  return dest;
}

/**
 * Conserva los N backups más nuevos y borra el resto.
 *
 * Sin esto, cada instalación deja un archivo para siempre: reinstalar diez veces deja diez copias
 * de un settings.json que nadie va a mirar. Solo se tocan los archivos con nuestro prefijo, nunca
 * otra cosa que haya en la carpeta.
 */
function pruneBackups() {
  try {
    const dir = backupsDir();
    const mine = fs
      .readdirSync(dir)
      .filter((f) => /^settings-.*\.json$/.test(f))
      .sort(); // el timestamp ISO ordena cronológicamente como texto
    for (const stale of mine.slice(0, Math.max(0, mine.length - KEEP_BACKUPS))) {
      fs.rmSync(path.join(dir, stale), { force: true });
    }
  } catch {
    /* limpiar backups es cortesía: que falle no debe romper una instalación */
  }
}

export function writeSettings(settings) {
  return writeJsonAtomic(settingsPath(), settings);
}

/**
 * Herramientas MCP de ClickUp que MUTAN el tablero.
 *
 * Es el matcher del hook `PostToolUse`, y de él depende toda la verificación: lo que no esté en
 * esta lista no deja evidencia, y un claim que solo se cerró con una herramienta ausente acá
 * quedaría marcado como "sin sincronizar" para siempre. Por eso la lista es generosa con las
 * escrituras y no incluye ninguna lectura: una lectura no es prueba de que el trabajo se registró.
 */
export const MCP_WRITE_TOOLS = [
  'clickup_create_task',
  'clickup_update_task',
  'clickup_create_task_comment',
  'clickup_create_comment',
  'clickup_update_comment',
  'clickup_add_tag_to_task',
  'clickup_remove_tag_from_task',
  'clickup_move_task',
  'clickup_add_task_to_list',
  'clickup_add_task_dependency',
  'clickup_attach_task_file',
  'clickup_delete_task',
];

/** El matcher de PostToolUse, anclado para que no cace herramientas de otro servidor MCP. */
export function mcpWriteMatcher() {
  return `^mcp__claude_ai_ClickUp__(${MCP_WRITE_TOOLS.join('|')})$`;
}

/**
 * Los hooks que instala la herramienta, como ternas (evento, matcher, comando).
 *
 * QUÉ CAMBIÓ Y POR QUÉ, porque este arreglo es el que redefine el producto:
 *
 *   · `UserPromptSubmit` SE FUE. Spawneaba node en cada prompt de cada proyecto de la máquina
 *     —0.14 s medidos por turno en repos donde el resultado estaba garantizado que era 0— y en
 *     los proyectos registrados inyectaba ~70 palabras por turno repitiendo lo que el modelo ya
 *     había leído. Su única función real (que una sesión larga no se olvide tras compactar) la
 *     cubre `SessionStart`, que se dispara también en `compact`.
 *
 *   · `PreToolUse` ahora incluye **Bash**. Sin eso el candado era decorativo: `cat > archivo`,
 *     `sed -i`, `tee` y `git apply` pasaban de largo, y el modo `bypassPermissions` le RECOMIENDA
 *     al agente exactamente esas formas por encima de Edit/Write.
 *
 *   · `PostToolUse` es NUEVO, y es la pieza que cierra el hueco de fondo. El conector de ClickUp
 *     es OAuth de claude.ai: no hay token en disco y ningún proceso fuera de una sesión puede
 *     llamarlo, así que el CLI nunca va a poder escribir en el tablero. Pero SÍ puede mirar: el
 *     `tool_response` de cada mutación MCP es evidencia real, y con eso el registro local deja de
 *     ser lo que el modelo dice que hizo.
 *
 *   · `Stop` es NUEVO, y es la obligación. Sale con 2 si hay una tarea reclamada sin ninguna
 *     mutación registrada, y eso impide cerrar el turno. Es lo que convierte el protocolo de una
 *     sugerencia en markdown a algo de lo que el modelo no puede salirse.
 */
export function hookSpecs(cliPath) {
  const cli = forwardSlash(cliPath);
  const invoke = (sub) => `node "${cli}" ${sub}`;
  return [
    {
      event: 'SessionStart',
      // Sin matcher = todos los disparadores, `compact` incluido. Ese es justamente el que
      // reemplaza al viejo hook por prompt: reinyecta el protocolo cuando el contexto se compacta.
      matcher: null,
      command: invoke('session-start'),
      why: 'Anuncia el destino de ClickUp del proyecto, o que todavía no tiene ninguno.',
    },
    {
      event: 'PreToolUse',
      matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash',
      command: invoke('guard'),
      why: 'Bloquea escrituras sin tarea, y pregunta una vez por los proyectos nuevos.',
    },
    {
      event: 'PostToolUse',
      matcher: mcpWriteMatcher(),
      command: invoke('sync-hook'),
      why: 'Registra las mutaciones REALES de ClickUp leyendo el resultado de la herramienta.',
    },
    {
      event: 'Stop',
      matcher: null,
      command: invoke('stop-hook'),
      why: 'No deja cerrar el turno con una tarea reclamada y sin sincronizar.',
    },
  ];
}

/** Cuántos hooks debería haber instalados. `doctor` lo usa para no tener el número a mano. */
export const HOOK_COUNT = 4;

function isOurHook(entry) {
  return typeof entry?.command === 'string' && entry.command.includes(HOOK_MARKER);
}

/**
 * Add our hooks, replacing any previous copy of them.
 *
 * Claude Code's shape is `hooks[event] = [{ matcher?, hooks: [{type, command}] }]`. We look for
 * an existing group with the same matcher and append into it, rather than always adding a new
 * group — several groups with the same matcher all fire, which works but reads as a mess in a
 * file the user is expected to open.
 */
export function installHooks(settings, cliPath) {
  const specs = hookSpecs(cliPath);

  // `!Array.isArray` no es paranoia: un array TAMBIÉN es `typeof 'object'`, así que la versión
  // anterior aceptaba un `"hooks": []` y le colgaba los eventos como propiedades. En memoria
  // funcionaba y el instalador reportaba "3 hooks registrados" — pero `JSON.stringify` descarta
  // las propiedades de un array, así que al archivo no llegaba NADA. Éxito reportado, cero
  // efecto: el peor modo de fallo posible.
  const usable =
    settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks);
  settings.hooks = usable ? settings.hooks : {};
  const added = [];

  // Drop previous copies first so re-installing is a replace, not an accumulation.
  removeHooks(settings);

  for (const spec of specs) {
    if (!Array.isArray(settings.hooks[spec.event])) settings.hooks[spec.event] = [];
    const groups = settings.hooks[spec.event];
    const wantMatcher = spec.matcher ?? undefined;

    let group = groups.find((g) => {
      const has = g && typeof g === 'object' && Array.isArray(g.hooks);
      if (!has) return false;
      const gm = g.matcher === '' ? undefined : g.matcher;
      return gm === wantMatcher;
    });

    if (!group) {
      group = spec.matcher ? { matcher: spec.matcher, hooks: [] } : { hooks: [] };
      groups.push(group);
    }

    group.hooks.push({ type: 'command', command: spec.command });
    added.push(spec);
  }

  return added;
}

/** Remove every hook this tool registered, and prune the containers it emptied. */
export function removeHooks(settings) {
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    return 0;
  }
  let removed = 0;

  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;

    // Cuántos había antes de tocar nada: si no quitamos nada de este evento, no se toca.
    const removedHere = { n: 0 };

    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter((h) => !isOurHook(h));
      const diff = before - group.hooks.length;
      removedHere.n += diff;
      removed += diff;
    }

    // Si no había nada nuestro en este evento, se deja EXACTAMENTE como estaba. La versión
    // anterior borraba un `"PreToolUse": []` que el usuario tenía puesto a propósito: quitar algo
    // que nunca pusimos es modificar su archivo sin motivo, y rompe la única promesa que importa.
    if (removedHere.n === 0) continue;

    // Solo se descartan los grupos que NOSOTROS vaciamos.
    settings.hooks[event] = groups.filter((g) => {
      if (!g || !Array.isArray(g.hooks)) return true;
      return g.hooks.length > 0;
    });

    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }

  return removed;
}

/**
 * Union our read-only MCP permissions into `permissions.allow`.
 *
 * Union, never assignment: this list sits next to whatever the user already allowed, and the
 * only acceptable failure mode here is "we added one entry too many", never "we dropped one".
 */
export function mergePermissions(settings, entries = READONLY_MCP_PERMISSIONS) {
  const usablePerms =
    settings.permissions &&
    typeof settings.permissions === 'object' &&
    !Array.isArray(settings.permissions);
  settings.permissions = usablePerms ? settings.permissions : {};

  // Un `allow` malformado NO se descarta: se rescata lo que se pueda.
  //
  // La versión anterior hacía `Array.isArray(...) ? ... : []`, así que un `"allow": "mcp__mio__*"`
  // (malformado, pero el valor del usuario) desaparecía en silencio. Perder un permiso es
  // exactamente lo que este archivo promete no hacer, sin importar que la forma estuviera mal.
  const raw = settings.permissions.allow;
  let allow;
  if (Array.isArray(raw)) {
    allow = raw;
  } else if (typeof raw === 'string' && raw.trim()) {
    allow = [raw];
  } else {
    allow = [];
  }
  const present = new Set(allow);
  const added = [];

  // A blanket `mcp__claude_ai_ClickUp__*` already covers everything we would add.
  const wildcard = allow.some(
    (e) => typeof e === 'string' && /^mcp__claude_ai_ClickUp__\*$/.test(e.trim()),
  );
  if (wildcard) {
    settings.permissions.allow = allow;
    return added;
  }

  for (const entry of entries) {
    if (!present.has(entry)) {
      allow.push(entry);
      present.add(entry);
      added.push(entry);
    }
  }
  settings.permissions.allow = allow;
  return added;
}

/** Undo `mergePermissions` — only the exact entries we know we added. */
export function unmergePermissions(settings, entries = READONLY_MCP_PERMISSIONS) {
  const allow = settings?.permissions?.allow;
  if (!Array.isArray(allow)) return 0;
  const drop = new Set(entries);
  const before = allow.length;
  settings.permissions.allow = allow.filter((e) => !drop.has(e));
  return before - settings.permissions.allow.length;
}

/** What is currently installed — used by `doctor` and by the installer's "already set up" path. */
export function inspectInstalled(settings) {
  const found = [];
  if (settings?.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)) {
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (!group || !Array.isArray(group.hooks)) continue;
        for (const h of group.hooks) {
          if (isOurHook(h)) found.push({ event, matcher: group.matcher ?? null, command: h.command });
        }
      }
    }
  }
  return found;
}

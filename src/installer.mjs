#!/usr/bin/env node
//
// clickup-flow — installer.
//
// Installs a global ClickUp task protocol into the user's Claude Code setup: a skill, three slash
// commands, and three hooks. One TUI implementation shared by Linux, macOS and Windows — the
// shell wrappers (`install.sh`, `install.ps1`) only check for node and hand over to this file, so
// the interactive logic exists once instead of twice and cannot drift between platforms.
//
// THE PROMISE THIS FILE MAKES: it never destroys configuration the user already had. Every merge
// is a union, every write is preceded by a backup, and re-running it is a replace of our own
// entries rather than an accumulation. `--uninstall` removes only what we added.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  claudeHome,
  toolHome,
  configPath,
  skillsDir,
  commandsDir,
  backupsDir,
  statePath,
  forwardSlash,
  cliInvocation,
} from './lib/paths.mjs';
import { loadConfig, saveConfig, defaultConfig, MODES } from './lib/config.mjs';
import {
  readSettings,
  writeSettings,
  backupSettings,
  installHooks,
  removeHooks,
  mergePermissions,
  unmergePermissions,
  inspectInstalled,
} from './lib/settings.mjs';
import {
  Prompt,
  box,
  banner as drawBanner,
  heading,
  say,
  ok,
  fail,
  warn,
  info,
  note,
  c,
  SYM,
} from './lib/tui.mjs';
import { looksLikeToken, listWorkspaces, matchMember } from './lib/clickup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const ASSETS = path.join(REPO, 'assets');

/** Versión de la herramienta, leída de package.json. Si falta, no se inventa. */
function toolVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

const SKILL_NAME = 'clickup-task-flow';
const COMMAND_FILES = ['tarea.md', 'clickup-setup.md', 'clickup-config.md'];

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) {
      out._.push(t);
      continue;
    }
    const body = t.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[body] = true;
    else {
      out[body] = next;
      i++;
    }
  }
  return out;
}

function copyDirFiltered(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDirFiltered(src, dest);
    else if (entry.isFile()) fs.copyFileSync(src, dest);
  }
}

/**
 * Borra del motor instalado lo que la versión nueva ya no trae.
 *
 * Devuelve `{ borrados, retenidos }`.
 *
 * Reemplaza a un `rmSync` del directorio entero antes de copiar. Un archivo que no se puede
 * borrar se informa y se sigue: dejar un `.mjs` viejo que nadie importa es molesto, abortar la
 * instalación por él es peor.
 */
function pruneOrphanEngineFiles(from, to) {
  const esperados = new Set();
  (function recorrer(dir, prefijo) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefijo ? `${prefijo}/${entry.name}` : entry.name;
      if (entry.isDirectory()) recorrer(path.join(dir, entry.name), rel);
      else if (entry.isFile()) esperados.add(rel);
    }
  })(from, '');

  const borrados = [];
  const retenidos = [];
  (function limpiar(dir, prefijo) {
    let entradas;
    try {
      entradas = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entradas) {
      const rel = prefijo ? `${prefijo}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        limpiar(abs, rel);
        try {
          if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
        } catch {
          /* un directorio que no se vacía no es un problema del usuario */
        }
      } else if (!esperados.has(rel)) {
        try {
          fs.rmSync(abs, { force: true });
          borrados.push(rel);
        } catch {
          retenidos.push(rel);
        }
      }
    }
  })(to, '');

  return { borrados, retenidos };
}

/**
 * Manifiesto de archivos instalados.
 *
 * Existe por un modo de fallo concreto y verificado: si una versión renombra o deja de traer un
 * comando, instalar la nueva encima de la vieja NO borra el archivo viejo. Queda un `/comando`
 * huérfano, visible para el usuario, que apunta a un flujo que la versión nueva ya no soporta —
 * y no hay forma de distinguirlo de un comando propio del usuario.
 *
 * Con el manifiesto, cada instalación sabe exactamente qué archivos puso la anterior y borra los
 * que ya no corresponden. Y la desinstalación deja de depender de una lista hardcodeada que hay
 * que acordarse de actualizar.
 *
 * Las rutas se guardan RELATIVAS a la carpeta de configuración de Claude Code, para que mover esa
 * carpeta (o cambiar CLAUDE_CONFIG_DIR) no deje el manifiesto apuntando al vacío.
 */
function relToClaude(absPath) {
  return forwardSlash(path.relative(claudeHome(), absPath));
}

/**
 * Borra los archivos que la instalación anterior puso y esta ya no trae.
 *
 * Solo toca rutas que estaban en el manifiesto: un archivo que el usuario creó con el mismo
 * nombre nunca estuvo ahí, así que no se toca.
 */
function pruneStaleFiles(previous, current) {
  const keep = new Set(current);
  const removed = [];
  for (const rel of previous || []) {
    if (keep.has(rel)) continue;
    const abs = path.join(claudeHome(), rel);
    try {
      if (fs.existsSync(abs)) {
        fs.rmSync(abs, { recursive: true, force: true });
        removed.push(rel);
      }
    } catch {
      /* si no se puede borrar, se informa y se sigue: no vale abortar una instalación por esto */
    }
  }
  return removed;
}

/** Substitute `{{CLI}}` so nothing the agent reads depends on a PATH shim. */
function renderAsset(srcFile, destFile, cli) {
  const raw = fs.readFileSync(srcFile, 'utf8');
  const rendered = raw.split('{{CLI}}').join(cli);
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.writeFileSync(destFile, rendered, 'utf8');
}

/**
 * Write `clickup-flow` / `clickup-flow.cmd` wrappers next to the engine.
 *
 * We deliberately do NOT edit the user's PATH or shell rc files — that is somebody else's file
 * and a global installer has no business rewriting it. Instead the wrappers exist, the summary
 * says how to reach them, and everything the AGENT reads uses the fully-resolved
 * `node "<path>/cli.mjs"` form, so the protocol never depends on the short name being available.
 */
function writeWrappers(toolDir) {
  const cliPath = forwardSlash(path.join(toolDir, 'src', 'cli.mjs'));
  const sh = path.join(toolDir, 'clickup-flow');
  const cmd = path.join(toolDir, 'clickup-flow.cmd');

  fs.writeFileSync(
    sh,
    `#!/usr/bin/env sh
# Wrapper de conveniencia para humanos. Lo que lee el agente usa la ruta completa.
exec node "${cliPath}" "\$@"
`,
    'utf8',
  );
  try {
    fs.chmodSync(sh, 0o755);
  } catch {
    /* chmod is meaningless on some Windows filesystems; the .cmd wrapper covers that case */
  }

  fs.writeFileSync(
    cmd,
    `@echo off\r\nrem Wrapper de conveniencia para humanos.\r\nnode "${cliPath}" %*\r\n`,
    'utf8',
  );

  return { sh, cmd };
}

function banner() {
  drawBanner([
    `${c.bold('clickup-flow')}  ${c.gray('·')}  protocolo de tareas de ClickUp para Claude Code`,
    c.gray('Instalación global: una vez, y sirve para todos tus proyectos.'),
  ]);
}

// ---------------------------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------------------------

function preflight() {
  heading('Verificación previa');
  const problems = [];

  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (Number.isFinite(major) && major >= 18) {
    ok(`node ${process.version}`);
  } else {
    fail(`node ${process.version} — hace falta 18 o superior`);
    problems.push('node demasiado viejo');
  }

  const home = claudeHome();
  if (fs.existsSync(home)) {
    ok(`configuración de Claude Code en ${home}`);
  } else {
    // Not fatal: a fresh machine may not have run Claude Code yet, and creating the directory
    // is exactly what Claude Code itself would do on first launch.
    warn(`no existe ${home} todavía — se va a crear`);
  }

  const { error } = readSettings();
  if (error) {
    fail(`settings.json no se puede leer: ${error}`);
    note('Arreglá ese JSON antes de instalar: no vamos a sobrescribir un archivo que no entendemos.');
    problems.push('settings.json inválido');
  } else {
    ok('settings.json legible');
  }

  return problems;
}

// ---------------------------------------------------------------------------------------------
// the interview
// ---------------------------------------------------------------------------------------------

async function interview(prompt, existing) {
  const answers = {};

  heading('1. Tu usuario de ClickUp');
  box(
    'Por qué esto es la pregunta más importante',
    [
      'Las tareas se asignan a un id NUMÉRICO de ClickUp. El atajo "me" que suele usarse ' +
        'resuelve al dueño del token de la integración, no a quien ejecuta: en un equipo eso le ' +
        'asigna todas las tareas a la misma persona. No falla, no avisa, y se descubre semanas ' +
        'después.',
      '',
      'Con tu email o usuario dejamos resuelto el id correcto de una vez.',
    ],
    { color: c.yellow },
  );

  answers.clickupQuery = await prompt.text('Tu email o usuario de ClickUp', {
    def: existing?.identity?.clickup_email ?? existing?.identity?.pending_query ?? '',
    required: false,
    hint: 'Si no lo sabés ahora, dejalo vacío: Claude lo resuelve en la primera sesión.',
  });

  heading('2. Cómo querés que se registren las tareas');

  answers.useDates = await prompt.confirm('¿Registrar fechas de inicio y fin?', {
    def: existing?.defaults?.use_dates ?? true,
    hint: 'Inicio al reclamar, fin al cerrar. Sirve para medir cuánto tardó algo desde que se pidió.',
  });

  if (answers.useDates) {
    answers.endDateField = await prompt.choice(
      '¿Dónde se escribe la fecha de fin?',
      [
        {
          value: 'description',
          label: 'En la descripción (recomendado)',
          hint: 'Línea "**Finalizado:** YYYY-MM-DD". No toca due_date. ClickUp ya estampa date_closed solo.',
        },
        {
          value: 'due_date',
          label: 'En due_date',
          hint: '⚠ Solo si tu equipo YA usa due_date así. Si lo usa como fecha límite, esto borra vencimientos ajenos.',
        },
        {
          value: 'custom_field',
          label: 'En un custom field "Fecha de fin"',
          hint: 'Hay que crearlo a mano en la UI de ClickUp: el conector MCP no puede crear campos.',
        },
      ],
      {
        def: ['description', 'due_date', 'custom_field'].indexOf(
          existing?.defaults?.end_date_field ?? 'description',
        ),
      },
    );
  } else {
    answers.endDateField = existing?.defaults?.end_date_field ?? 'description';
  }

  answers.usePriorities = await prompt.confirm('¿Trabajar con prioridades?', {
    def: existing?.defaults?.use_priorities ?? true,
    hint: 'Se elige por impacto si sale mal, no por urgencia sentida. Ante la duda, normal.',
  });

  answers.autoAssign = await prompt.confirm('¿Autoasignar las tareas a tu usuario de ClickUp?', {
    def: existing?.defaults?.auto_assign ?? true,
    hint: 'Quien crea o reclama queda asignado. Nunca se saca a nadie que ya estuviera.',
  });

  heading('3. El candado');
  box(
    'Qué hace, dicho sin adornos',
    [
      'Un hook que ejecuta el harness (no el modelo) cancela las escrituras si el proyecto está ' +
        'configurado y no hay ni tarea reclamada ni exención declarada.',
      '',
      'Es lo ÚNICO del protocolo que el modelo no puede saltearse: todo lo demás es una ' +
        'instrucción, y una instrucción se diluye cuando el contexto se comprime en una sesión ' +
        'larga.',
      '',
      'Solo actúa en proyectos que configures. En cualquier otra carpeta de la máquina no hace ' +
        'nada.',
    ],
    { color: c.yellow },
  );

  answers.blockWrites = await prompt.confirm('¿Activar el candado?', {
    def: existing?.defaults?.block_writes_without_task ?? true,
    hint: 'Siempre se puede declarar una exención con su motivo cuando el trabajo no amerita tarea.',
  });

  heading('4. La ventana de búsqueda');
  box(
    'Qué se está eligiendo acá',
    [
      'Antes de crear una tarea, el protocolo busca si ya existe. Lo que está ABIERTO ' +
        '(incluido lo que espera a otra persona) se busca siempre completo, sin límite de fecha: ' +
        'eso no se negocia.',
      '',
      'Lo que se acota es lo CERRADO, y el intercambio es real en las dos direcciones:',
      '',
      '· Ventana corta → cada búsqueda es barata, pero una tarea cerrada hace más tiempo no ' +
        'aparece y se puede rehacer trabajo viejo.',
      '· Ventana larga (o sin límite) → no se te escapa nada, pero cada reclamo pagina más ' +
        'tareas.',
      '',
      'Con un tablero chico, SIN LÍMITE es lo mejor: es barato y no se pierde nada. Con más de ' +
        'unos cientos de tareas cerradas, acotar empieza a valer la pena.',
    ],
    { color: c.blue },
  );

  const rawWindow = await prompt.text('Días hacia atrás para buscar tareas CERRADAS', {
    def: String(existing?.defaults?.search_window_days ?? 30),
    hint: 'Un número de días, o 0 para SIN LÍMITE (buscar todo el historial).',
  });
  answers.searchWindow = Number.parseInt(rawWindow, 10);
  if (!Number.isInteger(answers.searchWindow) || answers.searchWindow < 0) {
    answers.searchWindow = 30;
  }

  return answers;
}

// ---------------------------------------------------------------------------------------------
// identity resolution (optional, token path)
// ---------------------------------------------------------------------------------------------

/**
 * Try to turn the email/username into a confirmed numeric id during install.
 *
 * Only possible with a personal API token, because the MCP connector is OAuth and has no token on
 * disk. Without one we record the query as `pending_query` and the first Claude session resolves
 * it through MCP — which is why `identity.confirmed` starts false and the hooks keep saying so.
 */
async function tryResolveIdentity(prompt, answers, config) {
  if (!answers.clickupQuery) return null;

  heading('Resolver tu id de ClickUp ahora (opcional)');

  let token = process.env.CLICKUP_API_TOKEN?.trim() || '';
  if (token) {
    info('Encontré CLICKUP_API_TOKEN en el entorno.');
  } else {
    box(
      'Se puede resolver ahora, o en la primera sesión de Claude',
      [
        'El conector de ClickUp que usa Claude Code es OAuth y no deja un token en disco, así ' +
          'que este instalador no puede consultarlo por su cuenta.',
        '',
        'Dos caminos, los dos válidos:',
        '',
        `${SYM.arrow} Pegás un token personal (pk_…) y queda resuelto acá mismo.`,
        `${SYM.arrow} Lo dejás vacío y Claude lo resuelve en la primera sesión, mostrándote los ` +
          'candidatos para que confirmes.',
        '',
        'El token NO se guarda en ningún archivo: se usa para esta consulta y se descarta.',
      ],
      { color: c.blue },
    );
    token = (
      await prompt.text('Token personal de ClickUp (Enter para saltear)', { def: '' })
    ).trim();
  }

  if (!token) {
    warn('Sin resolver por ahora. Claude lo va a resolver en la primera sesión.');
    return null;
  }
  if (!looksLikeToken(token)) {
    warn('Eso no parece un token de ClickUp (empiezan con "pk_"). Lo salteo.');
    return null;
  }

  info('Consultando ClickUp…');
  const res = await listWorkspaces(token);
  if (!res.ok) {
    fail(`No se pudo consultar ClickUp: ${res.error}`);
    note('No es bloqueante: se resuelve en la primera sesión de Claude.');
    return null;
  }

  const workspaces = res.data;
  if (!workspaces.length) {
    warn('El token no ve ningún workspace.');
    return null;
  }

  let workspace = workspaces[0];
  if (workspaces.length > 1) {
    const chosen = await prompt.choice(
      '¿Cuál es tu workspace principal?',
      workspaces.map((w) => ({
        value: w.id,
        label: `${w.name} (${w.id})`,
        hint: `${w.members.length} miembros`,
      })),
      { def: 0 },
    );
    workspace = workspaces.find((w) => w.id === chosen) ?? workspaces[0];
  }
  config.defaults.workspace_id = workspace.id;
  ok(`Workspace: ${workspace.name} (${workspace.id})`);

  const { exact, fuzzy } = matchMember(workspace.members, answers.clickupQuery);

  if (exact.length === 1) {
    const m = exact[0];
    ok(`Coincidencia exacta: ${m.username ?? 's/n'} · ${m.email ?? 's/e'} · id ${m.id}`);
    return { ...m, via: 'api', confirmed: true };
  }

  const candidates = exact.length ? exact : fuzzy;
  if (!candidates.length) {
    warn(`No encontré a "${answers.clickupQuery}" entre los ${workspace.members.length} miembros.`);
    note('Se resuelve en la primera sesión de Claude, buscando con otros términos.');
    return null;
  }

  // More than one plausible match, or only a fuzzy one: the human decides. A ranked guess here
  // is precisely the silent mis-assignment this tool exists to prevent.
  say('');
  warn(
    exact.length
      ? 'Hay más de una coincidencia exacta.'
      : 'No hubo coincidencia exacta; estos se parecen.',
  );
  note('Un parecido de apellido no es evidencia. Elegí solo si estás seguro.');

  const chosen = await prompt.choice(
    '¿Cuál sos vos?',
    [
      ...candidates.slice(0, 8).map((m) => ({
        value: m.id,
        label: `${m.username ?? 's/nombre'} · ${m.email ?? 's/email'}`,
        hint: `id ${m.id}`,
      })),
      { value: '__none__', label: 'Ninguno / no estoy seguro', hint: 'Se resuelve en la primera sesión' },
    ],
    { def: 0 },
  );

  if (chosen === '__none__') {
    warn('Sin resolver. Claude lo va a resolver con tu confirmación.');
    return null;
  }
  const m = candidates.find((x) => x.id === chosen);
  return m ? { ...m, via: 'api', confirmed: true } : null;
}

// ---------------------------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------------------------

async function install(args) {
  banner();

  const problems = preflight();
  if (problems.length) {
    say('');
    fail(`No se puede instalar todavía: ${problems.join(', ')}.`);
    return 1;
  }

  const interactive = !args.yes && !args['non-interactive'];
  const prompt = new Prompt({ interactive });

  const { config: existing, existed, ok: configOk } = loadConfig();
  if (existed && !configOk) {
    warn('La config existente no se pudo leer; se va a partir de una nueva.');
    note(`Se conserva una copia en ${backupsDir()}.`);
    try {
      fs.mkdirSync(backupsDir(), { recursive: true });
      fs.copyFileSync(
        configPath(),
        path.join(backupsDir(), `config-roto-${Date.now()}.json`),
      );
    } catch {
      /* the backup is a courtesy; a failure here must not stop the install */
    }
  }

  const installed = inspectInstalled(readSettings().settings ?? {});
  if (installed.length && interactive) {
    say('');
    info(`clickup-flow ya está instalado (${installed.length} hook(s) registrados).`);
    const proceed = await prompt.confirm('¿Reinstalar / actualizar?', { def: true });
    if (!proceed) {
      say('');
      info('Sin cambios.');
      prompt.close();
      return 0;
    }
  }

  // Start from the existing config when it was readable: projects and team mappings are the
  // user's accumulated work and must survive a reinstall.
  const config = existed && configOk ? existing : defaultConfig();

  // Se leen ANTES de escribir nada: después de instalar ya no se puede saber qué había.
  const previousFiles = Array.isArray(config.installed_files) ? [...config.installed_files] : [];
  const previousVersion = config.installed_version ?? null;
  const version = toolVersion();

  let answers;
  try {
    answers = await interview(prompt, existed && configOk ? existing : null);
  } catch (err) {
    prompt.close();
    fail(`Instalación cancelada: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  config.defaults.use_dates = answers.useDates;
  config.defaults.use_priorities = answers.usePriorities;
  config.defaults.auto_assign = answers.autoAssign;
  config.defaults.end_date_field = answers.endDateField;
  config.defaults.block_writes_without_task = answers.blockWrites;
  config.defaults.search_window_days = answers.searchWindow;

  let resolved = null;
  if (interactive) {
    try {
      resolved = await tryResolveIdentity(prompt, answers, config);
    } catch (err) {
      warn(`No se pudo resolver la identidad ahora: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (resolved) {
    config.identity.clickup_user_id = String(resolved.id);
    config.identity.clickup_email = resolved.email ?? null;
    config.identity.clickup_username = resolved.username ?? null;
    config.identity.confirmed = true;
    config.identity.resolved_via = resolved.via;
    config.identity.resolved_at = new Date().toISOString();
    delete config.identity.pending_query;
  } else if (answers.clickupQuery) {
    // Keep the query so the first session knows what to search for, but leave `confirmed` false:
    // an unconfirmed identity must never be used to assign.
    config.identity.pending_query = answers.clickupQuery;
    if (!config.identity.clickup_user_id) config.identity.confirmed = false;
  }

  prompt.close();

  // ---- write everything ----
  heading('Instalando');

  fs.mkdirSync(toolHome(), { recursive: true });
  fs.mkdirSync(statePath(), { recursive: true });

  const engineDest = path.join(toolHome(), 'src');
  const engineSrc = path.join(REPO, 'src');
  // Running the installer from the INSTALLED copy would otherwise delete the script that is
  // currently executing. Same directory means the engine is already where it belongs.
  if (path.resolve(engineSrc) === path.resolve(engineDest)) {
    ok(`motor ya en su lugar → ${forwardSlash(engineDest)}`);
  } else {
    // Copiar primero: si algo falla, el motor viejo sigue entero y los hooks siguen andando.
    copyDirFiltered(engineSrc, engineDest);
    const huerfanos = pruneOrphanEngineFiles(engineSrc, engineDest);
    ok(`motor → ${forwardSlash(engineDest)}`);
    if (huerfanos.borrados.length) {
      note(`archivos de una versión anterior borrados: ${huerfanos.borrados.length}`);
    }
    if (huerfanos.retenidos.length) {
      warn(
        `no se pudieron borrar ${huerfanos.retenidos.length} archivo(s) viejo(s) del motor ` +
          '(¿antivirus, OneDrive, o un editor abierto ahí?). La instalación quedó completa; ' +
          'esos archivos sobrantes no se ejecutan.',
      );
    }
  }

  const cli = cliInvocation(config);
  const manifest = [];

  const skillDest = path.join(skillsDir(), SKILL_NAME);
  renderAsset(
    path.join(ASSETS, 'skills', SKILL_NAME, 'SKILL.md'),
    path.join(skillDest, 'SKILL.md'),
    cli,
  );
  manifest.push(relToClaude(path.join(skillDest, 'SKILL.md')));
  ok(`skill → ${forwardSlash(path.join(skillDest, 'SKILL.md'))}`);

  for (const file of COMMAND_FILES) {
    const dest = path.join(commandsDir(), file);
    // A same-named command the user wrote themselves is theirs. We back it up instead of
    // silently replacing it, and say so.
    if (fs.existsSync(dest)) {
      const current = fs.readFileSync(dest, 'utf8');
      if (!current.includes('clickup-flow') && !current.includes(cli)) {
        fs.mkdirSync(backupsDir(), { recursive: true });
        const bak = path.join(backupsDir(), `${file}.${Date.now()}.bak`);
        fs.copyFileSync(dest, bak);
        warn(`/${file.replace(/\.md$/, '')} ya existía y no era nuestro — copia en ${bak}`);
      }
    }
    renderAsset(path.join(ASSETS, 'commands', file), dest, cli);
    manifest.push(relToClaude(dest));
    ok(`comando → /${file.replace(/\.md$/, '')}`);
  }

  const stale = pruneStaleFiles(previousFiles, manifest);
  for (const rel of stale) warn(`quitado (esta versión ya no lo trae): ${rel}`);

  const bak = backupSettings();
  if (bak) note(`backup de settings.json → ${bak}`);

  const { settings, error: sErr } = readSettings();
  if (sErr) {
    fail(`settings.json dejó de ser legible: ${sErr}. No se registraron los hooks.`);
    return 1;
  }
  const target = settings ?? {};
  const addedHooks = installHooks(target, path.join(toolHome(), 'src', 'cli.mjs'));
  const addedPerms = mergePermissions(target);
  writeSettings(target);
  ok(`${addedHooks.length} hooks registrados en settings.json`);
  for (const h of addedHooks) note(`${h.event}${h.matcher ? ` [${h.matcher}]` : ''} — ${h.why}`);
  if (addedPerms.length) ok(`${addedPerms.length} permisos de lectura de ClickUp pre-aprobados`);

  const wrappers = writeWrappers(toolHome());
  ok(`comando corto → ${forwardSlash(wrappers.sh)}`);

  config.installed_files = manifest;
  config.installed_version = version;
  config.installed_at = config.installed_at ?? new Date().toISOString();
  config.updated_at = new Date().toISOString();
  saveConfig(config);
  ok(`config → ${forwardSlash(configPath())}`);

  // ---- summary ----
  heading('Listo');

  if (previousVersion && version && previousVersion !== version) {
    ok(`actualizado ${previousVersion} → ${version}`);
  } else if (previousVersion && version === previousVersion) {
    ok(`reinstalado ${version} (sin cambio de versión)`);
  } else if (version) {
    ok(`instalado ${version}`);
  }

  const lines = [
    `Identidad     ${
      config.identity.confirmed
        ? `${config.identity.clickup_user_id} (${config.identity.clickup_username ?? 's/n'}) ${SYM.ok}`
        : 'SIN RESOLVER — Claude la resuelve en la primera sesión'
    }`,
    `Fechas        ${config.defaults.use_dates ? `sí, fin en ${config.defaults.end_date_field}` : 'no'}`,
    `Prioridades   ${config.defaults.use_priorities ? 'sí' : 'no'}`,
    `Autoasignar   ${config.defaults.auto_assign ? 'sí' : 'no'}`,
    `Candado       ${config.defaults.block_writes_without_task ? 'activo' : 'desactivado'}`,
    `Búsqueda      ${
      config.defaults.search_window_days > 0
        ? `cerradas de los últimos ${config.defaults.search_window_days} días`
        : 'cerradas SIN LÍMITE de fecha (todo el historial)'
    }`,
    `Proyectos     ${Object.keys(config.projects ?? {}).length} registrados`,
  ];
  box('Configuración global', lines, { color: c.green });

  say('');
  say(c.bold('  Qué sigue'));
  say('');
  say(`  ${c.green('1.')} Abrí Claude Code en un proyecto (o reiniciá la sesión actual: los hooks`);
  say('     se leen al arrancar).');
  say(`  ${c.green('2.')} La primera sesión te va a avisar que ese proyecto no tiene espacio de`);
  say(`     ClickUp asignado. Corré ${c.cyan('/clickup-setup')} y elegí espacio, lista y modo`);
  say('     — o excluílo, que también queda registrado y no se vuelve a preguntar.');
  say(`  ${c.green('3.')} A partir de ahí, ${c.cyan('/tarea <descripción>')} hace todo el ciclo.`);
  say('');
  if (!config.identity.confirmed) {
    say(`  ${c.yellow(SYM.warn)} La identidad todavía no está resuelta, así que el protocolo NO va a`);
    say(`     asignar tareas hasta que lo esté. ${c.cyan('/clickup-config')} lo resuelve en un paso.`);
    say('');
  }
  say(`  ${c.bold('El comando corto')} (opcional, solo para vos: el agente usa la ruta completa)`);
  say('');
  say(`  ${c.gray('# bash / zsh — agregalo a tu ~/.bashrc o ~/.zshrc')}`);
  say(`  ${c.cyan(`alias clickup-flow='node "${forwardSlash(path.join(toolHome(), 'src', 'cli.mjs'))}"'`)}`);
  say('');
  say(`  ${c.gray('# PowerShell — agregalo a tu $PROFILE')}`);
  say(`  ${c.cyan(`Set-Alias clickup-flow "${forwardSlash(path.join(toolHome(), 'clickup-flow.cmd'))}"`)}`);
  say('');
  say(`  ${c.gray(`Diagnóstico:  ${cli} doctor`)}`);
  say(`  ${c.gray(`Desinstalar:  node "${forwardSlash(path.join(REPO, 'src', 'installer.mjs'))}" --uninstall`)}`);
  say('');

  return 0;
}

// ---------------------------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------------------------

async function uninstall(args) {
  banner();
  heading('Desinstalando');

  const interactive = !args.yes;
  const prompt = new Prompt({ interactive });

  const { settings, error } = readSettings();
  if (error) {
    fail(`settings.json no se puede leer (${error}). No se toca nada.`);
    prompt.close();
    return 1;
  }

  const bak = backupSettings();
  if (bak) note(`backup de settings.json → ${bak}`);

  const target = settings ?? {};
  const removedHooks = removeHooks(target);
  const removedPerms = unmergePermissions(target);
  writeSettings(target);
  ok(`${removedHooks} hook(s) y ${removedPerms} permiso(s) quitados de settings.json`);
  note('Todo lo demás en settings.json quedó intacto.');

  // El manifiesto es la fuente de verdad: sabe lo que puso ESTA instalación, incluidos archivos
  // de versiones anteriores con otros nombres. La lista hardcodeada queda como respaldo para una
  // config perdida o ilegible.
  const { config: cfgForUninstall, ok: cfgOk } = loadConfig();
  const recorded = cfgOk && Array.isArray(cfgForUninstall.installed_files)
    ? cfgForUninstall.installed_files
    : [];

  let removedAssets = 0;
  for (const rel of recorded) {
    const abs = path.join(claudeHome(), rel);
    if (fs.existsSync(abs)) {
      fs.rmSync(abs, { recursive: true, force: true });
      removedAssets++;
    }
  }
  if (removedAssets) ok(`${removedAssets} archivo(s) del manifiesto eliminados`);

  const skillDest = path.join(skillsDir(), SKILL_NAME);
  if (fs.existsSync(skillDest)) {
    fs.rmSync(skillDest, { recursive: true, force: true });
    ok(`skill ${SKILL_NAME} eliminada`);
  }
  for (const file of COMMAND_FILES) {
    const dest = path.join(commandsDir(), file);
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { force: true });
      ok(`comando /${file.replace(/\.md$/, '')} eliminado`);
    }
  }
  // La carpeta de la skill queda vacía si solo tenía nuestro SKILL.md.
  try {
    if (fs.existsSync(skillDest) && fs.readdirSync(skillDest).length === 0) fs.rmdirSync(skillDest);
  } catch {
    /* dejar una carpeta vacía es inocuo */
  }

  // The config is the user's accumulated work — every project binding and team mapping. Deleting
  // it by default would make "uninstall to reinstall" quietly destructive.
  say('');
  const dropConfig = await prompt.confirm(
    `¿Borrar también la configuración (${forwardSlash(configPath())})?`,
    {
      def: false,
      hint: 'Ahí viven tus proyectos registrados y los mapeos del equipo. Si vas a reinstalar, decí no.',
    },
  );
  prompt.close();

  if (dropConfig) {
    fs.rmSync(toolHome(), { recursive: true, force: true });
    ok('configuración y estado eliminados');
  } else {
    // Los wrappers apuntan a src/cli.mjs. Dejarlos después de borrar el motor deja un comando
    // roto en el PATH de quien se hizo el alias, que falla sin explicar por qué.
    for (const wrapper of ['clickup-flow', 'clickup-flow.cmd']) {
      const p = path.join(toolHome(), wrapper);
      if (fs.existsSync(p)) {
        fs.rmSync(p, { force: true });
        ok(`wrapper ${wrapper} eliminado`);
      }
    }

    const engineDest = path.join(toolHome(), 'src');
    if (path.resolve(path.join(REPO, 'src')) === path.resolve(engineDest)) {
      // Removing our own directory mid-run leaves a half-deleted install behind. Say so, and
      // give the one command that finishes the job from anywhere else.
      warn('El motor no se borró: estás corriendo el instalador DESDE la copia instalada.');
      note(`Para quitarlo: rm -rf "${forwardSlash(engineDest)}"`);
    } else {
      fs.rmSync(engineDest, { recursive: true, force: true });
      ok('motor eliminado; configuración conservada');
    }
    note(`Reinstalar recupera todo tal cual: ${forwardSlash(configPath())}`);
  }

  say('');
  ok('Desinstalado.');
  say('');
  return 0;
}

// ---------------------------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------------------------

const USAGE = `clickup-flow — instalador

Uso:
  node src/installer.mjs [opciones]

Instalar y ACTUALIZAR son el mismo comando: correlo de nuevo. Es idempotente — reemplaza
sus propias entradas en vez de acumularlas, conserva tu configuración (proyectos, identidad,
equipo) y borra los archivos que la versión nueva ya no trae.

  git pull && ./install.sh      # actualizar a la última versión

Opciones:
  --yes            No preguntar nada: usa los valores por defecto de cada pregunta
  --uninstall      Quita hooks, skill y comandos (pregunta antes de borrar la config)
  --status         Muestra qué versión hay instalada y sale
  --help           Esto

Variables de entorno:
  CLICKUP_API_TOKEN   Token personal (pk_…) para resolver tu id durante la instalación.
                      No se guarda en ningún archivo.
  CLAUDE_CONFIG_DIR   Si movés la carpeta de configuración de Claude Code.
`;

function status() {
  banner();
  heading('Estado');
  const { settings, error } = readSettings();
  if (error) {
    fail(`settings.json ilegible: ${error}`);
    return 1;
  }
  const installed = inspectInstalled(settings ?? {});
  if (!installed.length) {
    info('clickup-flow no está instalado.');
  } else {
    ok(`${installed.length}/3 hooks registrados`);
    for (const h of installed) note(`${h.event}${h.matcher ? ` [${h.matcher}]` : ''}`);
  }

  const { config, existed, ok: cOk, error: cErr } = loadConfig();
  if (!existed) info(`sin config en ${forwardSlash(configPath())}`);
  else if (!cOk) fail(`config ilegible: ${cErr}`);
  else {
    const projects = Object.entries(config.projects ?? {});
    ok(
      `config ok · identidad ${config.identity.confirmed ? config.identity.clickup_user_id : 'SIN RESOLVER'} · ` +
        `${projects.length} proyecto(s), ${projects.filter(([, p]) => p.mode === MODES.EXCLUDED).length} excluido(s)`,
    );
  }
  say('');
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    say(USAGE);
    return 0;
  }
  if (args.status) return status();
  if (args.uninstall) return uninstall(args);
  return install(args);
}

main()
  .then((code) => process.exit(typeof code === 'number' ? code : 0))
  .catch((err) => {
    // El resto de la herramienta no le muestra stacks al usuario; el instalador tampoco debería.
    // Y un error va a stderr: quien redirige stdout a un log espera ahí el progreso, no la falla.
    const msg = err instanceof Error ? err.message : String(err);
    const codigo = err && typeof err === 'object' && 'code' in err ? String(err.code) : null;
    process.stderr.write(`\n  La instalación no se completó: ${msg}\n`);
    if (codigo === 'EACCES' || codigo === 'EPERM') {
      process.stderr.write(
        '  Parece un problema de permisos sobre el directorio de Claude Code.\n' +
          '  Cerrá lo que esté usando esa carpeta y volvé a intentar.\n',
      );
    } else if (codigo === 'EBUSY' || codigo === 'ENOTEMPTY') {
      process.stderr.write(
        '  Un archivo está en uso (antivirus, OneDrive, o un editor abierto ahí).\n' +
          '  Cerralo y volvé a correr el instalador: es idempotente.\n',
      );
    } else if (codigo === 'ENOSPC') {
      process.stderr.write('  No queda espacio en disco.\n');
    }
    if (process.env.CLICKUP_FLOW_DEBUG && err instanceof Error && err.stack) {
      process.stderr.write(`\n${err.stack}\n`);
    } else {
      process.stderr.write('  Detalle técnico: CLICKUP_FLOW_DEBUG=1 y volvé a correrlo.\n');
    }
    process.stderr.write('\n');
    process.exit(1);
  });

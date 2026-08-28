#!/usr/bin/env node
//
// End-to-end tests for clickup-flow.
//
// Everything runs against a throwaway CLAUDE_CONFIG_DIR, so the suite can exercise the real
// installer — including the settings.json merge — without touching the machine's actual Claude
// Code configuration. That is the whole reason `CLAUDE_CONFIG_DIR` is respected in paths.mjs.
//
// The tests that matter most are the destructive-merge ones: this tool edits a file the user
// owns, and "we did not delete anything" is the property that has to be proven, not assumed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// La MISMA función que usa el producto para armar la clave de un proyecto.
//
// Reimplementarla a mano en el test fue un error real, y lo encontró Windows: allá la clave lleva
// la letra de unidad en minúscula (`c:/Users/...`), y un `replace(/\\/g, '/')` la deja en
// mayúscula, así que la búsqueda en el registro de proyectos fallaba. Un test que reimplementa la
// lógica del producto prueba su propia copia, no el producto.
import { canonicalProjectKey } from '../src/lib/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const INSTALLER = path.join(REPO, 'src', 'installer.mjs');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    process.stdout.write(`  FAIL ${name}\n         ${err.message}\n`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'not equal'}: esperado ${JSON.stringify(expected)}, hubo ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// sandbox
// ---------------------------------------------------------------------------------------------

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'clickup-flow-test-'));
const fakeClaude = path.join(sandbox, '.claude');
const projectA = path.join(sandbox, 'proyecto-tasks');
const projectB = path.join(sandbox, 'proyecto-umbrella');
const projectC = path.join(sandbox, 'proyecto-excluido');
const projectD = path.join(sandbox, 'proyecto-sin-configurar');
// Otro proyecto virgen, para probar que una LECTURA nunca dispara la pregunta de alta: projectD
// ya quedó pospuesto tras su primera escritura, así que ahí el silencio no probaría nada.
const projectE = path.join(sandbox, 'proyecto-solo-lectura');
const projRol = path.join(sandbox, 'proyecto-rol');
const projRol2 = path.join(sandbox, 'proyecto-rol-2');

for (const dir of [fakeClaude, projectA, projectB, projectC, projectD, projectE, projRol, projRol2]) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.mkdirSync(path.join(projectA, 'src', 'deep'), { recursive: true });

/** A settings.json that looks like a real, used one — the thing we must not damage. */
const PRE_EXISTING_SETTINGS = {
  model: 'opus[1m]',
  outputStyle: 'Gentleman',
  theme: 'dark-ansi',
  hooks: {
    PreToolUse: [],
    UserPromptSubmit: [
      { hooks: [{ type: 'command', command: 'codegraph prompt-hook' }] },
      { matcher: '', hooks: [{ type: 'command', command: 'gentle-ai skill-registry refresh || true' }] },
    ],
    SessionStart: [{ hooks: [{ type: 'command', command: 'echo hook-del-usuario' }] }],
  },
  permissions: {
    defaultMode: 'bypassPermissions',
    allow: ['mcp__codegraph__*', 'mcp__plugin_engram_engram__mem_save'],
    deny: ['Bash(rm -rf /)', 'Read(.env)'],
  },
  enabledPlugins: { 'engram@engram': true },
};

fs.writeFileSync(
  path.join(fakeClaude, 'settings.json'),
  JSON.stringify(PRE_EXISTING_SETTINGS, null, 2),
);

const env = { ...process.env, CLAUDE_CONFIG_DIR: fakeClaude, NO_COLOR: '1' };

function run(args, opts = {}) {
  return execFileSync('node', args, {
    encoding: 'utf8',
    env: { ...env, ...(opts.env || {}) },
    cwd: opts.cwd || REPO,
    stdio: ['pipe', 'pipe', 'pipe'],
    input: opts.input ?? '',
  });
}

const CLI = path.join(fakeClaude, 'clickup-flow', 'src', 'cli.mjs');

function cli(args, opts = {}) {
  return run([CLI, ...args], opts);
}

/**
 * Corre un hook como lo hace el harness: JSON por stdin. Devuelve `{ code, stdout, stderr }`.
 *
 * Usa `spawnSync` y NO `execFileSync` por un motivo concreto: `execFileSync` solo devuelve stdout
 * cuando el comando tiene éxito, así que la versión anterior de este helper devolvía
 * `stderr: ''` fijo en el camino feliz. Toda aserción sobre stderr de una llamada exitosa estaba
 * comparando contra un string vacío — vacua. Lo descubrió un test de mutación: rompí el guard a
 * propósito, el hook avisó por stderr, y el test no se enteró.
 */
function hook(subcommand, payload, opts = {}) {
  const r = spawnSync('node', [CLI, subcommand], {
    encoding: 'utf8',
    env: { ...env, ...(opts.env || {}) },
    input: JSON.stringify(payload),
  });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/** Our hooks only, matched the same way the installer matches them. */
function ourHooks() {
  const s = readSettings();
  const found = [];
  for (const [event, groups] of Object.entries(s.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const h of group.hooks ?? []) {
        if (String(h.command).includes('clickup-flow/src/cli.mjs')) {
          found.push({ event, matcher: group.matcher ?? null, command: h.command });
        }
      }
    }
  }
  return found;
}

function readSettings() {
  return JSON.parse(fs.readFileSync(path.join(fakeClaude, 'settings.json'), 'utf8'));
}

function readConfig() {
  return JSON.parse(fs.readFileSync(path.join(fakeClaude, 'clickup-flow', 'config.json'), 'utf8'));
}

// =============================================================================================
process.stdout.write(`\nsandbox: ${sandbox}\n\n`);

process.stdout.write('INSTALACIÓN\n');

const installOut = run([INSTALLER, '--yes']);

check('el instalador termina bien', () => {
  assert(installOut.includes('Listo'), 'no llegó al resumen final');
});

check('copia el motor', () => {
  assert(fs.existsSync(CLI), `no existe ${CLI}`);
});

check('instala la skill con {{CLI}} sustituido', () => {
  const p = path.join(fakeClaude, 'skills', 'clickup-task-flow', 'SKILL.md');
  assert(fs.existsSync(p), 'falta SKILL.md');
  const body = fs.readFileSync(p, 'utf8');
  assert(!body.includes('{{CLI}}'), 'quedó un {{CLI}} sin sustituir');
  assert(body.includes('cli.mjs'), 'no quedó la invocación real del CLI');
});

check('instala los tres comandos', () => {
  for (const f of ['tarea.md', 'clickup-setup.md', 'clickup-config.md']) {
    const p = path.join(fakeClaude, 'commands', f);
    assert(fs.existsSync(p), `falta ${f}`);
    assert(!fs.readFileSync(p, 'utf8').includes('{{CLI}}'), `${f} tiene {{CLI}} sin sustituir`);
  }
});

check('escribe los wrappers de conveniencia y funcionan', () => {
  const sh = path.join(fakeClaude, 'clickup-flow', 'clickup-flow');
  const cmd = path.join(fakeClaude, 'clickup-flow', 'clickup-flow.cmd');
  assert(fs.existsSync(sh), 'falta el wrapper sh');
  assert(fs.existsSync(cmd), 'falta el wrapper .cmd');

  // Se ejecuta el que corresponde a la plataforma: en Windows no existe `sh`, y el `.cmd` no
  // sirve en Linux. Los dos archivos se escriben siempre, porque el mismo repo se instala en las
  // dos y quien clona en WSL puede querer el .cmd para su Claude Code de Windows.
  const out =
    process.platform === 'win32'
      ? execFileSync(process.env.COMSPEC || 'cmd.exe', ['/c', cmd, 'status'], {
          encoding: 'utf8',
          env,
          cwd: projectD,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      : execFileSync('sh', [sh, 'status'], {
          encoding: 'utf8',
          env,
          cwd: projectD,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
  assert(out.includes('config'), `el wrapper no ejecutó el CLI:\n${out}`);
});

check('no toca el PATH ni los archivos de shell del usuario', () => {
  // El instalador imprime cómo hacerse un alias, pero no escribe en ~/.bashrc, ~/.zshrc ni
  // $PROFILE: esos archivos son del usuario. Si algún día alguien agrega esa "comodidad",
  // este test lo frena.
  assert(
    installOut.includes('alias clickup-flow'),
    'no le dice al usuario cómo crearse el alias',
  );
  const installer = fs.readFileSync(INSTALLER, 'utf8');

  // Nunca se agrega contenido a un archivo ajeno: settings.json se reescribe entero después de
  // mergear, y nada más se toca.
  assert(!installer.includes('appendFileSync'), 'el instalador usa appendFileSync');

  // Los archivos de shell pueden MENCIONARSE (el instalador imprime cómo hacerse el alias),
  // pero solo dentro de una línea que imprime texto — nunca como destino de una escritura.
  const rcLines = installer
    .split('\n')
    .filter((l) => /\.bashrc|\.zshrc|\$PROFILE/.test(l));
  assert(rcLines.length > 0, 'el instalador ya no explica cómo crearse el alias');
  for (const line of rcLines) {
    assert(
      /say\(|c\.(gray|cyan|bold)/.test(line),
      `una línea toca un archivo de shell fuera de un mensaje: ${line.trim()}`,
    );
    assert(
      !/writeFileSync|createWriteStream|openSync/.test(line),
      `una línea escribe en un archivo de shell: ${line.trim()}`,
    );
  }
});

process.stdout.write('\nMERGE NO DESTRUCTIVO DE settings.json\n');

check('conserva las claves de nivel superior del usuario', () => {
  const s = readSettings();
  assertEqual(s.model, 'opus[1m]', 'model');
  assertEqual(s.outputStyle, 'Gentleman', 'outputStyle');
  assertEqual(s.theme, 'dark-ansi', 'theme');
  assertEqual(s.enabledPlugins['engram@engram'], true, 'enabledPlugins');
});

check('conserva los hooks preexistentes del usuario', () => {
  const s = readSettings();
  const commands = JSON.stringify(s.hooks);
  assert(commands.includes('codegraph prompt-hook'), 'se perdió el hook de codegraph');
  assert(commands.includes('gentle-ai skill-registry refresh'), 'se perdió el hook de gentle-ai');
  assert(commands.includes('echo hook-del-usuario'), 'se perdió el SessionStart del usuario');
});

check('registra sus cuatro hooks propios', () => {
  const s = readSettings();
  assertEqual(ourHooks().length, 4, 'no quedaron exactamente 4 hooks nuestros');
  const flat = JSON.stringify(s.hooks);
  assert(flat.includes('session-start'), 'falta session-start');
  assert(flat.includes('guard'), 'falta guard');
  assert(flat.includes('sync-hook'), 'falta sync-hook (la evidencia del PostToolUse)');
  assert(flat.includes('stop-hook'), 'falta stop-hook (la obligación de cerrar)');
  assert(!flat.includes('cli.mjs" prompt-hook'), 'el hook por prompt no debería instalarse más');

  // Bash en el matcher no es un detalle: sin él el candado es decorativo, porque el modo
  // bypassPermissions le RECOMIENDA al agente escribir con sed, heredocs y scripts cortos.
  const pre = s.hooks.PreToolUse.find(
    (g) => g.matcher === 'Edit|Write|MultiEdit|NotebookEdit|Bash',
  );
  assert(pre, 'el guard no quedó con Bash en el matcher');

  const post = (s.hooks.PostToolUse ?? []).find((g) => /clickup_create_task/.test(g.matcher ?? ''));
  assert(post, 'el sync-hook no quedó atado a las herramientas de escritura del MCP');
});

check('conserva permisos allow y deny del usuario', () => {
  const s = readSettings();
  assert(s.permissions.allow.includes('mcp__codegraph__*'), 'se perdió un allow');
  assert(
    s.permissions.allow.includes('mcp__plugin_engram_engram__mem_save'),
    'se perdió un allow de engram',
  );
  assert(s.permissions.deny.includes('Bash(rm -rf /)'), 'se perdió un deny');
  assert(s.permissions.deny.includes('Read(.env)'), 'se perdió un deny');
  assertEqual(s.permissions.defaultMode, 'bypassPermissions', 'defaultMode');
});

check('agrega permisos de lectura de ClickUp', () => {
  const s = readSettings();
  assert(
    s.permissions.allow.includes('mcp__claude_ai_ClickUp__clickup_filter_tasks'),
    'no agregó los permisos de ClickUp',
  );
});

check('reinstalar es idempotente: no duplica hooks', () => {
  run([INSTALLER, '--yes']);
  const mine = ourHooks();
  assertEqual(mine.length, 4, `quedaron ${mine.length} hooks nuestros en vez de 4`);
  const events = mine.map((h) => h.event).sort().join(',');
  assertEqual(events, 'PostToolUse,PreToolUse,SessionStart,Stop', 'eventos registrados');
  // and the user's own hooks survive a second pass
  const flat = JSON.stringify(readSettings().hooks);
  assert(flat.includes('codegraph prompt-hook'), 'la reinstalación perdió el hook del usuario');
  assert(flat.includes('gentle-ai skill-registry'), 'la reinstalación perdió otro hook del usuario');
});

process.stdout.write('\nEL CANDADO EN UN PROYECTO SIN CONFIGURAR: PREGUNTA UNA VEZ\n');

const escribirEn = (dir, archivo = 'app.js') =>
  hook('guard', {
    cwd: dir,
    tool_name: 'Write',
    tool_input: { file_path: path.join(dir, archivo) },
  });

check('la PRIMERA escritura en un proyecto desconocido pregunta y bloquea', () => {
  // Este es el comportamiento que la herramienta NO tenía, y su ausencia era el motivo por el que
  // nunca se activó en el segundo proyecto: `pending` y `excluded` se comportaban idéntico, así
  // que el default era el silencio permanente y la única salida era que un humano tipeara
  // `/clickup-setup`. Ahora pregunta un hook, que no se olvida.
  const r = escribirEn(projectD);
  assertEqual(r.code, 2, `no preguntó por un proyecto desconocido: ${r.stdout}`);
  assert(/clickup-setup/.test(r.stderr), 'no ofrece configurarlo');
  assert(/exclude/.test(r.stderr), 'no ofrece excluirlo');
  assert(/snooze/.test(r.stderr), 'no ofrece posponerlo');

  // El exit 2 no alcanza como prueba: un crash interno sale con 0 por el catch-all, pero un
  // mensaje de fallo interno acompañando un bloqueo también sería un bug distinto.
  assert(
    !r.stderr.includes('falló internamente'),
    `el guard reventó en vez de preguntar: ${r.stderr}`,
  );
});

check('la SEGUNDA escritura ya no bloquea: pregunta y pospone en el mismo acto', () => {
  // La propiedad que hace tolerable un candado que corre en cada repo de la máquina. Si
  // insistiera, se desinstalaría.
  const r = escribirEn(projectD, 'otro.js');
  assertEqual(r.code, 0, `siguió bloqueando después de preguntar: ${r.stderr}`);
  assert(
    !r.stderr.includes('falló internamente'),
    `el guard reventó y el catch-all lo disfrazó de permiso: ${r.stderr}`,
  );
});

check('un `ls` en un proyecto desconocido nunca pregunta nada', () => {
  // Solo una ESCRITURA real dispara la pregunta. Interrumpir una lectura con una consulta sobre
  // ClickUp es exactamente cómo se gana el derecho a que te desinstalen.
  const r = hook('guard', {
    cwd: projectE,
    tool_name: 'Bash',
    tool_input: { command: 'ls -la && git status' },
  });
  assertEqual(r.code, 0, 'preguntó por una lectura');
  assertEqual(r.stderr.trim(), '', 'dijo algo ante una lectura');
});

check('prompt-hook queda callado en un proyecto sin configurar', () => {
  const r = hook('prompt-hook', { cwd: projectD });
  assertEqual(r.stdout.trim(), '', 'habló en un proyecto que no es suyo');
});

check('session-start ofrece configurar, sin imponer nada', () => {
  const r = hook('session-start', { cwd: projectD });
  assert(r.stdout.includes('/clickup-setup'), 'no menciona cómo configurar');
  assert(/no aplica/i.test(r.stdout), 'no aclara que el protocolo no aplica todavía');
});

check('guard no bloquea aunque el config esté corrupto', () => {
  const cfgPath = path.join(fakeClaude, 'clickup-flow', 'config.json');
  const good = fs.readFileSync(cfgPath, 'utf8');
  fs.writeFileSync(cfgPath, '{ esto no es json');
  try {
    const r = hook('guard', {
      cwd: projectA,
      tool_name: 'Write',
      tool_input: { file_path: path.join(projectA, 'x.js') },
    });
    assertEqual(r.code, 0, 'bloqueó con la config ilegible — debe fallar abierto');
  } finally {
    fs.writeFileSync(cfgPath, good);
  }
});

process.stdout.write('\nCONFIGURACIÓN DE PROYECTO\n');

check('project set (modo tasks)', () => {
  cli(
    [
      'project', 'set',
      '--mode', 'tasks',
      '--name', 'Proyecto Tasks',
      '--workspace-id', '1000000001',
      '--space-id', '2000000001', '--space-name', 'Acme',
      '--list-id', '4000000001', '--list-name', 'List',
      '--cwd', projectA,
    ],
    { cwd: projectA },
  );
  const cfg = readConfig();
  const entry = Object.values(cfg.projects).find((p) => p.name === 'Proyecto Tasks');
  assert(entry, 'no se guardó la entrada');
  assertEqual(entry.mode, 'tasks', 'modo');
  assertEqual(entry.list_id, '4000000001', 'list_id');
});

check('project set rechaza umbrella sin tarea paraguas', () => {
  let threw = false;
  try {
    cli(
      ['project', 'set', '--mode', 'umbrella', '--list-id', '123', '--cwd', projectB],
      { cwd: projectB },
    );
  } catch (err) {
    threw = true;
    assert(
      (err.stderr?.toString() ?? '').includes('umbrella-task-id'),
      'no explicó que falta el id del paraguas',
    );
  }
  assert(threw, 'aceptó un umbrella sin paraguas');
});

check('project set (modo umbrella) con paraguas', () => {
  cli(
    [
      'project', 'set',
      '--mode', 'umbrella',
      '--name', 'Proyecto Umbrella',
      '--space-id', '2000000001', '--space-name', 'Acme',
      '--list-id', '4000000002', '--list-name', 'Gateway',
      '--umbrella-task-id', '86abc0001',
      '--role', 'backend',
      '--naming', 'prefixed',
      '--cwd', projectB,
    ],
    { cwd: projectB },
  );
  const entry = Object.values(readConfig().projects).find((p) => p.name === 'Proyecto Umbrella');
  assertEqual(entry.mode, 'umbrella', 'modo');
  assertEqual(entry.umbrella_task_id, '86abc0001', 'paraguas');
  assertEqual(entry.role, 'backend', 'rol');
  assertEqual(entry.handoff, true, 'handoff derivado');
  assertEqual(entry.naming, 'prefixed', 'naming');
});

check('project set valida el rol y guarda la contraparte', () => {
  // Rol inválido: falla explicando las tres opciones.
  let threw = false;
  try {
    cli(['project', 'set', '--mode', 'tasks', '--list-id', '1', '--role', 'inventado', '--cwd', projRol], {
      cwd: projRol,
    });
  } catch (err) {
    threw = true;
    const msg = err.stderr?.toString() ?? '';
    assert(msg.includes('backend'), 'no lista los roles válidos');
    assert(msg.includes('fullstack'), 'no menciona fullstack');
  }
  assert(threw, 'aceptó un rol inválido');

  // Un fullstack no puede tener contraparte: hace las dos puntas.
  let threw2 = false;
  try {
    cli(
      ['project', 'set', '--mode', 'tasks', '--list-id', '1', '--role', 'fullstack',
       '--counterpart', projRol2, '--cwd', projRol],
      { cwd: projRol },
    );
  } catch (err) {
    threw2 = true;
    assert((err.stderr?.toString() ?? '').includes('no tiene contraparte'), 'no explica por qué');
  }
  assert(threw2, 'aceptó contraparte en un fullstack');

  // Y no puede ser sí misma.
  let threw3 = false;
  try {
    cli(
      ['project', 'set', '--mode', 'tasks', '--list-id', '1', '--role', 'backend',
       '--counterpart', projRol, '--cwd', projRol],
      { cwd: projRol },
    );
  } catch {
    threw3 = true;
  }
  assert(threw3, 'aceptó ser su propia contraparte');
});

check('el rol y la contraparte se guardan y se ven en status', () => {
  // Los DOS lados, consistentes: roles complementarios y la MISMA lista.
  //
  // Una contraparte solo *declarada* no alcanza. Si el otro proyecto no está registrado, es
  // fullstack, está excluido, tiene el mismo rol o mira otra lista, no puede RECIBIR — y el
  // protocolo degrada a propósito para no parkear tareas que nadie va a levantar.
  cli(
    ['project', 'set', '--mode', 'tasks', '--list-id', '4000000009', '--role', 'frontend',
     '--counterpart', projRol2, '--cwd', projRol],
    { cwd: projRol },
  );
  cli(
    ['project', 'set', '--mode', 'tasks', '--list-id', '4000000009', '--role', 'backend',
     '--counterpart', projRol, '--cwd', projRol2],
    { cwd: projRol2 },
  );
  const entry = readConfig().projects[canonicalProjectKey(projRol2)];
  assert(entry.role === 'backend', `rol guardado: ${entry.role}`);
  assert(entry.counterpart === canonicalProjectKey(projRol), 'no guardó la contraparte');
  assert(entry.handoff === true, 'handoff derivado del rol quedó mal');

  const st = cli(['status', '--cwd', projRol2], { cwd: projRol2 });
  assert(st.includes('rol             backend'), `status no muestra el rol:\n${st}`);
  assert(st.includes('contraparte'), 'status no muestra la contraparte');
  assert(st.includes('puede parkear'), 'status no dice qué puede hacer al entregar');
});

check('un backend sin contraparte: status dice que cierra la cadena', () => {
  // `none` limpia la contraparte que puso el test anterior: omitir el flag la conservaría.
  cli(
    ['project', 'set', '--mode', 'tasks', '--list-id', '4000000009', '--role', 'backend',
     '--counterpart', 'none', '--cwd', projRol2],
    { cwd: projRol2 },
  );
  const st = cli(['status', '--cwd', projRol2], { cwd: projRol2 });
  assert(st.includes('sin contraparte'), 'no informa que falta la contraparte');
  assert(st.includes('cierra la cadena'), 'no dice que cierra en vez de parkear');
});

check('avisa cuando la contraparte no está registrada, pero la guarda', () => {
  const out = cli(
    ['project', 'set', '--mode', 'tasks', '--list-id', '1', '--role', 'frontend',
     '--counterpart', '/no/registrado/todavia', '--cwd', projRol],
    { cwd: projRol },
  );
  assert(out.includes('no está registrada'), 'no avisa que la contraparte falta');
  const entry = readConfig().projects[canonicalProjectKey(projRol)];
  assert(entry.counterpart === '/no/registrado/todavia', 'no la guardó igual');
});

check('project exclude se registra con motivo', () => {
  cli(['project', 'exclude', '--reason', 'es un sandbox personal', '--cwd', projectC], {
    cwd: projectC,
  });
  const entry = readConfig().projects[canonicalProjectKey(projectC)];
  assert(entry, 'no se registró la exclusión');
  assertEqual(entry.mode, 'excluded', 'modo');
  assert(entry.excluded_reason.includes('sandbox'), 'no guardó el motivo');
});

check('un proyecto excluido no genera ruido en ningún hook', () => {
  const s = hook('session-start', { cwd: projectC });
  assertEqual(s.stdout.trim(), '', 'session-start habló en un proyecto excluido');
  const p = hook('prompt-hook', { cwd: projectC });
  assertEqual(p.stdout.trim(), '', 'prompt-hook habló en un proyecto excluido');
  const g = hook('guard', {
    cwd: projectC,
    tool_name: 'Write',
    tool_input: { file_path: path.join(projectC, 'a.js') },
  });
  assertEqual(g.code, 0, 'el guard bloqueó un proyecto excluido');
});

check('un subdirectorio resuelve al proyecto padre', () => {
  const deep = path.join(projectA, 'src', 'deep');
  const out = cli(['status', '--cwd', deep], { cwd: deep });
  assert(out.includes('ancestor'), 'no resolvió por ancestro');
  assert(out.includes('4000000001'), 'no trajo la lista del padre');
});

process.stdout.write('\nEL CANDADO: FAIL CLOSED CUANDO SÍ ESTÁ CONFIGURADO\n');

check('guard bloquea sin tarea ni exención', () => {
  const r = hook('guard', {
    cwd: projectA,
    tool_name: 'Write',
    tool_input: { file_path: path.join(projectA, 'app.js') },
  });
  assertEqual(r.code, 2, 'no bloqueó');
  assert(r.stderr.includes('BLOQUEADO'), 'no explicó el bloqueo');
  assert(r.stderr.includes('4000000001'), 'no dio la lista donde buscar');
  assert(r.stderr.includes('exempt'), 'no ofreció la salida por exención');
});

check('guard NO bloquea editar CLAUDE.md ni .claude/', () => {
  for (const f of [path.join(projectA, 'CLAUDE.md'), path.join(projectA, '.claude', 'settings.json')]) {
    const r = hook('guard', { cwd: projectA, tool_name: 'Edit', tool_input: { file_path: f } });
    assertEqual(r.code, 0, `bloqueó ${f}, que es configuración y no trabajo compartido`);
  }
});

check('claim desbloquea la escritura', () => {
  cli(['claim', '--task-id', '86abc123', '--title', 'Arreglar el ruteo', '--cwd', projectA], {
    cwd: projectA,
  });
  const r = hook('guard', {
    cwd: projectA,
    tool_name: 'Write',
    tool_input: { file_path: path.join(projectA, 'app.js') },
  });
  assertEqual(r.code, 0, `siguió bloqueando con tarea reclamada: ${r.stderr}`);
});

check('session-start recuerda la tarea en curso', () => {
  // Antes lo hacía el hook por prompt, en CADA turno de CADA proyecto de la máquina. Se fue por
  // costo (0,14 s y ~70 palabras de contexto por turno) y su trabajo quedó acá, que corre una vez
  // por sesión — y también al compactar, que era su única justificación real.
  const r = hook('session-start', { cwd: projectA });
  assert(r.stdout.includes('86abc123'), 'no menciona el id de la tarea');
  assert(r.stdout.includes('TAREA EN CURSO'), 'no avisa que hay tarea en curso');
});

check('el hook por prompt quedó obsoleto pero no rompe un settings.json viejo', () => {
  // Una instalación anterior puede seguir invocándolo. Un comando inexistente sería un error en
  // cada turno hasta que el usuario reinstale.
  const r = hook('prompt-hook', { cwd: projectA });
  assertEqual(r.code, 0, 'prompt-hook debería salir con 0');
  assertEqual(r.stdout.trim(), '', 'prompt-hook ya no debería decir nada');
});

check('un segundo claim distinto se RECHAZA, no pisa al primero', () => {
  // Dos sesiones de Claude en el mismo repo (terminal + IDE) se pisaban el claim en silencio.
  let threw = false;
  try {
    cli(['claim', '--task-id', 'OTRA-TAREA', '--title', 'sesión B', '--cwd', projectA], {
      cwd: projectA,
    });
  } catch (err) {
    threw = true;
    const msg = err.stderr?.toString() ?? '';
    assert(msg.includes('86abc123'), 'no dice cuál tarea está reclamada');
    assert(msg.includes('OTRA sesión'), 'no menciona la posibilidad de otra sesión');
    assert(msg.includes('--force'), 'no ofrece la salida explícita');
  }
  assert(threw, 'aceptó un segundo claim y pisó el primero');
  // Y el original sigue en pie.
  const st = cli(['status', '--cwd', projectA], { cwd: projectA });
  assert(st.includes('86abc123'), 'perdió el claim original');
});

check('--force reemplaza el claim, avisando de lo que queda huérfano', () => {
  const out = cli(['claim', '--task-id', 'FORZADA', '--title', 'x', '--force', '--cwd', projectA], {
    cwd: projectA,
  });
  assert(out.includes('Reemplazado por --force'), 'no avisa del reemplazo');
  assert(out.includes('sin nadie encima'), 'no advierte que la anterior quedó abierta');
  // Volver al estado que esperan los tests siguientes. `--force` porque el harness nunca vio
  // una mutación MCP sobre estas tareas de prueba, y sin él `release` ahora se niega.
  cli(['release', '--force', '--cwd', projectA], { cwd: projectA });
  cli(['claim', '--task-id', '86abc123', '--title', 'Arreglar el ruteo', '--cwd', projectA], {
    cwd: projectA,
  });
});

check('release con el id equivocado NO borra el claim de otra sesión', () => {
  let threw = false;
  try {
    cli(['release', '--task-id', 'NO-ES-ESTA', '--cwd', projectA], { cwd: projectA });
  } catch (err) {
    threw = true;
    const msg = err.stderr?.toString() ?? '';
    assert(msg.includes('NO es la tarea'), 'no explica el desajuste');
    assert(msg.includes('86abc123'), 'no dice cuál es el claim vigente');
  }
  assert(threw, 'soltó un claim que no era el suyo');
  const st = cli(['status', '--cwd', projectA], { cwd: projectA });
  assert(st.includes('86abc123'), 'borró el claim de la otra sesión');
});

check('sin plomería probada, release NO se niega: falla abierto', () => {
  // La válvula de seguridad. La verificación depende de que el matcher del `PostToolUse` case el
  // nombre de las herramientas del conector; si no casa, exigir evidencia trabaría cada proyecto
  // acusando al usuario de algo que hizo bien. Mientras el hook no haya corrido NUNCA, no se
  // exige nada — es la misma regla de "fallar abierto" que gobierna el resto del candado.
  // `doctor` sale con 1 cuando encuentra problemas, y `run` usa execFileSync, que en ese caso
  // lanza. La salida sigue estando en el error: es lo que hay que leer.
  let doc = '';
  try {
    doc = cli(['doctor', '--cwd', projectA], { cwd: projectA });
  } catch (err) {
    doc = err.stdout?.toString() ?? '';
  }
  assert(/DESARMADA/.test(doc), 'doctor no avisa que la obligación está desarmada');

  const out = cli(['release', '--cwd', projectA], { cwd: projectA });
  assert(/nunca corrió/.test(out), 'no explica que la culpa es de la plomería, no del usuario');

  // Volver al estado que espera el test siguiente, ya con la plomería demostrada: una mutación
  // sobre cualquier tarea prueba que el hook corre.
  hook('sync-hook', {
    cwd: projectA,
    tool_name: 'mcp__claude_ai_ClickUp__clickup_update_task',
    tool_input: { taskId: 'PLOMERIA-OK' },
    tool_response: { id: 'PLOMERIA-OK', name: 'prueba de que el hook corre' },
  });
  cli(['claim', '--task-id', '86abc123', '--title', 'Arreglar el ruteo', '--cwd', projectA], {
    cwd: projectA,
  });
});

check('release SIN evidencia de ClickUp se NIEGA a soltar', () => {
  // El chequeo que convierte el cierre en algo verificado en vez de anunciado: si no hay ninguna
  // mutación MCP registrada para la tarea, soltar el claim borraría la única señal de que este
  // trabajo pasó, y el tablero quedaría sin rastro.
  let threw = false;
  try {
    cli(['release', '--task-id', '86abc123', '--cwd', projectA], { cwd: projectA });
  } catch (err) {
    threw = true;
    const msg = err.stderr?.toString() ?? '';
    assert(/ninguna mutación/i.test(msg), 'no explica que falta la evidencia');
    assert(msg.includes('--force'), 'no ofrece la salida documentada');
  }
  assert(threw, 'soltó una tarea sin ninguna evidencia de que se tocó en ClickUp');
});

check('release con el id correcto sí libera (con --force, sin evidencia)', () => {
  const out = cli(['release', '--task-id', '86abc123', '--force', '--cwd', projectA], {
    cwd: projectA,
  });
  assert(out.includes('liberado'), 'no liberó con el id correcto');
  // Reclamar de nuevo para el test siguiente.
  cli(['claim', '--task-id', '86abc123', '--title', 'Arreglar el ruteo', '--cwd', projectA], {
    cwd: projectA,
  });
});

check('release vuelve a activar el candado', () => {
  cli(['release', '--force', '--cwd', projectA], { cwd: projectA });
  const r = hook('guard', {
    cwd: projectA,
    tool_name: 'Write',
    tool_input: { file_path: path.join(projectA, 'app.js') },
  });
  assertEqual(r.code, 2, 'no volvió a bloquear después del release');
});

check('exempt exige un motivo', () => {
  let threw = false;
  try {
    cli(['exempt', '--cwd', projectA], { cwd: projectA });
  } catch (err) {
    threw = true;
    assert((err.stderr?.toString() ?? '').includes('reason'), 'no explicó que falta el motivo');
  }
  assert(threw, 'aceptó una exención sin motivo');
});

check('exempt con motivo desbloquea', () => {
  cli(['exempt', '--reason', 'typo en un comentario', '--cwd', projectA], { cwd: projectA });
  const r = hook('guard', {
    cwd: projectA,
    tool_name: 'Write',
    tool_input: { file_path: path.join(projectA, 'app.js') },
  });
  assertEqual(r.code, 0, `no desbloqueó con exención vigente: ${r.stderr}`);
});

check('una exención vencida vuelve a bloquear, y lo dice', () => {
  // Backdate the exemption past its window instead of waiting eight hours.
  const stateFiles = fs
    .readdirSync(path.join(fakeClaude, 'clickup-flow', 'state'))
    .map((f) => path.join(fakeClaude, 'clickup-flow', 'state', f));
  const target = stateFiles.find((f) => {
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    return s.project === canonicalProjectKey(projectA);
  });
  assert(target, 'no encontré el archivo de estado del proyecto');
  const state = JSON.parse(fs.readFileSync(target, 'utf8'));
  state.exemption.declared_at = new Date(Date.now() - 9 * 3_600_000).toISOString();
  fs.writeFileSync(target, JSON.stringify(state, null, 2));

  const r = hook('guard', {
    cwd: projectA,
    tool_name: 'Write',
    tool_input: { file_path: path.join(projectA, 'app.js') },
  });
  assertEqual(r.code, 2, 'una exención vencida siguió abriendo el candado');
  assert(r.stderr.includes('VENCIÓ'), 'no dijo que la exención venció');
  assert(r.stderr.includes('typo'), 'no recordó el motivo que tenía');
  cli(['exempt', '--clear', '--cwd', projectA], { cwd: projectA });
});

check('el candado se puede apagar por configuración', () => {
  cli(['config', 'set', '--key', 'defaults.block_writes_without_task', '--value', 'false']);
  const r = hook('guard', {
    cwd: projectA,
    tool_name: 'Write',
    tool_input: { file_path: path.join(projectA, 'app.js') },
  });
  assertEqual(r.code, 0, 'siguió bloqueando con el candado apagado');
  cli(['config', 'set', '--key', 'defaults.block_writes_without_task', '--value', 'true']);
});

process.stdout.write('\nIDENTIDAD (el bug de asignación)\n');

check('la identidad arranca sin resolver', () => {
  let out = '';
  try {
    out = cli(['identity', 'show']);
  } catch (err) {
    out = err.stdout?.toString() ?? '';
  }
  assert(out.includes('SIN RESOLVER'), 'debería arrancar sin resolver');
});

check('context avisa que no se puede asignar', () => {
  const out = cli(['context', '--cwd', projectA], { cwd: projectA });
  assert(out.includes('NO está resuelta'), 'no avisa que la identidad falta');
  assert(out.includes('No asignes nada'), 'no prohíbe asignar');
});

check('identity set rechaza un id no numérico', () => {
  let threw = false;
  try {
    cli(['identity', 'set', '--id', 'me']);
  } catch (err) {
    threw = true;
    assert((err.stderr?.toString() ?? '').includes('numérico'), 'no explicó por qué');
  }
  assert(threw, 'aceptó "me" como id — es exactamente el bug a evitar');
});

check('identity set acepta un id numérico confirmado', () => {
  cli([
    'identity', 'set',
    '--id', '5000000001',
    '--email', 'atorres@acme.example',
    '--name', 'Ana Torres',
    '--confirmed',
  ]);
  const cfg = readConfig();
  assertEqual(cfg.identity.clickup_user_id, '5000000001', 'id');
  assertEqual(cfg.identity.confirmed, true, 'confirmado');
});

check('context ahora manda asignar al id numérico y prohíbe "me"', () => {
  const out = cli(['context', '--cwd', projectA], { cwd: projectA });
  assert(out.includes('5000000001'), 'no trae el id resuelto');
  assert(out.includes('Nunca uses `"me"`'), 'no prohíbe "me"');
});

check('team add marca como no confirmado por defecto', () => {
  const out = cli([
    'team', 'add',
    '--git-email', 'bsalas.dev@example.org',
    '--clickup-id', '5000000002',
    '--name', 'Bruno Salas',
  ]);
  assert(out.includes('SIN CONFIRMAR'), 'no advirtió que quedó sin confirmar');
  assertEqual(readConfig().team['bsalas.dev@example.org'].confirmed, false, 'confirmed');
});

process.stdout.write('\nEL PROTOCOLO RESUELTO POR PROYECTO\n');

check('modo tasks: sin paraguas, sin parent', () => {
  const out = cli(['context', '--cwd', projectA], { cwd: projectA });
  assert(out.includes('no se usa en este proyecto'), 'no aclara que no hay paraguas');
  assert(out.includes('Tarea normal, sin `parent`'), 'no dice que va sin parent');
});

check('modo umbrella: exige parent y menciona el paraguas', () => {
  const out = cli(['context', '--cwd', projectB], { cwd: projectB });
  assert(out.includes('86abc0001'), 'no trae el id del paraguas');
  assert(out.includes('parent:'), 'no incluye el parent en el create');
  assert(out.includes('siempre subtarea'), 'no exige subtarea');
});

check('handoff: aparece la bifurcación solo donde corresponde', () => {
  const withHandoff = cli(['context', '--cwd', projectB], { cwd: projectB });
  assert(withHandoff.includes('update required'), 'falta la bifurcación de handoff');
  const without = cli(['context', '--cwd', projectA], { cwd: projectA });
  assert(
    !without.includes('¿el cambio necesita implementación visual?'),
    'metió la bifurcación en un proyecto sin handoff',
  );
});

check('end_date_field=description prohíbe tocar due_date', () => {
  const out = cli(['context', '--cwd', projectA], { cwd: projectA });
  assert(out.includes('`due_date` NO se usa para esto'), 'no prohíbe due_date');
  assert(out.includes('Finalizado:'), 'no manda la línea Finalizado');
});

check('end_date_field=due_date cambia la instrucción y advierte', () => {
  cli(['config', 'set', '--key', 'defaults.end_date_field', '--value', 'due_date']);
  const out = cli(['context', '--cwd', projectA], { cwd: projectA });
  assert(out.includes('la fecha de fin va en `due_date`'), 'no cambió la instrucción');
  assert(out.includes('due_date: "none"'), 'no explica la limpieza al reabrir');
  cli(['config', 'set', '--key', 'defaults.end_date_field', '--value', 'description']);
});

check('config set valida los valores de end_date_field', () => {
  let threw = false;
  try {
    cli(['config', 'set', '--key', 'defaults.end_date_field', '--value', 'inventado']);
  } catch {
    threw = true;
  }
  assert(threw, 'aceptó un valor inválido');
});

check('use_dates=false quita las fechas del protocolo', () => {
  cli(['config', 'set', '--key', 'defaults.use_dates', '--value', 'false']);
  const out = cli(['context', '--cwd', projectA], { cwd: projectA });
  assert(!out.includes('start_date:'), 'siguió pidiendo start_date con las fechas apagadas');
  cli(['config', 'set', '--key', 'defaults.use_dates', '--value', 'true']);
});

check('use_priorities=false quita la tabla de prioridad', () => {
  cli(['config', 'set', '--key', 'defaults.use_priorities', '--value', 'false']);
  const out = cli(['context', '--cwd', projectA], { cwd: projectA });
  assert(!out.includes('Prioridad — por impacto'), 'siguió mostrando prioridades apagadas');
  cli(['config', 'set', '--key', 'defaults.use_priorities', '--value', 'true']);
});

check('la ventana de búsqueda se refleja en el protocolo', () => {
  for (const days of ['7', '90', '365']) {
    cli(['config', 'set', '--key', 'defaults.search_window_days', '--value', days]);
    const out = cli(['context', '--cwd', projectA], { cwd: projectA });
    assert(out.includes(`últimos ${days} días`), `no aplicó la ventana de ${days} días`);
    assert(out.includes('date_closed_from'), `perdió el filtro de fecha con ${days} días`);
  }
  cli(['config', 'set', '--key', 'defaults.search_window_days', '--value', '30']);
});

check('ventana en 0 = sin límite: quita el filtro de fecha y colapsa a dos pasadas', () => {
  cli(['config', 'set', '--key', 'defaults.search_window_days', '--value', '0']);
  const out = cli(['context', '--cwd', projectA], { cwd: projectA });

  assert(out.includes('SIN LÍMITE'), 'no informa que la ventana no tiene límite');
  assert(out.includes('Dos pasadas'), 'no colapsó las pasadas');

  // Lo que importa de verdad: el bloque de comandos EMITIDO no puede llevar el filtro de fecha.
  // (La sección de límites de la API sí lo menciona, y eso es correcto.)
  const bloque = out.slice(
    out.indexOf('## Paso 1 — Buscar antes de crear'),
    out.indexOf('### Qué hacer según'),
  );
  assert(!bloque.includes('date_closed_from'), 'dejó el filtro de fecha en la búsqueda emitida');
  assert(!bloque.includes('created_date_from'), 'dejó el filtro de creación en la búsqueda');
  assert(bloque.includes('include_closed:true'), 'sin include_closed no aparecen las cerradas');

  cli(['config', 'set', '--key', 'defaults.search_window_days', '--value', '30']);
});

check('la ventana se puede definir por proyecto, en días o sin límite', () => {
  cli(['project', 'set', '--mode', 'tasks', '--list-id', '4000000001',
       '--search-window-days', '0', '--cwd', projectA], { cwd: projectA });
  const a = cli(['context', '--cwd', projectA], { cwd: projectA });
  assert(a.includes('Dos pasadas'), 'el override a sin límite no se aplicó');

  const b = cli(['context', '--cwd', projectB], { cwd: projectB });
  assert(b.includes('Tres pasadas'), 'el sin límite se filtró a otro proyecto');

  const st = cli(['status', '--cwd', projectA], { cwd: projectA });
  assert(st.includes('sin límite'), `status no lo informa:\n${st}`);

  // Volver a una ventana acotada en este proyecto.
  cli(['project', 'set', '--mode', 'tasks', '--list-id', '4000000001',
       '--search-window-days', '30', '--cwd', projectA], { cwd: projectA });
});

check('la ventana valida lo que recibe', () => {
  for (const bad of ['-5', 'abc', '7.5']) {
    let threw = false;
    try {
      cli(['config', 'set', '--key', 'defaults.search_window_days', '--value', bad]);
    } catch {
      threw = true;
    }
    assert(threw, `aceptó una ventana inválida: ${bad}`);
  }
  // Y el valor bueno sigue en pie después de los rechazos.
  const out = cli(['config', 'show']);
  assert(/"search_window_days": 30/.test(out), 'un valor inválido corrompió la config');
});

check('un proyecto puede overridear end_date_field sin afectar a los demás', () => {
  // El caso real que motivó esto: dos repos escriben la fecha de fin en due_date y un tercero
  // lo prohíbe porque su equipo usa ese campo como fecha límite. Una sola respuesta global
  // tendría que estar mal para alguno, y "mal" acá significa borrar el vencimiento de otro.
  cli(
    [
      'project', 'set',
      '--mode', 'umbrella',
      '--name', 'Proyecto Umbrella',
      '--space-id', '2000000001',
      '--list-id', '4000000002',
      '--umbrella-task-id', '86abc0001',
      '--role', 'backend',
      '--end-date-field', 'due_date',
      '--search-window-days', '15',
      '--cwd', projectB,
    ],
    { cwd: projectB },
  );

  const b = cli(['context', '--cwd', projectB], { cwd: projectB });
  assert(b.includes('la fecha de fin va en `due_date`'), 'el override no se aplicó');
  assert(b.includes('últimos 15 días'), 'el override de ventana no se aplicó');

  // and the other project keeps the global default
  const a = cli(['context', '--cwd', projectA], { cwd: projectA });
  assert(a.includes('`due_date` NO se usa para esto'), 'el override se filtró al otro proyecto');
  assert(a.includes('últimos 30 días'), 'la ventana global se contaminó');
});

check('status muestra qué campos están overrideados', () => {
  const out = cli(['status', '--cwd', projectB], { cwd: projectB });
  assert(out.includes('override'), 'no informa que hay overrides');
  assert(out.includes('end_date_field'), 'no dice cuál está overrideado');
});

check('project set valida los overrides', () => {
  let threw = false;
  try {
    cli(
      [
        'project', 'set', '--mode', 'tasks', '--list-id', '999',
        '--end-date-field', 'inventado', '--cwd', projectD,
      ],
      { cwd: projectD },
    );
  } catch (err) {
    threw = true;
    assert(
      (err.stderr?.toString() ?? '').includes('end-date-field'),
      'no explicó el valor inválido',
    );
  }
  assert(threw, 'aceptó un end_date_field inválido');
  // y no dejó el proyecto a medio registrar
  let out = '';
  try {
    out = cli(['status', '--cwd', projectD], { cwd: projectD });
  } catch (err) {
    out = err.stdout?.toString() ?? '';
  }
  assert(out.includes('registrado      no'), 'registró el proyecto pese al error');
});

check('un proyecto excluido devuelve un contexto que corta el flujo', () => {
  const out = cli(['context', '--cwd', projectC], { cwd: projectC });
  assert(out.includes('excluido'), 'no dice que está excluido');
  assert(out.includes('no le preguntes al usuario'), 'no evita volver a preguntar');
});

check('siempre se instruye fallar cerrado si ClickUp no responde', () => {
  const out = cli(['context', '--cwd', projectA], { cwd: projectA });
  assert(out.includes('Si ClickUp no responde, se PARA'), 'falta la regla de fallo cerrado');
});

check('el protocolo insiste en la unión de assignees', () => {
  const out = cli(['context', '--cwd', projectA], { cwd: projectA });
  assert(out.includes('leer, unir y escribir'), 'no explica la unión');
  assert(out.includes('borra a esas dos personas'), 'no advierte la pérdida silenciosa');
});

process.stdout.write('\nESTADOS DEL TABLERO (nombres validados contra ClickUp real)\n');

check('sin capturar estados, usa los defaults y lo dice', () => {
  const out = cli(['context', '--cwd', projectA], { cwd: projectA });
  assert(out.includes('Los estados de ESTE tablero'), 'no declara los estados');
  assert(out.includes('son los defaults'), 'no avisa que no están confirmados');
  const st = cli(['status', '--cwd', projectA], { cwd: projectA });
  assert(st.includes('SIN confirmar'), 'status no marca que están sin confirmar');
});

check('doctor cuenta los estados sin confirmar como aviso, no como problema', () => {
  const out = cli(['doctor']);
  assert(out.includes('estados sin confirmar'), 'no menciona el aviso');
  assert(out.includes('Todo en orden'), `lo trató como problema:\n${out}`);
});

check('captura los estados reales de un tablero en inglés', () => {
  cli(
    [
      'project', 'set', '--mode', 'tasks', '--list-id', '4000000001', '--role', 'backend',
      '--status-todo', 'to do',
      '--status-in-progress', 'in progress',
      '--status-on-hold', 'on hold',
      '--status-handoff', 'update required',
      '--status-done', 'complete',
      // Los seis estados reales del espacio Acme, leídos con clickup_get_list.
      '--available-statuses', 'to do|on hold|in progress|update required|reviewed|complete',
      '--cwd', projectA,
    ],
    { cwd: projectA },
  );
  const out = cli(['context', '--cwd', projectA], { cwd: projectA });
  assert(!out.includes('son los defaults'), 'sigue diciendo que son defaults');
  assert(out.includes('status:     "in progress"'), 'no emite el estado real');
  // "reviewed" existe en ese tablero pero el flujo no le da significado: hay que decirlo.
  assert(out.includes('existe en el tablero'), 'no marca reviewed como no declarado');
  assert(out.includes('preguntá'), 'no manda preguntar ante un estado no declarado');
});

check('un tablero con estados en español emite ESOS nombres', () => {
  // El caso que hacía fallar cada clickup_update_task: nombres distintos a los canónicos.
  cli(
    [
      'project', 'set', '--mode', 'tasks', '--list-id', '999',
      '--status-todo', 'Pendiente',
      '--status-in-progress', 'En progreso',
      '--status-on-hold', 'Bloqueado',
      '--status-done', 'Terminado',
      '--available-statuses', 'Pendiente|En progreso|Bloqueado|Terminado',
      '--cwd', projectD,
    ],
    { cwd: projectD },
  );
  const out = cli(['context', '--cwd', projectD], { cwd: projectD });
  assert(out.includes('status:     "En progreso"'), 'no emite "En progreso" al reclamar');
  assert(out.includes('status:  "Terminado"'), 'no emite "Terminado" al cerrar');
  assert(!out.includes('"in progress"'), 'sigue emitiendo el nombre canónico');
  assert(!out.includes('status:  "complete"'), 'sigue emitiendo complete');
  assert(out.includes('Pendiente'), 'la ventana de búsqueda no usa los nombres reales');
});

check('rechaza un estado que no existe en la lista', () => {
  let threw = false;
  try {
    cli(
      [
        'project', 'set', '--mode', 'tasks', '--list-id', '999',
        '--status-in-progress', 'Haciendo',
        '--available-statuses', 'Pendiente|En progreso|Terminado',
        '--cwd', projectD,
      ],
      { cwd: projectD },
    );
  } catch (err) {
    threw = true;
    const msg = err.stderr?.toString() ?? '';
    assert(msg.includes('no existen en la lista'), 'no explica el problema');
    assert(msg.includes('Haciendo'), 'no dice cuál estado está mal');
  }
  assert(threw, 'aceptó un estado inexistente — eso hace fallar cada update después');
});

check('los estados capturados sobreviven a una reinstalación', () => {
  run([INSTALLER, '--yes']);
  const out = cli(['context', '--cwd', projectD], { cwd: projectD });
  assert(out.includes('"En progreso"'), 'la reinstalación perdió los estados capturados');
});

process.stdout.write('\nMIGRACIÓN DESDE EL PROTOCOLO VIEJO\n');

// Un repo con la forma exacta de la configuración anterior: skill, comando, hooks, settings que
// los registra, estado local, mapeo de usuarios y un CLAUDE.md que declara prioridad.
const legacy = path.join(sandbox, 'repo-legacy');
fs.mkdirSync(path.join(legacy, '.claude', 'skills', 'clickup-task-flow'), { recursive: true });
fs.mkdirSync(path.join(legacy, '.claude', 'commands'), { recursive: true });
fs.mkdirSync(path.join(legacy, '.claude', 'hooks'), { recursive: true });
fs.writeFileSync(path.join(legacy, '.claude', 'skills', 'clickup-task-flow', 'SKILL.md'), '---\nname: clickup-task-flow\n---\nviejo');
fs.writeFileSync(path.join(legacy, '.claude', 'commands', 'tarea.md'), 'comando viejo');
fs.writeFileSync(path.join(legacy, '.claude', 'hooks', 'recordar-protocolo.sh'), '#!/bin/bash\nexit 0');
fs.writeFileSync(path.join(legacy, '.claude', 'hooks', 'bloquear-sin-tarea.sh'), '#!/bin/bash\nexit 0');
fs.writeFileSync(path.join(legacy, '.claude', '.tarea-actual'), 'algo (tarea 86abc, por dev@example.net)');
fs.writeFileSync(
  path.join(legacy, '.claude', 'settings.json'),
  JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'bash .claude/hooks/recordar-protocolo.sh' }] }],
    },
    permissions: { deny: ['Bash(pytest*)'] },
  }, null, 2),
);
fs.writeFileSync(
  path.join(legacy, '.claude', 'clickup-usuarios.json'),
  JSON.stringify({
    _lee_esto: ['una nota larga que no es un usuario'],
    workspace_id: '1000000001',
    usuarios: {
      'ana.torres@example.net': {
        clickup_id: '5000000001', clickup_email: 'atorres@acme.example',
        nombre: 'Ana Torres', confirmado: true, nota: 'Confirmado en sesión',
      },
      'BSalas.dev@example.org': {
        clickup_id: '5000000002', clickup_email: 'bsalas@acme.example',
        nombre: 'Bruno Salas', confirmado: false, nota: 'INFERIDO, coincide el apellido pero no el nombre',
      },
    },
  }, null, 2),
);
fs.writeFileSync(
  path.join(legacy, 'CLAUDE.md'),
  '# Proyecto\n\nInvocá la skill `clickup-task-flow`.\n\n' +
    '> **Esta skill manda en este repositorio.** Si hay otra skill de ClickUp cargada (por ejemplo\n' +
    '> una global de la cuenta), **gana esta**.\n\n' +
    'El candado usa `.claude/.tarea-actual`.\n\n## Otra sección que no hay que tocar\n\ncontenido\n',
);
fs.writeFileSync(path.join(legacy, 'TODO.md'), '# TODO\n\nespejo del detalle\n');

check('migrate detecta todos los conflictos del protocolo viejo', () => {
  let out = '';
  try {
    out = cli(['migrate', '--cwd', legacy], { cwd: legacy });
  } catch (err) {
    // exit 1 es correcto cuando hay conflictos
    out = err.stdout?.toString() ?? '';
  }
  for (const needle of [
    'skill del repo',
    '/tarea` del repo',
    'recordar-protocolo.sh',
    'bloquear-sin-tarea.sh',
    'hooks viejos registrados en el settings.json',
    'CLAUDE.md',
  ]) {
    assert(out.includes(needle), `no detectó: ${needle}`);
  }
  assert(out.includes('CONFLICTO'), 'no los marca como conflicto');
});

check('migrate detecta la declaración de prioridad del CLAUDE.md', () => {
  let out = '';
  try {
    out = cli(['migrate', '--cwd', legacy], { cwd: legacy });
  } catch (err) {
    out = err.stdout?.toString() ?? '';
  }
  // Es el hallazgo más importante: esa frase sola hace ganar al protocolo viejo aunque se
  // borren todos los archivos.
  assert(out.includes('TIENE PRIORIDAD'), 'no advierte sobre la declaración de prioridad');
});

check('migrate NO borra nada', () => {
  try {
    cli(['migrate', '--cwd', legacy], { cwd: legacy });
  } catch {
    /* exit 1 esperado */
  }
  for (const p of [
    path.join(legacy, '.claude', 'skills', 'clickup-task-flow', 'SKILL.md'),
    path.join(legacy, '.claude', 'commands', 'tarea.md'),
    path.join(legacy, '.claude', 'hooks', 'recordar-protocolo.sh'),
    path.join(legacy, 'CLAUDE.md'),
  ]) {
    assert(fs.existsSync(p), `borró ${p} — migrate es solo de lectura`);
  }
});

check('migrate marca TODO.md como algo que se queda', () => {
  let out = '';
  try {
    out = cli(['migrate', '--cwd', legacy], { cwd: legacy });
  } catch (err) {
    out = err.stdout?.toString() ?? '';
  }
  assert(out.includes('Se queda como está'), 'no tiene sección de lo que se conserva');
  assert(out.includes('TODO.md'), 'no menciona TODO.md');
  assert(out.includes('NO lo toca'), 'no aclara que no lo reemplaza');
});

check('migrate --import-users trae el mapeo y preserva confirmado:false', () => {
  // Ojo: un test anterior ya agregó ese email con el mismo id vía `team add`, sin la nota. El
  // import tiene que COMPLETAR esa entrada, no saltearla: la nota del archivo es justamente la
  // advertencia que explica por qué el mapeo no está confirmado.
  const out = cli(['migrate', '--import-users', '--cwd', legacy], { cwd: legacy });
  assert(out.includes('Importadas 2'), `no importó/completó las dos entradas:\n${out}`);
  assert(out.includes('SIN CONFIRMAR'), 'no marcó la deducida');
  assert(out.includes('completada'), 'no informa que completó una entrada que ya existía');
  const team = readConfig().team;
  assert(team['ana.torres@example.net'].confirmed === true, 'perdió el confirmado');
  assert(team['bsalas.dev@example.org'].confirmed === false, 'ascendió un mapeo deducido');
  assert(
    (team['bsalas.dev@example.org'].note ?? '').includes('INFERIDO'),
    'perdió la nota que explica por qué no está confirmado',
  );
  // `_lee_esto` es una nota del archivo, no un usuario.
  assert(!('_lee_esto' in team), 'importó una clave que no es un usuario');
});

check('migrate --import-users no borra el archivo original', () => {
  assert(
    fs.existsSync(path.join(legacy, '.claude', 'clickup-usuarios.json')),
    'borró el archivo del repo',
  );
});

check('migrate en un proyecto limpio no reporta nada', () => {
  const clean = path.join(sandbox, 'repo-limpio');
  fs.mkdirSync(clean, { recursive: true });
  const out = cli(['migrate', '--cwd', clean], { cwd: clean });
  assert(out.includes('No encontré configuración vieja'), `reportó algo:\n${out}`);
});

process.stdout.write('\nDIAGNÓSTICO Y DESINSTALACIÓN\n');

check('doctor reporta una instalación sana', () => {
  const out = cli(['doctor']);
  assert(out.includes('3/3'), `no ve los tres hooks:\n${out}`);
  assert(out.includes('Todo en orden'), `reporta problemas:\n${out}`);
});

check('doctor detecta un umbrella sin paraguas', () => {
  const cfgPath = path.join(fakeClaude, 'clickup-flow', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const key = Object.keys(cfg.projects).find((k) => cfg.projects[k].mode === 'umbrella');
  const saved = cfg.projects[key].umbrella_task_id;
  cfg.projects[key].umbrella_task_id = null;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  let out = '';
  try {
    out = cli(['doctor']);
  } catch (err) {
    out = err.stdout?.toString() ?? '';
  }
  assert(out.includes('SIN umbrella_task_id'), 'no detectó el paraguas faltante');
  cfg.projects[key].umbrella_task_id = saved;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
});

check('la desinstalación quita lo nuestro y conserva lo del usuario', () => {
  run([INSTALLER, '--uninstall', '--yes']);
  const s = readSettings();
  const flat = JSON.stringify(s.hooks ?? {});
  assert(!flat.includes('clickup-flow'), 'quedaron hooks nuestros');
  assert(flat.includes('codegraph prompt-hook'), 'se perdió el hook de codegraph');
  assert(flat.includes('gentle-ai skill-registry'), 'se perdió el hook de gentle-ai');
  assert(flat.includes('echo hook-del-usuario'), 'se perdió el SessionStart del usuario');
  assert(s.permissions.allow.includes('mcp__codegraph__*'), 'se perdió un allow del usuario');
  assert(
    !s.permissions.allow.includes('mcp__claude_ai_ClickUp__clickup_filter_tasks'),
    'no quitó los permisos que agregó',
  );
  assertEqual(s.model, 'opus[1m]', 'model');
  assert(!fs.existsSync(path.join(fakeClaude, 'skills', 'clickup-task-flow')), 'quedó la skill');
  assert(!fs.existsSync(path.join(fakeClaude, 'commands', 'tarea.md')), 'quedó /tarea');
});

check('la desinstalación no deja wrappers apuntando a un motor borrado', () => {
  for (const w of ['clickup-flow', 'clickup-flow.cmd']) {
    const p = path.join(fakeClaude, 'clickup-flow', w);
    assert(!fs.existsSync(p), `quedó ${w}, que ahora apunta a un cli.mjs inexistente`);
  }
});

check('los backups de settings.json están acotados', () => {
  // Para que el tope se pueda ROMPER hay que superarlo.
  //
  // La versión anterior contaba los ~6 backups que dejaba el suite y comprobaba `<= 10`: nunca
  // pasaba de 10, así que quitar el tope del producto no la hacía fallar. Un test de mutación lo
  // destapó — un test que no puede fallar no prueba nada.
  const dir = path.join(fakeClaude, 'clickup-flow', 'backups');
  const cuenta = () =>
    fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^settings-.*\.json$/.test(f)) : [];

  const antes = cuenta().length;
  for (let i = 0; i < 14; i++) run([INSTALLER, '--yes']);

  const despues = cuenta();
  assert(
    despues.length <= 10,
    `tras ${antes} + 14 instalaciones quedaron ${despues.length} backups: el tope no se aplica`,
  );
  assert(despues.length > 0, 'no dejó ningún backup');

  // Y conserva los MÁS NUEVOS: el nombre lleva timestamp ISO, así que ordena cronológicamente.
  const ordenados = [...despues].sort();
  assert(
    ordenados[ordenados.length - 1] === despues.reduce((a, b) => (a > b ? a : b)),
    'no conservó los backups más recientes',
  );
});

check('la desinstalación por defecto conserva la configuración', () => {
  const cfgPath = path.join(fakeClaude, 'clickup-flow', 'config.json');
  assert(fs.existsSync(cfgPath), 'borró la config sin que se lo pidieran');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert(Object.keys(cfg.projects).length >= 3, 'perdió los proyectos registrados');
  assertEqual(cfg.identity.clickup_user_id, '5000000001', 'perdió la identidad resuelta');
});

check('reinstalar recupera los proyectos ya configurados', () => {
  run([INSTALLER, '--yes']);
  const cfg = readConfig();
  assert(Object.keys(cfg.projects).length >= 3, 'la reinstalación perdió proyectos');
  assertEqual(cfg.identity.clickup_user_id, '5000000001', 'la reinstalación perdió la identidad');
  const r = hook('guard', {
    cwd: projectA,
    tool_name: 'Write',
    tool_input: { file_path: path.join(projectA, 'app.js') },
  });
  assertEqual(r.code, 2, 'el candado no volvió después de reinstalar');
});

// =============================================================================================

process.stdout.write(`\n${passed} pasaron, ${failed} fallaron\n`);
if (failed) {
  process.stdout.write('\nFallos:\n');
  for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.err.message}\n`);
  process.stdout.write(`\nsandbox conservado para inspección: ${sandbox}\n`);
  process.exit(1);
}

fs.rmSync(sandbox, { recursive: true, force: true });
process.stdout.write('\nTodo verde.\n');

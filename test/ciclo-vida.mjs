#!/usr/bin/env node
//
// Ciclo de vida de la instalación: instalar, reinstalar, ACTUALIZAR y desinstalar.
//
// Los otros suites prueban que la herramienta funcione. Este prueba que se pueda mantener, y
// existe por dos bugs reales que aparecieron justamente acá:
//
//   1. Al actualizar a una versión que renombraba un comando, el archivo viejo quedaba huérfano:
//      un `/comando` visible apuntando a un flujo que la versión nueva ya no soportaba. Se
//      arregló con un manifiesto de archivos instalados.
//   2. La desinstalación se rompía con un ReferenceError y salía sin borrar nada, dejando los
//      tres hooks registrados. Imprimía "Desinstalando" y terminaba: el modo de fallo más
//      peligroso posible, porque parece que funcionó.
//
// Un "update" se simula creando una copia del árbol y modificándola, que es exactamente lo que
// pasa cuando alguien hace `git pull` y vuelve a correr el instalador.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n         ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// ---- sandbox --------------------------------------------------------------------------------
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'clickup-ciclo-'));
const fakeClaude = path.join(sandbox, '.claude');
const project = path.join(sandbox, 'proj');
const V1 = path.join(sandbox, 'v1');
const V2 = path.join(sandbox, 'v2');

fs.mkdirSync(path.join(fakeClaude, 'skills', 'mi-skill'), { recursive: true });
fs.mkdirSync(path.join(fakeClaude, 'commands'), { recursive: true });
fs.mkdirSync(project, { recursive: true });

// Cosas del usuario que NO se pueden tocar en ningún momento del ciclo.
fs.writeFileSync(path.join(fakeClaude, 'skills', 'mi-skill', 'SKILL.md'), 'skill del usuario');
fs.writeFileSync(path.join(fakeClaude, 'commands', 'mi-comando.md'), 'comando del usuario');
fs.writeFileSync(
  path.join(fakeClaude, 'settings.json'),
  JSON.stringify(
    {
      model: 'opus',
      theme: 'dark',
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'mi-hook-personal' }] }] },
      permissions: { allow: ['mcp__mio__*'], deny: ['Bash(rm -rf /)'] },
    },
    null,
    2,
  ),
);

/** Copia del árbol del proyecto: lo que tendría alguien tras un `git pull`. */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const src = path.join(from, e.name);
    const dest = path.join(to, e.name);
    if (e.isDirectory()) copyTree(src, dest);
    else if (e.isFile()) fs.copyFileSync(src, dest);
  }
}

copyTree(REPO, V1);

const env = { ...process.env, CLAUDE_CONFIG_DIR: fakeClaude, NO_COLOR: '1' };
const CLI = path.join(fakeClaude, 'clickup-flow', 'src', 'cli.mjs');

function install(root, extra = []) {
  return execFileSync('node', [path.join(root, 'src', 'installer.mjs'), '--yes', ...extra], {
    encoding: 'utf8',
    env,
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function cli(args) {
  return execFileSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env,
    cwd: project,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

const readConfig = () =>
  JSON.parse(fs.readFileSync(path.join(fakeClaude, 'clickup-flow', 'config.json'), 'utf8'));
const readSettings = () =>
  JSON.parse(fs.readFileSync(path.join(fakeClaude, 'settings.json'), 'utf8'));
const ourHookCount = () =>
  JSON.stringify(readSettings().hooks ?? {}).split('clickup-flow/src/cli.mjs').length - 1;
const commands = () => fs.readdirSync(path.join(fakeClaude, 'commands')).sort();
const skills = () => fs.readdirSync(path.join(fakeClaude, 'skills')).sort();

console.log(`\nsandbox: ${sandbox}\n`);
console.log('INSTALACIÓN LIMPIA\n');

const out1 = install(V1);

check('registra la versión de la herramienta', () => {
  const cfg = readConfig();
  const pkg = JSON.parse(fs.readFileSync(path.join(V1, 'package.json'), 'utf8'));
  assert(cfg.installed_version === pkg.version, `versión: ${cfg.installed_version}`);
  assert(out1.includes(`instalado ${pkg.version}`), 'no informa qué versión instaló');
});

check('deja un manifiesto de lo que instaló', () => {
  const files = readConfig().installed_files;
  assert(Array.isArray(files) && files.length >= 4, `manifiesto: ${JSON.stringify(files)}`);
  for (const rel of files) {
    assert(fs.existsSync(path.join(fakeClaude, rel)), `el manifiesto lista algo que no existe: ${rel}`);
  }
});

check('doctor informa la versión instalada', () => {
  let out = '';
  try {
    out = cli(['doctor']);
  } catch (err) {
    out = err.stdout?.toString() ?? '';
  }
  assert(/version\s+\d+\.\d+\.\d+/.test(out), `doctor no muestra versión:\n${out}`);
});

// Estado que tiene que sobrevivir todo el ciclo.
cli(['identity', 'set', '--id', '5000000001', '--name', 'Ana Torres', '--confirmed']);
cli(['project', 'set', '--mode', 'tasks', '--list-id', '4000000001', '--cwd', project]);
cli(['team', 'add', '--git-email', 'primero@example.net', '--clickup-id', '999', '--confirmed']);

console.log('\nREINSTALACIÓN (idempotencia)\n');

const out2 = install(V1);

check('reinstalar informa que es una reinstalación, no un update', () => {
  assert(out2.includes('reinstalado'), 'no distingue reinstalar de actualizar');
});

check('reinstalar no duplica hooks', () => {
  assert(ourHookCount() === 3, `hay ${ourHookCount()} hooks nuestros en vez de 3`);
});

check('reinstalar conserva proyectos, identidad y equipo', () => {
  const cfg = readConfig();
  assert(Object.keys(cfg.projects).length === 1, 'perdió el proyecto');
  assert(cfg.identity.clickup_user_id === '5000000001', 'perdió la identidad');
  assert(Object.keys(cfg.team).length === 1, 'perdió el mapeo del equipo');
});

check('reinstalar no toca nada del usuario', () => {
  const s = readSettings();
  assert(s.model === 'opus' && s.theme === 'dark', 'cambió claves del usuario');
  assert(JSON.stringify(s.hooks).includes('mi-hook-personal'), 'perdió el hook del usuario');
  assert(s.permissions.allow.includes('mcp__mio__*'), 'perdió un allow del usuario');
  assert(s.permissions.deny.includes('Bash(rm -rf /)'), 'perdió un deny del usuario');
  assert(commands().includes('mi-comando.md'), 'borró un comando del usuario');
  assert(skills().includes('mi-skill'), 'borró una skill del usuario');
});

console.log('\nACTUALIZACIÓN A OTRA VERSIÓN\n');

// v2: sube la versión, renombra un comando, agrega un módulo y borra otro.
copyTree(V1, V2);
{
  const pkgPath = path.join(V2, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = '99.0.0';
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  fs.writeFileSync(path.join(V2, 'src', 'lib', 'nuevo.mjs'), 'export const NUEVO = 1;\n');
  fs.rmSync(path.join(V2, 'src', 'lib', 'clickup.mjs'), { force: true });

  const skill = path.join(V2, 'assets', 'skills', 'clickup-task-flow', 'SKILL.md');
  fs.writeFileSync(skill, `${fs.readFileSync(skill, 'utf8')}\n<!-- marca-v2 -->\n`);

  // El caso que dejaba huérfanos: un comando cambia de nombre.
  fs.renameSync(
    path.join(V2, 'assets', 'commands', 'clickup-config.md'),
    path.join(V2, 'assets', 'commands', 'clickup-ajustes.md'),
  );
  const inst = path.join(V2, 'src', 'installer.mjs');
  let body = fs.readFileSync(inst, 'utf8');
  body = body.replace("'clickup-config.md'", "'clickup-ajustes.md'");
  // clickup.mjs ya no existe en v2: hay que quitar su import y su uso.
  body = body.replace(/^import \{[^}]*\} from '\.\/lib\/clickup\.mjs';\n/m, '');
  body = body.replace('await tryResolveIdentity(prompt, answers, config)', 'null');
  fs.writeFileSync(inst, body);
}

const out3 = install(V2);

check('informa la transición de versión', () => {
  assert(/actualizado .* → 99\.0\.0/.test(out3), `no informa el update:\n${out3}`);
});

check('el motor se reemplaza: aparece lo nuevo y desaparece lo borrado', () => {
  const libs = fs.readdirSync(path.join(fakeClaude, 'clickup-flow', 'src', 'lib'));
  assert(libs.includes('nuevo.mjs'), 'no copió el módulo nuevo');
  assert(!libs.includes('clickup.mjs'), 'dejó un módulo que la versión nueva ya no trae');
});

check('los assets se re-renderizan', () => {
  const skill = fs.readFileSync(path.join(fakeClaude, 'skills', 'clickup-task-flow', 'SKILL.md'), 'utf8');
  assert(skill.includes('marca-v2'), 'la skill quedó en la versión vieja');
  assert(!skill.includes('{{CLI}}'), 'quedó un {{CLI}} sin sustituir');
});

check('un comando renombrado NO deja huérfano', () => {
  const cmds = commands();
  assert(cmds.includes('clickup-ajustes.md'), 'no instaló el comando nuevo');
  assert(
    !cmds.includes('clickup-config.md'),
    `quedó el comando viejo huérfano: ${JSON.stringify(cmds)}`,
  );
  assert(out3.includes('quitado'), 'no avisó que quitó un archivo obsoleto');
});

check('el manifiesto refleja la versión nueva', () => {
  const files = readConfig().installed_files;
  assert(files.some((f) => f.endsWith('clickup-ajustes.md')), 'el manifiesto no tiene el nuevo');
  assert(!files.some((f) => f.endsWith('clickup-config.md')), 'el manifiesto conserva el viejo');
});

check('actualizar conserva proyectos, identidad y equipo', () => {
  const cfg = readConfig();
  assert(Object.keys(cfg.projects).length === 1, 'perdió el proyecto');
  assert(cfg.identity.clickup_user_id === '5000000001', 'perdió la identidad');
  assert(Object.keys(cfg.team).length === 1, 'perdió el equipo');
});

check('actualizar sigue sin tocar nada del usuario', () => {
  const s = readSettings();
  assert(ourHookCount() === 3, `hay ${ourHookCount()} hooks nuestros`);
  assert(JSON.stringify(s.hooks).includes('mi-hook-personal'), 'perdió el hook del usuario');
  assert(commands().includes('mi-comando.md'), 'borró un comando del usuario');
  assert(skills().includes('mi-skill'), 'borró una skill del usuario');
  assert(s.model === 'opus', 'cambió claves del usuario');
});

check('el candado sigue funcionando después de actualizar', () => {
  let blocked = false;
  try {
    execFileSync('node', [CLI, 'guard'], {
      encoding: 'utf8',
      env,
      input: JSON.stringify({
        cwd: project,
        tool_name: 'Write',
        tool_input: { file_path: path.join(project, 'a.js') },
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    blocked = err.status === 2;
  }
  assert(blocked, 'el candado dejó de bloquear después del update');
});

console.log('\nDESINSTALACIÓN\n');

const out4 = execFileSync('node', [path.join(V2, 'src', 'installer.mjs'), '--uninstall', '--yes'], {
  encoding: 'utf8',
  env,
  cwd: V2,
  stdio: ['pipe', 'pipe', 'pipe'],
});

check('la desinstalación realmente hace algo', () => {
  // El bug era exactamente esto: imprimía "Desinstalando" y salía sin borrar nada.
  assert(out4.includes('Desinstalado'), `no llegó al final:\n${out4}`);
  assert(out4.includes('hook(s)'), 'no informa haber quitado los hooks');
});

check('quita los tres hooks y deja los del usuario', () => {
  assert(ourHookCount() === 0, `quedaron ${ourHookCount()} hooks nuestros`);
  assert(
    JSON.stringify(readSettings().hooks ?? {}).includes('mi-hook-personal'),
    'se llevó el hook del usuario',
  );
});

check('quita los permisos que agregó y deja los del usuario', () => {
  const allow = readSettings().permissions.allow;
  assert(allow.includes('mcp__mio__*'), 'perdió un allow del usuario');
  assert(
    !allow.some((a) => a.startsWith('mcp__claude_ai_ClickUp__')),
    `dejó permisos propios: ${JSON.stringify(allow)}`,
  );
  assert(readSettings().permissions.deny.includes('Bash(rm -rf /)'), 'perdió un deny');
});

check('borra sus archivos vía manifiesto, incluido el renombrado', () => {
  // La prueba clave: `clickup-ajustes.md` no está en la lista hardcodeada del instalador.
  // Solo el manifiesto sabe que existe.
  assert(commands().length === 1, `quedaron comandos: ${JSON.stringify(commands())}`);
  assert(commands()[0] === 'mi-comando.md', 'borró el comando del usuario');
  assert(skills().length === 1 && skills()[0] === 'mi-skill', `quedaron skills: ${skills()}`);
});

check('borra los wrappers para no dejar un comando roto en el PATH', () => {
  for (const w of ['clickup-flow', 'clickup-flow.cmd']) {
    assert(
      !fs.existsSync(path.join(fakeClaude, 'clickup-flow', w)),
      `quedó ${w} apuntando a un cli.mjs inexistente`,
    );
  }
});

check('conserva la configuración por defecto, para poder reinstalar', () => {
  const cfg = readConfig();
  assert(Object.keys(cfg.projects).length === 1, 'borró los proyectos sin que se lo pidieran');
  assert(cfg.identity.clickup_user_id === '5000000001', 'borró la identidad');
});

check('no deja claves del usuario alteradas', () => {
  const s = readSettings();
  assert(s.model === 'opus' && s.theme === 'dark', 'cambió claves del usuario');
});

console.log('\nREINSTALACIÓN DESPUÉS DE DESINSTALAR\n');

install(V1);

check('reinstalar recupera el estado completo', () => {
  const cfg = readConfig();
  assert(Object.keys(cfg.projects).length === 1, 'no recuperó el proyecto');
  assert(cfg.identity.clickup_user_id === '5000000001', 'no recuperó la identidad');
  assert(ourHookCount() === 3, 'no volvieron los hooks');
  assert(commands().includes('tarea.md'), 'no volvió /tarea');
});

check('y el usuario sigue con todo lo suyo', () => {
  assert(commands().includes('mi-comando.md'), 'perdió el comando del usuario');
  assert(skills().includes('mi-skill'), 'perdió la skill del usuario');
  assert(
    JSON.stringify(readSettings().hooks).includes('mi-hook-personal'),
    'perdió el hook del usuario',
  );
});

// ---------------------------------------------------------------------------------------------
// El motor no se borra antes de copiarlo.
//
// El instalador hacía `fs.rmSync(engineDest, { recursive: true, force: true })` y después
// copiaba. `force: true` sólo silencia ENOENT: EBUSY, EPERM y ENOTEMPTY siguen tirando. Medido:
// 1 de cada 5 instalaciones concurrentes reventaba con un stack crudo en pantalla — y el modo de
// fallo era el peor, porque el motor ya estaba borrado y los tres hooks quedaban apuntando a un
// archivo inexistente.
// ---------------------------------------------------------------------------------------------
console.log('\nEL MOTOR SOBREVIVE A UN BORRADO QUE FALLA\n');

check('al actualizar se borra del motor lo que la versión nueva ya no trae', () => {
  const c = fs.mkdtempSync(path.join(os.tmpdir(), 'clickup-motor-'));
  const fc = path.join(c, '.claude');
  fs.mkdirSync(fc, { recursive: true });
  fs.writeFileSync(path.join(fc, 'settings.json'), '{}');
  const e = { ...process.env, CLAUDE_CONFIG_DIR: fc, NO_COLOR: '1' };
  execFileSync('node', [path.join(REPO, 'src', 'installer.mjs'), '--yes'], { env: e, cwd: REPO, stdio: 'pipe' });

  // Un archivo de una versión anterior que la actual ya no trae.
  const intruso = path.join(fc, 'clickup-flow', 'src', 'lib', 'version-vieja.mjs');
  fs.writeFileSync(intruso, 'export const viejo = true;\n');
  const subdirViejo = path.join(fc, 'clickup-flow', 'src', 'lib', 'obsoleto');
  fs.mkdirSync(subdirViejo, { recursive: true });
  fs.writeFileSync(path.join(subdirViejo, 'x.mjs'), 'export default 1;\n');

  execFileSync('node', [path.join(REPO, 'src', 'installer.mjs'), '--yes'], { env: e, cwd: REPO, stdio: 'pipe' });
  assert(!fs.existsSync(intruso), 'el archivo huérfano del motor sobrevivió a la actualización');
  assert(!fs.existsSync(subdirViejo), 'el directorio huérfano del motor sobrevivió');
  assert(
    fs.existsSync(path.join(fc, 'clickup-flow', 'src', 'cli.mjs')),
    'la limpieza se llevó el CLI',
  );
  fs.rmSync(c, { recursive: true, force: true });
});

check('un archivo viejo del motor que NO se puede borrar no aborta la instalación', () => {
  const c = fs.mkdtempSync(path.join(os.tmpdir(), 'clickup-motor2-'));
  const fc = path.join(c, '.claude');
  fs.mkdirSync(fc, { recursive: true });
  fs.writeFileSync(path.join(fc, 'settings.json'), '{}');
  const e = { ...process.env, CLAUDE_CONFIG_DIR: fc, NO_COLOR: '1' };
  execFileSync('node', [path.join(REPO, 'src', 'installer.mjs'), '--yes'], { env: e, cwd: REPO, stdio: 'pipe' });

  // Se le quita el permiso de escritura al DIRECTORIO que contiene el archivo huérfano, que es
  // lo que hace fallar el `unlink` con EACCES. En Windows `chmod` no hace nada, así que ahí el
  // caso se salta declarándolo: un salto silencioso sería un test que miente.
  const dirLib = path.join(fc, 'clickup-flow', 'src', 'lib');
  const huerfano = path.join(dirLib, 'version-vieja.mjs');
  fs.writeFileSync(huerfano, 'export const viejo = true;\n');

  if (process.platform === 'win32' || process.getuid?.() === 0) {
    console.log('       (salteado: chmod no bloquea en win32 ni como root)');
    fs.rmSync(c, { recursive: true, force: true });
    return;
  }

  fs.chmodSync(dirLib, 0o500);
  let r;
  try {
    r = execFileSync('node', [path.join(REPO, 'src', 'installer.mjs'), '--yes'], {
      env: e,
      cwd: REPO,
      encoding: 'utf8',
    });
  } finally {
    fs.chmodSync(dirLib, 0o700);
  }

  assert(fs.existsSync(huerfano), 'el test no probó nada: el archivo sí se pudo borrar');
  assert(
    fs.existsSync(path.join(fc, 'clickup-flow', 'src', 'cli.mjs')),
    'la instalación no dejó el CLI en su lugar',
  );
  const s = JSON.parse(fs.readFileSync(path.join(fc, 'settings.json'), 'utf8'));
  const refs = (JSON.stringify(s.hooks || {}).match(/cli\.mjs/g) || []).length;
  assert(refs === 3, `los hooks no quedaron registrados: ${refs} referencias`);
  assert(/no se pudieron borrar/i.test(r), `no avisó del archivo que no pudo borrar:\n${r.slice(-400)}`);
  fs.rmSync(c, { recursive: true, force: true });
});

/**
 * Un fallo que llega al catch de nivel superior.
 *
 * Ojo: un `settings.json` ilegible NO sirve para esto — el instalador ya lo maneja con un
 * mensaje propio y ni se acerca al catch. El caso que sí llega es un directorio de Claude Code
 * sin permiso de escritura, que es exactamente lo que pasa cuando alguien instaló con `sudo` y
 * después corre el instalador como su usuario.
 */
function instalarEnDirSinPermisos(extraEnv = {}) {
  const c = fs.mkdtempSync(path.join(os.tmpdir(), 'clickup-permisos-'));
  const fc = path.join(c, '.claude');
  fs.mkdirSync(fc, { recursive: true });
  fs.writeFileSync(path.join(fc, 'settings.json'), '{}');
  fs.chmodSync(fc, 0o500);
  try {
    return spawnSync('node', [path.join(REPO, 'src', 'installer.mjs'), '--yes'], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: fc, NO_COLOR: '1', ...extraEnv },
      cwd: REPO,
      encoding: 'utf8',
    });
  } finally {
    fs.chmodSync(fc, 0o700);
    fs.rmSync(c, { recursive: true, force: true });
  }
}

const puedeProbarPermisos = process.platform !== 'win32' && process.getuid?.() !== 0;

check('un error del instalador sale por stderr, sin stack trace', () => {
  if (!puedeProbarPermisos) {
    console.log('       (salteado: chmod no bloquea en win32 ni como root)');
    return;
  }
  const r = instalarEnDirSinPermisos();
  assert(r.status !== 0, 'un directorio sin permisos tendría que fallar');
  const err = r.stderr ?? '';
  const out = r.stdout ?? '';
  assert(err.trim().length > 0, `el error no salió por stderr (stdout: ${out.slice(-300)})`);
  assert(!/\n\s+at .+:\d+:\d+/.test(err + out), `filtró un stack trace:\n${(err + out).slice(-400)}`);
  assert(/CLICKUP_FLOW_DEBUG/.test(err), `no dice cómo ver el detalle técnico:\n${err}`);
  assert(/permisos/i.test(err), `no explica que es un problema de permisos:\n${err}`);
});

check('con CLICKUP_FLOW_DEBUG=1 sí aparece el stack, y por stderr', () => {
  if (!puedeProbarPermisos) {
    console.log('       (salteado: chmod no bloquea en win32 ni como root)');
    return;
  }
  const r = instalarEnDirSinPermisos({ CLICKUP_FLOW_DEBUG: '1' });
  assert(r.status !== 0, 'tendría que fallar');
  assert(/\n\s+at .+:\d+:\d+/.test(r.stderr ?? ''), `con DEBUG=1 no mostró el stack:\n${r.stderr}`);
  assert(!/\n\s+at .+:\d+:\d+/.test(r.stdout ?? ''), 'el stack salió por stdout');
});

console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
if (fail) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
  console.log(`\nsandbox conservado: ${sandbox}\n`);
  process.exit(1);
}
fs.rmSync(sandbox, { recursive: true, force: true });
console.log('Ciclo de vida verde.\n');

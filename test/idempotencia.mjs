#!/usr/bin/env node
//
// Idempotencia y calidad de los errores.
//
//   1) Todo comando que escribe se corre TRES veces. La segunda y la tercera no pueden cambiar
//      nada que la primera ya dejó bien, y ninguna puede duplicar entradas, hooks o backups.
//      Esto importa porque la herramienta se reinstala con cada `git pull` y los hooks corren en
//      cada prompt: un comando que acumula estado degrada la instalación con el uso.
//
//   2) Todo camino de error tiene que dar un mensaje que diga QUÉ hacer, sin stack, y con el
//      código de salida correcto. Un error que no es accionable manda al usuario a leer el
//      código fuente, y la mitad de las veces el usuario es un agente.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-idem-'));
const claude = path.join(sandbox, '.claude');
fs.mkdirSync(claude, { recursive: true });
fs.writeFileSync(
  path.join(claude, 'settings.json'),
  JSON.stringify({ model: 'opus', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'mio.sh' }] }] } }, null, 2),
);
const env = { ...process.env, CLAUDE_CONFIG_DIR: claude, NO_COLOR: '1' };
const INSTALLER = path.join(REPO, 'src', 'installer.mjs');
execFileSync('node', [INSTALLER, '--yes'], { env, cwd: REPO, stdio: 'pipe' });
const CLI = path.join(claude, 'clickup-flow', 'src', 'cli.mjs');
const CFG = path.join(claude, 'clickup-flow', 'config.json');
const proj = path.join(sandbox, 'proj');
const otro = path.join(sandbox, 'otro');
fs.mkdirSync(proj, { recursive: true });
fs.mkdirSync(otro, { recursive: true });

let pass = 0;
let fail = 0;
const fallos = [];
function check(n, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${n}`);
  } catch (e) {
    fail++;
    fallos.push(`${n}: ${e.message}`);
    console.log(`  FAIL ${n}\n         ${e.message}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m || 'assertion failed');
};
function run(args, cwd = proj, input) {
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8', env, cwd, input: input ?? '' });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}
const tieneStack = (t) => /\n\s+at .+:\d+:\d+/.test(t);
const leerCfg = () => JSON.parse(fs.readFileSync(CFG, 'utf8'));
const leerSettings = () => JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'));

/** Todo lo que define el estado observable de la instalación, para comparar antes y después. */
function huella() {
  const archivos = [];
  (function walk(d, pre) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = pre ? `${pre}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel);
      else archivos.push(rel);
    }
  })(claude, '');
  const cfg = leerCfg();
  // `updated_at` cambia por diseño en cada escritura y existe tanto en la raíz como dentro de
  // cada entrada de proyecto: no forma parte de la huella en ningún nivel.
  (function limpiarSellos(o) {
    if (!o || typeof o !== 'object') return;
    delete o.updated_at;
    for (const v of Object.values(o)) limpiarSellos(v);
  })(cfg);
  const esBackup = (a) => /(^|\/)backups\//.test(a) || /settings-.*\.json$/.test(a);
  return {
    archivos: archivos.filter((a) => !esBackup(a)),
    backups: archivos.filter(esBackup).length,
    config: JSON.stringify(cfg),
    settings: JSON.stringify(leerSettings()),
  };
}

console.log('\n=== IDEMPOTENCIA: TODO COMANDO, TRES VECES ===\n');

/**
 * Corre un comando tres veces y exige que la huella tras la 2ª sea idéntica a la de la 3ª.
 *
 * La 1ª puede (y debe) cambiar cosas: es la que hace el trabajo. Lo que no puede pasar es que la
 * 3ª siga moviendo la aguja, porque eso es acumulación: entradas duplicadas, hooks repetidos,
 * backups infinitos.
 */
function idempotente(nombre, args, cwd = proj) {
  check(`${nombre} es idempotente`, () => {
    const a = run(args, cwd);
    assert(a.code === 0 || a.code === 1, `1ª corrida → exit ${a.code}: ${a.err.slice(0, 200)}`);
    run(args, cwd);
    const h2 = huella();
    const c = run(args, cwd);
    const h3 = huella();
    assert(c.code === a.code, `el código de salida cambió entre corridas: ${a.code} → ${c.code}`);
    assert(h2.config === h3.config, `el config cambió en la 3ª corrida`);
    assert(h2.settings === h3.settings, `settings.json cambió en la 3ª corrida`);
    assert(
      JSON.stringify(h2.archivos) === JSON.stringify(h3.archivos),
      `aparecieron o desaparecieron archivos en la 3ª corrida`,
    );
  });
}

idempotente('project set', ['project', 'set', '--mode', 'tasks', '--list-id', '900', '--role', 'fullstack']);
idempotente('identity set', ['identity', 'set', '--id', '4242', '--confirm']);
idempotente('team add', ['team', 'add', '--email', 'nadie@example.com', '--id', '555', '--name', 'Nadie']);
idempotente('config set', ['config', 'set', '--key', 'defaults.search_window_days', '--value', '30']);
idempotente('claim', ['claim', '--task-id', 'ABC-1']);
idempotente('release', ['release', '--task-id', 'ABC-1']);
idempotente('exempt', ['exempt', '--reason', 'un motivo cualquiera']);
idempotente('project exclude', ['project', 'exclude'], otro);
idempotente('status (lectura)', ['status']);
idempotente('doctor (lectura)', ['doctor']);
idempotente('context (lectura)', ['context']);

check('el instalador corrido 3 veces no duplica hooks ni acumula backups sin tope', () => {
  execFileSync('node', [INSTALLER, '--yes'], { env, cwd: REPO, stdio: 'pipe' });
  const h2 = huella();
  execFileSync('node', [INSTALLER, '--yes'], { env, cwd: REPO, stdio: 'pipe' });
  const h3 = huella();
  const s = leerSettings();
  const refs = (JSON.stringify(s.hooks).match(/cli\.mjs/g) || []).length;
  assert(refs === 3, `los hooks se duplicaron: ${refs} referencias al CLI`);
  assert(JSON.stringify(s.hooks).includes('mio.sh'), 'perdió el hook del usuario');
  assert(
    JSON.stringify(h2.archivos) === JSON.stringify(h3.archivos),
    'la 3ª instalación cambió el conjunto de archivos',
  );
  assert(h3.backups <= 10, `los backups pasaron el tope: ${h3.backups}`);
});

check('los hooks corridos 50 veces no dejan basura', () => {
  const antes = huella();
  for (let i = 0; i < 50; i++) {
    for (const h of ['session-start', 'prompt-hook']) {
      run([h], proj, JSON.stringify({ cwd: proj, prompt: 'hola', tool_input: {} }));
    }
  }
  const despues = huella();
  assert(
    JSON.stringify(antes.archivos) === JSON.stringify(despues.archivos),
    `100 invocaciones de hooks cambiaron el conjunto de archivos:\n` +
      `         + ${despues.archivos.filter((a) => !antes.archivos.includes(a)).slice(0, 5).join(', ')}`,
  );
  assert(despues.settings === antes.settings, 'un hook modificó settings.json');
});

console.log('\n=== CALIDAD DE LOS ERRORES ===\n');

/**
 * Un error accionable: sale por stderr, con exit distinto de 0, sin stack, y con algo más que un
 * "inválido" — tiene que decir qué se esperaba o qué comando corregirlo.
 */
function errorAccionable(nombre, args, cwd = proj, { pista = null } = {}) {
  check(`error accionable: ${nombre}`, () => {
    const r = run(args, cwd);
    assert(r.code !== 0, `esperaba un fallo, dio exit 0`);
    const texto = r.err + r.out;
    assert(r.err.trim().length > 0, `el error no salió por stderr (stdout: ${r.out.slice(0, 200)})`);
    assert(!tieneStack(texto), `filtró un stack:\n${texto.slice(-300)}`);
    assert(texto.trim().length > 25, `el mensaje es demasiado escueto: "${texto.trim()}"`);
    // Un mensaje accionable nombra un flag, un comando, o dice qué valor se esperaba.
    assert(
      /--[a-z-]+|`[^`]+`|clickup-flow|tiene que|ten[ée]s que|falta|esperaba|us[áa] /i.test(texto),
      `el mensaje no dice qué hacer: "${texto.trim().slice(0, 200)}"`,
    );
    if (pista) assert(pista.test(texto), `el mensaje no menciona lo esperado (${pista}): "${texto.trim().slice(0, 200)}"`);
  });
}

errorAccionable('comando inexistente', ['comando-que-no-existe']);
errorAccionable('subcomando inexistente de project', ['project', 'inventado']);
errorAccionable('subcomando inexistente de identity', ['identity', 'inventado']);
errorAccionable('subcomando inexistente de team', ['team', 'inventado']);
errorAccionable('subcomando inexistente de config', ['config', 'inventado']);
errorAccionable('project set sin modo', ['project', 'set'], proj, { pista: /--mode/ });
errorAccionable('project set con modo inválido', ['project', 'set', '--mode', 'raro'], proj, { pista: /--mode/ });
errorAccionable('identity set con id no numérico', ['identity', 'set', '--id', 'abc'], proj, { pista: /num[ée]ric/i });
errorAccionable('identity set sin id', ['identity', 'set'], proj, { pista: /--id/ });
errorAccionable('team add con id no numérico', ['team', 'add', '--email', 'a@example.com', '--id', 'xyz']);
errorAccionable('claim sin task-id', ['claim'], proj, { pista: /--task-id/ });
errorAccionable('exempt sin motivo', ['exempt'], proj, { pista: /--reason|motivo/i });
errorAccionable('config set sin key', ['config', 'set'], proj, { pista: /--key/ });
const jamas = path.join(sandbox, 'jamas');
fs.mkdirSync(jamas, { recursive: true });
errorAccionable('project forget en un proyecto sin registrar', ['project', 'forget'], jamas);

check('todos los subcomandos de grupo desconocidos nombran los que SÍ existen', () => {
  for (const grupo of ['project', 'identity', 'team', 'config']) {
    const r = run([grupo, 'zzz-no-existe']);
    assert(r.code !== 0, `${grupo} zzz → exit 0`);
    const t = r.err + r.out;
    // Un "subcomando desconocido" sin la lista obliga a ir a leer la ayuda o el código.
    assert(
      /set|list|show|add|remove|forget|exclude|path|import/i.test(t),
      `${grupo}: el error no nombra ningún subcomando válido: "${t.trim().slice(0, 200)}"`,
    );
  }
});

check('un error de validación NO deja el config a medio escribir', () => {
  const antes = fs.readFileSync(CFG, 'utf8');
  run(['project', 'set', '--mode', 'raro', '--list-id', '1']);
  run(['identity', 'set', '--id', 'no-numerico']);
  run(['team', 'add', '--email', 'x@example.com', '--id', 'nope']);
  const despues = fs.readFileSync(CFG, 'utf8');
  assert(antes === despues, 'un comando que falló la validación igual escribió en el config');
});

check('el candado bloquea explicando el motivo y cómo seguir', () => {
  run(['project', 'set', '--mode', 'tasks', '--list-id', '900', '--role', 'fullstack']);
  // Un test anterior dejó una exención viva, y con eso el guard falla OPEN con toda la razón.
  // Sin borrarla, este test no probaría el bloqueo sino la exención.
  run(['release', '--force']);
  const st = path.join(claude, 'clickup-flow', 'state');
  if (fs.existsSync(st)) for (const f of fs.readdirSync(st)) fs.rmSync(path.join(st, f), { force: true });
  const r = run(['guard'], proj, JSON.stringify({ cwd: proj, tool_input: { file_path: 'src/nuevo.js' } }));
  assert(r.code === 2, `el guard tendría que bloquear, dio ${r.code}`);
  const t = r.err;
  assert(!tieneStack(t), `filtró un stack:\n${t.slice(-300)}`);
  // Bloquear sin decir cómo desbloquear convierte la herramienta en un obstáculo.
  assert(t.length > 60, `el bloqueo es demasiado escueto: "${t.trim()}"`);
  assert(/tarea|task/i.test(t), 'no menciona que falta una tarea');
  assert(/claim|exempt|clickup-flow|\/tarea/i.test(t), `no dice cómo seguir: "${t.trim().slice(0, 300)}"`);
});

console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
if (fail) {
  for (const f of fallos) console.log(`  - ${f}`);
  console.log(`\nsandbox: ${sandbox}\n`);
  process.exit(1);
}
fs.rmSync(sandbox, { recursive: true, force: true });
console.log('idempotencia y errores: sin hallazgos.\n');

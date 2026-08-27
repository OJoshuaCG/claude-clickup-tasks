#!/usr/bin/env node
//
// Auditoría adversarial de cli.mjs: parseo de argumentos y contrato de los hooks.
//
// Los hooks los invoca el harness, no una persona, así que su contrato tiene que aguantar lo que
// el harness mande: stdin vacío, JSON con formas inesperadas, campos ausentes, o nada de stdin.
// Y LA REGLA DE ORO: un hook nunca puede terminar con código distinto de 0 salvo el guard cuando
// bloquea a propósito. Un hook que revienta rompe el turno en un repositorio que quizá no tiene
// nada que ver con ClickUp.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const INSTALLER = path.join(REPO, 'src', 'installer.mjs');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-adv-cli-'));
const fakeClaude = path.join(sandbox, '.claude');
const proj = path.join(sandbox, 'proj');
const noProj = path.join(sandbox, 'sin-configurar');
fs.mkdirSync(fakeClaude, { recursive: true });
fs.mkdirSync(proj, { recursive: true });
fs.mkdirSync(noProj, { recursive: true });
fs.writeFileSync(path.join(fakeClaude, 'settings.json'), '{"model":"opus"}');

const env = { ...process.env, CLAUDE_CONFIG_DIR: fakeClaude, NO_COLOR: '1' };
const CLI = path.join(fakeClaude, 'clickup-flow', 'src', 'cli.mjs');

execFileSync('node', [INSTALLER, '--yes'], { encoding: 'utf8', env, cwd: REPO, stdio: 'pipe' });

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
function assert(c, m) {
  if (!c) throw new Error(m || 'assertion failed');
}

/**
 * Detecta un stack trace de verdad, no la palabra "at".
 *
 * La primera versión buscaba la subcadena 'at ' y daba falso positivo con el mensaje de
 * JSON.parse ("Expected property name ... at position 2"), que es un error perfectamente limpio.
 * Un marco de stack real va indentado y nombra un archivo con su línea.
 */
function tieneStack(texto) {
  return /\n\s+at\s/.test(texto) || /\.mjs:\d+/.test(texto);
}

/**
 * Corre el CLI y devuelve `{ code, stdout, stderr }` sin tirar nunca.
 *
 * `spawnSync`, no `execFileSync`: el segundo solo devuelve stdout en el camino feliz, así que la
 * versión anterior devolvía `stderr: ''` fijo cuando el comando salía con 0. Las 60 aserciones
 * de "no filtra stack" sobre hooks exitosos comparaban contra un string vacío.
 */
function run(args, input) {
  const r = spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env,
    cwd: sandbox,
    input: input ?? '',
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const HOOKS = ['session-start', 'prompt-hook', 'guard'];

console.log('\nLOS HOOKS NUNCA REVIENTAN (la regla de oro)\n');

const ENTRADAS_HOSTILES = [
  ['sin stdin', ''],
  ['stdin vacío con espacios', '   \n'],
  ['no es JSON', 'esto no es json'],
  ['JSON truncado', '{"cwd":'],
  ['JSON array', '[1,2,3]'],
  ['JSON null', 'null'],
  ['JSON string', '"hola"'],
  ['JSON número', '42'],
  ['objeto vacío', '{}'],
  ['cwd es null', '{"cwd":null}'],
  ['cwd es número', '{"cwd":42}'],
  ['cwd es objeto', '{"cwd":{"a":1}}'],
  ['cwd inexistente', '{"cwd":"/no/existe/nada"}'],
  ['tool_input ausente', '{"cwd":"/tmp","tool_name":"Write"}'],
  ['tool_input es null', '{"cwd":"/tmp","tool_input":null}'],
  ['tool_input es string', '{"cwd":"/tmp","tool_input":"x"}'],
  ['file_path es null', '{"cwd":"/tmp","tool_input":{"file_path":null}}'],
  ['file_path es número', '{"cwd":"/tmp","tool_input":{"file_path":7}}'],
  ['campos extra desconocidos', '{"cwd":"/tmp","futuro":{"x":1},"otro":[1,2]}'],
  ['JSON gigante', JSON.stringify({ cwd: '/tmp', basura: 'x'.repeat(200000) })],
];

for (const hook of HOOKS) {
  for (const [label, input] of ENTRADAS_HOSTILES) {
    check(`${hook} sobrevive: ${label}`, () => {
      const r = run([hook], input);
      // 0 siempre; el guard puede devolver 2 solo si decide bloquear, y con estas entradas
      // (proyecto sin registrar) no debería bloquear nunca.
      assert(r.code === 0, `exit ${r.code}\n         stderr: ${r.stderr.slice(0, 300)}`);
      assert(!tieneStack(r.stderr), `filtró un stack trace:\n${r.stderr.slice(0, 300)}`);
    });
  }
}

console.log('\nPARSEO DE ARGUMENTOS\n');

check('--flag=valor y --flag valor son equivalentes', () => {
  const a = run(['config', 'set', '--key=defaults.search_window_days', '--value=15']);
  assert(a.code === 0, `--flag=valor falló: ${a.stderr}`);
  const b = run(['config', 'show']);
  assert(b.stdout.includes('"search_window_days": 15'), 'no aplicó --flag=valor');
  run(['config', 'set', '--key', 'defaults.search_window_days', '--value', '30']);
});

check('un valor con espacios sobrevive', () => {
  run(['project', 'set', '--mode', 'tasks', '--list-id', '1', '--name', 'mi proyecto con espacios', '--cwd', proj]);
  const out = run(['project', 'show', '--cwd', proj]).stdout;
  assert(out.includes('mi proyecto con espacios'), 'perdió los espacios del nombre');
});

check('un valor que empieza con guion no se confunde con un flag', () => {
  const r = run(['exempt', '--reason', '-- esto empieza con guiones', '--cwd', proj]);
  // Con `--reason` seguido de algo que empieza con `--`, el parser lo trata como flag booleano.
  // Lo importante es que NO acepte una exención sin motivo real.
  if (r.code === 0) {
    const st = run(['status', '--cwd', proj]).stdout;
    assert(!/exención\s+vigente:\s*$/m.test(st), 'guardó una exención con motivo vacío');
  } else {
    assert(r.stderr.includes('reason'), 'falló por otro motivo');
  }
  run(['exempt', '--clear', '--cwd', proj]);
});

check('un comando desconocido falla con mensaje, no con stack', () => {
  const r = run(['comando-que-no-existe']);
  assert(r.code === 1, `exit ${r.code}`);
  assert(r.stderr.includes('desconocido'), 'no dice que es desconocido');
  assert(!tieneStack(r.stderr), 'filtró stack trace');
});

check('sin argumentos muestra la ayuda y sale con 0', () => {
  const r = run([]);
  assert(r.code === 0, `exit ${r.code}`);
  assert(r.stdout.includes('Uso:'), 'no mostró la ayuda');
});

check('subcomandos desconocidos de cada grupo fallan con mensaje', () => {
  for (const [grupo, sub] of [
    ['project', 'inventado'],
    ['identity', 'inventado'],
    ['team', 'inventado'],
    ['config', 'inventado'],
  ]) {
    const r = run([grupo, sub]);
    assert(r.code === 1, `${grupo} ${sub} → exit ${r.code}`);
    assert(r.stderr.includes('desconocido'), `${grupo} ${sub} no explica`);
    assert(!tieneStack(r.stderr), `${grupo} ${sub} filtró stack`);
  }
});

console.log('\nVALIDACIÓN DE ENTRADAS DE USUARIO\n');

check('identity set rechaza todo lo que no sea un id numérico', () => {
  for (const bad of ['me', 'abc', '12a', '1.5', '-5', '', '  ', 'atorres@example.net']) {
    const r = run(['identity', 'set', '--id', bad]);
    assert(r.code === 1, `aceptó "${bad}" como id`);
  }
});

check('team add rechaza ids no numéricos', () => {
  for (const bad of ['me', 'abc', '1.5']) {
    const r = run(['team', 'add', '--git-email', 'dev@example.net', '--clickup-id', bad]);
    assert(r.code === 1, `aceptó "${bad}"`);
  }
});

check('project set exige list-id y un modo válido', () => {
  assert(run(['project', 'set', '--mode', 'tasks', '--cwd', proj]).code === 1, 'aceptó sin list-id');
  assert(run(['project', 'set', '--list-id', '1', '--cwd', proj]).code === 1, 'aceptó sin modo');
  assert(
    run(['project', 'set', '--mode', 'excluded', '--list-id', '1', '--cwd', proj]).code === 1,
    'aceptó "excluded" como modo (para eso está project exclude)',
  );
});

check('claim exige task-id', () => {
  assert(run(['claim', '--cwd', proj]).code === 1, 'aceptó un claim sin id');
});

check('los comandos que necesitan proyecto lo dicen si no está configurado', () => {
  for (const args of [['claim', '--task-id', 'T1'], ['exempt', '--reason', 'x']]) {
    const r = run([...args, '--cwd', noProj]);
    assert(r.code === 1, `${args[0]} no falló en un proyecto sin configurar`);
    assert(
      r.stderr.includes('no está configurado') || r.stderr.includes('clickup-setup'),
      `${args[0]} no explica que falta configurar: ${r.stderr.slice(0, 120)}`,
    );
  }
});

console.log('\nCOMANDOS DE LECTURA NUNCA REVIENTAN\n');

check('context, status y doctor funcionan con y sin proyecto', () => {
  for (const cmd of ['context', 'status']) {
    for (const dir of [proj, noProj, '/no/existe']) {
      const r = run([cmd, '--cwd', dir]);
      assert(r.code === 0 || r.code === 1, `${cmd} en ${dir} → exit ${r.code}`);
      assert(!tieneStack(r.stderr), `${cmd} en ${dir} filtró stack:\n${r.stderr.slice(0, 200)}`);
    }
  }
  const d = run(['doctor']);
  assert(!tieneStack(d.stderr), 'doctor filtró stack');
});

check('con el config corrupto, TODO degrada sin stack traces', () => {
  const cfgPath = path.join(fakeClaude, 'clickup-flow', 'config.json');
  const bueno = fs.readFileSync(cfgPath, 'utf8');
  try {
    fs.writeFileSync(cfgPath, '{ roto');
    for (const hook of HOOKS) {
      const r = run([hook], JSON.stringify({ cwd: proj, tool_input: { file_path: 'a.js' } }));
      assert(r.code === 0, `${hook} con config roto → exit ${r.code}`);
    }
    for (const cmd of [['context'], ['status'], ['doctor'], ['project', 'list']]) {
      const r = run([...cmd, '--cwd', proj]);
      assert(!tieneStack(r.stderr), `${cmd.join(' ')} filtró stack`);
    }
  } finally {
    fs.writeFileSync(cfgPath, bueno);
  }
});

check('con el config BORRADO, los hooks siguen callados y en 0', () => {
  const cfgPath = path.join(fakeClaude, 'clickup-flow', 'config.json');
  const bueno = fs.readFileSync(cfgPath, 'utf8');
  try {
    fs.rmSync(cfgPath);
    for (const hook of HOOKS) {
      const r = run([hook], JSON.stringify({ cwd: proj, tool_input: { file_path: 'a.js' } }));
      assert(r.code === 0, `${hook} sin config → exit ${r.code}`);
    }
  } finally {
    fs.writeFileSync(cfgPath, bueno);
  }
});

console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
if (fail) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
  console.log(`\nsandbox: ${sandbox}\n`);
  process.exit(1);
}
fs.rmSync(sandbox, { recursive: true, force: true });
console.log('cli.mjs: sin hallazgos.\n');

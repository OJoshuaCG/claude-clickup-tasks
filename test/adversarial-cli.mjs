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

check('project set exige list-id la PRIMERA vez, y un modo válido', () => {
  // Directorio virgen: `--list-id` solo es obligatorio cuando el proyecto todavía no tiene lista.
  // En una reconfiguración parcial no hay que repetir lo que ya está guardado.
  const virgen = path.join(sandbox, 'proyecto-virgen');
  fs.mkdirSync(virgen, { recursive: true });

  assert(run(['project', 'set', '--mode', 'tasks', '--cwd', virgen]).code === 1, 'aceptó sin list-id');
  assert(run(['project', 'set', '--list-id', '1', '--cwd', virgen]).code === 1, 'aceptó sin modo');
  assert(
    run(['project', 'set', '--mode', 'excluded', '--list-id', '1', '--cwd', virgen]).code === 1,
    'aceptó "excluded" como modo (para eso está project exclude)',
  );
});

check('una reconfiguración parcial NO borra lo que no se repite', () => {
  // Bug real: el patch incluía todos los campos con `null` donde faltaba el flag, y
  // `{...previo, ...patch}` los borraba. Cambiar el rol vaciaba espacio, carpeta y nombres.
  const p = path.join(sandbox, 'proyecto-parcial');
  fs.mkdirSync(p, { recursive: true });
  run([
    'project', 'set', '--mode', 'tasks', '--list-id', '4000000001', '--list-name', 'Lista Uno',
    '--space-id', '2000000001', '--space-name', 'Espacio Uno', '--folder-id', '3000000001',
    '--cwd', p,
  ]);
  // Segunda pasada: solo el rol.
  const r = run(['project', 'set', '--mode', 'tasks', '--role', 'backend', '--cwd', p]);
  assert(r.code === 0, `la reconfiguración parcial falló: ${r.stderr}`);

  const out = run(['project', 'show', '--cwd', p]).stdout;
  for (const esperado of ['Lista Uno', 'Espacio Uno', '3000000001', '4000000001', '2000000001']) {
    assert(out.includes(esperado), `perdió "${esperado}" al cambiar solo el rol:\n${out}`);
  }
  assert(out.includes('"role": "backend"'), 'no aplicó el rol nuevo');
});

check('--handoff se rechaza explicando que lo reemplazó --role', () => {
  // Ignorar un flag en silencio es peor que fallar: quien lo pasa cree que configuró algo.
  const p = path.join(sandbox, 'proyecto-handoff');
  fs.mkdirSync(p, { recursive: true });
  const r = run(['project', 'set', '--mode', 'tasks', '--list-id', '1', '--handoff', 'true', '--cwd', p]);
  assert(r.code === 1, 'aceptó --handoff en silencio');
  assert(r.stderr.includes('--role'), 'no dice qué usar en su lugar');
  assert(r.stderr.includes('DIRECCIÓN'), 'no explica por qué el booleano no alcanzaba');
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

// ---------------------------------------------------------------------------------------
// `project forget` es el comando MÁS destructivo del CLI: borra la entrada del config y el
// estado del proyecto. Estaba sin un solo test. Un fallo acá no se nota hasta que alguien
// pierde la configuración de otro repositorio.
// ---------------------------------------------------------------------------------------
console.log('\nPROJECT FORGET (borra config y estado)\n');

function runEn(dirTrabajo, args, input) {
  const r = spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env,
    cwd: dirTrabajo,
    input: input ?? '',
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const cfgFile = path.join(fakeClaude, 'clickup-flow', 'config.json');
const leerCfg = () => JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
const escribirCfg = (c) => fs.writeFileSync(cfgFile, JSON.stringify(c, null, 2));

// Dos proyectos hermanos y un subdirectorio, para probar que el borrado no se desborda.
const olvA = path.join(sandbox, 'olvidable-a');
const olvB = path.join(sandbox, 'olvidable-b');
const olvSub = path.join(olvA, 'src', 'api');
fs.mkdirSync(olvSub, { recursive: true });
fs.mkdirSync(olvB, { recursive: true });

// La clave del config la calcula el propio CLI, así que en vez de replicar la normalización
// (y arriesgar que el test pruebe MI copia de la regla en lugar de la de producción) se
// registran los proyectos con `project set` y después se leen las claves que quedaron.
function sembrar() {
  for (const dir of [olvA, olvB]) {
    const r = runEn(dir, ['project', 'set', '--mode', 'tasks', '--list-id', '900', '--role', 'fullstack']);
    assert(r.code === 0, `no pudo sembrar ${dir}: ${r.stderr}`);
  }
  const claves = Object.keys(leerCfg().projects || {});
  const keyA = claves.find((k) => k.endsWith('olvidable-a'));
  const keyB = claves.find((k) => k.endsWith('olvidable-b'));
  assert(keyA && keyB, `las entradas no quedaron registradas: ${claves.join(', ')}`);
  return { keyA, keyB };
}

check('forget en un proyecto que no está registrado falla y no borra nada', () => {
  const { keyA, keyB } = sembrar();
  const antes = Object.keys(leerCfg().projects).length;
  const r = runEn(noProj, ['project', 'forget']);
  assert(r.code === 1, `esperaba exit 1, dio ${r.code}`);
  assert(/no hay entrada exacta/i.test(r.stderr + r.stdout), `no explica el motivo: ${r.stderr}`);
  const despues = leerCfg().projects;
  assert(Object.keys(despues).length === antes, 'borró entradas al fallar');
  assert(despues[keyA] && despues[keyB], 'perdió proyectos ajenos');
});

check('forget borra SOLO la entrada de este proyecto', () => {
  const { keyA, keyB } = sembrar();
  const r = runEn(olvA, ['project', 'forget']);
  assert(r.code === 0, `exit ${r.code}: ${r.stderr}`);
  const p = leerCfg().projects;
  assert(!p[keyA], 'no borró la entrada pedida');
  assert(p[keyB], `borró de más: desapareció ${keyB}`);
});

check('forget desde un subdirectorio NO borra la entrada del ancestro', () => {
  const { keyA } = sembrar();
  const r = runEn(olvSub, ['project', 'forget']);
  assert(r.code === 1, `un subdirectorio pudo borrar el proyecto padre (exit ${r.code})`);
  assert(leerCfg().projects[keyA], 'borró la entrada del ancestro desde un subdirectorio');
});

check('forget borra también el estado (claim) del proyecto', () => {
  sembrar();
  runEn(olvA, ['identity', 'set', '--id', '4242', '--confirm']);
  const c = runEn(olvA, ['claim', '--task-id', 'TAREA-OLV']);
  assert(c.code === 0, `el claim falló, el test no probaría nada: ${c.stderr}`);
  const estados = path.join(fakeClaude, 'clickup-flow', 'state');
  const antes = fs.existsSync(estados) ? fs.readdirSync(estados).length : 0;
  assert(antes > 0, 'el claim no dejó archivo de estado: el test no prueba nada');
  runEn(olvA, ['project', 'forget']);
  const despues = fs.existsSync(estados) ? fs.readdirSync(estados).length : 0;
  assert(despues < antes, `el estado sobrevivió al forget (${antes} -> ${despues})`);
});

check('forget sirve para des-excluir: borra una entrada excluida', () => {
  const { keyA } = sembrar();
  const c = leerCfg();
  c.projects[keyA] = { mode: 'excluded' };
  escribirCfg(c);
  const r = runEn(olvA, ['project', 'forget']);
  assert(r.code === 0, `no pudo borrar una exclusión: ${r.stderr}`);
  assert(!leerCfg().projects[keyA], 'la exclusión sobrevivió');
  assert(/volver a preguntar/i.test(r.stdout), 'no avisa que se va a volver a preguntar');
});

check('forget no toca la identidad ni settings.json', () => {
  sembrar();
  const id = runEn(olvA, ['identity', 'set', '--id', '777', '--confirm']);
  assert(id.code === 0, `identity set falló, el test no probaría nada: ${id.stderr}`);
  const settingsAntes = fs.readFileSync(path.join(fakeClaude, 'settings.json'), 'utf8');
  runEn(olvA, ['project', 'forget']);
  const c = leerCfg();
  assert(
    String(c.identity?.clickup_user_id) === '777',
    `perdió la identidad: ${JSON.stringify(c.identity)}`,
  );
  assert(
    fs.readFileSync(path.join(fakeClaude, 'settings.json'), 'utf8') === settingsAntes,
    'modificó settings.json',
  );
});

// ---------------------------------------------------------------------------------------
// `config path` es el único comando que tiene que responder CON el config roto: es cómo
// alguien encuentra el archivo que tiene que ir a arreglar a mano.
// ---------------------------------------------------------------------------------------
console.log('\nCONFIG PATH (tiene que responder con el config roto)\n');

check('config path imprime una ruta absoluta que existe', () => {
  const r = run(['config', 'path']);
  assert(r.code === 0, `exit ${r.code}: ${r.stderr}`);
  const ruta = r.stdout.trim();
  assert(ruta.length > 0, 'no imprimió nada');
  assert(path.isAbsolute(ruta), `la ruta no es absoluta: ${ruta}`);
  assert(fs.existsSync(ruta), `la ruta impresa no existe: ${ruta}`);
});

check('config path responde igual con el config corrupto', () => {
  const bueno = fs.readFileSync(cfgFile, 'utf8');
  try {
    fs.writeFileSync(cfgFile, '{ esto no es json');
    const r = run(['config', 'path']);
    assert(r.code === 0, `con el config roto dio exit ${r.code}: ${r.stderr}`);
    assert(r.stdout.trim().length > 0, 'no imprimió la ruta con el config roto');
    assert(!tieneStack(r.stdout + r.stderr), 'filtró un stack trace');
  } finally {
    fs.writeFileSync(cfgFile, bueno);
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

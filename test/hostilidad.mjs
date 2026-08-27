#!/usr/bin/env node
//
// Un entorno hostil, en dos frentes.
//
//   1) El sistema de archivos: directorios sin permiso de escritura, rutas relativas, symlinks,
//      nombres con espacios y comillas, rutas profundísimas, un cwd borrado bajo los pies.
//   2) El contrato de los hooks bajo estrés: payloads de megabytes, todos los nombres de
//      herramienta que Claude Code puede mandar, y formas de `tool_input` que nadie previó.
//
// Encontró dos bugs que ningún otro suite veía: el CLI mostraba un stack crudo ante cualquier
// fallo de I/O, y el guard BLOQUEABA editar `CLAUDE.md` cuando la ruta llegaba relativa —
// exactamente lo contrario de lo que la exención de archivos triviales busca.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-fs-'));
const claude = path.join(sandbox, '.claude');
fs.mkdirSync(claude, { recursive: true });
fs.writeFileSync(path.join(claude, 'settings.json'), '{"model":"opus"}');
const env = { ...process.env, CLAUDE_CONFIG_DIR: claude, NO_COLOR: '1' };
execFileSync('node', [path.join(REPO, 'src', 'installer.mjs'), '--yes'], { env, cwd: REPO, stdio: 'pipe' });
const CLI = path.join(claude, 'clickup-flow', 'src', 'cli.mjs');
const CFG = path.join(claude, 'clickup-flow', 'config.json');

let pass = 0;
let fail = 0;
const fallos = [];
const check = (n, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ok   ${n}`);
  } catch (e) {
    fail++;
    fallos.push(`${n}: ${e.message}`);
    console.log(`  FAIL ${n}\n         ${e.message}`);
  }
};
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
function run(cwd, args, input) {
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8', env, cwd, input: input ?? '' });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}
function tieneStack(t) {
  return /\n\s+at .+:\d+:\d+/.test(t);
}
const HOOKS = ['session-start', 'prompt-hook', 'guard'];
const posix = process.platform !== 'win32' && process.getuid?.() !== 0;

console.log('\n=== EL SISTEMA DE ARCHIVOS EN CONTRA ===\n');

check('un directorio de estado sin permiso de escritura no rompe ningún hook', () => {
  if (!posix) return console.log('       (salteado en win32/root)');
  const p = path.join(sandbox, 'sin-estado');
  fs.mkdirSync(p, { recursive: true });
  run(p, ['project', 'set', '--mode', 'tasks', '--list-id', '900', '--role', 'fullstack']);
  const stateDir = path.join(claude, 'clickup-flow', 'state');
  fs.chmodSync(stateDir, 0o500);
  try {
    for (const h of HOOKS) {
      const r = run(p, [h], JSON.stringify({ cwd: p, tool_input: { file_path: 'a.js' } }));
      assert(r.code === 0 || r.code === 2, `${h} → exit ${r.code}: ${r.err.slice(0, 200)}`);
      assert(!tieneStack(r.out + r.err), `${h} filtró un stack: ${(r.out + r.err).slice(-300)}`);
    }
  } finally {
    fs.chmodSync(stateDir, 0o700);
  }
});

check('un config de SÓLO LECTURA: el comando falla con mensaje, no con stack', () => {
  if (!posix) return console.log('       (salteado en win32/root)');
  const p = path.join(sandbox, 'ro');
  fs.mkdirSync(p, { recursive: true });
  const dir = path.dirname(CFG);
  fs.chmodSync(dir, 0o500);
  try {
    const r = run(p, ['project', 'set', '--mode', 'tasks', '--list-id', '900', '--role', 'fullstack']);
    assert(r.code !== 0, 'escribió en un directorio sin permisos');
    assert(!tieneStack(r.out + r.err), `filtró un stack:\n${(r.out + r.err).slice(-400)}`);
    assert((r.err + r.out).trim().length > 0, 'falló en silencio');
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});

check('con el config de sólo lectura los HOOKS siguen callados y en 0', () => {
  if (!posix) return console.log('       (salteado en win32/root)');
  const p = path.join(sandbox, 'ro2');
  fs.mkdirSync(p, { recursive: true });
  const dir = path.dirname(CFG);
  fs.chmodSync(dir, 0o500);
  try {
    for (const h of HOOKS) {
      const r = run(p, [h], JSON.stringify({ cwd: p, tool_input: { file_path: 'a.js' } }));
      assert(r.code === 0, `${h} → exit ${r.code} en un proyecto no registrado: ${r.err.slice(0, 200)}`);
    }
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});

check('un proyecto en un symlink resuelve a la misma entrada', () => {
  if (process.platform === 'win32') return console.log('       (salteado en win32)');
  const real = path.join(sandbox, 'real-proj');
  const link = path.join(sandbox, 'link-proj');
  fs.mkdirSync(real, { recursive: true });
  try {
    fs.symlinkSync(real, link, 'dir');
  } catch {
    return console.log('       (salteado: no se pudo crear el symlink)');
  }
  const a = run(real, ['project', 'set', '--mode', 'tasks', '--list-id', '900', '--role', 'fullstack']);
  assert(a.code === 0, `set falló: ${a.err}`);
  const b = run(link, ['status']);
  assert(b.code === 0, `status desde el symlink falló: ${b.err}`);
  // Lo que NO puede pasar es que el symlink cree una SEGUNDA entrada silenciosa: eso duplica
  // la configuración de un mismo repositorio y el candado deja de proteger de forma coherente.
  const antes = Object.keys(JSON.parse(fs.readFileSync(CFG, 'utf8')).projects).length;
  run(link, ['status']);
  const despues = Object.keys(JSON.parse(fs.readFileSync(CFG, 'utf8')).projects).length;
  assert(despues === antes, `el symlink creó otra entrada (${antes} → ${despues})`);
  console.log(
    `       (nota: symlink resuelto como ${
      JSON.parse(fs.readFileSync(CFG, 'utf8')).projects[
        Object.keys(JSON.parse(fs.readFileSync(CFG, 'utf8')).projects).find((k) => k.includes('proj'))
      ]
        ? 'entrada existente'
        : 'nada'
    })`,
  );
});

check('nombres de directorio con espacios, acentos, comillas y $ no rompen nada', () => {
  const raros = ['con espacio', 'acentué-ñ', "com'illa", 'signo $PATH', 'punto.y.punto', 'a&b'];
  for (const nombre of raros) {
    let p;
    try {
      p = path.join(sandbox, nombre);
      fs.mkdirSync(p, { recursive: true });
    } catch {
      continue; // el sistema de archivos no lo acepta: no es problema de la herramienta
    }
    const s = run(p, ['project', 'set', '--mode', 'tasks', '--list-id', '900', '--role', 'fullstack']);
    assert(s.code === 0, `set falló en "${nombre}": ${s.err.slice(0, 200)}`);
    const st = run(p, ['status']);
    assert(st.code === 0, `status falló en "${nombre}": ${st.err.slice(0, 200)}`);
    const ctx = run(p, ['context']);
    assert(ctx.code === 0, `context falló en "${nombre}": ${ctx.err.slice(0, 200)}`);
    assert(!tieneStack(ctx.out + ctx.err), `stack en "${nombre}"`);
    for (const h of HOOKS) {
      const r = run(p, [h], JSON.stringify({ cwd: p, tool_input: { file_path: 'x.js' } }));
      assert(r.code === 0 || r.code === 2, `${h} en "${nombre}" → exit ${r.code}`);
    }
  }
});

check('una ruta muy profunda no revienta', () => {
  let p = path.join(sandbox, 'profundo');
  for (let i = 0; i < 25; i++) p = path.join(p, `nivel${i}`);
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {
    return console.log('       (salteado: el sistema de archivos no lo permite)');
  }
  const s = run(p, ['project', 'set', '--mode', 'tasks', '--list-id', '900', '--role', 'fullstack']);
  assert(s.code === 0, `set falló: ${s.err.slice(0, 200)}`);
  const st = run(p, ['status']);
  assert(st.code === 0, `status falló: ${st.err.slice(0, 200)}`);
});

check('el directorio de trabajo borrado bajo los pies no cuelga ni revienta', () => {
  const p = path.join(sandbox, 'efimero');
  fs.mkdirSync(p, { recursive: true });
  run(p, ['project', 'set', '--mode', 'tasks', '--list-id', '900', '--role', 'fullstack']);
  // Se invoca el hook diciendo que el cwd es un directorio que ya no existe: es lo que pasa si
  // alguien borra o mueve el repositorio mientras la sesión sigue abierta.
  const fantasma = path.join(sandbox, 'ya-no-existe');
  for (const h of HOOKS) {
    const r = run(sandbox, [h], JSON.stringify({ cwd: fantasma, tool_input: { file_path: 'a.js' } }));
    assert(r.code === 0, `${h} con cwd inexistente → exit ${r.code}: ${r.err.slice(0, 200)}`);
    assert(!tieneStack(r.out + r.err), `${h} filtró un stack`);
  }
});

console.log('\n=== EL CONTRATO DE LOS HOOKS BAJO ESTRÉS ===\n');

const proj = path.join(sandbox, 'estres');
fs.mkdirSync(proj, { recursive: true });
run(proj, ['project', 'set', '--mode', 'tasks', '--list-id', '900', '--role', 'fullstack']);

check('un payload de 5 MB no cuelga ni revienta ningún hook', () => {
  const gigante = JSON.stringify({
    cwd: proj,
    prompt: 'x'.repeat(5 * 1024 * 1024),
    tool_input: { file_path: 'a.js' },
  });
  for (const h of HOOKS) {
    const t0 = Date.now();
    const r = run(proj, [h], gigante);
    const ms = Date.now() - t0;
    assert(r.code === 0 || r.code === 2, `${h} con 5MB → exit ${r.code}`);
    assert(ms < 20000, `${h} tardó ${ms}ms con 5MB`);
    assert(!tieneStack(r.out + r.err), `${h} filtró un stack`);
  }
});

check('el guard aguanta todos los nombres de herramienta que Claude Code puede mandar', () => {
  const tools = [
    'Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Bash', 'Read', 'Glob', 'Grep', 'Task',
    'WebFetch', 'TodoWrite', 'Agent', 'Artifact', 'mcp__x__y', '', null, 123, {}, [],
    'Edit'.repeat(500),
  ];
  for (const t of tools) {
    const r = run(
      proj,
      ['guard'],
      JSON.stringify({ cwd: proj, tool_name: t, tool_input: { file_path: 'src/a.js' } }),
    );
    assert(r.code === 0 || r.code === 2, `tool_name=${JSON.stringify(t)} → exit ${r.code}`);
    assert(!tieneStack(r.out + r.err), `tool_name=${JSON.stringify(t)} filtró un stack`);
  }
});

check('formas de tool_input que nadie previó no rompen el guard', () => {
  const formas = [
    { file_path: null },
    { file_path: 123 },
    { file_path: {} },
    { file_path: [] },
    { file_path: ['a.js', 'b.js'] },
    { path: 'a.js' },
    { edits: [{ file_path: 'a.js' }] },
    { notebook_path: 'a.ipynb' },
    { command: 'rm -rf /' },
    {},
    null,
    [],
    'texto',
    42,
    true,
  ];
  for (const ti of formas) {
    const r = run(proj, ['guard'], JSON.stringify({ cwd: proj, tool_name: 'Edit', tool_input: ti }));
    assert(r.code === 0 || r.code === 2, `tool_input=${JSON.stringify(ti)} → exit ${r.code}`);
    assert(!tieneStack(r.out + r.err), `tool_input=${JSON.stringify(ti)} filtró un stack`);
  }
});

check('100 invocaciones seguidas del guard: sin fugas ni degradación', () => {
  const t0 = Date.now();
  for (let i = 0; i < 100; i++) {
    const r = run(proj, ['guard'], JSON.stringify({ cwd: proj, tool_input: { file_path: `f${i}.js` } }));
    assert(r.code === 0 || r.code === 2, `iteración ${i} → exit ${r.code}`);
  }
  const ms = Date.now() - t0;
  console.log(`       100 invocaciones en ${ms}ms (${Math.round(ms / 100)}ms cada una)`);
  const dir = path.join(claude, 'clickup-flow', 'state');
  const n = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  assert(n < 50, `el estado creció a ${n} archivos con 100 invocaciones del guard`);
});

check('stdin cerrado sin datos, y stdin con basura binaria', () => {
  // El guard puede salir con 2 acá y está BIEN: sin payload cae a process.cwd(), que es un
  // proyecto registrado sin tarea reclamada, y el candado tiene que cerrarse. Lo que se exige es
  // que nunca revienta y que, si bloquea, lo explique.
  for (const h of HOOKS) {
    const a = run(proj, [h], '');
    const permitido = h === 'guard' ? [0, 2] : [0];
    assert(permitido.includes(a.code), `${h} con stdin vacío → exit ${a.code}: ${a.err.slice(0,200)}`);
    if (a.code === 2) assert(a.err.trim().length > 30, `el guard bloqueó sin explicar: ${a.err}`);
    const b = run(proj, [h], Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x7f]).toString('binary'));
    assert(permitido.includes(b.code), `${h} con basura binaria → exit ${b.code}: ${b.err.slice(0, 200)}`);
    assert(!tieneStack(a.out + a.err + b.out + b.err), `${h} filtró un stack`);
  }
});

check('un hook nunca escribe en stdout algo que no sea para el agente', () => {
  // El guard bloquea por stderr con exit 2; session-start y prompt-hook inyectan contexto por
  // stdout. Lo que no puede pasar es que el guard escupa ruido por stdout cuando NO bloquea.
  // Con ruta RELATIVA, que es el caso que estaba roto: isTrivialTarget exigía un separador
  // delante y 'CLAUDE.md' nunca matcheaba, así que el guard bloqueaba editar el archivo que
  // configura la propia herramienta.
  for (const f of ['CLAUDE.md', path.join(proj, 'CLAUDE.md'), '.gitignore', '.claude/settings.json']) {
    const t = run(proj, ['guard'], JSON.stringify({ cwd: proj, tool_input: { file_path: f } }));
    assert(t.code === 0, `el guard bloqueó ${f} (exit ${t.code}): ${t.err.slice(0, 200)}`);
    assert(t.out.trim() === '', `el guard escribió en stdout sin bloquear con ${f}: ${JSON.stringify(t.out)}`);
  }
  const bloqueado = run(proj, ['guard'], JSON.stringify({ cwd: proj, tool_input: { file_path: 'MI-CLAUDE.md' } }));
  assert(bloqueado.code === 2, `MI-CLAUDE.md tendría que bloquear, dio ${bloqueado.code}`);
  const r = run(proj, ['guard'], JSON.stringify({ cwd: proj, tool_input: { file_path: 'CLAUDE.md' } }));
  assert(r.code === 0, `esperaba fail-open en CLAUDE.md, dio ${r.code}`);
  assert(r.out.trim() === '', `el guard escribió en stdout sin bloquear: ${JSON.stringify(r.out)}`);
});

console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
if (fail) {
  for (const f of fallos) console.log(`  - ${f}`);
  console.log(`\nsandbox: ${sandbox}\n`);
  process.exit(1);
}
fs.rmSync(sandbox, { recursive: true, force: true });
console.log('hostilidad: sin hallazgos.\n');

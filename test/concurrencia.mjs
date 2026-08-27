#!/usr/bin/env node
//
// Concurrencia real. Dos (o veinte) procesos escribiendo el mismo config y el mismo estado al
// mismo tiempo. Lo que se busca: un config truncado, un JSON a medio escribir, una entrada
// perdida, o un proceso que revienta porque el archivo cambió bajo sus pies.
//
// Este suite nació encontrando un bug: 12 de 20 registros simultáneos de proyectos DISTINTOS se
// perdían. El rename atómico evitaba el archivo truncado, pero no el lost update — dos sesiones
// de Claude Code leían el mismo config, cada una agregaba su proyecto, y el último rename
// borraba el trabajo de la otra. Por eso vive acá y no en un directorio temporal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-conc-'));
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
const check = (n, fn) =>
  fn()
    .then(() => {
      pass++;
      console.log(`  ok   ${n}`);
    })
    .catch((e) => {
      fail++;
      fallos.push(`${n}: ${e.message}`);
      console.log(`  FAIL ${n}\n         ${e.message}`);
    });
const assert = (c, m) => {
  if (!c) throw new Error(m);
};

function correr(cwd, args) {
  return new Promise((resolve) => {
    const p = spawn('node', [CLI, ...args], { cwd, env });
    let out = '';
    let errOut = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (errOut += d));
    p.on('close', (code) => resolve({ code, out, errOut }));
  });
}

const leerCfg = () => {
  const raw = fs.readFileSync(CFG, 'utf8');
  try {
    return { ok: true, cfg: JSON.parse(raw), raw };
  } catch (e) {
    return { ok: false, error: e.message, raw };
  }
};

console.log('\nCONCURRENCIA\n');

await check('20 registros simultáneos de proyectos DISTINTOS: el config queda válido', async () => {
  const dirs = [];
  for (let i = 0; i < 20; i++) {
    const d = path.join(sandbox, `p${i}`);
    fs.mkdirSync(d, { recursive: true });
    dirs.push(d);
  }
  const res = await Promise.all(
    dirs.map((d) => correr(d, ['project', 'set', '--mode', 'tasks', '--list-id', '900', '--role', 'fullstack'])),
  );
  const rotos = res.filter((r) => r.code !== 0);
  assert(rotos.length === 0, `${rotos.length}/20 procesos fallaron: ${rotos[0]?.errOut?.slice(0, 200)}`);

  const { ok, cfg, error, raw } = leerCfg();
  assert(ok, `el config quedó ILEGIBLE: ${error}\n  primeros bytes: ${raw.slice(0, 120)}`);
  assert(cfg.projects && typeof cfg.projects === 'object', 'perdió la sección projects');
  const registrados = Object.keys(cfg.projects).length;
  // Esta es la afirmación honesta: con escritura atómica sin lock, el último gana.
  // El test NO exige 20; exige que el archivo sea válido y que no se pierda TODO.
  console.log(`         registrados: ${registrados}/20`);
  assert(registrados >= 1, 'no quedó ninguno');
  if (registrados < 20) {
    throw new Error(
      `PÉRDIDA POR CARRERA: solo ${registrados}/20 quedaron. Escritura atómica sin ` +
        `read-modify-write bajo lock: dos procesos leen el mismo config y el último sobreescribe.`,
    );
  }
});

await check('el config nunca queda a medio escribir (100 lecturas durante escrituras)', async () => {
  const d = path.join(sandbox, 'ruido');
  fs.mkdirSync(d, { recursive: true });
  let truncados = 0;
  let leidos = 0;
  let parar = false;
  const lector = (async () => {
    while (!parar) {
      leidos++;
      const r = leerCfg();
      if (!r.ok) {
        truncados++;
        console.log(`         ILEGIBLE en la lectura ${leidos}: ${r.error}`);
      }
      await new Promise((r2) => setTimeout(r2, 1));
    }
  })();
  const escritores = [];
  for (let i = 0; i < 12; i++) {
    escritores.push(correr(d, ['config', 'set', '--search-window-days', String(10 + i)]));
  }
  await Promise.all(escritores);
  parar = true;
  await lector;
  assert(leidos > 5, `el lector apenas corrió (${leidos} lecturas): el test no prueba nada`);
  assert(truncados === 0, `${truncados} de ${leidos} lecturas vieron un config a medio escribir`);
});

await check('claims simultáneos en el MISMO proyecto: el estado queda válido', async () => {
  const d = path.join(sandbox, 'colision');
  fs.mkdirSync(d, { recursive: true });
  await correr(d, ['project', 'set', '--mode', 'tasks', '--list-id', '900', '--role', 'fullstack']);
  const res = await Promise.all(
    Array.from({ length: 8 }, (_, i) => correr(d, ['claim', '--task-id', `T-${i}`, '--force'])),
  );
  const rotos = res.filter((r) => r.code !== 0);
  assert(rotos.length === 0, `${rotos.length}/8 claims fallaron: ${rotos[0]?.errOut?.slice(0, 200)}`);
  const dir = path.join(claude, 'clickup-flow', 'state');
  const archivos = fs.readdirSync(dir);
  for (const f of archivos) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    try {
      JSON.parse(raw);
    } catch (e) {
      throw new Error(`estado ilegible en ${f}: ${e.message} — bytes: ${raw.slice(0, 80)}`);
    }
  }
  const st = await correr(d, ['status']);
  assert(st.code === 0, `status revienta después de la colisión: ${st.errOut}`);
});

await check('dos instaladores a la vez no se pisan', async () => {
  const c2 = path.join(sandbox, '.claude2');
  fs.mkdirSync(c2, { recursive: true });
  fs.writeFileSync(path.join(c2, 'settings.json'), '{"model":"opus"}');
  const env2 = { ...process.env, CLAUDE_CONFIG_DIR: c2, NO_COLOR: '1' };
  const uno = new Promise((res) => {
    const p = spawn('node', [path.join(REPO, 'src', 'installer.mjs'), '--yes'], { cwd: REPO, env: env2 });
    let e = '';
    p.stderr.on('data', (d) => (e += d));
    p.on('close', (code) => res({ code, e }));
  });
  const dos = new Promise((res) => {
    const p = spawn('node', [path.join(REPO, 'src', 'installer.mjs'), '--yes'], { cwd: REPO, env: env2 });
    let e = '';
    p.stderr.on('data', (d) => (e += d));
    p.on('close', (code) => res({ code, e }));
  });
  const [a, b] = await Promise.all([uno, dos]);
  assert(a.code === 0 && b.code === 0, `instaladores simultáneos: ${a.code}/${b.code} — ${a.e || b.e}`);
  const cli2 = path.join(c2, 'clickup-flow', 'src', 'cli.mjs');
  assert(fs.existsSync(cli2), 'el CLI no quedó instalado');
  const s = JSON.parse(fs.readFileSync(path.join(c2, 'settings.json'), 'utf8'));
  const hooks = JSON.stringify(s.hooks || {});
  const veces = (hooks.match(/cli\.mjs/g) || []).length;
  assert(veces === 3, `los hooks quedaron duplicados: ${veces} referencias al CLI (esperaba 3)`);
});

console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
if (fail) {
  for (const f of fallos) console.log(`  - ${f}`);
  console.log(`\nsandbox: ${sandbox}\n`);
  process.exit(1);
}
fs.rmSync(sandbox, { recursive: true, force: true });
console.log('concurrencia: sin hallazgos.\n');

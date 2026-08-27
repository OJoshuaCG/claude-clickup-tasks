#!/usr/bin/env node
//
// Auditoría adversarial de migrate.mjs: detección del protocolo viejo.
//
// Este módulo escanea repositorios ajenos y NO borra nada, así que lo que hay que probar es que
// tolere cualquier cosa que encuentre — carpetas inexistentes, JSON corrupto, rutas inválidas — y
// que al importar el mapeo del equipo no promueva un mapeo deducido a confirmado ni elija por su
// cuenta en un conflicto de ids.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-adv-migr-'));

const MIG = await import('../src/lib/migrate.mjs');
const C = await import('../src/lib/config.mjs');

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

console.log('\nmigrate.mjs — escaneo\n');

check('escanear una carpeta inexistente no explota', () => {
  const f = MIG.scanProject('/no/existe/en/ningun/lado');
  assert(Array.isArray(f), 'no devolvió array');
});

check('escanear con cwd raro no explota', () => {
  for (const d of ['', '/', '.', null, undefined]) {
    const f = MIG.scanProject(d);
    assert(Array.isArray(f), `falló con ${JSON.stringify(d)}`);
  }
});

check('importUsers ignora claves de nota y valores inválidos', () => {
  const cfg = C.defaultConfig();
  const { added, skipped } = MIG.importUsers(cfg, {
    _lee_esto: ['una nota'],
    _otra_nota: 'x',
    'valido@example.net': { clickup_id: '123', nombre: 'V', confirmado: true },
    'sin-id@example.net': { nombre: 'Sin id' },
    'id-no-numerico@example.net': { clickup_id: 'me' },
    'id-vacio@example.net': { clickup_id: '' },
  });
  assert(added.length === 1, `importó ${added.length} en vez de 1`);
  assert(added[0].gitEmail === 'valido@example.net', 'importó el equivocado');
  assert(skipped.length === 3, `salteó ${skipped.length} en vez de 3`);
  assert(!('_lee_esto' in cfg.team), 'importó una nota como usuario');
});

check('importUsers con entrada nula o rara no explota', () => {
  for (const u of [null, undefined, {}, [], 'x', 42]) {
    const cfg = C.defaultConfig();
    const r = MIG.importUsers(cfg, u);
    assert(Array.isArray(r.added), `falló con ${JSON.stringify(u)}`);
  }
});

check('un `usuarios` que es ARRAY no produce entradas llamadas "0" y "1"', () => {
  // `typeof [] === 'object'`, así que sin la guardia de Array un `usuarios: [{...}]` recorría el
  // array con `Object.entries` y creaba entradas de equipo con clave "0", "1"… en vez de por
  // email. Un test de mutación mostró que nada lo vigilaba: este caso no estaba cubierto.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-usr-array-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude', 'clickup-usuarios.json'),
    JSON.stringify({
      usuarios: [
        { clickup_id: '111', nombre: 'Uno' },
        { clickup_id: '222', nombre: 'Dos' },
      ],
    }),
  );

  const hallazgos = MIG.scanProject(dir);
  const entrada = hallazgos.find((f) => f.severity === 'import');
  assert(entrada, 'no detectó el archivo de usuarios');
  assert(entrada.users === null, `un array se aceptó como mapa de usuarios: ${JSON.stringify(entrada.users)}`);

  // Y si de todos modos llegara al importador, no puede crear claves numéricas.
  const cfg = C.defaultConfig();
  MIG.importUsers(cfg, [
    { clickup_id: '111', nombre: 'Uno' },
    { clickup_id: '222', nombre: 'Dos' },
  ]);
  for (const clave of Object.keys(cfg.team)) {
    assert(!/^\d+$/.test(clave), `creó una entrada de equipo con clave numérica: "${clave}"`);
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

check('importUsers NO promueve un mapeo a confirmado', () => {
  const cfg = C.defaultConfig();
  cfg.team['dev@example.net'] = { clickup_id: '123', confirmed: false, note: 'deducido' };
  MIG.importUsers(cfg, { 'dev@example.net': { clickup_id: '123', confirmado: true } });
  assert(cfg.team['dev@example.net'].confirmed === false, 'promovió a confirmado en silencio');
});

check('importUsers reporta un conflicto de id en vez de elegir', () => {
  const cfg = C.defaultConfig();
  cfg.team['dev@example.net'] = { clickup_id: '111', confirmed: true };
  const { added, conflicts } = MIG.importUsers(cfg, { 'dev@example.net': { clickup_id: '999' } });
  assert(conflicts.length === 1, `conflictos: ${conflicts.length}`);
  assert(added.length === 0, 'importó pese al conflicto');
  assert(cfg.team['dev@example.net'].clickup_id === '111', 'pisó el id existente');
});


console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
if (fail) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
  console.log(`\nsandbox: ${process.env.CLAUDE_CONFIG_DIR}\n`);
  process.exit(1);
}
fs.rmSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
console.log('migrate.mjs: sin hallazgos.\n');

#!/usr/bin/env node
//
// Auditoría adversarial de settings.mjs.
//
// Este módulo edita `~/.claude/settings.json`, que es un archivo del USUARIO. Es el que más daño
// puede hacer, así que se ataca con formas inválidas en cada nivel del árbol: `hooks` que no es un
// objeto, un evento que no es un array, un grupo sin `hooks`, `permissions.allow` que es un
// string, nulls sembrados por todas partes.
//
// La propiedad que hay que probar no es "funciona con entrada válida" — eso ya está cubierto.
// Es: **con entrada inválida, no borra nada y no explota**.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-adv-set-'));

const {
  readSettings,
  writeSettings,
  installHooks,
  removeHooks,
  mergePermissions,
  unmergePermissions,
  inspectInstalled,
  hookSpecs,
  HOOK_COUNT,
  HOOK_MARKER,
} = await import('../src/lib/settings.mjs');
const { settingsPath } = await import('../src/lib/paths.mjs');

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

const CLI = '/home/x/.claude/clickup-flow/src/cli.mjs';
const write = (obj) =>
  fs.writeFileSync(settingsPath(), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
const ours = (s) =>
  inspectInstalled(s).length;

console.log('\nFORMAS INVÁLIDAS DE hooks\n');

const MALFORMED = [
  ['hooks es null', { hooks: null, model: 'opus' }],
  ['hooks es un string', { hooks: 'nada', model: 'opus' }],
  ['hooks es un array', { hooks: [], model: 'opus' }],
  ['hooks es un número', { hooks: 42, model: 'opus' }],
  ['un evento es null', { hooks: { PreToolUse: null }, model: 'opus' }],
  ['un evento es un objeto', { hooks: { PreToolUse: { a: 1 } }, model: 'opus' }],
  ['un evento es un string', { hooks: { PreToolUse: 'x' }, model: 'opus' }],
  ['un grupo es null', { hooks: { PreToolUse: [null] }, model: 'opus' }],
  ['un grupo no tiene hooks', { hooks: { PreToolUse: [{ matcher: 'x' }] }, model: 'opus' }],
  ['group.hooks es null', { hooks: { PreToolUse: [{ hooks: null }] }, model: 'opus' }],
  ['group.hooks es un objeto', { hooks: { PreToolUse: [{ hooks: {} }] }, model: 'opus' }],
  ['un hook es null', { hooks: { PreToolUse: [{ hooks: [null] }] }, model: 'opus' }],
  ['un hook sin command', { hooks: { PreToolUse: [{ hooks: [{ type: 'command' }] }] }, model: 'opus' }],
  ['command no es string', { hooks: { PreToolUse: [{ hooks: [{ command: 42 }] }] }, model: 'opus' }],
];

for (const [label, obj] of MALFORMED) {
  check(`installHooks sobrevive: ${label}`, () => {
    write(obj);
    const { settings, error } = readSettings();
    assert(!error, `readSettings falló: ${error}`);
    const added = installHooks(settings, CLI);
    assert(added.length === HOOK_COUNT, `registró ${added.length} en vez de ${HOOK_COUNT}`);
    assert(ours(settings) === HOOK_COUNT, `inspectInstalled ve ${ours(settings)}`);
    // La clave del usuario tiene que seguir ahí.
    assert(settings.model === 'opus', 'perdió una clave del usuario');
    writeSettings(settings);
    // Y el resultado tiene que ser JSON válido y releíble.
    const re = readSettings();
    assert(!re.error, `el resultado no se puede releer: ${re.error}`);
  });

  check(`removeHooks sobrevive: ${label}`, () => {
    const { settings } = readSettings();
    const removed = removeHooks(settings);
    assert(removed === 3, `quitó ${removed} en vez de 3`);
    assert(ours(settings) === 0, 'quedaron hooks nuestros');
    assert(settings.model === 'opus', 'perdió una clave del usuario');
  });
}

console.log('\nFORMAS INVÁLIDAS DE permissions\n');

const PERM_MALFORMED = [
  ['permissions es null', { permissions: null }],
  ['permissions es un array', { permissions: [] }],
  ['permissions es un string', { permissions: 'x' }],
  ['allow es null', { permissions: { allow: null } }],
  ['allow es un string', { permissions: { allow: 'mcp__mio__*' } }],
  ['allow es un objeto', { permissions: { allow: { a: 1 } } }],
  ['allow tiene nulls', { permissions: { allow: [null, 'mcp__mio__*', null] } }],
  ['allow tiene números', { permissions: { allow: [1, 2, 'mcp__mio__*'] } }],
];

for (const [label, obj] of PERM_MALFORMED) {
  check(`mergePermissions sobrevive: ${label}`, () => {
    write({ ...obj, model: 'opus' });
    const { settings, error } = readSettings();
    assert(!error, `readSettings falló: ${error}`);
    mergePermissions(settings);
    assert(Array.isArray(settings.permissions.allow), 'allow no quedó como array');
    assert(
      settings.permissions.allow.includes('mcp__claude_ai_ClickUp__clickup_filter_tasks'),
      'no agregó los permisos',
    );
    assert(settings.model === 'opus', 'perdió una clave del usuario');
    writeSettings(settings);
    assert(!readSettings().error, 'el resultado no se puede releer');
  });
}

check('un allow que era string no pierde su valor original', () => {
  write({ permissions: { allow: 'mcp__mio__*' }, model: 'opus' });
  const { settings } = readSettings();
  mergePermissions(settings);
  // El valor original era un string, no un array. Convertirlo NO puede tirarlo a la basura.
  const flat = JSON.stringify(settings.permissions);
  assert(flat.includes('mcp__mio__*'), `perdió el allow original: ${flat}`);
});

check('unmergePermissions no toca los permisos del usuario', () => {
  write({ permissions: { allow: ['mcp__mio__*', 'Bash(ls)'], deny: ['Read(.env)'] } });
  const { settings } = readSettings();
  mergePermissions(settings);
  const n = unmergePermissions(settings);
  assert(n === 11, `quitó ${n} en vez de 11`);
  assert(settings.permissions.allow.includes('mcp__mio__*'), 'perdió un allow del usuario');
  assert(settings.permissions.allow.includes('Bash(ls)'), 'perdió otro allow del usuario');
  assert(settings.permissions.deny.includes('Read(.env)'), 'perdió un deny del usuario');
  assert(settings.permissions.allow.length === 2, `quedaron ${settings.permissions.allow.length}`);
});

check('un wildcard de ClickUp ya presente evita agregar los 11', () => {
  write({ permissions: { allow: ['mcp__claude_ai_ClickUp__*'] } });
  const { settings } = readSettings();
  const added = mergePermissions(settings);
  assert(added.length === 0, `agregó ${added.length} pese al wildcard`);
  assert(settings.permissions.allow.length === 1, 'modificó la lista');
});

console.log('\nJSON QUE NO SE PUEDE PARSEAR\n');

const BAD_JSON = [
  ['vacío', ''],
  ['solo espacios', '   \n  '],
  ['truncado', '{ "model": "opus"'],
  ['coma final', '{ "model": "opus", }'],
  ['no es objeto: array', '[1,2,3]'],
  ['no es objeto: string', '"hola"'],
  ['no es objeto: número', '42'],
  ['no es objeto: null', 'null'],
  ['comentarios (no es JSON)', '{ // nota\n "model": "opus" }'],
];

for (const [label, raw] of BAD_JSON) {
  check(`readSettings reporta el error sin explotar: ${label}`, () => {
    write(raw);
    const { settings, error } = readSettings();
    if (label === 'vacío' || label === 'solo espacios') {
      // Un archivo vacío es tratable como "sin configuración", no como error.
      assert(!error, `un archivo vacío no debería ser error: ${error}`);
      assert(settings && typeof settings === 'object', 'no devolvió objeto');
    } else {
      assert(error, 'no reportó error');
      assert(settings === null, 'devolvió settings pese al error');
    }
  });
}

console.log('\nBOM Y CODIFICACIÓN\n');

check('un settings.json con BOM se lee', () => {
  // Windows y algunos editores escriben BOM. Si eso rompe la lectura, el instalador aborta
  // diciendo "settings.json inválido" en una máquina donde el archivo está perfecto.
  fs.writeFileSync(settingsPath(), `\uFEFF${JSON.stringify({ model: 'opus' })}`, 'utf8');
  const { settings, error } = readSettings();
  assert(!error, `el BOM rompió la lectura: ${error}`);
  assert(settings.model === 'opus', 'no leyó el contenido');
});

check('contenido unicode sobrevive el round-trip', () => {
  write({ model: 'opus', nota: 'ñ á é í — ✔ 中文 🎯' });
  const { settings } = readSettings();
  installHooks(settings, CLI);
  writeSettings(settings);
  const re = readSettings();
  assert(re.settings.nota === 'ñ á é í — ✔ 中文 🎯', `se corrompió: ${re.settings.nota}`);
});

console.log('\nIDEMPOTENCIA Y FALSOS POSITIVOS\n');

check('installHooks diez veces seguidas deja exactamente 3', () => {
  write({ model: 'opus' });
  const { settings } = readSettings();
  for (let i = 0; i < 10; i++) installHooks(settings, CLI);
  assert(ours(settings) === HOOK_COUNT, `quedaron ${ours(settings)} hooks`);
});

check('removeHooks no borra un hook del usuario que solo se parece', () => {
  // Un hook del usuario que menciona "clickup" pero NO es nuestro marcador exacto.
  write({
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: 'mi-script-clickup-flow.sh' }] },
        { hooks: [{ type: 'command', command: 'echo clickup-flow' }] },
        { hooks: [{ type: 'command', command: 'node /otro/lugar/cli.mjs prompt-hook' }] },
      ],
    },
  });
  const { settings } = readSettings();
  installHooks(settings, CLI);
  removeHooks(settings);
  const flat = JSON.stringify(settings.hooks ?? {});
  assert(flat.includes('mi-script-clickup-flow.sh'), 'borró un script del usuario');
  assert(flat.includes('echo clickup-flow'), 'borró un echo del usuario');
  assert(flat.includes('/otro/lugar/cli.mjs'), 'borró un cli.mjs ajeno');
  assert(ours(settings) === 0, 'no quitó los nuestros');
});

check('removeHooks conserva un grupo vacío que ya estaba vacío', () => {
  // `PreToolUse: []` es del usuario. Si lo borramos, cambiamos su archivo sin motivo.
  write({ hooks: { PreToolUse: [], SessionStart: [] } });
  const { settings } = readSettings();
  removeHooks(settings);
  // Sin nada nuestro que quitar, los eventos vacíos del usuario se conservan tal cual estaban.
  assert('PreToolUse' in (settings.hooks ?? {}), 'borró un evento vacío del usuario');
});

check('el marcador coincide con lo que instalHooks escribe', () => {
  const specs = hookSpecs(CLI);
  for (const s of specs) {
    assert(s.command.includes(HOOK_MARKER), `el comando no lleva el marcador: ${s.command}`);
  }
});

check('un cliPath con espacios queda entrecomillado', () => {
  const specs = hookSpecs('C:/Program Files/x/clickup-flow/src/cli.mjs');
  for (const s of specs) {
    assert(/^node "/.test(s.command), `sin comillas: ${s.command}`);
    assert(s.command.includes('Program Files'), 'perdió la ruta');
  }
});

check('un cliPath con backslashes se normaliza a forward slash', () => {
  const specs = hookSpecs('C:\\Users\\x\\.claude\\clickup-flow\\src\\cli.mjs');
  for (const s of specs) {
    assert(!s.command.includes('\\'), `quedó un backslash: ${s.command}`);
  }
});

console.log('\nESCRITURA\n');

check('writeSettings deja JSON con salto de línea final', () => {
  write({ model: 'opus' });
  const { settings } = readSettings();
  writeSettings(settings);
  const raw = fs.readFileSync(settingsPath(), 'utf8');
  assert(raw.endsWith('\n'), 'sin newline final (ensucia los diffs de git)');
  assert(!raw.includes('\r\n'), 'metió CRLF');
});

check('writeSettings no deja archivos .tmp huérfanos', () => {
  const dir = path.dirname(settingsPath());
  write({ model: 'opus' });
  const { settings } = readSettings();
  for (let i = 0; i < 5; i++) writeSettings(settings);
  const tmps = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
  assert(tmps.length === 0, `quedaron ${tmps.length} archivos temporales: ${tmps}`);
});

console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
if (fail) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
  console.log(`\nsandbox: ${process.env.CLAUDE_CONFIG_DIR}\n`);
  process.exit(1);
}
fs.rmSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
console.log('settings.mjs: sin hallazgos.\n');

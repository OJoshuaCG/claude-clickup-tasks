#!/usr/bin/env node
//
// Auditoría adversarial de protocol.mjs y tui.mjs: el texto que lee el agente.
//
// protocol.mjs genera las instrucciones que el agente sigue para tocar un tablero compartido.
// Un render a medias no da una excepción visible: da un protocolo con huecos que el agente
// completa inventando. Por eso lo que se prueba acá es que NUNCA filtre `undefined`, `NaN` ni
// `[object Object]`, y que las reglas que no se negocian —prohibir `"me"`, fallar cerrado si
// ClickUp no responde— sobrevivan a cualquier combinación de flags.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-adv-proto-'));

const PR = await import('../src/lib/protocol.mjs');
const TUI = await import('../src/lib/tui.mjs');
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

console.log('\ntui.mjs — cajas y wrapping\n');

check('softWrap no pierde palabras', () => {
  const texto = 'una frase larga con varias palabras que hay que cortar en varias lineas';
  for (const ancho of [10, 20, 40, 200]) {
    const lineas = TUI.softWrap(texto, ancho);
    const reconstruido = lineas.join(' ');
    assert(reconstruido === texto, `se perdió texto con ancho ${ancho}: "${reconstruido}"`);
  }
});

check('softWrap con una palabra más larga que el ancho no entra en bucle', () => {
  const lineas = TUI.softWrap('palabrasuperlargasinespacios', 5);
  assert(lineas.length >= 1, 'no devolvió nada');
  assert(lineas.join('').includes('palabrasuperlarga'), 'perdió la palabra');
});

check('softWrap con vacío devuelve una línea vacía, no un array vacío', () => {
  assert(TUI.softWrap('', 10).length === 1, 'devolvió array vacío');
});

check('las cajas alinean con acentos y emoji', () => {
  // Con colores apagados (NO_COLOR en el suite) el ancho visible es el largo del string.
  const lineas = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => {
    lineas.push(String(s).replace(/\n$/, ''));
    return true;
  };
  try {
    TUI.box('Título con ñ', ['línea con á é í ó ú', 'otra corta']);
  } finally {
    process.stdout.write = original;
  }
  const anchos = [...new Set(lineas.map((l) => [...l].length))];
  assert(anchos.length === 1, `las líneas de la caja no miden igual: ${JSON.stringify(anchos)}`);
});

console.log('\nprotocol.mjs — renderizado con configuración hostil\n');

function ctxFor(entry, defaults = {}) {
  const cfg = C.defaultConfig();
  Object.assign(cfg.defaults, defaults);
  cfg.identity.clickup_user_id = '5000000001';
  cfg.identity.confirmed = true;
  const key = '/tmp/adv-proj';
  cfg.projects[key] = { path: key, name: 'adv', ...entry };
  return PR.buildContext(cfg, key);
}

check('renderiza sin explotar con campos faltantes', () => {
  const casos = [
    { mode: 'tasks' },
    { mode: 'tasks', list_id: null },
    { mode: 'umbrella' },
    { mode: 'umbrella', umbrella_task_id: null, list_id: null },
    { mode: 'tasks', space_name: null, folder_id: null },
    { mode: 'tasks', handoff: true, naming: 'prefixed' },
  ];
  for (const c of casos) {
    const out = PR.renderContext(ctxFor(c));
    assert(typeof out === 'string' && out.length > 500, `render pobre con ${JSON.stringify(c)}`);
    assert(!out.includes('undefined'), `filtró "undefined" con ${JSON.stringify(c)}`);
    assert(!out.includes('[object Object]'), `filtró "[object Object]" con ${JSON.stringify(c)}`);
  }
});

check('un modo desconocido no produce un protocolo a medias', () => {
  const out = PR.renderContext(ctxFor({ mode: 'inventado', list_id: '1' }));
  assert(!out.includes('undefined'), 'filtró undefined');
  assert(out.length > 500, 'render demasiado corto');
});

check('nunca filtra "undefined" ni NaN con defaults raros', () => {
  for (const d of [
    { search_window_days: NaN },
    { search_window_days: null },
    { search_window_days: -1 },
    { end_date_field: null },
    { end_date_field: 'inventado' },
    { use_dates: null },
  ]) {
    const out = PR.renderContext(ctxFor({ mode: 'tasks', list_id: '1' }, d));
    assert(!out.includes('undefined'), `undefined con ${JSON.stringify(d)}`);
    assert(!out.includes('NaN'), `NaN con ${JSON.stringify(d)}`);
  }
});

check('el protocolo SIEMPRE prohíbe "me", en cualquier configuración', () => {
  // Es la regla que no puede desaparecer por una combinación de flags.
  for (const d of [{ auto_assign: false }, { use_dates: false }, { use_priorities: false }]) {
    const out = PR.renderContext(ctxFor({ mode: 'tasks', list_id: '1' }, d));
    assert(out.includes('"me"'), `no menciona "me" con ${JSON.stringify(d)}`);
  }
});

check('el protocolo SIEMPRE manda fallar cerrado si ClickUp no responde', () => {
  for (const d of [{ use_dates: false }, { use_priorities: false }, { auto_assign: false }]) {
    const out = PR.renderContext(ctxFor({ mode: 'tasks', list_id: '1' }, d));
    assert(out.includes('se PARA'), `falta la regla de fallo cerrado con ${JSON.stringify(d)}`);
  }
});

check('un proyecto sin registrar produce el texto de "no configurado"', () => {
  const cfg = C.defaultConfig();
  const out = PR.renderContext(PR.buildContext(cfg, '/tmp/no-registrado'));
  assert(out.includes('no está configurado'), 'no avisa que falta configurar');
  assert(out.includes('/clickup-setup'), 'no dice cómo configurarlo');
});


console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
if (fail) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
  console.log(`\nsandbox: ${process.env.CLAUDE_CONFIG_DIR}\n`);
  process.exit(1);
}
fs.rmSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
console.log('protocol.mjs + tui.mjs: sin hallazgos.\n');

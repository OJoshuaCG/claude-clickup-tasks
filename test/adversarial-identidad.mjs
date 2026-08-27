#!/usr/bin/env node
//
// Auditoría adversarial de clickup.mjs: a quién se le asigna el trabajo.
//
// Es la lógica de más riesgo de todo el proyecto. `matchMember` decide qué candidatos se le
// muestran al humano para resolver la identidad de ClickUp. Si devuelve UN candidato donde había
// ambigüedad, el humano confirma sin ver la duda y el trabajo termina asignado a otra persona —
// en silencio, que es exactamente el bug que esta herramienta existe para eliminar.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-adv-ident-'));

const CU = await import('../src/lib/clickup.mjs');

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

// Miembros ficticios, con la FORMA que devuelve clickup_get_workspace_members.
//
// Incluye a propósito dos cuentas del mismo humano (Elena Rios): que eso exista en un workspace
// es real, y es el caso que obliga a matchMember a devolver las dos en vez de elegir una.
const MIEMBROS = [
  { id: '5000000001', username: 'Ana Torres', email: 'atorres@acme.example' },
  { id: '5000000002', username: 'Bruno Salas', email: 'bsalas@acme.example' },
  { id: '5000000003', username: 'Carla Medina', email: 'cmedina@acme.example' },
  { id: '5000000004', username: 'Diego Paz', email: 'dpaz@acme.example' },
  // El caso real citado en las skills: la MISMA humana con dos cuentas.
  { id: '5000000005', username: 'Elena Rios', email: 'erios@dev.example' },
  { id: '5000000006', username: 'Elena Rios', email: 'erios.dev@example.net' },
];

console.log('\nclickup.mjs — matchMember (quién recibe el trabajo)\n');

check('un email exacto da UN candidato exacto', () => {
  const r = CU.matchMember(MIEMBROS, 'atorres@acme.example');
  assert(r.exact.length === 1, `exact=${r.exact.length}`);
  assert(r.exact[0].id === '5000000001', 'id equivocado');
  assert(r.fuzzy.length === 0, 'devolvió fuzzy además del exacto');
});

check('un username exacto también', () => {
  const r = CU.matchMember(MIEMBROS, 'Bruno Salas');
  assert(r.exact.length === 1 && r.exact[0].id === '5000000002', 'no matcheó por username');
});

check('el match exacto NO distingue mayúsculas', () => {
  const r = CU.matchMember(MIEMBROS, 'ATORRES@ACME.EXAMPLE');
  assert(r.exact.length === 1, 'falló por mayúsculas');
});

check('DOS cuentas del mismo humano se devuelven AMBAS, no una', () => {
  // Este es el caso citado en las skills originales: erios@dev.example y
  // erios.dev@example.net son la misma persona con ids distintos. Devolver una sola sería
  // elegir por el humano.
  const r = CU.matchMember(MIEMBROS, 'Elena Rios');
  assert(r.exact.length === 2, `devolvió ${r.exact.length} en vez de 2`);
  const ids = r.exact.map((m) => m.id).sort();
  assert(ids.join(',') === '5000000005,5000000006', `ids: ${ids}`);
});

check('un email de git que no es miembro NO da candidato exacto', () => {
  // Verificado contra la API real: estos tres devuelven null en resolve_assignees.
  for (const e of ['atorres@dev.example', 'ana.torres@example.net', 'BSalas.dev@example.org']) {
    const r = CU.matchMember(MIEMBROS, e);
    assert(r.exact.length === 0, `${e} dio un match exacto que no existe`);
  }
});

check('un parecido de apellido cae en fuzzy, NUNCA en exact', () => {
  // "BSalas.dev@example.org" → parte local "bsalas.dev" → debería sugerir a Bruno Salas como
  // POSIBLE, pero jamás como certeza. La distinción es lo único que evita la mala asignación.
  const r = CU.matchMember(MIEMBROS, 'BSalas.dev@example.org');
  assert(r.exact.length === 0, 'un parecido pasó como exacto');
});

check('una consulta vacía no devuelve nada', () => {
  for (const q of ['', '   ', null, undefined]) {
    const r = CU.matchMember(MIEMBROS, q);
    assert(r.exact.length === 0 && r.fuzzy.length === 0, `devolvió algo con ${JSON.stringify(q)}`);
  }
});

check('una lista de miembros vacía o rara no explota', () => {
  for (const lista of [[], [null], [{}], [{ id: '1' }], [{ id: '1', username: null, email: null }]]) {
    const r = CU.matchMember(lista.filter(Boolean), 'dev@example.net');
    assert(Array.isArray(r.exact) && Array.isArray(r.fuzzy), 'no devolvió arrays');
  }
});

check('un miembro sin email no rompe el match por username', () => {
  const r = CU.matchMember([{ id: '5', username: 'Sin Email', email: null }], 'Sin Email');
  assert(r.exact.length === 1, 'no matcheó a un miembro sin email');
});

check('una consulta de una sola letra no matchea a medio workspace como exacta', () => {
  const r = CU.matchMember(MIEMBROS, 'a');
  assert(r.exact.length === 0, 'una letra dio match exacto');
});

console.log('\nclickup.mjs — looksLikeToken\n');

check('reconoce un token válido y rechaza el resto', () => {
  assert(CU.looksLikeToken('pk_12345678901234567890'), 'rechazó un token válido');
  for (const bad of [
    '', '   ', 'pk_', 'pk_corto', 'sk_12345678901234567890',
    'PK_12345678901234567890', 'Bearer pk_123', null, undefined, 42, {},
    'pk_1234567890 con espacio',
  ]) {
    assert(!CU.looksLikeToken(bad), `aceptó ${JSON.stringify(bad)} como token`);
  }
});

check('un token con espacios alrededor se acepta (la gente pega así)', () => {
  assert(CU.looksLikeToken('  pk_12345678901234567890  '), 'no toleró espacios al pegar');
});


console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
if (fail) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
  console.log(`\nsandbox: ${process.env.CLAUDE_CONFIG_DIR}\n`);
  process.exit(1);
}
fs.rmSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
console.log('clickup.mjs: sin hallazgos.\n');

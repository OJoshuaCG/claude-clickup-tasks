#!/usr/bin/env node
//
// Corre TODOS los suites de `test/`, descubriéndolos del directorio.
//
// Antes la lista vivía escrita a mano en `package.json`, y eso es el mismo modo de fallo que el
// manifiesto de instalación existe para evitar: agregar un suite y olvidarse de la lista deja un
// archivo de tests que nunca corre, y nada avisa. Un suite que existe se ejecuta.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const YO = path.basename(fileURLToPath(import.meta.url));

const suites = fs
  .readdirSync(HERE)
  .filter((f) => f.endsWith('.mjs') && f !== YO)
  .sort();

if (suites.length === 0) {
  console.error('No se encontró ningún suite en test/. Eso es un error, no un éxito.');
  process.exit(1);
}

const anchoNombre = Math.max(...suites.map((s) => s.length));
const resultados = [];
let totalTests = 0;

for (const suite of suites) {
  process.stdout.write(`  ${suite.padEnd(anchoNombre)}  `);
  const r = spawnSync('node', [path.join(HERE, suite)], { encoding: 'utf8' });
  const salida = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const m = salida.match(/(\d+) pasaron, (\d+) fallaron/g);
  const ultimo = m ? m[m.length - 1].match(/(\d+) pasaron, (\d+) fallaron/) : null;
  const pasaron = ultimo ? Number(ultimo[1]) : 0;
  const fallaron = ultimo ? Number(ultimo[2]) : 0;
  totalTests += pasaron + fallaron;
  const ok = r.status === 0;
  resultados.push({ suite, ok, pasaron, fallaron, salida });
  console.log(ok ? `${pasaron} ok` : `${pasaron} ok, ${fallaron} FALLARON  (exit ${r.status})`);
}

const rotos = resultados.filter((r) => !r.ok);
console.log(
  `\n  ${suites.length} suites, ${totalTests} tests, ${rotos.length} suite(s) con fallas\n`,
);

if (rotos.length) {
  for (const r of rotos) {
    console.log(`━━ ${r.suite} ━━`);
    const lineas = r.salida.split('\n').filter((l) => /^\s{2}(FAIL|-|\?\?)/.test(l) || /sandbox:/.test(l));
    console.log(lineas.length ? lineas.join('\n') : r.salida.slice(-1500));
    console.log('');
  }
  process.exit(1);
}
console.log('  Todo verde.\n');

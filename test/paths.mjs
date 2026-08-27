#!/usr/bin/env node
//
// Path canonicalisation tests.
//
// These live in a file rather than a `node -e` one-liner for a reason discovered the hard way:
// backslashes go through two levels of escaping on the way to an inline script, so the inputs
// under test stop being the inputs you wrote. A Windows path test that cannot be trusted to
// contain the path you meant is worse than no test.

import { canonicalProjectKey, projectStateFile, fnv1a32 } from '../src/lib/paths.mjs';

let pass = 0;
let fail = 0;

function eq(input, expected, label) {
  const got = canonicalProjectKey(input);
  if (got === expected) {
    pass++;
    console.log(`  ok   ${label ?? JSON.stringify(input)}`);
  } else {
    fail++;
    console.log(
      `  FAIL ${label ?? JSON.stringify(input)}\n         esperado ${JSON.stringify(expected)}, hubo ${JSON.stringify(got)}`,
    );
  }
}

function assert(cond, label) {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}`);
  }
}

console.log('\nRUTAS WINDOWS\n');

// String.raw keeps single backslashes exactly as written.
eq(String.raw`C:\Users\alex\code\proj`, 'c:/Users/alex/code/proj', 'backslashes → slashes');
eq(String.raw`c:\Users\alex\code\proj`, 'c:/Users/alex/code/proj', 'unidad ya minúscula');
eq('c:/Users/alex/code/proj', 'c:/Users/alex/code/proj', 'slashes, unidad mayúscula');
// A raw string cannot END in a backslash — it would escape the closing backtick — so the
// trailing separator is appended as a normal escaped literal.
eq(String.raw`C:\Users\alex\code\proj` + '\\', 'c:/Users/alex/code/proj', 'separador final');
eq('C:\\', 'c:/', 'raíz de unidad se conserva');
eq('C:/', 'c:/', 'raíz de unidad con slash');

console.log('\nSEPARADORES REPETIDOS\n');

// These arrive in real life from string concatenation that joins a path that already ended in a
// separator. Two spellings of the same directory must not become two config entries.
eq(String.raw`C:\\Users\\alex\\proj`, 'c:/Users/alex/proj', 'backslashes dobles');
eq('C://Users//proj', 'c:/Users/proj', 'slashes dobles');
eq('/home/j//code///proj', '/home/j/code/proj', 'slashes repetidos en POSIX');
eq('/home/j/p//', '/home/j/p', 'separadores repetidos al final');

console.log('\nRUTAS UNC (el // inicial NO se colapsa)\n');

eq(String.raw`\\server\share\proj`, '//server/share/proj', 'UNC con backslashes');
eq('//server/share/proj', '//server/share/proj', 'UNC con slashes');
eq(String.raw`\\server\share` + '\\', '//server/share', 'UNC con separador final');

console.log('\nPOSIX Y BORDES\n');

eq('/home/j/p', '/home/j/p', 'POSIX simple');
eq('/home/j/p/', '/home/j/p', 'POSIX con separador final');
eq('/', '/', 'raíz POSIX');
eq('', '', 'vacío');
eq(null, '', 'null');
eq(undefined, '', 'undefined');
eq('/mnt/c/Users/alex/code/proj', '/mnt/c/Users/alex/code/proj', 'ruta de WSL');

console.log('\nESTABILIDAD DE LA CLAVE\n');

assert(
  projectStateFile(String.raw`C:\Users\J\p`) === projectStateFile('c:/Users/J/p'),
  'mismo archivo de estado para C:\\ y c:/',
);
assert(
  projectStateFile('/home/j/p') === projectStateFile('/home/j/p/'),
  'mismo archivo de estado con y sin separador final',
);
assert(
  projectStateFile('/home/j/p') !== projectStateFile('/home/j/otro'),
  'proyectos distintos no comparten archivo de estado',
);
assert(
  projectStateFile('/mnt/c/Users/J/p') !== projectStateFile('c:/Users/J/p'),
  'WSL y Windows son claves distintas (son instalaciones distintas de Claude Code)',
);

console.log('\nHASH ESTABLE ENTRE PLATAFORMAS\n');

// If this ever changes, every project silently loses its claim state. It must be pinned.
assert(fnv1a32('abc') === '1a47e90b', `fnv1a32('abc') === '1a47e90b' (hubo ${fnv1a32('abc')})`);
assert(fnv1a32('') === '811c9dc5', `fnv1a32('') === '811c9dc5' (hubo ${fnv1a32('')})`);
assert(fnv1a32('/home/j/p').length === 8, 'el hash siempre tiene 8 caracteres');

console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
process.exit(fail ? 1 : 0);

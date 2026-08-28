#!/usr/bin/env node
//
// Detección de escrituras en comandos de shell.
//
// Este suite existe porque el detector es la pieza con MÁS superficie de error de toda la
// herramienta, y porque sus dos modos de fallo no cuestan lo mismo:
//
//   * Un falso NEGATIVO (no detecta una escritura) devuelve el comportamiento anterior, donde
//     Bash no estaba en el matcher. Malo, pero conocido.
//   * Un falso POSITIVO (bloquea un `ls`) rompe una sesión en un repo cualquiera de la máquina,
//     y eso se paga con la desinstalación.
//
// Por eso hay tantos casos NEGATIVOS como positivos. Un suite que solo prueba que el candado
// bloquea, sin probar que deja pasar, prueba la mitad que no duele.

import { detectBashWrites, tokenize } from '../src/lib/bash-writes.mjs';

let pass = 0;
let fail = 0;

function assert(cond, label) {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}`);
  }
}

/** El comando escribe, y entre sus destinos está `destino` (si se pasa). */
function escribe(command, destino = null, label = null) {
  const r = detectBashWrites(command);
  const etiqueta = label ?? command.replace(/\n/g, '⏎').slice(0, 62);
  if (!r.writes) {
    fail++;
    console.log(`  FAIL ${etiqueta}\n         esperaba ESCRIBE, dio writes:false`);
    return;
  }
  if (destino && !r.targets.includes(destino) && !r.unknownTarget) {
    fail++;
    console.log(
      `  FAIL ${etiqueta}\n         esperaba el destino ${destino}, hubo ${JSON.stringify(r.targets)}`,
    );
    return;
  }
  pass++;
  console.log(`  ok   ${etiqueta}`);
}

/** El comando NO escribe. Estos son los que evitan que la herramienta sea insufrible. */
function noEscribe(command, label = null) {
  const r = detectBashWrites(command);
  const etiqueta = label ?? command.replace(/\n/g, '⏎').slice(0, 62);
  if (r.writes) {
    fail++;
    console.log(
      `  FAIL ${etiqueta}\n         esperaba NO ESCRIBE, dio ${JSON.stringify(r.targets)}${r.unknownTarget ? ' + destino desconocido' : ''}`,
    );
    return;
  }
  pass++;
  console.log(`  ok   ${etiqueta}`);
}

console.log('\nREDIRECCIONES\n');

escribe('echo hola > salida.txt', 'salida.txt');
escribe('echo hola >> salida.txt', 'salida.txt');
escribe('echo hola >| salida.txt', 'salida.txt');
escribe('echo hola 1> salida.txt', 'salida.txt');
escribe('make 2> errores.log', 'errores.log');
escribe('make &> todo.log', 'todo.log');
escribe('make &>> todo.log', 'todo.log');
// El heredoc es la forma que el modo bypassPermissions recomienda explícitamente.
escribe('cat > src/app.py <<EOF\nprint(1)\nEOF', 'src/app.py', 'heredoc: cat > archivo <<EOF');
escribe("cat <<'EOF' > src/app.py\nprint(1)\nEOF", 'src/app.py', 'heredoc con el > al final');
escribe('printf "x" > "un archivo con espacios.txt"', 'un archivo con espacios.txt');

console.log('\nREDIRECCIONES QUE NO SON ESCRITURAS\n');

noEscribe('echo hola > /dev/null');
noEscribe('make 2> /dev/null');
noEscribe('make > /dev/null 2>&1', 'el 2>&1 duplica un fd, no nombra un archivo');
noEscribe('diff <(sort a) <(sort b)', 'redirección de LECTURA');
noEscribe('rg foo < entrada.txt', 'leer de un archivo no es escribirlo');
// El falso positivo más caro de todos: un `>` que es texto, no un operador.
noEscribe("echo 'a > b' | rg x", 'el > entre comillas simples es literal');
noEscribe('echo "resultado > esperado"', 'el > entre comillas dobles es literal');
noEscribe('echo a \\> b', 'el > escapado es literal');
noEscribe("rg 'x>y' archivo.txt", 'el > dentro de un patrón');

console.log('\nCOMANDOS QUE ESCRIBEN\n');

escribe('tee salida.txt', 'salida.txt');
escribe('echo x | tee -a registro.log', 'registro.log');
escribe("sed -i 's/a/b/' src/app.py", 'src/app.py');
escribe("sed -i.bak 's/a/b/' src/app.py", 'src/app.py');
escribe("sed -e 's/a/b/' -i src/app.py", 'src/app.py');
escribe("perl -i -pe 's/a/b/' src/app.py", 'src/app.py');
// `sd` reescribe in situ POR DEFECTO, y es el que el CLAUDE.md del usuario recomienda sobre sed.
escribe('sd viejo nuevo src/app.py', 'src/app.py');
escribe('cp origen.txt destino.txt', 'destino.txt');
escribe('mv viejo.txt nuevo.txt', 'nuevo.txt');
escribe('install -m 755 script build/script', 'build/script');
escribe('dd if=/dev/zero of=imagen.bin bs=1M count=1', 'imagen.bin');
escribe('truncate -s 0 registro.log', 'registro.log');

console.log('\nESCRITURAS CON DESTINO DESCONOCIDO\n');

// Estas son la evasión que había que cerrar: escriben, pero la línea no nombra el archivo.
assert(detectBashWrites('git apply parche.diff').unknownTarget, 'git apply → destino desconocido');
assert(detectBashWrites('patch -p1 < parche.diff').unknownTarget, 'patch → destino desconocido');
assert(detectBashWrites('git checkout -- src/').unknownTarget, 'git checkout -- → reescribe');
assert(detectBashWrites('git restore src/app.py').unknownTarget, 'git restore → reescribe');
assert(detectBashWrites('git -C /repo apply p.diff').unknownTarget, 'git con flags globales');
assert(
  detectBashWrites("python3 -c \"open('a.py','w').write('x')\"").unknownTarget,
  'python -c con open(...,"w")',
);
assert(
  detectBashWrites("node -e \"require('fs').writeFileSync('a.js','x')\"").unknownTarget,
  'node -e con writeFileSync',
);

console.log('\nGIT Y SCRIPTS QUE NO ESCRIBEN\n');

noEscribe('git status --porcelain');
noEscribe('git log --oneline -20');
noEscribe('git diff HEAD~1');
noEscribe('git rev-parse --short HEAD');
noEscribe('python3 -c "print(1+1)"', 'python -c sin forma de escritura');
noEscribe('node -e "console.log(process.version)"', 'node -e que solo imprime');
noEscribe('python3 script.py', 'ejecutar un script NO es escribirlo');
noEscribe("sed 's/a/b/' src/app.py", 'sed SIN -i solo imprime');
noEscribe('sd -p viejo nuevo src/app.py', 'sd --preview es read-only');
noEscribe('sd viejo nuevo', 'sd sin archivos lee stdin');

console.log('\nLECTURAS PURAS\n');

noEscribe('ls -la');
noEscribe('eza -la --git-ignore');
noEscribe('rg --files -g "*.mjs"');
noEscribe('fd -t f -e py');
noEscribe('bat --plain src/app.py');
noEscribe('cat src/app.py');
noEscribe('ls -la && rg foo && git status', 'varios comandos encadenados, ninguno escribe');
noEscribe('curl -s https://ejemplo.test | jq .', 'pipe sin redirección a archivo');
noEscribe('npm ls --depth 0');

console.log('\nENVOLTORIOS\n');

escribe('sudo tee /etc/hosts', '/etc/hosts');
escribe('env FOO=bar tee salida.txt', 'salida.txt');
escribe('FOO=bar BAZ=qux tee salida.txt', 'salida.txt', 'asignaciones de entorno al frente');
escribe('nohup tee salida.txt', 'salida.txt');
noEscribe('sudo ls /root');
noEscribe('env FOO=bar rg patron');

console.log('\nCOMANDOS ENCADENADOS: BASTA UNO\n');

escribe('rg foo && echo x > salida.txt', 'salida.txt');
escribe('mkdir -p build; cp a.txt build/b.txt', 'build/b.txt');
escribe('ls | tee listado.txt', 'listado.txt');
escribe('cat a.txt > b.txt || echo falló', 'b.txt');

console.log('\nENTRADAS DEGENERADAS (no deben explotar)\n');

for (const entrada of [
  '',
  '   ',
  null,
  undefined,
  '>',
  '>>>',
  '|||',
  "echo 'sin cerrar",
  'echo "sin cerrar',
  'echo \\',
  '&&&',
  ';;;',
  'cat <<EOF',
  '2>',
  'sed -i',
]) {
  let ok = true;
  try {
    const r = detectBashWrites(entrada);
    ok = typeof r.writes === 'boolean' && Array.isArray(r.targets);
  } catch {
    ok = false;
  }
  assert(ok, `no explota con ${JSON.stringify(entrada)}`);
}

console.log('\nTOKENIZADOR\n');

assert(
  tokenize('echo a > b').filter((t) => t.op).length === 1,
  'un solo operador en `echo a > b`',
);
assert(
  tokenize("echo 'a > b'").filter((t) => t.op).length === 0,
  'ningún operador dentro de comillas',
);
assert(
  tokenize('make 2>&1').some((t) => t.op && t.text.endsWith('&')),
  '2>&1 produce un operador de duplicación',
);
assert(
  tokenize('a && b || c | d ; e').filter((t) => t.op).length === 4,
  'los cuatro separadores se reconocen',
);
assert(
  tokenize('echo "hola mundo"')[1]?.text === 'hola mundo',
  'las comillas dobles agrupan en un solo token',
);

console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
process.exit(fail ? 1 : 0);

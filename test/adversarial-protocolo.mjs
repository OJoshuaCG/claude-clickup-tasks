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

check('softWrap conserva la sangría de la línea original', () => {
  // El bug: `split(/\s+/)` sobre todo el texto se comía los espacios del principio, así que las
  // continuaciones arrancaban pegadas al borde. Una lista indentada dentro de un `box` se
  // desarmaba sola en cuanto UNO de sus ítems se pasaba de ancho: un ítem quedaba alineado y el
  // de al lado no, sin que nada avisara. Apareció escribiendo el cuadro del candado.
  const lineas = TUI.softWrap('  ítem indentado con bastante texto para que tenga que cortarse', 30);
  assert(lineas.length > 1, 'no llegó a cortar, el caso no se está probando');
  for (const [i, l] of lineas.entries()) {
    assert(l.startsWith('  '), `la línea ${i} perdió la sangría: "${l}"`);
  }
});

check('softWrap alinea las continuaciones debajo del TEXTO, no del bullet', () => {
  // Si la continuación arranca en la columna del bullet, la lista se lee como un párrafo con un
  // símbolo suelto adelante.
  for (const bullet of ['· ', '- ', '* ', '1. ']) {
    const lineas = TUI.softWrap(`${bullet}texto suficientemente largo como para cortarse`, 24);
    assert(lineas.length > 1, `no cortó con el bullet "${bullet}"`);
    const sangriaEsperada = ' '.repeat(bullet.length);
    for (const l of lineas.slice(1)) {
      assert(
        l.startsWith(sangriaEsperada) && l[bullet.length] !== ' ',
        `la continuación de "${bullet}" no quedó alineada bajo el texto: "${l}"`,
      );
    }
  }
});

check('softWrap con un ancho imposible devuelve la línea entera, sin bucle', () => {
  // Un `max` menor que la sangría es un error del llamador, pero acá no se cuelga: partir por
  // caracteres sería peor que devolver la línea larga.
  const lineas = TUI.softWrap('        muy indentado', 4);
  assert(lineas.length === 1, `devolvió ${lineas.length} líneas en vez de una`);
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
    // El cronómetro tiene tres estados de atribución y los tres imprimen prosa distinta. Con la
    // identidad resuelta pero el token sin verificar se renderiza el bloque "todavía no": es el
    // que interpola ids, y por lo tanto el que puede filtrar `undefined`.
    { track_time: true },
    { track_time: 'sí' },
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

check('el protocolo declara el rol y su dirección de entrega', () => {
  const be = PR.renderContext(ctxFor({ mode: 'tasks', list_id: '1', role: 'backend', counterpart: '/a/fe' }));
  assert(be.includes('Rol: **backend**'), 'no declara el rol backend');
  assert(be.includes('/a/fe'), 'no nombra la contraparte');

  const fe = PR.renderContext(ctxFor({ mode: 'tasks', list_id: '1', role: 'frontend' }));
  assert(fe.includes('Rol: **frontend**'), 'no declara el rol frontend');
  assert(fe.includes('final de la cadena'), 'no dice que el frontend cierra la cadena');

  const full = PR.renderContext(ctxFor({ mode: 'tasks', list_id: '1', role: 'fullstack' }));
  assert(full.includes('las dos puntas'), 'no describe el fullstack');
});

check('un BACKEND sin contraparte recibe la ADVERTENCIA de no parkear', () => {
  // Es el hallazgo que motivó el modelo de rol: sin esta advertencia el protocolo decía
  // "si dudás, va al estado de handoff" y la tarea quedaba esperando a nadie.
  const out = PR.renderContext(ctxFor({ mode: 'tasks', list_id: '1', role: 'backend' }));
  assert(out.includes('NO parkees nada'), 'no advierte que no puede parkear');
  assert(out.includes('esperando a nadie'), 'no explica la consecuencia');
  assert(out.includes('siempre'), 'no dice que cierra siempre');

  // Y con una contraparte REGISTRADA Y USABLE, la advertencia desaparece.
  //
  // "Declarada" no alcanza: si el otro proyecto no está en el registro, o es fullstack, o mira
  // otra lista, no puede recibir — y el protocolo tiene que seguir prohibiendo parkear.
  const cfg = C.defaultConfig();
  cfg.identity.clickup_user_id = '5000000001';
  cfg.identity.confirmed = true;
  const be = '/tmp/adv-be2';
  const fe = '/tmp/adv-fe2';
  cfg.projects = {
    [fe]: { path: fe, mode: 'tasks', role: 'frontend', counterpart: be, list_id: '1' },
    [be]: { path: be, name: 'be', mode: 'tasks', role: 'backend', counterpart: fe, list_id: '1' },
  };
  const con = PR.renderContext(PR.buildContext(cfg, be));
  assert(!con.includes('NO parkees nada'), 'advierte con una contraparte que sí puede recibir');
  assert(con.includes(fe), 'no nombra la contraparte');
});

check('una contraparte que no puede recibir se explica con el motivo REAL', () => {
  // Decir "no hay contraparte registrada" cuando SÍ hay una es mentirle al agente, y el agente
  // necesita el motivo concreto para poder informarle al usuario qué arreglar.
  const cfg = C.defaultConfig();
  cfg.identity.clickup_user_id = '5000000001';
  cfg.identity.confirmed = true;
  const key = '/tmp/adv-be';
  cfg.projects = {
    '/tmp/adv-fe': { path: '/tmp/adv-fe', mode: 'tasks', role: 'fullstack', list_id: '1' },
    [key]: {
      path: key,
      name: 'be',
      mode: 'tasks',
      role: 'backend',
      counterpart: '/tmp/adv-fe',
      list_id: '1',
    },
  };
  const out = PR.renderContext(PR.buildContext(cfg, key));

  assert(out.includes('NO parkees nada'), 'no prohíbe parkear');
  assert(out.includes('Hay una contraparte declarada'), 'niega que exista la contraparte');
  assert(out.includes('no mira el estado de handoff'), 'no da el motivo real');
  assert(!out.includes('NO hay contraparte registrada'), 'sigue diciendo que no hay ninguna');
  assert(out.includes('avisale al usuario'), 'no manda informar el desajuste');
});

check('el FRONTEND sabe que su bandeja NO es `to do`', () => {
  const out = PR.renderContext(ctxFor({ mode: 'tasks', list_id: '1', role: 'frontend' }));
  assert(/bandeja de entrada es `update required`, no `to do`/.test(out), 'no aclara la bandeja');
  assert(out.includes('backlog del otro rol'), 'no dice de quién es el `to do`');
  // Y que reclama con `in progress`, para que nadie más la tome.
  assert(out.includes('avisa que ya la estás haciendo'), 'no explica por qué reclama');
});

check('el FRONTEND puede pedir trabajo aunque el backend no esté registrado', () => {
  const out = PR.renderContext(ctxFor({ mode: 'tasks', list_id: '1', role: 'frontend' }));
  assert(out.includes('exista o no'), 'no aclara que el pedido no depende del repo registrado');
  assert(out.includes('/tarea bloqueo'), 'no dice cómo dejar el pedido');
  assert(
    out.includes('Nunca devuelvas una tarea a `update required`'),
    'no prohíbe devolver al estado de handoff',
  );
});

console.log('\nprotocol.mjs — el bloqueo no es un veto\n');

check('una colisión se plantea UNA vez y ofrece tres salidas', () => {
  const out = PR.renderContext(ctxFor({ mode: 'tasks', list_id: '1', role: 'fullstack' }));
  assert(out.includes('no se veta'), 'no aclara que no es un veto');
  assert(out.includes('decide el usuario'), 'no dice de quién es la decisión');
  // Las tres salidas, explícitas.
  assert(out.includes('No es la misma tarea'), 'falta la salida "no es la misma"');
  assert(out.includes('la hago igual'), 'falta la salida "seguir igual"');
  assert(out.includes('No la hago'), 'falta la salida "no la hago"');
  assert(out.includes('no lo vuelvas a plantear'), 'no dice que se plantea una sola vez');
});

check('si el usuario decide seguir, el aviso a la otra persona es obligatorio', () => {
  const out = PR.renderContext(ctxFor({ mode: 'tasks', list_id: '1', role: 'backend' }));
  assert(out.includes('TRABAJO EN PARALELO'), 'no exige el comentario');
  assert(out.includes('notify_all'), 'no exige la notificación');
  assert(out.includes('NO es opcional'), 'no marca el comentario como obligatorio');
  assert(out.includes('en el merge'), 'no explica qué evita');
});

check('una tarea cerrada tampoco es un veto', () => {
  const out = PR.renderContext(ctxFor({ mode: 'tasks', list_id: '1', role: 'fullstack' }));
  assert(out.includes('no prohíbe volver a tocarla'), 'trata `complete` como veto');
  assert(out.includes('REAPERTURA'), 'no menciona la reapertura como salida');
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

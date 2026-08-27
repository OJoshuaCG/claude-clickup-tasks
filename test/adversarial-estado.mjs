#!/usr/bin/env node
//
// Auditoría adversarial de state.mjs y config.mjs.
//
// state.mjs decide si el candado se abre. config.mjs decide qué proyecto es cuál. Los dos se leen
// en cada prompt y en cada escritura, así que un error acá no da una excepción visible: da un
// candado que se abre cuando no debe, o un proyecto que resuelve al espacio de ClickUp de otro.
//
// El ataque se concentra en lo que un archivo editado a mano puede contener: timestamps
// imposibles, tipos equivocados, rutas que se parecen entre sí.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-adv-est-'));

const S = await import('../src/lib/state.mjs');
const C = await import('../src/lib/config.mjs');
const P = await import('../src/lib/paths.mjs');

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

const PROJ = path.join(os.tmpdir(), 'cf-proj-adv');
fs.mkdirSync(PROJ, { recursive: true });

function writeRawState(obj) {
  fs.mkdirSync(P.statePath(), { recursive: true });
  fs.writeFileSync(
    P.projectStateFile(PROJ),
    typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2),
  );
}

console.log('\nSTATE: ARCHIVOS DE ESTADO CORRUPTOS\n');

for (const [label, raw] of [
  ['vacío', ''],
  ['truncado', '{ "claim": '],
  ['no es objeto', '[1,2,3]'],
  ['null', 'null'],
  ['basura', 'no es json en absoluto'],
  ['claim es un string', '{ "claim": "TAREA-1" }'],
  ['claim es un número', '{ "claim": 42 }'],
  ['exemption es un string', '{ "exemption": "porque sí" }'],
]) {
  check(`readState degrada a "sin estado": ${label}`, () => {
    writeRawState(raw);
    const st = S.readState(PROJ);
    assert(st && typeof st === 'object', 'no devolvió objeto');
    assert('claim' in st && 'exemption' in st, 'faltan las claves');
    // Y exemptionStatus tiene que tolerar lo que salga de ahí.
    const ex = S.exemptionStatus(st, 8);
    assert(typeof ex.active === 'boolean', 'active no es booleano');
  });
}

console.log('\nSTATE: TIMESTAMPS IMPOSIBLES EN LA EXENCIÓN\n');

check('un declared_at ilegible se considera VENCIDO (falla cerrado)', () => {
  writeRawState({ exemption: { reason: 'x', declared_at: 'no es fecha', hours: 8 } });
  const ex = S.exemptionStatus(S.readState(PROJ), 8);
  assert(!ex.active, 'una exención con fecha ilegible mantuvo el candado abierto');
  assert(ex.expired, 'no la marcó como vencida');
});

check('un declared_at ausente se considera VENCIDO', () => {
  writeRawState({ exemption: { reason: 'x', hours: 8 } });
  const ex = S.exemptionStatus(S.readState(PROJ), 8);
  assert(!ex.active, 'sin fecha, mantuvo el candado abierto');
});

check('un declared_at EN EL FUTURO no deja el candado abierto para siempre', () => {
  // Puede pasar por desfase de reloj, por una VM que se suspendió, o porque alguien editó el
  // archivo. Con `edad = ahora - declarado`, una fecha futura da edad NEGATIVA, y
  // `negativa >= limite` es false: la exención quedaría vigente hasta que el reloj la alcance.
  // Con 2099 eso son décadas de candado abierto.
  const futuro = new Date(Date.now() + 365 * 86400000).toISOString();
  writeRawState({ exemption: { reason: 'x', declared_at: futuro, hours: 8 } });
  const ex = S.exemptionStatus(S.readState(PROJ), 8);
  assert(!ex.active, 'una exención fechada en el futuro dejó el candado abierto');
});

check('hours negativo o cero no vuelve la exención eterna', () => {
  for (const hours of [-1, 0, -9999]) {
    writeRawState({ exemption: { reason: 'x', declared_at: new Date().toISOString(), hours } });
    const ex = S.exemptionStatus(S.readState(PROJ), 8);
    // Con horas inválidas se cae al default (8h), no a "infinito".
    assert(Number.isFinite(ex.limitHours) && ex.limitHours > 0, `limitHours inválido: ${ex.limitHours}`);
  }
});

check('hours absurdamente grande sigue siendo un número finito', () => {
  writeRawState({
    exemption: { reason: 'x', declared_at: new Date().toISOString(), hours: 1e18 },
  });
  const ex = S.exemptionStatus(S.readState(PROJ), 8);
  assert(Number.isFinite(ex.ageHours), 'ageHours no es finito');
});

check('una exención justo en el límite está vencida, no vigente', () => {
  const hace8h = new Date(Date.now() - 8 * 3600000 - 1000).toISOString();
  writeRawState({ exemption: { reason: 'x', declared_at: hace8h, hours: 8 } });
  const ex = S.exemptionStatus(S.readState(PROJ), 8);
  assert(ex.expired, 'a las 8h exactas debería estar vencida');
});

console.log('\nSTATE: CLAIM\n');

check('setClaim retira cualquier exención vigente', () => {
  S.setExemption(PROJ, 'motivo', 8);
  S.setClaim(PROJ, { taskId: 'T1', title: 'x' });
  const st = S.readState(PROJ);
  assert(st.claim, 'no guardó el claim');
  assert(!st.exemption, 'dejó la exención junto al claim: el candado tendría dos llaves');
});

check('un claim con campos ausentes no rompe nada', () => {
  S.setClaim(PROJ, { taskId: 'T2' });
  const st = S.readState(PROJ);
  assert(st.claim.task_id === 'T2', 'perdió el id');
  assert(st.claim.url && st.claim.url.includes('T2'), 'no derivó la URL');
  assert(st.claim.claimed_at, 'sin timestamp');
});

check('un título absurdamente largo no corrompe el archivo', () => {
  S.setClaim(PROJ, { taskId: 'T3', title: 'x'.repeat(100000) });
  const st = S.readState(PROJ);
  assert(st.claim.title.length === 100000, 'truncó o perdió el título');
});

check('caracteres peligrosos en el título sobreviven', () => {
  const raro = 'con "comillas" y \\backslash y \n salto y ñ 中 🎯';
  S.setClaim(PROJ, { taskId: 'T4', title: raro });
  assert(S.readState(PROJ).claim.title === raro, 'se corrompió el título');
});

check('dropState borra y readState sigue funcionando', () => {
  S.dropState(PROJ);
  const st = S.readState(PROJ);
  assert(st.claim === null && st.exemption === null, 'quedó estado');
});

console.log('\nCONFIG: ARCHIVOS CORRUPTOS Y SECCIONES CON TIPOS MAL\n');

function writeRawConfig(obj) {
  fs.mkdirSync(P.toolHome(), { recursive: true });
  fs.writeFileSync(
    P.configPath(),
    typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2),
  );
}

for (const [label, raw] of [
  ['truncado', '{ "identity": '],
  ['no es objeto', '[]'],
  ['null', 'null'],
  ['basura', 'xxx'],
]) {
  check(`loadConfig reporta ok:false sin explotar: ${label}`, () => {
    writeRawConfig(raw);
    const r = C.loadConfig();
    assert(r.ok === false, 'debería reportar ok:false');
    assert(r.config && r.config.defaults, 'no devolvió defaults usables');
  });
}

for (const [label, obj] of [
  ['identity es null', { identity: null }],
  ['identity es string', { identity: 'x' }],
  ['defaults es null', { defaults: null }],
  ['defaults es array', { defaults: [] }],
  ['projects es null', { projects: null }],
  ['projects es array', { projects: [] }],
  ['team es null', { team: null }],
  ['git_emails es string', { identity: { git_emails: 'primero@example.net' } }],
]) {
  check(`loadConfig rellena defaults: ${label}`, () => {
    writeRawConfig(obj);
    const { config, ok } = C.loadConfig();
    assert(ok, 'debería poder leerse');
    assert(config.defaults && typeof config.defaults === 'object', 'defaults inutilizable');
    assert('block_writes_without_task' in config.defaults, 'falta un default');
    // resolveProject tiene que tolerar un `projects` con forma rara.
    const r = C.resolveProject(config, PROJ);
    assert(r && 'entry' in r, 'resolveProject falló');
  });
}

console.log('\nCONFIG: RESOLUCIÓN DE PROYECTOS\n');

function cfgWith(projects) {
  const c = C.defaultConfig();
  c.projects = projects;
  return c;
}

check('un hermano con prefijo común NO resuelve al proyecto registrado', () => {
  // `/a/proj` registrado y cwd `/a/proyecto2`: si el match fuera por startsWith sin separador,
  // el segundo heredaría el espacio de ClickUp del primero y crearía tareas en el tablero ajeno.
  const c = cfgWith({ '/a/proj': { mode: 'tasks', list_id: '1', path: '/a/proj' } });
  assert(C.resolveProject(c, '/a/proyecto2').entry === null, 'resolvió un hermano');
  assert(C.resolveProject(c, '/a/proj2').entry === null, 'resolvió /a/proj2');
  assert(C.resolveProject(c, '/a/projX/sub').entry === null, 'resolvió /a/projX/sub');
  // Pero el subdirectorio real sí.
  assert(C.resolveProject(c, '/a/proj/src').matchedBy === 'ancestor', 'no resolvió el hijo real');
});

check('gana el ancestro MÁS específico', () => {
  const c = cfgWith({
    '/a': { mode: 'tasks', list_id: 'PADRE', path: '/a' },
    '/a/b/c': { mode: 'tasks', list_id: 'HIJO', path: '/a/b/c' },
  });
  assert(C.resolveProject(c, '/a/b/c/d').entry.list_id === 'HIJO', 'ganó el padre');
  assert(C.resolveProject(c, '/a/b').entry.list_id === 'PADRE', 'no cayó al padre');
});

check('un cwd vacío o inválido no resuelve nada', () => {
  const c = cfgWith({ '/a': { mode: 'tasks', list_id: '1', path: '/a' } });
  for (const bad of ['', null, undefined]) {
    const r = C.resolveProject(c, bad);
    assert(r.entry === null, `resolvió con cwd ${JSON.stringify(bad)}`);
  }
});

check('un proyecto excluido NO se hereda por remote', () => {
  const c = cfgWith({
    '/otro/clone': {
      mode: C.MODES.EXCLUDED,
      git_remote: 'github.com/x/y',
      path: '/otro/clone',
    },
  });
  // Sin git en PROJ no hay remote que comparar, pero la lógica no debe reventar.
  const r = C.resolveProject(c, PROJ);
  assert(r.entry === null || r.entry.mode !== C.MODES.EXCLUDED, 'heredó una exclusión por remote');
});

console.log('\nCONFIG: normaliseRemote\n');

check('formas equivalentes del mismo remoto colapsan', () => {
  const formas = [
    'git@github.com:acme/mensajeria-api.git',
    'https://github.com/acme/mensajeria-api.git',
    'https://github.com/acme/mensajeria-api',
    'https://user@github.com/acme/mensajeria-api',
    'ssh://git@github.com/acme/mensajeria-api.git',
    'https://github.com/acme/mensajeria-api/',
    'HTTPS://GitHub.com/Acme/Mensajeria-API.git',
  ];
  const norm = formas.map(C.normaliseRemote);
  const unicos = [...new Set(norm)];
  assert(unicos.length === 1, `no colapsaron: ${JSON.stringify(unicos)}`);
  assert(unicos[0] === 'github.com/acme/mensajeria-api', `resultado inesperado: ${unicos[0]}`);
});

check('repos distintos NO colapsan', () => {
  const a = C.normaliseRemote('git@github.com:x/uno.git');
  const b = C.normaliseRemote('git@github.com:x/dos.git');
  assert(a !== b, 'dos repos distintos dieron la misma clave');
});

console.log('\nCONFIG: effectiveDefaults y effectiveStatuses\n');

check('overrides con basura no rompen los defaults', () => {
  const c = C.defaultConfig();
  for (const basura of [null, 'x', 42, [], { end_date_field: null }, { use_dates: undefined }]) {
    const d = C.effectiveDefaults(c, { overrides: basura });
    assert(typeof d.use_dates === 'boolean', `use_dates roto con ${JSON.stringify(basura)}`);
    assert(d.end_date_field, `end_date_field roto con ${JSON.stringify(basura)}`);
  }
});

check('un override solo pisa lo que declara', () => {
  const c = C.defaultConfig();
  c.defaults.search_window_days = 30;
  const d = C.effectiveDefaults(c, { overrides: { search_window_days: 7 } });
  assert(d.search_window_days === 7, 'no aplicó el override');
  assert(d.use_dates === true, 'pisó algo que no declaraba');
});

check('un override no puede meter una clave que no es overridable', () => {
  const c = C.defaultConfig();
  const d = C.effectiveDefaults(c, {
    overrides: { block_writes_without_task: false, exemption_hours: 99999 },
  });
  // El candado y la duración de la exención son de la máquina, no del tablero.
  assert(d.block_writes_without_task === true, 'un override apagó el candado');
  assert(d.exemption_hours === 8, 'un override cambió la duración de la exención');
});

check('effectiveStatuses cae a los defaults con basura', () => {
  for (const basura of [null, 'x', 42, [], { in_progress: '' }, { in_progress: '   ' }]) {
    const s = C.effectiveStatuses({ statuses: basura });
    assert(s.in_progress === 'in progress', `in_progress roto con ${JSON.stringify(basura)}`);
    assert(s.done === 'complete', 'done roto');
  }
});

check('effectiveStatuses marca si los nombres venían del tablero', () => {
  assert(C.effectiveStatuses({}).__recorded === false, 'sin statuses debería ser false');
  assert(
    C.effectiveStatuses({ statuses: { in_progress: 'En curso' } }).__recorded === true,
    'con statuses debería ser true',
  );
});

console.log('\nCONFIG: rol y contraparte (dirección de las entregas)\n');

check('sin rol declarado, se comporta como fullstack', () => {
  for (const entry of [{}, { role: null }, { role: 'inventado' }, { role: 42 }]) {
    const rb = C.roleBehaviour(entry);
    assert(rb.role === C.ROLES.FULLSTACK, `rol ${rb.role} con ${JSON.stringify(entry)}`);
    assert(rb.canHandoff === false, 'un fullstack no entrega hacia adelante');
    assert(rb.closesChain === true, 'un fullstack cierra la cadena');
  }
});

check('un BACKEND sin contraparte NO puede parkear en handoff', () => {
  // La regla que evita la tarea que espera a nadie: sin frontend registrado, nadie mira ese
  // filtro, así que parkear ahí PIERDE la tarea con apariencia de haberla entregado.
  const rb = C.roleBehaviour({ role: 'backend' });
  assert(rb.canHandoff === false, 'dejó parkear sin contraparte');
  assert(rb.closesChain === true, 'debería cerrar la cadena');
});

check('un BACKEND con contraparte SÍ puede parkear', () => {
  const rb = C.roleBehaviour({ role: 'backend', counterpart: '/a/fe' });
  assert(rb.canHandoff === true, 'no deja parkear con contraparte');
  assert(rb.counterpart === '/a/fe', 'perdió la contraparte');
  assert(rb.closesChain === false, 'con contraparte no cierra la cadena');
});

check('un FRONTEND puede pedir trabajo al otro rol con o sin contraparte', () => {
  // Opción (b) del usuario: el pedido es a una PERSONA, no a un repositorio. Una tarea con el
  // pedido escrito la encuentra cualquiera; no hace falta que nadie vigile un filtro.
  for (const counterpart of [null, '/a/be']) {
    const rb = C.roleBehaviour({ role: 'frontend', counterpart });
    assert(rb.canRequestFromOther === true, `no puede pedir con counterpart=${counterpart}`);
    assert(rb.canHandoff === false, 'un frontend no entrega hacia adelante');
    assert(rb.closesChain === true, 'un frontend cierra la cadena');
  }
});

check('la bandeja de entrada depende del rol', () => {
  assert(C.roleBehaviour({ role: 'backend' }).inbox === 'todo', 'backend mira el backlog');
  assert(
    C.roleBehaviour({ role: 'frontend' }).inbox === 'handoff',
    'el frontend NO mira `to do`: eso es backlog del otro rol',
  );
  assert(C.roleBehaviour({ role: 'fullstack' }).inbox === 'todo', 'fullstack mira lo suyo');
});

check('un backend NUNCA pide trabajo hacia atrás', () => {
  // Sería el camino inverso del handoff, y no existe: el backend recibe pedidos, no los emite.
  for (const cp of [null, '/a/fe']) {
    assert(
      C.roleBehaviour({ role: 'backend', counterpart: cp }).canRequestFromOther === false,
      'un backend no emite pedidos al frontend',
    );
  }
});

console.log('\nCONFIG: identidad\n');

check('identityReady exige id Y confirmación', () => {
  const c = C.defaultConfig();
  assert(!C.identityReady(c), 'sin nada debería ser false');
  c.identity.clickup_user_id = '123';
  assert(!C.identityReady(c), 'con id sin confirmar debería ser false');
  c.identity.confirmed = true;
  assert(C.identityReady(c), 'con id confirmado debería ser true');
  c.identity.clickup_user_id = '   ';
  assert(!C.identityReady(c), 'un id en blanco pasó como válido');
});

check('rememberGitEmail no duplica ni distingue mayúsculas', () => {
  const c = C.defaultConfig();
  assert(C.rememberGitEmail(c, 'Primero@Example.net'), 'no agregó el primero');
  assert(!C.rememberGitEmail(c, 'primero@example.net'), 'duplicó por mayúsculas');
  assert(!C.rememberGitEmail(c, '  primero@example.net  '), 'duplicó por espacios');
  assert(!C.rememberGitEmail(c, ''), 'agregó un vacío');
  assert(!C.rememberGitEmail(c, null), 'agregó null');
  assert(c.identity.git_emails.length === 1, `quedaron ${c.identity.git_emails.length}`);
});

console.log('\nCONFIG: escritura\n');

check('saveConfig conserva claves desconocidas', () => {
  writeRawConfig({ mi_campo_propio: { a: 1 }, defaults: { use_dates: false } });
  const { config } = C.loadConfig();
  C.saveConfig(config);
  const re = C.loadConfig();
  assert(re.config.mi_campo_propio?.a === 1, 'descartó una clave que no conoce');
  assert(re.config.defaults.use_dates === false, 'pisó un valor del usuario con el default');
});

check('saveConfig no deja .tmp huérfanos', () => {
  const { config } = C.loadConfig();
  for (let i = 0; i < 5; i++) C.saveConfig(config);
  const tmps = fs.readdirSync(P.toolHome()).filter((f) => f.includes('.tmp-'));
  assert(tmps.length === 0, `quedaron ${tmps.length} temporales`);
});

console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
if (fail) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
  console.log(`\nsandbox: ${process.env.CLAUDE_CONFIG_DIR}\n`);
  process.exit(1);
}
fs.rmSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
fs.rmSync(PROJ, { recursive: true, force: true });
console.log('state.mjs + config.mjs: sin hallazgos.\n');

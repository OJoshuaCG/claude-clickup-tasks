#!/usr/bin/env node
//
// N tareas activas por proyecto, sin que se bloqueen ni se confundan entre sí.
//
// POR QUÉ EXISTE ESTE SUITE. El estado guardaba UN claim por proyecto (`claim`, objeto), y eso
// no era una regla de trabajo: era el formato. Con dos sesiones de Claude Code en el mismo repo
// —terminal e IDE, el caso normal— la segunda tarea se rechazaba pidiendo pausar la primera en
// `on hold`, y el hook `Stop` exigía sobre el claim global, así que cada sesión quedaba trabada
// por la tarea de la otra.
//
// Lo que se prueba acá es lo que reemplazó a eso, y sobre todo su riesgo nuevo: con varias
// tareas activas aparece la posibilidad de tocar la equivocada. La defensa es que NADA elige por
// defecto. Los tests que más importan son los que afirman que un comando SIN id **falla** en vez
// de adivinar, y que la evidencia de una tarea nunca verifica a otra.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CLI = path.join(REPO, 'src', 'cli.mjs');

const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-multi-'));
process.env.CLAUDE_CONFIG_DIR = claudeHome;

// El import va DESPUÉS de fijar CLAUDE_CONFIG_DIR: `paths.mjs` la lee al resolver, y un import
// estático arriba del todo se llevaría el directorio real de la máquina.
const S = await import('../src/lib/state.mjs');
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

const PROJ = P.canonicalProjectKey(fs.mkdtempSync(path.join(os.tmpdir(), 'cf-multi-proj-')));

// Ids ficticios con la convención del repo: el primer dígito codifica el nivel de la jerarquía.
fs.mkdirSync(path.join(claudeHome, 'clickup-flow'), { recursive: true });
fs.writeFileSync(
  path.join(claudeHome, 'clickup-flow', 'config.json'),
  `${JSON.stringify(
    {
      version: 1,
      identity: { clickup_user_id: '5000000001', confirmed: true, git_emails: [] },
      defaults: { block_writes_without_task: true, ask_new_projects: false, exemption_hours: 0.5 },
      projects: {
        [PROJ]: {
          mode: 'tasks',
          path: PROJ,
          name: 'multi',
          workspace_id: '1000000001',
          space_id: '2000000001',
          space_name: 'Acme',
          list_id: '4000000001',
          list_name: 'Backlog',
        },
      },
      team: {},
    },
    null,
    2,
  )}\n`,
);

/** Corre el CLI. `session` simula la sesión de Claude Code donde corre el Bash del agente. */
function cli(args, { stdin = null, session = null } = {}) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, NO_COLOR: '1' };
  if (session) env.CLAUDE_CODE_SESSION_ID = session;
  else delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync('node', [CLI, ...args], {
    env,
    cwd: PROJ,
    encoding: 'utf8',
    input: stdin ?? undefined,
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
const hook = (nombre, payload) => cli([nombre], { stdin: JSON.stringify(payload) });

const limpiar = () => S.dropState(PROJ);
const ids = () => S.activeClaims(S.readState(PROJ)).map((c) => c.task_id).sort();

/** Hace creer al harness que el `PostToolUse` de las mutaciones ya corrió alguna vez. */
function evidenciaSana() {
  fs.mkdirSync(P.statePath(), { recursive: true });
  fs.writeFileSync(
    path.join(P.statePath(), '_mcp-evidence.json'),
    JSON.stringify({ count: 1, first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString() }),
  );
}

console.log('\nEL MODELO: N CLAIMS POR PROYECTO\n');

check('dos tareas distintas conviven en el mismo proyecto', () => {
  limpiar();
  S.addClaim(PROJ, { taskId: 'A-1', title: 'Tarea A' });
  S.addClaim(PROJ, { taskId: 'B-2', title: 'Tarea B' });
  assert(ids().join(',') === 'A-1,B-2', `esperaba las dos, hay: ${ids().join(',') || '(ninguna)'}`);
});

check('reclamar la MISMA tarea dos veces actualiza, no duplica', () => {
  limpiar();
  S.addClaim(PROJ, { taskId: 'A-1', title: 'primero' });
  const antes = S.findClaim(S.readState(PROJ), 'A-1').claimed_at;
  S.addClaim(PROJ, { taskId: 'A-1', title: 'segundo', role: 'backend' });
  const st = S.readState(PROJ);
  assert(S.activeClaims(st).length === 1, 'duplicó la entrada');
  const c = S.findClaim(st, 'A-1');
  assert(c.title === 'segundo', 'no actualizó el título');
  assert(c.role === 'backend', 'no actualizó el rol');
  // El momento en que arrancó el trabajo no se pisa: es el dato que usa `hasMcpEvidence` como
  // corte, y moverlo hacia adelante invalidaría evidencia legítima ya registrada.
  assert(c.claimed_at === antes, 'pisó el claimed_at original');
});

check('la evidencia de una tarea NO verifica a la otra', () => {
  limpiar();
  S.addClaim(PROJ, { taskId: 'A-1' });
  S.addClaim(PROJ, { taskId: 'B-2' });
  S.recordMcpWrite(PROJ, { tool: 'clickup_update_task', taskId: 'B-2' });
  const st = S.readState(PROJ);
  assert(S.claimVerified(S.findClaim(st, 'B-2')), 'no verificó la tarea que recibió la mutación');
  assert(
    !S.claimVerified(S.findClaim(st, 'A-1')),
    'VERIFICÓ UNA TAREA SIN EVIDENCIA PROPIA: es exactamente el cruce que este diseño evita',
  );
});

check('removeClaim saca solo la suya y devuelve la que sacó', () => {
  limpiar();
  S.addClaim(PROJ, { taskId: 'A-1', title: 'Tarea A' });
  S.addClaim(PROJ, { taskId: 'B-2' });
  const salido = S.removeClaim(PROJ, 'A-1');
  assert(salido && salido.task_id === 'A-1', 'no devolvió el claim que sacó');
  assert(ids().join(',') === 'B-2', `dejó el estado mal: ${ids().join(',')}`);
});

check('removeClaim de un id que no está no toca nada', () => {
  limpiar();
  S.addClaim(PROJ, { taskId: 'A-1' });
  assert(S.removeClaim(PROJ, 'NO-EXISTE') === null, 'inventó un claim');
  assert(ids().join(',') === 'A-1', 'borró algo que no correspondía');
});

check('clearAllClaims vacía y devuelve cuántas había', () => {
  limpiar();
  S.addClaim(PROJ, { taskId: 'A-1' });
  S.addClaim(PROJ, { taskId: 'B-2' });
  assert(S.clearAllClaims(PROJ) === 2, 'contó mal');
  assert(ids().length === 0, 'quedaron claims');
});

console.log('\nDE QUIÉN ES CADA TAREA\n');

check('cada sesión solo se hace cargo de lo suyo', () => {
  limpiar();
  S.addClaim(PROJ, { taskId: 'A-1', session: 'sesion-a' });
  S.addClaim(PROJ, { taskId: 'B-2', session: 'sesion-b' });
  const st = S.readState(PROJ);
  const deA = S.claimsOwnedBy(st, 'sesion-a').map((c) => c.task_id);
  assert(deA.join(',') === 'A-1', `la sesión A ve: ${deA.join(',')}`);
});

check('un claim SIN sesión registrada es de todos (estado migrado del formato viejo)', () => {
  limpiar();
  S.addClaim(PROJ, { taskId: 'VIEJA' });
  assert(S.claimIsMine(S.findClaim(S.readState(PROJ), 'VIEJA'), 'cualquiera'), 'lo excluyó');
});

check('sin saber quién soy, me hago cargo de todo', () => {
  limpiar();
  S.addClaim(PROJ, { taskId: 'A-1', session: 'sesion-a' });
  // Fallar para el lado de exigir de más nunca pierde trabajo. Para el otro lado, sí.
  assert(S.claimIsMine(S.findClaim(S.readState(PROJ), 'A-1'), null), 'se desentendió');
});

console.log('\nMIGRACIÓN DEL FORMATO VIEJO\n');

function escribirEstadoCrudo(obj) {
  fs.mkdirSync(P.statePath(), { recursive: true });
  fs.writeFileSync(P.projectStateFile(PROJ), JSON.stringify({ project: PROJ, ...obj }, null, 2));
}

check('un `claim` singular en disco se lee como lista de uno', () => {
  limpiar();
  escribirEstadoCrudo({
    claim: { task_id: 'VIEJA-1', title: 'de antes', claimed_at: '2026-01-01T00:00:00.000Z' },
  });
  const st = S.readState(PROJ);
  assert(S.activeClaims(st).length === 1, 'perdió el claim viejo');
  const c = S.findClaim(st, 'VIEJA-1');
  assert(c.title === 'de antes', 'perdió el título');
  assert(c.session === null, 'le inventó una sesión');
});

check('al escribir, el campo viejo desaparece del archivo', () => {
  limpiar();
  escribirEstadoCrudo({ claim: { task_id: 'VIEJA-1' } });
  S.addClaim(PROJ, { taskId: 'NUEVA-2' });
  const crudo = JSON.parse(fs.readFileSync(P.projectStateFile(PROJ), 'utf8'));
  assert(!('claim' in crudo), 'dejó `claim` y `claims` a la vez: dos fuentes de verdad');
  assert(Array.isArray(crudo.claims) && crudo.claims.length === 2, 'no conservó las dos');
});

check('basura en `claims` se filtra sin romper', () => {
  limpiar();
  escribirEstadoCrudo({ claims: [null, 'texto', 42, { sin_id: true }, { task_id: 'BUENA' }] });
  assert(ids().join(',') === 'BUENA', `no filtró: ${JSON.stringify(ids())}`);
});

check('un `sync_failed` objeto viejo se lee como lista', () => {
  limpiar();
  escribirEstadoCrudo({ sync_failed: { task_id: 'X-1', reason: 'vieja', at: '2026-01-01T00:00:00.000Z' } });
  const st = S.readState(PROJ);
  assert(Array.isArray(st.sync_failed) && st.sync_failed.length === 1, 'perdió la deuda vieja');
});

console.log('\nDEUDAS DE SINCRONIZACIÓN: UNA POR TAREA\n');

check('dos tareas sin sincronizar dejan DOS deudas', () => {
  limpiar();
  S.setSyncFailed(PROJ, { taskId: 'A-1', reason: 'a' });
  S.setSyncFailed(PROJ, { taskId: 'B-2', reason: 'b' });
  assert(S.readState(PROJ).sync_failed.length === 2, 'una deuda pisó a la otra');
});

check('la evidencia salda SOLO la deuda de su tarea', () => {
  limpiar();
  S.setSyncFailed(PROJ, { taskId: 'A-1', reason: 'a' });
  S.setSyncFailed(PROJ, { taskId: 'B-2', reason: 'b' });
  S.recordMcpWrite(PROJ, { tool: 'clickup_update_task', taskId: 'A-1' });
  const quedan = S.readState(PROJ).sync_failed.map((d) => d.task_id);
  assert(quedan.join(',') === 'B-2', `saldó mal: quedan ${quedan.join(',') || '(ninguna)'}`);
});

console.log('\nEL CLI: NADA ELIGE POR DEFECTO\n');

check('`claim` ya no rechaza la segunda tarea del proyecto', () => {
  limpiar();
  assert(cli(['claim', '--task-id', 'A-1', '--title', 'Tarea A']).code === 0, 'falló la primera');
  const r = cli(['claim', '--task-id', 'B-2', '--title', 'Tarea B']);
  assert(r.code === 0, `rechazó la segunda: ${r.err.slice(0, 200)}`);
  assert(ids().join(',') === 'A-1,B-2', 'no quedaron las dos');
  assert(/2 tareas activas/.test(r.out), 'no avisó que ahora hay dos');
  assert(/--task-id/.test(r.out), 'no dijo que al cerrar el id es obligatorio');
});

check('`claim` NO propone pausar nada en `on hold`', () => {
  limpiar();
  cli(['claim', '--task-id', 'A-1']);
  const r = cli(['claim', '--task-id', 'B-2']);
  assert(
    !/on hold/i.test(r.out) && !/on hold/i.test(r.err),
    'sigue empujando a pausar una tarea que no está detenida por nada',
  );
});

check('`release` SIN id, con dos activas, se niega y NO toca el estado', () => {
  limpiar();
  cli(['claim', '--task-id', 'A-1', '--title', 'Tarea A']);
  cli(['claim', '--task-id', 'B-2', '--title', 'Tarea B']);
  const r = cli(['release']);
  assert(r.code === 1, `soltó algo sin que se lo dijeran (exit ${r.code})`);
  assert(ids().join(',') === 'A-1,B-2', 'CERRÓ UNA TAREA SIN QUE NADIE LA ELIGIERA');
  assert(/A-1/.test(r.err) && /B-2/.test(r.err), 'no listó las candidatas');
  assert(/--task-id/.test(r.err), 'no dijo cómo desambiguar');
});

check('`release --task-id` cierra exactamente esa y deja la otra', () => {
  limpiar();
  cli(['claim', '--task-id', 'A-1']);
  cli(['claim', '--task-id', 'B-2']);
  const r = cli(['release', '--task-id', 'A-1', '--force']);
  assert(r.code === 0, `no pudo soltar: ${r.err.slice(0, 200)}`);
  assert(ids().join(',') === 'B-2', `quedó mal: ${ids().join(',')}`);
  assert(/sigue activa/.test(r.out) && /B-2/.test(r.out), 'no avisó qué queda abierto');
});

check('`release` SIN id con UNA sola activa sigue andando', () => {
  limpiar();
  cli(['claim', '--task-id', 'A-1']);
  assert(cli(['release', '--force']).code === 0, 'rompió el caso simple');
  assert(ids().length === 0, 'no la soltó');
});

check('`release` de un id que no está reclamado acá se niega y lista lo que sí', () => {
  limpiar();
  cli(['claim', '--task-id', 'A-1']);
  const r = cli(['release', '--task-id', 'DE-OTRO-PROYECTO']);
  assert(r.code === 1, 'soltó una tarea que no estaba reclamada');
  assert(ids().join(',') === 'A-1', 'tocó el estado igual');
  assert(/A-1/.test(r.err), 'no dijo qué sí está reclamado');
});

check('`release --all` limpia todo de una', () => {
  limpiar();
  cli(['claim', '--task-id', 'A-1']);
  cli(['claim', '--task-id', 'B-2']);
  assert(cli(['release', '--all']).code === 0, 'falló');
  assert(ids().length === 0, 'quedaron claims');
});

console.log('\nEL CANDADO Y EL HOOK STOP\n');

check('cualquier tarea activa abre el candado de escritura', () => {
  limpiar();
  cli(['claim', '--task-id', 'A-1']);
  const g = hook('guard', {
    cwd: PROJ,
    tool_name: 'Write',
    tool_input: { file_path: path.join(PROJ, 'src', 'x.js') },
  });
  assert(g.code === 0, `el candado bloqueó con una tarea reclamada: ${g.err.slice(0, 200)}`);
});

check('la tarea SIN VERIFICAR de otra sesión no traba el cierre de turno de la mía', () => {
  limpiar();
  evidenciaSana();
  // Sesión A reclama y deja evidencia real. Sesión B reclama y no hace nada.
  cli(['claim', '--task-id', 'A-1'], { session: 'sesion-a' });
  cli(['claim', '--task-id', 'B-2'], { session: 'sesion-b' });
  S.recordMcpWrite(PROJ, { tool: 'clickup_update_task', taskId: 'A-1' });

  const r = hook('stop-hook', { cwd: PROJ, session_id: 'sesion-a' });
  assert(
    r.code === 0,
    `LA SESIÓN A QUEDÓ TRABADA POR LA TAREA DE B (exit ${r.code}): es el bloqueo cruzado que ` +
      `este cambio elimina. ${r.err.slice(0, 200)}`,
  );
});

check('pero a la sesión que SÍ tiene trabajo sin registrar se le sigue exigiendo', () => {
  limpiar();
  evidenciaSana();
  cli(['claim', '--task-id', 'B-2', '--title', 'Tarea B'], { session: 'sesion-b' });
  const r = hook('stop-hook', { cwd: PROJ, session_id: 'sesion-b' });
  assert(r.code === 2, `dejó cerrar el turno con trabajo sin sincronizar (exit ${r.code})`);
  assert(/B-2/.test(r.err), 'no dijo cuál tarea');
});

check('con varias pendientes propias, el aviso las nombra a todas y exige el id', () => {
  limpiar();
  evidenciaSana();
  cli(['claim', '--task-id', 'A-1', '--title', 'Tarea A'], { session: 'sesion-a' });
  cli(['claim', '--task-id', 'B-2', '--title', 'Tarea B'], { session: 'sesion-a' });
  const r = hook('stop-hook', { cwd: PROJ, session_id: 'sesion-a' });
  assert(r.code === 2, 'no exigió nada');
  assert(/A-1/.test(r.err) && /B-2/.test(r.err), 'no nombró las dos');
  assert(/--task-id/.test(r.err), 'no dijo que el id es obligatorio para resolverlas');
});

console.log('\nEL NOMBRE CANÓNICO DE LA TAREA\n');

// POR QUÉ ESTA SECCIÓN. El `title` del claim lo escribe el modelo y nada lo ata al `name` real de
// la tarea. Cuando divergen, un lector posterior no distingue "el título describe otra cosa" de
// "el estado está corrupto" — y eso produjo un `release --force` sobre el claim de otra sesión.

const CREATE = 'mcp__claude_ai_ClickUp__clickup_create_task';
const UPDATE = 'mcp__claude_ai_ClickUp__clickup_update_task';

check('el nombre se archiva aunque el claim todavía no exista', () => {
  limpiar();
  // Es el orden NORMAL del protocolo: primero se crea la tarea por MCP, después se reclama.
  S.recordTaskName(PROJ, { taskId: 'TAREA-1', name: 'Nombre real' });
  assert(S.activeClaims(S.readState(PROJ)).length === 0, 'inventó un claim');
  S.addClaim(PROJ, { taskId: 'TAREA-1', title: 'lo que voy a hacer' });
  const c = S.findClaim(S.readState(PROJ), 'TAREA-1');
  assert(c.clickup_name === 'Nombre real', `addClaim no lo recogió: ${c.clickup_name}`);
});

check('registrar un nombre NO es evidencia de trabajo', () => {
  limpiar();
  S.addClaim(PROJ, { taskId: 'TAREA-1', title: 'x' });
  S.recordTaskName(PROJ, { taskId: 'TAREA-1', name: 'Nombre real' });
  const st = S.readState(PROJ);
  assert(
    !S.claimVerified(S.findClaim(st, 'TAREA-1')),
    'UN RENOMBRE ABRIÓ EL CANDADO: se podría soltar el claim sin haber comentado ni cerrado nada',
  );
  assert((st.mcp?.writes ?? []).length === 0, 'ensució el registro de mutaciones');
});

check('el nombre llega al claim que ya estaba', () => {
  limpiar();
  S.addClaim(PROJ, { taskId: 'TAREA-1', title: 'x' });
  S.addClaim(PROJ, { taskId: 'OTRA-2', title: 'y' });
  S.recordTaskName(PROJ, { taskId: 'TAREA-1', name: 'Nombre real' });
  const st = S.readState(PROJ);
  assert(S.findClaim(st, 'TAREA-1').clickup_name === 'Nombre real', 'no lo escribió');
  assert(S.findClaim(st, 'OTRA-2').clickup_name === null, 'se lo pegó a la tarea equivocada');
});

check('la divergencia se detecta, y solo cuando es real', () => {
  assert(S.claimNameMismatch({ title: 'una cosa', clickup_name: 'otra cosa' }), 'no vio la diferencia');
  assert(!S.claimNameMismatch({ title: 'igual', clickup_name: 'igual' }), 'marcó dos iguales');
  // Sin nombre canónico no hay con qué comparar: afirmar una divergencia indemostrable es
  // exactamente el dato engañoso que esto viene a eliminar.
  assert(!S.claimNameMismatch({ title: 'algo', clickup_name: null }), 'inventó una divergencia');
  assert(!S.claimNameMismatch({ title: null, clickup_name: 'algo' }), 'inventó una divergencia');
  assert(
    !S.claimNameMismatch({ title: '  Hola   Mundo ', clickup_name: 'hola mundo' }),
    'marcó una diferencia de espacios y mayúsculas: un aviso que aparece siempre se deja de leer',
  );
});

check('el archivo de nombres no crece sin límite', () => {
  limpiar();
  for (let i = 0; i < 60; i++) S.recordTaskName(PROJ, { taskId: `TAREA-${i}`, name: `n${i}` });
  const names = S.readState(PROJ).mcp?.names ?? {};
  assert(Object.keys(names).length <= 40, `guardó ${Object.keys(names).length} nombres`);
  assert(names['TAREA-59'] === 'n59', 'tiró el más reciente en vez del más viejo');
});

check('el hook saca el nombre de `create_task` (id de la RESPUESTA)', () => {
  limpiar();
  hook('sync-hook', {
    cwd: PROJ,
    tool_name: CREATE,
    tool_input: { name: 'Nombre real', list_id: '4000000001' },
    tool_response: { success: true, task_id: '86e3auq8z', task_url: 'https://app.clickup.com/t/86e3auq8z' },
  });
  assert(
    (S.readState(PROJ).mcp?.names ?? {})['86e3auq8z'] === 'Nombre real',
    'no archivó el nombre con el que nació la tarea',
  );
});

check('el hook saca el nombre de `update_task` cuando renombra (id de la ENTRADA)', () => {
  limpiar();
  hook('sync-hook', {
    cwd: PROJ,
    tool_name: UPDATE,
    tool_input: { task_id: '86e3auq8z', name: 'Nombre nuevo' },
    tool_response: { success: true, task_id: '86e3auq8z' },
  });
  assert((S.readState(PROJ).mcp?.names ?? {})['86e3auq8z'] === 'Nombre nuevo', 'no siguió el renombre');
});

check('un `update_task` que NO renombra no inventa un nombre', () => {
  limpiar();
  hook('sync-hook', {
    cwd: PROJ,
    tool_name: UPDATE,
    tool_input: { task_id: '86e3auq8z', status: 'in progress' },
    tool_response: { success: true, task_id: '86e3auq8z' },
  });
  assert(Object.keys(S.readState(PROJ).mcp?.names ?? {}).length === 0, 'archivó un nombre fantasma');
});

check('un comentario no aporta nombre, aunque lleve un `name` adentro', () => {
  limpiar();
  hook('sync-hook', {
    cwd: PROJ,
    tool_name: 'mcp__claude_ai_ClickUp__clickup_create_comment',
    tool_input: { entity_id: '86e3auq8z', comment_text: 'algo', name: 'NO ES EL NOMBRE DE LA TAREA' },
    tool_response: { success: true, comment_id: '900' },
  });
  assert(
    Object.keys(S.readState(PROJ).mcp?.names ?? {}).length === 0,
    'tomó por nombre de tarea un campo de otra herramienta',
  );
});

check('`status` muestra el nombre real solo cuando difiere', () => {
  limpiar();
  hook('sync-hook', {
    cwd: PROJ,
    tool_name: CREATE,
    tool_input: { name: 'Nombre real' },
    tool_response: { success: true, task_id: '86e3auq8z' },
  });
  cli(['claim', '--task-id', '86e3auq8z', '--title', 'describe el alcance']);
  assert(/en ClickUp se llama: Nombre real/.test(cli(['status']).out), 'no marcó la divergencia');

  cli(['release', '--task-id', '86e3auq8z', '--force']);
  cli(['claim', '--task-id', '86e3auq8z', '--title', 'Nombre real']);
  assert(!/en ClickUp se llama/.test(cli(['status']).out), 'lo repitió cuando coincidían: es ruido');
});

console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
if (fail) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
  console.log(`\nsandbox: ${claudeHome}\n`);
  process.exit(1);
}
fs.rmSync(claudeHome, { recursive: true, force: true });
fs.rmSync(PROJ, { recursive: true, force: true });
console.log('multitarea: sin hallazgos.\n');

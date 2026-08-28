#!/usr/bin/env node
//
// Los dos mecanismos que redefinen qué es esta herramienta, probados de punta a punta.
//
// 1. DESCUBRIMIENTO. Un proyecto que la herramienta nunca vio tiene que PREGUNTAR una vez, y
//    después dejar trabajar. El bug que esto previene es el que hizo que la herramienta no se
//    activara nunca en el segundo proyecto ni en los siguientes: `pending` y `excluded` se
//    comportaban idéntico, así que el default era el silencio permanente.
//
// 2. EVIDENCIA. Un claim está verificado cuando el harness VIO la mutación MCP, no cuando el
//    modelo la anunció. Es lo que cierra el hueco entre "los hooks son deterministas pero no
//    pueden escribir en ClickUp" y "el modelo puede escribir pero no está obligado a nada".
//
// Todo corre contra un CLAUDE_CONFIG_DIR descartable, y los hooks se invocan como los invoca el
// harness: JSON por stdin, decisión por código de salida.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { canonicalProjectKey } from '../src/lib/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'src', 'cli.mjs');

let pass = 0;
let fail = 0;

function assert(cond, label, detalle = '') {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${detalle ? `\n         ${detalle}` : ''}`);
  }
}

// ---------------------------------------------------------------------------------------------
// sandbox
// ---------------------------------------------------------------------------------------------

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'clickup-descubrimiento-'));
const claudeHome = path.join(sandbox, 'claude');
const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeHome };

const NUEVO = canonicalProjectKey(path.join(sandbox, 'repo-nuevo'));
const ACTIVO = canonicalProjectKey(path.join(sandbox, 'repo-activo'));
const WORKTREE = `${ACTIVO}/.claude/worktrees/feat-x`;

for (const d of [`${NUEVO}/src`, `${ACTIVO}/src`, `${WORKTREE}/src`]) {
  fs.mkdirSync(d, { recursive: true });
}
fs.mkdirSync(path.join(claudeHome, 'clickup-flow'), { recursive: true });

// Ids ficticios con la convención del repo: el primer dígito codifica el nivel de la jerarquía.
fs.writeFileSync(
  path.join(claudeHome, 'clickup-flow', 'config.json'),
  `${JSON.stringify(
    {
      version: 1,
      identity: { clickup_user_id: '5000000001', confirmed: true, git_emails: [] },
      defaults: {
        block_writes_without_task: true,
        ask_new_projects: true,
        snooze_days: 7,
        exemption_hours: 8,
      },
      projects: {
        [ACTIVO]: {
          mode: 'tasks',
          path: ACTIVO,
          name: 'repo-activo',
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

/** Corre un subcomando del CLI. Devuelve `{ code, out, err }`. */
function cli(args, stdin = null) {
  const r = spawnSync('node', [CLI, ...args], { env, encoding: 'utf8', input: stdin ?? undefined });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** Invoca un hook igual que el harness: payload JSON por stdin. */
function hook(nombre, payload) {
  return cli([nombre], JSON.stringify(payload));
}

const guard = (cwd, file, solicitud = null) =>
  hook('guard', {
    cwd,
    tool_name: 'Write',
    tool_input: { file_path: file },
    ...(solicitud ? { prompt_id: solicitud } : {}),
  });
const guardBash = (cwd, command) =>
  hook('guard', { cwd, tool_name: 'Bash', tool_input: { command } });

function leerConfig() {
  return JSON.parse(fs.readFileSync(path.join(claudeHome, 'clickup-flow', 'config.json'), 'utf8'));
}

// ---------------------------------------------------------------------------------------------

console.log('\nDESCUBRIMIENTO: UN PROYECTO NUEVO PREGUNTA UNA VEZ\n');

{
  const r = guard(NUEVO, `${NUEVO}/src/app.py`);
  assert(r.code === 2, 'la primera escritura en un proyecto desconocido BLOQUEA', `exit ${r.code}`);
  assert(
    /clickup-setup/.test(r.err) && /exclude/.test(r.err) && /snooze/.test(r.err),
    'el mensaje ofrece los tres caminos, no uno',
  );
  assert(
    /No decidas vos/i.test(r.err),
    'le prohíbe al modelo contestar por el usuario',
  );
}

assert(leerConfig().projects[NUEVO]?.mode === 'pending', 'el proyecto queda registrado como `pending`');
assert(
  Boolean(leerConfig().projects[NUEVO]?.first_seen),
  '`first_seen` deja fecha: "nunca lo vi" pasa a ser un hecho con historia',
);

{
  // "Omitir" está acotado a la SOLICITUD, no a los días.
  //
  // La primera versión posponía 7 días al preguntar, y eso era la queja original en cámara
  // lenta: si el usuario ignoraba la pregunta una vez, el proyecto quedaba sin decidir una
  // semana y la herramienta no hacía nada. Ahora el resto de la MISMA solicitud sigue sin
  // interrupciones, y la siguiente vuelve a preguntar hasta que haya un sí o un no.
  const r = guard(NUEVO, `${NUEVO}/src/otro.py`, 'solicitud-1');
  assert(r.code === 2, 'no preguntó en una solicitud nueva', `exit ${r.code}`);

  const mismo = guard(NUEVO, `${NUEVO}/src/tercero.py`, 'solicitud-1');
  assert(mismo.code === 0, 'volvió a interrumpir dentro de la MISMA solicitud', `exit ${mismo.code}`);

  const siguiente = guard(NUEVO, `${NUEVO}/src/cuarto.py`, 'solicitud-2');
  assert(siguiente.code === 2, 'no volvió a preguntar en la solicitud siguiente');

  assert(
    /OMITIR/.test(siguiente.err) && /EJECUTÁ SU RESPUESTA/.test(siguiente.err),
    'el mensaje no le ordena al modelo ejecutar la respuesta',
  );
}

{
  // Aplazamiento EXPLÍCITO por días: sigue existiendo como escape, y ese sí calla varias
  // solicitudes seguidas.
  cli(['project', 'snooze', '--days', '7', '--cwd', NUEVO]);
  assert(
    guard(NUEVO, `${NUEVO}/src/quinto.py`, 'solicitud-3').code === 0,
    '`project snooze --days` no silenció la pregunta',
  );
  cli(['project', 'forget', '--cwd', NUEVO]);
}

{
  const r = cli(['project', 'exclude', '--cwd', NUEVO, '--reason', 'repo de juguete']);
  assert(r.code === 0, '`project exclude` responde que no');
  assert(leerConfig().projects[NUEVO]?.mode === 'excluded', 'la respuesta queda registrada');
  const g = guard(NUEVO, `${NUEVO}/src/app.py`);
  assert(g.code === 0 && !g.err.trim(), 'un proyecto excluido nunca más molesta, ni con un mensaje');
}

console.log('\nEL ESTADO PENDING NO SE CONFUNDE CON NADA\n');

{
  const ctx = cli(['context', '--cwd', ACTIVO]);
  assert(/Protocolo de tareas ClickUp/.test(ctx.out), 'un proyecto activo rinde el protocolo');
  const doc = cli(['doctor', '--cwd', `${sandbox}/inexistente`]);
  assert(
    /NO se aplica/.test(doc.out),
    'doctor dice que el protocolo NO se aplica en un directorio sin registrar',
  );
  assert(
    /ESTE DIRECTORIO/.test(doc.out),
    'doctor empieza por el directorio actual, no por la instalación',
  );
  const docActivo = cli(['doctor', '--cwd', ACTIVO]);
  assert(/SÍ se aplica/.test(docActivo.out), 'y dice que SÍ se aplica donde corresponde');
}

console.log('\nEL CANDADO CUBRE BASH (punto 3)\n');

{
  const casos = [
    [`cat > ${ACTIVO}/src/app.py <<EOF\nx\nEOF`, 2, 'heredoc'],
    [`sed -i 's/a/b/' ${ACTIVO}/src/app.py`, 2, 'sed -i'],
    [`tee ${ACTIVO}/src/app.py`, 2, 'tee'],
    ['git apply /tmp/parche.diff', 2, 'git apply'],
    [`printf x > ${ACTIVO}/src/app.py`, 2, 'redirección'],
    ['ls -la && rg foo', 0, 'lecturas puras'],
    ['echo hola > /dev/null', 0, '> /dev/null'],
    [`cat > ${ACTIVO}/CLAUDE.md <<EOF\nx\nEOF`, 0, 'escribir CLAUDE.md (exento)'],
    [`cat > ${ACTIVO}/.claude/settings.json <<EOF\n{}\nEOF`, 0, 'escribir .claude/ (exento)'],
  ];
  for (const [cmd, esperado, etiqueta] of casos) {
    const r = guardBash(ACTIVO, cmd);
    assert(r.code === esperado, `Bash: ${etiqueta} → exit ${esperado}`, `dio exit ${r.code}`);
  }
}

console.log('\nEL WORKTREE NO EXIME EL REPO (punto 4)\n');

{
  const r = guard(WORKTREE, `${WORKTREE}/src/app.py`);
  assert(r.code === 2, 'código dentro de un worktree SIGUE bloqueado', `exit ${r.code}`);
  const c = guard(WORKTREE, `${WORKTREE}/.claude/settings.json`);
  assert(c.code === 0, 'pero la config DENTRO del worktree sigue exenta');
  const desdeRepo = guard(ACTIVO, `${WORKTREE}/src/app.py`);
  assert(desdeRepo.code === 2, 'y tampoco se exime vista desde la raíz del repo');
}

console.log('\nLA VÁLVULA: SIN PLOMERÍA PROBADA NO SE EXIGE NADA\n');

const TAREA = '86abc1234';

{
  // La verificación entera depende de que el matcher del `PostToolUse` case el nombre de las
  // herramientas del conector. Si no casa, el hook nunca corre — y sin esta válvula eso
  // bloquearía TODOS los turnos acusando al usuario de no sincronizar algo que sincronizó bien.
  // Un problema de plomería no puede trabar la máquina: se falla ABIERTO, como todo el resto.
  cli(['claim', '--task-id', TAREA, '--title', 'Arreglar el login', '--cwd', ACTIVO]);

  const doc = cli(['doctor', '--cwd', ACTIVO]);
  assert(/DESARMADA/.test(doc.out), 'doctor no avisa que la obligación está desarmada');

  const stop = hook('stop-hook', { cwd: ACTIVO, session_id: 'sin-plomeria' });
  assert(stop.code === 0, 'el Stop bloqueó sin haber visto NUNCA una mutación MCP');
  assert(/no se exige nada/i.test(stop.err), 'bloqueó en silencio en vez de explicar');

  const rel = cli(['release', '--cwd', ACTIVO]);
  assert(/nunca corrió/.test(rel.out), 'release no explica que la culpa es de la plomería');
}

console.log('\nEVIDENCIA: EL CLAIM NO SE CREE, SE VERIFICA\n');

{
  // A partir de acá la plomería YA demostró funcionar, así que la obligación se arma sola.
  // Una mutación sobre una tarea ajena alcanza: lo que prueba es que el hook corre.
  hook('sync-hook', {
    cwd: ACTIVO,
    tool_name: 'mcp__claude_ai_ClickUp__clickup_update_task',
    tool_input: { taskId: 'PLOMERIA-OK' },
    tool_response: { id: 'PLOMERIA-OK', name: 'prueba de que el hook corre' },
  });
  const doc = cli(['doctor', '--cwd', ACTIVO]);
  assert(!/DESARMADA/.test(doc.out), 'doctor sigue diciendo desarmada tras ver una mutación');
}

{
  const r = cli(['claim', '--task-id', TAREA, '--title', 'Arreglar el login', '--cwd', ACTIVO]);
  assert(r.code === 0, 'se puede reclamar una tarea');
  assert(
    /Sin evidencia todavía/.test(r.out),
    'pero avisa que el harness no vio ninguna llamada MCP sobre ella',
  );
  assert(guard(ACTIVO, `${ACTIVO}/src/app.py`).code === 0, 'con claim, la escritura pasa');
}

{
  const r = cli(['release', '--cwd', ACTIVO]);
  assert(r.code === 1, 'NO se puede soltar una tarea sin ninguna mutación registrada');
  assert(/ninguna mutación/i.test(r.err), 'y lo dice explicando por qué');
}

console.log('\nEL HOOK Stop NO DEJA CERRAR EL TURNO\n');

{
  assert(hook('stop-hook', { cwd: ACTIVO, session_id: 's1' }).code === 2, 'primer intento: bloquea');
  assert(hook('stop-hook', { cwd: ACTIVO, session_id: 's1' }).code === 2, 'segundo intento: bloquea');
  const tercero = hook('stop-hook', { cwd: ACTIVO, session_id: 's1' });
  assert(
    tercero.code === 0,
    'tercer intento: SUELTA — un hook que bloquea para siempre cuelga la sesión',
  );
  assert(/SIN sincronizar/.test(tercero.err), 'pero deja dicho que se cerró sin sincronizar');
  assert(
    guard(ACTIVO, `${ACTIVO}/src/app.py`).code === 2,
    'y el candado NO se vuelve a abrir: el fallo no se pierde, se traslada',
  );
}

console.log('\nUNA MUTACIÓN REAL SALDA LA DEUDA\n');

{
  // Así es como llega la evidencia: PostToolUse con el resultado real de la herramienta MCP.
  const r = hook('sync-hook', {
    cwd: ACTIVO,
    tool_name: 'mcp__claude_ai_ClickUp__clickup_create_task_comment',
    tool_input: { taskId: TAREA, commentText: 'INICIO' },
    tool_response: { id: 'comentario-1' },
  });
  assert(r.code === 0, 'el sync-hook nunca falla ruidosamente');
  assert(
    guard(ACTIVO, `${ACTIVO}/src/app.py`).code === 0,
    'con evidencia, el candado vuelve a dejar pasar',
  );
  assert(
    hook('stop-hook', { cwd: ACTIVO, session_id: 's2' }).code === 0,
    'y el turno ya puede cerrarse',
  );
  assert(cli(['release', '--cwd', ACTIVO]).code === 0, 'y la tarea se puede soltar');
}

console.log('\nLA EVIDENCIA NO CONFUNDE UNA LISTA CON UNA TAREA\n');

{
  // Un falso "verificado" es peor que no verificar: reintroduce la confianza sin evidencia que
  // este hook vino a eliminar. La respuesta de una tarea trae `list.id`, `space.id`, `creator.id`
  // anidados, y ninguno de esos es el id de la tarea.
  cli(['claim', '--task-id', '86zzz9999', '--title', 'Otra', '--cwd', ACTIVO]);
  hook('sync-hook', {
    cwd: ACTIVO,
    tool_name: 'mcp__claude_ai_ClickUp__clickup_create_task',
    tool_input: { listId: '4000000001', name: 'Otra' },
    tool_response: {
      id: '86www1111',
      name: 'Otra',
      list: { id: '4000000001', name: 'Backlog' },
      space: { id: '2000000001' },
      creator: { id: '5000000001' },
    },
  });
  assert(
    cli(['release', '--cwd', ACTIVO]).code === 1,
    'una mutación sobre OTRA tarea no verifica la reclamada',
  );
  assert(
    cli(['release', '--force', '--cwd', ACTIVO]).code === 0,
    '`--force` sigue siendo la salida documentada para un claim equivocado',
  );
}

console.log('\nADOPCIÓN POR ORGANIZACIÓN\n');

{
  const OTRO = canonicalProjectKey(path.join(sandbox, 'repo-hermano'));
  fs.mkdirSync(`${OTRO}/src`, { recursive: true });
  const r = cli(['project', 'adopt', '--like', ACTIVO, '--cwd', OTRO]);
  assert(r.code === 0, '`project adopt --like` copia el destino de otro proyecto');
  const e = leerConfig().projects[OTRO];
  assert(e?.list_id === '4000000001', 'hereda la lista destino');
  assert(e?.mode === 'tasks', 'hereda el modo');
  assert(e?.adopted_from === ACTIVO, 'y deja registrado de dónde salió');
  assert(
    e?.role === undefined || e.role === null,
    'pero NO hereda el rol: heredarlo crearía entregas hacia quien no corresponde',
  );
}

console.log('\nUN CONFIG ILEGIBLE NUNCA BLOQUEA\n');

{
  fs.writeFileSync(path.join(claudeHome, 'clickup-flow', 'config.json'), '{ esto no es json');
  assert(guard(ACTIVO, `${ACTIVO}/src/app.py`).code === 0, 'guard falla ABIERTO');
  assert(guardBash(ACTIVO, 'cat > x.py <<EOF\nx\nEOF').code === 0, 'guard por Bash falla ABIERTO');
  assert(hook('stop-hook', { cwd: ACTIVO, session_id: 's3' }).code === 0, 'stop-hook no bloquea');
  assert(hook('sync-hook', { cwd: ACTIVO, tool_name: 'x' }).code === 0, 'sync-hook no rompe');
  assert(hook('session-start', { cwd: ACTIVO }).code === 0, 'session-start no rompe');
}

fs.rmSync(sandbox, { recursive: true, force: true });

console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
//
// El cronómetro de ClickUp: las horas de quién, y quién apaga el reloj.
//
// Este suite cubre tres cosas que se rompen de formas distintas, y ninguna es "arranca y para":
//
// 1. ATRIBUCIÓN. Las herramientas de tiempo del MCP no reciben a quién se le carga la hora — el
//    reloj corre SIEMPRE a nombre del dueño del token OAuth. Es el mismo agujero que hace que
//    `"me"` esté prohibido para asignar, pero sobre horas facturables y sin ningún error que
//    revisar. El cronómetro no se ofrece hasta que se pruebe que el token es de quien ejecuta.
//
// 2. EVIDENCIA QUE NO MIENTE. ClickUp permite UN solo reloj por persona, así que arrancar uno con
//    otro andando FALLA — y `tool_input` está igual de presente cuando falla. Anotar el arranque
//    desde la entrada dejaría un reloj fantasma trabando `release` para siempre.
//
// 3. SEPARACIÓN DE REGISTROS. Prender el reloj NO es evidencia de que el trabajo quedó anotado en
//    la tarea. Si contara, alcanzaría con un cronómetro para abrir el candado de escritura.
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

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'clickup-cronometro-'));
const claudeHome = path.join(sandbox, 'claude');
const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeHome };

const REPO = canonicalProjectKey(path.join(sandbox, 'repo'));
fs.mkdirSync(path.join(REPO, 'src'), { recursive: true });
fs.mkdirSync(path.join(claudeHome, 'clickup-flow'), { recursive: true });

// Ids ficticios con la convención del repo: el primer dígito codifica el nivel de la jerarquía.
const YO = '5000000001';
const OTRA_PERSONA = '5000000099';

function escribirConfig(extra = {}) {
  fs.writeFileSync(
    path.join(claudeHome, 'clickup-flow', 'config.json'),
    `${JSON.stringify(
      {
        version: 1,
        identity: {
          clickup_user_id: YO,
          clickup_email: 'yo@acme.test',
          confirmed: true,
          git_emails: [],
          token_user_id: null,
          token_checked_at: null,
          ...(extra.identity || {}),
        },
        defaults: {
          block_writes_without_task: true,
          ask_new_projects: true,
          snooze_days: 7,
          exemption_hours: 8,
          track_time: false,
        },
        projects: {
          [REPO]: {
            mode: 'tasks',
            path: REPO,
            name: 'repo',
            workspace_id: '1000000001',
            space_id: '2000000001',
            space_name: 'Acme',
            list_id: '4000000001',
            list_name: 'Backlog',
            overrides: { track_time: true },
            ...(extra.project || {}),
          },
        },
        team: {},
      },
      null,
      2,
    )}\n`,
  );
}

escribirConfig();

/** Corre un subcomando del CLI. Devuelve `{ code, out, err }`. */
function cli(args, stdin = null, cwd = REPO) {
  const r = spawnSync('node', [CLI, ...args], {
    env,
    cwd,
    encoding: 'utf8',
    input: stdin ?? undefined,
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/** Invoca un hook igual que el harness: payload JSON por stdin. */
function hook(nombre, payload) {
  return cli([nombre], JSON.stringify(payload));
}

const tool = (n) => `mcp__claude_ai_ClickUp__${n}`;

const arrancar = (respuesta, taskId = '9001') =>
  hook('timer-hook', {
    cwd: REPO,
    tool_name: tool('clickup_start_time_tracking'),
    tool_input: { task_id: taskId },
    tool_response: respuesta,
  });

const parar = (respuesta) =>
  hook('timer-hook', {
    cwd: REPO,
    tool_name: tool('clickup_stop_time_tracking'),
    tool_input: {},
    tool_response: respuesta,
  });

/** Una entrada de tiempo como la devuelve ClickUp cuando la llamada SÍ sucedió. */
const entradaAbierta = (taskId = '9001') => ({
  id: '77771',
  start: '1756400000000',
  task: { id: taskId, name: 'prueba' },
  task_url: `https://app.clickup.com/t/${taskId}`,
});

const entradaCerrada = (taskId = '9001') => ({
  ...entradaAbierta(taskId),
  end: '1756403600000',
  duration: 3600000,
});

/** Una mutación real sobre la tarea: es lo que habilita a soltar el claim. */
const mutacion = (taskId = '9001') =>
  hook('sync-hook', {
    cwd: REPO,
    tool_name: tool('clickup_update_task'),
    tool_input: { task_id: taskId },
    tool_response: { id: taskId, name: 'prueba' },
  });

function leerEstado() {
  const dir = path.join(claudeHome, 'clickup-flow', 'state');
  const archivo = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => path.join(dir, f))[0];
  return archivo ? JSON.parse(fs.readFileSync(archivo, 'utf8')) : null;
}

// ---------------------------------------------------------------------------------------------

console.log('\nATRIBUCIÓN: EL RELOJ NO ARRANCA SI LAS HORAS SON DE OTRO\n');

{
  const r = cli(['timer', 'status']);
  assert(/SIN RESOLVER \(unchecked\)/.test(r.out), 'sin verificar, la atribución está sin resolver');
  assert(
    /dueño del token/i.test(r.out),
    'y explica el porqué: el reloj corre a nombre del dueño del token',
  );
}

{
  const r = cli(['context']);
  assert(
    /NO se puede usar todavía/.test(r.out),
    'el protocolo NO imprime la llamada de arranque mientras la atribución esté sin resolver',
  );
  assert(
    !/^clickup_start_time_tracking$/m.test(r.out),
    'y no deja el bloque de arranque suelto para que el modelo lo copie igual',
  );
}

{
  const r = cli(['timer', 'verify', '--user-id', OTRA_PERSONA]);
  assert(r.code === 1, 'verificar contra un token ajeno FALLA', `exit ${r.code}`);
  assert(
    r.err.includes(OTRA_PERSONA) && r.err.includes(YO),
    'y dice los dos ids, para que se entienda a quién se le cargarían las horas',
  );
  assert(
    /facturaci|Connectors/i.test(r.err),
    'ofrece la salida real: conectar la cuenta propia, no un flag para saltearlo',
  );
}

{
  // El veredicto ajeno queda GUARDADO. Sin esto, cada sesión volvería a preguntar y la respuesta
  // "el token no es tuyo" no tendría dónde vivir.
  const r = cli(['context']);
  assert(
    /es de otra persona/.test(r.out),
    'con el token ajeno verificado, el protocolo lo declara desactivado y lo explica',
  );
}

{
  const r = cli(['timer', 'verify', '--user-id', YO]);
  assert(r.code === 0, 'verificar contra el token propio pasa', `exit ${r.code}`);
  assert(/es tuyo/.test(r.out), 'y lo confirma explícitamente');
}

{
  const r = cli(['context']);
  assert(
    /clickup_start_time_tracking/.test(r.out) && /clickup_stop_time_tracking/.test(r.out),
    'recién ahí el protocolo imprime las llamadas de arranque y de parada',
  );
  assert(
    r.out.indexOf('clickup_stop_time_tracking') < r.out.indexOf('status:  "complete"'),
    'y la parada va ANTES del cierre: al revés, un turno cortado deja el reloj sobre una tarea cerrada',
  );
}

console.log('\nEL CANDADO DE ATRIBUCIÓN ES UN HOOK, NO UN PÁRRAFO\n');

const guardTiempo = (herramienta) =>
  hook('timer-guard', {
    cwd: REPO,
    tool_name: tool(herramienta),
    tool_input: { task_id: '9001' },
  });

{
  // Explicar no es impedir. El protocolo ya dice que el reloj corre a nombre del dueño del
  // token, pero una instrucción se puede olvidar o diluir en una compactación — y acá el daño
  // es en los datos de otra persona. Por eso lo ejecuta el harness.
  cli(['timer', 'verify', '--user-id', OTRA_PERSONA]);

  const r = guardTiempo('clickup_start_time_tracking');
  assert(r.code === 2, 'con el token ajeno, arrancar el cronómetro se CANCELA', `exit ${r.code}`);
  assert(/BLOQUEADO/.test(r.err), 'y lo dice sin ambigüedad');
  assert(
    /NO se resuelve reintentando/.test(r.err),
    'y le corta el reintento al modelo: la herramienta no tiene cómo asignar la hora',
  );

  assert(
    guardTiempo('clickup_add_time_entry').code === 2,
    'la carga manual de horas se cancela igual: el daño es el mismo',
  );
}

{
  // La excepción que evita que el candado sea una trampa. Parar un reloj no puede hacer daño, y
  // es justo lo que hay que poder hacer cuando algo salió mal.
  const r = guardTiempo('clickup_stop_time_tracking');
  assert(r.code === 0, 'PARAR el reloj nunca se bloquea, ni con la atribución rota', `exit ${r.code}`);
}

{
  const antes = guardTiempo('clickup_start_time_tracking');
  cli(['timer', 'verify', '--user-id', YO]);
  const despues = guardTiempo('clickup_start_time_tracking');
  assert(antes.code === 2 && despues.code === 0, 'verificar la atribución levanta el candado');
}

console.log('\nUNA LLAMADA QUE FALLÓ NO ES UN RELOJ CORRIENDO\n');

cli(['claim', '--task-id', '9001', '--title', 'prueba']);

{
  // El caso real: ya había otro cronómetro andando, así que este arranque falla. `tool_input`
  // trae el task_id igual. Anotarlo desde ahí dejaría un reloj fantasma bloqueando `release`.
  arrancar({ isError: true, content: 'Only one timer can be running at a time' });
  assert(!leerEstado()?.timer, 'un arranque con isError NO se anota');

  arrancar('Error: Only one timer can be running at a time');
  assert(!leerEstado()?.timer, 'ni uno cuya respuesta es el texto del error');

  arrancar({ content: 'Needs authentication' });
  assert(!leerEstado()?.timer, 'ni uno con el conector desconectado');
}

{
  const r = cli(['timer', 'status']);
  assert(/hook            armado/.test(r.out), 'pero las llamadas fallidas SÍ prueban que el matcher coincide');
  assert(/cronómetro      parado/.test(r.out), 'y el cronómetro sigue parado');
}

{
  arrancar(entradaAbierta());
  const t = leerEstado()?.timer;
  assert(Boolean(t?.started_at) && !t?.stopped_at, 'un arranque CONFIRMADO por la respuesta sí se anota');
  assert(t?.task_id === '9001', 'sobre la tarea que dice la entrada de tiempo, no el id de la entrada');
}

{
  // La asimetría deliberada: un `stop` que no se pudo confirmar deja el reloj corriendo, porque
  // si el stop falló el reloj EFECTIVAMENTE sigue corriendo.
  parar({ isError: true, content: 'Needs authentication' });
  assert(!leerEstado()?.timer?.stopped_at, 'un `stop` fallido NO apaga el registro');
}

console.log('\nNO SE CIERRA LA TAREA DEJANDO EL RELOJ CORRIENDO\n');

mutacion();

{
  const r = cli(['release']);
  assert(r.code === 1, '`release` se niega con el cronómetro corriendo', `exit ${r.code}`);
  assert(/CORRIENDO/.test(r.err), 'y dice exactamente por qué');
  assert(
    /timer clear/.test(r.err) && /--force/.test(r.err),
    'con las dos salidas: reconciliar si ya se paró por fuera, o soltar igual a propósito',
  );
  assert(Boolean(leerEstado()?.claim), 'y el claim NO se soltó');
}

{
  parar(entradaCerrada());
  const r = cli(['release']);
  assert(r.code === 0, 'con el reloj parado, `release` suelta normalmente', `exit ${r.code}`);
  assert(!leerEstado()?.claim, 'el claim quedó liberado');
  assert(!leerEstado()?.timer, 'y el cronómetro ya parado se limpia con él');
}

console.log('\nEL CRONÓMETRO NO ABRE EL CANDADO DE ESCRITURA\n');

{
  // El error que esta separación evita: si prender el reloj contara como evidencia, se podría
  // reclamar, prender, escribir código y soltar sin haber comentado ni cerrado NADA.
  cli(['claim', '--task-id', '9002', '--title', 'otra']);
  arrancar(entradaAbierta('9002'), '9002');
  parar(entradaCerrada('9002'));

  const r = cli(['release']);
  assert(r.code === 1, 'un ciclo completo de cronómetro NO habilita a soltar el claim', `exit ${r.code}`);
  assert(
    /no hay NINGUNA mutación/.test(r.err),
    'porque un reloj no es evidencia de que el trabajo quedó anotado en la tarea',
  );
}

{
  mutacion('9002');
  assert(cli(['release']).code === 0, 'con la mutación real, sí');
}

console.log('\nEL RELOJ OLVIDADO SE DESCUBRE AL ABRIR SESIÓN\n');

{
  cli(['claim', '--task-id', '9003', '--title', 'nocturna']);
  arrancar(entradaAbierta('9003'), '9003');

  const r = hook('session-start', { cwd: REPO });
  assert(/CRONÓMETRO CORRIENDO/.test(r.out), 'SessionStart avisa del reloj que quedó andando');
  assert(/9003/.test(r.out), 'con la tarea sobre la que corre');
}

{
  // Apagar la preferencia no apaga un reloj que YA está corriendo en el tablero: el aviso sigue.
  escribirConfig({
    identity: { token_user_id: YO, token_checked_at: new Date().toISOString() },
    project: { overrides: { track_time: false } },
  });
  const r = hook('session-start', { cwd: REPO });
  assert(
    /CRONÓMETRO CORRIENDO/.test(r.out),
    'y sigue avisando aunque el proyecto ya no registre tiempo',
  );
}

console.log('\nEL PROYECTO QUE NO REGISTRA TIEMPO NO SE ENTERA DE NADA\n');

{
  cli(['timer', 'clear']);
  const r = cli(['context']);
  assert(!/⏱/.test(r.out), 'con `track_time` apagado, no hay ningún bloque de cronómetro');
  assert(
    !/^clickup_start_time_tracking$/m.test(r.out),
    'ni la llamada de arranque suelta, que es lo que el modelo copia',
  );
  assert(
    !/Un solo cronómetro corriendo/.test(r.out),
    'ni la regla operativa: en un proyecto que no registra tiempo es contexto quemado',
  );
  // Pero la advertencia de ATRIBUCIÓN se queda, y esa distinción es el punto. El usuario puede
  // pedir "cargá dos horas" en cualquier repo; sin esta línea el modelo no tiene cómo saber que
  // la hora se le carga al dueño del token. Es una regla de seguridad, como la de `"me"`.
  assert(
    /no reciben a quién se le carga la hora/.test(r.out),
    'la advertencia de atribución NO se omite aunque el proyecto no registre tiempo',
  );
}

console.log('\nUNA CARGA MANUAL DE HORAS NO PRENDE NINGÚN RELOJ\n');

{
  hook('timer-hook', {
    cwd: REPO,
    tool_name: tool('clickup_add_time_entry'),
    tool_input: { task_id: '9004', start: '2026-08-29 09:00', duration: '90m' },
    tool_response: { id: '77772', start: '1756400000000', duration: 5400000 },
  });
  assert(!leerEstado()?.timer, '`add_time_entry` deja una entrada cerrada, no un cronómetro');
}

console.log('\nCLICKUP LLEVA UN RELOJ POR PERSONA, NO POR PROYECTO\n');

{
  // El caso que este arreglo cubre: arrancás el reloj en el repo A, vas al repo B, y ahí lo
  // parás — que es exactamente lo que el protocolo te manda hacer cuando el arranque en B falla
  // por "only one timer". El reloj real quedó parado, pero sin esto el estado de A seguiría
  // diciendo "corriendo" para siempre, y `release` en A se trabaría pidiendo parar algo que ya
  // está parado. Es seguro por el propio límite de la API: si una parada tuvo efecto, el reloj
  // que paró era el único que había.
  const OTRO = canonicalProjectKey(path.join(sandbox, 'repo-b'));
  fs.mkdirSync(path.join(OTRO, 'src'), { recursive: true });
  cli(
    [
      'project', 'set',
      '--mode', 'tasks',
      '--workspace-id', '1000000001',
      '--space-id', '2000000001',
      '--list-id', '4000000001',
      '--track-time', 'true',
    ],
    null,
    OTRO,
  );

  cli(['timer', 'clear']);
  arrancar(entradaAbierta('9005'), '9005');
  assert(/CORRIENDO/.test(cli(['timer', 'status']).out), 'el reloj arranca en el primer proyecto');

  // La parada llega desde el OTRO proyecto.
  hook('timer-hook', {
    cwd: OTRO,
    tool_name: tool('clickup_stop_time_tracking'),
    tool_input: {},
    tool_response: entradaCerrada('9005'),
  });

  assert(
    /cronómetro      parado/.test(cli(['timer', 'status']).out),
    'y una parada desde otro proyecto lo apaga acá también',
  );
}

console.log('\nUN CONFIG ILEGIBLE NUNCA ROMPE EL HOOK\n');

{
  fs.writeFileSync(path.join(claudeHome, 'clickup-flow', 'config.json'), '{ esto no es json');
  assert(arrancar(entradaAbierta()).code === 0, 'timer-hook falla ABIERTO con el config roto');
  assert(cli(['timer', 'status']).code === 1, 'y `timer status` lo reporta en vez de fingir');
}

fs.rmSync(sandbox, { recursive: true, force: true });

console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
//
// Las CUATRO formas en que puede llegar un `tool_response`, y las claves con las que una
// herramienta MCP nombra su tarea.
//
// POR QUÉ EXISTE ESTE SUITE. Se encontró validando contra el tablero real, no leyendo código: en
// una sesión se hicieron 2 `create_task`, 4 `create_comment` y 4 `update_task`, y el registro de
// evidencia guardó **solo los 4 `update_task`**. Las tres herramientas estaban en
// `MCP_WRITE_TOOLS`, así que el matcher no era el problema — lo era la extracción.
//
// Dos defectos, y los dos silenciosos:
//
//   1. `raiz()` abre con `if (typeof obj !== 'object') return`, así que un `tool_response` que
//      llega como STRING con JSON adentro se descartaba entero. `clickup_create_task` no dejaba
//      evidencia NUNCA, porque su id existe solo en la respuesta.
//   2. `CLAVES_TAREA` no incluía `entity_id`, que es como nombra su objetivo la herramienta
//      VIGENTE `clickup_create_comment`. Ningún comentario dejaba evidencia.
//
// El costo real: una tarea creada y comentada, sin ningún `update_task`, quedaba "sin
// sincronizar" para siempre — `release` se negaba y el hook `Stop` bloqueaba el turno. Lo tapaba
// que el protocolo siempre hace un `update_task` para poner `in progress`.
//
// Lo que este suite cuida en la otra dirección importa igual: aceptar ids de más es PEOR que
// aceptar de menos. Un id de lista tomado por id de tarea marcaría como verificado un claim que
// no lo está, y eso reintroduce la confianza sin evidencia que el hook vino a eliminar.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CLI = path.join(REPO, 'src', 'cli.mjs');

const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-eviformas-'));
process.env.CLAUDE_CONFIG_DIR = claudeHome;
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

const PROJ = P.canonicalProjectKey(fs.mkdtempSync(path.join(os.tmpdir(), 'cf-eviformas-proj-')));
fs.mkdirSync(path.join(claudeHome, 'clickup-flow'), { recursive: true });
fs.writeFileSync(
  path.join(claudeHome, 'clickup-flow', 'config.json'),
  `${JSON.stringify(
    {
      version: 1,
      identity: { clickup_user_id: '5000000001', confirmed: true, git_emails: [] },
      defaults: { block_writes_without_task: true, ask_new_projects: false },
      projects: {
        [PROJ]: {
          mode: 'tasks',
          path: PROJ,
          name: 'formas',
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

const T = '86e3bweue'; // id de tarea con forma real: `ID_PLAUSIBLE` exige 4 caracteres o más.
const CREATE = 'mcp__claude_ai_ClickUp__clickup_create_task';
const UPDATE = 'mcp__claude_ai_ClickUp__clickup_update_task';
const COMMENT = 'mcp__claude_ai_ClickUp__clickup_create_comment';

/** Dispara el `sync-hook` con un payload y devuelve lo que quedó registrado. */
function hook(payload) {
  S.dropState(PROJ);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, NO_COLOR: '1' };
  spawnSync('node', [CLI, 'sync-hook'], {
    env,
    cwd: PROJ,
    encoding: 'utf8',
    input: JSON.stringify({ cwd: PROJ, ...payload }),
  });
  const st = S.readState(PROJ);
  return {
    ids: (st.mcp?.writes ?? []).map((w) => w.task_id),
    names: st.mcp?.names ?? {},
  };
}

console.log('\nLAS CUATRO FORMAS DEL `tool_response`\n');

const entradaCrear = { name: 'Nombre real', list_id: '4000000001' };

check('objeto plano', () => {
  const r = hook({ tool_name: CREATE, tool_input: entradaCrear, tool_response: { success: true, task_id: T } });
  assert(r.ids.includes(T), `no sacó el id: ${JSON.stringify(r.ids)}`);
  assert(r.names[T] === 'Nombre real', 'no archivó el nombre');
});

check('STRING con JSON adentro — el defecto que dejaba a `create_task` sin evidencia', () => {
  const r = hook({
    tool_name: CREATE,
    tool_input: entradaCrear,
    tool_response: JSON.stringify({ success: true, task_id: T }),
  });
  assert(
    r.ids.includes(T),
    'el `tool_response` string se descarta entero: `raiz()` corta en `typeof !== object` y ' +
      '`visitar()`, que sí sabe parsearlo, nunca lo ve',
  );
  assert(r.names[T] === 'Nombre real', 'tampoco archivó el nombre');
});

check('envoltorio MCP `{content:[{type,text}]}`', () => {
  const r = hook({
    tool_name: CREATE,
    tool_input: entradaCrear,
    tool_response: { content: [{ type: 'text', text: JSON.stringify({ success: true, task_id: T }) }] },
  });
  assert(r.ids.includes(T), 'no atravesó el envoltorio');
  // El id vive adentro del texto: leer `tool_response.task_id` a mano devuelve `undefined`, y por
  // eso el nombre tiene que apoyarse en los ids que `extractTaskIds` ya resolvió.
  assert(r.names[T] === 'Nombre real', 'sacó el id pero no supo a qué tarea pegarle el nombre');
});

check('sin `tool_response`: no hay de dónde sacarlo, y no se inventa', () => {
  const r = hook({ tool_name: CREATE, tool_input: entradaCrear });
  assert(r.ids.length === 0, `inventó un id: ${JSON.stringify(r.ids)}`);
});

console.log('\nCÓMO CADA HERRAMIENTA NOMBRA SU TAREA\n');

check('`update_task` la nombra en la ENTRADA', () => {
  const r = hook({ tool_name: UPDATE, tool_input: { task_id: T, status: 'in progress' }, tool_response: { success: true } });
  assert(r.ids.includes(T), 'no sacó el id del tool_input');
});

check('`create_comment` usa `entity_id`, no `task_id`', () => {
  const r = hook({
    tool_name: COMMENT,
    tool_input: { entity_type: 'task', entity_id: T, comment_text: 'avance' },
    tool_response: { success: true, comment_id: '900' },
  });
  assert(
    r.ids.includes(T),
    '`entity_id` no se reconocía, así que NINGÚN comentario dejaba evidencia — y comentar es la ' +
      'mitad del protocolo',
  );
});

check('`entity_type` ausente se trata como tarea, que es el default del conector', () => {
  const r = hook({
    tool_name: COMMENT,
    tool_input: { entity_id: T, comment_text: 'avance' },
    tool_response: { success: true },
  });
  assert(r.ids.includes(T), 'perdió la evidencia por un campo opcional que no vino');
});

console.log('\nLO QUE NO SE DEBE ACEPTAR (aceptar de más es peor que de menos)\n');

check('un comentario en una LISTA no es evidencia sobre ninguna tarea', () => {
  const r = hook({
    tool_name: COMMENT,
    tool_input: { entity_type: 'list', entity_id: '4000000001', comment_text: 'x' },
    tool_response: { success: true },
  });
  assert(
    r.ids.length === 0,
    `tomó el id de una LISTA por el de una tarea: ${JSON.stringify(r.ids)} — eso marcaría como ` +
      'verificado un claim que no lo está',
  );
});

check('los ids anidados de list/folder/space/creator no se cuelan', () => {
  const r = hook({
    tool_name: UPDATE,
    tool_input: { status: 'x' },
    tool_response: {
      id: T,
      name: 'T',
      url: `https://app.clickup.com/t/${T}`,
      list: { id: '4000000001', name: 'Backlog' },
      folder: { id: '3000000001', name: 'Plataforma' },
      space: { id: '2000000001' },
      creator: { id: '5000000001' },
    },
  });
  assert(r.ids.length === 1 && r.ids[0] === T, `se coló algún anidado: ${JSON.stringify(r.ids)}`);
});

check('con VARIOS ids, el nombre no se le pega a ninguno', () => {
  const r = hook({
    tool_name: CREATE,
    tool_input: { name: 'Nombre real', task_id: 'OTRA-9999' },
    tool_response: { success: true, task_id: T },
  });
  assert(r.ids.length > 1, 'el escenario no se armó: hacían falta dos ids');
  assert(
    Object.keys(r.names).length === 0,
    `adivinó a cuál pertenecía el nombre: ${JSON.stringify(r.names)}`,
  );
});

console.log('\nEL HOOK DE SOLO LECTURA: APRENDE EL NOMBRE, NUNCA ABRE EL CANDADO\n');

// `clickup_get_task` tiene su propio matcher y su propio subcomando, y la separación no es
// organización: es la garantía. Una lectura no prueba que el trabajo se registró. Si contara como
// evidencia, alcanzaría con ABRIR una tarea para poder soltar el claim sin haber comentado ni
// cerrado nada — el candado se abriría con solo mirar.

const GET = 'mcp__claude_ai_ClickUp__clickup_get_task';

// Una respuesta realista: la tarea trae anidados `list`, `folder`, `space` y `creator`, y los
// cuatro tienen `id` y `name`. Quedarse con el de la lista sería peor que no guardar nada.
const TAREA = {
  id: T,
  name: 'Propagar el stale-on-error',
  status: { status: 'in progress' },
  list: { id: '4000000001', name: 'Backlog' },
  folder: { id: '3000000001', name: 'Plataforma' },
  space: { id: '2000000001', name: 'Acme' },
  creator: { id: '5000000001', name: 'Otra Persona' },
};

function leer(tool_response) {
  S.dropState(PROJ);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, NO_COLOR: '1' };
  spawnSync('node', [CLI, 'name-hook'], {
    env,
    cwd: PROJ,
    encoding: 'utf8',
    input: JSON.stringify({ cwd: PROJ, tool_name: GET, tool_input: { task_id: T }, tool_response }),
  });
  const st = S.readState(PROJ);
  return { names: st.mcp?.names ?? {}, writes: (st.mcp?.writes ?? []).length };
}

check('aprende el nombre de una respuesta objeto', () => {
  const r = leer(TAREA);
  assert(r.names[T] === 'Propagar el stale-on-error', `no lo aprendió: ${JSON.stringify(r.names)}`);
});

check('aprende el nombre de una respuesta string', () => {
  assert(leer(JSON.stringify(TAREA)).names[T] === 'Propagar el stale-on-error', 'no parseó el string');
});

check('aprende el nombre atravesando el envoltorio MCP', () => {
  const r = leer({ content: [{ type: 'text', text: JSON.stringify(TAREA) }] });
  assert(r.names[T] === 'Propagar el stale-on-error', 'no atravesó el envoltorio');
});

check('NO se queda con el nombre de la lista, la carpeta, el espacio ni el creador', () => {
  const r = leer(TAREA);
  const guardados = Object.values(r.names);
  for (const ajeno of ['Backlog', 'Plataforma', 'Acme', 'Otra Persona']) {
    assert(
      !guardados.includes(ajeno),
      `se quedó con "${ajeno}": el aviso de divergencia diría que la tarea se llama así y ` +
        'mandaría a dudar de un claim que estaba bien',
    );
  }
  assert(Object.keys(r.names).length === 1, `guardó de más: ${JSON.stringify(r.names)}`);
});

check('LA INVARIANTE: leer una tarea NO deja evidencia de trabajo', () => {
  const r = leer(TAREA);
  assert(
    r.writes === 0,
    'una lectura quedó registrada como mutación: alcanzaría con ABRIR una tarea para soltar el ' +
      'claim sin haber comentado ni cerrado nada',
  );
});

check('una respuesta sin `name` no inventa nada', () => {
  const r = leer({ id: T, status: { status: 'to do' } });
  assert(Object.keys(r.names).length === 0, `inventó un nombre: ${JSON.stringify(r.names)}`);
});

check('una respuesta sin `id` no se le pega a ninguna tarea', () => {
  const r = leer({ name: 'Algo', list: { id: '4000000001', name: 'Backlog' } });
  assert(Object.keys(r.names).length === 0, `adivinó a qué tarea pertenecía: ${JSON.stringify(r.names)}`);
});

console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
if (fail) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
  console.log(`\nsandbox: ${claudeHome}\n`);
  process.exit(1);
}
fs.rmSync(claudeHome, { recursive: true, force: true });
fs.rmSync(PROJ, { recursive: true, force: true });
console.log('evidencia-formas: sin hallazgos.\n');

#!/usr/bin/env node
//
// Los assets SON el producto.
//
// El skill y los comandos son lo único que el agente lee de verdad, y hasta ahora los tests sólo
// verificaban que los archivos EXISTIERAN. Una regla que desaparece en una edición no rompe ningún
// test y no se nota hasta que alguien duplica una tarea o asigna al dueño del token.
//
// Acá se fija lo que no puede desaparecer, y se verifica contra la API real de ClickUp que los
// nombres de herramienta y de parámetro que las instrucciones enseñan sean los correctos: enseñar
// `list_id` donde la API espera `list_ids` produce una búsqueda que no filtra nada y devuelve
// resultados que parecen válidos.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(REPO, 'assets');
const PROTOCOL = path.join(REPO, 'src', 'lib', 'protocol.mjs');

let pass = 0;
let fail = 0;
const fallos = [];
function check(n, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${n}`);
  } catch (e) {
    fail++;
    fallos.push(`${n}: ${e.message}`);
    console.log(`  FAIL ${n}\n         ${e.message}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m || 'assertion failed');
};

const leer = (p) => fs.readFileSync(p, 'utf8');
const SKILL = leer(path.join(ASSETS, 'skills', 'clickup-task-flow', 'SKILL.md'));
const TAREA = leer(path.join(ASSETS, 'commands', 'tarea.md'));
const SETUP = leer(path.join(ASSETS, 'commands', 'clickup-setup.md'));
const CONFIG_CMD = leer(path.join(ASSETS, 'commands', 'clickup-config.md'));
const PROTO = leer(PROTOCOL);
const TODO_TEXTO = [SKILL, TAREA, SETUP, CONFIG_CMD, PROTO].join('\n');

console.log('\nLAS REGLAS QUE NO PUEDEN DESAPARECER\n');

check('nunca se enseña a asignar con "me"', () => {
  // `"me"` resuelve al dueño del token de la integración, no al ejecutor. Verificado en vivo:
  // devuelve un id fijo, y ninguno de los emails de git del usuario resuelve a ese id.
  assert(/"me"/.test(TODO_TEXTO), 'ni se menciona el problema de "me"');
  const prohibicion =
    /"me"[\s\S]{0,300}?(no lo uses|nunca|dueño del token)|dueño del token[\s\S]{0,300}?"me"/i;
  assert(prohibicion.test(PROTO), 'el protocolo no prohíbe usar "me" para asignar');
  // Y en ningún asset puede haber un ejemplo que lo use como valor de assignees.
  for (const [nombre, texto] of [
    ['SKILL.md', SKILL],
    ['tarea.md', TAREA],
    ['clickup-setup.md', SETUP],
  ]) {
    assert(
      !/assignees\s*:\s*\[\s*"me"/i.test(texto),
      `${nombre} tiene un ejemplo que asigna con "me"`,
    );
  }
});

check('el bloqueo avisa UNA vez y no veta para siempre', () => {
  // Requisito explícito: se bloquea una vez explicando el motivo, con opción de continuar.
  const enSkill = /no\s+(le\s+)?vet|una\s+(sola\s+)?vez|puede\s+seguir|si\s+lo\s+desea/i.test(SKILL);
  assert(enSkill, 'el SKILL.md ya no dice que un estado no veta el trabajo');
  assert(
    /sobreescrib|sobrescrib|crear\s+una\s+nueva|otra\s+tarea/i.test(TAREA + SKILL),
    'no se ofrece la salida de sobrescribir o crear otra cuando sólo PARECE la misma tarea',
  );
});

check('siempre se busca antes de crear, y paginando hasta el final', () => {
  assert(/busc/i.test(SKILL), 'el SKILL.md no manda buscar antes de crear');
  // Sin paginar, la búsqueda anticolisión puede no ver la tarea que ya existe y duplicarla —
  // que es exactamente lo que la herramienta existe para evitar. La API pagina a 100.
  const pagina = /has_more|next_page|next_cursor|pagin/i;
  assert(pagina.test(SKILL), 'el SKILL.md no dice paginar');
  assert(pagina.test(PROTO), 'el protocolo no dice paginar');
});

check('se capturan los estados REALES del tablero, no los nombres por defecto', () => {
  // El setup nombra `clickup_get_list` dos veces, con propósitos distintos: capturar los estados
  // de la lista elegida, y verificar un list_id que el usuario pegó a mano. Este check exige la
  // invocación con `list_id:`, que es la de captura — buscar el nombre suelto lo satisfacía la otra.
  assert(
    /clickup_get_list\s+list_id:/.test(SETUP),
    'el setup ya no invoca clickup_get_list para leer los estados de la lista elegida',
  );
  // Anclas precisas, no la palabra suelta: `` `type` `` también aparece en el encabezado de la
  // tabla de más abajo, así que buscarla a secas sobrevivía a que borren la frase que la explica.
  assert(
    /`statuses\[\]`[\s\S]{0,80}`type`/.test(SETUP),
    'el setup ya no explica que statuses[] trae el nombre exacto y el `type` de cada estado',
  );
  for (const tipo of ['open', 'custom', 'done', 'closed']) {
    assert(
      new RegExp(`\`${tipo}\``).test(SETUP),
      `el setup no nombra el tipo de estado \`${tipo}\`, y sin los cuatro no se sabe cuál cierra`,
    );
  }
});

check('el setup dice qué hacer si la jerarquía vuelve SIN listas', () => {
  // Pasa de verdad: `clickup_get_workspace_hierarchy` puede devolver un espacio con
  // `children: []`. Sin instrucción, el agente se queda trabado en el primer paso del setup.
  //
  // Cada pieza se verifica POR SEPARADO. Con una cadena de OR, borrar el encabezado de la sección
  // no rompía nada porque el cuerpo seguía mencionando `children: []` — y un test que sobrevive a
  // que le saquen la mitad de lo que verifica no está verificando eso.
  const debeEstar = [
    [/### Si la jerarquía vuelve vacía o sin listas/, 'la sección del caso sin listas'],
    [/children:\s*\[\]/, 'la forma concreta en que llega la jerarquía vacía'],
    [/No inventes un `list_id`/, 'la prohibición de inventar un list_id'],
    [/bucle de reintentos/, 'la prohibición de reintentar en bucle'],
    [/has_more/, 'el paso de paginar antes de darse por vencido'],
    [/next_cursor/, 'el cursor con el que se pagina la jerarquía'],
    [/clickup_create_list/, 'la salida de crear la lista'],
    [/preguntando\n?\s*\*\*primero\*\*|\*\*preguntando\s*\n?\s*primero\*\*|preguntando[\s\S]{0,30}primero/i, 'que crear la lista se pregunta primero'],
    [/clickup_get_list/, 'la verificación del list_id que pegue el usuario'],
    [/sin escribir nada/, 'que el setup cierra sin escribir si no hay lista'],
    [/configuración a medias/, 'por qué una configuración a medias es peor que ninguna'],
  ];
  for (const [re, que] of debeEstar) {
    assert(re.test(SETUP), `el setup ya no dice ${que} (${re})`);
  }
});

console.log('\nCOHERENCIA CON LA API REAL DE CLICKUP\n');

/**
 * Herramientas del conector de ClickUp, verificadas contra el conector en vivo.
 *
 * Si el conector renombra o retira una, este test falla y hay que actualizar las instrucciones —
 * que es justamente lo que se quiere, porque una herramienta que no existe hace que el agente
 * improvise en el medio del flujo.
 */
const HERRAMIENTAS_REALES = new Set([
  'clickup_add_tag_to_task', 'clickup_add_task_dependency', 'clickup_add_task_link',
  'clickup_add_task_to_list', 'clickup_add_time_entry', 'clickup_attach_task_file',
  'clickup_create_comment', 'clickup_create_document', 'clickup_create_document_page',
  'clickup_create_folder', 'clickup_create_list', 'clickup_create_list_in_folder',
  'clickup_create_reminder', 'clickup_create_task', 'clickup_create_task_comment',
  'clickup_delete_comment', 'clickup_delete_task', 'clickup_download_task_attachment',
  'clickup_filter_tasks', 'clickup_find_member_by_name', 'clickup_get_bulk_tasks_time_in_status',
  'clickup_get_chat_channel_messages', 'clickup_get_chat_channels', 'clickup_get_chat_message_replies',
  'clickup_get_current_time_entry', 'clickup_get_custom_fields', 'clickup_get_document_pages',
  'clickup_get_folder', 'clickup_get_list', 'clickup_get_task', 'clickup_get_task_comments',
  'clickup_get_task_time_in_status', 'clickup_get_threaded_comments', 'clickup_get_time_entries',
  'clickup_get_workspace_hierarchy', 'clickup_get_workspace_members', 'clickup_list_document_pages',
  'clickup_merge_tasks', 'clickup_move_task', 'clickup_remove_tag_from_task',
  'clickup_remove_task_dependency', 'clickup_remove_task_from_list', 'clickup_remove_task_link',
  'clickup_request_attachment_upload', 'clickup_resolve_assignees', 'clickup_search',
  'clickup_search_reminders', 'clickup_send_chat_message', 'clickup_start_time_tracking',
  'clickup_stop_time_tracking', 'clickup_update_comment', 'clickup_update_document_page',
  'clickup_update_folder', 'clickup_update_list', 'clickup_update_reminder', 'clickup_update_task',
]);

// Campos del config que empiezan igual que una herramienta y no lo son.
const NO_SON_HERRAMIENTAS = new Set(['clickup_email', 'clickup_user_id', 'clickup_username', 'clickup_id']);

check('toda herramienta que las instrucciones nombran existe en el conector', () => {
  const nombradas = new Set(
    [...TODO_TEXTO.matchAll(/\bclickup_[a-z_]+\b/g)].map((m) => m[0]).filter((n) => !NO_SON_HERRAMIENTAS.has(n)),
  );
  assert(nombradas.size > 10, `apenas ${nombradas.size} herramientas nombradas: algo se rompió`);
  const inventadas = [...nombradas].filter((n) => !HERRAMIENTAS_REALES.has(n));
  assert(
    inventadas.length === 0,
    `las instrucciones nombran herramientas que no existen: ${inventadas.join(', ')}`,
  );
});

check('clickup_filter_tasks se invoca con list_ids (plural), nunca con list_id', () => {
  // `list_id` es de `clickup_create_task`. En `filter_tasks` el parámetro es `list_ids` y toma un
  // array: pasarle `list_id` no filtra nada, y el resultado parece válido.
  for (const [nombre, texto] of [
    ['protocol.mjs', PROTO],
    ['tarea.md', TAREA],
    ['SKILL.md', SKILL],
  ]) {
    const lineas = texto.split('\n');
    lineas.forEach((l, i) => {
      if (!/clickup_filter_tasks/.test(l)) return;
      // Se mira la línea de la invocación y las 3 siguientes, que es donde van los parámetros.
      const bloque = lineas.slice(i, i + 4).join(' ');
      if (!/list_id/.test(bloque)) return;
      assert(
        /list_ids/.test(bloque),
        `${nombre}:${i + 1} le pasa list_id a filter_tasks: "${l.trim().slice(0, 90)}"`,
      );
    });
  }
});

check('assignees se manda como lista COMPLETA, no con add/rem', () => {
  // `clickup_update_task.assignees` es un array plano de user IDs: no soporta add/rem (a
  // diferencia de los custom fields de tipo people, que sí). Sin leer-unir-escribir, agregar un
  // colaborador BORRA al que ya estaba asignado.
  assert(
    /add|rem/.test(PROTO) === false ||
      /lista\s+completa|reemplaz|uni[óo]n|le[ée]r?\s*-?\s*unir|no\s+soporta\s+add/i.test(PROTO),
    'el protocolo no explica que assignees se reemplaza entero',
  );
  assert(
    !/assignees[^\n]{0,60}\{\s*"?add"?/i.test(TODO_TEXTO),
    'hay un ejemplo que le manda {add:...} a assignees, que la API no soporta',
  );
});

check('las instrucciones no traen datos reales de nadie', () => {
  // La documentación va con datos ficticios a propósito. Un id o un dominio real acá se filtra
  // a cualquiera que instale la herramienta.
  const sospechoso = [
    /\b\d{9}\b/, // ids de usuario de ClickUp
    /@(?!example\.(com|net|org))[a-z0-9-]+\.(com|mx|net|org|io)\b/i,
  ];
  for (const [nombre, texto] of [
    ['SKILL.md', SKILL],
    ['tarea.md', TAREA],
    ['clickup-setup.md', SETUP],
    ['clickup-config.md', CONFIG_CMD],
    ['protocol.mjs', PROTO],
  ]) {
    for (const re of sospechoso) {
      const linea = texto.split('\n').find((l) => re.test(l));
      assert(!linea, `${nombre} tiene algo que parece un dato real: "${linea?.trim().slice(0, 110)}"`);
    }
  }
});

check('cada comando declara el CLI vía {{CLI}}, sin rutas hardcodeadas', () => {
  for (const [nombre, texto] of [
    ['SKILL.md', SKILL],
    ['tarea.md', TAREA],
    ['clickup-setup.md', SETUP],
    ['clickup-config.md', CONFIG_CMD],
  ]) {
    assert(texto.includes('{{CLI}}'), `${nombre} no usa {{CLI}}`);
    assert(
      !/node\s+"\/(home|mnt|Users)/.test(texto),
      `${nombre} tiene una ruta absoluta hardcodeada`,
    );
  }
});

console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
if (fail) {
  for (const f of fallos) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('instrucciones: sin hallazgos.\n');

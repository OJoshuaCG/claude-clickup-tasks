// Renders the resolved, per-project protocol.
//
// The problem this solves: a skill is a static markdown file, but the protocol is not the same
// in every repo — one board wants several normal tasks, another wants one umbrella task with
// subtasks, a third wants nothing to do with ClickUp. The three source repos handled that by
// keeping three hand-maintained copies of the skill, which is why they drifted apart and started
// contradicting each other on things as basic as which field holds the completion date.
//
// So the skill stays generic and DELEGATES the specifics here: it runs `clickup-flow context`
// and gets back the coordinates, the mode and the exact rules that apply to the directory it is
// standing in. One protocol, resolved per project, no copies to keep in sync.

import {
  MODES,
  identityReady,
  resolveProject,
  gitEmail,
  effectiveDefaults,
  effectiveStatuses,
} from './config.mjs';
import { cliInvocation } from './paths.mjs';
import { readState, exemptionStatus } from './state.mjs';

const TASK_URL = (id) => `https://app.clickup.com/t/${id}`;

function today() {
  // Local date, not UTC. `toISOString()` would report yesterday for anyone west of Greenwich
  // during their evening, and a start_date that is off by one is a start_date nobody trusts.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function daysAgo(days) {
  const d = new Date(Date.now() - days * 86_400_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Everything the caller needs about "where am I and what are the rules here".
 * Pure data — the markdown rendering is separate so hooks can use the facts without the prose.
 */
export function buildContext(config, cwd) {
  const { key, entry, matchedBy, matchedKey } = resolveProject(config, cwd);
  let gitEmailCache;
  const state = readState(matchedKey || key);
  // Project overrides win over the global defaults — see OVERRIDABLE in config.mjs for why.
  const defaults = effectiveDefaults(config, entry);
  const exemption = exemptionStatus(state, defaults.exemption_hours ?? 8);

  return {
    cwd: key,
    project: entry,
    matchedBy,
    matchedKey,
    registered: Boolean(entry),
    excluded: entry?.mode === MODES.EXCLUDED,
    mode: entry?.mode ?? null,
    identity: config.identity || {},
    identityReady: identityReady(config),
    defaults,
    team: config.team || {},
    claim: state.claim,
    exemption,
    // Lazy on purpose: the hooks that fire every turn never read this, and spawning git for a
    // value nobody asked for is a tax paid on every prompt in every repo on the machine.
    get gitEmail() {
      if (gitEmailCache === undefined) gitEmailCache = gitEmail(cwd);
      return gitEmailCache;
    },
    statuses: effectiveStatuses(entry),
    cli: cliInvocation(config),
    today: today(),
    // Con la ventana en 0 (sin límite) no hay fecha de corte: el renderer omite el filtro.
    closedSince:
      (defaults.search_window_days ?? 30) > 0 ? daysAgo(defaults.search_window_days ?? 30) : null,
  };
}

/** The one-line summary the SessionStart hook prints. */
export function shortSummary(ctx) {
  if (!ctx.registered) return 'proyecto sin configurar';
  if (ctx.excluded) return 'proyecto excluido';
  const p = ctx.project;
  const where = p.mode === MODES.UMBRELLA ? `paraguas ${p.umbrella_task_id}` : `lista ${p.list_id}`;
  return `${p.mode} · ${p.space_name ?? p.space_id} · ${where}`;
}

/** The full brief, as markdown, for the agent to read before touching the board. */
export function renderContext(ctx) {
  if (!ctx.registered) return renderUnregistered(ctx);
  if (ctx.excluded) return renderExcluded(ctx);

  const p = ctx.project;
  const d = ctx.defaults;
  const st = ctx.statuses;
  const out = [];

  out.push(`# Protocolo de tareas ClickUp — ${p.name}`);
  out.push('');
  out.push(
    `Este bloque lo generó \`${ctx.cli} context\` leyendo la configuración de ESTE proyecto. ` +
      'Manda sobre cualquier convención genérica de ClickUp que tengas cargada de otro lado.',
  );
  out.push('');

  // ---- Coordinates ----------------------------------------------------------------------
  out.push('## Coordenadas');
  out.push('');
  out.push('| Campo | Valor |');
  out.push('| --- | --- |');
  out.push(`| Proyecto | \`${p.path}\` |`);
  if (ctx.matchedBy && ctx.matchedBy !== 'path') {
    out.push(`| Resuelto por | ${ctx.matchedBy} (\`${ctx.matchedKey}\`) |`);
  }
  out.push(`| Modo | **${p.mode}** |`);
  out.push(`| Workspace | \`${p.workspace_id ?? d.workspace_id ?? '—'}\` |`);
  out.push(`| Espacio | ${p.space_name ?? '—'} (\`${p.space_id ?? '—'}\`) |`);
  if (p.folder_id) out.push(`| Carpeta | ${p.folder_name ?? '—'} (\`${p.folder_id}\`) |`);
  out.push(`| Lista | ${p.list_name ?? '—'} (\`${p.list_id ?? '—'}\`) |`);
  if (p.mode === MODES.UMBRELLA) {
    out.push(
      `| Tarea paraguas | \`${p.umbrella_task_id ?? '— FALTA'}\` — ${p.umbrella_task_id ? TASK_URL(p.umbrella_task_id) : 'configurala con `/clickup-setup`'} |`,
    );
  } else {
    out.push('| Tarea paraguas | **no se usa en este proyecto** |');
  }
  out.push(`| Fecha de hoy | \`${ctx.today}\` |`);
  out.push('');

  // ---- Statuses -------------------------------------------------------------------------
  // Emitted explicitly because a status name that does not exist on the list makes every
  // clickup_update_task fail, and the failure reads as "the protocol did nothing".
  out.push('## Los estados de ESTE tablero');
  out.push('');
  out.push('Usá estos nombres **exactos**. Un estado que no existe en la lista hace fallar el update.');
  out.push('');
  out.push('| Rol en el protocolo | Estado real | Significa |');
  out.push('| --- | --- | --- |');
  out.push(`| libre | \`${st.todo}\` | Nadie la tomó |`);
  out.push(
    `| en curso | \`${st.in_progress}\` | **Es lo que reserva la tarea.** No dice por sí solo QUIÉN: eso lo declara el comentario \`INICIO\` |`,
  );
  out.push(
    `| detenida | \`${st.on_hold}\` | Trabada por algo externo, quedó a medias, o es un pedido con contexto |`,
  );
  if (p.handoff) {
    out.push(
      `| falta el otro rol | \`${st.handoff}\` | Un lado terminó. **Nada más.** Para "a medias" está \`${st.on_hold}\` |`,
    );
  }
  out.push(`| cerrada | \`${st.done}\` | No queda nada pendiente en ningún lado |`);
  out.push('');
  if (Array.isArray(p.available_statuses) && p.available_statuses.length) {
    out.push(
      `Estados configurados en la lista: ${p.available_statuses.map((x) => `\`${x}\``).join(', ')}. ` +
        'Cualquiera que no esté en esa lista **no existe**: no lo uses y no lo inventes.',
    );
    const extra = p.available_statuses.filter(
      (x) => ![st.todo, st.in_progress, st.on_hold, st.handoff, st.done].includes(x),
    );
    if (extra.length) {
      out.push('');
      out.push(
        `${extra.map((x) => `\`${x}\``).join(', ')} existe${extra.length > 1 ? 'n' : ''} en el tablero pero ` +
          '**no tiene significado declarado en este flujo**. No lo pongas, y si encontrás una tarea ' +
          'ahí, **preguntá** antes de asumir qué quiso decir quien la dejó.',
      );
    }
  }
  if (!st.__recorded) {
    out.push('');
    out.push(
      '⚠️ **Estos nombres son los defaults, no se confirmaron contra el tablero.** Antes del primer ' +
        `update, verificalos con \`clickup_get_list list_id:"${p.list_id ?? '<list_id>'}"\` y, si no ` +
        `coinciden, guardalos: \`${ctx.cli} project set … --status-in-progress "<nombre real>" …\``,
    );
  }
  out.push('');

  // ---- Identity -------------------------------------------------------------------------
  out.push('## A quién se le asigna el trabajo');
  out.push('');
  if (ctx.identityReady) {
    out.push(
      `**Asigná siempre al id numérico \`${ctx.identity.clickup_user_id}\`** ` +
        `(${ctx.identity.clickup_username ?? 's/n'}${ctx.identity.clickup_email ? ` · ${ctx.identity.clickup_email}` : ''}).`,
    );
    out.push('');
    out.push(
      '**Nunca uses `"me"`.** `"me"` resuelve al dueño del token de la integración, no a quien ' +
        'ejecuta, así que en un equipo le asigna todo a la misma persona. Ese es el bug que esta ' +
        'configuración existe para eliminar: el id de arriba está confirmado y es el correcto.',
    );
    if (!d.auto_assign) {
      out.push('');
      out.push(
        '⚠️ **La autoasignación está DESACTIVADA** en la configuración: no agregues asignados ' +
          'salvo que el usuario lo pida explícitamente en el turno.',
      );
    }
  } else {
    out.push('🛑 **La identidad de ClickUp NO está resuelta todavía.** No asignes nada.');
    out.push('');
    out.push('Resolvela ahora, en este orden, y una sola vez para siempre:');
    out.push('');
    out.push('1. `clickup_get_workspace_members` (o `clickup_find_member_by_name`) buscando');
    out.push(
      `   \`${ctx.identity.pending_query ?? ctx.gitEmail ?? '<email o usuario de ClickUp>'}\`.`,
    );
    out.push('2. **Mostrale los candidatos al usuario y esperá que confirme uno.** Un match por');
    out.push('   parecido de apellido no es evidencia: asignar al colega equivocado no falla, no');
    out.push('   avisa, y se descubre semanas después.');
    out.push('3. Con la confirmación, guardalo:');
    out.push('');
    out.push('   ```bash');
    out.push(
      `   ${ctx.cli} identity set --id <id numérico> --email <email ClickUp> --name \"<nombre>\" --confirmed`,
    );
    out.push('   ```');
  }
  if (ctx.gitEmail) {
    out.push('');
    out.push(
      `**Identidad para los comentarios: \`${ctx.gitEmail}\`** (de \`git config user.email\`). ` +
        'Va escrita DENTRO del texto del comentario, porque todos los comentarios se publican con ' +
        'la cuenta del token y el campo "autor" de ClickUp no sirve para detectar colisiones.',
    );
  }
  out.push('');

  // ---- Current claim --------------------------------------------------------------------
  out.push('## Estado en este proyecto');
  out.push('');
  if (ctx.claim) {
    out.push(
      `**TAREA RECLAMADA:** \`${ctx.claim.task_id}\` — ${ctx.claim.title ?? 's/título'}` +
        `${ctx.claim.role ? ` (rol ${ctx.claim.role})` : ''}`,
    );
    out.push(`Reclamada ${ctx.claim.claimed_at} por ${ctx.claim.git_email ?? 's/email'}.`);
    out.push('');
    out.push('Al terminar, cerrala con `/tarea fin ' + ctx.claim.task_id + '`.');
  } else if (ctx.exemption.active) {
    out.push(
      `**Exención vigente** (${ctx.exemption.ageHours.toFixed(1)}h de ${ctx.exemption.limitHours}h): ` +
        `${ctx.exemption.reason}`,
    );
    out.push('');
    out.push('Se puede escribir sin tarea mientras dure. No la uses para saltear la búsqueda.');
  } else if (ctx.exemption.expired) {
    out.push(
      `**La exención VENCIÓ** (${ctx.exemption.ageHours === Infinity ? 'timestamp ilegible' : `${ctx.exemption.ageHours.toFixed(1)}h`}). ` +
        'Hay que volver a decidir: reclamar tarea, o declarar la exención de nuevo con el motivo actual.',
    );
  } else {
    out.push('**Ninguna tarea reclamada y ninguna exención declarada.**');
  }
  out.push('');

  // ---- Step 0 ---------------------------------------------------------------------------
  out.push('## Paso 0 — ¿Esto amerita una tarea?');
  out.push('');
  out.push('> **¿Alguien más del equipo necesitaría saber que esto pasó?**');
  out.push('');
  out.push('| Amerita tarea | NO amerita tarea |');
  out.push('| --- | --- |');
  out.push(
    '| Cambia código, esquema, configuración o documentación que se commitea | Responder una pregunta, explicar código, leer para entender |',
  );
  out.push(
    '| Es un fix de algo reportado o roto | Investigar o diagnosticar **sin** terminar en un cambio |',
  );
  out.push(
    '| Produce un entregable que otro consume | Ajustes del entorno local de quien trabaja |',
  );
  out.push('| Va a quedar a medias y hay que retomarlo | Un rename hecho dentro de una tarea ya reclamada |');
  out.push('');
  out.push(
    'Si el diagnóstico **termina** en un cambio, ahí sí amerita — y la fecha de solicitud es la ' +
      'del pedido original, no la de cuando terminaste de investigar. **Ante la duda, preguntale ' +
      'al usuario.**',
  );
  out.push('');
  out.push(
    'Si NO amerita y vas a escribir código igual, declaralo por escrito para no chocar con el candado:',
  );
  out.push('');
  out.push('```bash');
  out.push(`${ctx.cli} exempt --reason \"<motivo concreto>\"`);
  out.push('```');
  out.push('');

  // ---- Fail closed ----------------------------------------------------------------------
  out.push('## Si ClickUp no responde, se PARA');
  out.push('');
  out.push(
    'Conector caído, `Needs authentication`, timeout o error del servidor = **no se pudo validar**. ' +
      'Decíselo al usuario y **no escribas código**. Nunca interpretes un error del conector como ' +
      '"no hay tarea, está libre": un agente que no puede consultar y avanza igual produce justo ' +
      'el trabajo duplicado que esto evita, y encima con la falsa confianza de haber chequeado.',
  );
  out.push('');
  out.push(
    'Seguir sin validar es una decisión **del usuario, explícita**. Si te la da, dejá dicho en el ' +
      'resumen final que el trabajo se hizo **sin validación de colisiones**.',
  );
  out.push('');

  // ---- Search ---------------------------------------------------------------------------
  out.push('## Paso 1 — Buscar antes de crear (sin excepciones)');
  out.push('');
  out.push(renderSearch(ctx));
  out.push('');
  out.push('### Qué hacer según lo que encuentres');
  out.push('');
  out.push('| Estado | Acción |');
  out.push('| --- | --- |');
  out.push(
    `| \`${st.in_progress}\` | Leé el último \`INICIO\` (\`clickup_get_task_comments\`): **quién**, **desde cuándo**, qué **rol**. Si venís a hacer lo mismo → **PARÁ e informá quién la tiene**. Si el \`INICIO\` es de otro rol y vos tocás lo tuyo → no la toques, derivá |`,
  );
  out.push(
    `| \`${st.done}\` | **PARÁ Y AVISÁ: este trabajo ya se hizo.** Mostrá el resumen del \`FIN\`, quién lo cerró y cuándo, y **esperá confirmación antes de tocar una línea** |`,
  );
  out.push(`| \`${st.todo}\` | Libre. Se puede tomar |`);
  out.push(
    `| \`${st.on_hold}\` | **Leé el último comentario primero**: dice por qué se detuvo y dónde quedó. Puede ser un pedido con contexto, no una tarea abandonada |`,
  );
  if (p.handoff) {
    out.push(
      `| \`${st.handoff}\` | **El otro rol ya entregó.** Si venís a hacer lo que falta, tomala. Si venís a re-tocar lo ya entregado, ver la bifurcación de handoff |`,
    );
  }
  out.push(
    '| cualquier otro estado | Significado **no declarado** en este flujo. **Preguntá** antes de asumir |',
  );
  out.push('| No existe | Crear la tarea (abajo) |');
  out.push('');

  // ---- Creating -------------------------------------------------------------------------
  out.push('## Crear la tarea (solo si de verdad no existe)');
  out.push('');
  out.push('```');
  out.push('clickup_create_task');
  out.push(`  name:                 "${p.mode === MODES.UMBRELLA ? renderNaming(p, ctx) : '<título descriptivo, sin inventar esquemas de ID>'}"`);
  out.push(`  list_id:              "${p.list_id ?? '<list_id>'}"`);
  if (p.mode === MODES.UMBRELLA) {
    out.push(`  parent:               "${p.umbrella_task_id ?? '<umbrella>'}"   ← siempre subtarea`);
  }
  if (d.use_dates) {
    out.push(
      '  markdown_description: "**Solicitado:** <fecha del pedido>\\n\\n<contexto, alcance, archivos>"',
    );
  } else {
    out.push('  markdown_description: "<contexto, alcance, archivos>"');
  }
  if (d.auto_assign && ctx.identityReady) {
    out.push(`  assignees:            ["${ctx.identity.clickup_user_id}"]   ← NUNCA "me"`);
  }
  if (d.use_priorities) {
    out.push('  priority:             "urgent" | "high" | "normal" | "low"');
  }
  out.push('```');
  out.push('');
  if (p.mode === MODES.TASKS) {
    out.push(
      '**Tarea normal, sin `parent`.** Las subtareas son la excepción en este proyecto: solo si ' +
        'la tarea es grande y sus partes se entregan por separado con estados distintos, o si hay ' +
        'que tocar algo de una tarea que otra persona está haciendo ahora mismo.',
    );
  } else {
    out.push(
      `**Siempre subtarea de \`${p.umbrella_task_id ?? '<paraguas>'}\`, nunca tarea suelta.** ` +
        'Profundidad máxima: dos niveles. Un tercer nivel es una excepción de emergencia (hay que ' +
        'tocar algo de una subtarea que otra persona está trabajando ahora); cualquier otro caso ' +
        'va como hermana vinculada, no anidada más profundo.',
    );
  }
  out.push('');
  out.push(
    '**Después de crear, RE-VERIFICÁ.** La ventana entre buscar y crear no se puede cerrar ' +
      '(ClickUp no tiene "crear si no existe" atómico), solo se puede detectar: volvé a buscar y, ' +
      'si apareció otra con el mismo alcance, **gana la de `date_created` más antiguo**; si empatan, ' +
      'el `id` menor en orden lexicográfico. **Si perdiste: PARÁ**, informá los dos ids y no borres ' +
      'nada por tu cuenta.',
  );
  out.push('');

  if (d.use_priorities) {
    out.push('### Prioridad — por impacto si sale mal, no por urgencia sentida ni por tamaño');
    out.push('');
    out.push('| | Cuándo |');
    out.push('| --- | --- |');
    out.push(
      '| `urgent` | **Está sangrando ahora**: producción caída, cobros mal, fuga de datos, secreto expuesto |',
    );
    out.push('| `high` | Toca un área crítica sin estar sangrando, **o** bloquea a otra persona |');
    out.push('| `normal` | **El default.** Feature o refactor de un módulo no crítico |');
    out.push('| `low` | Sin impacto y sin nadie esperando: docs, limpieza, DX de una sola persona |');
    out.push('');
    out.push(
      'Un cambio chico en un área crítica es `high`. Un bug grave todavía sin explotar es `high`, ' +
        'no `urgent` — si todo es urgente, nada lo es. **Ante la duda, `normal`.** Se puede subir ' +
        'después; bajarla, hablalo antes: la puso otra persona por algún motivo.',
    );
    out.push('');
  }

  // ---- Claiming -------------------------------------------------------------------------
  out.push('## Paso 2 — Reclamar (antes de la primera línea de código)');
  out.push('');
  out.push('```');
  out.push('clickup_update_task');
  out.push('  task_id:    "<tarea>"');
  out.push(`  status:     "${st.in_progress}"${' '.repeat(Math.max(1, 18 - st.in_progress.length))}← esto es lo que la reserva`);
  if (d.use_dates) {
    out.push(`  start_date: "${ctx.today}"           ← SOLO si venía vacío; si ya tenía, OMITILO`);
  }
  if (d.auto_assign) {
    out.push('  assignees:  [<la UNIÓN>]           ← ver abajo. Omitilo si ya estabas asignado');
  }
  out.push('```');
  out.push('');
  out.push('### `assignees` es leer, unir y escribir — nunca escribir');
  out.push('');
  out.push(
    '`clickup_update_task.assignees` recibe la **lista completa** y no tiene `add`/`rem`. Mandar ' +
      'solo tu id sobre una tarea que ya tenía dos asignados **borra a esas dos personas, en ' +
      'silencio y sin aviso**. Son tres pasos, siempre:',
  );
  out.push('');
  out.push('```');
  out.push('1. clickup_get_task task_id:"<tarea>"     → leé assignees[].id');
  out.push('2. unión = los actuales + tu id            → sin duplicar, sin quitar a nadie');
  out.push('3. clickup_update_task assignees:[<unión>]');
  out.push('```');
  out.push('');
  out.push(
    '**Nadie saca a nadie**, ni al cerrar ni al reabrir. `assignees` es el registro de quiénes ' +
      'pasaron por la tarea; los comentarios `INICIO` dicen quién hizo qué y cuándo. Son datos ' +
      'distintos y los dos hacen falta.',
  );
  out.push('');
  if (d.use_dates) {
    out.push(
      '**No sobrescribas un `start_date` que ya existía** (reapertura, o tarea previa): marca ' +
        'cuándo arrancó el trabajo original y ese dato no se recupera.',
    );
    out.push('');
  }
  out.push('### Y RE-VERIFICÁ que ganaste la carrera — también al tomar una tarea que ya existía');
  out.push('');
  out.push(
    'Dos personas pueden ver la MISMA tarea en `to do` con segundos de diferencia y ponerla las ' +
      'dos en `in progress`. El segundo `clickup_update_task` **no falla** —el estado ya era ese—, ' +
      'así que sin esta verificación el caso más común del tablero es justo el que queda sin detectar.',
  );
  out.push('');
  out.push('Inmediatamente después de publicar tu `INICIO`, y antes de escribir una línea:');
  out.push('');
  out.push('1. `clickup_get_task_comments` sobre esa tarea.');
  out.push(
    '2. Buscá `INICIO` de un **email distinto al tuyo** sin `FIN`, handoff ni `on hold` posterior.',
  );
  const aliases = (ctx.identity.git_emails || []).filter(Boolean);
  if (aliases.length > 1) {
    out.push(
      `   Tus emails conocidos: ${aliases.map((e) => `\`${e}\``).join(', ')} — un \`INICIO\` de ` +
        'cualquiera de ellos sos vos, no una colisión.',
    );
  }
  out.push('3. **Gana el `INICIO` con timestamp más antiguo.** Si empatan, el `id` de comentario menor.');
  out.push(
    '4. **Si perdiste: PARÁ.** Dejá un comentario `RETIRO`, **no toques el estado** (la tarea es del ' +
      `otro), soltá el claim con \`${ctx.cli} release\` e informale al usuario quién la tiene.`,
  );
  out.push('5. **Si ganaste**, registrá el claim para desbloquear la escritura:');
  out.push('');
  out.push('```bash');
  out.push(
    `${ctx.cli} claim --task-id <id> --title "<título>"${p.handoff ? ' --role <backend|frontend>' : ''}`,
  );
  out.push('```');
  out.push('');

  // ---- Closing --------------------------------------------------------------------------
  out.push('## Paso 3 — Cerrar');
  out.push('');
  if (p.handoff) {
    out.push('**La pregunta obligatoria: ¿esto necesita trabajo de frontend?**');
    out.push('');
    out.push('```');
    out.push('              ¿el cambio necesita implementación visual?');
    out.push('                              │');
    out.push('           ┌──────────────────┴──────────────────┐');
    out.push('          SÍ                                     NO');
    out.push('           │                                      │');
    out.push(`  status: ${st.handoff}${' '.repeat(Math.max(2, 34 - st.handoff.length))}status: ${st.done}`);
    out.push('  + comentario HANDOFF FRONTEND            + comentario FIN');
    out.push('```');
    out.push('');
    out.push(
      '**Criterio para decir "no requiere frontend" con honestidad:** no alcanza con que *vos* no ' +
        'hayas tocado el frontend. Hay que poder afirmar que **nada de lo que el frontend ya ' +
        'consume cambió**: ni rutas, ni forma de la respuesta, ni códigos de error, ni campos ' +
        'obligatorios del request. **Si dudás, va a `update required`** — un handoff de más cuesta ' +
        'un comentario; uno de menos deja el frontend roto sin que nadie se entere.',
    );
    out.push('');
    out.push(
      '**`update required` significa UNA cosa: falta el frontend.** Para "quedó a medias" está ' +
        '`on hold`. Si se usa para las dos, el filtro del frontend se llena de ruido y el mecanismo ' +
        'pierde el sentido.',
    );
    out.push('');
  }
  out.push('```');
  out.push('clickup_update_task');
  out.push('  task_id: "<tarea>"');
  out.push(`  status:  "${st.done}"`);
  if (d.use_dates) out.push(renderEndDateCall(d));
  out.push('```');
  out.push('');
  if (d.use_dates) out.push(renderEndDateRule(d, p));
  out.push('');
  out.push('Después: `clickup_create_comment` con el bloque `FIN`, y soltá el claim:');
  out.push('');
  out.push('```bash');
  out.push(`${ctx.cli} release`);
  out.push('```');
  out.push('');
  out.push(
    '**Si se abandona a mitad, nunca se deja en `in progress`.** Pasa a `on hold` con un ' +
      'comentario que diga **dónde quedó**. Una tarea colgada en `in progress` bloquea a todos los ' +
      'demás por nada.',
  );
  out.push('');

  // ---- Comment formats ------------------------------------------------------------------
  out.push('## Formato de los comentarios');
  out.push('');
  out.push('```');
  out.push(`**Ejecutor:** ${ctx.gitEmail ?? '<email de git>'}`);
  if (p.handoff) out.push('**Rol:** backend | frontend        ← OBLIGATORIO');
  out.push('**Acción:** INICIO — <tarea>');
  out.push('**Resumen:** <una o dos líneas de qué se va a hacer>');
  out.push('```');
  out.push('');
  out.push('```');
  out.push(`**Ejecutor:** ${ctx.gitEmail ?? '<email de git>'}`);
  out.push('**Acción:** FIN — <tarea>');
  out.push('**Resumen:** <qué se hizo, en simple>');
  out.push('**Sin verificar:** <lo que quedó sin probar, o "nada">');
  out.push('```');
  out.push('');
  out.push(
    '**`Sin verificar:` no es opcional.** Es normal que algo quede sin probar; lo que no es ' +
      'aceptable es que no esté dicho.',
  );
  if (
    ctx.identity.clickup_email &&
    ctx.gitEmail &&
    ctx.identity.clickup_email.toLowerCase() !== ctx.gitEmail.toLowerCase()
  ) {
    out.push('');
    out.push(
      `**Tu email de git y tu cuenta de ClickUp NO coinciden** (\`${ctx.gitEmail}\` vs ` +
        `\`${ctx.identity.clickup_email}\`). Poné las dos en el comentario, así se puede cruzar un ` +
        'commit con una tarea:',
    );
    out.push('');
    out.push('```');
    out.push(`**Ejecutor:** ${ctx.gitEmail} (git) — cuenta ClickUp: ${ctx.identity.clickup_email}`);
    out.push('```');
  }
  out.push('');

  // ---- Never ----------------------------------------------------------------------------
  out.push('## Qué NO va a ClickUp');
  out.push('');
  out.push(
    'Credenciales, contenido de `.env`, tokens, claves, volcados de datos de clientes, ni ' +
      'fragmentos de consultas con datos reales. ClickUp es un sistema externo: lo que se escribe ' +
      'ahí sale del repo. **Vale también para los adjuntos.**',
  );
  out.push('');

  out.push('## Límites de la API vía MCP (verificados, no asumidos)');
  out.push('');
  out.push(
    '- **`date_created` no se puede definir**: lo estampa el servidor. Por eso la fecha de ' +
      'solicitud va en la descripción.',
  );
  out.push(
    '- **`date_closed` se estampa solo, pero SOLO en estados de tipo `closed`.** Verificado ' +
      'contra un tablero real: un estado de tipo `done` cierra la tarea en la UI y deja ' +
      '`date_closed` en `null`. Por eso la fecha de fin nunca se deja únicamente a ese campo.',
  );
  out.push(
    '- **`date_closed_from` no filtra estrictamente por fecha:** devuelve las tareas del **grupo ' +
      'cerrado**, incluidas las que tienen `date_closed: null`. Lo que sí hace es **excluir todo ' +
      'lo abierto** — por eso nunca va en la búsqueda principal, y por eso la pasada 2 sirve igual.',
  );
  out.push('- **`assignees` recibe la lista completa** y no tiene `add`/`rem` → mandá la unión.');
  out.push(
    '- **`clickup_resolve_assignees` con un email que no es miembro devuelve `null` en esa ' +
      'posición del array, sin error.** Si no lo chequeás, mandás `[null]` como asignados.',
  );
  out.push('- **`"me"` resuelve al dueño del token**, nunca al ejecutor. No lo uses para asignar.');
  out.push('- `start_date` / `due_date` aceptan `YYYY-MM-DD`; `"none"` los limpia (solo en update).');
  out.push('- `priority` se **lee** como objeto y se **escribe** como string. No son la misma forma.');
  out.push(
    '- `clickup_filter_tasks` pagina de a 100 (`has_more` → `page: next_page`) y `include_closed` ' +
      'viene **apagado** por defecto.',
  );
  out.push(
    '- `clickup_filter_tasks` **no** filtra por fecha de creación; `date_closed_from` devuelve ' +
      '**solo tareas cerradas**, así que nunca va en la búsqueda principal.',
  );
  out.push('- `clickup_search` sí filtra por `created_date_from` y pagina con `cursor`/`next_cursor`.');
  out.push(
    '- **No hay herramienta para listar tags**, y `clickup_add_tag_to_task` falla si el tag no ' +
      'existe → este protocolo no asigna tags.',
  );
  out.push('- **No existe** herramienta para crear espacios, ni `delete_list`, ni `delete_folder`.');
  out.push('- **Sí** se puede mover una tarea (`clickup_move_task`) y el id sobrevive.');
  out.push(
    '- Las herramientas de ClickUp son **deferred**: traé su esquema con ' +
      '`ToolSearch(query: "select:clickup_filter_tasks,clickup_update_task,…")` antes de invocarlas.',
  );

  return out.join('\n');
}

function renderSearch(ctx) {
  const p = ctx.project;
  const d = ctx.defaults;
  const s2 = ctx.statuses;
  const days = d.search_window_days ?? 30;
  // 0 significa "sin límite": la búsqueda no lleva filtro de fecha. En un tablero chico es
  // estrictamente mejor —no se puede rehacer trabajo viejo por no haberlo visto— y además
  // colapsa las dos primeras pasadas en una, porque `include_closed:true` sin filtro de fecha
  // ya trae todo.
  const unlimited = !Number.isFinite(days) || days <= 0;
  const list = p.list_id ?? '<list_id>';
  const out = [];

  if (unlimited) {
    out.push('**Dos pasadas. La ventana está en SIN LÍMITE: se busca todo el historial.**');
    out.push('');
    out.push('```');
    out.push('# 1) TODO: lo abierto y lo cerrado, sin límite de fecha');
    out.push(`clickup_filter_tasks  list_ids:["${list}"]  include_closed:true  subtasks:true`);
    out.push('');
    out.push('# 2) Texto, también sin límite');
    out.push('clickup_search  keywords:"<términos>"');
    out.push(`                filters:{ location:{subcategories:["${list}"]} }`);
    out.push('```');
    out.push('');
    out.push(
      '**`include_closed: true` no es opcional.** Viene **apagado** por defecto: sin él una tarea ' +
        'ya cerrada no aparece y se crea un duplicado exacto.',
    );
    out.push('');
    out.push(
      '**Paginá hasta el final** (`has_more` → `page: next_page`, y `next_cursor` en la búsqueda ' +
        'por texto). Sin ventana de fecha, este barrido puede traer bastante: es el precio de no ' +
        'perderse nada, y está elegido a propósito.',
    );
  } else {
    out.push('**Tres pasadas, y ninguna barre el tablero entero.**');
    out.push('');
    out.push('```');
    out.push('# 1) TODO lo abierto — SIN límite de fecha');
    out.push(`clickup_filter_tasks  list_ids:["${list}"]  include_closed:false  subtasks:true`);
    out.push('');
    out.push(`# 2) Cerradas de los últimos ${days} días`);
    out.push(`clickup_filter_tasks  list_ids:["${list}"]  include_closed:true`);
    out.push(`                      date_closed_from:"${ctx.closedSince}"  subtasks:true`);
    out.push('');
    out.push('# 3) Texto, misma ventana');
    out.push('clickup_search  keywords:"<términos>"');
    out.push(`                filters:{ location:{subcategories:["${list}"]},`);
    out.push(`                          created_date_from:"${ctx.closedSince}" }`);
    out.push('```');
  }

  out.push('');
  out.push('| Qué | Ventana |');
  out.push('| --- | --- |');
  out.push(
    `| \`${s2.todo}\`, \`${s2.in_progress}\`, **\`${s2.on_hold}\`**${
      p.handoff ? `, **\`${s2.handoff}\`**` : ''
    } | **Sin límite de fecha** |`,
  );
  out.push(`| \`${s2.done}\` | ${unlimited ? '**Sin límite de fecha**' : `Últimos ${days} días`} |`);
  out.push(
    `| Búsqueda por texto | ${unlimited ? '**Sin límite de fecha**' : `Últimos ${days} días`} |`,
  );
  out.push('');
  out.push(
    '**Lo que está esperando a alguien NUNCA se acota por fecha.** Es trabajo **parado** y puede ' +
      'llevar meses ahí sin dejar de ser relevante: un handoff de hace tres meses sigue siendo un ' +
      'handoff pendiente. Acotarlo lo volvería invisible justo cuando más falta hace.',
  );
  out.push('');

  if (unlimited) {
    out.push(
      '**Si no aparece en ninguna de las dos pasadas, no existe: procedé.** Con la ventana sin ' +
        'límite no hay trabajo viejo que se pueda escapar — el intercambio es que cada reclamo ' +
        'pagina más tareas.',
    );
  } else {
    out.push(
      '**Si no aparece en ninguna de las tres, NO hay bloqueante: procedé.** El precio, dicho ' +
        `claro: una tarea cerrada hace más de ${days} días no va a aparecer, así que se puede ` +
        'rehacer trabajo muy viejo. Es un intercambio deliberado. **Si el usuario menciona que ' +
        '"esto ya se hizo alguna vez", ampliá la ventana a mano** — ahí el dato lo tiene él, no el ' +
        'tablero.',
    );
    out.push('');
    out.push(
      `Para cambiar la ventana: \`${ctx.cli} config set --key defaults.search_window_days --value <N>\` ` +
        `(o \`0\` para sin límite). Por proyecto: \`${ctx.cli} project set … --search-window-days <N>\`.`,
    );
  }

  out.push('');
  out.push(
    '**Probá más de un término en la búsqueda por texto** (el módulo, el síntoma, el nombre ' +
      'técnico) y paginá mientras haya `next_cursor`. Compará por **significado**, no por ' +
      'coincidencia literal de título.',
  );

  if (ctx.project.naming === 'prefixed') {
    out.push('');
    out.push('Compará también por **prefijo del ID**, que en este proyecto es parte del nombre.');
  }
  return out.join('\n');
}
function renderNaming(p, ctx) {
  if (p.naming === 'prefixed') {
    const initials = deriveInitials(ctx.gitEmail);
    const stamp = ctx.today.slice(2).replace(/-/g, '');
    return `T-${stamp}-${initials}-<slug-en-kebab-case>`;
  }
  return '<título descriptivo, sin inventar esquemas de ID>';
}

/** Initials for the `T-<YYMMDD>-<initials>-<slug>` scheme: local part of the email, 8 chars. */
export function deriveInitials(email) {
  if (!email) return 'xxxxxxxx';
  return (
    String(email)
      .split('@')[0]
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 8) || 'xxxxxxxx'
  );
}

function renderEndDateCall(d) {
  switch (d.end_date_field) {
    case 'due_date':
      return '  due_date: "<hoy>"                 ← la fecha de fin, SOLO acá';
    case 'custom_field':
      return '  custom_fields: [{ id:"<id del campo Fecha de fin>", value:"<hoy>" }]';
    default:
      return '  markdown_description: "<la descripción, con la línea **Finalizado:** agregada>"';
  }
}

function renderEndDateRule(d, p) {
  const out = [];
  out.push('### La fecha de fin va SOLO en `complete`');
  out.push('');
  if (d.end_date_field === 'due_date') {
    out.push(
      '**En este proyecto la fecha de fin va en `due_date`.** Ningún otro cambio de estado la toca: ' +
        `\`on hold\`${p.handoff ? ', `update required`' : ''} y una vuelta a \`to do\` la dejan como estaba. ` +
        'Una fecha de fin en una tarea que no terminó es una mentira que después alguien lee como dato.',
    );
    out.push('');
    out.push(
      '**Al reabrir (`complete → in progress`) se limpia: `due_date: "none"`.** Es el inverso ' +
        'exacto: la tarea dejó de estar terminada.',
    );
    out.push('');
    out.push(
      '⚠️ **Si la tarea ya traía un `due_date` distinto** —un vencimiento real puesto por otra ' +
        'persona— se sobrescribe, **pero el valor anterior se anota en el comentario `FIN`**. Así ' +
        'no desaparece en silencio.',
    );
  } else if (d.end_date_field === 'custom_field') {
    out.push(
      'La fecha de fin va en un custom field de tipo Date llamado **`Fecha de fin`**. Antes del ' +
        'update, una llamada a `clickup_get_custom_fields` sobre la lista: si el campo existe, ' +
        'llenalo en el **mismo** update. Si no está, seguí sin él y no intentes crearlo (el ' +
        'conector no puede).',
    );
    out.push('');
    out.push('**No toques `due_date`:** es la fecha límite del equipo, no la de fin.');
  } else {
    out.push(
      'ClickUp **ya estampa `date_closed`** solo, y solo en los estados cerrados: no hay que ' +
        'escribirlo. Lo único que se agrega es la línea `**Finalizado:** YYYY-MM-DD` a la ' +
        'descripción, debajo de `**Solicitado:**`, porque `date_closed` trae hora y no se muestra ' +
        'en la vista de lista.',
    );
    out.push('');
    out.push(
      '⚠️ **`due_date` NO se usa para esto. Nunca.** Es la trampa evidente —es el único campo de ' +
        'fecha libre que queda— y sería un error de datos: el equipo usa `due_date` como **fecha ' +
        'límite real**, y escribir ahí la fecha de fin **borra el vencimiento que puso otra ' +
        'persona**, en silencio y sin forma de recuperarlo.',
    );
  }
  if (p.handoff) {
    out.push('');
    out.push(
      '**En la rama `update required` NO se escribe ninguna fecha de fin.** El backend terminó; la ' +
        'tarea no. La escribe quien la pase a `complete`. Lo mismo vale para `on hold`.',
    );
  }
  return out.join('\n');
}

function renderUnregistered(ctx) {
  return [
    '# ClickUp — este proyecto todavía no está configurado',
    '',
    `Directorio: \`${ctx.cwd}\``,
    '',
    'No hay ninguna configuración de ClickUp para esta carpeta, así que **el protocolo de tareas',
    'no aplica todavía y el candado de escritura está abierto**: se puede trabajar normalmente.',
    '',
    'Si este proyecto debería generar tareas en ClickUp, corré **`/clickup-setup`**. Va a preguntar:',
    '',
    '1. En qué **espacio y lista** de ClickUp viven las tareas de este proyecto.',
    '2. Si genera **varias tareas normales** o **una tarea principal con subtareas**.',
    '3. O si este proyecto queda **excluido** — y eso también se registra, para no volver a preguntar.',
    '',
    '**No inventes coordenadas ni empieces a crear tareas sin pasar por `/clickup-setup`.**',
    'Crear tareas en el espacio equivocado de un tablero compartido es más difícil de deshacer',
    'que preguntar.',
  ].join('\n');
}

function renderExcluded(ctx) {
  const p = ctx.project;
  return [
    '# ClickUp — proyecto excluido a propósito',
    '',
    `Directorio: \`${ctx.cwd}\``,
    p.excluded_reason ? `Motivo registrado: ${p.excluded_reason}` : '',
    p.excluded_at ? `Excluido el ${p.excluded_at}` : '',
    '',
    '**Este proyecto NO gestiona tareas en ClickUp.** No busques tareas, no crees tareas, no',
    'comentes nada, y no le preguntes al usuario si quiere configurarlo: ya respondió que no.',
    '',
    'El candado de escritura está abierto. Trabajá con normalidad.',
    '',
    'Si el usuario cambia de opinión, el camino es `/clickup-setup` — solo si lo pide él.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

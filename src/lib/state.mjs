// Per-project runtime state: the claimed task, and the written-down exemption.
//
// This lives in ~/.claude/clickup-flow/state/, NOT in the project. The three repos this tool
// generalises all kept `.claude/.tarea-actual` inside the checkout, which meant every
// participating repo needed a .gitignore entry and every `git status` had a stray file in it.
// Central state costs nothing and keeps the tool out of the user's diff.
//
// Everything here degrades to "no state" on any error. A hook that cannot read its state file
// must behave like a hook with no state, never like a hook that crashes.

import fs from 'node:fs';
import path from 'node:path';
import { projectStateFile, statePath, canonicalProjectKey, writeJsonAtomic } from './paths.mjs';
import {
  DEFAULT_EXEMPTION_HOURS,
  MAX_EXEMPTION_HOURS,
  DEFAULT_CLAIM_STALE_HOURS,
} from './config.mjs';

function emptyState() {
  return { claims: [], exemption: null, mcp: null, timer: null, sync_failed: [], stop: null };
}

/**
 * Normalizar los claims leidos del disco, y MIGRAR el formato viejo de paso.
 *
 * Hasta aca el estado guardaba UN claim (`claim`, objeto o null), porque el protocolo llevaba una
 * tarea por proyecto. Ahora lleva N, asi que el campo es `claims` (lista). La migracion es
 * perezosa y silenciosa: se hace al leer, y el archivo queda en el formato nuevo la proxima vez
 * que algo escriba. No hay paso de migracion que correr ni version que recordar.
 *
 * LA LISTA SE LLAVEA POR `task_id`, NO POR SESION, y esa eleccion es el corazon del rediseno.
 * Una sola sesion tambien puede llevar dos tareas, asi que la sesion es un atributo del claim y
 * no su identidad. Ademas `task_id` es lo unico que la evidencia del hook `PostToolUse` conoce:
 * llavear por ahi es lo que hace imposible que una mutacion verifique la tarea equivocada.
 *
 * Un `task_id` repetido es un error de escritura, no dos tareas: gana el ultimo y se descarta el
 * duplicado.
 */
function normalizeClaims(parsed) {
  const crudos = Array.isArray(parsed?.claims)
    ? parsed.claims
    : parsed?.claim && typeof parsed.claim === 'object' && !Array.isArray(parsed.claim)
      ? [parsed.claim]
      : [];
  const porTarea = new Map();
  for (const c of crudos) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    const id = c.task_id ? String(c.task_id) : null;
    if (!id) continue;
    porTarea.set(id, { ...c, task_id: id, session: c.session ?? null });
  }
  return [...porTarea.values()];
}

/**
 * Las deudas de sincronizacion, siempre como lista.
 *
 * Tambien migra: era UN objeto, y con N tareas activas un cierre forzado puede dejar mas de una
 * deuda. Guardar solo la ultima perderia en silencio justo la evidencia que este registro existe
 * para no perder.
 */
function normalizeSyncFailed(parsed) {
  const crudo = parsed?.sync_failed;
  const lista = Array.isArray(crudo) ? crudo : crudo && typeof crudo === 'object' ? [crudo] : [];
  const porTarea = new Map();
  for (const d of lista) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
    porTarea.set(d.task_id ? String(d.task_id) : '__sin_id__', d);
  }
  return [...porTarea.values()];
}

export function readState(projectDir) {
  const file = projectStateFile(projectDir);
  if (!fs.existsSync(file)) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      claims: normalizeClaims(parsed),
      exemption: parsed?.exemption ?? null,
      // Evidencia recogida por el hook PostToolUse desde el RESULTADO real de las herramientas
      // MCP. Ver `recordMcpWrite`: esto es lo que separa "el modelo dice que creó la tarea" de
      // "la tarea existe".
      mcp: parsed?.mcp ?? null,
      // El cronómetro de ClickUp, tal como lo vio el hook `PostToolUse` — nunca como lo anunció
      // el modelo. Ver `recordTimerEvent`.
      timer: parsed?.timer ?? null,
      // Cierres de turno que se soltaron sin sincronizar. Persisten entre sesiones a propósito.
      sync_failed: normalizeSyncFailed(parsed),
      // Contador anti-loop del hook Stop, por sesión.
      stop: parsed?.stop ?? null,
    };
  } catch {
    return emptyState();
  }
}

function writeState(projectDir, state) {
  fs.mkdirSync(statePath(), { recursive: true });
  const file = projectStateFile(projectDir);
  const payload = {
    project: canonicalProjectKey(projectDir),
    updated_at: new Date().toISOString(),
    ...state,
  };
  // `claim` (singular) es el formato viejo. `readState` ya lo migro a `claims`, asi que dejarlo
  // en el payload escribiria los dos y el proximo lector tendria dos fuentes de verdad.
  delete payload.claim;
  return writeJsonAtomic(file, payload);
}

/** Los claims activos del proyecto, siempre una lista. Nunca null, nunca undefined. */
export function activeClaims(state) {
  return Array.isArray(state?.claims) ? state.claims : [];
}

/** El claim de una tarea puntual, o `null`. Es la UNICA forma de llegar a un claim por id. */
export function findClaim(state, taskId) {
  if (!taskId) return null;
  const id = String(taskId);
  return activeClaims(state).find((c) => c.task_id === id) ?? null;
}

/**
 * Este claim, la responsabilidad de esta sesion?
 *
 * ESCALERA DE DEGRADACION, y cada peldano se eligio por cual es el peor caso:
 *
 *   · el claim no registro sesion  -> es de todos. Es el comportamiento que habia antes de que
 *     existieran los claims por sesion, y lo conservan los estados viejos ya migrados.
 *   · no se quien soy              -> no puedo excluir a nadie, asi que me hago cargo. Fallar
 *     para el lado de exigir de mas nunca pierde trabajo; fallar para el otro lado si.
 *   · los dos ids estan            -> comparacion exacta.
 *
 * Lo usa el hook `Stop` para no exigirle a una sesion la tarea de otra, que es exactamente el
 * bloqueo cruzado que este rediseno vino a eliminar. El guard NO lo usa: ver `cmdGuard`.
 */
export function claimIsMine(claim, sessionId) {
  if (!claim?.session) return true;
  if (!sessionId) return true;
  return claim.session === String(sessionId);
}

/** Los claims de los que ESTA sesion tiene que rendir cuentas. Ver `claimIsMine`. */
export function claimsOwnedBy(state, sessionId) {
  return activeClaims(state).filter((c) => claimIsMine(c, sessionId));
}

/**
 * Agregar una tarea reclamada. Esto es lo que desbloquea la escritura.
 *
 * `role` matters as much as the id: `in progress` alone never says whether backend or frontend
 * is holding the task, which is the single most reliable way to misread a shared board.
 *
 * AGREGA, no reemplaza. Antes esta funcion pisaba el claim vigente y por eso el CLI tenia que
 * rechazar la segunda tarea del proyecto: con un solo lugar donde guardar, dos tareas activas
 * eran indistinguibles de un estado corrupto. Ahora conviven, y la unica colision posible es
 * reclamar dos veces la MISMA tarea, que se resuelve actualizando la entrada en vez de duplicarla.
 *
 * `session` se graba desde quien llama (el CLI, que lee `CLAUDE_CODE_SESSION_ID`). Medido: un
 * subagente ve el MISMO id que su padre, asi que trabajar en subagentes no fragmenta la
 * responsabilidad; dos sesiones de Claude Code distintas si tienen ids distintos, que es
 * justamente la separacion que hace falta.
 */
export function addClaim(projectDir, claim) {
  const state = readState(projectDir);
  const taskId = claim.taskId ? String(claim.taskId) : null;
  const previo = findClaim(state, taskId);
  const entrada = {
    task_id: taskId,
    title: claim.title ?? previo?.title ?? null,
    url: claim.url ?? previo?.url ?? (taskId ? `https://app.clickup.com/t/${taskId}` : null),
    role: claim.role ?? previo?.role ?? null,
    git_email: claim.gitEmail ?? previo?.git_email ?? null,
    session: claim.session ? String(claim.session) : (previo?.session ?? null),
    // El nombre REAL de la tarea en ClickUp, cuando el harness lo vio pasar. Ver `recordTaskName`.
    // Del argumento, de lo que ya tenía, o de lo que el hook archivó al crearse la tarea —en ese
    // orden. El tercero es el que cubre el caso normal: crear por MCP y reclamar después.
    clickup_name:
      claim.clickupName ?? previo?.clickup_name ?? (taskId ? (state.mcp?.names?.[taskId] ?? null) : null),
    claimed_at: previo?.claimed_at ?? claim.claimedAt ?? new Date().toISOString(),
    // Se llena SOLO desde `recordMcpWrite`, nunca desde un argumento. Ver `claimVerified`.
    verified_at: previo?.verified_at ?? null,
    verified_by: previo?.verified_by ?? null,
  };
  // Si el modelo ya creó la tarea por MCP antes de reclamarla —que es el orden natural: primero
  // se crea, después se registra— la evidencia ya está en disco. Buscarla acá evita marcar como
  // "sin verificar" un trabajo que sí se hizo, que sería el falso positivo más molesto posible.
  if (!entrada.verified_at) {
    const previa = (state.mcp?.writes ?? []).find((w) => taskId && w.task_id === taskId);
    if (previa) {
      entrada.verified_at = previa.at;
      entrada.verified_by = previa.tool;
    }
  }
  state.claims = [...activeClaims(state).filter((c) => c.task_id !== taskId), entrada];
  // Claiming a task retires any standing exemption: the two states are alternatives, and an
  // exemption left behind would keep the lock open after the task is closed.
  state.exemption = null;
  return writeState(projectDir, state);
}

/**
 * Cuántas mutaciones MCP se recuerdan por proyecto.
 *
 * Es una ventana de evidencia, no un historial: lo único que hay que poder contestar es "¿esta
 * tarea que se está reclamando o cerrando existe de verdad?". Guardar todo haría crecer el
 * archivo de estado sin límite, en una carpeta que nadie mira.
 */
const MAX_EVIDENCIA = 40;

/**
 * Grabar una mutación REAL de ClickUp, leída del `tool_response` de una llamada MCP.
 *
 * ACÁ ESTÁ EL CIERRE DEL HUECO. La crítica lo diagnosticó bien: los hooks son deterministas pero
 * no pueden escribir en ClickUp, y el modelo puede escribir pero no está obligado a nada. Entre
 * esas dos mitades vivía todo el producto.
 *
 * Lo que faltaba no era que el hook escribiera. Era que el hook MIRARA. `PostToolUse` recibe el
 * resultado de la herramienta MCP, así que el registro local deja de ser lo que el modelo dice
 * que hizo y pasa a ser lo que el harness vio que pasó. El modelo sigue siendo el único que
 * puede crear la tarea — pero deja de ser la única fuente sobre si la creó.
 */
export function recordMcpWrite(projectDir, { tool, taskId, at } = {}) {
  const state = readState(projectDir);
  state.mcp = state.mcp && typeof state.mcp === 'object' ? state.mcp : {};
  const writes = Array.isArray(state.mcp.writes) ? state.mcp.writes : [];
  const cuando = at ?? new Date().toISOString();
  writes.push({ tool: tool ?? null, task_id: taskId ?? null, at: cuando });
  state.mcp.writes = writes.slice(-MAX_EVIDENCIA);
  state.mcp.last_seen_at = cuando;

  // La evidencia verifica EXACTAMENTE el claim de esa tarea, y ninguno mas.
  //
  // Con N tareas activas esta es la linea que garantiza que no se crucen: la unica llave es el
  // `task_id` que devolvio la herramienta MCP, asi que un comentario en la tarea A no puede
  // marcar verificada a la B ni aunque B sea la mas reciente. No hay "la actual" que confundir.
  if (taskId) {
    for (const c of activeClaims(state)) {
      if (c.task_id === taskId && !c.verified_at) {
        c.verified_at = cuando;
        c.verified_by = tool ?? null;
      }
    }
    // Cualquier evidencia sobre una tarea que había quedado sin sincronizar salda ESA deuda.
    state.sync_failed = (state.sync_failed ?? []).filter((d) => d.task_id !== taskId);
  }
  writeState(projectDir, state);
  return state.mcp;
}

/**
 * Anotar el nombre CANÓNICO de una tarea sobre su claim.
 *
 * QUÉ PROBLEMA RESUELVE. El `title` del claim lo escribe el modelo al reclamar, y nada lo ata al
 * `name` de la tarea en ClickUp. Cuando divergen —porque el modelo escribió el alcance de lo que
 * va a hacer en vez del nombre de la tarea— un lector posterior no puede distinguir "el título
 * describe otra cosa" de "el estado está corrupto". Pasó de verdad: una sesión leyó esa
 * discrepancia, concluyó que el estado era basura vieja, e hizo `release --force` sobre el claim
 * de otra. Con los dos nombres guardados, la discrepancia se ve como lo que es.
 *
 * POR QUÉ NO ENTRA EN `recordMcpWrite`, que es la decisión de diseño que importa acá.
 *
 * Es la misma asimetría que separa el cronómetro de las mutaciones: registrar un NOMBRE no es
 * prueba de que el trabajo quedó registrado en la tarea. Si esto tocara `mcp.writes` o
 * `verified_at`, renombrar una tarea alcanzaría para abrir el candado y soltar el claim sin
 * haber comentado ni cerrado nada. Entonces escribe un campo y nada más.
 *
 * Devuelve `true` si cambió algo.
 */
export function recordTaskName(projectDir, { taskId, name } = {}) {
  const id = taskId ? String(taskId) : null;
  const nombre = String(name ?? '').trim();
  if (!id || !nombre) return false;
  const state = readState(projectDir);

  // SE GUARDA AUNQUE TODAVÍA NO HAYA CLAIM, y esto no es una precaución: es el caso NORMAL.
  //
  // El orden natural del protocolo es crear la tarea por MCP y recién después registrarla con
  // `claim`. O sea que cuando este hook corre, el claim no existe todavía. Anotar solo sobre los
  // claims presentes haría que el nombre se perdiera justo en el único momento en que el harness
  // lo ve pasar. Se archiva acá y `addClaim` lo recoge, igual que hace con la evidencia previa.
  state.mcp = state.mcp && typeof state.mcp === 'object' ? state.mcp : {};
  const previos =
    state.mcp.names && typeof state.mcp.names === 'object' && !Array.isArray(state.mcp.names)
      ? state.mcp.names
      : {};
  // Se reinserta al final para que el recorte por tamaño tire los más viejos: las claves de
  // string conservan el orden de inserción, y sin el delete un id ya presente quedaría al frente.
  delete previos[id];
  previos[id] = nombre;
  const entradas = Object.entries(previos);
  state.mcp.names = Object.fromEntries(entradas.slice(-MAX_EVIDENCIA));

  for (const c of activeClaims(state)) {
    if (c.task_id === id) c.clickup_name = nombre;
  }
  writeState(projectDir, state);
  return true;
}

/**
 * ¿El título que escribió el modelo dice otra cosa que el nombre real de la tarea?
 *
 * `false` cuando falta cualquiera de los dos: sin nombre canónico no hay con qué comparar, y
 * afirmar una divergencia que no se puede demostrar es peor que callarse — es exactamente el
 * tipo de dato engañoso que esta función existe para exponer.
 *
 * La comparación normaliza espacios y mayúsculas. Un título que difiere solo en eso es el mismo
 * título, y marcarlo entrenaría a ignorar el aviso.
 */
export function claimNameMismatch(claim) {
  const canonico = String(claim?.clickup_name ?? '').trim();
  const propio = String(claim?.title ?? '').trim();
  if (!canonico || !propio) return false;
  const norm = (t) => t.toLowerCase().replace(/\s+/g, ' ');
  return norm(canonico) !== norm(propio);
}

/**
 * La última señal de vida de un claim: cuándo se reclamó, o la última mutación MCP sobre su
 * tarea, lo que sea más reciente.
 *
 * Que cuente la evidencia y no solo `claimed_at` es la diferencia entre un vencimiento útil y uno
 * que miente: quien está trabajando de verdad comenta el avance y mueve el estado, y cada una de
 * esas llamadas es prueba de que sigue ahí. Sin esto, una tarea con actividad de hace un minuto
 * quedaría declarada abandonada por haberse reclamado a la mañana.
 */
export function claimActivityAt(state, claim) {
  if (!claim) return null;
  let ultima = Date.parse(claim.claimed_at ?? '');
  if (!Number.isFinite(ultima)) ultima = null;
  for (const w of state?.mcp?.writes ?? []) {
    if (w.task_id !== claim.task_id) continue;
    const cuando = Date.parse(w.at ?? '');
    if (Number.isFinite(cuando) && (ultima === null || cuando > ultima)) ultima = cuando;
  }
  return ultima === null ? null : new Date(ultima).toISOString();
}

/**
 * ¿Este claim dejó de ser evidencia de que alguien está encima de la tarea?
 *
 * NO significa "la tarea venció" ni "el claim se soltó". Significa una sola cosa: que reclamar esa
 * misma tarea desde otra sesión ya no cuenta como trabajo duplicado. Ver `DEFAULT_CLAIM_STALE_HOURS`.
 *
 * Sin fecha legible se considera VENCIDO. Es la dirección correcta: lo que se pierde es la
 * protección contra pisar a alguien que probablemente ya no está, y lo que se ganaría por el otro
 * lado es trabar una tarea para siempre por un timestamp roto.
 */
export function claimStale(state, claim, hours = DEFAULT_CLAIM_STALE_HOURS) {
  const limite = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_CLAIM_STALE_HOURS;
  const desde = Date.parse(claimActivityAt(state, claim) ?? '');
  if (!Number.isFinite(desde)) return true;
  return (Date.now() - desde) / 3_600_000 >= limite;
}

/** ¿Hay evidencia de una mutación MCP sobre `taskId` posterior a `desde`? */
export function hasMcpEvidence(state, taskId, desde = null) {
  if (!taskId) return false;
  const corte = desde ? Date.parse(desde) : null;
  return (state?.mcp?.writes ?? []).some((w) => {
    if (w.task_id !== taskId) return false;
    if (!Number.isFinite(corte)) return true;
    const cuando = Date.parse(w.at ?? '');
    return Number.isFinite(cuando) && cuando >= corte;
  });
}

/**
 * Un claim está verificado cuando el harness vio la mutación, no cuando el modelo la anunció.
 *
 * Recibe UN CLAIM, no el estado. El cambio de firma es a proposito: con N tareas activas,
 * "esta verificado" sin decir cual es una pregunta sin respuesta, y dejar que se siguiera
 * llamando con el estado entero habria devuelto en silencio la verificacion de una tarea
 * cualquiera. Que rompa a quien no se actualizo es el resultado correcto.
 */
export function claimVerified(claim) {
  return Boolean(claim?.verified_at);
}

/**
 * Registrar un evento del CRONÓMETRO de ClickUp, leído del resultado real de la llamada MCP.
 *
 * POR QUÉ ESTO NO ENTRA EN `recordMcpWrite`, que es la decisión de diseño que más importa acá.
 *
 * Arrancar un cronómetro ES una mutación del tablero, así que la tentación es contarla como
 * evidencia y listo. Sería un error: la evidencia de `recordMcpWrite` es lo que autoriza a
 * soltar el claim y a cerrar el turno, y su significado es "el trabajo quedó registrado en la
 * tarea". Un cronómetro no dice nada de eso. Si contara, alcanzaría con arrancar el reloj para
 * poder reclamar, escribir código y soltar sin haber comentado ni cerrado nada — o sea, se
 * podría abrir el candado sin dejar un solo rastro del trabajo, que es exactamente el modo de
 * fallo que el candado existe para evitar.
 *
 * Entonces son dos registros distintos, con dos matchers distintos y dos hooks distintos. El
 * cronómetro se verifica a sí mismo y a nadie más.
 */
export function recordTimerEvent(projectDir, { tool, taskId, at, running } = {}) {
  const state = readState(projectDir);
  const cuando = at ?? new Date().toISOString();

  if (running) {
    state.timer = {
      task_id: taskId ?? null,
      started_at: cuando,
      started_by: tool ?? null,
      stopped_at: null,
    };
  } else {
    // Un `stop` sin cronómetro local previo no se descarta: es el caso real de haber arrancado
    // el reloj en la app de ClickUp y pararlo desde acá. Se registra igual, porque lo único que
    // este estado tiene que poder contestar es "¿queda algo corriendo?".
    state.timer = {
      task_id: taskId ?? state.timer?.task_id ?? null,
      started_at: state.timer?.started_at ?? null,
      started_by: state.timer?.started_by ?? null,
      stopped_at: cuando,
      stopped_by: tool ?? null,
    };
  }
  writeState(projectDir, state);

  // Un `stop` apaga el reloj de TODOS los proyectos, no solo el de este.
  //
  // Porque ClickUp lleva **un cronómetro por persona**, no por proyecto, y este estado vive por
  // proyecto. Sin esto: arrancás el reloj en el repo A, vas al repo B, y ahí lo parás —que es lo
  // que el protocolo te manda hacer cuando el arranque en B falla por "only one timer"—. El reloj
  // real quedó parado, pero el estado de A sigue diciendo "corriendo" para siempre, y `release`
  // en A se traba pidiéndote parar algo que ya está parado.
  //
  // Es seguro justamente por el límite de la API: si una parada tuvo efecto, el reloj que paró
  // era el único que había. No hace falta adivinar cuál era.
  if (!running) apagarRelojesAjenos(projectDir, cuando);

  return state.timer;
}

/** Marca como parado cualquier cronómetro que haya quedado corriendo en OTRO proyecto. */
function apagarRelojesAjenos(projectDir, cuando) {
  const mio = canonicalProjectKey(projectDir);
  for (const archivo of listStateFiles()) {
    try {
      const crudo = JSON.parse(fs.readFileSync(archivo, 'utf8'));
      const clave = crudo?.project;
      if (!clave || clave === mio) continue;
      if (!crudo?.timer?.started_at || crudo.timer.stopped_at) continue;

      const otro = readState(clave);
      if (!otro.timer?.started_at || otro.timer.stopped_at) continue;
      otro.timer = {
        ...otro.timer,
        stopped_at: cuando,
        stopped_by: 'otro proyecto paró el único cronómetro de la cuenta',
      };
      writeState(clave, otro);
    } catch {
      // Un archivo de estado ilegible no puede romper un hook. Se salta: el costo es que ese
      // proyecto pida un `timer clear`, que es exactamente lo que pasaba antes de este arreglo.
    }
  }
}

/**
 * `{ running, taskId, startedAt, hours }` del cronómetro que este proyecto arrancó.
 *
 * Solo sabe de los cronómetros que el harness vio arrancar. Uno iniciado desde la app de ClickUp
 * o el móvil es invisible acá, y eso está bien: la herramienta se hace responsable de lo que
 * ella misma prendió, no de auditar el tablero entero.
 */
export function timerStatus(state) {
  const t = state?.timer;
  if (!t || !t.started_at || t.stopped_at) {
    return { running: false, taskId: t?.task_id ?? null, startedAt: null, hours: 0 };
  }
  const desde = Date.parse(t.started_at);
  // Un `started_at` ilegible o en el futuro se trata como "corriendo desde hace 0". Acá fallar
  // cerrado es seguir considerándolo corriendo: lo peligroso es un reloj olvidado, no uno de más.
  const hours = Number.isFinite(desde) ? Math.max(0, (Date.now() - desde) / 3_600_000) : 0;
  return { running: true, taskId: t.task_id ?? null, startedAt: t.started_at, hours };
}

/** Limpiar el cronómetro local. Para reconciliar cuando se paró por fuera de Claude Code. */
export function clearTimer(projectDir) {
  const state = readState(projectDir);
  const had = Boolean(state.timer);
  state.timer = null;
  writeState(projectDir, state);
  return had;
}

/**
 * Dejar constancia de que un turno se cerró con trabajo sin sincronizar.
 *
 * Persiste ENTRE SESIONES, y eso es deliberado. El hook `Stop` no puede bloquear para siempre —
 * un hook que nunca deja terminar cuelga la sesión y se desinstala esa misma tarde. Entonces
 * suelta, pero deja esto escrito, y el candado de escritura no vuelve a abrirse en este proyecto
 * hasta que se resuelva. El fallo no se olvida: se traslada.
 */
export function setSyncFailed(projectDir, { taskId, reason } = {}) {
  const state = readState(projectDir);
  const id = taskId ? String(taskId) : null;
  const entrada = {
    task_id: id,
    reason: String(reason ?? '').trim() || 'el turno terminó con una tarea reclamada sin verificar',
    at: new Date().toISOString(),
  };
  // Se acumulan, una por tarea. Un cierre forzado con dos tareas activas deja DOS deudas, y
  // guardar solo la ultima borraria la evidencia de que la otra tambien quedo sin reflejar.
  state.sync_failed = [
    ...(state.sync_failed ?? []).filter((d) => (d.task_id ?? null) !== id),
    entrada,
  ];
  return writeState(projectDir, state);
}

/** Saldar deudas de sincronizacion: la de una tarea con `taskId`, o todas sin el. */
export function clearSyncFailed(projectDir, taskId = null) {
  const state = readState(projectDir);
  const antes = (state.sync_failed ?? []).length;
  if (!antes) return false;
  state.sync_failed = taskId
    ? state.sync_failed.filter((d) => d.task_id !== String(taskId))
    : [];
  writeState(projectDir, state);
  return state.sync_failed.length !== antes;
}

/**
 * Contador anti-loop del hook `Stop`, por sesión.
 *
 * Devuelve cuántas veces ya bloqueamos ESTA sesión. El llamador decide con eso; acá solo se
 * lleva la cuenta, reiniciándola cuando cambia el `session_id`.
 */
export function bumpStopBlocks(projectDir, sessionId) {
  const state = readState(projectDir);
  const previo = state.stop?.session_id === sessionId ? (state.stop?.blocks ?? 0) : 0;
  state.stop = { session_id: sessionId ?? null, blocks: previo + 1, at: new Date().toISOString() };
  writeState(projectDir, state);
  return state.stop.blocks;
}

export function resetStopBlocks(projectDir) {
  const state = readState(projectDir);
  if (!state.stop) return false;
  state.stop = null;
  writeState(projectDir, state);
  return true;
}

/**
 * Soltar UNA tarea, por id. Devuelve el claim que se saco, o `null` si no estaba.
 *
 * Exige el id y no tiene default. Es deliberado y es el nucleo del pedido: un `release` que
 * eligiera "la ultima" cerraria la tarea equivocada la primera vez que hay dos activas, y el
 * error seria invisible porque el comando igual reportaria exito.
 */
export function removeClaim(projectDir, taskId) {
  if (!taskId) return null;
  const state = readState(projectDir);
  const id = String(taskId);
  const salido = findClaim(state, id);
  if (!salido) return null;
  state.claims = activeClaims(state).filter((c) => c.task_id !== id);
  writeState(projectDir, state);
  return salido;
}

/** Soltar TODAS las tareas del proyecto. Devuelve cuantas habia. Solo para limpieza explicita. */
export function clearAllClaims(projectDir) {
  const state = readState(projectDir);
  const habia = activeClaims(state).length;
  if (!habia) return 0;
  state.claims = [];
  writeState(projectDir, state);
  return habia;
}

/**
 * Horas pedidas -> horas que se van a respetar, acotadas al techo.
 *
 * Devuelve `{ hours, clamped }`: quien renderiza necesita saber si recortó para poder DECIRLO.
 * Un recorte silencioso deja al usuario creyendo que tiene una ventana que no tiene.
 */
export function clampExemptionHours(hours, defaultHours = DEFAULT_EXEMPTION_HOURS) {
  const base = Number.isFinite(defaultHours) && defaultHours > 0 ? defaultHours : DEFAULT_EXEMPTION_HOURS;
  const pedido = Number.isFinite(hours) && hours > 0 ? hours : base;
  const techo = Math.min(pedido, MAX_EXEMPTION_HOURS);
  return { hours: techo, clamped: techo < pedido };
}

/**
 * Record the written-down decision that this work does not deserve a task.
 *
 * It expires, and that is the whole point. A forgotten exemption would disable the lock
 * permanently and silently — precisely the failure the lock exists to prevent.
 *
 * NACE SIN SESIÓN, a propósito. `session` queda en `null` y lo escribe el GUARD la primera vez
 * que la honra — ver `bindExemption`. Estamparlo acá, desde el proceso que declara, sería lo
 * intuitivo y sería frágil: el CLI corre en el Bash del agente y lee `CLAUDE_CODE_SESSION_ID`,
 * mientras el guard lee el `session_id` que le llega por stdin, y no hay nada que garantice que
 * un job en background o un subagente vean el MISMO id por las dos vías. Si difirieran, la
 * exención nacería ajena a quien la declaró y el guard pediría re-declararla en un bucle.
 *
 * Atando en el primer uso, quien escribe el id y quien lo compara son el mismo actor. No pueden
 * estar en desacuerdo sobre de qué namespace salió.
 */
export function setExemption(projectDir, reason, hours) {
  const state = readState(projectDir);
  const { hours: acotadas } = clampExemptionHours(hours);
  state.exemption = {
    reason: String(reason ?? '').trim() || 'sin motivo declarado',
    declared_at: new Date().toISOString(),
    hours: acotadas,
    session: null,
  };
  return writeState(projectDir, state);
}

/**
 * Atar una exención sin dueño a la sesión que la está por usar. La llama el guard, y sólo el guard.
 *
 * ESTE ES EL ARREGLO, y la duración es apenas el respaldo. Una exención guardaba un `reason` que
 * nada comparaba nunca contra el trabajo en curso: quien la tenía la usaba, incluso una sesión
 * distinta horas después haciendo algo que no se le parecía en nada. Eso es un bearer token, no
 * un permiso acotado.
 *
 * Devuelve `true` si acaba de atarla. Si ya tenía dueño no la toca: una exención se ata UNA vez,
 * o cualquier sesión nueva se adueñaría de ella con sólo llegar primero, que es el agujero otra vez.
 */
export function bindExemption(projectDir, sessionId) {
  const id = String(sessionId ?? '').trim();
  if (!id) return false;
  const state = readState(projectDir);
  const ex = state.exemption;
  // `typeof === 'object'` y no sólo truthy: `exemption` puede ser un string si alguien editó el
  // archivo a mano, y spreadear un string produciría `{0:'p',1:'o',…}` escrito en el estado.
  // Hoy el guard nunca llega acá con basura —exige un `declared_at` que parsee— pero este módulo
  // asume que todo lo que lee puede estar roto, y esa regla no se rompe por un caso improbable.
  if (!ex || typeof ex !== 'object' || Array.isArray(ex) || ex.session) return false;
  state.exemption = { ...ex, session: id };
  writeState(projectDir, state);
  return true;
}

export function clearExemption(projectDir) {
  const state = readState(projectDir);
  const had = Boolean(state.exemption);
  state.exemption = null;
  writeState(projectDir, state);
  return had;
}

/**
 * `{ active, expired, foreign, ageHours, reason }` for the current exemption.
 *
 * `sessionId` es la sesión que PREGUNTA. Con eso se distinguen tres cosas que antes eran una:
 *
 *   expired  → se le acabó el tiempo. Hay que volver a decidir.
 *   foreign  → sigue vigente en el reloj, pero la declaró y la usó OTRA sesión. Hay que
 *              re-declararla con el motivo actual antes de que valga acá.
 *   active   → ni una ni otra.
 *
 * DEGRADACIÓN EN ESCALERA. Si no hay id por algún lado —la exención nunca se ató porque el
 * harness no expone `session_id`, o quien pregunta no lo tiene— no se puede comparar, y una
 * comparación imposible NO puede leerse como "es ajena": eso trabaría instalaciones enteras.
 * En ese caso se cae al comportamiento de siempre, vencimiento por edad. Que es exactamente por
 * qué el default bajó a media hora: cuando la atadura no está disponible, la duración es lo
 * único que queda acotando el daño.
 */
export function exemptionStatus(state, defaultHours = DEFAULT_EXEMPTION_HOURS, sessionId = null) {
  const ex = state?.exemption;
  if (!ex || !ex.declared_at) {
    return { active: false, expired: false, foreign: false, ageHours: 0, reason: null, boundTo: null };
  }
  const boundTo = String(ex.session ?? '').trim() || null;
  const actual = String(sessionId ?? '').trim() || null;
  const foreign = Boolean(boundTo && actual && boundTo !== actual);
  const declared = Date.parse(ex.declared_at);
  if (!Number.isFinite(declared)) {
    // An unreadable timestamp is treated as expired. Failing closed is the right default for
    // something whose only job is to hold a lock open.
    return {
      active: false,
      expired: true,
      foreign,
      ageHours: Infinity,
      reason: ex.reason ?? null,
      boundTo,
    };
  }
  // El techo se aplica también acá, y no sólo al declarar: un `hours` gigante editado a mano en
  // el archivo de estado saltearía `setExemption` por completo.
  const { hours: limitHours } = clampExemptionHours(ex.hours, defaultHours);
  const ageHours = (Date.now() - declared) / 3_600_000;

  // Una exención fechada en el FUTURO se trata como vencida.
  //
  // Sin esto, la edad sale negativa y `negativa >= limite` es false: la exención quedaba vigente
  // hasta que el reloj la alcanzara. Con un `declared_at` en 2099 eso son décadas de candado
  // abierto. Pasa por desfase de reloj, por una VM suspendida, o porque alguien editó el archivo
  // — y en los tres casos la respuesta correcta es la misma: fallar cerrado.
  const expired = ageHours < 0 || ageHours >= limitHours;
  return {
    // Vigente Y propia. Que sean dos condiciones y no una es todo el cambio: el reloj deja de
    // ser lo único que separa "esto lo autoricé yo, para esto" de "esto lo encontré abierto".
    active: !expired && !foreign,
    expired,
    foreign,
    ageHours,
    limitHours,
    reason: ex.reason ?? null,
    boundTo,
  };
}

/**
 * Salud del mecanismo de evidencia, global a la instalación.
 *
 * POR QUÉ EXISTE, y es el error que corrige.
 *
 * La verificación de claims descansa en que el hook `PostToolUse` case el nombre de las
 * herramientas del conector de ClickUp. En esta máquina el matcher es exacto — pero es un string,
 * y un string puede no coincidir en otra instalación, o si el conector se renombra.
 *
 * Y si no coincide, la cadena entera se desmorona hacia el lado MALO: el hook nunca corre, ningún
 * claim se verifica, `Stop` bloquea todos los turnos, `sync_failed` se acumula y el candado no
 * abre más. El usuario cerró la tarea perfectamente y la herramienta le dice que no. Un problema
 * de plomería le traba la máquina.
 *
 * Eso contradice el principio que gobierna todo este repo: **fallar ABIERTO cuando algo no está
 * bien configurado**. El candado viejo lo respetaba; la capa de obligación lo rompía.
 *
 * Entonces se distinguen dos cosas que sin esto se ven iguales:
 *
 *   · "esta TAREA no tiene evidencia"            → el modelo probablemente no cerró. Exigir.
 *   · "esta INSTALACIÓN nunca registró ninguna"  → la plomería está rota. No exigir, avisar.
 *
 * La obligación se arma sola recién cuando el mecanismo demostró funcionar al menos una vez.
 */
const EVIDENCE_FILE = '_mcp-evidence.json';

/**
 * Salud del hook del CRONÓMETRO, en su propio archivo y por el mismo motivo.
 *
 * Va aparte del de las mutaciones a propósito: son dos matchers distintos y pueden fallar por
 * separado. Un conector que registra las escrituras pero renombró las herramientas de tiempo
 * dejaría `_mcp-evidence.json` sano y el cronómetro roto — y contarlos juntos haría que la
 * herramienta exigiera parar un reloj que nunca supo que arrancó.
 */
const TIMER_EVIDENCE_FILE = '_timer-evidence.json';

function evidenceFile(name) {
  return path.join(statePath(), name);
}

function bumpEvidence(name) {
  let previo = { count: 0, first_seen_at: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(evidenceFile(name), 'utf8'));
    if (parsed && typeof parsed === 'object') previo = parsed;
  } catch {
    /* sin archivo o ilegible: se arranca de cero */
  }
  const ahora = new Date().toISOString();
  try {
    fs.mkdirSync(statePath(), { recursive: true });
    writeJsonAtomic(evidenceFile(name), {
      count: Number(previo.count) > 0 ? Number(previo.count) + 1 : 1,
      first_seen_at: previo.first_seen_at ?? ahora,
      last_seen_at: ahora,
    });
  } catch {
    // Que no se pueda escribir NO es motivo para romper un hook. El costo de perder este dato es
    // que la obligación se queda desarmada, y desarmada es el lado seguro.
  }
}

function readEvidence(name) {
  try {
    const parsed = JSON.parse(fs.readFileSync(evidenceFile(name), 'utf8'));
    const count = Number(parsed?.count) || 0;
    return {
      everSeen: count > 0,
      count,
      firstSeenAt: parsed?.first_seen_at ?? null,
      lastSeenAt: parsed?.last_seen_at ?? null,
    };
  } catch {
    return { everSeen: false, count: 0, firstSeenAt: null, lastSeenAt: null };
  }
}

/** El hook `PostToolUse` corrió y registró algo real. Es la prueba de que el matcher funciona. */
export function markEvidenceSeen() {
  bumpEvidence(EVIDENCE_FILE);
}

/** `{ everSeen, count, firstSeenAt, lastSeenAt }`. Nunca lanza: lo leen los hooks. */
export function evidenceHealth() {
  return readEvidence(EVIDENCE_FILE);
}

/** Ídem, para el hook de las herramientas de tiempo. */
export function markTimerSeen() {
  bumpEvidence(TIMER_EVIDENCE_FILE);
}

export function timerHealth() {
  return readEvidence(TIMER_EVIDENCE_FILE);
}

/** Remove a project's state file entirely (used by uninstall and by `project forget`). */
export function dropState(projectDir) {
  const file = projectStateFile(projectDir);
  try {
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      return true;
    }
  } catch {
    /* nothing worth reporting: the file is cache-like by nature */
  }
  return false;
}

/** Every state file on disk, for `doctor`. */
export function listStateFiles() {
  const dir = statePath();
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      // El `_` del prefijo distingue los archivos internos de los de proyecto: contar la
      // evidencia global como "un proyecto con estado" haría mentir a `doctor`.
      .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

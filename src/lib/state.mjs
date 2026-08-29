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

function emptyState() {
  return { claim: null, exemption: null, mcp: null, timer: null, sync_failed: null, stop: null };
}

export function readState(projectDir) {
  const file = projectStateFile(projectDir);
  if (!fs.existsSync(file)) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      claim: parsed?.claim ?? null,
      exemption: parsed?.exemption ?? null,
      // Evidencia recogida por el hook PostToolUse desde el RESULTADO real de las herramientas
      // MCP. Ver `recordMcpWrite`: esto es lo que separa "el modelo dice que creó la tarea" de
      // "la tarea existe".
      mcp: parsed?.mcp ?? null,
      // El cronómetro de ClickUp, tal como lo vio el hook `PostToolUse` — nunca como lo anunció
      // el modelo. Ver `recordTimerEvent`.
      timer: parsed?.timer ?? null,
      // Un cierre de turno que se soltó sin sincronizar. Persiste entre sesiones a propósito.
      sync_failed: parsed?.sync_failed ?? null,
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
  return writeJsonAtomic(file, payload);
}

/**
 * Record a claimed task. This is what unlocks writing.
 *
 * `role` matters as much as the id: `in progress` alone never says whether backend or frontend
 * is holding the task, which is the single most reliable way to misread a shared board.
 */
export function setClaim(projectDir, claim) {
  const state = readState(projectDir);
  const taskId = claim.taskId ?? null;
  state.claim = {
    task_id: taskId,
    title: claim.title ?? null,
    url: claim.url ?? (taskId ? `https://app.clickup.com/t/${taskId}` : null),
    role: claim.role ?? null,
    git_email: claim.gitEmail ?? null,
    claimed_at: claim.claimedAt ?? new Date().toISOString(),
    // Se llena SOLO desde `recordMcpWrite`, nunca desde un argumento. Ver `claimVerified`.
    verified_at: null,
    verified_by: null,
  };
  // Si el modelo ya creó la tarea por MCP antes de reclamarla —que es el orden natural: primero
  // se crea, después se registra— la evidencia ya está en disco. Buscarla acá evita marcar como
  // "sin verificar" un trabajo que sí se hizo, que sería el falso positivo más molesto posible.
  const previa = (state.mcp?.writes ?? []).find((w) => taskId && w.task_id === taskId);
  if (previa) {
    state.claim.verified_at = previa.at;
    state.claim.verified_by = previa.tool;
  }
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

  // Si esta escritura es sobre la tarea reclamada, el claim queda verificado.
  if (state.claim && taskId && state.claim.task_id === taskId && !state.claim.verified_at) {
    state.claim.verified_at = cuando;
    state.claim.verified_by = tool ?? null;
  }
  // Cualquier evidencia sobre la tarea que había quedado sin sincronizar salda la deuda.
  if (state.sync_failed && taskId && state.sync_failed.task_id === taskId) {
    state.sync_failed = null;
  }
  writeState(projectDir, state);
  return state.mcp;
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

/** Un claim está verificado cuando el harness vio la mutación, no cuando el modelo la anunció. */
export function claimVerified(state) {
  return Boolean(state?.claim?.verified_at);
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
  state.sync_failed = {
    task_id: taskId ?? state.claim?.task_id ?? null,
    reason: String(reason ?? '').trim() || 'el turno terminó con una tarea reclamada sin verificar',
    at: new Date().toISOString(),
  };
  return writeState(projectDir, state);
}

export function clearSyncFailed(projectDir) {
  const state = readState(projectDir);
  const had = Boolean(state.sync_failed);
  state.sync_failed = null;
  writeState(projectDir, state);
  return had;
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

export function clearClaim(projectDir) {
  const state = readState(projectDir);
  const had = Boolean(state.claim);
  state.claim = null;
  writeState(projectDir, state);
  return had;
}

/**
 * Record the written-down decision that this work does not deserve a task.
 *
 * It expires, and that is the whole point. A forgotten exemption would disable the lock
 * permanently and silently — precisely the failure the lock exists to prevent.
 */
export function setExemption(projectDir, reason, hours) {
  const state = readState(projectDir);
  state.exemption = {
    reason: String(reason ?? '').trim() || 'sin motivo declarado',
    declared_at: new Date().toISOString(),
    hours: Number.isFinite(hours) && hours > 0 ? hours : 8,
  };
  return writeState(projectDir, state);
}

export function clearExemption(projectDir) {
  const state = readState(projectDir);
  const had = Boolean(state.exemption);
  state.exemption = null;
  writeState(projectDir, state);
  return had;
}

/** `{ active, expired, ageHours, reason }` for the current exemption. */
export function exemptionStatus(state, defaultHours = 8) {
  const ex = state?.exemption;
  if (!ex || !ex.declared_at) return { active: false, expired: false, ageHours: 0, reason: null };
  const declared = Date.parse(ex.declared_at);
  if (!Number.isFinite(declared)) {
    // An unreadable timestamp is treated as expired. Failing closed is the right default for
    // something whose only job is to hold a lock open.
    return { active: false, expired: true, ageHours: Infinity, reason: ex.reason ?? null };
  }
  const limitHours = Number.isFinite(ex.hours) && ex.hours > 0 ? ex.hours : defaultHours;
  const ageHours = (Date.now() - declared) / 3_600_000;

  // Una exención fechada en el FUTURO se trata como vencida.
  //
  // Sin esto, la edad sale negativa y `negativa >= limite` es false: la exención quedaba vigente
  // hasta que el reloj la alcanzara. Con un `declared_at` en 2099 eso son décadas de candado
  // abierto. Pasa por desfase de reloj, por una VM suspendida, o porque alguien editó el archivo
  // — y en los tres casos la respuesta correcta es la misma: fallar cerrado.
  const expired = ageHours < 0 || ageHours >= limitHours;
  return {
    active: !expired,
    expired,
    ageHours,
    limitHours,
    reason: ex.reason ?? null,
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

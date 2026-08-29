// The configuration file: read, migrate, resolve, write.
//
// Two rules govern everything here:
//
//   1. Reading NEVER throws. A corrupt or missing config has to degrade into "not configured",
//      because the hooks read this file on every prompt and on every write, and a hook that
//      throws is a hook that breaks the user's session.
//   2. Writing NEVER drops unknown keys. The file is meant to be hand-edited, and a user who
//      adds a field they care about should not lose it because this version didn't know it.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  configPath,
  toolHome,
  canonicalProjectKey,
  realProjectKey,
  writeJsonAtomic,
} from './paths.mjs';

export const CONFIG_VERSION = 1;

/**
 * Modes a project can be in.
 *
 * `excluded` is a real, recorded answer — not the absence of one. `pending` es la distinción que
 * FALTABA, y su ausencia era el bug de fondo del descubrimiento: un proyecto nunca visto y uno
 * rechazado se comportaban idéntico. Los dos hooks decían lo mismo —
 *
 *     if (!ctx.registered || ctx.excluded) return 0;
 *
 * — así que el default de la herramienta era el silencio permanente, y la única forma de salir de
 * ahí era que un humano tipeara `/clickup-setup`. La activación de un mecanismo determinista
 * quedaba delegada a que el modelo se acordara de ofrecerlo. A veces se acordaba. A veces no.
 *
 * Con `pending`, "nunca lo vi" pasa a ser un estado con historia propia (`first_seen`,
 * `snoozed_until`, `ask_count`) sobre el que un hook SÍ puede actuar. Nadie contesta por el
 * usuario: se le pregunta, una vez, en el momento en que la respuesta importa.
 */
export const MODES = Object.freeze({
  TASKS: 'tasks', // several normal tasks in a list (mensajeria-style)
  UMBRELLA: 'umbrella', // one parent task, work happens in subtasks (frontend/backend-style)
  EXCLUDED: 'excluded', // the user said no. Recorded so we never ask again.
  PENDING: 'pending', // lo vimos, todavía no preguntamos (o el usuario pospuso).
});

/**
 * Un proyecto ACTIVO: registrado, con destino, y con el protocolo aplicándose.
 *
 * Existe para no volver a escribir `mode !== MODES.EXCLUDED` nunca más. Esa comparación era
 * correcta mientras hubo tres estados; con `pending` adentro pasó a ser un bug silencioso —
 * `doctor` habría reportado "sin list_id" como problema para cada proyecto pendiente, que es
 * precisamente el estado en el que todavía no TIENE que haber una lista.
 */
export function isActive(entry) {
  return entry?.mode === MODES.TASKS || entry?.mode === MODES.UMBRELLA;
}

/** El estado de un proyecto como una sola palabra, para que los hooks ramifiquen sobre esto. */
export function projectStatus(entry) {
  if (!entry) return 'unknown';
  if (entry.mode === MODES.EXCLUDED) return 'excluded';
  if (entry.mode === MODES.PENDING) return 'pending';
  if (isActive(entry)) return 'active';
  // Una entrada con un `mode` que esta versión no conoce. Tratarla como activa la metería en el
  // protocolo sin coordenadas válidas; tratarla como pendiente vuelve a preguntar, que es la
  // degradación segura.
  return 'pending';
}

/**
 * El ROL de un proyecto dentro de la cadena de entrega.
 *
 * Reemplaza al booleano `handoff`, que no alcanzaba por dos motivos:
 *
 *   1. No tenía DIRECCIÓN. El flujo es asimétrico: un backend entrega dejando la tarea en el
 *      estado de handoff, donde el frontend la va a buscar; un frontend que necesita algo del
 *      backend NO usa ese estado —devolverla ahí la deja en el filtro de quien ya terminó, y
 *      nadie del backend se enteraría— sino `on hold` con un pedido concreto.
 *   2. No sabía si había alguien del otro lado. Un backend que parkea una tarea en el estado de
 *      handoff sin un frontend que mire ese filtro deja la tarea esperando a NADIE. Parece que
 *      entregó, y en realidad la perdió.
 */
export const ROLES = Object.freeze({
  BACKEND: 'backend',
  FRONTEND: 'frontend',
  FULLSTACK: 'fullstack',
});

/**
 * Qué puede hacer un proyecto al cerrar y dónde busca su trabajo, derivado de rol + contraparte.
 *
 * La asimetría es deliberada y sale del flujo real:
 *
 * - Un BACKEND sin contraparte registrada **no puede parkear en handoff**: no hay quien mire ese
 *   estado, así que cierra. Es la regla que evita la tarea que espera a nadie.
 * - Un FRONTEND **sí puede pedirle trabajo al backend aunque su repo no esté registrado**, porque
 *   el pedido es a una persona, no a un repositorio: una tarea en `on hold` con un pedido escrito
 *   la encuentra cualquiera, no hace falta que nadie vigile un filtro.
 */
export function roleBehaviour(entry, config = null) {
  const role = [ROLES.BACKEND, ROLES.FRONTEND, ROLES.FULLSTACK].includes(entry?.role)
    ? entry.role
    : ROLES.FULLSTACK;
  const counterpart = entry?.counterpart || null;

  // Una contraparte declarada no basta: tiene que poder RECIBIR.
  //
  // Si `be` declara a `fe` como contraparte pero `fe` es fullstack, o está excluido, o mira otra
  // lista, entonces `be` parkea tareas que nadie va a levantar. Es el mismo fallo que el modelo
  // de rol vino a evitar, un nivel más arriba: la herramienta cree que entregó y en realidad
  // perdió la tarea.
  //
  // Cuando se pasa el config, la contraparte se VALIDA y `canHandoff` degrada solo. Sin config
  // (llamadas sueltas, tests unitarios) se confía en lo declarado.
  let counterpartProblem = null;
  if (counterpart && config) {
    const otro = config.projects?.[counterpart];
    if (!otro) {
      counterpartProblem = 'no está registrada';
    } else if (otro.mode === MODES.EXCLUDED) {
      counterpartProblem = 'está EXCLUIDA de ClickUp: no gestiona tareas';
    } else if (otro.role === ROLES.FULLSTACK || !otro.role) {
      counterpartProblem = `es \`${otro.role || 'fullstack'}\`: no mira el estado de handoff`;
    } else if (otro.role === role) {
      counterpartProblem = `tiene el MISMO rol (\`${role}\`): nadie recibe la entrega`;
    } else if (entry.list_id && otro.list_id && entry.list_id !== otro.list_id) {
      counterpartProblem =
        `mira otra lista (\`${otro.list_id}\` vs \`${entry.list_id}\`): el handoff ocurre sobre ` +
        'la MISMA tarea, así que en listas distintas no llega nunca';
    }
  }

  switch (role) {
    case ROLES.BACKEND:
      return {
        role,
        counterpart,
        // Contraparte declarada Y usable: si no puede recibir, parkear pierde la tarea.
        canHandoff: Boolean(counterpart) && !counterpartProblem,
        counterpartProblem,
        // Su bandeja es el backlog más los pedidos que le dejó el otro lado.
        inbox: 'todo',
        canRequestFromOther: false,
        closesChain: !counterpart || Boolean(counterpartProblem),
      };
    case ROLES.FRONTEND:
      return {
        role,
        counterpart,
        // El frontend es el final de la cadena: no entrega hacia adelante, cierra.
        canHandoff: false,
        // Su entrada natural es el estado de handoff, NO `to do` (eso es backlog del backend).
        inbox: 'handoff',
        // Opción (b): puede pedirle trabajo al backend exista o no su repo.
        canRequestFromOther: true,
        closesChain: true,
        counterpartProblem,
      };
    default:
      return {
        role: ROLES.FULLSTACK,
        // Un fullstack no tiene contraparte por definición: hace las dos puntas.
        counterpart: null,
        canHandoff: false,
        inbox: 'todo',
        canRequestFromOther: false,
        closesChain: true,
        counterpartProblem: null,
      };
  }
}

/**
 * Las coordenadas del proyecto como una sola ruta legible: `Espacio › Carpeta › Lista (id)`.
 *
 * Cada lugar que mostraba el destino imprimía el `list_id` pelado, y en un tablero real eso es
 * ilegible: ClickUp llama "List" a toda lista nueva, así que un workspace termina con varias
 * listas de nombre idéntico. La carpeta es lo único que las distingue, y era justo el segmento
 * que no se mostraba en ningún lado. El id queda al lado del nombre porque el id es lo que se
 * pega en una URL de ClickUp.
 *
 * Los segmentos ausentes se OMITEN, no se rellenan: una lista que cuelga directo del espacio no
 * tiene carpeta, y un `(sin carpeta)` nombraría una ausencia en vez de describir el lugar.
 *
 * El workspace no entra en la ruta a propósito: casi siempre hay uno solo, y repetirlo en cada
 * línea es ruido. `status` y el protocolo lo muestran aparte, que es donde sirve.
 */
export function formatListPath(entry) {
  const clean = (s) => (typeof s === 'string' && s.trim() ? s.trim() : null);
  const id = entry?.list_id ? String(entry.list_id) : null;
  const list = clean(entry?.list_name);
  if (!id && !list) return 'sin lista';
  // El último segmento SIEMPRE representa la lista. Sin nombre guardado cae al id: mostrar el
  // espacio o la carpeta como último tramo sugeriría que el destino es uno de ellos, y el
  // destino es siempre una lista.
  const segments = [clean(entry?.space_name), clean(entry?.folder_name), list ?? `lista ${id}`];
  const label = segments.filter(Boolean).join(' › ');
  return id && list ? `${label} (${id})` : label;
}

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    // Versión de la HERRAMIENTA (distinta de `version`, que es el esquema del archivo). Sirve
    // para que `doctor` diga qué hay instalado y para que el instalador sepa si está
    // actualizando, reinstalando o volviendo atrás.
    installed_version: null,
    installed_at: new Date().toISOString(),
    // Rutas relativas a la carpeta de Claude Code que puso la instalación. Ver el manifiesto en
    // installer.mjs: es lo que permite borrar un comando que una versión nueva ya no trae.
    installed_files: [],
    identity: {
      // The numeric ClickUp user id. THIS is what gets assigned — never the string "me".
      clickup_user_id: null,
      clickup_email: null,
      clickup_username: null,
      confirmed: false,
      resolved_via: null, // 'api' | 'mcp' | 'manual'
      resolved_at: null,
      // Git emails known to belong to this same human. Used to recognise your own INICIO
      // comments instead of reading them as somebody else's collision.
      git_emails: [],
      // A QUIÉN resuelve `"me"` en ESTE conector: el dueño del token OAuth.
      //
      // No es lo mismo que `clickup_user_id`, y toda la seguridad del cronómetro descansa en esa
      // diferencia. Las herramientas de tiempo del MCP no aceptan un asignado: el reloj corre
      // SIEMPRE para el dueño del token. Si ese dueño no sos vos, cada hora que registres se le
      // carga a otra persona, sin error y sin aviso — el mismo agujero que ya prohibimos para
      // `"me"` en los assignees, pero sobre datos de facturación.
      //
      // `null` significa "todavía no se verificó", y con eso el cronómetro NO arranca.
      token_user_id: null,
      token_checked_at: null,
    },
    defaults: {
      workspace_id: null,
      use_dates: true,
      use_priorities: true,
      auto_assign: true,
      // ¿Este proyecto registra el tiempo trabajado en ClickUp?
      //
      // Apagado por defecto, y no por timidez: encenderlo escribe entradas de tiempo en un
      // tablero compartido, que en muchos equipos son datos de facturación. Un default que
      // empieza a cargar horas sin que nadie lo haya pedido es una herramienta que se desinstala.
      // Se enciende por proyecto en `/clickup-setup`.
      track_time: false,
      // Where the completion date is written.
      //   'description'  → a `**Finalizado:** YYYY-MM-DD` line + ClickUp's own date_closed.
      //   'due_date'     → overwrite due_date (only for boards that already use it that way).
      //   'custom_field' → a Date custom field literally named "Fecha de fin", if it exists.
      end_date_field: 'description',
      search_window_days: 30,
      // The PreToolUse lock. Only ever applies to registered, non-excluded projects.
      block_writes_without_task: true,
      exemption_hours: 8,
      // ¿Preguntar en un proyecto que nunca vimos? Es LA palanca que el usuario pidió: un
      // registro global que sepa qué proyectos aceptaron y cuáles no, y que pregunte por los
      // que faltan. Se pregunta una vez, en la primera escritura, con tres salidas — adoptar,
      // excluir, posponer. Poner esto en `false` devuelve el comportamiento anterior: silencio
      // permanente hasta que alguien tipee `/clickup-setup`.
      ask_new_projects: true,
      // Cuántos días dura un "ahora no". Suficiente para no interrumpir una tarde de trabajo,
      // corto para que un proyecto que sí importaba no quede olvidado un semestre.
      snooze_days: 7,
    },
    // Keyed by canonical project path. `git_remote` lets the same repo be recognised in a
    // second checkout without asking again.
    projects: {},
    // git email -> ClickUp identity, for assigning work to teammates. Mirrors the
    // clickup-usuarios.json idea from the frontend repo, including its `confirmed` flag.
    team: {},
  };
}

/** True solo para un objeto plano: `null` y los arrays NO cuentan, aunque sean `typeof object`. */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deep merge que rellena los defaults ausentes sin pisar nada que el usuario haya puesto.
 *
 * La clave está en la rama del medio: si una sección DEBERÍA ser un objeto y en el archivo es
 * `null` o un array, se reemplaza por el default. La versión anterior recursaba sobre ese valor,
 * `fillDefaults(null, {...})` salía inmediatamente, y `config.defaults` se quedaba en `null` — con
 * lo cual todo lo que lee `config.defaults.algo` explotaba después, lejos de la causa.
 */
function fillDefaults(target, defaults) {
  if (!isPlainObject(target)) return target;
  for (const [k, v] of Object.entries(defaults)) {
    if (!(k in target)) {
      target[k] = structuredClone(v);
    } else if (isPlainObject(v)) {
      target[k] = isPlainObject(target[k]) ? fillDefaults(target[k], v) : structuredClone(v);
    }
  }
  return target;
}

/**
 * Load the config. Returns `{ config, ok, error, existed }`.
 *
 * On a parse failure it hands back defaults with `ok:false` rather than throwing: the caller
 * (usually a hook) then knows to stay quiet instead of blocking the user over a typo in JSON.
 */
export function loadConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) {
    return { config: defaultConfig(), ok: true, existed: false, error: null, normalised: [] };
  }
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    // `isPlainObject`, no `typeof === 'object'`: un `[]` en la raíz pasaba la validación anterior
    // y después `config.projects` era `undefined` en un lugar muy lejano al archivo.
    if (!isPlainObject(parsed)) throw new Error('la raíz del config no es un objeto');
    const { config, arreglado } = normalise(fillDefaults(parsed, defaultConfig()));
    config.version = CONFIG_VERSION;
    BASELINE.set(config, structuredClone(config));
    // `normalised` viaja hasta `doctor`: corregir una contradicción en silencio la arregla pero
    // la vuelve invisible, y la queja original era justamente que el sistema NO la detectaba.
    // Se arregla Y se dice.
    return { config, ok: true, existed: true, error: null, normalised: arreglado };
  } catch (err) {
    return {
      config: defaultConfig(),
      ok: false,
      existed: true,
      error: err instanceof Error ? err.message : String(err),
      normalised: [],
    };
  }
}

/**
 * Contradicciones que se resuelven solas, en memoria.
 *
 * NO es una migración y no escribe nada: normaliza lo que se acaba de leer, y la corrección llega
 * al disco cuando algo guarde por su cuenta. Eso mantiene la regla de que leer nunca tiene
 * efectos, que es lo que permite que los hooks lean en cada llamada.
 *
 * Hoy solo arregla una: `confirmed: true` conviviendo con un `pending_query`. Son dos campos que
 * se contradicen —está confirmada Y queda una consulta pendiente— y el sistema los mostraba a los
 * dos sin notar el conflicto. `pending_query` es el dato que el instalador deja para que la
 * primera sesión resuelva la identidad; una vez confirmada, no significa nada.
 */
function normalise(config) {
  const arreglado = [];
  if (config?.identity?.confirmed && config.identity.pending_query) {
    arreglado.push(
      `identity.pending_query ("${config.identity.pending_query}") convivía con confirmed:true`,
    );
    delete config.identity.pending_query;
  }
  return { config, arreglado };
}

/**
 * Los bytes de los que salió cada objeto de config, para poder distinguir "esto lo cambié yo"
 * de "esto ya estaba así". Es un WeakMap: si el caller suelta el config, la baseline se va con él.
 */
const BASELINE = new WeakMap();

/** Espera bloqueante sin dependencias ni busy-loop. */
function dormir(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const hasta = Date.now() + ms;
    while (Date.now() < hasta) {
      /* último recurso: SharedArrayBuffer deshabilitado */
    }
  }
}

/**
 * Lock entre procesos con `mkdir`, que es atómico en POSIX y en Windows y no necesita nada
 * instalado. Un lock viejo se rompe: si el proceso que lo tomó murió, nadie lo va a soltar.
 *
 * Si el lock no se consigue dentro del timeout se escribe igual. Perder una escritura por
 * contención sería peor que el problema que el lock resuelve: el usuario dio una orden y la
 * orden tiene que tener efecto. En el peor caso se degrada al comportamiento de antes.
 */
function conLock(fn, { timeoutMs = 5000, staleMs = 30000 } = {}) {
  const dir = `${configPath()}.lock`;
  const desde = Date.now();
  let tomado = false;
  while (Date.now() - desde < timeoutMs) {
    try {
      fs.mkdirSync(dir);
      tomado = true;
      break;
    } catch (err) {
      if (err && err.code !== 'EEXIST') break; // un problema de permisos no se resuelve esperando
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > staleMs) {
          fs.rmSync(dir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // el lock se soltó entre el statSync y nosotros: reintentar ya
      }
      dormir(10 + Math.floor(Math.random() * 30));
    }
  }
  try {
    return fn();
  } finally {
    if (tomado) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* si no se puede borrar, el staleMs lo recicla */
      }
    }
  }
}

/**
 * Aplica sobre `fresco` sólo lo que cambió entre `base` (lo que este proceso leyó) y
 * `propuesto` (lo que este proceso quiere escribir).
 *
 * Esto es lo que separa una fusión ciega de una correcta: una fusión ciega resucitaría la
 * entrada que `project forget` acaba de borrar. Acá el borrado es una intención explícita
 * (estaba en base, no está en propuesto) y se respeta, mientras que las claves que otro
 * proceso agregó — que no están ni en base ni en propuesto — sobreviven intactas.
 */
function aplicarIntencion(fresco, base, propuesto) {
  for (const k of Object.keys(propuesto)) {
    const nuevo = propuesto[k];
    const viejo = base ? base[k] : undefined;
    if (isPlainObject(nuevo) && isPlainObject(viejo) && isPlainObject(fresco[k])) {
      aplicarIntencion(fresco[k], viejo, nuevo);
    } else if (JSON.stringify(nuevo) !== JSON.stringify(viejo)) {
      fresco[k] = structuredClone(nuevo);
    }
  }
  if (!base) return fresco;
  for (const k of Object.keys(base)) {
    if (!(k in propuesto)) delete fresco[k];
  }
  return fresco;
}

/**
 * Escritura atómica (archivo temporal + rename) bajo lock, reconciliada contra el disco.
 *
 * El rename atómico por sí solo evita un archivo truncado, pero NO evita el lost update: dos
 * sesiones de Claude Code en proyectos distintos leen el mismo config, cada una agrega su
 * proyecto, y el último rename borra el trabajo de la otra. Medido: 12 de 20 registros
 * simultáneos se perdían. Por eso se relee el disco DENTRO del lock y se aplica sólo la
 * intención de este proceso.
 */
export function saveConfig(config) {
  fs.mkdirSync(toolHome(), { recursive: true });
  const file = configPath();
  return conLock(() => {
    const base = BASELINE.get(config);
    let salida = config;
    if (base) {
      const disco = loadConfigSinBaseline();
      // Un config ilegible en disco no se reconcilia: fusionar contra defaults borraría lo que
      // el usuario tiene escrito a mano. Se escribe lo que este proceso decidió, sin más.
      if (disco.ok && disco.existed) {
        salida = aplicarIntencion(disco.config, base, config);
      }
    }
    salida.updated_at = new Date().toISOString();
    writeJsonAtomic(file, salida);
    // El caller sigue teniendo su objeto en la mano y a veces imprime desde él: se sincroniza
    // con lo que realmente quedó escrito, para que no muestre algo distinto del archivo.
    if (salida !== config) {
      for (const k of Object.keys(config)) if (!(k in salida)) delete config[k];
      Object.assign(config, structuredClone(salida));
    }
    BASELINE.set(config, structuredClone(salida));
    return file;
  });
}

/** loadConfig sin registrar baseline: la relectura de dentro del lock no es la del caller. */
function loadConfigSinBaseline() {
  const file = configPath();
  if (!fs.existsSync(file)) return { config: defaultConfig(), ok: true, existed: false };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isPlainObject(parsed)) throw new Error('la raíz del config no es un objeto');
    const { config } = normalise(fillDefaults(parsed, defaultConfig()));
    config.version = CONFIG_VERSION;
    return { config, ok: true, existed: true };
  } catch {
    return { config: defaultConfig(), ok: false, existed: true };
  }
}

/** `git config user.email` for a directory. Null when there is no git or no email set. */
export function gitEmail(dir) {
  return runGit(dir, ['config', 'user.email']);
}

/** First remote URL, normalised so ssh and https forms of the same repo compare equal. */
export function gitRemote(dir) {
  const url = runGit(dir, ['remote', 'get-url', 'origin']);
  return url ? normaliseRemote(url) : null;
}

function runGit(dir, args) {
  try {
    const out = execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
    const value = out.trim();
    return value || null;
  } catch {
    return null;
  }
}

export function normaliseRemote(url) {
  let u = String(url).trim().toLowerCase();
  u = u.replace(/\.git$/, '');
  u = u.replace(/^git\+/, '');
  // git@host:owner/repo  ->  host/owner/repo
  u = u.replace(/^[a-z0-9._-]+@([^:]+):/, '$1/');
  // scheme://[user@]host/...  ->  host/...
  u = u.replace(/^[a-z]+:\/\/(?:[^@/]+@)?/, '');
  u = u.replace(/\/+$/, '');
  return u;
}

/**
 * Find the project entry for a directory.
 *
 * Three ways in, deliberately ordered:
 *   1. Exact canonical path.
 *   2. Nearest registered ancestor — so `repo/src/api` resolves to `repo`.
 *   3. Same git remote — so a second clone of the same repo inherits the setup instead of
 *      asking again. This one only matches non-excluded entries: "I don't want ClickUp in
 *      that checkout" should not silently spread to every other clone.
 */
export function resolveProject(config, dir) {
  const key = canonicalProjectKey(dir);
  if (!key) {
    return { key: '', entry: null, matchedBy: null, matchedKey: null, status: 'unknown' };
  }

  const projects = config.projects || {};
  const hit = (entry, matchedBy, matchedKey) => ({
    key,
    entry,
    matchedBy,
    matchedKey,
    status: projectStatus(entry),
  });

  if (projects[key]) return hit(projects[key], 'path', key);

  // La misma carpeta vista por otro nombre. Se prueba DESPUÉS de la clave literal para no
  // cambiarle el comportamiento a nadie que ya esté registrado; ver `realProjectKey`.
  const real = realProjectKey(dir);
  if (real && projects[real]) return hit(projects[real], 'realpath', real);

  let bestKey = null;
  for (const candidate of Object.keys(projects)) {
    for (const k of real ? [key, real] : [key]) {
      if (k === candidate || k.startsWith(`${candidate}/`)) {
        if (!bestKey || candidate.length > bestKey.length) bestKey = candidate;
      }
    }
  }
  if (bestKey) return hit(projects[bestKey], 'ancestor', bestKey);

  // Only pay for a git subprocess if some project was actually recorded with a remote. On a
  // fresh install, and in every repo that is not registered, this skips the spawn entirely —
  // and "not registered" is the common case for a tool installed globally.
  //
  // Los `pending` SÍ entran acá, a diferencia de los excluidos: un proyecto pendiente en otra
  // ruta con el mismo remote es el MISMO proyecto, y arrastrar su `snoozed_until` evita
  // preguntar dos veces por lo mismo. Un excluido no se propaga: "no quiero ClickUp en ese
  // checkout" no debería contagiarse a los demás clones.
  const withRemote = Object.entries(projects).filter(
    ([, entry]) => entry && entry.git_remote && entry.mode !== MODES.EXCLUDED,
  );
  if (withRemote.length) {
    const remote = gitRemote(dir);
    if (remote) {
      for (const [candidate, entry] of withRemote) {
        if (entry.git_remote === remote) return hit(entry, 'remote', candidate);
      }
    }
  }

  return { key, entry: null, matchedBy: null, matchedKey: null, status: 'unknown' };
}

/**
 * `host/organización` de un remote normalizado: `github.com/acme/repo` → `github.com/acme`.
 *
 * Es la unidad de descubrimiento. La crítica lo señaló bien: el resolver ya sabía matchear por
 * remote, pero solo disparaba si YA existía otro proyecto con ese remote EXACTO — o sea, nunca
 * para un repo nuevo, que es justo el caso que importa. La organización sí se repite: si los
 * cuatro proyectos registrados viven en `github.com/acme/*`, el quinto repo de `acme` casi
 * seguro va a la misma lista, y proponerlo con esa lista ya cargada convierte una configuración
 * de seis preguntas en un sí o un no.
 *
 * Nunca AUTO-registra. Propone. La diferencia importa: crear tareas en el espacio equivocado de
 * un tablero compartido es más difícil de deshacer que preguntar.
 */
export function remoteOrg(remote) {
  if (!remote) return null;
  const parts = String(remote).split('/').filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
}

/**
 * Proyectos activos que comparten organización con `dir`, del más reciente al más viejo.
 *
 * El primero es el que se ofrece como plantilla. Se ordena por `updated_at` porque el destino
 * que el usuario tocó último es el que mejor representa dónde está trabajando hoy.
 */
export function suggestFromOrg(config, dir, remote = undefined) {
  const mine = remote === undefined ? gitRemote(dir) : remote;
  const org = remoteOrg(mine);
  if (!org) return [];
  return Object.entries(config.projects || {})
    .filter(([, e]) => isActive(e) && e.list_id && remoteOrg(e.git_remote) === org)
    .sort(([, a], [, b]) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))
    .map(([key, entry]) => ({ key, entry, org }));
}

/** ¿La exclusión/postergación de este proyecto sigue vigente? */
export function snoozeActive(entry) {
  const until = Date.parse(entry?.snoozed_until ?? '');
  return Number.isFinite(until) && until > Date.now();
}

/**
 * Deja constancia de que vimos este directorio, sin decidir nada por el usuario.
 *
 * Escribir la entrada `pending` es lo que convierte "no sé nada de esta carpeta" en un hecho
 * con fecha, y sin ese hecho no hay forma de preguntar UNA sola vez: sin `ask_count` la única
 * alternativa es preguntar siempre o no preguntar nunca, que es exactamente el dilema del que
 * venimos.
 */
export function markPending(config, dir, patch = {}) {
  return upsertProject(config, dir, {
    mode: MODES.PENDING,
    first_seen: config.projects?.[canonicalProjectKey(dir)]?.first_seen ?? new Date().toISOString(),
    ...patch,
  });
}

/** Write (or overwrite) a project entry, preserving fields the caller did not mention. */
export function upsertProject(config, dir, patch) {
  const key = canonicalProjectKey(dir);
  config.projects = config.projects || {};
  const previous = config.projects[key] || {};
  const entry = {
    ...previous,
    ...patch,
    name: patch.name ?? previous.name ?? path.basename(key) ?? key,
    path: key,
    registered_at: previous.registered_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (!entry.git_remote) {
    const remote = gitRemote(dir);
    if (remote) entry.git_remote = remote;
  }
  config.projects[key] = entry;
  return entry;
}

/**
 * The five roles the protocol needs from a board's status set, and the names it falls back to.
 *
 * These defaults are the names used by the boards this tool was built against. They are only
 * FALLBACKS: a space is free to call its statuses anything, and a status name that does not
 * exist makes every `clickup_update_task` fail. So `/clickup-setup` reads the real names from
 * the list (`clickup_get_list` returns them) and records the mapping per project.
 *
 * Verified against a real board: statuses carry a `type` — `open`, `custom`, `done` or
 * `closed` — and ClickUp only stamps `date_closed` on `type: closed`. A status of type
 * `done` (on that board, `reviewed`) closes the task in the UI but leaves `date_closed`
 * null, which is why `done` here means "the closed-group status the protocol actually uses",
 * and why the completion date is never left to `date_closed` alone.
 */
export const STATUS_ROLES = Object.freeze({
  todo: 'to do',
  in_progress: 'in progress',
  on_hold: 'on hold',
  handoff: 'update required',
  done: 'complete',
});

/** The status names in effect for a project: its recorded map, with the fallbacks filled in. */
export function effectiveStatuses(entry) {
  const map = isPlainObject(entry?.statuses) ? entry.statuses : {};
  const out = {};
  for (const [role, fallback] of Object.entries(STATUS_ROLES)) {
    const value = map[role];
    out[role] = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  }
  // Whether the names were actually confirmed against the board, or are just the defaults.
  out.__recorded = Object.keys(map).length > 0;
  return out;
}

/**
 * Settings a project may override locally.
 *
 * This exists because the same machine legitimately needs different answers per board. The three
 * repos this tool generalises proved it: two of them wrote the completion date into `due_date`,
 * while the third forbade touching that field at all — their team uses it as a real deadline, so
 * writing there silently destroys somebody else's due date. A single global answer would have to
 * be wrong for one of them, and "wrong" here means data loss.
 *
 * Anything NOT in this list stays global on purpose: the identity and the lock are properties of
 * the person and the machine, not of the board.
 */
export const OVERRIDABLE = Object.freeze([
  'use_dates',
  'use_priorities',
  'auto_assign',
  'end_date_field',
  'search_window_days',
  // Por proyecto y no global: en un mismo equipo conviven el repo del cliente que se factura por
  // hora y la herramienta interna donde registrar tiempo es puro ruido. Una respuesta global
  // tendría que estar mal en uno de los dos.
  'track_time',
]);

/** Global defaults with a project's overrides applied on top. */
export function effectiveDefaults(config, entry) {
  const base = { ...(config?.defaults || {}) };
  const overrides = entry?.overrides;
  if (isPlainObject(overrides)) {
    for (const key of OVERRIDABLE) {
      if (overrides[key] !== undefined && overrides[key] !== null) base[key] = overrides[key];
    }
  }
  return base;
}

/** True when the identity is usable for assigning work. Anything less means "stop and ask". */
export function identityReady(config) {
  const id = config?.identity?.clickup_user_id;
  return Boolean(id && String(id).trim() && config.identity.confirmed);
}

/**
 * ¿Se puede arrancar el cronómetro sin cargarle las horas a otra persona?
 *
 * Devuelve `{ ok, reason }`, y `reason` es un código, no una frase: quien renderiza decide cómo
 * decirlo. Tres formas de fallar, todas cerradas:
 *
 *   'identity'  → no sabemos quién sos en ClickUp. Sin eso no hay nada contra qué comparar.
 *   'unchecked' → nunca se verificó a quién pertenece el token de este conector.
 *   'mismatch'  → se verificó, y el token es de OTRA persona. Acá el cronómetro no se toca.
 *
 * El caso 'mismatch' es el que justifica todo este mecanismo. Es indetectable desde el resultado
 * de la llamada —el reloj arranca, la herramienta devuelve éxito— y se descubre semanas después,
 * cuando alguien mira el reporte de horas y ve el trabajo de cuatro personas cargado a una sola.
 */
export function timeTrackingReady(config) {
  const mine = config?.identity?.clickup_user_id;
  if (!identityReady(config)) return { ok: false, reason: 'identity', tokenUserId: null };
  const token = config?.identity?.token_user_id;
  if (!token || !String(token).trim()) return { ok: false, reason: 'unchecked', tokenUserId: null };
  if (String(token).trim() !== String(mine).trim()) {
    return { ok: false, reason: 'mismatch', tokenUserId: String(token).trim() };
  }
  return { ok: true, reason: null, tokenUserId: String(token).trim() };
}

/** Record a git email as belonging to this human, so their own comments read as their own. */
export function rememberGitEmail(config, email) {
  if (!email) return false;
  const normalised = String(email).trim().toLowerCase();
  if (!normalised) return false;
  config.identity.git_emails = config.identity.git_emails || [];
  const known = config.identity.git_emails.map((e) => String(e).toLowerCase());
  if (known.includes(normalised)) return false;
  config.identity.git_emails.push(normalised);
  return true;
}

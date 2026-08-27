#!/usr/bin/env node
//
// clickup-flow — runtime CLI and hook entry point.
//
// Two kinds of subcommand live here:
//
//   * HOOKS (`session-start`, `prompt-hook`, `guard`) — run by the Claude Code harness, not by
//     the model. That is the whole point: an instruction can be forgotten or diluted when a long
//     context gets compacted; a hook cannot.
//   * WRITE-BACK COMMANDS (`claim`, `release`, `identity set`, `project set`, …) — run by the
//     model or the user to record decisions.
//
// THE GOLDEN RULE FOR HOOKS: they never crash and they never block for the wrong reason. This
// tool installs GLOBALLY, so its hooks fire in every repository on the machine — including the
// ones that have nothing to do with ClickUp. A hook that throws, or a lock that engages in an
// unconfigured project, would turn a task-tracking convenience into something that breaks
// unrelated work. Hence: fail OPEN when unconfigured, fail CLOSED only when the user explicitly
// configured this project and asked for the lock.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { canonicalProjectKey, configPath, toolHome, statePath } from './lib/paths.mjs';
import {
  MODES,
  ROLES,
  roleBehaviour,
  OVERRIDABLE,
  STATUS_ROLES,
  loadConfig,
  saveConfig,
  upsertProject,
  identityReady,
  rememberGitEmail,
  gitEmail,
  resolveProject,
} from './lib/config.mjs';
import {
  readState,
  setClaim,
  clearClaim,
  setExemption,
  clearExemption,
  dropState,
  listStateFiles,
} from './lib/state.mjs';
import { buildContext, renderContext, shortSummary } from './lib/protocol.mjs';
import { readSettings, inspectInstalled } from './lib/settings.mjs';
import { scanProject, importUsers } from './lib/migrate.mjs';

// ---------------------------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------------------------

/** Minimal `--flag value` / `--flag=value` / `--bool` parser. Positionals kept in `_`. */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[body] = true;
    } else {
      out[body] = next;
      i++;
    }
  }
  return out;
}

function truthy(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['true', '1', 'si', 'sí', 'yes', 'y', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(s)) return false;
  return fallback;
}

// ---------------------------------------------------------------------------------------------
// Hook plumbing
// ---------------------------------------------------------------------------------------------

/**
 * Read the hook payload from stdin.
 *
 * The harness sends JSON (`cwd`, `tool_name`, `tool_input`, …). We take `cwd` from there because
 * it is the directory the SESSION is in, which is what we want to match against the project
 * registry — `process.cwd()` of the hook process is not guaranteed to be that.
 *
 * Bounded by a timeout: if stdin never closes we must still exit, or we would hang the turn.
 */
async function readHookInput(timeoutMs = 2000) {
  if (process.stdin.isTTY) return {};
  return new Promise((resolve) => {
    let raw = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        resolve(raw.trim() ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) finish(); // defensive: never buffer unbounded
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

/** Best available project directory, in order of trustworthiness. */
function hookCwd(payload) {
  return canonicalProjectKey(
    payload?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd() || '',
  );
}

// ---------------------------------------------------------------------------------------------
// Hook: SessionStart
// ---------------------------------------------------------------------------------------------

async function cmdSessionStart() {
  const payload = await readHookInput();
  const cwd = hookCwd(payload);
  const { config, ok } = loadConfig();

  if (!ok) {
    // A corrupt config is worth saying once per session, but it must not read as a task rule.
    say(
      '[clickup-flow] La configuración global no se pudo leer (JSON inválido en ' +
        `${configPath()}). El protocolo de tareas queda DESACTIVADO en esta sesión; ` +
        'corré `clickup-flow doctor` para verlo.',
    );
    return 0;
  }

  const ctx = buildContext(config, cwd);

  // Silence is the correct output for a project the user excluded. Anything else re-litigates a
  // decision they already made, every single session.
  if (ctx.excluded) return 0;

  if (!ctx.registered) {
    say(
      '[clickup-flow] Este proyecto no tiene espacio de ClickUp asignado. Si el trabajo de acá ' +
        'debería quedar registrado en el tablero, ofrecele al usuario correr `/clickup-setup` ' +
        '(una vez y queda). Mientras no esté configurado, el protocolo de tareas NO aplica y se ' +
        'puede trabajar normalmente — no inventes coordenadas ni crees tareas por tu cuenta.',
    );
    return 0;
  }

  const lines = [`[clickup-flow] Protocolo de tareas ACTIVO — ${shortSummary(ctx)}.`];

  if (!ctx.identityReady) {
    lines.push(
      'FALTA RESOLVER LA IDENTIDAD DE CLICKUP: no asignes tareas hasta hacerlo. Buscá el miembro ' +
        `con clickup_get_workspace_members${ctx.identity.pending_query ? ` (dato del install: "${ctx.identity.pending_query}")` : ''}, ` +
        'confirmalo CON EL USUARIO y guardalo con `clickup-flow identity set --id <id> --confirmed`.',
    );
  }

  if (ctx.claim) {
    lines.push(
      `TAREA EN CURSO: ${ctx.claim.task_id} — ${ctx.claim.title ?? 's/título'}. ` +
        `Al terminar, /tarea fin ${ctx.claim.task_id}.`,
    );
  } else if (ctx.exemption.active) {
    lines.push(`Exención vigente (${ctx.exemption.reason}). Se puede escribir sin tarea.`);
  } else {
    lines.push(
      'Ninguna tarea reclamada. Antes de implementar, arreglar o refactorizar algo, corré ' +
        '`clickup-flow context` y seguí el protocolo. Responder preguntas o leer código no ' +
        'requiere tarea.',
    );
  }

  say(lines.join(' '));
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Hook: UserPromptSubmit
// ---------------------------------------------------------------------------------------------

async function cmdPromptHook() {
  const payload = await readHookInput();
  const cwd = hookCwd(payload);
  const { config, ok } = loadConfig();
  if (!ok) return 0;

  const ctx = buildContext(config, cwd);
  // Unconfigured and excluded projects get nothing: a per-prompt nag in a repo that opted out
  // is noise, and noise every turn is how a reminder stops being read at all.
  if (!ctx.registered || ctx.excluded) return 0;

  if (ctx.claim) {
    say(
      `[protocolo de tareas] TAREA EN CURSO: ${ctx.claim.task_id} — ` +
        `${ctx.claim.title ?? 's/título'}${ctx.claim.role ? ` (rol ${ctx.claim.role})` : ''}. ` +
        `Al terminar cerrala con \`/tarea fin ${ctx.claim.task_id}\`. Si la abandonás a mitad va a ` +
        '`on hold` con el motivo, nunca se deja en `in progress`.',
    );
    return 0;
  }

  if (ctx.exemption.active) {
    say(
      `[protocolo de tareas] Exención vigente (${ctx.exemption.ageHours.toFixed(1)}h de ` +
        `${ctx.exemption.limitHours}h): ${ctx.exemption.reason}. Se puede escribir sin tarea. ` +
        'No la uses para saltear la búsqueda en ClickUp.',
    );
    return 0;
  }

  const parts = [
    '[protocolo de tareas] Ninguna tarea reclamada en este proyecto.',
    'Si lo que sigue es implementar, arreglar, migrar o refactorizar algo, primero corré',
    '`clickup-flow context` (o `/tarea <descripción>`) para decidir si amerita tarea y validar en',
    'ClickUp que nadie más la esté haciendo. Responder preguntas, leer código, investigar o',
    'explicar NO requiere reclamar tarea.',
  ];
  if (!ctx.identityReady) {
    parts.push('OJO: la identidad de ClickUp todavía no está resuelta — no asignes tareas.');
  }
  say(parts.join(' '));
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Hook: PreToolUse — the actual lock
// ---------------------------------------------------------------------------------------------

/** Editing Claude's own configuration is not the shared product work the lock protects. */
/**
 * Archivos que el candado nunca bloquea: la configuración de Claude Code y del propio flujo.
 *
 * La exención existe justamente para que la herramienta no se bloquee a sí misma — pedirle una
 * tarea de ClickUp para poder escribir el CLAUDE.md que configura ClickUp es un círculo.
 *
 * Las comparaciones necesitan un separador delante (`/CLAUDE.md`, no `CLAUDE.md`) para no
 * cazar `MI-CLAUDE.md`. Eso hacía que una ruta RELATIVA no matcheara nunca: con
 * `file_path: "CLAUDE.md"` el guard bloqueaba, que es exactamente lo contrario de lo que la
 * exención busca. Por eso la ruta se resuelve primero contra el directorio del hook.
 */
function isTrivialTarget(filePath, baseDir = null) {
  if (!filePath) return false;
  const crudo = String(filePath);
  const absoluto =
    path.isAbsolute(crudo) || /^[A-Za-z]:[\\/]/.test(crudo)
      ? crudo
      : path.resolve(baseDir || process.cwd(), crudo);
  const p = canonicalProjectKey(absoluto);
  return (
    p.includes('/.claude/') ||
    p.endsWith('/CLAUDE.md') ||
    p.endsWith('/claude.md') ||
    p.includes('/.claude-plugin/') ||
    p.endsWith('/.gitignore')
  );
}

function targetPath(payload) {
  const input = payload?.tool_input ?? {};
  return input.file_path || input.notebook_path || input.path || null;
}

async function cmdGuard() {
  const payload = await readHookInput();
  const cwd = hookCwd(payload);

  const { config, ok } = loadConfig();
  if (!ok) return 0; // unreadable config → never block

  const ctx = buildContext(config, cwd);

  // ---- every fail-open branch, stated explicitly ----
  if (!ctx.registered) return 0; // project was never configured
  if (ctx.excluded) return 0; // user said no, on the record
  if (!ctx.defaults.block_writes_without_task) return 0; // lock switched off at install
  if (ctx.claim) return 0; // a task is claimed
  if (ctx.exemption.active) return 0; // a live, written-down exemption

  const file = targetPath(payload);
  if (isTrivialTarget(file, cwd)) return 0; // configuring the tooling, not doing the work

  // ---- fail closed ----
  if (ctx.exemption.expired) {
    const age =
      ctx.exemption.ageHours === Infinity ? 'sin timestamp legible' : `${Math.floor(ctx.exemption.ageHours)}h`;
    err(
      `BLOQUEADO por el protocolo de tareas: la exención VENCIÓ (${age}, el límite son ` +
        `${ctx.exemption.limitHours}h). Motivo que tenía: "${ctx.exemption.reason}".\n\n` +
        'Volvé a decidir: si este trabajo amerita tarea, reclamala; si no, volvé a declarar la ' +
        'exención con el motivo ACTUAL:\n\n' +
        '    clickup-flow exempt --reason "<motivo concreto>"',
    );
    return 2;
  }

  const p = ctx.project;
  err(
    [
      'BLOQUEADO por el protocolo de tareas de este proyecto (clickup-flow).',
      '',
      'No hay tarea reclamada ni exención declarada, así que no se puede escribir todavía. Este',
      'candado existe para no rehacer trabajo que alguien ya hizo o está haciendo ahora mismo en',
      'un tablero compartido por varias personas.',
      '',
      'Elegí UNO de los dos caminos:',
      '',
      'A) EL TRABAJO AMERITA TAREA',
      '   1. Corré `clickup-flow context` para tener las coordenadas y las reglas de este proyecto.',
      `   2. BUSCÁ en ClickUp antes de crear nada (lista ${p.list_id ?? '<sin lista>'}): lo abierto`,
      '      sin límite de fecha, lo cerrado de la ventana configurada, y búsqueda por texto con',
      '      varios términos.',
      '   3. Si ya existe y está `in progress` o `complete` → PARÁ y avisale al usuario que ese',
      '      trabajo ya está tomado o ya se hizo. No sigas sin su confirmación.',
      '   4. Si corresponde tomarla: `in progress` + comentario INICIO, y registrá el claim:',
      '',
      '        clickup-flow claim --task-id <id> --title "<título>"',
      '',
      'B) EL TRABAJO NO AMERITA TAREA',
      '   Declaralo por escrito (vence solo, a propósito):',
      '',
      '        clickup-flow exempt --reason "<motivo concreto>"',
      '',
      '   Vale para: correcciones triviales, ajustes del entorno local, o cambios pedidos dentro',
      '   de un trabajo ya reclamado. NO vale como atajo para saltearse la búsqueda en ClickUp.',
    ].join('\n'),
  );
  return 2;
}

// ---------------------------------------------------------------------------------------------
// context / status
// ---------------------------------------------------------------------------------------------

function cmdContext(args) {
  const cwd = canonicalProjectKey(args.cwd || process.cwd());
  const { config, ok, error } = loadConfig();
  if (!ok) {
    say(`# clickup-flow — configuración ilegible\n\n${configPath()}\n\n${error}`);
    say('\nCorré `clickup-flow doctor`, o reinstalá la herramienta.');
    return 1;
  }
  const ctx = buildContext(config, cwd);
  say(renderContext(ctx));
  return 0;
}

function cmdStatus(args) {
  const cwd = canonicalProjectKey(args.cwd || process.cwd());
  const { config, ok, error, existed } = loadConfig();
  if (!ok) {
    err(`config ilegible: ${error}`);
    return 1;
  }
  const ctx = buildContext(config, cwd);
  const lines = [];
  lines.push(`config          ${configPath()}${existed ? '' : ' (no existe todavía)'}`);
  lines.push(`proyecto        ${ctx.cwd}`);
  lines.push(
    `registrado      ${ctx.registered ? `sí (${ctx.matchedBy})` : 'no'}${ctx.excluded ? ' — EXCLUIDO' : ''}`,
  );
  if (ctx.registered && !ctx.excluded) {
    const p = ctx.project;
    lines.push(`modo            ${p.mode}`);
    lines.push(`espacio         ${p.space_name ?? '—'} (${p.space_id ?? '—'})`);
    lines.push(`lista           ${p.list_name ?? '—'} (${p.list_id ?? '—'})`);
    if (p.mode === MODES.UMBRELLA) lines.push(`paraguas        ${p.umbrella_task_id ?? '— FALTA'}`);
    const rb = roleBehaviour(p, config);
    lines.push(`rol             ${rb.role}${rb.counterpart ? ` · contraparte ${rb.counterpart}` : ' · sin contraparte'}`);
    lines.push(
      `entrega         ${rb.canHandoff ? 'puede parkear para la contraparte' : 'cierra la cadena'}` +
        `${rb.canRequestFromOther ? ' · puede pedir trabajo al otro rol' : ''}`,
    );
  }
  lines.push(
    `identidad       ${
      ctx.identityReady
        ? `${ctx.identity.clickup_user_id} (${ctx.identity.clickup_username ?? 's/n'})`
        : 'SIN RESOLVER'
    }`,
  );
  lines.push(`email de git    ${ctx.gitEmail ?? '—'}`);
  const overridden = Object.keys(ctx.project?.overrides || {});
  lines.push(
    `fechas ${ctx.defaults.use_dates ? 'sí' : 'no'} · prioridades ${
      ctx.defaults.use_priorities ? 'sí' : 'no'
    } · autoasignar ${ctx.defaults.auto_assign ? 'sí' : 'no'} · fin en ${ctx.defaults.end_date_field}` +
      ` · cerradas ${
        (ctx.defaults.search_window_days ?? 30) > 0
          ? `${ctx.defaults.search_window_days}d`
          : 'sin límite'
      }`,
  );
  if (overridden.length) {
    lines.push(`override        ${overridden.join(', ')} (definido en este proyecto)`);
  }
  if (ctx.registered && !ctx.excluded) {
    const st = ctx.statuses;
    lines.push(
      `estados         ${st.todo} / ${st.in_progress} / ${st.on_hold} / ${st.handoff} / ${st.done}` +
        `${st.__recorded ? '' : '   (por defecto, SIN confirmar contra el tablero)'}`,
    );
  }
  lines.push(`candado         ${ctx.defaults.block_writes_without_task ? 'activo' : 'desactivado'}`);
  lines.push(
    `claim           ${
      ctx.claim ? `${ctx.claim.task_id} — ${ctx.claim.title ?? ''}` : 'ninguno'
    }`,
  );
  if (ctx.exemption.active) {
    lines.push(
      `exención        vigente (${ctx.exemption.ageHours.toFixed(1)}/${ctx.exemption.limitHours}h): ${ctx.exemption.reason}`,
    );
  } else if (ctx.exemption.expired) {
    lines.push('exención        VENCIDA');
  }
  say(lines.join('\n'));
  return 0;
}

// ---------------------------------------------------------------------------------------------
// claim / release / exempt
// ---------------------------------------------------------------------------------------------

function requireRegistered(config, cwd, what) {
  const { entry } = resolveProject(config, cwd);
  if (!entry) {
    err(
      `Este proyecto no está configurado, así que no hay nada que ${what}.\n` +
        'Corré `/clickup-setup` (dentro de Claude Code) o `clickup-flow project set …`.',
    );
    return null;
  }
  if (entry.mode === MODES.EXCLUDED) {
    err(
      `Este proyecto está EXCLUIDO de ClickUp a propósito${entry.excluded_reason ? ` (${entry.excluded_reason})` : ''}, ` +
        `así que no hay nada que ${what}.`,
    );
    return null;
  }
  return entry;
}

function cmdClaim(args) {
  const cwd = canonicalProjectKey(args.cwd || process.cwd());
  const { config, ok } = loadConfig();
  if (!ok) {
    err('config ilegible — corré `clickup-flow doctor`');
    return 1;
  }
  if (!requireRegistered(config, cwd, 'reclamar')) return 1;

  const taskId = args['task-id'] || args.task || args._[0];
  if (!taskId) {
    err('Falta --task-id. Uso: clickup-flow claim --task-id <id> --title "<título>" [--role backend|frontend]');
    return 1;
  }

  // Un claim distinto ya vigente en este proyecto se rechaza, no se sobrescribe.
  //
  // Verificado: dos sesiones de Claude Code abiertas en el MISMO repo (el caso normal de tener
  // una en la terminal y otra en el IDE) se pisaban el claim en silencio. Cada una creía tener
  // su tarea, y cuando la primera cerraba con `release`, la segunda quedaba bloqueada a mitad
  // del trabajo sin haber cerrado nada. Fallar acá con un mensaje es mucho mejor que descubrirlo
  // así.
  const previous = readState(cwd).claim;
  if (previous && previous.task_id && previous.task_id !== String(taskId) && !args.force) {
    err(
      `Ya hay una tarea reclamada en este proyecto: ${previous.task_id}` +
        `${previous.title ? ` — ${previous.title}` : ''}` +
        `${previous.claimed_at ? ` (desde ${previous.claimed_at})` : ''}.\n\n` +
        'El protocolo lleva UNA tarea por proyecto a la vez. Dos causas posibles:\n\n' +
        `  1. Esa tarea sigue abierta y hay que cerrarla primero: /tarea fin ${previous.task_id}\n` +
        '     (o pausarla en `on hold` si queda a medias).\n' +
        '  2. Hay OTRA sesión de Claude trabajando en este mismo repo. Si es así, no le pises el\n' +
        '     claim: coordinalo con el usuario antes de seguir.\n\n' +
        'Si de verdad querés reemplazarlo, `--force` — pero entonces la tarea anterior queda\n' +
        `abierta en ClickUp y sin nadie encima.`,
    );
    return 1;
  }

  const email = args.email || gitEmail(cwd);
  const file = setClaim(cwd, {
    taskId: String(taskId),
    title: args.title ? String(args.title) : null,
    url: args.url ? String(args.url) : null,
    role: args.role ? String(args.role) : null,
    gitEmail: email,
  });

  if (previous && previous.task_id && previous.task_id !== String(taskId)) {
    say(`⚠ Reemplazado por --force el claim anterior: ${previous.task_id}`);
    say('  Esa tarea quedó abierta en ClickUp y sin nadie encima. Cerrala o pausala.');
  }

  // Learning the git email here is how a second machine's alias stops looking like a colleague.
  if (email && rememberGitEmail(config, email)) saveConfig(config);

  say(`Tarea ${taskId} reclamada. Escritura desbloqueada.`);
  say(`  claim: ${file}`);
  return 0;
}

function cmdRelease(args) {
  const cwd = canonicalProjectKey(args.cwd || process.cwd());
  const current = readState(cwd).claim;

  if (!current) {
    say('No había ningún claim.');
    return 0;
  }

  // Si se dice QUÉ tarea se está soltando, se verifica que sea esa.
  //
  // Sin esto, dos sesiones en el mismo repo se sabotean: la sesión A termina su tarea, corre
  // `release`, y borra el claim de la sesión B — que queda bloqueada a mitad del trabajo sin
  // entender por qué. El id es opcional para no romper el uso simple, pero cuando se pasa, manda.
  const expected = args['task-id'] || args.task || args._[0];
  if (expected && current.task_id && String(expected) !== current.task_id && !args.force) {
    err(
      `El claim vigente NO es la tarea que estás soltando.\n\n` +
        `  querés soltar:  ${expected}\n` +
        `  claim vigente:  ${current.task_id}${current.title ? ` — ${current.title}` : ''}\n\n` +
        'Lo más probable es que otra sesión de Claude reclamó algo en este mismo repo. Soltarlo\n' +
        'la dejaría bloqueada a mitad del trabajo, así que no se toca.\n\n' +
        'Verificá el estado de tu tarea en ClickUp, y si igual querés limpiar el claim: --force.',
    );
    return 1;
  }

  clearClaim(cwd);
  say(`Claim liberado (${current.task_id ?? 's/id'}). El candado vuelve a pedir tarea.`);
  return 0;
}

function cmdExempt(args) {
  const cwd = canonicalProjectKey(args.cwd || process.cwd());
  const { config, ok } = loadConfig();
  if (!ok) {
    err('config ilegible — corré `clickup-flow doctor`');
    return 1;
  }
  if (args.clear) {
    const had = clearExemption(cwd);
    say(had ? 'Exención borrada.' : 'No había exención.');
    return 0;
  }
  if (!requireRegistered(config, cwd, 'exceptuar')) return 1;

  const reason = args.reason || args._.join(' ');
  if (!reason || !String(reason).trim()) {
    err(
      'Falta --reason, y no es un trámite: la exención existe para que quede DICHO por qué este ' +
        'trabajo no amerita tarea.\n' +
        '  clickup-flow exempt --reason "<motivo concreto>"',
    );
    return 1;
  }
  const hours = Number.parseFloat(args.hours ?? config.defaults.exemption_hours ?? 8);
  setExemption(cwd, reason, hours);
  say(`Exención declarada por ${hours}h: ${String(reason).trim()}`);
  say('No la uses para saltear la búsqueda en ClickUp — eso es justo lo que produce duplicados.');
  return 0;
}

// ---------------------------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------------------------

function cmdIdentity(args) {
  const sub = args._[0] ?? 'show';
  const { config, ok } = loadConfig();
  if (!ok) {
    err('config ilegible — corré `clickup-flow doctor`');
    return 1;
  }

  if (sub === 'show') {
    const i = config.identity;
    say(
      [
        `clickup_user_id  ${i.clickup_user_id ?? '— SIN RESOLVER'}`,
        `clickup_email    ${i.clickup_email ?? '—'}`,
        `clickup_username ${i.clickup_username ?? '—'}`,
        `confirmado       ${i.confirmed ? 'sí' : 'NO'}`,
        `resuelto vía     ${i.resolved_via ?? '—'} ${i.resolved_at ?? ''}`,
        `emails de git    ${(i.git_emails ?? []).join(', ') || '—'}`,
        i.pending_query ? `dato del install ${i.pending_query}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    return identityReady(config) ? 0 : 1;
  }

  if (sub === 'set') {
    const id = args.id;
    if (!id) {
      err(
        'Falta --id (el id NUMÉRICO del miembro de ClickUp).\n' +
          'Sacalo con clickup_get_workspace_members o clickup_find_member_by_name, CONFIRMALO con\n' +
          'el usuario, y recién entonces guardalo. Nunca uses "me": resuelve al dueño del token.',
      );
      return 1;
    }
    if (!/^\d+$/.test(String(id).trim())) {
      err(
        `--id tiene que ser numérico, llegó "${id}". Si eso es un email o un nombre, resolvelo ` +
          'primero contra el workspace: guardar un id inválido produce asignaciones que fallan en ' +
          'silencio.',
      );
      return 1;
    }
    config.identity.clickup_user_id = String(id).trim();
    if (args.email) config.identity.clickup_email = String(args.email).trim();
    if (args.name) config.identity.clickup_username = String(args.name).trim();
    config.identity.confirmed = truthy(args.confirmed, true);
    config.identity.resolved_via = args.via ? String(args.via) : 'mcp';
    config.identity.resolved_at = new Date().toISOString();
    delete config.identity.pending_query;

    const email = gitEmail(canonicalProjectKey(args.cwd || process.cwd()));
    if (email) rememberGitEmail(config, email);

    saveConfig(config);
    say(
      `Identidad guardada: ${config.identity.clickup_user_id}` +
        `${config.identity.clickup_username ? ` (${config.identity.clickup_username})` : ''}` +
        `${config.identity.confirmed ? ' — confirmada' : ' — SIN CONFIRMAR'}`,
    );
    if (!config.identity.confirmed) {
      say('Sin confirmar significa: no asignes con esto sin preguntarle al usuario primero.');
    }
    return 0;
  }

  err(`Subcomando desconocido: identity ${sub}. Usá "show" o "set".`);
  return 1;
}

function cmdTeam(args) {
  const sub = args._[0] ?? 'list';
  const { config, ok } = loadConfig();
  if (!ok) {
    err('config ilegible');
    return 1;
  }

  if (sub === 'list') {
    const entries = Object.entries(config.team ?? {});
    if (!entries.length) {
      say('Sin compañeros mapeados. Solo hace falta si asignás tareas a otra gente.');
      return 0;
    }
    for (const [email, v] of entries) {
      say(
        `${email.padEnd(34)} ${String(v.clickup_id ?? '—').padEnd(12)} ${v.name ?? '—'}` +
          `${v.confirmed ? '' : '   ⚠ SIN CONFIRMAR'}`,
      );
    }
    return 0;
  }

  if (sub === 'add') {
    const gitE = args['git-email'];
    const id = args['clickup-id'] || args.id;
    if (!gitE || !id) {
      err('Uso: clickup-flow team add --git-email <email> --clickup-id <id> --name "<nombre>" [--confirmed]');
      return 1;
    }
    if (!/^\d+$/.test(String(id).trim())) {
      err(`--clickup-id tiene que ser numérico, llegó "${id}".`);
      return 1;
    }
    config.team = config.team ?? {};
    config.team[String(gitE).trim().toLowerCase()] = {
      clickup_id: String(id).trim(),
      name: args.name ? String(args.name) : null,
      clickup_email: args['clickup-email'] ? String(args['clickup-email']) : null,
      confirmed: truthy(args.confirmed, false),
      note: args.note ? String(args.note) : null,
      added_at: new Date().toISOString(),
    };
    saveConfig(config);
    const conf = truthy(args.confirmed, false);
    say(`Mapeo guardado para ${gitE} → ${id}${conf ? ' (confirmado)' : ''}`);
    if (!conf) {
      say(
        '⚠ Quedó SIN CONFIRMAR. `confirmado: false` no es "casi sí": significa que el mapeo lo ' +
          'dedujo un agente y nadie lo validó. No le asignes nada sin preguntar — una asignación ' +
          'al colega equivocado no falla, no avisa, y se descubre semanas después.',
      );
    }
    return 0;
  }

  err(`Subcomando desconocido: team ${sub}`);
  return 1;
}

// ---------------------------------------------------------------------------------------------
// project
// ---------------------------------------------------------------------------------------------

function cmdProject(args) {
  const sub = args._[0] ?? 'show';
  const cwd = canonicalProjectKey(args.cwd || process.cwd());
  const { config, ok } = loadConfig();
  if (!ok) {
    err('config ilegible');
    return 1;
  }

  if (sub === 'list') {
    const entries = Object.entries(config.projects ?? {});
    if (!entries.length) {
      say('Ningún proyecto registrado todavía.');
      return 0;
    }
    for (const [key, p] of entries) {
      const where =
        p.mode === MODES.EXCLUDED
          ? `excluido${p.excluded_reason ? ` — ${p.excluded_reason}` : ''}`
          : p.mode === MODES.UMBRELLA
            ? `paraguas ${p.umbrella_task_id ?? '—'} en lista ${p.list_id ?? '—'}`
            : `lista ${p.list_id ?? '—'}`;
      say(`${String(p.mode).padEnd(9)} ${key}\n          ${where}`);
    }
    return 0;
  }

  if (sub === 'show') {
    const { entry, matchedBy, matchedKey } = resolveProject(config, cwd);
    if (!entry) {
      say(`Sin configurar: ${cwd}`);
      return 1;
    }
    say(`# ${matchedKey}${matchedBy !== 'path' ? ` (resuelto por ${matchedBy})` : ''}`);
    say(JSON.stringify(entry, null, 2));
    return 0;
  }

  if (sub === 'exclude') {
    const entry = upsertProject(config, cwd, {
      mode: MODES.EXCLUDED,
      excluded_reason: args.reason ? String(args.reason) : 'el usuario eligió no usar ClickUp acá',
      excluded_at: new Date().toISOString(),
    });
    saveConfig(config);
    dropState(cwd);
    say(`Proyecto EXCLUIDO de ClickUp: ${entry.path}`);
    say('No se vuelve a preguntar, y el candado de escritura queda abierto en esta carpeta.');
    return 0;
  }

  if (sub === 'forget') {
    const key = canonicalProjectKey(cwd);
    if (!config.projects?.[key]) {
      err(`No hay entrada exacta para ${key}. \`project list\` muestra las que hay.`);
      return 1;
    }
    delete config.projects[key];
    saveConfig(config);
    dropState(cwd);
    say(`Entrada borrada: ${key}. La próxima sesión va a volver a preguntar.`);
    return 0;
  }

  if (sub === 'set') {
    const mode = String(args.mode ?? '').trim();
    if (![MODES.TASKS, MODES.UMBRELLA].includes(mode)) {
      err(`--mode tiene que ser "${MODES.TASKS}" o "${MODES.UMBRELLA}" (para excluir: project exclude).`);
      return 1;
    }
    // Obligatorio solo si el proyecto no tiene ya una lista: en una reconfiguración parcial
    // (cambiar el rol, por ejemplo) no hay que repetir lo que ya está guardado.
    const listaPrevia = config.projects?.[cwd]?.list_id;
    if (!args['list-id'] && !listaPrevia) {
      err('Falta --list-id: es donde se crean las tareas. Sin eso el protocolo no puede operar.');
      return 1;
    }

    // `--handoff` quedó reemplazado por `--role`, que además tiene DIRECCIÓN. Ignorarlo en
    // silencio sería peor que fallar: quien lo pase cree que configuró algo que no configuró.
    if (args.handoff !== undefined) {
      err(
        '--handoff ya no existe: fue reemplazado por --role, que además dice la DIRECCIÓN de la\n' +
          'entrega.\n\n' +
          '  --role backend    entrega hacia adelante (con --counterpart, puede parkear)\n' +
          '  --role frontend   consume lo que el otro dejó listo; cierra la cadena\n' +
          '  --role fullstack  hace las dos puntas; sin entregas entre proyectos',
      );
      return 1;
    }
    if (mode === MODES.UMBRELLA && !args['umbrella-task-id'] && !config.projects?.[cwd]?.umbrella_task_id) {
      err(
        'El modo "umbrella" necesita --umbrella-task-id: la tarea principal de la que cuelgan las ' +
          'subtareas. Si no existe todavía, creala en ClickUp primero.',
      );
      return 1;
    }

    // El ROL decide la dirección de las entregas. Sin rol el protocolo no puede saber si al
    // cerrar hay que parkear para otro o cerrar del todo, ni cuál es la bandeja de entrada.
    const roleArg = args.role === undefined ? ROLES.FULLSTACK : String(args.role).trim();
    const role = roleArg;
    if (![ROLES.BACKEND, ROLES.FRONTEND, ROLES.FULLSTACK].includes(role)) {
      err(
        `--role: "${ROLES.BACKEND}" | "${ROLES.FRONTEND}" | "${ROLES.FULLSTACK}". Llegó "${roleArg}".\n\n` +
          `  ${ROLES.BACKEND}    entrega hacia adelante; su bandeja es el backlog\n` +
          `  ${ROLES.FRONTEND}   consume lo que el backend dejó listo; cierra la cadena\n` +
          `  ${ROLES.FULLSTACK}  hace las dos puntas; no hay entregas entre proyectos`,
      );
      return 1;
    }

    // La contraparte es lo que evita la tarea que espera a nadie: un backend sin frontend
    // registrado NO puede parkear en el estado de handoff (ver roleBehaviour en config.mjs).
    const limpiaContraparte =
      args.counterpart !== undefined &&
      ['none', ''].includes(String(args.counterpart).trim().toLowerCase());
    if (args.counterpart && !limpiaContraparte) {
      const cp = canonicalProjectKey(args.counterpart);
      if (cp === cwd) {
        err('--counterpart no puede ser este mismo proyecto.');
        return 1;
      }
      if (role === ROLES.FULLSTACK) {
        err(
          'Un proyecto `fullstack` no tiene contraparte: hace las dos puntas. Si entrega trabajo a ' +
            'otro repositorio, su rol es `backend` o `frontend`.',
        );
        return 1;
      }
      if (!config.projects?.[cp]) {
        say(
          `⚠ La contraparte \`${cp}\` no está registrada todavía. Se guarda igual, pero hasta que ` +
            'lo esté el protocolo no va a poder nombrarla ni verificar su rol.',
        );
      }
    }

    // Solo se incluyen los campos que el llamador PASÓ.
    //
    // La versión anterior armaba el patch completo, con `null` donde el flag faltaba, y
    // `upsertProject` hace `{...previo, ...patch}`: un flag omitido BORRABA el valor guardado.
    // Cambiar solo el rol de un proyecto le vaciaba el espacio, la carpeta y los nombres, en
    // silencio. Y `/clickup-setup` propone justamente cambios parciales sobre un proyecto que ya
    // funciona, así que era el camino más probable hacia la pérdida.
    const previo = config.projects?.[cwd] ?? {};
    const patch = { mode };

    const asigna = (campo, flag, transformar = String) => {
      if (args[flag] !== undefined) patch[campo] = transformar(args[flag]);
    };

    asigna('name', 'name');
    if (patch.name === undefined && previo.name === undefined) patch.name = path.basename(cwd);

    asigna('workspace_id', 'workspace-id');
    if (patch.workspace_id === undefined && previo.workspace_id === undefined) {
      patch.workspace_id = config.defaults.workspace_id;
    }

    asigna('space_id', 'space-id');
    asigna('space_name', 'space-name');
    asigna('folder_id', 'folder-id');
    asigna('folder_name', 'folder-name');
    asigna('list_id', 'list-id');
    asigna('list_name', 'list-name');
    asigna('umbrella_task_id', 'umbrella-task-id');
    // `none` (o vacío) LIMPIA la contraparte. Con la semántica de preservar, omitir el flag la
    // conserva — así que sin una forma explícita de borrarla no habría manera de quitarla.
    if (args.counterpart !== undefined) {
      const v = String(args.counterpart).trim().toLowerCase();
      patch.counterpart = v === 'none' || v === '' ? null : canonicalProjectKey(args.counterpart);
    }
    asigna('naming', 'naming', (v) => (v === 'prefixed' ? 'prefixed' : 'descriptive'));

    // El rol siempre se escribe: su default (fullstack) es una decisión, no una ausencia — y de
    // él se deriva `handoff`, que no puede quedar inconsistente.
    patch.role = role;
    patch.handoff = role !== ROLES.FULLSTACK;
    // Un fullstack no tiene contraparte: si el rol cambió a fullstack, se limpia.
    if (role === ROLES.FULLSTACK) patch.counterpart = null;
    // Re-registering a previously excluded project has to clear the exclusion, or `context`
    // would keep reporting "excluded" from the leftover fields.
    patch.excluded_reason = null;
    patch.excluded_at = null;

    // The real status names of this board. A name that does not exist on the list makes every
    // update fail, so when they are provided we record them and stop relying on the defaults.
    const statuses = { ...(config.projects?.[cwd]?.statuses || {}) };
    for (const role of Object.keys(STATUS_ROLES)) {
      const raw = args[`status-${role.replace(/_/g, '-')}`];
      if (raw === undefined) continue;
      const value = String(raw).trim();
      if (!value) {
        err(`--status-${role.replace(/_/g, '-')} no puede estar vacío.`);
        return 1;
      }
      statuses[role] = value;
    }
    if (Object.keys(statuses).length) patch.statuses = statuses;

    if (args['available-statuses']) {
      const list = String(args['available-statuses'])
        .split('|')
        .map((x) => x.trim())
        .filter(Boolean);
      if (list.length) {
        patch.available_statuses = list;
        // Catch the mistake at write time rather than at the first failed update: a mapped name
        // that is not in the board's own list is guaranteed to fail later.
        const unknown = Object.entries(statuses).filter(([, v]) => !list.includes(v));
        if (unknown.length) {
          err(
            `Estos estados no existen en la lista (${list.join(', ')}):\n` +
              unknown.map(([role, v]) => `  ${role} → "${v}"`).join('\n') +
              '\nCorregilos: un estado inexistente hace fallar cada clickup_update_task.',
          );
          return 1;
        }
      }
    }

    // Per-project overrides. Only the flags actually passed are recorded, so an omitted flag
    // keeps inheriting the global default instead of freezing today's value into the project.
    const overrides = { ...(config.projects?.[cwd]?.overrides || {}) };
    const flagFor = {
      use_dates: 'use-dates',
      use_priorities: 'use-priorities',
      auto_assign: 'auto-assign',
      end_date_field: 'end-date-field',
      search_window_days: 'search-window-days',
    };
    for (const key of OVERRIDABLE) {
      const raw = args[flagFor[key]];
      if (raw === undefined) continue;
      if (key === 'end_date_field') {
        const value = String(raw);
        if (!['description', 'due_date', 'custom_field'].includes(value)) {
          err('--end-date-field: description | due_date | custom_field');
          return 1;
        }
        overrides[key] = value;
      } else if (key === 'search_window_days') {
        const n = Number(raw);
        // 0 es válido y significa "sin límite": buscar todo el historial de cerradas.
        if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
          err(
            `--search-window-days: un entero de días, o 0 para sin límite. Llegó "${raw}".`,
          );
          return 1;
        }
        overrides[key] = n;
      } else {
        overrides[key] = truthy(raw, true);
      }
    }
    if (Object.keys(overrides).length) patch.overrides = overrides;

    const entry = upsertProject(config, cwd, patch);
    saveConfig(config);
    say(`Proyecto configurado: ${entry.path}`);
    say(`  modo ${entry.mode} · lista ${entry.list_id}${entry.umbrella_task_id ? ` · paraguas ${entry.umbrella_task_id}` : ''}`);
    if (!identityReady(config)) {
      say('');
      say('⚠ La identidad de ClickUp sigue sin resolver: resolvela antes de asignar nada.');
    }
    return 0;
  }

  err(`Subcomando desconocido: project ${sub}. Usá show | list | set | exclude | forget.`);
  return 1;
}

// ---------------------------------------------------------------------------------------------
// migrate — detecta la configuración vieja del protocolo dentro de un proyecto
// ---------------------------------------------------------------------------------------------

function cmdMigrate(args) {
  const cwd = canonicalProjectKey(args.cwd || process.cwd());
  const findings = scanProject(cwd);

  const bySeverity = (sev) => findings.filter((f) => f.severity === sev);
  const conflicts = bySeverity('conflict');
  const stale = bySeverity('stale');
  const imports = bySeverity('import');
  const keep = bySeverity('keep');

  // --- importar el mapeo de usuarios: la única escritura, y va a NUESTRA config --------------
  if (args['import-users']) {
    const entry = imports.find((f) => f.users);
    if (!entry) {
      err(
        'No encontré un .claude/clickup-usuarios.json con entradas para importar en este proyecto.',
      );
      return 1;
    }
    const { config, ok } = loadConfig();
    if (!ok) {
      err('config ilegible — corré doctor');
      return 1;
    }
    const { added, skipped, conflicts } = importUsers(config, entry.users);
    if (added.length) saveConfig(config);

    say(`Importadas ${added.length} entrada(s) al mapeo del equipo:`);
    for (const a of added) {
      const flags = [
        a.enriched ? 'completada' : null,
        a.confirmed ? null : '⚠ SIN CONFIRMAR',
        a.demoted ? 'pasó a sin confirmar' : null,
      ].filter(Boolean);
      say(`  ${a.gitEmail.padEnd(34)} → ${a.id}${flags.length ? `   ${flags.join(' · ')}` : ''}`);
    }
    for (const s of skipped) say(`  (salteada) ${s.gitEmail}: ${s.why}`);

    if (added.some((a) => a.demoted)) {
      say('');
      say(
        'Alguna entrada pasó a SIN CONFIRMAR: el archivo la tenía marcada como deducida y acá ' +
          'estaba como confirmada. `confirmed` es una bandera de seguridad, así que gana la ' +
          'versión más conservadora — vuelve a estar confirmada cuando el usuario lo valide.',
      );
    }

    if (conflicts.length) {
      say('');
      say(`⚠ ${conflicts.length} conflicto(s) de id que NO se resolvieron:`);
      for (const c of conflicts) {
        say(`  ${c.gitEmail}: la config dice ${c.existing}, el archivo dice ${c.incoming}`);
      }
      say('');
      say(
        'Uno de los dos está mal, y elegir por nuestra cuenta sería asignarle trabajo a la ' +
          'persona equivocada en silencio. Resolvelo con el usuario y después: ' +
          'clickup-flow team add --git-email <email> --clickup-id <el correcto> --confirmed',
      );
    }

    if (added.some((a) => !a.confirmed)) {
      say('');
      say(
        'Las marcadas SIN CONFIRMAR se importaron tal cual venían. Si el archivo original decía ' +
          'que el mapeo era una deducción sin validar, ascenderlo acá sería borrar la única ' +
          'advertencia que evita asignarle trabajo a la persona equivocada.',
      );
    }
    say('');
    say(`El archivo original NO se borró: ${entry.where}`);
    return 0;
  }

  // --- reporte (no borra nada) ---------------------------------------------------------------
  say(`# Migración — ${cwd}`);
  say('');

  if (!conflicts.length && !stale.length && !imports.length) {
    say('No encontré configuración vieja del protocolo en este proyecto.');
    for (const f of keep) say(`  · ${f.what} se queda como está. ${f.why}`);
    return 0;
  }

  if (conflicts.length) {
    say(`## ${conflicts.length} CONFLICTO(S) — esto hay que resolverlo`);
    say('');
    say(
      'Mientras esto siga acá hay DOS protocolos cargados, y no dicen lo mismo. Y peor: las ' +
        'skills y los comandos de proyecto GANAN sobre los globales, así que el que se aplica es ' +
        'el viejo — con "me" como assignee, que es exactamente el bug que la herramienta nueva ' +
        'elimina.',
    );
    say('');
    for (const f of conflicts) {
      say(`### ${f.what}`);
      say(f.where);
      say('');
      say(f.why);
      say('');
      if (f.manual) {
        say(`A MANO: ${f.fix}`);
      } else {
        say('```bash');
        say(f.fix);
        say('```');
      }
      say('');
    }
  }

  if (imports.length) {
    say('## Datos que conviene traer');
    say('');
    for (const f of imports) {
      say(`### ${f.what}`);
      say(f.where);
      say('');
      say(f.why);
      say('');
      say('```bash');
      say(f.fix);
      say('```');
      say('');
    }
  }

  if (stale.length) {
    say('## Restos, sin urgencia');
    say('');
    for (const f of stale) {
      say(`- ${f.what}`);
      say(`  ${f.why}`);
      if (f.fix) say(`  ${f.fix}`);
    }
    say('');
  }

  if (keep.length) {
    say('## Se queda como está');
    say('');
    for (const f of keep) say(`- ${f.what} — ${f.why}`);
    say('');
  }

  say('---');
  say('');
  say(
    'Nada de esto se borró automáticamente: son archivos de tu repositorio y la decisión es tuya. ' +
      'Después de limpiar, verificá con `context` que el protocolo que queda es el nuevo.',
  );

  return conflicts.length ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// config / doctor
// ---------------------------------------------------------------------------------------------

function cmdConfig(args) {
  const sub = args._[0] ?? 'show';
  if (sub === 'path') {
    say(configPath());
    return 0;
  }
  const { config, ok, error } = loadConfig();
  if (!ok) {
    err(`config ilegible: ${error}`);
    return 1;
  }
  if (sub === 'show') {
    say(JSON.stringify(config, null, 2));
    return 0;
  }
  if (sub === 'set') {
    const key = args.key ?? args._[1];
    const value = args.value ?? args._[2];
    if (!key) {
      err('Uso: clickup-flow config set --key <defaults.x> --value <valor>');
      return 1;
    }
    const parts = String(key).split('.');
    if (parts[0] !== 'defaults') {
      err('Solo se puede editar `defaults.*` por acá. Para lo demás, editá el JSON a mano.');
      return 1;
    }
    const field = parts[1];
    if (!(field in config.defaults)) {
      err(`No existe defaults.${field}. Campos: ${Object.keys(config.defaults).join(', ')}`);
      return 1;
    }
    const current = config.defaults[field];
    let next = value;
    if (typeof current === 'boolean') next = truthy(value, current);
    else if (typeof current === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        err(`defaults.${field} es numérico y no negativo, llegó "${value}".`);
        return 1;
      }
      if (field === 'search_window_days' && !Number.isInteger(n)) {
        err('defaults.search_window_days son días enteros (0 = sin límite).');
        return 1;
      }
      next = n;
    }
    if (field === 'end_date_field' && !['description', 'due_date', 'custom_field'].includes(next)) {
      err('end_date_field: description | due_date | custom_field');
      return 1;
    }
    config.defaults[field] = next;
    saveConfig(config);
    say(`defaults.${field} = ${JSON.stringify(next)}`);
    return 0;
  }
  err(`Subcomando desconocido: config ${sub}. Usá show | path | set.`);
  return 1;
}

function cmdDoctor() {
  const lines = [];
  // Problems break the protocol; warnings are things worth knowing that still work. Mixing
  // them turns `doctor` into something people stop reading — a healthy install has to be able
  // to say "todo en orden" and mean it.
  let problems = 0;
  let warnings = 0;

  lines.push(`node            ${process.version}`);
  {
    const { config: c } = loadConfig();
    lines.push(
      `version         ${c.installed_version ?? 'sin registrar (instalación previa a este campo)'}`,
    );
  }
  lines.push(`install dir     ${toolHome()}${fs.existsSync(toolHome()) ? '' : '  ← NO EXISTE'}`);
  if (!fs.existsSync(toolHome())) problems++;

  const { config, ok, error, existed } = loadConfig();
  if (!existed) {
    lines.push(`config          ${configPath()}  ← NO EXISTE (¿corriste el instalador?)`);
    problems++;
  } else if (!ok) {
    lines.push(`config          ILEGIBLE — ${error}`);
    lines.push('                Con la config ilegible, TODOS los hooks se desactivan (fail open).');
    problems++;
  } else {
    lines.push(`config          ${configPath()}  ok`);
    lines.push(
      `identidad       ${identityReady(config) ? `${config.identity.clickup_user_id} ok` : 'SIN RESOLVER ← no vas a poder asignar'}`,
    );
    if (!identityReady(config)) problems++;
    const projects = Object.entries(config.projects ?? {});
    lines.push(
      `proyectos       ${projects.length} (${projects.filter(([, p]) => p.mode === MODES.EXCLUDED).length} excluidos)`,
    );
    // A misconfigured umbrella project silently degrades into "creates loose tasks".
    for (const [key, p] of projects) {
      if (p.mode === MODES.UMBRELLA && !p.umbrella_task_id) {
        lines.push(`                ⚠ ${key}: modo umbrella SIN umbrella_task_id`);
        problems++;
      }
      if (p.mode !== MODES.EXCLUDED && !p.list_id) {
        lines.push(`                ⚠ ${key}: sin list_id`);
        problems++;
      }
      // Una contraparte que no puede RECIBIR solo es un PROBLEMA para quien iba a entregarle.
      //
      // Para un `backend` es pérdida de trabajo: parkearía tareas creyendo que entregó y nadie
      // las levantaría. Para un `frontend` es apenas informativo — nunca parkea, así que una
      // contraparte rota no le cambia el comportamiento. Reportar las dos igual sería `doctor`
      // gritando lobo, que es exactamente cómo se deja de leer.
      if (p.mode !== MODES.EXCLUDED && p.counterpart) {
        const rb = roleBehaviour(p, config);
        if (rb.counterpartProblem && rb.role === ROLES.BACKEND) {
          lines.push(`                ⚠ ${key}:`);
          lines.push(`                  su contraparte \`${p.counterpart}\` ${rb.counterpartProblem}`);
          lines.push(
            '                  → mientras siga así CIERRA en vez de parkear (degradado a propósito)',
          );
          problems++;
        } else if (rb.counterpartProblem) {
          lines.push(
            `                · ${key}: su contraparte \`${p.counterpart}\` ${rb.counterpartProblem}`,
          );
          lines.push(
            `                  (informativo: un \`${rb.role}\` no parkea, así que no le cambia nada)`,
          );
          warnings++;
        } else if (config.projects?.[p.counterpart]?.counterpart !== key) {
          // Relación de un solo lado: puede ser deliberada, pero conviene saberlo.
          lines.push(
            `                · ${key}: su contraparte \`${p.counterpart}\` no lo declara de vuelta`,
          );
          warnings++;
        }
      }

      if (p.mode !== MODES.EXCLUDED && !p.statuses) {
        // A warning, not a problem: the fallback names are right for many boards, so this works
        // as-is. But when a space renames its statuses, this is the line that explains why every
        // update suddenly fails — so it stays visible.
        lines.push(
          `                · ${key}: estados sin confirmar contra el tablero (usa los defaults)`,
        );
        warnings++;
      }
    }
  }

  const { settings, error: sErr } = readSettings();
  if (sErr) {
    lines.push(`settings.json   ILEGIBLE — ${sErr}`);
    problems++;
  } else {
    const installed = inspectInstalled(settings);
    lines.push(`hooks           ${installed.length}/3 registrados en settings.json`);
    for (const h of installed) lines.push(`                ${h.event}${h.matcher ? ` [${h.matcher}]` : ''}`);
    if (installed.length !== 3) problems++;
  }

  const states = listStateFiles();
  lines.push(`state           ${states.length} archivo(s) en ${statePath()}`);

  say(lines.join('\n'));
  say('');
  if (problems === 0 && warnings === 0) {
    say('Todo en orden.');
  } else if (problems === 0) {
    say(`Todo en orden. ${warnings} aviso(s) sin gravedad, marcados con ·`);
  } else {
    say(
      `${problems} problema(s) que conviene revisar` +
        `${warnings ? `, y ${warnings} aviso(s) sin gravedad` : ''}.`,
    );
  }
  return problems === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

function say(msg) {
  process.stdout.write(`${msg}\n`);
}
function err(msg) {
  process.stderr.write(`${msg}\n`);
}

const USAGE = `clickup-flow — protocolo de tareas de ClickUp para Claude Code

Uso: clickup-flow <comando> [opciones]

Trabajo diario
  context                     Imprime el protocolo resuelto para este proyecto
  status                      Resumen corto del estado
  claim --task-id <id> --title "<t>" [--role backend|frontend]
  release                     Suelta el claim (al cerrar o al retirarse)
  exempt --reason "<motivo>" [--hours N] | exempt --clear

Configuración
  project show | list | set | exclude | forget
      set acepta, además de las coordenadas, overrides por proyecto:
      --use-dates --use-priorities --auto-assign --end-date-field --search-window-days
      y los nombres REALES de los estados del tablero:
      --role backend|frontend|fullstack   --counterpart <ruta del otro proyecto>|none
      --status-todo --status-in-progress --status-on-hold --status-handoff --status-done
      --available-statuses "a|b|c"   (valida que los de arriba existan)
  identity show | set --id <numérico> [--email] [--name] [--confirmed]
  team list | add --git-email <e> --clickup-id <id> [--name] [--confirmed]
  config show | path | set --key defaults.<campo> --value <v>
  migrate [--import-users]    Detecta configuración vieja del protocolo en este proyecto
  doctor                      Verifica la instalación

Hooks (los invoca el harness, no vos)
  session-start | prompt-hook | guard
`;

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parseArgs(argv.slice(1));

  switch (command) {
    case 'session-start':
      return cmdSessionStart();
    case 'prompt-hook':
      return cmdPromptHook();
    case 'guard':
      return cmdGuard();
    case 'context':
      return cmdContext(args);
    case 'status':
      return cmdStatus(args);
    case 'claim':
      return cmdClaim(args);
    case 'release':
      return cmdRelease(args);
    case 'exempt':
      return cmdExempt(args);
    case 'identity':
      return cmdIdentity(args);
    case 'team':
      return cmdTeam(args);
    case 'project':
      return cmdProject(args);
    case 'config':
      return cmdConfig(args);
    case 'migrate':
      return cmdMigrate(args);
    case 'doctor':
      return cmdDoctor();
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      say(USAGE);
      return 0;
    default:
      err(`Comando desconocido: ${command}\n`);
      err(USAGE);
      return 1;
  }
}

// The catch-all is what makes the golden rule true. A hook that throws would surface as a broken
// turn in an unrelated repository, so hooks always resolve to a silent 0 and only real commands
// are allowed to report a failure.
const HOOKS = new Set(['session-start', 'prompt-hook', 'guard']);
main()
  .then((code) => process.exit(typeof code === 'number' ? code : 0))
  .catch((error) => {
    const cmd = process.argv[2];
    const message = error instanceof Error ? error.message : String(error);

    if (HOOKS.has(cmd)) {
      // Sale con 0 para no romper el turno — pero DICIÉNDOLO.
      //
      // Antes salía con 0 en absoluto silencio, y eso creaba un modo de fallo indetectable: un
      // bug interno en `guard` lo dejaba sin bloquear nada, indistinguible de un proyecto sin
      // configurar. El candado dejaba de proteger y nadie se enteraba. Lo descubrió un test de
      // mutación: al romper el guard a propósito, el suite seguía en verde.
      //
      // stderr de un hook lo muestra Claude Code sin cancelar la llamada, así que esto es
      // visible sin ser destructivo. Una línea, sin stack: el stack va a `doctor`.
      err(
        `[clickup-flow] El hook \`${cmd}\` falló internamente: ${message}. ` +
          'El protocolo de tareas NO se aplicó en esta llamada — si esto se repite, corré ' +
          '`clickup-flow doctor`.',
      );
      process.exit(0);
    }

    // Un comando sí puede reportar la falla, pero no con un stack en la cara. El fallo típico
    // acá no es un bug: es el disco, los permisos o un archivo en uso, y el usuario necesita
    // saber QUÉ hacer, no en qué línea de qué módulo se cortó.
    const codigo = error && typeof error === 'object' && 'code' in error ? String(error.code) : null;
    err(`clickup-flow: ${message}`);
    if (codigo === 'EACCES' || codigo === 'EPERM') {
      err(
        'Es un problema de permisos sobre el directorio de configuración de Claude Code. ' +
          'Revisá quién es el dueño de esa carpeta (¿se instaló con sudo?).',
      );
    } else if (codigo === 'EBUSY' || codigo === 'ENOTEMPTY') {
      err('Un archivo está en uso (antivirus, OneDrive, o un editor abierto ahí). Cerralo y reintentá.');
    } else if (codigo === 'ENOSPC') {
      err('No queda espacio en disco.');
    } else if (codigo === 'EROFS') {
      err('El sistema de archivos está montado como sólo lectura.');
    }
    if (process.env.CLICKUP_FLOW_DEBUG && error instanceof Error && error.stack) {
      err(`\n${error.stack}`);
    } else {
      err('Detalle técnico: CLICKUP_FLOW_DEBUG=1 y volvé a correrlo.');
    }
    process.exit(1);
  });

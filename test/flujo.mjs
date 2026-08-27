#!/usr/bin/env node
//
// Simulación del flujo completo de una persona, de punta a punta.
//
// Los otros suites prueban piezas. Este prueba el recorrido: instalar, resolver identidad,
// configurar tres proyectos con los tres modos, reclamar, escribir, cerrar.
//
// LOS DATOS SON FICTICIOS. Los ids, nombres y emails de acá no corresponden a ningún workspace:
// los dominios salen de RFC 2606 (reservados para documentación, no pueden existir) y los ids
// usan rangos sintéticos que ningún workspace real produce.
//
// Lo que sí es real es la FORMA: los ids son numéricos porque el código los valida así, los
// estados llevan los nombres canónicos que devuelve `clickup_get_list`, y el id de tarea imita
// el formato de ClickUp. Eso es lo que hace que el test pruebe algo — la forma, no los valores.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const INSTALLER = path.join(REPO, 'src', 'installer.mjs');

// ---- coordenadas ficticias con la FORMA de las reales ---------------------------------------
const TABLERO = {
  workspace: '1000000001',
  space: { id: '2000000001', name: 'Acme' },
  mensajeria: {
    folder: { id: '3000000001', name: 'Mensajeria' },
    list: { id: '4000000001', name: 'List' },
  },
  gateway: {
    folder: { id: '3000000002', name: 'Plataforma' },
    list: { id: '4000000002', name: 'Gateway' },
    umbrella: '86abc0001', // la tarea paraguas de la que cuelgan las subtareas
  },
  // La forma que devuelve clickup_get_list. `reviewed` es type:done y `complete` es
  // type:closed — esa distinción SÍ es real y es la que decide quién recibe date_closed.
  statuses: ['to do', 'on hold', 'in progress', 'update required', 'reviewed', 'complete'],
  // Lo que devolvería clickup_resolve_assignees(["me"]): el dueño del token, NO quien ejecuta.
  tokenOwner: '5000000001',
  // Emails de git que NO son miembros del workspace y por lo tanto resuelven a null. Que eso
  // pase es real y verificado; estos valores concretos son inventados.
  gitEmailsThatFail: ['atorres@dev.example', 'ana.torres@example.net', 'BSalas.dev@example.org'],
};

let pass = 0;
let fail = 0;
const failures = [];

function step(name, fn) {
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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// ---- sandbox -------------------------------------------------------------------------------
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'clickup-flujo-'));
const fakeClaude = path.join(sandbox, '.claude');
const P = {
  mensajeria: path.join(sandbox, 'mensajeria-api'),
  backend: path.join(sandbox, 'db-gateway'),
  frontend: path.join(sandbox, 'db-gateway-frontend'),
  personal: path.join(sandbox, 'dotfiles'),
};
for (const dir of [fakeClaude, ...Object.values(P)]) fs.mkdirSync(dir, { recursive: true });

fs.writeFileSync(path.join(fakeClaude, 'settings.json'), JSON.stringify({ model: 'opus' }, null, 2));

const env = { ...process.env, CLAUDE_CONFIG_DIR: fakeClaude, NO_COLOR: '1' };
const CLI = path.join(fakeClaude, 'clickup-flow', 'src', 'cli.mjs');

function cli(args, cwd) {
  return execFileSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env,
    cwd: cwd || REPO,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function guard(cwd, file) {
  try {
    execFileSync('node', [CLI, 'guard'], {
      encoding: 'utf8',
      env,
      input: JSON.stringify({ cwd, tool_name: 'Write', tool_input: { file_path: file } }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { blocked: false, why: '' };
  } catch (err) {
    return { blocked: err.status === 2, why: err.stderr?.toString() ?? '' };
  }
}

console.log(`\nsandbox: ${sandbox}\n`);
console.log('PASO 1 — instalar\n');

execFileSync('node', [INSTALLER, '--yes'], { encoding: 'utf8', env, cwd: REPO });

step('la herramienta queda instalada', () => {
  assert(fs.existsSync(CLI), 'no se copió el motor');
});

step('ningún proyecto queda bloqueado antes de configurarse', () => {
  for (const [name, dir] of Object.entries(P)) {
    const r = guard(dir, path.join(dir, 'x.js'));
    assert(!r.blocked, `bloqueó ${name}, que no está configurado`);
  }
});

console.log('\nPASO 2 — resolver la identidad (el bug)\n');

step('el protocolo se niega a asignar mientras la identidad no esté resuelta', () => {
  cli(['project', 'set', '--mode', 'tasks', '--list-id', TABLERO.mensajeria.list.id, '--cwd', P.mensajeria], P.mensajeria);
  const out = cli(['context', '--cwd', P.mensajeria], P.mensajeria);
  assert(out.includes('No asignes nada'), 'no prohíbe asignar sin identidad');
});

step('"me" es rechazado como identidad, aunque sea lo que devuelve la API', () => {
  // `"me"` resuelve al dueño del token de la integración, no a quien ejecuta. Aceptarlo es el
  // bug: en equipo le asigna todas las tareas a la misma persona.
  let threw = false;
  try {
    cli(['identity', 'set', '--id', 'me']);
  } catch {
    threw = true;
  }
  assert(threw, 'aceptó "me"');
});

step('la identidad se guarda con el id numérico confirmado', () => {
  cli([
    'identity', 'set',
    '--id', TABLERO.tokenOwner,
    '--email', 'atorres@acme.example',
    '--name', 'Ana Torres',
    '--confirmed',
  ]);
  const out = cli(['identity', 'show']);
  assert(out.includes(TABLERO.tokenOwner), 'no guardó el id');
  assert(out.includes('confirmado       sí'), 'no quedó confirmada');
});

step('los emails de git del equipo quedan mapeados, y los deducidos sin confirmar', () => {
  cli([
    'team', 'add', '--git-email', 'ana.torres@example.net', '--clickup-id', TABLERO.tokenOwner,
    '--name', 'Ana Torres', '--confirmed',
  ]);
  // El segundo mapeo imita el caso incómodo real: coincide el apellido pero no el nombre de
  // pila, así que es una DEDUCCIÓN. Queda sin confirmar, y con eso no se asigna sin preguntar.
  const out = cli([
    'team', 'add', '--git-email', 'bsalas.dev@example.org', '--clickup-id', '5000000002',
    '--name', 'Bruno Salas',
  ]);
  assert(out.includes('SIN CONFIRMAR'), 'no advirtió que el mapeo es una deducción');
  const list = cli(['team', 'list']);
  assert(list.includes('SIN CONFIRMAR'), 'team list no marca el deducido');
});

console.log('\nPASO 3 — configurar tres proyectos, uno por cada modo\n');

step('mensajeria-api: tareas normales, con handoff', () => {
  cli(
    [
      'project', 'set',
      '--mode', 'tasks', '--name', 'mensajeria-api',
      '--workspace-id', TABLERO.workspace,
      '--space-id', TABLERO.space.id, '--space-name', TABLERO.space.name,
      '--folder-id', TABLERO.mensajeria.folder.id, '--folder-name', TABLERO.mensajeria.folder.name,
      '--list-id', TABLERO.mensajeria.list.id, '--list-name', TABLERO.mensajeria.list.name,
      '--handoff', 'true',
      '--status-todo', 'to do', '--status-in-progress', 'in progress',
      '--status-on-hold', 'on hold', '--status-handoff', 'update required',
      '--status-done', 'complete',
      '--available-statuses', TABLERO.statuses.join('|'),
      '--cwd', P.mensajeria,
    ],
    P.mensajeria,
  );
  const out = cli(['context', '--cwd', P.mensajeria], P.mensajeria);
  assert(out.includes('no se usa en este proyecto'), 'no debería tener paraguas');
  assert(out.includes('due_date` NO se usa'), 'debería prohibir due_date (default)');
  assert(out.includes('existe en el tablero'), 'no marca reviewed como no declarado');
});

step('db-gateway: paraguas + subtareas, fecha de fin en due_date', () => {
  for (const [label, dir] of [['backend', P.backend], ['frontend', P.frontend]]) {
    cli(
      [
        'project', 'set',
        '--mode', 'umbrella', '--name', `db-gateway-${label}`,
        '--workspace-id', TABLERO.workspace,
        '--space-id', TABLERO.space.id, '--space-name', TABLERO.space.name,
        '--folder-id', TABLERO.gateway.folder.id, '--folder-name', TABLERO.gateway.folder.name,
        '--list-id', TABLERO.gateway.list.id, '--list-name', TABLERO.gateway.list.name,
        '--umbrella-task-id', TABLERO.gateway.umbrella,
        '--handoff', 'true', '--naming', 'prefixed',
        '--end-date-field', 'due_date',
        '--status-todo', 'to do', '--status-in-progress', 'in progress',
        '--status-on-hold', 'on hold', '--status-handoff', 'update required',
        '--status-done', 'complete',
        '--available-statuses', TABLERO.statuses.join('|'),
        '--cwd', dir,
      ],
      dir,
    );
  }
  const out = cli(['context', '--cwd', P.backend], P.backend);
  assert(out.includes(TABLERO.gateway.umbrella), 'no trae el paraguas');
  assert(out.includes('parent:'), 'no exige parent');
  assert(out.includes('la fecha de fin va en `due_date`'), 'no aplicó el override');
});

step('los dos repos del gateway comparten lista y paraguas, a propósito', () => {
  const be = JSON.parse(cli(['project', 'show', '--cwd', P.backend], P.backend).split('\n').slice(1).join('\n'));
  const fe = JSON.parse(cli(['project', 'show', '--cwd', P.frontend], P.frontend).split('\n').slice(1).join('\n'));
  assert(be.list_id === fe.list_id, 'no comparten lista');
  assert(be.umbrella_task_id === fe.umbrella_task_id, 'no comparten paraguas');
});

step('el override de due_date NO se filtra a mensajeria', () => {
  const omni = cli(['context', '--cwd', P.mensajeria], P.mensajeria);
  assert(omni.includes('due_date` NO se usa'), 'se contaminó con el override del gateway');
});

step('dotfiles queda excluido, con motivo, y en silencio', () => {
  cli(['project', 'exclude', '--reason', 'repo personal, no es trabajo de equipo', '--cwd', P.personal], P.personal);
  const out = cli(['context', '--cwd', P.personal], P.personal);
  assert(out.includes('excluido'), 'no reporta la exclusión');
  assert(out.includes('no le preguntes al usuario'), 'volvería a preguntar');
  const r = guard(P.personal, path.join(P.personal, 'zshrc'));
  assert(!r.blocked, 'bloqueó un proyecto excluido');
});

console.log('\nPASO 4 — el ciclo de trabajo\n');

step('el candado frena la primera escritura', () => {
  const r = guard(P.mensajeria, path.join(P.mensajeria, 'app/main.py'));
  assert(r.blocked, 'no frenó');
  assert(r.why.includes(TABLERO.mensajeria.list.id), 'no dice en qué lista buscar');
});

step('reclamar desbloquea, y el recordatorio lo dice en cada turno', () => {
  cli(
    ['claim', '--task-id', '86abc0002', '--title', 'Corregir el guardado de adjuntos',
     '--role', 'backend', '--cwd', P.mensajeria],
    P.mensajeria,
  );
  const r = guard(P.mensajeria, path.join(P.mensajeria, 'app/main.py'));
  assert(!r.blocked, `siguió bloqueando: ${r.why}`);
  const ctx = cli(['context', '--cwd', P.mensajeria], P.mensajeria);
  assert(ctx.includes('TAREA RECLAMADA'), 'el contexto no refleja el claim');
  assert(ctx.includes('86abc0002'), 'no trae el id');
});

step('el claim es por proyecto: no desbloquea los otros', () => {
  const r = guard(P.backend, path.join(P.backend, 'src/api.py'));
  assert(r.blocked, 'el claim de mensajeria desbloqueó el gateway');
});

step('cerrar vuelve a activar el candado', () => {
  cli(['release', '--cwd', P.mensajeria], P.mensajeria);
  const r = guard(P.mensajeria, path.join(P.mensajeria, 'app/main.py'));
  assert(r.blocked, 'no volvió a frenar después de cerrar');
});

step('un trabajo que no amerita tarea se declara y se puede escribir', () => {
  cli(['exempt', '--reason', 'typo en un comentario', '--cwd', P.mensajeria], P.mensajeria);
  const r = guard(P.mensajeria, path.join(P.mensajeria, 'app/main.py'));
  assert(!r.blocked, 'no dejó pasar con exención vigente');
});

console.log('\nPASO 5 — cierre\n');

step('doctor no reporta problemas con todo configurado', () => {
  const out = cli(['doctor']);
  assert(out.includes('3/3'), 'no ve los hooks');
  assert(out.includes('Todo en orden'), `reporta problemas:\n${out}`);
  assert(!out.includes('estados sin confirmar'), 'quedaron proyectos sin estados');
});

step('project list muestra los cuatro proyectos con su modo', () => {
  const out = cli(['project', 'list']);
  assert(out.includes('tasks'), 'falta el de tareas normales');
  assert(out.includes('umbrella'), 'falta el de paraguas');
  assert(out.includes('excluido'), 'falta el excluido');
  assert((out.match(/umbrella/g) || []).length >= 2, 'faltan los dos repos del gateway');
});

step('el config.json quedó legible y con todo dentro', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(fakeClaude, 'clickup-flow', 'config.json'), 'utf8'));
  assert(Object.keys(cfg.projects).length === 4, 'no quedaron los cuatro proyectos');
  assert(cfg.identity.confirmed === true, 'la identidad no quedó confirmada');
  assert(Object.keys(cfg.team).length === 2, 'no quedó el mapeo del equipo');
  assert(cfg.team['bsalas.dev@example.org'].confirmed === false, 'ascendió un mapeo deducido');
});

step('los emails de git que fallan contra ClickUp están documentados en el protocolo', () => {
  // No es cosmético: si el protocolo no dice que el email de git no resuelve, el agente lo va a
  // intentar y va a mandar [null] como asignados.
  const out = cli(['context', '--cwd', P.mensajeria], P.mensajeria);
  assert(out.includes('devuelve `null`'), 'no advierte que resolver por email devuelve null');
  assert(out.includes('"me"'), 'no menciona el problema de "me"');
});

console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
if (fail) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
  console.log(`\nsandbox conservado: ${sandbox}\n`);
  process.exit(1);
}
fs.rmSync(sandbox, { recursive: true, force: true });
console.log('Flujo completo verde.\n');

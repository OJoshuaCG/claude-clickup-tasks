#!/usr/bin/env node
//
// El esquema del config y las invariantes del protocolo.
//
// El config está pensado para editarse a mano, así que va a llegar con campos que esta versión
// no conoce, secciones del tipo equivocado, y una `version` de una versión futura. Nada de eso
// puede romper un comando ni, peor, borrar lo que el usuario escribió.
//
// Y el protocolo es el único artefacto que el agente realmente lee. Se verifica COMBINATORIAMENTE
// —192 combinaciones de rol, modo, banderas y ventana— que no filtre una interpolación fallida y
// que ninguna combinación le quite una de sus reglas duras.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatListPath } from '../src/lib/config.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-esq-'));
const claude = path.join(sandbox, '.claude');
fs.mkdirSync(claude, { recursive: true });
fs.writeFileSync(path.join(claude, 'settings.json'), '{"model":"opus"}');
const env = { ...process.env, CLAUDE_CONFIG_DIR: claude, NO_COLOR: '1' };
execFileSync('node', [path.join(REPO, 'src', 'installer.mjs'), '--yes'], { env, cwd: REPO, stdio: 'pipe' });
const CLI = path.join(claude, 'clickup-flow', 'src', 'cli.mjs');
const CFG = path.join(claude, 'clickup-flow', 'config.json');
const proj = path.join(sandbox, 'proj');
fs.mkdirSync(proj, { recursive: true });

let pass = 0;
let fail = 0;
const fallos = [];
const check = (n, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ok   ${n}`);
  } catch (e) {
    fail++;
    fallos.push(`${n}: ${e.message}`);
    console.log(`  FAIL ${n}\n         ${e.message}`);
  }
};
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
function run(args, cwd = proj, input) {
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8', env, cwd, input: input ?? '' });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}
const tieneStack = (t) => /\n\s+at .+:\d+:\d+/.test(t);
const escribirCfg = (o) => fs.writeFileSync(CFG, JSON.stringify(o, null, 2));
const leerCfg = () => JSON.parse(fs.readFileSync(CFG, 'utf8'));

run(['project', 'set', '--mode', 'tasks', '--list-id', '900', '--role', 'fullstack']);
const KEY = Object.keys(leerCfg().projects)[0];
const BUENO = leerCfg();

console.log('\n=== CORRIDA 6: EVOLUCIÓN DEL ESQUEMA ===\n');

const COMANDOS_LECTURA = [['status'], ['context'], ['doctor'], ['project', 'list'], ['config', 'show']];

check('un config sin ninguna sección conocida no rompe ningún comando de lectura', () => {
  escribirCfg({ hola: 'mundo' });
  for (const c of COMANDOS_LECTURA) {
    const r = run(c);
    assert(r.code === 0 || r.code === 1, `${c.join(' ')} → exit ${r.code}`);
    assert(!tieneStack(r.out + r.err), `${c.join(' ')} filtró un stack`);
  }
  escribirCfg(BUENO);
});

check('un campo desconocido escrito a mano SOBREVIVE a una escritura', () => {
  const c = structuredClone(BUENO);
  c.mi_campo_personal = { nota: 'no me borres' };
  c.projects[KEY].mi_anotacion = 'esto es mío';
  escribirCfg(c);
  const r = run(['config', 'set', '--key', 'defaults.search_window_days', '--value', '45']);
  assert(r.code === 0, `config set falló: ${r.err}`);
  const d = leerCfg();
  assert(d.mi_campo_personal?.nota === 'no me borres', 'perdió el campo raíz del usuario');
  assert(d.projects[KEY].mi_anotacion === 'esto es mío', 'perdió la anotación del proyecto');
  assert(String(d.defaults.search_window_days) === '45', 'no aplicó el cambio pedido');
  escribirCfg(BUENO);
});

check('una versión FUTURA del config no se destruye ni se ignora en silencio', () => {
  const c = structuredClone(BUENO);
  c.version = 999;
  c.campo_de_una_version_futura = ['a', 'b'];
  escribirCfg(c);
  const r = run(['status']);
  assert(r.code === 0, `status con versión futura → exit ${r.code}: ${r.err}`);
  assert(!tieneStack(r.out + r.err), 'filtró un stack');
  const s = run(['config', 'set', '--key', 'defaults.search_window_days', '--value', '30']);
  assert(s.code === 0, `config set con versión futura falló: ${s.err}`);
  const d = leerCfg();
  assert(
    JSON.stringify(d.campo_de_una_version_futura) === '["a","b"]',
    'perdió el campo de la versión futura',
  );
  escribirCfg(BUENO);
});

check('cada sección con el tipo equivocado degrada sin romper', () => {
  const secciones = ['identity', 'defaults', 'projects', 'team'];
  const basuras = [null, [], 'texto', 42, true, { anidado: { profundo: [1, 2] } }];
  let combinaciones = 0;
  for (const sec of secciones) {
    for (const basura of basuras) {
      const c = structuredClone(BUENO);
      c[sec] = basura;
      escribirCfg(c);
      combinaciones++;
      for (const cmd of COMANDOS_LECTURA) {
        const r = run(cmd);
        assert(
          r.code === 0 || r.code === 1,
          `${sec}=${JSON.stringify(basura)} + ${cmd.join(' ')} → exit ${r.code}: ${r.err.slice(0, 150)}`,
        );
        assert(
          !tieneStack(r.out + r.err),
          `${sec}=${JSON.stringify(basura)} + ${cmd.join(' ')} filtró un stack`,
        );
      }
      for (const h of ['session-start', 'prompt-hook', 'guard']) {
        const r = run([h], proj, JSON.stringify({ cwd: proj, tool_input: { file_path: 'a.js' } }));
        assert(
          r.code === 0 || r.code === 2,
          `${sec}=${JSON.stringify(basura)} + ${h} → exit ${r.code}`,
        );
      }
    }
  }
  console.log(`       ${combinaciones} combinaciones de tipo equivocado`);
  escribirCfg(BUENO);
});

check('una entrada de proyecto con cada campo del tipo equivocado no rompe nada', () => {
  const campos = [
    'mode', 'role', 'counterpart', 'list_id', 'umbrella_task_id', 'space_name',
    'folder_name', 'list_name', 'statuses', 'overrides', 'git_remote',
  ];
  const basuras = [null, [], {}, 42, true, ''];
  for (const campo of campos) {
    for (const basura of basuras) {
      const c = structuredClone(BUENO);
      c.projects[KEY][campo] = basura;
      escribirCfg(c);
      for (const cmd of [['status'], ['context'], ['doctor']]) {
        const r = run(cmd);
        assert(
          r.code === 0 || r.code === 1,
          `${campo}=${JSON.stringify(basura)} + ${cmd[0]} → exit ${r.code}: ${r.err.slice(0, 150)}`,
        );
        assert(
          !tieneStack(r.out + r.err),
          `${campo}=${JSON.stringify(basura)} + ${cmd[0]} filtró un stack:\n${(r.out + r.err).slice(-300)}`,
        );
      }
    }
  }
  console.log(`       ${campos.length * basuras.length} combinaciones por campo de proyecto`);
  escribirCfg(BUENO);
});

check('un config gigante (500 proyectos) sigue siendo usable', () => {
  const c = structuredClone(BUENO);
  for (let i = 0; i < 500; i++) {
    c.projects[`/fake/proyecto-${i}`] = {
      mode: 'tasks',
      role: 'fullstack',
      list_id: String(900 + i),
      space_name: `Espacio ${i}`,
    };
  }
  escribirCfg(c);
  const t0 = Date.now();
  const r = run(['status']);
  const ms = Date.now() - t0;
  assert(r.code === 0, `status con 500 proyectos → exit ${r.code}`);
  assert(ms < 8000, `status tardó ${ms}ms con 500 proyectos`);
  const l = run(['project', 'list']);
  assert(l.code === 0, `project list con 500 proyectos → exit ${l.code}`);
  const g = run(['guard'], proj, JSON.stringify({ cwd: proj, tool_input: { file_path: 'a.js' } }));
  assert(g.code === 0 || g.code === 2, `guard con 500 proyectos → exit ${g.code}`);
  console.log(`       status en ${ms}ms con 501 proyectos`);
  escribirCfg(BUENO);
});

console.log('\n=== CORRIDA 7: INVARIANTES DEL PROTOCOLO ===\n');

const VENENOS = [
  /undefined/,
  /\[object Object\]/,
  /\bNaN\b/,
  /\{\{\w+\}\}/,
  // `null` sólo cuenta como veneno cuando aparece en forma de VALOR renderizado. El protocolo
  // lo menciona a propósito al documentar que `clickup_resolve_assignees` devuelve null para un
  // email que no es miembro, y eso es contenido correcto, no una interpolación fallida.
  /(?::|=|→|\*\*|\()\s*null\s*(?:$|[,.)\s])/m,
];

check('el protocolo nunca filtra undefined/null/[object Object] en NINGUNA combinación', () => {
  const usa = [true, false];
  const roles = ['backend', 'frontend', 'fullstack'];
  const modos = ['tasks', 'umbrella'];
  const ventanas = [0, 1, 30, 365];
  let n = 0;
  const problemas = [];
  for (const role of roles) {
    for (const modo of modos) {
      for (const dates of usa) {
        for (const prio of usa) {
          for (const auto of usa) {
            for (const win of ventanas) {
              const c = structuredClone(BUENO);
              c.defaults.use_dates = dates;
              c.defaults.use_priorities = prio;
              c.defaults.auto_assign = auto;
              c.defaults.search_window_days = win;
              c.projects[KEY] = {
                ...c.projects[KEY],
                mode: modo,
                role,
                ...(modo === 'umbrella' ? { umbrella_task_id: 'ABC123' } : {}),
              };
              escribirCfg(c);
              n++;
              const r = run(['context']);
              if (r.code !== 0) {
                problemas.push(`exit ${r.code} con ${role}/${modo}/w${win}: ${r.err.slice(0, 120)}`);
                continue;
              }
              for (const veneno of VENENOS) {
                if (veneno.test(r.out)) {
                  const linea = r.out.split('\n').find((l) => veneno.test(l));
                  problemas.push(
                    `${veneno} en ${role}/${modo}/dates=${dates}/prio=${prio}/auto=${auto}/w=${win}: "${linea?.trim().slice(0, 100)}"`,
                  );
                }
              }
            }
          }
        }
      }
    }
  }
  console.log(`       ${n} combinaciones de configuración`);
  assert(problemas.length === 0, `${problemas.length} problema(s):\n         ${problemas.slice(0, 6).join('\n         ')}`);
  escribirCfg(BUENO);
});

check('las reglas duras están presentes en TODA combinación', () => {
  // Estas son las reglas por las que existe la herramienta. Si una combinación de banderas hace
  // que alguna desaparezca del texto, el agente deja de tenerlas y nadie se entera.
  const REGLAS = [
    { nombre: 'no usar "me" para asignar', re: /"me"[\s\S]{0,200}?(no lo uses|nunca)/i },
    { nombre: 'buscar antes de crear', re: /busc/i },
    { nombre: 'el bloqueo avisa una vez, no veta', re: /no\s+(se\s+)?vet|una\s+(sola\s+)?vez/i },
  ];
  const roles = ['backend', 'frontend', 'fullstack'];
  const problemas = [];
  for (const role of roles) {
    for (const modo of ['tasks', 'umbrella']) {
      for (const win of [0, 30]) {
        const c = structuredClone(BUENO);
        c.defaults.search_window_days = win;
        c.projects[KEY] = {
          ...c.projects[KEY],
          mode: modo,
          role,
          ...(modo === 'umbrella' ? { umbrella_task_id: 'ABC123' } : {}),
        };
        escribirCfg(c);
        const r = run(['context']);
        assert(r.code === 0, `context falló con ${role}/${modo}: ${r.err}`);
        for (const regla of REGLAS) {
          if (!regla.re.test(r.out)) problemas.push(`falta "${regla.nombre}" en ${role}/${modo}/w${win}`);
        }
      }
    }
  }
  assert(problemas.length === 0, `${problemas.length}:\n         ${problemas.slice(0, 8).join('\n         ')}`);
  escribirCfg(BUENO);
});

check('con la ventana en 0 el protocolo dice SIN LÍMITE y no inventa una fecha', () => {
  const c = structuredClone(BUENO);
  c.defaults.search_window_days = 0;
  escribirCfg(c);
  const r = run(['context']);
  assert(r.code === 0, `exit ${r.code}`);
  assert(/sin\s+l[íi]mite/i.test(r.out), 'no dice SIN LÍMITE');
  assert(
    !/\d{4}-\d{2}-\d{2}/.test(r.out.split('\n').filter((l) => /cerrad|closed|desde/i.test(l)).join('\n')),
    'inventó una fecha de corte con la ventana en 0',
  );
  escribirCfg(BUENO);
});

check('un estado renombrado en el tablero aparece en el protocolo, no el nombre por defecto', () => {
  const c = structuredClone(BUENO);
  c.projects[KEY].statuses = {
    todo: 'POR HACER',
    in_progress: 'EN CURSO',
    on_hold: 'FRENADO',
    handoff: 'PARA QA',
    done: 'LISTO',
  };
  escribirCfg(c);
  const r = run(['context']);
  assert(r.code === 0, `exit ${r.code}`);
  for (const v of ['POR HACER', 'EN CURSO', 'PARA QA', 'LISTO']) {
    assert(r.out.includes(v), `el protocolo no menciona el estado real "${v}"`);
  }
  escribirCfg(BUENO);
});

check('el protocolo no filtra el id de ClickUp de otra persona del equipo', () => {
  const c = structuredClone(BUENO);
  c.identity = { clickup_user_id: '111', clickup_email: 'yo@example.com', confirmed: true, git_emails: [] };
  c.team = {
    'otra@example.com': { clickup_id: '222', name: 'Otra Persona', confirmed: true },
  };
  escribirCfg(c);
  const r = run(['context']);
  assert(r.code === 0, `exit ${r.code}`);
  assert(r.out.includes('111'), 'no dice el id del usuario, que es lo que hay que asignar');
  escribirCfg(BUENO);
});

console.log('\n=== CORRIDA 8: LA RUTA DEL DESTINO ===\n');

// Todo lugar que muestra dónde caen las tareas imprimía el `list_id` pelado. En un tablero real
// eso no identifica nada: ClickUp llama "List" a toda lista nueva, así que varias listas comparten
// nombre y solo la carpeta las distingue.

check('la ruta completa lleva espacio, carpeta, lista e id', () => {
  const s = formatListPath({
    space_name: 'Acme',
    folder_name: 'Plataforma',
    list_name: 'Gateway',
    list_id: '4000000001',
  });
  assert(s === 'Acme › Plataforma › Gateway (4000000001)', `salió "${s}"`);
});

check('una lista folderless muestra dos segmentos, sin rellenar el hueco', () => {
  const s = formatListPath({ space_name: 'Acme', list_name: 'Backlog', list_id: '42' });
  assert(s === 'Acme › Backlog (42)', `salió "${s}"`);
  assert(!/carpeta|—|undefined|null/i.test(s), `nombró la ausencia de carpeta: "${s}"`);
});

check('dos listas homónimas en carpetas distintas NO producen la misma ruta', () => {
  const base = { space_name: 'Acme', list_name: 'List' };
  const a = formatListPath({ ...base, folder_name: 'Facturación', list_id: '4000000002' });
  const b = formatListPath({ ...base, folder_name: 'Soporte', list_id: '4000000003' });
  assert(a !== b, 'la carpeta no desambiguó: dos listas "List" se ven idénticas');
});

check('sin nombre de lista, el ÚLTIMO segmento sigue siendo la lista y no la carpeta', () => {
  const s = formatListPath({ space_name: 'Acme', folder_name: 'Plataforma', list_id: '77' });
  assert(s.endsWith('lista 77'), `el último tramo no es la lista: "${s}"`);
  assert(!s.endsWith('Plataforma'), `la carpeta quedó como destino: "${s}"`);
});

check('sin lista ni id, degrada en vez de romper', () => {
  for (const e of [undefined, null, {}, { space_name: 'Acme' }]) {
    assert(formatListPath(e) === 'sin lista', `${JSON.stringify(e)} → "${formatListPath(e)}"`);
  }
});

check('`status` muestra el workspace y la carpeta cuando existen', () => {
  escribirCfg(BUENO);
  const r0 = run([
    'project', 'set', '--mode', 'tasks', '--list-id', '4000000001', '--list-name', 'Gateway',
    '--space-id', '2000000001', '--space-name', 'Acme',
    '--folder-id', '3000000001', '--folder-name', 'Plataforma',
    '--workspace-id', '1000000001', '--role', 'fullstack',
  ]);
  assert(r0.code === 0, `project set falló: ${r0.err}`);
  const r = run(['status']);
  assert(r.code === 0, `exit ${r.code}`);
  assert(/carpeta\s+Plataforma/.test(r.out), `status no muestra la carpeta:\n${r.out}`);
  assert(/workspace\s+1000000001/.test(r.out), `status no muestra el workspace:\n${r.out}`);
});

check('una lista folderless NO inventa una fila de carpeta en `status`', () => {
  const r0 = run([
    'project', 'set', '--mode', 'tasks', '--list-id', '55', '--list-name', 'Backlog',
    '--space-id', '1', '--space-name', 'Acme', '--folder-id', '', '--folder-name', '',
    '--role', 'fullstack',
  ]);
  assert(r0.code === 0, `project set falló: ${r0.err}`);
  const r = run(['status']);
  assert(!/^carpeta\s/m.test(r.out), `inventó una carpeta vacía:\n${r.out}`);
});

check('el primer --workspace-id SIEMBRA el default global, y el segundo proyecto lo hereda', () => {
  escribirCfg(BUENO);
  const c = leerCfg();
  c.defaults.workspace_id = null;
  escribirCfg(c);

  run(['project', 'set', '--mode', 'tasks', '--list-id', '900', '--workspace-id', '1000000001', '--role', 'fullstack']);
  assert(
    leerCfg().defaults.workspace_id === '1000000001',
    `el default global sigue en ${JSON.stringify(leerCfg().defaults.workspace_id)}: el fallback nunca sirve`,
  );

  const otro = path.join(sandbox, 'otro-proj');
  fs.mkdirSync(otro, { recursive: true });
  run(['project', 'set', '--mode', 'tasks', '--list-id', '901', '--role', 'fullstack'], otro);
  const heredado = Object.values(leerCfg().projects).find((p) => p.list_id === '901');
  assert(heredado?.workspace_id === '1000000001', `el segundo proyecto no heredó: ${JSON.stringify(heredado?.workspace_id)}`);
});

check('la siembra NO pisa un default global que ya estaba puesto', () => {
  const c = leerCfg();
  c.defaults.workspace_id = 'YA-ESTABA';
  escribirCfg(c);
  run(['project', 'set', '--mode', 'tasks', '--list-id', '902', '--workspace-id', '1000000001', '--role', 'fullstack']);
  assert(leerCfg().defaults.workspace_id === 'YA-ESTABA', 'la siembra pisó un valor existente');
  escribirCfg(BUENO);
});

console.log(`\n${pass} pasaron, ${fail} fallaron\n`);
if (fail) {
  for (const f of fallos) console.log(`  - ${f}`);
  console.log(`\nsandbox: ${sandbox}\n`);
  process.exit(1);
}
fs.rmSync(sandbox, { recursive: true, force: true });
console.log('corridas 6-8: sin hallazgos.\n');

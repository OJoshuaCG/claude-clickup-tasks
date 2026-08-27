// Detección de configuración vieja del protocolo dentro de un proyecto.
//
// Por qué existe: esta herramienta reemplaza un protocolo que vivía DENTRO de cada repositorio
// (skill, comando, hooks y estado local). Mientras esa copia siga ahí, hay dos protocolos
// cargados al mismo tiempo — y no dan la misma respuesta: uno asigna con `"me"` (el bug) y el
// otro con el id numérico; uno escribe la fecha de fin en `due_date` y el otro lo prohíbe.
//
// Y hay algo peor que la simple duplicación: las skills de proyecto **ganan** sobre las
// globales, y al menos uno de los CLAUDE.md originales lo dice con todas las letras
// ("si hay otra skill de ClickUp cargada, gana esta"). Así que sin limpiar, el que gana es el
// viejo. Instalar sin migrar no deja las cosas "un poco desordenadas": deja el bug activo.
//
// ESTE MÓDULO NO BORRA NADA. Detecta, explica y devuelve los comandos exactos. Borrar archivos
// del repo de alguien es su decisión, no la de un instalador.

import fs from 'node:fs';
import path from 'node:path';

/** Nombres de skill que usaba el protocolo anterior. */
const OLD_SKILLS = ['clickup-task-flow', 'clickup-task-flow-frontend'];
const OLD_HOOKS = ['recordar-protocolo.sh', 'bloquear-sin-tarea.sh'];
const OLD_STATE = ['.tarea-actual', '.sin-tarea'];

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Escanea un proyecto y devuelve los hallazgos.
 *
 * Cada hallazgo trae `severity`:
 *   'conflict' — dos protocolos compitiendo. Es lo que reactiva el bug de asignación.
 *   'stale'    — restos sin efecto real, pero ensucian.
 *   'import'   — datos que conviene traer a la configuración nueva.
 */
export function scanProject(dir) {
  const findings = [];
  // Es una función exportada: no puede confiar en que quien la llame ya normalizó la ruta.
  // `path.join(null, …)` tira un TypeError, y acá eso mataría el comando de migración entero.
  if (typeof dir !== 'string' || !dir.trim()) return findings;
  const claudeDir = path.join(dir, '.claude');

  // ---- skills del repo: el conflicto grave ---------------------------------------------------
  for (const name of OLD_SKILLS) {
    const skillDir = path.join(claudeDir, 'skills', name);
    if (exists(skillDir)) {
      findings.push({
        severity: 'conflict',
        what: `skill del repo \`${name}\``,
        where: skillDir,
        why:
          'Las skills de proyecto GANAN sobre las globales. Mientras esté acá, el protocolo que ' +
          'se aplica es el viejo — incluido el uso de `"me"` para asignar, que es justo el bug ' +
          'que la herramienta nueva elimina.',
        fix: `rm -rf "${skillDir}"`,
      });
    }
  }

  // ---- comando del repo ---------------------------------------------------------------------
  const oldCommand = path.join(claudeDir, 'commands', 'tarea.md');
  if (exists(oldCommand)) {
    findings.push({
      severity: 'conflict',
      what: '`/tarea` del repo',
      where: oldCommand,
      why:
        'Los comandos de proyecto tapan a los globales. El del repo apunta a la skill vieja y a ' +
        'coordenadas escritas a mano.',
      fix: `rm -f "${oldCommand}"`,
    });
  }

  // ---- hooks del repo -----------------------------------------------------------------------
  for (const name of OLD_HOOKS) {
    const hook = path.join(claudeDir, 'hooks', name);
    if (exists(hook)) {
      findings.push({
        severity: 'conflict',
        what: `hook \`${name}\``,
        where: hook,
        why:
          name === 'bloquear-sin-tarea.sh'
            ? 'Es un segundo candado, con su propio estado en `.claude/.tarea-actual`. Con los dos ' +
              'activos hay que reclamar la tarea dos veces, en dos lugares, para poder escribir.'
            : 'Inyecta el recordatorio viejo en cada turno, además del nuevo.',
        fix: `rm -f "${hook}"`,
      });
    }
  }

  // ---- settings.json del repo ---------------------------------------------------------------
  const projSettings = path.join(claudeDir, 'settings.json');
  if (exists(projSettings)) {
    const parsed = readJsonSafe(projSettings);
    if (parsed === null) {
      findings.push({
        severity: 'stale',
        what: '`.claude/settings.json` del repo no se pudo leer',
        where: projSettings,
        why: 'No se puede revisar si registra los hooks viejos.',
        fix: 'Revisalo a mano.',
      });
    } else {
      const flat = JSON.stringify(parsed.hooks ?? {});
      const referenced = OLD_HOOKS.filter((h) => flat.includes(h));
      if (referenced.length) {
        findings.push({
          severity: 'conflict',
          what: `hooks viejos registrados en el settings.json del repo (${referenced.join(', ')})`,
          where: projSettings,
          why:
            'El harness los va a seguir ejecutando aunque borres los scripts, y ahí van a fallar ' +
            'en cada turno.',
          fix:
            'Editalo a mano: borrá SOLO las entradas de `hooks` que nombran esos scripts. ' +
            'NO toques el resto del archivo — puede tener `permissions` que no tienen nada que ' +
            'ver con esto.',
          manual: true,
        });
      }
    }
  }

  // ---- estado local -------------------------------------------------------------------------
  for (const name of OLD_STATE) {
    const file = path.join(claudeDir, name);
    if (exists(file)) {
      let content = '';
      try {
        content = fs.readFileSync(file, 'utf8').trim().slice(0, 120);
      } catch {
        /* el contenido es informativo, no crítico */
      }
      findings.push({
        severity: 'stale',
        what: `estado local \`.claude/${name}\`${content ? ` — "${content}"` : ''}`,
        where: file,
        why:
          'La herramienta nueva guarda esto fuera del repo. Este archivo ya no se lee, pero si ' +
          'quedó un claim abierto conviene cerrar esa tarea en ClickUp antes de borrarlo.',
        fix: `rm -f "${file}"`,
      });
    }
  }

  // ---- mapeo de usuarios: esto SÍ conviene importar -----------------------------------------
  const usersFile = path.join(claudeDir, 'clickup-usuarios.json');
  if (exists(usersFile)) {
    const parsed = readJsonSafe(usersFile);
    // Objeto plano, no solo `typeof object`: un `usuarios: [{...}]` daría entradas de equipo
    // llamadas "0", "1"… en vez de por email.
    const u = parsed?.usuarios;
    const users = u !== null && typeof u === 'object' && !Array.isArray(u) ? u : null;
    findings.push({
      severity: 'import',
      what: `mapeo de usuarios \`.claude/clickup-usuarios.json\`${users ? ` (${Object.keys(users).length} entradas)` : ''}`,
      where: usersFile,
      why:
        'Es identidad del equipo y vale la pena traerla: son los mapeos email de git → id de ' +
        'ClickUp que ya alguien validó a mano.',
      fix: 'clickup-flow migrate --import-users   (importa y NO borra el archivo)',
      users,
    });
  }

  // ---- CLAUDE.md ----------------------------------------------------------------------------
  for (const name of ['CLAUDE.md', 'claude.md']) {
    const file = path.join(dir, name);
    if (!exists(file)) continue;
    let body = '';
    try {
      body = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const mentionsOldSkill = OLD_SKILLS.some((s) => body.includes(s));
    // El patrón que hace que el protocolo viejo gane incluso después de borrar archivos.
    const claimsPriority =
      /gana\s+esta|manda\s+en\s+este\s+repositorio|tiene\s+prioridad\s+sobre/i.test(body) &&
      /clickup/i.test(body);

    if (mentionsOldSkill || claimsPriority) {
      findings.push({
        severity: 'conflict',
        what: `\`${name}\` describe el protocolo viejo`,
        where: file,
        why: claimsPriority
          ? 'Y además declara que la skill del repo TIENE PRIORIDAD sobre cualquier skill global ' +
            'de ClickUp. Esa frase sola alcanza para que el agente siga el protocolo viejo aunque ' +
            'ya hayas borrado los archivos.'
          : 'Nombra la skill vieja y sus comandos, así que el agente va a intentar cargarla.',
        fix:
          'Editá a mano la sección de gestión de tareas: quitá la referencia a la skill del repo ' +
          'y la declaración de prioridad. Si querés, reemplazala por el bloque corto que ofrece ' +
          '`/clickup-setup`. **No reescribas el resto del archivo.**',
        manual: true,
      });
    }

    if (/\.claude\/\.tarea-actual|\.claude\/\.sin-tarea/.test(body)) {
      findings.push({
        severity: 'stale',
        what: `\`${name}\` documenta el estado local viejo`,
        where: file,
        why: 'Esos archivos ya no existen; el estado vive fuera del repo.',
        fix: 'Actualizá esa parte cuando edites la sección de tareas.',
        manual: true,
      });
    }
  }

  // ---- TODO.md: se queda ---------------------------------------------------------------------
  for (const name of ['TODO.md']) {
    if (exists(path.join(dir, name))) {
      findings.push({
        severity: 'keep',
        what: `\`${name}\``,
        where: path.join(dir, name),
        why:
          'La herramienta nueva NO lo toca ni lo reemplaza: sigue siendo tu espejo del detalle. ' +
          'No hay nada que migrar acá.',
        fix: null,
      });
    }
  }

  return findings;
}

/**
 * Convierte un `clickup-usuarios.json` en entradas de `team`.
 *
 * Conserva `confirmado` tal cual venía. Ascender a confirmado un mapeo que alguien dejó
 * explícitamente marcado como deducido sería destruir la única advertencia que protege de
 * asignarle trabajo a la persona equivocada.
 */
export function importUsers(config, users) {
  const added = [];
  const skipped = [];
  const conflicts = [];
  config.team = config.team || {};

  // La guardia va acá también, no solo en `scanProject`.
  //
  // Es una función exportada: `Object.entries([{...},{...}])` recorre el array y deja las claves
  // "0", "1"… así que un `usuarios` que es array crearía entradas de equipo con clave numérica en
  // vez de por email. Por el CLI no se puede llegar —`scanProject` ya lo filtra— pero depender de
  // que el único llamador filtre es exactamente cómo una función correcta se vuelve incorrecta al
  // aparecer un segundo llamador.
  if (users === null || typeof users !== 'object' || Array.isArray(users)) {
    return { added, skipped, conflicts };
  }

  for (const [gitEmail, data] of Object.entries(users)) {
    if (!gitEmail || gitEmail.startsWith('_')) continue; // `_lee_esto` y otras notas del archivo
    const id = data?.clickup_id;
    if (!id || !/^\d+$/.test(String(id))) {
      skipped.push({ gitEmail, why: 'sin id numérico' });
      continue;
    }

    const key = gitEmail.trim().toLowerCase();
    const already = config.team[key];
    const incoming = {
      clickup_id: String(id),
      name: data.nombre ?? data.name ?? null,
      clickup_email: data.clickup_email ?? null,
      confirmed: data.confirmado === true || data.confirmed === true,
      note: data.nota ?? data.note ?? null,
    };

    // Dos ids distintos para el mismo email de git no se resuelven acá: uno de los dos está mal,
    // y elegir por nuestra cuenta es asignarle trabajo a la persona equivocada en silencio.
    if (already && already.clickup_id && already.clickup_id !== incoming.clickup_id) {
      conflicts.push({ gitEmail: key, existing: already.clickup_id, incoming: incoming.clickup_id });
      continue;
    }

    // Mismo id: se enriquece lo que falte en vez de saltear. La entrada del archivo suele traer
    // la NOTA que explica por qué un mapeo no está confirmado, y esa nota es justamente la
    // advertencia que evita una asignación equivocada — perderla sería el peor resultado posible.
    const merged = {
      clickup_id: incoming.clickup_id,
      name: already?.name ?? incoming.name,
      clickup_email: already?.clickup_email ?? incoming.clickup_email,
      // AND, no OR: `confirmed` es una bandera de seguridad. Si alguna de las dos fuentes dice
      // "esto no está validado", el resultado es "no está validado". Nunca se promueve solo.
      confirmed: (already ? already.confirmed === true : true) && incoming.confirmed,
      note: already?.note ?? incoming.note,
      imported_from: 'clickup-usuarios.json',
      added_at: already?.added_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const enriched = Boolean(already);
    const demoted = Boolean(already?.confirmed === true && !merged.confirmed);
    config.team[key] = merged;
    added.push({
      gitEmail: key,
      id: merged.clickup_id,
      confirmed: merged.confirmed,
      enriched,
      demoted,
    });
  }

  return { added, skipped, conflicts };
}

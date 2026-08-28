// Detección de escrituras a disco dentro de un comando de shell.
//
// POR QUÉ EXISTE ESTE ARCHIVO
//
// El candado del protocolo vivía en un `PreToolUse` con matcher `Edit|Write|MultiEdit|
// NotebookEdit`. Bash no estaba en la lista, así que `cat > archivo <<EOF`, `sed -i`, `tee`,
// `git apply` y `python -c` pasaban de largo. Y no es un escenario rebuscado: el modo
// `bypassPermissions` le INSTRUYE al agente que prefiera `sed`, heredocs y scripts cortos por
// encima de Edit/Write. O sea, en la configuración donde la herramienta está instalada, el
// candado estaba apagado la mayor parte del tiempo.
//
// Un candado evadible que se presenta como garantía es peor que no tener candado: produce
// confianza falsa. Alguien asume que el tablero refleja el trabajo, y no lo refleja.
//
// EL COMPROMISO QUE GOBIERNA TODO ACÁ
//
// Este módulo corre en un hook que puede BLOQUEAR el trabajo del usuario, en cada repo de la
// máquina. Los dos errores no cuestan lo mismo:
//
//   * Un falso NEGATIVO (no detecto una escritura) degrada al comportamiento de hoy.
//   * Un falso POSITIVO (bloqueo un `ls`) rompe una sesión y hace que el usuario desinstale.
//
// Por eso el detector es CONSERVADOR: solo reporta lo que reconoce explícitamente, nunca
// adivina, y todo lo que no entiende sale como "no escribe". Un `>` dentro de comillas no es
// una redirección, un `2>&1` no es un archivo, y `echo x > /dev/null` no toca el disco.

import path from 'node:path';

// ---------------------------------------------------------------------------------------------
// Tokenizador
// ---------------------------------------------------------------------------------------------

/**
 * Parte un comando en tokens conscientes de comillas, con los operadores como tokens propios.
 *
 * No es un parser de shell completo y no pretende serlo — sustitución de comandos, expansión de
 * variables y globs quedan como texto literal. Lo único que tiene que hacer bien es no confundir
 * un `>` literal dentro de un string con una redirección, porque ESE es el falso positivo que
 * bloquearía un `echo "a > b"`.
 */
export function tokenize(command) {
  const src = String(command ?? '');
  const out = [];
  let cur = '';
  let hadQuote = false;
  let started = false;

  const flush = () => {
    if (started) out.push({ text: cur, op: false, quoted: hadQuote });
    cur = '';
    hadQuote = false;
    started = false;
  };
  const pushOp = (text) => {
    flush();
    out.push({ text, op: true, quoted: false });
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];

    // Escape: el carácter siguiente es literal, incluso si es `>` o una comilla.
    if (c === '\\') {
      cur += src[i + 1] ?? '';
      started = true;
      i += 2;
      continue;
    }

    // Comillas simples: TODO adentro es literal, ni siquiera el backslash escapa.
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end === -1 ? src.length : end;
      cur += src.slice(i + 1, stop);
      hadQuote = true;
      started = true;
      i = stop + 1;
      continue;
    }

    // Comillas dobles: el backslash sí escapa adentro.
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          cur += src[j + 1] ?? '';
          j += 2;
          continue;
        }
        cur += src[j];
        j++;
      }
      hadQuote = true;
      started = true;
      i = j + 1;
      continue;
    }

    if (c === ' ' || c === '\t' || c === '\r') {
      flush();
      i++;
      continue;
    }

    if (c === '\n' || c === ';') {
      pushOp(';');
      i++;
      continue;
    }

    // `&>` y `&>>` (redirigir stdout+stderr) antes que `&&` y que el `&` de background.
    if (c === '&') {
      if (src[i + 1] === '>') {
        let op = '&>';
        i += 2;
        if (src[i] === '>') {
          op += '>';
          i++;
        }
        pushOp(op);
        continue;
      }
      if (src[i + 1] === '&') {
        pushOp('&&');
        i += 2;
        continue;
      }
      pushOp('&');
      i++;
      continue;
    }

    if (c === '|') {
      if (src[i + 1] === '|') {
        pushOp('||');
        i += 2;
        continue;
      }
      pushOp('|');
      i++;
      continue;
    }

    if (c === '>' || c === '<') {
      // Un dígito de descriptor pegado adelante (`2>`) es parte del operador, no una palabra.
      let fd = '';
      if (!hadQuote && /^\d$/.test(cur)) {
        fd = cur;
        cur = '';
        started = false;
      }
      flush();
      let op = fd + c;
      i++;
      if (c === '>') {
        if (src[i] === '>') {
          op += '>';
          i++;
        } else if (src[i] === '|') {
          op += '|';
          i++;
        }
        // `>&` y `2>&1` duplican descriptores: no hay archivo del otro lado.
        if (src[i] === '&') {
          op += '&';
          i++;
        }
      } else if (c === '<') {
        if (src[i] === '<') {
          op += '<';
          i++;
          if (src[i] === '<') {
            op += '<';
            i++;
          } else if (src[i] === '-') {
            op += '-';
            i++;
          }
        }
      }
      out.push({ text: op, op: true, quoted: false });
      continue;
    }

    cur += c;
    started = true;
    i++;
  }

  flush();
  return out;
}

/** Operadores que separan un comando del siguiente. Cada segmento se analiza por su cuenta. */
const SEPARADORES = new Set([';', '&&', '||', '|', '&']);

function segmentar(tokens) {
  const segmentos = [];
  let actual = [];
  for (const t of tokens) {
    if (t.op && SEPARADORES.has(t.text)) {
      if (actual.length) segmentos.push(actual);
      actual = [];
      continue;
    }
    actual.push(t);
  }
  if (actual.length) segmentos.push(actual);
  return segmentos;
}

// ---------------------------------------------------------------------------------------------
// Reconocimiento
// ---------------------------------------------------------------------------------------------

/** Redirecciones que crean o modifican un archivo. `2>&1` no está: duplica un fd, no escribe. */
const REDIRECCIONES_ESCRITURA = new Set(['>', '>>', '>|', '1>', '1>>', '2>', '2>>', '&>', '&>>']);

/**
 * Destinos que no son archivos del proyecto.
 *
 * `/dev/null` es el caso que más aparece y el que más falsos positivos generaría: media máquina
 * escribe ahí para silenciar salida, y ninguno de esos comandos toca el trabajo del usuario.
 */
const DESTINOS_NO_ARCHIVO = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

/** Envoltorios que no son el comando real: hay que mirar lo que viene después. */
const ENVOLTORIOS = new Set([
  'sudo',
  'doas',
  'env',
  'command',
  'builtin',
  'nohup',
  'time',
  'exec',
  'nice',
  'ionice',
  'stdbuf',
  'setsid',
  'xargs',
]);

/** Flags de los envoltorios que consumen el argumento siguiente y no son el comando. */
const ENVOLTORIO_CON_VALOR = new Set(['-u', '-n', '-I', '-i', '--max-args', '-P']);

/**
 * Comandos que escriben archivos, y cómo sacarles el destino.
 *
 * `kind`:
 *   'args'     → los argumentos no-flag son destinos.
 *   'last'     → el último argumento no-flag es el destino (cp, mv, install).
 *   'unknown'  → escribe, pero el destino no se puede saber leyendo la línea (git apply, patch).
 *   'inplace'  → solo escribe si tiene el flag de in-place; los no-flag son destinos.
 *   'script'   → escribe solo si el script embebido tiene forma de escritura.
 */
const COMANDOS = new Map([
  ['tee', { kind: 'args' }],
  ['dd', { kind: 'dd' }],
  ['truncate', { kind: 'args' }],
  ['cp', { kind: 'last' }],
  ['mv', { kind: 'last' }],
  ['install', { kind: 'last' }],
  ['rsync', { kind: 'last' }],
  ['ln', { kind: 'last' }],
  ['sed', { kind: 'inplace', inplace: /^-.*i|^--in-place/ }],
  ['gsed', { kind: 'inplace', inplace: /^-.*i|^--in-place/ }],
  ['perl', { kind: 'inplace', inplace: /^-.*i/ }],
  // `sd` reescribe in-place POR DEFECTO cuando se le pasan archivos. No hay flag que activar:
  // el flag (`-p`/`--preview`) es el que lo DESACTIVA. Es justo el que el CLAUDE.md del usuario
  // recomienda en lugar de `sed`, así que omitirlo dejaría abierta la puerta más transitada.
  ['sd', { kind: 'sd' }],
  ['patch', { kind: 'unknown' }],
  ['applypatch', { kind: 'unknown' }],
  ['python', { kind: 'script' }],
  ['python3', { kind: 'script' }],
  ['node', { kind: 'script' }],
  ['ruby', { kind: 'script' }],
  ['php', { kind: 'script' }],
  ['deno', { kind: 'script' }],
  ['bun', { kind: 'script' }],
]);

/** Subcomandos de git que reescriben el árbol de trabajo. El resto (status, log, diff) no. */
const GIT_ESCRIBE = new Set(['apply', 'checkout', 'restore', 'stash', 'revert', 'reset', 'merge', 'cherry-pick', 'rebase', 'am']);

/** Formas de escritura dentro de un script embebido (`python -c`, `node -e`). */
const SCRIPT_ESCRIBE =
  /open\s*\([^)]*['"][wax]|writeFileSync|writeFile\b|\.write_text\s*\(|\.write_bytes\s*\(|fs\.appendFile|createWriteStream|shutil\.(copy|move)|os\.replace|os\.rename|Path\([^)]*\)\.write/;

/** Flags que introducen un script inline en vez de un archivo. */
const FLAGS_SCRIPT = new Set(['-c', '-e', '--eval', '--execute', '-p', '-E']);

/**
 * Un destino cuya ruta real NO se puede saber leyendo la línea.
 *
 * Encontrado usando la herramienta de verdad: un comando escribía a un archivo temporal FUERA del
 * proyecto, pero la ruta venía en una variable (`$CLAUDE_CONFIG_DIR/x.json`). El tokenizador no
 * expande variables, así que el destino quedaba como texto sin `/` inicial, se resolvía contra el
 * directorio del proyecto y el candado bloqueaba de más.
 *
 * El error era hacia el lado seguro, pero es fricción real. Y la afirmación honesta es que NO SE
 * SABE dónde escribe: un destino sin resolver no se puede contar como escritura del proyecto, del
 * mismo modo que no se puede descartar. Se omite del listado; si el comando además tiene una forma
 * de escritura sin destino nombrable, `unknownTarget` ya lo cubre por su cuenta.
 */
function destinoSinResolver(texto) {
  const t = String(texto ?? '');
  return t.startsWith('$') || t.startsWith('~') || t.includes('$(') || t.includes('${') || t.includes('`');
}

function esFlag(texto) {
  return texto.startsWith('-') && texto !== '-' && texto !== '--';
}

/** Quita asignaciones de entorno (`FOO=bar cmd`) y envoltorios (`sudo`, `env`, `xargs`). */
function desenvolver(palabras) {
  let i = 0;
  while (i < palabras.length) {
    const t = palabras[i];
    if (!t.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t.text)) {
      i++;
      continue;
    }
    const base = path.basename(t.text.replace(/\\/g, '/'));
    if (ENVOLTORIOS.has(base)) {
      i++;
      // Saltear los flags del envoltorio, incluidos los que se comen el argumento siguiente.
      while (i < palabras.length && esFlag(palabras[i].text)) {
        const flag = palabras[i].text;
        i++;
        if (ENVOLTORIO_CON_VALOR.has(flag) && i < palabras.length) i++;
      }
      continue;
    }
    break;
  }
  return palabras.slice(i);
}

/**
 * Analiza UN segmento (un comando sin `;` ni `&&` adentro).
 *
 * Devuelve `{ targets, unknown, reasons }`. `unknown: true` significa "acá se escribe pero no
 * puedo nombrar el archivo" — y eso, para el candado, cuenta como escritura: `git apply` es
 * exactamente la evasión que hay que cerrar.
 */
function analizarSegmento(tokens) {
  const targets = [];
  const reasons = [];
  let unknown = false;

  // ---- redirecciones ----
  const palabras = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.op) {
      palabras.push(t);
      continue;
    }
    if (t.text.endsWith('&')) {
      // `>&`, `2>&`: duplicación de descriptor. El token siguiente es un número, no un archivo.
      i++;
      continue;
    }
    if (t.text.startsWith('<')) {
      // Lectura. Un heredoc (`<<EOF`) tampoco escribe por sí solo: lo que escribe es el `>`
      // que lo acompaña, y ese se detecta por su cuenta.
      if (t.text.startsWith('<<')) continue;
      i++;
      continue;
    }
    if (REDIRECCIONES_ESCRITURA.has(t.text)) {
      const destino = tokens[i + 1];
      if (destino && !destino.op) {
        i++;
        if (!DESTINOS_NO_ARCHIVO.test(destino.text) && !destinoSinResolver(destino.text)) {
          targets.push(destino.text);
          reasons.push(`redirección \`${t.text}\` a ${destino.text}`);
        }
      }
    }
  }

  const cmd = desenvolver(palabras);
  if (!cmd.length) return { targets, unknown, reasons };

  const nombre = path.basename(cmd[0].text.replace(/\\/g, '/')).toLowerCase();
  const args = cmd.slice(1);
  const textos = args.map((a) => a.text);

  // ---- git ----
  if (nombre === 'git') {
    // `git -C <dir> apply` — saltear los flags globales para llegar al subcomando.
    let k = 0;
    while (k < textos.length && esFlag(textos[k])) {
      const f = textos[k];
      k++;
      if (f === '-C' || f === '-c' || f === '--git-dir' || f === '--work-tree') k++;
    }
    const sub = textos[k];
    if (sub && GIT_ESCRIBE.has(sub)) {
      unknown = true;
      reasons.push(`\`git ${sub}\` reescribe el árbol de trabajo`);
    }
    return { targets, unknown, reasons };
  }

  const spec = COMANDOS.get(nombre);
  if (!spec) return { targets, unknown, reasons };

  // Los destinos que no se pueden resolver se descartan acá, una sola vez, para todos los
  // comandos de la tabla. Ver `destinoSinResolver`.
  const noFlags = args
    .filter((a) => !esFlag(a.text) && !destinoSinResolver(a.text))
    .map((a) => a.text);

  switch (spec.kind) {
    case 'args':
      for (const t of noFlags) {
        if (!DESTINOS_NO_ARCHIVO.test(t)) {
          targets.push(t);
          reasons.push(`\`${nombre}\` escribe ${t}`);
        }
      }
      break;

    case 'last':
      if (noFlags.length >= 2) {
        const destino = noFlags[noFlags.length - 1];
        targets.push(destino);
        reasons.push(`\`${nombre}\` escribe ${destino}`);
      }
      break;

    case 'unknown':
      unknown = true;
      reasons.push(`\`${nombre}\` aplica cambios a archivos que no se nombran en la línea`);
      break;

    case 'inplace': {
      const enSitio = textos.some((t) => esFlag(t) && spec.inplace.test(t));
      if (!enSitio) break;
      // El primer no-flag de `sed -i` es el script (`s/a/b/`), los siguientes son archivos.
      // Con `-e` el script va en el flag, así que TODOS los no-flag son archivos.
      const tieneE = textos.some((t) => t === '-e' || t === '-f' || t.startsWith('--expression'));
      const archivos = tieneE ? noFlags : noFlags.slice(1);
      for (const t of archivos) {
        targets.push(t);
        reasons.push(`\`${nombre} -i\` reescribe ${t}`);
      }
      if (!archivos.length) {
        unknown = true;
        reasons.push(`\`${nombre} -i\` sin archivos nombrados`);
      }
      break;
    }

    case 'sd': {
      // `sd [flags] <buscar> <reemplazar> [archivos...]`. Sin archivos lee stdin y no escribe.
      // `-p`/`--preview` lo vuelve read-only.
      if (textos.some((t) => t === '-p' || t === '--preview')) break;
      const archivos = noFlags.slice(2);
      for (const t of archivos) {
        targets.push(t);
        reasons.push(`\`sd\` reescribe ${t} en el lugar`);
      }
      break;
    }

    case 'dd': {
      const of = textos.find((t) => t.startsWith('of='));
      if (of) {
        const destino = of.slice(3);
        if (!DESTINOS_NO_ARCHIVO.test(destino)) {
          targets.push(destino);
          reasons.push(`\`dd of=\` escribe ${destino}`);
        }
      }
      break;
    }

    case 'script': {
      // El script viene en el argumento que sigue al flag, y ahí adentro se busca forma de
      // escritura. Sin flag de script es `python archivo.py`: ejecutar un archivo del repo no
      // es, por sí solo, escribir en él.
      const idx = args.findIndex((a) => FLAGS_SCRIPT.has(a.text));
      if (idx === -1) break;
      const script = args[idx + 1]?.text ?? '';
      if (SCRIPT_ESCRIBE.test(script)) {
        unknown = true;
        reasons.push(`\`${nombre} ${args[idx].text}\` ejecuta un script que escribe archivos`);
      }
      break;
    }

    default:
      break;
  }

  return { targets, unknown, reasons };
}

// ---------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------

/**
 * ¿Este comando de shell escribe archivos?
 *
 * `{ writes, targets, unknownTarget, reasons }`:
 *   - `targets`        rutas nombradas explícitamente (crudas, sin resolver).
 *   - `unknownTarget`  hay escritura pero el destino no se puede leer de la línea.
 *   - `reasons`        para poder explicarle al usuario POR QUÉ se bloqueó. Un candado que
 *                      bloquea sin decir qué vio es un candado que se termina desinstalando.
 */
export function detectBashWrites(command) {
  const texto = String(command ?? '');
  if (!texto.trim()) return { writes: false, targets: [], unknownTarget: false, reasons: [] };

  const targets = [];
  const reasons = [];
  let unknownTarget = false;

  for (const segmento of segmentar(tokenize(texto))) {
    const r = analizarSegmento(segmento);
    targets.push(...r.targets);
    reasons.push(...r.reasons);
    if (r.unknown) unknownTarget = true;
  }

  // Acá NO se filtra por directorio temporal, y es deliberado.
  //
  // La primera versión descartaba todo lo que cayera en `/tmp`, con el razonamiento de que un
  // script que arma un archivo auxiliar no es el trabajo que el tablero registra. El
  // razonamiento es correcto; el lugar donde se aplicaba, no. Este módulo no sabe dónde vive el
  // proyecto, así que la regla se rompía en los dos sentidos:
  //
  //   · Un proyecto que VIVE bajo /tmp —CI, contenedores, sandboxes, worktrees efímeros—
  //     quedaba con el candado apagado por completo.
  //   · Y era una segunda definición de "esto no cuenta", conviviendo con la que ya existe.
  //
  // La pregunta correcta no es "¿esto está en /tmp?" sino "¿esto está fuera del proyecto?", y
  // eso solo lo puede contestar quien conoce la raíz. Vive en `isTrivialTarget`, que ya exime
  // todo lo externo. Una responsabilidad, un lugar.
  return { writes: targets.length > 0 || unknownTarget, targets, unknownTarget, reasons };
}

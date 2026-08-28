// A dependency-free terminal UI: colours, boxes and prompts.
//
// No dependencies is a hard requirement, not a preference. This installer runs before anything
// is set up, on a machine we know nothing about beyond "Claude Code works here", so `npm
// install` is not a step we get to rely on.
//
// Every prompt has a default that Enter accepts, so the whole flow is answerable by holding
// Enter — and the same defaults are what `--yes` uses in a non-interactive run.

import readline from 'node:readline';
import process from 'node:process';

const useColor =
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb' &&
  Boolean(process.stdout.isTTY);

const wrap = (open, close) => (s) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export const SYM = {
  ok: useColor ? '✔' : 'OK',
  no: useColor ? '✖' : 'X',
  warn: useColor ? '▲' : '!',
  info: useColor ? '•' : '-',
  arrow: useColor ? '→' : '->',
};

/** Visible width, ignoring ANSI escapes, so box borders line up when colour is on. */
function width(str) {
  return String(str).replace(/\x1b\[[0-9;]*m/g, '').length;
}

export function say(line = '') {
  process.stdout.write(`${line}\n`);
}

export function ok(msg) {
  say(`  ${c.green(SYM.ok)} ${msg}`);
}
export function fail(msg) {
  say(`  ${c.red(SYM.no)} ${msg}`);
}
export function warn(msg) {
  say(`  ${c.yellow(SYM.warn)} ${msg}`);
}
export function info(msg) {
  say(`  ${c.cyan(SYM.info)} ${msg}`);
}
export function note(msg) {
  say(`    ${c.gray(msg)}`);
}

/** A titled box. Long lines are wrapped rather than allowed to break the frame. */
export function box(title, lines, { color = c.cyan, inner = 74 } = {}) {
  const body = [];
  for (const raw of lines) {
    const text = String(raw ?? '');
    if (width(text) <= inner) {
      body.push(text);
      continue;
    }
    for (const piece of softWrap(text, inner)) body.push(piece);
  }
  const top = `┌─ ${title} ${'─'.repeat(Math.max(0, inner - width(title) - 1))}┐`;
  const bottom = `└${'─'.repeat(inner + 2)}┘`;
  say(color(top));
  for (const line of body) {
    say(`${color('│')} ${line}${' '.repeat(Math.max(0, inner - width(line)))} ${color('│')}`);
  }
  say(color(bottom));
}

/**
 * Corta un texto a `max` columnas **conservando la sangría de la línea original**.
 *
 * Lo de la sangría no es un adorno. La versión anterior hacía `split(/\s+/)` sobre todo el texto,
 * así que los espacios del principio desaparecían y las continuaciones arrancaban pegadas al
 * borde. Efecto práctico: una lista indentada dentro de un `box` se desarmaba sola en cuanto UNO
 * de sus ítems se pasaba de ancho — un ítem quedaba alineado y el de al lado no, sin que nada
 * avisara. Se descubrió escribiendo el cuadro del candado: la línea de la exención perdió su
 * sangría y quedó en otra columna que sus tres hermanas.
 *
 * Se conserva también el bullet: si la línea abre con `· `, `- `, `* ` o `N. `, las continuaciones
 * se alinean debajo del TEXTO, no debajo del bullet. Es lo que hace que una lista larga se lea
 * como una lista y no como un párrafo con un símbolo suelto adelante.
 */
export function softWrap(text, max) {
  const crudo = String(text);
  const sangria = crudo.match(/^\s*/)?.[0] ?? '';
  const cuerpo = crudo.slice(sangria.length);

  // Un bullet cuenta como sangría para las continuaciones, pero no para la primera línea.
  const bullet = cuerpo.match(/^(?:[·\-*+•]\s+|\d+[.)]\s+)/)?.[0] ?? '';
  const colgante = sangria + ' '.repeat(width(bullet));

  // Sin espacio útil no hay nada que calcular: devolver el texto entero es mejor que entrar en un
  // bucle partiendo por caracteres. Un `max` demasiado chico es un error del llamador.
  const util = max - width(sangria);
  if (util <= 1) return [crudo];

  const words = cuerpo.split(/\s+/).filter(Boolean);
  const out = [];
  let line = '';
  let prefijo = sangria;

  for (const word of words) {
    const disponible = max - width(prefijo);
    if (!line) {
      line = word;
    } else if (width(line) + 1 + width(word) <= disponible) {
      line += ` ${word}`;
    } else {
      out.push(prefijo + line);
      prefijo = colgante;
      line = word;
    }
  }
  if (line) out.push(prefijo + line);
  return out.length ? out : [crudo];
}

/**
 * The install banner. Width is derived from the content instead of hardcoded, because a border
 * that no longer matches its text is the first thing a user notices and the last thing anyone
 * remembers to update.
 */
export function banner(lines, { color = c.cyan, pad = 2 } = {}) {
  const inner = Math.max(...lines.map((l) => width(l)));
  const gap = ' '.repeat(pad);
  say('');
  say(`${gap}${color(`┌${'─'.repeat(inner + 2)}┐`)}`);
  for (const line of lines) {
    say(`${gap}${color('│')} ${line}${' '.repeat(inner - width(line))} ${color('│')}`);
  }
  say(`${gap}${color(`└${'─'.repeat(inner + 2)}┘`)}`);
  say('');
}

export function heading(text) {
  say('');
  say(c.bold(c.magenta(text)));
  say(c.magenta('─'.repeat(Math.min(78, width(text)))));
}

/**
 * Prompt controller. `interactive:false` makes every ask return its default, which is what
 * `--yes` and CI use — the same code path, so the non-interactive answers are always exactly
 * the documented defaults.
 */
export class Prompt {
  constructor({ interactive = true } = {}) {
    this.interactive = interactive && Boolean(process.stdin.isTTY);
    this.rl = null;
  }

  #open() {
    if (!this.rl) {
      this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    }
    return this.rl;
  }

  close() {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  async #question(text) {
    const rl = this.#open();
    return new Promise((resolve) => rl.question(text, (answer) => resolve(answer)));
  }

  /** Free text. `required:true` keeps asking rather than accepting an empty value. */
  async text(question, { def = '', required = false, hint = '' } = {}) {
    if (!this.interactive) return def;
    const suffix = def ? c.gray(` [${def}]`) : '';
    for (;;) {
      if (hint) note(hint);
      const raw = await this.#question(`  ${c.bold('?')} ${question}${suffix} ${c.gray('›')} `);
      const value = raw.trim() || def;
      if (value || !required) return value;
      fail('Hace falta un valor.');
    }
  }

  /** Yes/no. Returns a boolean; the default is shown capitalised. */
  async confirm(question, { def = true, hint = '' } = {}) {
    if (!this.interactive) return def;
    const suffix = c.gray(def ? ' [S/n]' : ' [s/N]');
    for (;;) {
      if (hint) note(hint);
      const raw = (await this.#question(`  ${c.bold('?')} ${question}${suffix} ${c.gray('›')} `))
        .trim()
        .toLowerCase();
      if (!raw) return def;
      if (['s', 'si', 'sí', 'y', 'yes'].includes(raw)) return true;
      if (['n', 'no'].includes(raw)) return false;
      fail('Respondé s o n.');
    }
  }

  /**
   * Numbered single choice. `options` is `[{ value, label, hint? }]`.
   * Returns the chosen `value`.
   */
  async choice(question, options, { def = 0, hint = '' } = {}) {
    const list = options.filter(Boolean);
    if (!list.length) throw new Error('choice() sin opciones');
    if (!this.interactive) return list[Math.min(def, list.length - 1)].value;

    say('');
    say(`  ${c.bold('?')} ${question}`);
    if (hint) note(hint);
    list.forEach((opt, i) => {
      const marker = i === def ? c.green('●') : c.gray('○');
      say(`     ${marker} ${c.bold(String(i + 1))}. ${opt.label}`);
      if (opt.hint) say(`        ${c.gray(opt.hint)}`);
    });

    for (;;) {
      const raw = (
        await this.#question(`  ${c.gray(`elegí 1-${list.length}`)} ${c.gray(`[${def + 1}]`)} ${c.gray('›')} `)
      ).trim();
      if (!raw) return list[def].value;
      const n = Number.parseInt(raw, 10);
      if (Number.isInteger(n) && n >= 1 && n <= list.length) return list[n - 1].value;
      fail(`Un número entre 1 y ${list.length}.`);
    }
  }
}

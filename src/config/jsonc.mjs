// JSON WITH COMMENTS, IN FORTY LINES, BECAUSE THE COMMENTS ARE THE POINT.
//
// A doctrine is a list of numbers that change what twenty-one characters do. The
// harness's own experience with this is written all over its policy defaults: a
// banking threshold of 2000 read as reasonable and meant "almost nothing is ever
// banked", and nobody could tell from the number. The reason has to travel with the
// value or the value gets copied without it.
//
// TOML would give comments and a dependency. YAML would give comments and a much
// larger dependency and a surprising number of ways to write `no`. JSON gives neither
// comments nor a dependency — so: JSON, plus `//` and slash-star, stripped before
// parsing. Nothing else. Not trailing commas, not single quotes, not unquoted keys;
// each of those is a small convenience bought with a parser that can disagree with
// every other JSON reader about what a file means.
//
// STRINGS ARE RESPECTED. A `why` field is prose and prose contains "http://", which
// the naive version of this turned into a comment and then into a parse error two
// hundred characters later. That bug is the entire reason this is a state machine and
// not a regular expression.

/**
 * Strip `//` and slash-star comments from JSON source, preserving string contents
 * and preserving line numbers so a parse error still points somewhere useful.
 * @param {string} src
 * @returns {string}
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    // Inside a string: copy verbatim until the closing quote, honouring backslashes.
    if (ch === '"') {
      out += ch; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        out += src[i];
        if (src[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;                       // the newline itself is copied by the next pass
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      // Keep the newlines. A block comment that swallowed its own line breaks moves
      // every error after it to the wrong line, which is worse than no line at all.
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    out += ch; i++;
  }
  return out;
}

/**
 * Parse JSONC. Errors name the file and the line, because a doctrine is edited by
 * hand and `Unexpected token } in JSON at position 4871` is not a location.
 * @param {string} src
 * @param {string} [label] file name for the error message
 */
export function parseJsonc(src, label = '<doctrine>') {
  const stripped = stripComments(src);
  try {
    return JSON.parse(stripped);
  } catch (e) {
    const m = /position (\d+)/.exec(e.message);
    const where = m ? `line ${stripped.slice(0, Number(m[1])).split('\n').length}` : 'somewhere';
    throw new Error(`${label}: ${e.message} (${where}). Note that JSONC here means ` +
                    `JSON plus comments and nothing else — no trailing commas, no ` +
                    `single quotes, no unquoted keys.`);
  }
}

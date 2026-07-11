/**
 * Extracts the first balanced top-level JSON value (object OR array) from
 * text by tracking bracket depth (ignoring brackets inside string literals).
 * A regex matching from the first '{' to the LAST '}' in the text breaks as
 * soon as an LLM adds any trailing prose containing its own brace (even
 * just "{algo}" in a sentence) — it silently captures past the JSON's real
 * closing brace, which JSON.parse then rejects as "Unexpected
 * non-whitespace character after JSON".
 *
 * Starting from either '{' or '[' (whichever appears first) matters because
 * LLMs don't reliably wrap a requested list in the object shape you asked
 * for — asked for {"moments": [...]}, Claude has returned a bare top-level
 * [...] instead. Tracking depth across both bracket kinds together (rather
 * than only the opening kind) correctly handles the object-containing-array
 * case too, since JSON nesting is always properly matched.
 */
function extractJsonValue(text) {
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' || text[i] === '[') {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{' || char === '[') {
      depth++;
    } else if (char === '}' || char === ']') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null; // unbalanced — no matching closing bracket found
}

module.exports = { extractJsonValue };

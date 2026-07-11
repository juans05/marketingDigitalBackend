/**
 * Extracts the first balanced top-level JSON object from text by tracking
 * brace depth (ignoring braces inside string literals). A regex matching
 * from the first '{' to the LAST '}' in the text breaks as soon as an LLM
 * adds any trailing prose containing its own brace (even just "{algo}" in
 * a sentence) — it silently captures past the JSON's real closing brace,
 * which JSON.parse then rejects as "Unexpected non-whitespace character
 * after JSON".
 */
function extractJsonObject(text) {
  const start = text.indexOf('{');
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

    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null; // unbalanced — no matching closing brace found
}

module.exports = { extractJsonObject };

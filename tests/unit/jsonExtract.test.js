const { extractJsonObject } = require('../../src/lib/jsonExtract');

describe('extractJsonObject', () => {
  it('should extract a plain JSON object with no surrounding text', () => {
    const input = '{"a":1,"b":2}';
    expect(extractJsonObject(input)).toBe(input);
  });

  it('should extract JSON from a markdown code fence', () => {
    const json = '{"a":1}';
    const input = '```json\n' + json + '\n```';
    expect(extractJsonObject(input)).toBe(json);
  });

  it('should extract JSON even when followed by trailing prose containing its own braces', () => {
    const json = '{"a":1,"nested":{"b":2}}';
    const input = `${json}\n\nEspero que este análisis de {contexto} te sea útil.`;
    expect(extractJsonObject(input)).toBe(json);
  });

  it('should extract JSON that contains braces inside string values', () => {
    const json = '{"reason":"uses { and } inside a string"}';
    expect(extractJsonObject(json)).toBe(json);
  });

  it('should extract JSON that contains escaped quotes near braces', () => {
    const json = '{"reason":"she said \\"hi\\" then {laughed}"}';
    expect(extractJsonObject(json)).toBe(json);
  });

  it('should return null when there is no opening brace', () => {
    expect(extractJsonObject('no json here')).toBeNull();
  });

  it('should return null when braces are unbalanced', () => {
    expect(extractJsonObject('{"a":1')).toBeNull();
  });
});

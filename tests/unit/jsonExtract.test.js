const { extractJsonValue } = require('../../src/lib/jsonExtract');

describe('extractJsonValue', () => {
  it('should extract a plain JSON object with no surrounding text', () => {
    const input = '{"a":1,"b":2}';
    expect(extractJsonValue(input)).toBe(input);
  });

  it('should extract JSON from a markdown code fence', () => {
    const json = '{"a":1}';
    const input = '```json\n' + json + '\n```';
    expect(extractJsonValue(input)).toBe(json);
  });

  it('should extract JSON even when followed by trailing prose containing its own braces', () => {
    const json = '{"a":1,"nested":{"b":2}}';
    const input = `${json}\n\nEspero que este análisis de {contexto} te sea útil.`;
    expect(extractJsonValue(input)).toBe(json);
  });

  it('should extract JSON that contains braces inside string values', () => {
    const json = '{"reason":"uses { and } inside a string"}';
    expect(extractJsonValue(json)).toBe(json);
  });

  it('should extract JSON that contains escaped quotes near braces', () => {
    const json = '{"reason":"she said \\"hi\\" then {laughed}"}';
    expect(extractJsonValue(json)).toBe(json);
  });

  it('should return null when there is no opening brace', () => {
    expect(extractJsonValue('no json here')).toBeNull();
  });

  it('should return null when braces are unbalanced', () => {
    expect(extractJsonValue('{"a":1')).toBeNull();
  });

  // Real production failure: Claude was asked for {"moments": [...]} and
  // returned a bare top-level array instead.
  it('should extract a bare top-level JSON array', () => {
    const input = '[{"start":1,"end":2},{"start":3,"end":4}]';
    expect(extractJsonValue(input)).toBe(input);
  });

  it('should extract a bare array wrapped in a markdown code fence', () => {
    const json = '[{"a":1}]';
    const input = '```json\n' + json + '\n```';
    expect(extractJsonValue(input)).toBe(json);
  });

  it('should extract a bare array followed by trailing prose with its own brackets', () => {
    const json = '[{"a":1}]';
    const input = `${json}\n\nEsto cubre [casi] todos los casos.`;
    expect(extractJsonValue(input)).toBe(json);
  });

  it('should correctly balance an object containing a nested array', () => {
    const json = '{"moments":[{"a":1},{"a":2}],"other":true}';
    expect(extractJsonValue(json)).toBe(json);
  });

  it('should correctly balance an array containing nested objects with arrays inside', () => {
    const json = '[{"tags":["a","b"]},{"tags":["c"]}]';
    expect(extractJsonValue(json)).toBe(json);
  });
});

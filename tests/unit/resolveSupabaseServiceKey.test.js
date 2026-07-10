const { resolveSupabaseServiceKey } = require('../../src/lib/resolveSupabaseServiceKey');

const ENV_KEYS = ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY', 'SUPABASE_ANON_KEY'];

beforeEach(() => {
  ENV_KEYS.forEach((k) => delete process.env[k]);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('prefiere SUPABASE_SERVICE_ROLE_KEY cuando está definida', () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'role-key';
  process.env.SUPABASE_SERVICE_KEY = 'service-key';
  expect(resolveSupabaseServiceKey('X')).toBe('role-key');
});

test('cae a SUPABASE_SERVICE_KEY y lo loguea cuando ROLE_KEY no está definida', () => {
  process.env.SUPABASE_SERVICE_KEY = 'service-key';
  const value = resolveSupabaseServiceKey('X');
  expect(value).toBe('service-key');
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('SUPABASE_SERVICE_KEY'));
});

test('cae a SUPABASE_ANON_KEY con warning cuando no hay ninguna service key', () => {
  process.env.SUPABASE_ANON_KEY = 'anon-key';
  const value = resolveSupabaseServiceKey('X');
  expect(value).toBe('anon-key');
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('ANON_KEY'));
});

test('cae a placeholder con warning cuando no hay ninguna variable configurada', () => {
  const value = resolveSupabaseServiceKey('X');
  expect(value).toBe('placeholder');
  expect(console.warn).toHaveBeenCalled();
});

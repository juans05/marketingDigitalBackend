// SUPABASE_SERVICE_ROLE_KEY es el nombre "canónico", pero varias partes del
// código (y el propio panel de Railway del proyecto) usan SUPABASE_SERVICE_KEY
// (sin "_ROLE_"). Si repurposerService.js no contempla ese nombre, cae
// silenciosamente a SUPABASE_ANON_KEY y los inserts fallan por RLS con un
// error casi imposible de diagnosticar (ver commit de este fix).
process.env.SUPABASE_URL = 'https://x.supabase.co';
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.SUPABASE_SERVICE_KEY = 'service-key-sin-role';
process.env.SUPABASE_ANON_KEY = 'anon-key';

const mockCreateClient = jest.fn().mockReturnValue({ from: () => ({}) });
jest.mock('@supabase/supabase-js', () => ({ createClient: (...args) => mockCreateClient(...args) }));

afterAll(() => {
  delete process.env.SUPABASE_SERVICE_KEY;
  delete process.env.SUPABASE_ANON_KEY;
});

test('repurposerService usa SUPABASE_SERVICE_KEY cuando SUPABASE_SERVICE_ROLE_KEY no está definida', () => {
  jest.isolateModules(() => {
    require('../../src/services/repurposerService');
  });
  expect(mockCreateClient).toHaveBeenCalledWith('https://x.supabase.co', 'service-key-sin-role');
});

test('repurposeProgress usa SUPABASE_SERVICE_KEY cuando SUPABASE_SERVICE_ROLE_KEY no está definida', () => {
  jest.isolateModules(() => {
    require('../../src/services/repurposeProgress');
  });
  expect(mockCreateClient).toHaveBeenCalledWith('https://x.supabase.co', 'service-key-sin-role');
});

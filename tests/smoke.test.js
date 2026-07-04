const { createSupabaseMock } = require('./helpers/supabaseMock');

test('supabase mock returns queued results in order', async () => {
  const { client, queueResult } = createSupabaseMock();
  queueResult({ data: [{ id: 1 }], error: null });
  const res = await client.from('agencies').select('*').eq('email', 'a@b.com').limit(1);
  expect(res.data).toEqual([{ id: 1 }]);
});

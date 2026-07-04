// Chainable Supabase stub for unit tests.
// Each awaited chain consumes the next queued { data, error } result (FIFO).
function createSupabaseMock() {
  const queue = [];
  const client = {
    from() { return client; },
    select() { return client; },
    insert() { return client; },
    upsert() { return client; },
    update() { return client; },
    delete() { return client; },
    eq() { return client; },
    limit() { return client; },
    single() { return client; },
    then(resolve, reject) {
      const result = queue.length ? queue.shift() : { data: null, error: null };
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return { client, queueResult: (result) => queue.push(result) };
}

module.exports = { createSupabaseMock };

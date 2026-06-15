// Set production BEFORE requiring the module to suppress the winston Console
// transport (it is only attached when NODE_ENV !== 'production'), keeping test
// output pristine.
process.env.NODE_ENV = 'production';

const logger = require('../loggerService');

describe('loggerService.log (legacy-compatible API)', () => {
  test('exposes a callable log() method (regression: winston migration dropped it)', () => {
    expect(typeof logger.log).toBe('function');
  });

  test('does not throw for any legacy call signature used across the codebase', () => {
    // Variants observed in vidalisService / analyticsService / uploadPostService
    expect(() => logger.log('info', 'EVENT_INFO', { a: 1 })).not.toThrow();
    expect(() => logger.log('warn', 'EVENT_WARN', { a: 1 })).not.toThrow();
    expect(() => logger.log('error', 'EVENT_ERROR', { e: 'x' })).not.toThrow();
    // 'success' is NOT a configured winston level — must be mapped, never throw
    expect(() => logger.log('success', 'EVENT_SUCCESS', { a: 1 })).not.toThrow();
    // 4-arg form carrying agency_id (e.g. vidalisService.js:166)
    expect(() => logger.log('success', 'USER_LOGIN', { email: 'a@b.c' }, 'agency-123')).not.toThrow();
    // 5-arg form with explicit source (e.g. uploadPostService.js:421)
    expect(() => logger.log('error', 'PUBLISH_API_LIMIT', { error: 'x' }, null, 'backend')).not.toThrow();
  });

  test('sanitizeLogMeta strips secrets but keeps other fields', () => {
    const out = logger.sanitizeLogMeta({
      password: 'p', password_hash: 'h', token: 't', secret: 's',
      userId: 42, email: 'a@b.c',
    });
    expect(out).toEqual({ userId: 42, email: 'a@b.c' });
  });

  test('sanitizeLogMeta tolerates null / non-object input', () => {
    expect(() => logger.sanitizeLogMeta(null)).not.toThrow();
    expect(logger.sanitizeLogMeta(null)).toEqual({});
  });
});

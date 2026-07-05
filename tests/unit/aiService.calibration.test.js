process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon';

const { calibrateScore, calibrateScore100 } = require('../../src/services/aiService');

describe('calibrateScore100 — bug de escala (0-100 sin colapsar a múltiplos de 10)', () => {
  test('dos raw scores distintos y cercanos NO colapsan al mismo múltiplo de 10', () => {
    // totalPostsAnalyzed=10 ya está por encima de la ventana de regresión (softened),
    // así que no hay pull hacia historicalAvg; sin bias, el score no debería cambiar.
    const ctx = {
      scoreBias: 0,
      biasStdDev: 0,
      historicalAvg: 5,
      platformCalibration: {},
      totalPostsAnalyzed: 10,
    };
    const a = calibrateScore100(58, ctx, 'tiktok');
    const b = calibrateScore100(63, ctx, 'tiktok');
    expect(a.score).toBe(58);
    expect(b.score).toBe(63);
    expect(a.score).not.toBe(b.score);
  });

  test('la corrección de bias se escala a 0-100 (no resta el bias crudo de 1-10)', () => {
    const ctx = {
      scoreBias: 0.5, // escala 1-10 → equivale a 5 en escala 0-100
      biasStdDev: 0.2,
      historicalAvg: 6,
      platformCalibration: {},
      totalPostsAnalyzed: 10,
    };
    const result = calibrateScore100(80, ctx, 'tiktok');
    expect(result.score).toBe(75); // 80 - (0.5 * 10)
  });

  test('sin datos suficientes, no rompe y redondea el raw tal cual', () => {
    const result = calibrateScore100(72, null, 'tiktok');
    expect(result.score).toBe(72);
    expect(result.confidence).toBe('low');
  });
});

describe('calibrateScore100 — regresión a la media suavizada', () => {
  test('con 10 posts analizados, ya no hay pull hacia historicalAvg (ventana softened)', () => {
    const ctx = {
      scoreBias: 0,
      biasStdDev: 0,
      historicalAvg: 30, // muy distinto del raw, para detectar cualquier pull
      platformCalibration: {},
      totalPostsAnalyzed: 10,
    };
    const result = calibrateScore100(90, ctx, 'tiktok');
    expect(result.score).toBe(90); // no debe acercarse a 30
  });
});

describe('calibrateScore (1-10, pipeline principal de video) — ventana de regresión unificada con calibrateScore100', () => {
  test('sin bias y con datos suficientes, el score no se ajusta', () => {
    const ctx = {
      scoreBias: 0,
      biasStdDev: 0,
      historicalAvg: 5,
      platformCalibration: {},
      totalPostsAnalyzed: 20,
    };
    const result = calibrateScore(8, ctx, 'tiktok');
    expect(result.score).toBe(8);
  });

  test('con 10 posts analizados, ya no hay pull hacia historicalAvg (misma ventana=10 que calibrateScore100)', () => {
    const ctx = {
      scoreBias: 0,
      biasStdDev: 0,
      historicalAvg: 3,
      platformCalibration: {},
      totalPostsAnalyzed: 10,
    };
    const result = calibrateScore(9, ctx, 'tiktok');
    expect(result.score).toBe(9); // regressionWeight = 10/10 = 1, sin pull
  });

  test('con pocos posts (5), todavía hay pull proporcional hacia la media', () => {
    const ctx = {
      scoreBias: 0,
      biasStdDev: 0,
      historicalAvg: 3,
      platformCalibration: {},
      totalPostsAnalyzed: 5,
    };
    const result = calibrateScore(9, ctx, 'tiktok');
    // regressionWeight = 5/10 = 0.5, priorWeight = 0.5
    // adjusted = 9*0.5 + 3*0.5 = 4.5 + 1.5 = 6.0
    expect(result.score).toBe(6);
  });
});

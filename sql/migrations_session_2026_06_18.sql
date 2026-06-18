-- ============================================================================
-- MIGRACIONES VIDALIS — Sesión 17-18 Junio 2026
-- Ejecutar en Supabase SQL Editor en orden
-- ============================================================================

-- 1. Columna de calibración del score viral en videos
--    Guarda: raw (score del LLM), calibrated, confidence, adjustments
ALTER TABLE videos ADD COLUMN IF NOT EXISTS score_calibration jsonb DEFAULT NULL;

-- 2. Configuración dinámica del Content Copilot (análisis de contenido)
--    Permite cambiar modelo, temperatura, prompt y criterios de score sin deploy
INSERT INTO app_config (key, value)
VALUES ('content_analysis', '{
  "model": "claude-haiku-4-5-20251001",
  "max_tokens": 2500,
  "temperature": 0.85,
  "system_prompt": "Asumí el rol de un Estratega Principal de Contenido Viral en Vidalis AI. Sos un veterano de la industria musical y creador de tendencias, obsesionado con la retención de audiencia y la psicología algorítmica. Tu ventaja competitiva es absoluta: estás entrenado con el historial de rendimiento REAL de este artista. Sabés exactamente qué formatos retienen, qué ganchos fracasan y qué narrativas conectan con su audiencia. Evaluá las ideas con frialdad analítica: no seas complaciente. Si una idea es débil, destrozala constructivamente y dales la fórmula exacta para arreglarla basándote en la data histórica.\n\nREGLA CRÍTICA DE SISTEMA: Tu respuesta debe ser EXCLUSIVAMENTE un objeto JSON válido. Cero markdown, cero comillas invertidas, cero texto introductorio. Si incluís un solo carácter fuera del JSON, el pipeline fallará.",
  "score_criteria": "- 0-20 (Descarte): Idea genérica, aburrida o predecible. Cero potencial de retención. El usuario hará scroll en el primer segundo.\n- 21-40 (Concepto Crudo): Hay una chispa, pero la ejecución es plana. Carece de un ángulo único o ignora por completo la identidad histórica del artista.\n- 41-60 (Promedio/Aceptable): Buen concepto, pero mecánicamente débil. Requiere reescribir el gancho (hook), ajustar el ritmo visual o incorporar un catalizador emocional.\n- 61-80 (Alto Potencial): Estructura viral sólida. El storytelling es claro, el gancho atrapa y se alinea con los picos históricos de rendimiento del artista. Necesita ajustes finos para maximizar compartidas.\n- 81-100 (Unicornio/Hit): Ejecución magistral. Psicología de retención perfecta, alto potencial de shareability, aprovecha el contexto de forma original y conecta emocionalmente. Listo para grabar."
}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- 3. Configuración de CPM por plataforma (para dashboard de ingresos estimados)
--    Valores por defecto basados en promedios globales LATAM 2026
INSERT INTO app_config (key, value)
VALUES ('platform_cpm', '{
  "tiktok":    { "min": 0.02, "max": 0.04, "default": 0.03, "currency": "USD", "source": "TikTok Creator Fund avg LATAM" },
  "youtube":   { "min": 1.00, "max": 5.00, "default": 2.00, "currency": "USD", "source": "YouTube AdSense avg música español" },
  "instagram": { "min": 0.01, "max": 0.02, "default": 0.015, "currency": "USD", "source": "Meta Reels Ads avg" },
  "facebook":  { "min": 0.01, "max": 0.03, "default": 0.02, "currency": "USD", "source": "Facebook Watch avg" },
  "spotify":   { "min": 3.00, "max": 5.00, "default": 4.00, "currency": "USD", "source": "Spotify per 1000 streams (Loud & Clear 2025)" }
}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- 4. Índices para optimizar queries de calibración global
--    (fetchGlobalCalibration consulta 200 videos con ambos scores)
CREATE INDEX IF NOT EXISTS idx_videos_calibration
  ON videos (created_at DESC)
  WHERE viral_score IS NOT NULL AND viral_score_real IS NOT NULL;

-- 5. Índice para la primera sync (2 años de snapshots por artista)
CREATE INDEX IF NOT EXISTS idx_platform_snapshots_artist_date
  ON platform_snapshots (artist_id, snapshot_date DESC);

-- 6. Índice para post_metrics_snapshots por artista (learning context)
CREATE INDEX IF NOT EXISTS idx_post_metrics_artist
  ON post_metrics_snapshots (artist_id, snapshot_at DESC);

-- ============================================================================
-- VERIFICACIÓN: correr después de ejecutar todo
-- ============================================================================
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'videos' AND column_name = 'score_calibration';
--
-- SELECT key FROM app_config WHERE key IN ('content_analysis', 'platform_cpm');

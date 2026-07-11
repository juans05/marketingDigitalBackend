-- ============================================================================
-- Migración: sistema de scoring de impacto para clips del Repurposer
-- Ejecutar en Supabase SQL Editor
-- ============================================================================
-- Independiente del viral_score/viral_score_real del sistema viejo
-- (generateCopyWithClaude / calibrateScore) — ese sistema queda intacto,
-- este es un rubro de scoring nuevo y separado, específico para clips.

-- 1. Columna liviana en `videos` para mostrar el score actual en el catálogo
--    sin necesitar un JOIN — se actualiza cada vez que se puntúa/re-puntúa.
ALTER TABLE videos ADD COLUMN IF NOT EXISTS clip_impact_score DECIMAL(4,1) DEFAULT NULL;

-- 2. Tabla dedicada: un clip puede tener un score distinto por cada red
--    social evaluada ("puntuar para otra red" no pisa el score anterior,
--    crea/actualiza la fila de ESA plataforma puntual).
CREATE TABLE IF NOT EXISTS clip_platform_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clip_video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,

  -- Score total (0-10) y desglose de los 7 criterios del rubro
  score DECIMAL(4,1) NOT NULL,
  score_breakdown JSONB NOT NULL,
  -- score_breakdown shape: { hook, retention, emotional_impact, clarity, value, cta, editing }

  main_strength TEXT,
  main_weakness TEXT,
  improvement_suggestion TEXT,
  viral_likelihood TEXT,
  recommended_platform TEXT,
  hashtags_suggested JSONB,

  -- Copy generado en el mismo llamado
  copy_short TEXT,
  copy_long TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Re-puntuar la MISMA plataforma actualiza esta fila (no duplica);
  -- puntuar una plataforma distinta crea una fila nueva.
  UNIQUE (clip_video_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_clip_platform_scores_clip
  ON clip_platform_scores(clip_video_id);

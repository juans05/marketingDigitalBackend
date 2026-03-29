-- =============================================================
-- MIGRACIÓN: Analytics Tracking + Real Viral Score
-- Vidalis.AI — 2026
-- =============================================================
-- Ejecutar en Supabase SQL Editor

-- -------------------------------------------------------------
-- 1. TABLA: post_metrics_snapshots
--    Guarda una foto de las métricas reales de cada post
--    cada vez que se sincroniza con Upload-Post.
--    Permite trackear tendencias (likes crecen, caen, etc.)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS post_metrics_snapshots (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  video_id          UUID REFERENCES videos(id) ON DELETE CASCADE NOT NULL,
  artist_id         UUID REFERENCES artists(id) ON DELETE CASCADE NOT NULL,
  snapshot_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  platform          TEXT,                     -- 'instagram', 'tiktok', 'youtube', etc.
  likes             INTEGER DEFAULT 0,
  comments          INTEGER DEFAULT 0,
  views             INTEGER DEFAULT 0,
  shares            INTEGER DEFAULT 0,
  saves             INTEGER DEFAULT 0,
  reach             INTEGER DEFAULT 0,
  impressions       INTEGER DEFAULT 0,
  engagement_rate   DECIMAL(6,3) DEFAULT 0,   -- (likes+comments*2+shares*3) / views * 100
  viral_score_real  DECIMAL(4,1) DEFAULT 0,   -- Score calculado de 1-10 basado en engagement real
  raw_data          JSONB DEFAULT '{}'         -- Respuesta cruda de Upload-Post (por si cambia la estructura)
);

CREATE INDEX IF NOT EXISTS idx_pms_video_id    ON post_metrics_snapshots(video_id);
CREATE INDEX IF NOT EXISTS idx_pms_artist_id   ON post_metrics_snapshots(artist_id);
CREATE INDEX IF NOT EXISTS idx_pms_snapshot_at ON post_metrics_snapshots(snapshot_at DESC);

-- -------------------------------------------------------------
-- 2. TABLA: analytics_insights_log
--    Historial de análisis generados por Claude.
--    Permite ver cómo evolucionan las recomendaciones,
--    y que la IA compare el desempeño actual vs el pasado.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics_insights_log (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  artist_id        UUID REFERENCES artists(id) ON DELETE CASCADE NOT NULL,
  generated_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  insights         JSONB DEFAULT '[]',         -- Array de observaciones textuales
  decisions        JSONB DEFAULT '[]',         -- Array de decisiones recomendadas
  best_platform    TEXT,
  best_post_title  TEXT,
  engagement_rate  DECIMAL(6,3) DEFAULT 0,
  followers_total  INTEGER DEFAULT 0,          -- Snapshot de seguidores en ese momento
  total_reach      INTEGER DEFAULT 0,          -- Snapshot de reach en ese momento
  profile_data     JSONB DEFAULT '{}'          -- Datos completos de perfil en ese momento
);

CREATE INDEX IF NOT EXISTS idx_ail_artist_id    ON analytics_insights_log(artist_id);
CREATE INDEX IF NOT EXISTS idx_ail_generated_at ON analytics_insights_log(generated_at DESC);

-- -------------------------------------------------------------
-- 3. COLUMNA ADICIONAL en videos:
--    viral_score_real — el score calculado con métricas reales
--    (distinto del viral_score estimado por IA al subir el video)
-- -------------------------------------------------------------
ALTER TABLE videos ADD COLUMN IF NOT EXISTS viral_score_real DECIMAL(4,1);

-- =============================================================
-- NOTA: No borrar viral_score (el estimado de IA al subir).
-- La comparación entre viral_score (predicho) y viral_score_real
-- (medido) es valiosa para que la IA mejore sus predicciones.
-- =============================================================

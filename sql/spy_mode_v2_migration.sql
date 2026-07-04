-- ═══════════════════════════════════════════════════════════════
-- SPY MODE V2 — New tables for competitive intelligence
-- ═══════════════════════════════════════════════════════════════

-- Configuración por artista: tracking diario de competidores
ALTER TABLE artists ADD COLUMN IF NOT EXISTS competitor_snapshot_enabled BOOLEAN DEFAULT false;
ALTER TABLE artists ADD COLUMN IF NOT EXISTS competitor_snapshot_expires_at TIMESTAMP WITH TIME ZONE;

-- Funcionalidad B — Seguimiento Semanal de Métricas
CREATE TABLE IF NOT EXISTS competitor_weekly_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competitor_id UUID NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  snapshot_date DATE NOT NULL,
  followers INTEGER DEFAULT 0,
  following INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  videos INTEGER DEFAULT 0,
  posts INTEGER DEFAULT 0,
  engagement_rate DECIMAL(5,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (competitor_id, platform, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_cws_competitor ON competitor_weekly_snapshots(competitor_id);
CREATE INDEX IF NOT EXISTS idx_cws_date ON competitor_weekly_snapshots(snapshot_date);

ALTER TABLE competitor_weekly_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_cws" ON competitor_weekly_snapshots FOR ALL USING (true) WITH CHECK (true);

-- Funcionalidad A — Análisis de Contenido Viral
CREATE TABLE IF NOT EXISTS competitor_content_analysis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competitor_id UUID NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  analyzed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  posts_count INTEGER,
  top_topics TEXT[],
  top_formats TEXT[],
  peak_hours TEXT[],
  peak_days TEXT[],
  common_hooks TEXT[],
  top_hashtags TEXT[],
  avg_duration TEXT,
  raw_posts JSONB,
  ai_summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_cca_competitor ON competitor_content_analysis(competitor_id);

ALTER TABLE competitor_content_analysis ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_cca" ON competitor_content_analysis FOR ALL USING (true) WITH CHECK (true);

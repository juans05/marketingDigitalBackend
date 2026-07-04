-- ═══════════════════════════════════════════════════════════════
-- COMPETITOR SPY — Tables for competitive intelligence
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS competitors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id UUID NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  tiktok_username TEXT,
  youtube_username TEXT,
  instagram_username TEXT,
  facebook_username TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_competitors_artist ON competitors(artist_id);

CREATE TABLE IF NOT EXISTS competitor_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competitor_id UUID NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  artist_id UUID NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  data JSONB,
  comparisons JSONB,
  action_plan JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_competitor_snapshots_competitor ON competitor_snapshots(competitor_id);
CREATE INDEX IF NOT EXISTS idx_competitor_snapshots_artist ON competitor_snapshots(artist_id);

-- RLS: allow service_role full access (same pattern as other tables)
ALTER TABLE competitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitor_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_competitors" ON competitors FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_competitor_snapshots" ON competitor_snapshots FOR ALL USING (true) WITH CHECK (true);

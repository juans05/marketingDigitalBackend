-- ============================================================
-- VIDALIS.AI — Fase 1 + Fase 2 Migration
-- Ejecutar en Supabase SQL Editor
-- ============================================================

-- ==================== FASE 1 ====================

-- 1. IdeaBank: Ideas generadas por IA
CREATE TABLE IF NOT EXISTS idea_bank (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  artist_id UUID NOT NULL,
  hook TEXT NOT NULL,
  bullets TEXT[] DEFAULT '{}',
  cta TEXT,
  script TEXT,
  category TEXT,
  trend_source TEXT,
  trend_platform TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','liked','disliked','saved')),
  rating INT CHECK (rating >= 1 AND rating <= 5),
  is_favorite BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_idea_bank_artist ON idea_bank(artist_id);
CREATE INDEX IF NOT EXISTS idx_idea_bank_status ON idea_bank(artist_id, status);
CREATE INDEX IF NOT EXISTS idx_idea_bank_created ON idea_bank(artist_id, created_at DESC);

-- 2. IdeaBank: Preferencias de swipe
CREATE TABLE IF NOT EXISTS idea_preferences (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  artist_id UUID NOT NULL,
  idea_id UUID REFERENCES idea_bank(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('like','dislike','save')),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_idea_pref_artist ON idea_preferences(artist_id);

-- 3. IdeaBank: Fuentes de monitoreo de tendencias
CREATE TABLE IF NOT EXISTS trend_references (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  artist_id UUID NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('hashtag','subreddit','profile','channel','category')),
  value TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('tiktok','instagram','reddit','youtube')),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trend_ref_artist ON trend_references(artist_id);

-- 4. IdeaBank: Perfil de estilo del artista
CREATE TABLE IF NOT EXISTS artist_style_profile (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  artist_id UUID NOT NULL UNIQUE,
  tone TEXT,
  hook_patterns JSONB DEFAULT '[]',
  common_themes JSONB DEFAULT '[]',
  preferred_formats TEXT[] DEFAULT '{}',
  audience_keywords TEXT[] DEFAULT '{}',
  best_posting_times JSONB DEFAULT '{}',
  avg_engagement_rate NUMERIC(5,2),
  total_posts_analyzed INT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_style_artist ON artist_style_profile(artist_id);

-- 5. Historial de crecimiento (snapshots diarios)
CREATE TABLE IF NOT EXISTS growth_snapshots (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  artist_id UUID NOT NULL,
  platform TEXT NOT NULL,
  followers INT DEFAULT 0,
  total_views BIGINT DEFAULT 0,
  total_likes BIGINT DEFAULT 0,
  engagement_rate NUMERIC(5,2) DEFAULT 0,
  posts_count INT DEFAULT 0,
  snapshot_date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(artist_id, platform, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_growth_artist ON growth_snapshots(artist_id, snapshot_date DESC);

-- 6. Notificaciones
CREATE TABLE IF NOT EXISTS notifications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  artist_id UUID NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('milestone','reminder','trend','idea','collab','system')),
  title TEXT NOT NULL,
  message TEXT,
  icon TEXT DEFAULT 'bell',
  color TEXT DEFAULT '#4F46E5',
  is_read BOOLEAN DEFAULT false,
  action_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_artist ON notifications(artist_id, is_read, created_at DESC);

-- ==================== FASE 2 ====================

-- 7. Media Kit
CREATE TABLE IF NOT EXISTS media_kit (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  artist_id UUID NOT NULL UNIQUE,
  display_name TEXT,
  bio TEXT,
  profile_photo TEXT,
  niche TEXT,
  location TEXT,
  languages TEXT[] DEFAULT '{}',
  custom_links JSONB DEFAULT '[]',
  visible_stats TEXT[] DEFAULT ARRAY['followers','engagement','views','posts'],
  theme TEXT DEFAULT 'dark',
  accent_color TEXT DEFAULT '#4F46E5',
  slug TEXT UNIQUE,
  is_public BOOLEAN DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_kit_slug ON media_kit(slug);
CREATE INDEX IF NOT EXISTS idx_media_kit_artist ON media_kit(artist_id);

-- 8. Colaboraciones / Brand Deals
CREATE TABLE IF NOT EXISTS collaborations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  artist_id UUID NOT NULL,
  brand_name TEXT NOT NULL,
  brand_logo TEXT,
  brand_contact TEXT,
  brand_email TEXT,
  amount NUMERIC(10,2),
  currency TEXT DEFAULT 'USD',
  status TEXT DEFAULT 'lead' CHECK (status IN ('lead','negotiating','confirmed','in_progress','delivered','paid','cancelled')),
  platform TEXT,
  deliverables JSONB DEFAULT '[]',
  start_date DATE,
  end_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_collab_artist ON collaborations(artist_id, status);
CREATE INDEX IF NOT EXISTS idx_collab_date ON collaborations(artist_id, created_at DESC);

-- ==================== FUNCIONES ====================

-- Función para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers de updated_at
DROP TRIGGER IF EXISTS trg_style_updated ON artist_style_profile;
CREATE TRIGGER trg_style_updated BEFORE UPDATE ON artist_style_profile
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_media_kit_updated ON media_kit;
CREATE TRIGGER trg_media_kit_updated BEFORE UPDATE ON media_kit
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_collab_updated ON collaborations;
CREATE TRIGGER trg_collab_updated BEFORE UPDATE ON collaborations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

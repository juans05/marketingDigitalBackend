-- Métricas diarias por plataforma (una fila por artista+plataforma+día)
CREATE TABLE IF NOT EXISTS platform_snapshots (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  artist_id       uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  platform        text NOT NULL,
  snapshot_date   date NOT NULL DEFAULT CURRENT_DATE,
  followers       integer DEFAULT 0,
  reach           integer DEFAULT 0,
  impressions     integer DEFAULT 0,
  likes           integer DEFAULT 0,
  comments        integer DEFAULT 0,
  shares          integer DEFAULT 0,
  saves           integer DEFAULT 0,
  clicks          integer DEFAULT 0,
  views           integer DEFAULT 0,
  posts_count     integer DEFAULT 0,
  engagement_rate numeric(8,3) DEFAULT 0,
  raw_data        jsonb DEFAULT '{}',
  synced_at       timestamptz DEFAULT now(),
  UNIQUE (artist_id, platform, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_platform_snapshots_artist_date
  ON platform_snapshots (artist_id, snapshot_date DESC);

-- Caché de datos Zernio que no tienen tabla propia
-- (best_posting_times, instagram_insights, youtube_insights, etc.)
CREATE TABLE IF NOT EXISTS zernio_sync_cache (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  artist_id  uuid NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  cache_key  text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}',
  synced_at  timestamptz DEFAULT now(),
  UNIQUE (artist_id, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_zernio_sync_cache_artist
  ON zernio_sync_cache (artist_id, cache_key);

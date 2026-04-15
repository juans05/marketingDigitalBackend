-- ============================================================
-- MIGRACIÓN: Columnas faltantes en tabla artists
-- Ejecutar en Supabase SQL Editor
-- ============================================================

-- Columnas de perfil del artista
ALTER TABLE artists ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE artists ADD COLUMN IF NOT EXISTS tiktok_url TEXT;
ALTER TABLE artists ADD COLUMN IF NOT EXISTS instagram_url TEXT;
ALTER TABLE artists ADD COLUMN IF NOT EXISTS youtube_url TEXT;

-- Columnas de IA (contexto para generación de contenido)
ALTER TABLE artists ADD COLUMN IF NOT EXISTS ai_genre TEXT;
ALTER TABLE artists ADD COLUMN IF NOT EXISTS ai_audience TEXT;
ALTER TABLE artists ADD COLUMN IF NOT EXISTS ai_tone TEXT;

-- Columna de modo de publicación
-- Valores: 'upload-post' | 'direct' | 'ayrshare'
ALTER TABLE artists ADD COLUMN IF NOT EXISTS publish_mode TEXT DEFAULT 'upload-post';

-- Columnas de autenticación directa con Meta (Instagram/Facebook)
ALTER TABLE artists ADD COLUMN IF NOT EXISTS instagram_user_id TEXT;
ALTER TABLE artists ADD COLUMN IF NOT EXISTS instagram_access_token TEXT;
ALTER TABLE artists ADD COLUMN IF NOT EXISTS instagram_token_expires_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE artists ADD COLUMN IF NOT EXISTS facebook_page_id TEXT;
ALTER TABLE artists ADD COLUMN IF NOT EXISTS facebook_access_token TEXT;

-- Columnas de autenticación en agencies (necesarias para login)
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT false;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS plan_type TEXT DEFAULT 'Free';

-- ============================================================
-- Verificar columnas resultantes:
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'artists' ORDER BY ordinal_position;
-- ============================================================

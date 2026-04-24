-- Migración para corregir esquema de tabla 'videos'
-- Añade columnas faltantes reportadas por la API y necesarias para el modelo móvil

-- 1. Asegurar columnas de metadatos y medios
ALTER TABLE videos ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS processed_url TEXT; -- Ya estaba pero asegurar
ALTER TABLE videos ADD COLUMN IF NOT EXISTS platform_urls JSONB DEFAULT '{}'::jsonb;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS format TEXT DEFAULT 'Reel';
ALTER TABLE videos ADD COLUMN IF NOT EXISTS post_type TEXT DEFAULT 'feed';

-- 2. Asegurar columnas de IA y Copy
ALTER TABLE videos ADD COLUMN IF NOT EXISTS ai_copy_short TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS ai_copy_long TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS hashtags TEXT; -- Almacenado como string separado por comas o JSON
ALTER TABLE videos ADD COLUMN IF NOT EXISTS error_log TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS viral_score_real INTEGER;

-- 3. Asegurar columnas de publicación y redes
ALTER TABLE videos ADD COLUMN IF NOT EXISTS platforms TEXT; -- Almacenado como string o array
ALTER TABLE videos ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS published_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS ayrshare_post_id TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS analytics_4h JSONB DEFAULT '{}'::jsonb;

-- 4. Notificar a PostgREST para recargar el esquema (IMPORTANTE para corregir el error de caché)
NOTIFY pgrst, 'reload schema';

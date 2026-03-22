-- Migración para soportar Clips, Programación y Hashtags
ALTER TABLE videos ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS hashtags TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS parent_video_id UUID REFERENCES videos(id) ON DELETE CASCADE;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS ai_clips_data JSONB; -- Para guardar los momentos divertidos detectados

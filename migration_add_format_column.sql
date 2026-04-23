-- Migración: Agregar campo 'format' para el tipo de publicación (Reel, Story, Post, etc.)
-- Ejecutar en Supabase SQL Editor

ALTER TABLE videos 
ADD COLUMN IF NOT EXISTS format TEXT DEFAULT 'Reel';

-- Comentario: values posibles: 'Reel', 'Story', 'Post', 'TikTok', 'YouTube Short'

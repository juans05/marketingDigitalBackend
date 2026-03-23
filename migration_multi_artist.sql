-- ============================================================
-- MIGRACIÓN: Soporte Multi-Artista + Artista Solo
-- Ejecutar en Supabase SQL Editor
-- ============================================================

-- 1. Agregar email y tipo de cuenta a agencies
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS account_type TEXT DEFAULT 'agency';
-- account_type: 'agency' (tiene varios artistas) | 'artist' (artista solo)

-- 2. Mover redes sociales al nivel de ARTISTA
--    (cada artista tiene sus propias cuentas conectadas)
ALTER TABLE artists ADD COLUMN IF NOT EXISTS ayrshare_profile_key TEXT;
ALTER TABLE artists ADD COLUMN IF NOT EXISTS active_platforms TEXT[] DEFAULT '{}';

-- 3. Índice para búsqueda rápida por email
CREATE INDEX IF NOT EXISTS idx_agencies_email ON agencies(email);
CREATE INDEX IF NOT EXISTS idx_artists_agency_id ON artists(agency_id);

-- ============================================================
-- NOTA: Las columnas ayrshare_profile_key y active_platforms
-- de la tabla agencies quedan en desuso pero no se eliminan
-- para no romper datos existentes.
-- ============================================================

-- ============================================
-- VIDALIS.AI - Configuración de Base de Datos
-- Ejecutar en Supabase > SQL Editor
-- ============================================

-- 0. Habilitar extensión UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Crear tabla de AGENCIAS (Empresas)
CREATE TABLE agencies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  logo_url TEXT,
  plan_type TEXT DEFAULT 'Pro',
  stripe_customer_id TEXT,
  ayrshare_profile_key TEXT,
  active_platforms TEXT[] DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 2. Crear tabla de ARTISTAS (Perfiles)
CREATE TABLE artists (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agency_id UUID REFERENCES agencies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  social_keys JSONB DEFAULT '{}'::jsonb,
  branding_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 3. Crear tabla de VIDEOS
CREATE TABLE videos (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  artist_id UUID REFERENCES artists(id) ON DELETE CASCADE,
  title TEXT,
  source_url TEXT NOT NULL,
  processed_url TEXT,
  viral_score INTEGER,
  transcript TEXT,
  status TEXT DEFAULT 'uploading',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 4. POLÍTICAS DE SEGURIDAD (RLS)
-- Habilitamos RLS pero con política permisiva para el MVP
ALTER TABLE agencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE artists ENABLE ROW LEVEL SECURITY;
ALTER TABLE videos ENABLE ROW LEVEL SECURITY;

-- Política temporal: Permite todas las operaciones con la anon key (MVP)
-- En producción, restringir por auth.uid()
CREATE POLICY "Permitir todo para MVP" ON agencies FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Permitir todo para MVP" ON artists FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Permitir todo para MVP" ON videos FOR ALL USING (true) WITH CHECK (true);

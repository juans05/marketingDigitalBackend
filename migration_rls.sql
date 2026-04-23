-- =============================================================================
-- ROW LEVEL SECURITY — Vidalis Backend
-- =============================================================================
-- Ejecutar en Supabase > SQL Editor.
--
-- ARQUITECTURA DE SEGURIDAD:
--   • El backend Node.js usa SUPABASE_SERVICE_ROLE_KEY → bypassa RLS.
--     Toda la autorización pasa por los middlewares (authorizeArtist, authorizeVideo).
--   • Las políticas siguientes protegen acceso directo a Supabase (anon key o
--     user JWT) como segunda capa de defensa.
--   • Para que auth.jwt() ->> 'id' funcione con tu JWT custom, el JWT secret
--     de tu proyecto Supabase (Settings → API → JWT Settings) debe coincidir
--     con el valor de JWT_SECRET en tu .env.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. HABILITAR RLS EN TODAS LAS TABLAS (si no está activo ya)
-- -----------------------------------------------------------------------------
ALTER TABLE agencies                ENABLE ROW LEVEL SECURITY;
ALTER TABLE artists                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE videos                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_metrics_snapshots  ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_insights_log  ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 1. ELIMINAR POLÍTICAS PERMISIVAS DEL MVP
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Permitir todo para MVP" ON agencies;
DROP POLICY IF EXISTS "Permitir todo para MVP" ON artists;
DROP POLICY IF EXISTS "Permitir todo para MVP" ON videos;
DROP POLICY IF EXISTS "Permitir todo para MVP" ON post_metrics_snapshots;
DROP POLICY IF EXISTS "Permitir todo para MVP" ON analytics_insights_log;

-- Eliminar cualquier política anterior de este script para idempotencia
DROP POLICY IF EXISTS "rls_agencies_own"          ON agencies;
DROP POLICY IF EXISTS "rls_artists_own"           ON artists;
DROP POLICY IF EXISTS "rls_videos_own"            ON videos;
DROP POLICY IF EXISTS "rls_metrics_own"           ON post_metrics_snapshots;
DROP POLICY IF EXISTS "rls_insights_own"          ON analytics_insights_log;

-- -----------------------------------------------------------------------------
-- 2. FUNCIÓN AUXILIAR — obtener agency_id del JWT custom
-- -----------------------------------------------------------------------------
-- El JWT del backend tiene claim "id" = agency UUID.
-- auth.jwt() ->> 'id' lo extrae como texto; se castea a uuid para comparar.
CREATE OR REPLACE FUNCTION auth.agency_id() RETURNS uuid
  LANGUAGE sql STABLE
AS $$
  SELECT (auth.jwt() ->> 'id')::uuid;
$$;

-- -----------------------------------------------------------------------------
-- 3. POLÍTICA: AGENCIES
--    Un usuario solo puede ver y modificar su propia fila en agencies.
-- -----------------------------------------------------------------------------
CREATE POLICY "rls_agencies_own" ON agencies
  FOR ALL
  USING      (id = auth.agency_id())
  WITH CHECK (id = auth.agency_id());

-- -----------------------------------------------------------------------------
-- 4. POLÍTICA: ARTISTS
--    Solo los artistas que pertenecen al agency del token.
-- -----------------------------------------------------------------------------
CREATE POLICY "rls_artists_own" ON artists
  FOR ALL
  USING      (agency_id = auth.agency_id())
  WITH CHECK (agency_id = auth.agency_id());

-- -----------------------------------------------------------------------------
-- 5. POLÍTICA: VIDEOS
--    Solo los videos cuyo artista pertenece al agency del token.
-- -----------------------------------------------------------------------------
CREATE POLICY "rls_videos_own" ON videos
  FOR ALL
  USING (
    artist_id IN (
      SELECT id FROM artists WHERE agency_id = auth.agency_id()
    )
  )
  WITH CHECK (
    artist_id IN (
      SELECT id FROM artists WHERE agency_id = auth.agency_id()
    )
  );

-- -----------------------------------------------------------------------------
-- 6. POLÍTICA: POST_METRICS_SNAPSHOTS
--    Solo métricas de artistas propios.
-- -----------------------------------------------------------------------------
CREATE POLICY "rls_metrics_own" ON post_metrics_snapshots
  FOR ALL
  USING (
    artist_id IN (
      SELECT id FROM artists WHERE agency_id = auth.agency_id()
    )
  )
  WITH CHECK (
    artist_id IN (
      SELECT id FROM artists WHERE agency_id = auth.agency_id()
    )
  );

-- -----------------------------------------------------------------------------
-- 7. POLÍTICA: ANALYTICS_INSIGHTS_LOG
--    Solo insights de artistas propios.
-- -----------------------------------------------------------------------------
CREATE POLICY "rls_insights_own" ON analytics_insights_log
  FOR ALL
  USING (
    artist_id IN (
      SELECT id FROM artists WHERE agency_id = auth.agency_id()
    )
  )
  WITH CHECK (
    artist_id IN (
      SELECT id FROM artists WHERE agency_id = auth.agency_id()
    )
  );

-- -----------------------------------------------------------------------------
-- 8. VERIFICACIÓN (ejecutar después para confirmar)
-- -----------------------------------------------------------------------------
-- SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual
-- FROM pg_policies
-- WHERE tablename IN ('agencies','artists','videos','post_metrics_snapshots','analytics_insights_log')
-- ORDER BY tablename, policyname;

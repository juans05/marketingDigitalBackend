-- MIGRACIÓN: Agregar Seguridad de Contraseñas
-- Ejecutar en Supabase SQL Editor

ALTER TABLE agencies ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Opcional: Si quieres forzar que todas las cuentas nuevas tengan password
-- ALTER TABLE agencies ALTER COLUMN password_hash SET NOT NULL;

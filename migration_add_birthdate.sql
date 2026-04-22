-- MIGRACIÓN: Agregar campo de fecha de nacimiento a la tabla agencies
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS birth_date DATE;

-- Comentario informativo
COMMENT ON COLUMN agencies.birth_date IS 'Fecha de nacimiento del usuario (para cuentas individuales)';

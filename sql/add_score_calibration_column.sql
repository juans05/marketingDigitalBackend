-- Agrega columna para almacenar metadata de calibración del score viral.
-- Contiene: raw (score original del LLM), calibrated, confidence, adjustments.
ALTER TABLE videos ADD COLUMN IF NOT EXISTS score_calibration jsonb DEFAULT NULL;

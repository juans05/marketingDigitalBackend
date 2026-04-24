-- Migración para implementar el sistema de Sparks

-- 1. Añadir balance de sparks a la tabla de agencias
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS sparks_balance INTEGER DEFAULT 100;

-- 2. Asegurar que los nuevos registros tengan 100 de bienvenida (ya está en el DEFAULT, pero por si acaso)
-- 3. Crear tabla de transacciones de sparks (para historial y auditoría)
CREATE TABLE IF NOT EXISTS sparks_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agency_id UUID REFERENCES agencies(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL, -- Positivo (compra/bono) o negativo (gasto)
    type TEXT NOT NULL, -- 'welcome', 'upload', 'purchase', 'daily_bonus'
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 4. Función para descontar sparks (seguridad en el servidor)
-- No queremos que el cliente envíe el nuevo balance, sino que pida una operación
CREATE OR REPLACE FUNCTION deduct_sparks(target_agency_id UUID, cost INTEGER) 
RETURNS BOOLEAN AS $$
DECLARE
    current_balance INTEGER;
BEGIN
    SELECT sparks_balance INTO current_balance FROM agencies WHERE id = target_agency_id;
    
    IF current_balance >= cost THEN
        UPDATE agencies SET sparks_balance = sparks_balance - cost WHERE id = target_agency_id;
        INSERT INTO sparks_transactions (agency_id, amount, type, description) 
        VALUES (target_agency_id, -cost, 'spend', 'Gasto por operación');
        RETURN TRUE;
    ELSE
        RETURN FALSE;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Notificar recarga de esquema
NOTIFY pgrst, 'reload schema';

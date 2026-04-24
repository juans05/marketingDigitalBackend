-- Migración final para el sistema de Cupones (Sin expiración y multi-usos)

-- Asegurar que la tabla existe con la columna description
CREATE TABLE IF NOT EXISTS coupons (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code TEXT UNIQUE NOT NULL,
    discount_percent INTEGER DEFAULT 0,
    extra_sparks INTEGER DEFAULT 0,
    description TEXT,
    expires_at TIMESTAMP WITH TIME ZONE,
    max_usages INTEGER DEFAULT 9999,
    current_usages INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- Desactivar RLS para permitir acceso desde el backend
ALTER TABLE coupons DISABLE ROW LEVEL SECURITY;

-- Limpiar tabla e insertar cupones permanentes
TRUNCATE TABLE coupons;

INSERT INTO coupons (code, extra_sparks, description, max_usages) 
VALUES 
('VIDALIS100', 110, 'Recarga especial para recuperación', 99999),
('SPARK_BOOST', 100, 'Impulso de energía estándar', 99999),
('VIDALIS2026', 50, 'Cupón de bienvenida Vidalis', 99999),
('INVITADO', 25, 'Código de invitado', 99999);

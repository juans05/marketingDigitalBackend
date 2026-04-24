-- Migración para el sistema de Cupones de Descuento / Promo Codes

CREATE TABLE IF NOT EXISTS coupons (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code TEXT UNIQUE NOT NULL,
    discount_percent INTEGER DEFAULT 0, -- Si es para rebajar precio (opcional)
    extra_sparks INTEGER DEFAULT 0, -- Si regala sparks directamente
    expires_at TIMESTAMP WITH TIME ZONE,
    max_usages INTEGER DEFAULT 9999,
    current_usages INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- Insertar un cupón de prueba
INSERT INTO coupons (code, extra_sparks, description) 
VALUES ('VIDALIS2026', 50, 'Cupón de bienvenida de 50 Sparks gratis');

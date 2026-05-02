-- =====================================================
-- SCRIPT PARA CREAR TABLA currencies
-- =====================================================
-- Este script crea la tabla de monedas con datos iniciales

-- Crear tabla currencies
CREATE TABLE IF NOT EXISTS currencies (
    code VARCHAR(3) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    name_es VARCHAR(100),
    symbol VARCHAR(10),
    decimal_places INTEGER DEFAULT 2,
    is_active BOOLEAN DEFAULT true,
    odoo_currency_id INTEGER,
    country VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Crear índices
CREATE INDEX IF NOT EXISTS idx_currencies_is_active ON currencies (is_active);
CREATE INDEX IF NOT EXISTS idx_currencies_odoo_id ON currencies (odoo_currency_id);

-- Habilitar RLS
ALTER TABLE currencies ENABLE ROW LEVEL SECURITY;

-- Política RLS: Todos pueden leer monedas activas
CREATE POLICY "Anyone can view active currencies" ON currencies
    FOR SELECT USING (is_active = true);

-- Política RLS: Solo usuarios autenticados pueden ver todas las monedas
CREATE POLICY "Authenticated users can view all currencies" ON currencies
    FOR SELECT USING (auth.role() = 'authenticated');

-- Insertar monedas iniciales
INSERT INTO currencies (code, name, name_es, symbol, decimal_places, is_active, odoo_currency_id, country) VALUES
    ('USD', 'US Dollar', 'Dólar Estadounidense', '$', 2, true, 2, 'United States'),
    ('CLP', 'Chilean Peso', 'Peso Chileno', '$', 0, true, 34, 'Chile'),
    ('CLF', 'Chilean Unit of Account (UF)', 'Unidad de Fomento', 'UF', 2, true, 158, 'Chile'),
    ('MXN', 'Mexican Peso', 'Peso Mexicano', '$', 2, true, 49, 'Mexico'),
    ('COP', 'Colombian Peso', 'Peso Colombiano', '$', 0, true, 37, 'Colombia'),
    ('PEN', 'Peruvian Sol', 'Sol Peruano', 'S/', 2, true, 135, 'Peru'),
    ('EUR', 'Euro', 'Euro', '€', 2, true, 1, 'European Union'),
    ('UYU', 'Uruguayan Peso', 'Peso Uruguayo', '$', 2, true, 162, 'Uruguay')
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    name_es = EXCLUDED.name_es,
    symbol = EXCLUDED.symbol,
    decimal_places = EXCLUDED.decimal_places,
    is_active = EXCLUDED.is_active,
    odoo_currency_id = EXCLUDED.odoo_currency_id,
    country = EXCLUDED.country,
    updated_at = NOW();

-- Verificar que la tabla se creó correctamente
SELECT 
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns 
WHERE table_name = 'currencies' 
  AND table_schema = 'public'
ORDER BY ordinal_position;

-- Verificar datos insertados
SELECT * FROM currencies ORDER BY code;

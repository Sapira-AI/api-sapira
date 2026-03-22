-- Verificar constraints en tabla invoices

-- 1. Ver la definición del constraint de document_type
SELECT 
    conname AS constraint_name,
    pg_get_constraintdef(oid) AS constraint_definition
FROM pg_constraint
WHERE conrelid = 'invoices'::regclass
    AND conname LIKE '%document_type%';

-- 1b. Ver la definición del constraint de status
SELECT 
    conname AS constraint_name,
    pg_get_constraintdef(oid) AS constraint_definition
FROM pg_constraint
WHERE conrelid = 'invoices'::regclass
    AND conname LIKE '%status%';

-- 2. Ver valores únicos de document_type en invoices existentes
SELECT DISTINCT document_type, COUNT(*) as count
FROM invoices
GROUP BY document_type
ORDER BY count DESC;

-- 2b. Ver valores únicos de status en invoices existentes
SELECT DISTINCT status, COUNT(*) as count
FROM invoices
GROUP BY status
ORDER BY count DESC;

-- 3. Ver ejemplos de facturas existentes
SELECT 
    id,
    invoice_number,
    document_type,
    invoice_type,
    invoice_series,
    payment_method,
    status
FROM invoices
LIMIT 10;

# 🚀 Guía Rápida: Corregir Error de Taxes Incompatibles

## ✅ El Sistema Detectó el Problema

```
❌ Factura tiene taxes incompatibles:
   Company ID solicitado: 4 (SimpliRoute S.A.P.I DE C.V - México)
   Taxes inválidos: 1, 19, 40, 80, 84, 116

   Problema: Los taxes pertenecen a otras empresas:
   - Tax 1 → Compañía 1 (Chile)
   - Tax 19 → Compañía 2 (Perú)
   - Tax 40, 80, 84 → Compañía 3 (Colombia)
   - Tax 116 → Compañía 5
```

## 🔧 Solución en 4 Pasos

### Paso 1: Consultar Taxes Correctos para México

Usa curl o Postman para consultar los taxes disponibles:

```bash
curl -X GET "http://localhost:3000/odoo/taxes/4?company_id=4" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "x-holding-id: 5652e95e-bb99-48f5-aa1c-13c8c2638fc6"
```

**Busca el tax de IVA 16% para México**, algo como:

```json
{
	"id": 91,
	"name": "IVA(16%) VENTAS",
	"company_id": [4, "SimpliRoute S.A.P.I DE C.V"],
	"amount": 16.0
}
```

### Paso 2: Crear Backup

```sql
CREATE TABLE odoo_product_mappings_backup_20260422 AS
SELECT * FROM odoo_product_mappings
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6';
```

### Paso 3: Actualizar los Mapeos

Reemplaza `91` con el tax_id correcto que encontraste en el Paso 1:

```sql
-- Para los dos productos específicos del error:
UPDATE odoo_product_mappings
SET metadata = jsonb_set(
    COALESCE(metadata, '{}'::jsonb),
    '{odoo_tax_ids}',
    '"91"'  -- ⚠️ REEMPLAZAR con el tax_id correcto
)
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
  AND sapira_product_id IN (
    '89e1c03c-fa42-4436-9aec-3a60e8cc5095',
    '7ffc00a7-f560-4d69-91ad-46784b52b861'
  );
```

### Paso 4: Verificar y Probar

```sql
-- Verificar que se actualizó correctamente
SELECT
    p.name as product_name,
    opm.metadata->>'odoo_tax_ids' as tax_ids
FROM odoo_product_mappings opm
LEFT JOIN products p ON p.id = opm.sapira_product_id
WHERE opm.sapira_product_id IN (
    '89e1c03c-fa42-4436-9aec-3a60e8cc5095',
    '7ffc00a7-f560-4d69-91ad-46784b52b861'
);
```

Luego intenta enviar la factura nuevamente. Deberías ver:

```
✅ Todos los taxes son válidos para company_id 4
📤 Enviando factura a Odoo...
```

## 🎯 Alternativa: Validar Antes de Actualizar

Puedes validar el tax_id antes de actualizar la base de datos:

```bash
curl -X POST "http://localhost:3000/odoo/validate-invoice-data" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "x-holding-id: 5652e95e-bb99-48f5-aa1c-13c8c2638fc6" \
  -H "Content-Type: application/json" \
  -d '{
    "company_id": 4,
    "invoice_line_ids": [
      {
        "product_id": 486,
        "quantity": 1,
        "price_unit": 100,
        "tax_ids": [91]
      }
    ]
  }'
```

Si la respuesta es `"success": true`, entonces el tax_id 91 es correcto.

## 📋 Checklist

-   [ ] Consulté los taxes disponibles para company_id 4
-   [ ] Identifiqué el tax_id correcto (IVA 16% México)
-   [ ] Creé backup de los mapeos
-   [ ] Actualicé los mapeos con el tax correcto
-   [ ] Verifiqué que se actualizó correctamente
-   [ ] Probé enviar la factura nuevamente
-   [ ] La factura se envió exitosamente ✅

## 🆘 Si Algo Sale Mal

Restaurar desde el backup:

```sql
DELETE FROM odoo_product_mappings
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6';

INSERT INTO odoo_product_mappings
SELECT * FROM odoo_product_mappings_backup_20260422;
```

## 💡 Para Prevenir en el Futuro

1. **Siempre validar antes de guardar mapeos** usando el endpoint `/odoo/validate-invoice-data`
2. **Documentar los tax_ids correctos** por empresa/país
3. **Usar un solo tax por producto** (en la mayoría de casos)
4. **Revisar los logs** antes de enviar facturas masivas

## 📞 Recursos

-   Documentación completa: `docs/debugging/TAX-COMPANY-MISMATCH.md`
-   Queries SQL: `docs/debugging/tax-company-mismatch-queries.sql`
-   Script específico México: `docs/debugging/fix-mexico-taxes.sql`

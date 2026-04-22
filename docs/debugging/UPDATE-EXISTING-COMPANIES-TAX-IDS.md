# Actualizar Tax IDs de Compañías Existentes

Después de implementar la nueva funcionalidad de obtener tax_ids desde la compañía, necesitas actualizar las compañías que ya están mapeadas.

## Opción 1: Re-mapear las Compañías (Recomendado)

La forma más fácil es simplemente **volver a mapear las compañías** usando el endpoint existente. Esto automáticamente consultará y guardará los tax_ids de Odoo.

### Pasos:

1. **Consultar compañías de Odoo**:

    ```bash
    GET /odoo/companies?connection_id={connection_id}
    ```

2. **Re-mapear las compañías** (usa el mismo mapeo que ya tienes):
    ```bash
    POST /odoo/map-companies
    {
      "holding_id": "5652e95e-bb99-48f5-aa1c-13c8c2638fc6",
      "mappings": [
        {
          "sapira_company_id": "8c9e0ed2-2d8b-454a-b243-c0c3c4125b58",
          "odoo_company_id": 4,
          "tax_rate": 16
        }
      ]
    }
    ```

El sistema automáticamente:

-   Consultará Odoo para obtener el `account_sale_tax_id` de la compañía 4
-   Guardará el valor en `companies.odoo_default_sale_tax_id`

## Opción 2: Script SQL Manual

Si prefieres actualizar directamente en la base de datos:

### Para México (SimpliRoute S.A.P.I DE C.V)

```sql
-- Actualizar compañía de México con tax_id 91 (IVA 16%)
UPDATE companies
SET
  odoo_default_sale_tax_id = 91,
  odoo_default_purchase_tax_id = 99
WHERE
  holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
  AND odoo_integration_id = 4;
```

### Para Chile (SIMPLIT SPA)

```sql
-- Actualizar compañía de Chile con tax_id 1 (IVA 19%)
UPDATE companies
SET
  odoo_default_sale_tax_id = 1,
  odoo_default_purchase_tax_id = 2
WHERE
  holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
  AND odoo_integration_id = 1;
```

### Para Perú (Simpliroute S.A.C)

```sql
-- Actualizar compañía de Perú con tax_id 19 (18%)
UPDATE companies
SET
  odoo_default_sale_tax_id = 19,
  odoo_default_purchase_tax_id = 24
WHERE
  holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
  AND odoo_integration_id = 2;
```

### Para Colombia (Simpliroute SAS)

```sql
-- Actualizar compañía de Colombia con tax_id 38 (IVA 19%)
UPDATE companies
SET
  odoo_default_sale_tax_id = 38,
  odoo_default_purchase_tax_id = 31
WHERE
  holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
  AND odoo_integration_id = 3;
```

### Para Uruguay (SimpliRoute S.A.S)

```sql
-- Actualizar compañía de Uruguay con tax_id 116 (22%)
UPDATE companies
SET
  odoo_default_sale_tax_id = 116,
  odoo_default_purchase_tax_id = 119
WHERE
  holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
  AND odoo_integration_id = 5;
```

## Verificar Actualización

```sql
SELECT
  id,
  legal_name,
  odoo_integration_id,
  odoo_default_sale_tax_id,
  odoo_default_purchase_tax_id,
  tax_rate
FROM companies
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
  AND odoo_integration_id IS NOT NULL
ORDER BY odoo_integration_id;
```

Deberías ver algo como:

| legal_name                 | odoo_integration_id | odoo_default_sale_tax_id | tax_rate |
| -------------------------- | ------------------- | ------------------------ | -------- |
| Simplit SpA                | 1                   | 1                        | 19       |
| SimpliRoute S.A.C          | 2                   | 19                       | 18       |
| SimpliRoute S.A.S          | 3                   | 38                       | 19       |
| SimpliRoute S.A.P.I DE C.V | 4                   | 91                       | 16       |
| SimpliRoute S.A.S          | 5                   | 116                      | 22       |

## Probar el Cambio

Después de actualizar, intenta enviar una factura nuevamente:

```bash
POST /invoices/scheduler/send
{
  "holding_id": "5652e95e-bb99-48f5-aa1c-13c8c2638fc6",
  "contract_id": "16b1f1ba-6911-4975-9c6f-68df287a9f6e",
  "dry_run": false
}
```

Deberías ver en los logs:

```
Factura INV-XXX: usando tax_id de compañía SimpliRoute S.A.P.I DE C.V - odoo_default_sale_tax_id=91
✅ Todos los taxes son válidos para company_id 4
📤 Enviando factura a Odoo...
```

## Limpiar Mapeos de Productos (Opcional)

Una vez que las compañías tengan sus tax_ids configurados, puedes limpiar los tax_ids incorrectos de los mapeos de productos:

```sql
-- Limpiar tax_ids de todos los mapeos de productos
UPDATE odoo_product_mappings
SET metadata = metadata - 'odoo_tax_ids'
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6';
```

Esto hará que todos los productos usen el tax_id de la compañía por defecto, que es el comportamiento correcto.

## Notas Importantes

-   ✅ Después de esta actualización, **NO necesitas configurar tax_ids en los productos**
-   ✅ El tax_id se obtiene automáticamente de la compañía emisora
-   ✅ Solo configura tax_ids en productos para casos especiales (productos exentos, etc.)
-   ✅ Al re-mapear compañías en el futuro, los tax_ids se actualizarán automáticamente

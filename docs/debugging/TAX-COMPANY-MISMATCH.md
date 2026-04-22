# Guía de Debugging: Error de Empresas Incompatibles en Odoo

## 📋 Descripción del Problema

El error "Empresas incompatibles con los registros" ocurre cuando intentas crear una factura en Odoo y los `tax_ids` (impuestos) configurados en las líneas de la factura pertenecen a una empresa diferente al `company_id` especificado en la factura.

### Ejemplo del Error

```
XML-RPC Fault: Empresas incompatibles con los registros:
- 'PATHFINDER+ - Periodo 19/04/2026 a 18/05/2026' le pertenece a 'SimpliRoute'
  y 'Taxes' (tax_ids: 'IVA 19% Venta', '18%', 'IVA Excento', 'RteFte -3.50% Ventas',
  'RteICA 0.966% Ventas', 'IVA(16%) VENTAS', '22%') le pertenece a otra empresa.
```

## 🔍 Sistema de Debugging Implementado

### 1. Logs Detallados

El sistema ahora registra información completa antes de enviar facturas a Odoo:

```
🔍 ===== PAYLOAD COMPLETO PARA ODOO =====
📍 Company ID: 1
👤 Partner ID: 123
📅 Invoice Date: 2026-04-22
💰 Currency ID: 49
📦 LÍNEAS DE FACTURA (2 items):
  Línea 1:
    - Product ID: 486
    - Name: PATHFINDER+ - Periodo 19/04/2026 a 18/05/2026
    - Quantity: 1
    - Price Unit: 100
    - Tax IDs: [1, 19, 40, 80, 84, 91, 116]
```

### 2. Validación Automática

Antes de enviar la factura a Odoo, el sistema valida que todos los taxes pertenezcan a la empresa correcta:

```
🔍 Validando 7 taxes únicos para company_id 1...
✅ Todos los taxes son válidos para company_id 1
```

Si hay taxes incompatibles:

```
❌ Factura INV-001 tiene taxes incompatibles:
   Company ID solicitado: 1
   Taxes inválidos: 19, 40, 80, 84, 91, 116
   Detalles: Tax ID 19 (IVA 19% Venta) pertenece a compañía 2 (SimpliRoute Colombia)
```

### 3. Endpoints de Diagnóstico

#### GET `/odoo/taxes/:companyId`

Consulta todos los taxes disponibles para una compañía específica.

**Parámetros:**

-   `company_id` (query): ID de la compañía en Odoo
-   `x-holding-id` (header): ID del holding

**Respuesta:**

```json
{
	"success": true,
	"message": "Se encontraron 15 taxes para la compañía SimpliRoute México",
	"company_id": 1,
	"company_name": "SimpliRoute México",
	"taxes": [
		{
			"id": 1,
			"name": "IVA(16%) VENTAS",
			"display_name": "IVA(16%) VENTAS",
			"company_id": [1, "SimpliRoute México"],
			"amount": 16.0,
			"type_tax_use": "sale",
			"active": true
		}
	],
	"total": 15
}
```

#### POST `/odoo/validate-invoice-data`

Valida que los tax_ids de una factura sean compatibles con la compañía.

**Body:**

```json
{
	"company_id": 1,
	"invoice_line_ids": [
		{
			"product_id": 486,
			"quantity": 1,
			"price_unit": 100,
			"tax_ids": [1, 19, 40]
		}
	]
}
```

**Respuesta (éxito):**

```json
{
	"success": true,
	"message": "Todos los taxes son válidos para la compañía 1",
	"company_id": 1,
	"tax_validations": [
		{
			"tax_id": 1,
			"name": "IVA(16%) VENTAS",
			"company_id": 1,
			"company_name": "SimpliRoute México",
			"is_valid": true
		}
	],
	"invalid_tax_ids": []
}
```

**Respuesta (error):**

```json
{
	"success": false,
	"message": "Se encontraron 2 taxes incompatibles con la compañía 1",
	"company_id": 1,
	"tax_validations": [
		{
			"tax_id": 19,
			"name": "IVA 19% Venta",
			"company_id": 2,
			"company_name": "SimpliRoute Colombia",
			"is_valid": false
		}
	],
	"invalid_tax_ids": [19, 40]
}
```

## 🛠️ Cómo Resolver el Problema

### Paso 1: Identificar los Mapeos Incorrectos

Usa las queries SQL en `docs/debugging/tax-company-mismatch-queries.sql`:

```sql
-- Ver mapeos con múltiples taxes (posiblemente incorrectos)
SELECT
    opm.id,
    opm.sapira_product_id,
    p.name as product_name,
    opm.odoo_product_id,
    opm.metadata->>'odoo_tax_ids' as tax_ids
FROM odoo_product_mappings opm
LEFT JOIN products p ON p.id = opm.sapira_product_id
WHERE array_length(string_to_array(opm.metadata->>'odoo_tax_ids', ','), 1) > 3;
```

### Paso 2: Consultar Taxes Disponibles

Usa el endpoint para ver qué taxes están disponibles para la compañía:

```bash
curl -X GET "https://api.sapira.ai/odoo/taxes/1?company_id=1" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "x-holding-id: YOUR_HOLDING_ID"
```

### Paso 3: Corregir el Mapeo

Actualiza el mapeo con los tax_ids correctos:

```sql
-- Para un solo tax (más común)
UPDATE odoo_product_mappings
SET metadata = jsonb_set(metadata, '{odoo_tax_ids}', '"1"')
WHERE id = 'MAPPING_ID';

-- Para múltiples taxes de la misma empresa
UPDATE odoo_product_mappings
SET metadata = jsonb_set(metadata, '{odoo_tax_ids}', '"1,2,3"')
WHERE id = 'MAPPING_ID';
```

### Paso 4: Validar Antes de Enviar

Usa el endpoint de validación para verificar:

```bash
curl -X POST "https://api.sapira.ai/odoo/validate-invoice-data" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "x-holding-id: YOUR_HOLDING_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "company_id": 1,
    "invoice_line_ids": [
      {
        "product_id": 486,
        "quantity": 1,
        "price_unit": 100,
        "tax_ids": [1]
      }
    ]
  }'
```

## 📊 Logs Mejorados

### En invoice-scheduler.service.ts

```
🔵 INICIO sendInvoiceToOdoo - Factura e733fa90-bab9-4ef3-9158-1ae5650bfa98
   clientEntity: SÍ (BUSCALIBRE MEXICO)
   company: SÍ (SimpliRoute S.A.P.I DE C.V)
📝 Asignando nombres - clientEntity: existe, company: existe
   ✓ clientName asignado: BUSCALIBRE MEXICO
   ✓ companyName asignado: SimpliRoute S.A.P.I DE C.V
🔍 Validando 7 taxes únicos para company_id 1...
❌ Factura INV-001 tiene taxes incompatibles:
   Company ID solicitado: 1
   Taxes inválidos: 19, 40, 80, 84, 91, 116
```

### En odoo-invoices.service.ts

```
🔍 ===== PAYLOAD COMPLETO PARA ODOO =====
📍 Company ID: 1
👤 Partner ID: 123
📦 LÍNEAS DE FACTURA (2 items):
  Línea 1:
    - Product ID: 486
    - Tax IDs: [1, 19, 40, 80, 84, 91, 116]
```

## 🎯 Mejores Prácticas

1. **Siempre validar antes de guardar mapeos**: Usa el endpoint de validación
2. **Un tax por producto (en la mayoría de casos)**: Evita mezclar taxes de diferentes empresas
3. **Backup antes de cambios masivos**: Crea tabla temporal con los datos originales
4. **Verificar por holding**: Cada holding puede tener diferentes configuraciones de Odoo
5. **Documentar los tax_ids correctos**: Mantén una tabla de referencia por país/empresa

## 🔗 Archivos Relacionados

-   `api-sapira-ai/src/modules/odoo/odoo-invoices.service.ts` - Validación y logs
-   `api-sapira-ai/src/modules/invoices/invoice-scheduler.service.ts` - Validación pre-envío
-   `api-sapira-ai/src/modules/odoo/odoo.controller.ts` - Endpoints de diagnóstico
-   `api-sapira-ai/src/modules/odoo/dtos/odoo.dto.ts` - DTOs de validación
-   `api-sapira-ai/docs/debugging/tax-company-mismatch-queries.sql` - Queries SQL

## 📝 Notas Importantes

-   Los tax_ids son específicos de cada instancia de Odoo
-   Diferentes empresas en Odoo tienen diferentes taxes
-   México, Colombia y Chile tienen configuraciones fiscales diferentes
-   El sistema ahora detecta estos errores ANTES de enviar a Odoo

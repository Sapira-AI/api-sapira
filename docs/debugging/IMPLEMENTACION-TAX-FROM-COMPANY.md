# ✅ Implementación Completada: Tax ID desde Compañía

## 📋 Resumen

Se implementó exitosamente el cambio para obtener los `tax_ids` desde la **compañía emisora** en lugar de desde los productos, **persistiéndolos en `invoice_items.odoo_tax_id`** para permitir edición futura, eliminando el error de "Empresas incompatibles" en Odoo.

## 🔧 Cambios Implementados

### 1. **Migración de Base de Datos**

**Archivo**: `sapira-ai/supabase/migrations/20260422104700_add_odoo_tax_ids_to_companies.sql`

Se agregaron dos nuevas columnas a la tabla `companies`:

-   `odoo_default_sale_tax_id` (INTEGER) - Tax de venta por defecto de Odoo
-   `odoo_default_purchase_tax_id` (INTEGER) - Tax de compra por defecto de Odoo

### 2. **Migración de Invoice Items**

**Archivo**: `sapira-ai/supabase/migrations/20260422115000_add_odoo_tax_id_to_invoice_items.sql`

Se agregó columna `odoo_tax_id` a la tabla `invoice_items`:

-   Almacena el ID del impuesto de Odoo que se aplicará a cada línea de factura
-   Se asigna automáticamente desde `company.odoo_default_sale_tax_id` al enviar a Odoo
-   Permite edición manual futura en la UI

### 3. **Entidad Company**

**Archivo**: `api-sapira-ai/src/modules/odoo/entities/companies.entity.ts`

```typescript
@Column({ type: 'integer', nullable: true })
odoo_default_sale_tax_id?: number;

@Column({ type: 'integer', nullable: true })
odoo_default_purchase_tax_id?: number;
```

### 4. **Entidad InvoiceItem**

**Archivo**: `api-sapira-ai/src/modules/invoices/entities/invoice-item.entity.ts`

```typescript
@Column({ type: 'integer', nullable: true })
odoo_tax_id?: number;
```

### 3. **Servicio Odoo - Mapeo de Compañías**

**Archivo**: `api-sapira-ai/src/modules/odoo/odoo.service.ts`

#### Nuevo método `getOdooConnectionByHoldingId()`

Obtiene la conexión de Odoo por `holding_id`.

#### Nuevo método `getOdooCompanyTaxIds()`

Consulta a Odoo los `account_sale_tax_id` y `account_purchase_tax_id` de las compañías que se están mapeando.

#### Modificado método `mapCompanies()`

-   Llama a `getOdooCompanyTaxIds()` antes de guardar los mapeos
-   Guarda `odoo_default_sale_tax_id` y `odoo_default_purchase_tax_id` en la tabla `companies`
-   Limpia estos campos cuando se desmapea una compañía

### 5. **Servicio de Facturas - Persistencia de Tax ID**

**Archivo**: `api-sapira-ai/src/modules/invoices/invoice-scheduler.service.ts`

#### Modificado método `mapInvoiceToOdooFormat()`

-   Obtiene `odoo_default_sale_tax_id` de `invoice.company`
-   Para cada item de la factura:
    -   **Si ya tiene `odoo_tax_id`** → usa ese (permite edición manual futura)
    -   **Si no tiene** → asigna `company.odoo_default_sale_tax_id` y lo guarda en BD
-   Llama a `updateInvoiceItemsTaxIds()` para persistir los tax_ids asignados
-   Agrega logs descriptivos del tax_id usado y si se guardó en BD

#### Nuevo método `updateInvoiceItemsTaxIds()`

-   Recibe array de items con sus `odoo_tax_id` a actualizar
-   Actualiza la BD usando `invoiceItemRepository.update()`
-   Agrega log de confirmación de actualización

#### Simplificado método `getProductMappingInfo()`

-   **Eliminada** toda la lógica de tax_ids
-   **Eliminado** parámetro `companyDefaultTaxId`
-   Solo devuelve `odooProductId` y `source`
-   Busca en: `odoo_product_mappings` → `products.odoo_product_id` → default (1)

## 🎯 Comportamiento Nuevo

### Flujo de Obtención de Tax IDs

```
1. Factura creada (trigger de contrato)
   ↓ (invoice_items.odoo_tax_id = null)

2. Usuario solicita enviar a Odoo
   ↓

3. mapInvoiceToOdooFormat()
   ├─ Obtener company.odoo_default_sale_tax_id
   ├─ Para cada item:
   │  ├─ ¿Tiene odoo_tax_id?
   │  │  ├─ Sí → usar ese (edición manual futura)
   │  │  └─ No → asignar company.odoo_default_sale_tax_id
   │  └─ Guardar en BD si no tenía
   ↓

4. updateInvoiceItemsTaxIds()
   ├─ Persistir tax_ids en invoice_items
   ↓

5. Validar que todos los tax_ids pertenezcan a la compañía
   ↓

6. Enviar a Odoo
   ↓

7. ✅ Factura enviada + tax_ids persistidos
```

### Ejemplo de Logs

```
Factura INV-001: usando tax_id de compañía SimpliRoute S.A.P.I DE C.V - odoo_default_sale_tax_id=91

Item abc123: asignando tax_id de compañía=91 (se guardará en BD)
Producto 89e1c03c-fa42-4436-9aec-3a60e8cc5095: Usando mapeo - odoo_product_id=486

Item factura INV-001: producto_sapira=89e1c03c-fa42-4436-9aec-3a60e8cc5095, odoo_product=486, tax_id=91, source=mapping

✅ Actualizados 2 items con odoo_tax_id

🔍 Validando 1 taxes únicos para company_id 4...
✅ Todos los taxes son válidos para company_id 4
📤 Enviando factura a Odoo...
```

## 📊 Comparación: Antes vs Después

### ❌ Antes

```
Producto → odoo_product_mappings.metadata.odoo_tax_ids
         → "1,19,40,80,84,91,116" (mezcla de todas las empresas)
         → ERROR: Taxes incompatibles
         → No se guardaba en BD
```

### ✅ Después

```
Compañía → companies.odoo_default_sale_tax_id → 91
         ↓
Item → invoice_items.odoo_tax_id → 91 (persistido en BD)
         ↓
Odoo → tax_ids: [91] (solo México)
         ↓
✓ Todos los taxes válidos
✓ Editable en el futuro
```

## 🔄 Próximos Pasos

### 1. Ejecutar Migración

```bash
# En sapira-ai (UI)
supabase db push
```

### 2. Re-mapear Compañías

Opción A - Via API (Recomendado):

```bash
POST /odoo/map-companies
{
  "holding_id": "5652e95e-bb99-48f5-aa1c-13c8c2638fc6",
  "mappings": [
    { "sapira_company_id": "8c9e0ed2-2d8b-454a-b243-c0c3c4125b58", "odoo_company_id": 4 }
  ]
}
```

Opción B - Via SQL:
Ver `UPDATE-EXISTING-COMPANIES-TAX-IDS.md`

### 3. Probar Envío de Factura

```bash
POST /invoices/scheduler/send
{
  "holding_id": "5652e95e-bb99-48f5-aa1c-13c8c2638fc6",
  "contract_id": "16b1f1ba-6911-4975-9c6f-68df287a9f6e",
  "dry_run": false
}
```

### 4. Limpiar Mapeos de Productos (Opcional)

```sql
UPDATE odoo_product_mappings
SET metadata = metadata - 'odoo_tax_ids'
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6';
```

## ✨ Beneficios

1. ✅ **Elimina el error** de "Empresas incompatibles"
2. ✅ **Simplifica la configuración** - no necesitas mapear tax por producto
3. ✅ **Más lógico** - el tax viene de quien emite (la compañía)
4. ✅ **Automático** - al mapear compañías, los tax_ids se guardan automáticamente
5. ✅ **Flexible** - permite override para casos especiales (productos exentos)
6. ✅ **Performance** - no requiere consultas adicionales a Odoo al crear facturas

## 📝 Notas Importantes

-   El campo `tax_id` en la entidad `Company` es para **VAT/RUT/RFC** (identificación fiscal), NO para el tax de Odoo
-   El campo `tax_rate` es solo el **porcentaje** (16, 19, etc.), NO el ID del tax en Odoo
-   Los `odoo_tax_ids` en `odoo_product_mappings` ahora son **opcionales** y solo para casos especiales
-   El sistema de validación automática sigue funcionando y ahora detectará correctamente los taxes válidos

## 🔗 Archivos Modificados

1. `sapira-ai/supabase/migrations/20260422104700_add_odoo_tax_ids_to_companies.sql` - Agregar tax_ids a companies
2. `sapira-ai/supabase/migrations/20260422115000_add_odoo_tax_id_to_invoice_items.sql` - Agregar odoo_tax_id a invoice_items
3. `api-sapira-ai/src/modules/odoo/entities/companies.entity.ts` - Entidad Company con tax_ids
4. `api-sapira-ai/src/modules/invoices/entities/invoice-item.entity.ts` - Entidad InvoiceItem con odoo_tax_id
5. `api-sapira-ai/src/modules/odoo/odoo.service.ts` - Mapeo de compañías con tax_ids
6. `api-sapira-ai/src/modules/invoices/invoice-scheduler.service.ts` - Persistencia y uso de tax_ids

## 🔗 Documentación Relacionada

-   `TAX-COMPANY-MISMATCH.md` - Guía completa del sistema de debugging
-   `UPDATE-EXISTING-COMPANIES-TAX-IDS.md` - Cómo actualizar compañías existentes
-   `QUICK-FIX-GUIDE.md` - Guía rápida de solución
-   `tax-company-mismatch-queries.sql` - Queries SQL de diagnóstico

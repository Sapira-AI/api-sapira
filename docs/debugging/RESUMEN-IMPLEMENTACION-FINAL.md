# ✅ Implementación Completada: Tax ID Persistido en Invoice Items

## 🎯 Objetivo Logrado

Se implementó exitosamente el sistema para **persistir el tax_id en `invoice_items`**, eliminando completamente la dependencia de los tax_ids de productos y permitiendo edición futura en la UI.

## 📦 Cambios Implementados

### 1. Base de Datos

#### Migración Companies (ya existente)

-   **Archivo**: `sapira-ai/supabase/migrations/20260422104700_add_odoo_tax_ids_to_companies.sql`
-   Agrega `odoo_default_sale_tax_id` y `odoo_default_purchase_tax_id` a `companies`

#### Migración Invoice Items (NUEVA)

-   **Archivo**: `sapira-ai/supabase/migrations/20260422115000_add_odoo_tax_id_to_invoice_items.sql`
-   Agrega `odoo_tax_id` a `invoice_items`
-   Permite persistir el tax ID que se enviará a Odoo

### 2. Entidades TypeORM

#### InvoiceItem Entity (MODIFICADA)

-   **Archivo**: `api-sapira-ai/src/modules/invoices/entities/invoice-item.entity.ts`
-   Agrega propiedad `odoo_tax_id?: number`

### 3. Servicio de Facturas (MODIFICADO)

#### `mapInvoiceToOdooFormat()` - Nueva Lógica

**Antes**:

```typescript
// Obtenía tax_ids desde productos (override)
const mappingInfo = await this.getProductMappingInfo(item.product_id, invoice.holding_id, companyDefaultTaxId);
taxIds = mappingInfo.odooTaxIds; // Podía tener [1,19,40,80,84,91,116]
```

**Después**:

```typescript
// 1. Si el item ya tiene odoo_tax_id → usar ese
if (item.odoo_tax_id) {
	taxId = item.odoo_tax_id;
}
// 2. Si no → usar tax de compañía y guardarlo
else {
	taxId = companyDefaultTaxId || 1;
	itemsToUpdate.push({ id: item.id, odoo_tax_id: taxId });
}

// Guardar en BD
if (itemsToUpdate.length > 0) {
	await this.updateInvoiceItemsTaxIds(itemsToUpdate);
}
```

#### `updateInvoiceItemsTaxIds()` - Nuevo Método

```typescript
private async updateInvoiceItemsTaxIds(items: Array<{ id: string; odoo_tax_id: number }>): Promise<void> {
    for (const item of items) {
        await this.invoiceItemRepository.update({ id: item.id }, { odoo_tax_id: item.odoo_tax_id });
    }
    this.logger.debug(`✅ Actualizados ${items.length} items con odoo_tax_id`);
}
```

#### `getProductMappingInfo()` - Simplificado

**Antes**:

```typescript
Promise<{
	odooProductId: number;
	odooTaxIds: number[]; // ← Eliminado
	source: 'mapping' | 'product_table' | 'default' | 'company_default' | 'product_override';
}>;
```

**Después**:

```typescript
Promise<{
	odooProductId: number;
	source: 'mapping' | 'product_table' | 'default';
}>;
// Solo obtiene odoo_product_id, SIN tax_ids
```

## 🔄 Flujo Completo

```
1. Factura creada (trigger de contrato)
   ↓
   invoice_items.odoo_tax_id = null

2. Usuario solicita enviar a Odoo
   ↓

3. mapInvoiceToOdooFormat()
   ├─ Obtener company.odoo_default_sale_tax_id (ej: 91)
   ├─ Para cada item:
   │  ├─ ¿Tiene odoo_tax_id?
   │  │  ├─ Sí → usar ese
   │  │  └─ No → asignar 91 y marcar para actualizar
   │  └─ Obtener odoo_product_id (sin tax_ids)
   ↓

4. updateInvoiceItemsTaxIds()
   ├─ UPDATE invoice_items SET odoo_tax_id = 91 WHERE id = ...
   ├─ Log: "✅ Actualizados 2 items con odoo_tax_id"
   ↓

5. Validar taxes (ahora todos son 91)
   ├─ ✅ Todos válidos para company_id 4
   ↓

6. Enviar a Odoo
   ├─ invoice_line_ids: [{ tax_ids: [91] }, { tax_ids: [91] }]
   ↓

7. ✅ Factura enviada exitosamente
   ✅ Tax IDs persistidos en BD
```

## 🎨 Ejemplo de Logs

```
Factura INV-001: usando tax_id de compañía SimpliRoute S.A.P.I DE C.V - odoo_default_sale_tax_id=91

Item abc-123: asignando tax_id de compañía=91 (se guardará en BD)
Producto 89e1c03c-fa42-4436-9aec-3a60e8cc5095: Usando mapeo - odoo_product_id=486
Item factura INV-001: producto_sapira=89e1c03c-fa42-4436-9aec-3a60e8cc5095, odoo_product=486, tax_id=91, source=mapping

Item def-456: asignando tax_id de compañía=91 (se guardará en BD)
Producto 7ffc00a7-f560-4d69-91ad-46784b52b861: Usando mapeo - odoo_product_id=484
Item factura INV-001: producto_sapira=7ffc00a7-f560-4d69-91ad-46784b52b861, odoo_product=484, tax_id=91, source=mapping

✅ Actualizados 2 items con odoo_tax_id

🔍 Validando 1 taxes únicos para company_id 4...
✅ Todos los taxes son válidos para company_id 4
📤 Enviando factura a Odoo...
✅ Factura creada en Odoo con ID: 12345
```

## ✨ Beneficios

1. ✅ **Elimina el error** "Empresas incompatibles"
2. ✅ **Persistencia** - tax_id guardado en BD para trazabilidad
3. ✅ **Editable** - permite edición manual futura en la UI
4. ✅ **Automático** - se asigna automáticamente al enviar si no está configurado
5. ✅ **Simplificado** - elimina lógica compleja de override de productos
6. ✅ **Correcto** - el tax viene de la compañía emisora, no del producto

## 📋 Próximos Pasos

### 1. Ejecutar Migraciones

```bash
cd sapira-ai
supabase db push
```

Esto ejecutará ambas migraciones:

-   `20260422104700_add_odoo_tax_ids_to_companies.sql`
-   `20260422115000_add_odoo_tax_id_to_invoice_items.sql`

### 2. Probar Envío de Factura

```bash
POST /invoices/scheduler/send
{
  "holding_id": "5652e95e-bb99-48f5-aa1c-13c8c2638fc6",
  "contract_id": "16b1f1ba-6911-4975-9c6f-68df287a9f6e",
  "dry_run": false
}
```

### 3. Verificar en BD

```sql
-- Ver tax_ids persistidos
SELECT
    ii.id,
    ii.description,
    ii.odoo_tax_id,
    i.invoice_number,
    c.legal_name as company_name,
    c.odoo_default_sale_tax_id
FROM invoice_items ii
JOIN invoices i ON i.id = ii.invoice_id
JOIN companies c ON c.id = i.company_id
WHERE i.holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
ORDER BY i.created_at DESC
LIMIT 10;
```

## 🔮 Fase Futura: Edición Manual en UI

En el futuro, se puede agregar funcionalidad en la UI para:

1. **Ver** el `odoo_tax_id` de cada item antes de enviar
2. **Editar** el tax_id de items específicos (ej: productos exentos)
3. **Validar** que el tax_id pertenezca a la compañía correcta

Ejemplo de UI:

```
Factura INV-001 - SimpliRoute México

Items:
┌─────────────────────────┬──────────┬──────────────┐
│ Descripción             │ Producto │ Tax ID       │
├─────────────────────────┼──────────┼──────────────┤
│ Servicio de Ruteo       │ 486      │ 91 (IVA 16%) │ [Editar]
│ Servicio de Tracking    │ 484      │ 91 (IVA 16%) │ [Editar]
└─────────────────────────┴──────────┴──────────────┘

[Enviar a Odoo]
```

## 📚 Documentación Relacionada

-   `IMPLEMENTACION-TAX-FROM-COMPANY.md` - Documentación completa de la implementación
-   `UPDATE-EXISTING-COMPANIES-TAX-IDS.md` - Cómo actualizar compañías existentes
-   `TAX-COMPANY-MISMATCH.md` - Guía de debugging del problema original
-   `remove-product-tax-override-3c3102.md` - Plan de implementación

## ✅ Estado Final

-   ✅ Migraciones creadas
-   ✅ Entidades actualizadas
-   ✅ Lógica de persistencia implementada
-   ✅ Lógica de override eliminada
-   ✅ Documentación actualizada
-   ⏳ Pendiente: Ejecutar migraciones en BD
-   ⏳ Pendiente: Probar envío de factura

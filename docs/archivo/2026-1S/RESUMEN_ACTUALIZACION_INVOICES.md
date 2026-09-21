# Resumen de Actualización: Triggers y Funciones de Invoices

**Fecha**: 5 de marzo de 2026

## 📋 Triggers Actualizados/Creados

### 1. ✅ `trg_assign_invoice_group_id`
- **Ubicación**: `src/databases/postgresql/triggers/trg_assign_invoice_group_id.sql`
- **Estado**: Ya existía, sin cambios necesarios
- **Función**: Asigna `invoice_group_id` automáticamente al insertar facturas

### 2. ✅ `trg_rsm_on_invoice_change` 
- **Ubicación**: `src/databases/postgresql/triggers/trg_rsm_on_invoice_change.sql`
- **Estado**: **CREADO NUEVO**
- **Función**: Reconstruye el Revenue Schedule cuando cambian facturas (INSERT/UPDATE/DELETE)

### 3. ✅ `trigger_auto_populate_invoice_fx_to_system`
- **Ubicación**: `src/databases/postgresql/triggers/trigger_auto_populate_invoice_fx_to_system.sql`
- **Estado**: Ya existía, sin cambios necesarios
- **Función**: Auto-popula campos FX de facturas

### 4. ✅ `trigger_auto_populate_invoice_tax_rate`
- **Ubicación**: `src/databases/postgresql/triggers/trigger_auto_populate_invoice_tax_rate.sql`
- **Estado**: Ya existía, sin cambios necesarios
- **Función**: Auto-popula `tax_rate` desde la compañía

### 5. ✅ `trigger_sync_invoice_items_on_invoice_update`
- **Ubicación**: `src/databases/postgresql/triggers/trigger_sync_invoice_items_on_invoice_update.sql`
- **Estado**: Ya existía, sin cambios necesarios
- **Función**: Sincroniza `status` e `issue_date` de items cuando cambia la factura

---

## 🔧 Funciones Actualizadas

### 1. ✅ `assign_invoice_group_id()`
- **Ubicación**: `src/databases/postgresql/functions/assign_invoice_group_id.sql`
- **Estado**: Ya estaba actualizada correctamente
- **Cambios**: Usa `document_type = 'NC'` para detectar notas de crédito

### 2. ✅ `auto_populate_invoice_fx_to_system()`
- **Ubicación**: `src/databases/postgresql/functions/auto_populate_invoice_fx_to_system.sql`
- **Estado**: Ya estaba actualizada con los FIX correctos
- **Cambios Importantes**:
  - ✅ **DIVIDE** en lugar de multiplicar para convertir moneda → USD
  - ✅ Calcula `total_system_currency` con `tax_rate` en porcentaje (0-100)
  - ✅ Usa `ROUND()` para redondear a 2 decimales
  - ✅ Usa `NULLIF()` para evitar división por cero

### 3. ✅ `auto_populate_invoice_tax_rate()`
- **Ubicación**: `src/databases/postgresql/functions/auto_populate_invoice_tax_rate.sql`
- **Estado**: Actualizada (cambio de formato)
- **Cambios**: Cambió delimitador de `$$` a `$function$` para consistencia

### 4. ✅ `sync_invoice_items_on_invoice_update()`
- **Ubicación**: `src/databases/postgresql/functions/sync_invoice_items_on_invoice_update.sql`
- **Estado**: Ya estaba actualizada correctamente
- **Función**: Sincroniza campos de items cuando cambia la factura padre

### 5. ✅ `trigger_rsm_on_invoice_change()`
- **Ubicación**: `src/databases/postgresql/functions/trigger_rsm_on_invoice_change.sql`
- **Estado**: Actualizada (cambio de formato)
- **Cambios**: Cambió delimitador de `$$` a `$function$` para consistencia
- **Función**: Lógica completa para reconstruir RSM cuando cambian facturas

---

## 📊 Resumen de Cambios

| Tipo | Total | Creados | Actualizados | Sin Cambios |
|------|-------|---------|--------------|-------------|
| **Triggers** | 5 | 1 | 0 | 4 |
| **Funciones** | 5 | 0 | 2 | 3 |

---

## 🎯 Archivos Modificados

### Nuevos
- `src/databases/postgresql/triggers/trg_rsm_on_invoice_change.sql`

### Actualizados
- `src/databases/postgresql/functions/auto_populate_invoice_tax_rate.sql`
- `src/databases/postgresql/functions/trigger_rsm_on_invoice_change.sql`

---

## ✅ Estado Final

Todos los triggers y funciones de invoices están actualizados y listos para ser aplicados a la base de datos mediante una migración de Supabase.

### Próximos Pasos

1. Crear migración de Supabase que ejecute estos archivos
2. Aplicar la migración en el entorno de desarrollo
3. Validar que los triggers funcionan correctamente
4. Aplicar en producción

---

## 🔍 Validaciones Recomendadas

Después de aplicar la migración, verificar:

1. **FX Calculation**: Que las facturas calculen correctamente `amount_system_currency` y `total_system_currency`
2. **Tax Rate**: Que se auto-pueble desde la compañía
3. **Invoice Group ID**: Que las notas de crédito hereden el `invoice_group_id` correcto
4. **RSM Rebuild**: Que los cambios en facturas reconstruyan correctamente el Revenue Schedule
5. **Item Sync**: Que los items se sincronicen cuando cambia el status/fecha de la factura

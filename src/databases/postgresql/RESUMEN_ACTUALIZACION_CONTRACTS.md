# Resumen de Actualización: Triggers y Funciones de Contracts

**Fecha**: 5 de marzo de 2026

## 📋 Triggers Actualizados/Verificados

### ✅ Todos los triggers ya existen correctamente

| #   | Trigger                                           | Ubicación                                                                               |
| --- | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | `generate_invoices_on_contract_active`            | `src/databases/postgresql/triggers/generate_invoices_on_contract_active.sql`            |
| 2   | `trg_prevent_end_date_update_when_active`         | `src/databases/postgresql/triggers/trg_prevent_end_date_update_when_active.sql`         |
| 3   | `trg_rsm_on_churn`                                | `src/databases/postgresql/triggers/trg_rsm_on_churn.sql`                                |
| 4   | `trg_set_booking_date_on_activate`                | `src/databases/postgresql/triggers/trg_set_booking_date_on_activate.sql`                |
| 5   | `trigger_auto_calculate_contract_fx`              | `src/databases/postgresql/triggers/trigger_auto_calculate_contract_fx.sql`              |
| 6   | `trigger_log_contract_workflow_transition`        | `src/databases/postgresql/triggers/trigger_log_contract_workflow_transition.sql`        |
| 7   | `trigger_revenue_schedule_on_contract_activation` | `src/databases/postgresql/triggers/trigger_revenue_schedule_on_contract_activation.sql` |
| 8   | `trigger_set_contract_company_currency`           | `src/databases/postgresql/triggers/trigger_set_contract_company_currency.sql`           |
| 9   | `unified_generate_invoices_on_contract_signed`    | `src/databases/postgresql/triggers/unified_generate_invoices_on_contract_signed.sql`    |
| 10  | `validate_contract_currency_trigger`              | `src/databases/postgresql/triggers/validate_contract_currency_trigger.sql`              |
| 11  | `validate_fx_before_firmado`                      | `src/databases/postgresql/triggers/validate_fx_before_firmado.sql`                      |

---

## 🔧 Funciones Actualizadas/Verificadas

### ✅ Todas las funciones ya existen correctamente

| #   | Función                                             | Estado             | Ubicación                                                                                |
| --- | --------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| 1   | `auto_calculate_contract_fx()`                      | ✅ Verificada      | `src/databases/postgresql/functions/auto_calculate_contract_fx.sql`                      |
| 2   | `log_contract_workflow_transition()`                | ✅ Verificada      | `src/databases/postgresql/functions/log_contract_workflow_transition.sql`                |
| 3   | `prevent_end_date_update_when_active()`             | ✅ Verificada      | `src/databases/postgresql/functions/prevent_end_date_update_when_active.sql`             |
| 4   | `set_booking_date_on_activate()`                    | ✅ Verificada      | `src/databases/postgresql/functions/set_booking_date_on_activate.sql`                    |
| 5   | `set_contract_company_currency()`                   | ✅ Verificada      | `src/databases/postgresql/functions/set_contract_company_currency.sql`                   |
| 6   | `trigger_generate_invoices_on_contract_signed()`    | ✅ Verificada      | `src/databases/postgresql/functions/trigger_generate_invoices_on_contract_signed.sql`    |
| 7   | `trigger_generate_invoices_on_status_change()`      | ✅ Verificada      | `src/databases/postgresql/functions/trigger_generate_invoices_on_status_change.sql`      |
| 8   | `trigger_revenue_schedule_on_contract_activation()` | ✅ Verificada      | `src/databases/postgresql/functions/trigger_revenue_schedule_on_contract_activation.sql` |
| 9   | `trigger_rsm_on_churn()`                            | ✅ **Actualizada** | `src/databases/postgresql/functions/trigger_rsm_on_churn.sql`                            |
| 10  | `validate_contract_currency_consistency()`          | ✅ Verificada      | `src/databases/postgresql/functions/validate_contract_currency_consistency.sql`          |
| 11  | `validate_fx_confirmation_before_firmado()`         | ✅ Verificada      | `src/databases/postgresql/functions/validate_fx_confirmation_before_firmado.sql`         |

---

## 📊 Resumen de Cambios

| Tipo          | Total | Creados | Actualizados | Sin Cambios |
| ------------- | ----- | ------- | ------------ | ----------- |
| **Triggers**  | 11    | 0       | 0            | 11          |
| **Funciones** | 11    | 0       | 1            | 10          |

---

## 🎯 Archivos Modificados

### Actualizados

-   `src/databases/postgresql/functions/trigger_rsm_on_churn.sql` - Cambio de delimitador `$$` a `$function$` para consistencia

---

## ✅ Estado Final

Todos los triggers y funciones de contracts están actualizados y listos para ser aplicados a la base de datos mediante una migración de Supabase.

### Descripción de Funciones Clave

#### 1. **auto_calculate_contract_fx()**

-   Calcula automáticamente los montos FX cuando un contrato pasa a estado Firmado/Activo
-   Se ejecuta en INSERT/UPDATE según condiciones específicas

#### 2. **log_contract_workflow_transition()**

-   Registra transiciones de workflow en `contract_workflow_history`
-   Solo registra cuando `current_step_id` cambia

#### 3. **prevent_end_date_update_when_active()**

-   Previene modificación de `contract_end_date` en contratos Activos
-   Lanza excepción si se intenta modificar

#### 4. **set_booking_date_on_activate()**

-   Auto-asigna `booking_date` cuando un contrato se activa
-   Solo si `booking_date` es NULL

#### 5. **set_contract_company_currency()**

-   Auto-puebla `company_currency` desde la tabla `companies`
-   Se ejecuta si el campo es NULL

#### 6. **trigger_generate_invoices_on_contract_signed()**

-   Genera facturas cuando contrato pasa a Firmado/Activo
-   Verifica que no existan facturas previas

#### 7. **trigger_generate_invoices_on_status_change()**

-   Genera facturas cuando contrato cambia a Activo
-   Similar a la función anterior pero solo para Activo

#### 8. **trigger_revenue_schedule_on_contract_activation()**

-   Reconstruye Revenue Schedule cuando contrato se activa
-   Maneja errores sin bloquear la transacción

#### 9. **trigger_rsm_on_churn()**

-   Elimina períodos futuros de RSM cuando se establece `churn_date`
-   Solo actúa cuando churn_date pasa de NULL a una fecha

#### 10. **validate_contract_currency_consistency()**

-   Valida que la moneda del contrato coincida con sus items
-   Lanza excepción si hay inconsistencias

#### 11. **validate_fx_confirmation_before_firmado()**

-   Valida que las políticas FX estén confirmadas antes de firmar
-   Requiere `fx_company_confirmed_at` y `fx_invoice_confirmed_at`

---

## 🔍 Validaciones Recomendadas

Después de aplicar la migración, verificar:

1. **Cálculo FX**: Que los contratos calculen correctamente los montos en moneda del sistema
2. **Workflow Logging**: Que las transiciones de workflow se registren correctamente
3. **Protección de Fechas**: Que no se puedan modificar fechas de término en contratos activos
4. **Booking Date**: Que se auto-asigne al activar contratos
5. **Generación de Facturas**: Que se generen facturas al firmar/activar contratos
6. **Revenue Schedule**: Que se reconstruya correctamente al activar contratos
7. **Churn Handling**: Que se eliminen períodos futuros al establecer churn_date
8. **Validaciones**: Que las validaciones de moneda y FX funcionen correctamente

---

## 📝 Notas Importantes

-   Todas las funciones usan `SECURITY DEFINER` para ejecutarse con privilegios del propietario
-   Las funciones que modifican datos usan `SET search_path TO 'public'` para seguridad
-   Los triggers están configurados con los eventos correctos (BEFORE/AFTER, INSERT/UPDATE)
-   La función `trigger_rsm_on_churn` fue actualizada para usar `$function$` en lugar de `$$`

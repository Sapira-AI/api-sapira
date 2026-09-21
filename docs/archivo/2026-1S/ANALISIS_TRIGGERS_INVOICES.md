# Análisis Detallado de Triggers y Funciones de Invoices e Invoice_Items

## 📋 Resumen Ejecutivo

Este documento analiza todas las funciones y triggers asociados a las tablas `invoices` y `invoice_items`. Se detectaron **3 inconsistencias críticas** y **2 áreas de mejora** que requieren atención.

---

## 🔴 INCONSISTENCIAS CRÍTICAS DETECTADAS

### 1. **Duplicación de Lógica de Revenue Schedule** ⚠️

Existen **3 funciones diferentes** que hacen prácticamente lo mismo:

- `refresh_revenue_schedule_for_invoice_contract()` - Llama a `revenue_schedule_rebuild()`
- `trigger_revenue_schedule_update()` - Llama a `revenue_schedule_rebuild()` con validación de feature flag
- `trigger_revenue_schedule_on_invoice_change()` - Llama a `refresh_revenue_schedule_for_contract_safe()`

**Problema:** Lógica duplicada y confusa. Diferentes funciones llaman a diferentes versiones (`revenue_schedule_rebuild` vs `refresh_revenue_schedule_for_contract_safe`).

**Impacto:** Mantenimiento complejo, posibles inconsistencias en el comportamiento, y múltiples actualizaciones del revenue schedule en la misma operación.

---

### 2. **Inconsistencia en tax_rate: Porcentaje vs Decimal** ⚠️

**Ubicaciones del conflicto:**

- **`auto_populate_invoice_fx_to_system.sql`** (líneas 44-46, 78-80): 
  ```sql
  -- Asume que tax_rate está en PORCENTAJE (0-100) y divide por 100
  NEW.total_system_currency := ROUND(
    NEW.amount_system_currency * (1 + COALESCE(NEW.tax_rate, 0) / 100.0),
    2
  );
  ```

- **`auto_populate_invoice_tax_rate.sql`** (línea 26):
  ```sql
  -- Asigna 0.19 como default, sugiriendo DECIMAL (0.0-1.0)
  NEW.tax_rate := COALESCE(v_company_tax_rate, 0.19);
  ```

**Problema:** Si `tax_rate` se guarda como `0.19` (formato decimal para 19%), al dividir por 100 en otras funciones se obtendría `0.0019` (0.19%), causando cálculos incorrectos de impuestos.

**Impacto:** Cálculos de impuestos incorrectos en conversiones de moneda.

---

### 3. **Función que llama a otra función inexistente** ⚠️

**Ubicación:** `trigger_revenue_schedule_on_invoice_change.sql` (línea 33)

```sql
PERFORM refresh_revenue_schedule_for_contract_safe(v_contract_id);
```

**Problema:** La función `refresh_revenue_schedule_for_contract_safe()` **no existe en la lista de funciones proporcionadas**. Debería ser `revenue_schedule_rebuild()`.

**Impacto:** El trigger fallará en ejecución, causando errores en las operaciones de INSERT/UPDATE de invoices.

---

## ⚠️ ÁREAS DE MEJORA

### 4. **Cálculo de VAT en standardize_invoice_items potencialmente incorrecto**

**Ubicación:** `standardize_invoice_items.sql` (líneas 73-74)

```sql
NEW.tax_amount_contract_currency := NEW.subtotal_contract_currency * 
  (v_invoice_vat / NULLIF(v_invoice_total - v_invoice_vat, 0));
```

**Problema:** Esta fórmula calcula la tasa de impuesto como `vat / (total - vat)`. Si `vat = 19` y `total = 119`, esto da `19 / 100 = 0.19`, pero la semántica de qué representan `vat` y `total_invoice_currency` no está clara.

**Recomendación:** Documentar claramente qué representan estos campos y validar la fórmula.

---

### 5. **sync_invoice_item_contract_id depende de tabla contract_invoices**

**Ubicación:** `sync_invoice_item_contract_id.sql` (líneas 28-36)

```sql
SELECT DISTINCT 
  (jsonb_array_elements(contract_item_details)->>'contract_item_id')::UUID
INTO v_contract_item_id
FROM contract_invoices
WHERE contract_id = v_invoice.contract_id
AND contract_item_details @> jsonb_build_array(
  jsonb_build_object('product_name', NEW.description)
)
```

**Problema:** Depende de que exista una tabla `contract_invoices` con un campo JSONB `contract_item_details`. Si esta tabla no existe o está vacía, el `contract_item_id` nunca se asignará.

**Recomendación:** Validar que la tabla existe o implementar lógica alternativa.

---

## 📊 ANÁLISIS POR FUNCIÓN

### **TABLA: invoices**

#### 1. `assign_invoice_group_id()` - BEFORE INSERT

**Trigger:** `trg_assign_invoice_group_id`

**Lógica:**
- Si es nota de crédito (`document_type = 'NC'`), hereda el `invoice_group_id` de la factura relacionada
- Si es factura nueva sin `invoice_group_id`, usa su propio `id` como `invoice_group_id`

**Propósito:** Agrupar facturas relacionadas (facturas y sus notas de crédito)

**Estado:** ✅ Correcto

---

#### 2. `auto_populate_invoice_tax_rate()` - BEFORE INSERT/UPDATE

**Trigger:** `trigger_auto_populate_invoice_tax_rate`

**Lógica:**
1. Solo procesa si `company_id` existe
2. Solo procesa si `tax_rate` es NULL (no sobrescribe valores existentes)
3. Obtiene `tax_rate` de la tabla `companies`
4. Asigna default de `0.19` (19%) si no existe en company

**Propósito:** Auto-poblar la tasa de impuesto desde la configuración de la company

**Estado:** ⚠️ **INCONSISTENCIA #2** - Usa formato decimal (0.19) pero otras funciones asumen porcentaje (19)

---

#### 3. `auto_populate_invoice_fx_to_system()` - BEFORE INSERT/UPDATE

**Trigger:** `trigger_auto_populate_invoice_fx_to_system`

**Lógica:**
1. Solo procesa si `contract_id` existe
2. Obtiene `contract_currency` del contrato
3. Obtiene `system_currency` y `fx_system_policy` del holding
4. Si monedas son iguales: `fx = 1.0`, no requiere conversión
5. Si son diferentes:
   - Busca FX rate usando `calculate_system_fx_rate()`
   - Calcula `amount_system_currency` **dividiendo** por el rate (rates inversos)
   - Calcula `total_system_currency` aplicando `tax_rate / 100`
6. Si no encuentra FX rate, registra WARNING y deja NULL

**Propósito:** Convertir montos de la moneda del contrato a la moneda del sistema

**Estado:** ⚠️ **INCONSISTENCIA #2** - Asume tax_rate en porcentaje (0-100)

**Dependencias externas:** 
- Función `calculate_system_fx_rate()`
- Tabla `holding_settings`

---

#### 4. `trigger_revenue_schedule_update()` - AFTER INSERT/UPDATE/DELETE

**Trigger:** `invoices_revenue_schedule_trigger`

**Lógica:**
1. Detecta si viene de tabla `invoices` o `contract_items`
2. Obtiene `contract_id`, `holding_id` y `status` del contrato
3. Verifica si feature `revenue_schedule_monthly_enabled` está activo en `financial_settings`
4. Solo procesa si feature está habilitado Y contrato está 'Activo'
5. Llama a `revenue_schedule_rebuild(contract_id, affected_month)`
6. Maneja excepciones sin fallar (EXCEPTION handler)

**Propósito:** Actualizar el revenue schedule mensual cuando cambian invoices o contract_items

**Estado:** ✅ Correcto pero **DUPLICADO** (ver inconsistencia #1)

**Dependencias externas:**
- Función `revenue_schedule_rebuild()`
- Tabla `financial_settings`

---

#### 5. `trigger_revenue_schedule_on_invoice_change()` - AFTER INSERT/UPDATE

**Trigger:** `trigger_revenue_schedule_after_invoice_change`

**Lógica:**
1. Obtiene `contract_id` (maneja DELETE también)
2. Solo procesa si `is_active = true` (para INSERT/UPDATE)
3. Verifica que el contrato existe y está 'Activo'
4. Llama a `refresh_revenue_schedule_for_contract_safe()`
5. Registra NOTICE si contrato no está Activo

**Propósito:** Actualizar revenue schedule cuando cambian invoices activas

**Estado:** 🔴 **INCONSISTENCIA #3** - Llama a función inexistente `refresh_revenue_schedule_for_contract_safe()`

---

#### 6. `sync_invoice_items_on_invoice_update()` - AFTER UPDATE

**Trigger:** `trigger_sync_invoice_items_on_invoice_update`

**Lógica:**
1. Detecta si cambió `status` o `issue_date` en la invoice
2. Si cambió alguno, actualiza TODOS los `invoice_items` asociados con los mismos valores
3. Actualiza también `updated_at`
4. Registra NOTICE con los valores sincronizados

**Propósito:** Mantener sincronización entre invoice e invoice_items

**Estado:** ✅ Correcto - Garantiza consistencia de datos

---

### **TABLA: invoice_items**

#### 7. `update_invoice_items_updated_at()` - BEFORE UPDATE

**Trigger:** `update_invoice_items_updated_at_trigger`

**Lógica:**
- Actualiza `updated_at` a `now()` en cada UPDATE

**Propósito:** Timestamp automático de última modificación

**Estado:** ✅ Correcto - Patrón estándar de auditoría

---

#### 8. `auto_populate_invoice_item_fields()` - BEFORE INSERT

**Trigger:** `trigger_auto_populate_invoice_item_fields`

**Lógica:**
1. Obtiene `contract_id`, `status`, `issue_date` de la invoice padre
2. Auto-asigna estos campos al invoice_item
3. Si existe `contract_item_id`:
   - Obtiene `product_id` y `currency` del contract_item
   - Asigna `product_id`
   - Asigna `contract_currency` desde contract_item
   - Asigna `invoice_currency` (usa existente o copia de contract_item)

**Propósito:** Auto-población de campos desde invoice y contract_item

**Estado:** ✅ Correcto - Reduce redundancia de datos

---

#### 9. `sync_invoice_item_contract_id()` - BEFORE INSERT/UPDATE

**Trigger:** `trigger_sync_invoice_item_contract_id`

**Lógica:**
1. Solo procesa si `contract_item_id` es NULL
2. Obtiene `contract_id` de la invoice
3. Si invoice no tiene contrato, no hace nada
4. Busca en tabla `contract_invoices` por coincidencia de `product_name` con `description`
5. Si encuentra match, asigna el `contract_item_id`

**Propósito:** Intentar vincular automáticamente invoice_items con contract_items basándose en descripción

**Estado:** ⚠️ **ÁREA DE MEJORA #5** - Depende de tabla `contract_invoices` que puede no existir

---

#### 10. `standardize_invoice_items()` - BEFORE INSERT

**Trigger:** `standardize_invoice_items_trigger`

**Lógica:**
1. Solo procesa si existe `contract_item_id`
2. Obtiene datos del contract_item:
   - `billing_frequency`, `final_price`, `term_months`
   - `quantity`, `unit_of_measure`, `billing_period_price`
3. Calcula valores de fallback:
   - `v_frequency_months` = meses según frecuencia de facturación
   - `v_monthly_price` = precio prorrateado mensual
4. Determina valores finales con COALESCE (usa real o fallback):
   - `quantity`: usa quantity real o frecuencia de facturación
   - `unit_of_measure`: usa real o 'PERIODOS'
   - `unit_price`: usa billing_period_price o precio mensual
5. Calcula subtotal aplicando descuento
6. Calcula tax_amount desde la invoice (si no está proporcionado)
7. Calcula total = subtotal + tax

**Propósito:** Estandarizar y calcular precios de invoice_items desde contract_items

**Estado:** ⚠️ **ÁREA DE MEJORA #4** - Fórmula de VAT cuestionable

**Dependencias externas:**
- Función `get_frequency_months()`

---

#### 11. `refresh_revenue_schedule_for_invoice_contract()` - AFTER INSERT/UPDATE/DELETE

**Triggers:** 
- `trg_invoice_item_change` (en invoice_items)
- `trg_invoice_status_change` (en invoices)

**Lógica:**
1. Detecta si viene de tabla `invoice_items` o `invoices`
2. Obtiene `invoice_id` apropiadamente
3. Busca `contract_id` y `status` del contrato asociado
4. Solo procesa si contrato existe Y está 'Activo'
5. Llama a `revenue_schedule_rebuild(contract_id)`

**Propósito:** Actualizar revenue schedule cuando cambian invoices o invoice_items

**Estado:** ✅ Correcto pero **DUPLICADO** (ver inconsistencia #1)

**Dependencias externas:**
- Función `revenue_schedule_rebuild()`

---

## 🔄 FLUJO DE EJECUCIÓN

### Al INSERTAR una Invoice:

**BEFORE INSERT (en orden):**
1. ✅ `assign_invoice_group_id()` - Asigna group_id
2. ✅ `auto_populate_invoice_tax_rate()` - Asigna tax_rate desde company
3. ⚠️ `auto_populate_invoice_fx_to_system()` - Calcula FX y montos en system_currency

**AFTER INSERT:**
4. ✅ `trigger_revenue_schedule_update()` - Actualiza revenue schedule
5. 🔴 `trigger_revenue_schedule_on_invoice_change()` - **DUPLICADO** - Actualiza revenue schedule otra vez (y llama función inexistente)

**Problema:** El revenue schedule se actualiza 2 veces en cada INSERT de invoice.

---

### Al ACTUALIZAR una Invoice:

**BEFORE UPDATE:**
1. ⚠️ `auto_populate_invoice_tax_rate()` - Asigna tax_rate si es NULL
2. ⚠️ `auto_populate_invoice_fx_to_system()` - Recalcula FX

**AFTER UPDATE:**
3. ✅ `sync_invoice_items_on_invoice_update()` - Sincroniza items si cambió status/issue_date
4. ✅ `trigger_revenue_schedule_update()` - Actualiza revenue schedule
5. 🔴 `trigger_revenue_schedule_on_invoice_change()` - **DUPLICADO** - Actualiza revenue schedule otra vez
6. ✅ `refresh_revenue_schedule_for_invoice_contract()` - **TRIPLICADO** si cambió status

**Problema:** El revenue schedule se actualiza 2-3 veces en cada UPDATE de invoice.

---

### Al INSERTAR un Invoice_Item:

**BEFORE INSERT (en orden):**
1. ✅ `auto_populate_invoice_item_fields()` - Copia datos de invoice y contract_item
2. ⚠️ `sync_invoice_item_contract_id()` - Intenta asignar contract_item_id
3. ⚠️ `standardize_invoice_items()` - Calcula precios y totales

**AFTER INSERT:**
4. ✅ `refresh_revenue_schedule_for_invoice_contract()` - Actualiza revenue schedule

---

### Al ACTUALIZAR un Invoice_Item:

**BEFORE UPDATE:**
1. ✅ `update_invoice_items_updated_at()` - Actualiza timestamp
2. ⚠️ `sync_invoice_item_contract_id()` - Intenta asignar contract_item_id si es NULL

**AFTER UPDATE:**
3. ✅ `refresh_revenue_schedule_for_invoice_contract()` - Actualiza revenue schedule

---

## 🎯 RECOMENDACIONES

### 🔴 Críticas (Resolver Inmediatamente):

#### 1. Estandarizar formato de tax_rate
**Acción:** Decidir si `tax_rate` es:
- **Opción A:** Porcentaje (0-100) → Cambiar `auto_populate_invoice_tax_rate` para asignar `19` en lugar de `0.19`
- **Opción B:** Decimal (0.0-1.0) → Cambiar `auto_populate_invoice_fx_to_system` para NO dividir por 100

**Archivos a modificar:**
- `auto_populate_invoice_tax_rate.sql`
- `auto_populate_invoice_fx_to_system.sql`

---

#### 2. Consolidar funciones de revenue schedule
**Acción:** Usar una sola función en lugar de 3:
- Mantener `refresh_revenue_schedule_for_invoice_contract()` como función principal
- Eliminar o refactorizar `trigger_revenue_schedule_update()` y `trigger_revenue_schedule_on_invoice_change()`
- O mejor: crear una función wrapper que maneje todas las validaciones

**Beneficio:** Evitar múltiples actualizaciones del revenue schedule en la misma operación

---

#### 3. Corregir función inexistente
**Acción:** En `trigger_revenue_schedule_on_invoice_change.sql` línea 33:

**Cambiar:**
```sql
PERFORM refresh_revenue_schedule_for_contract_safe(v_contract_id);
```

**Por:**
```sql
PERFORM revenue_schedule_rebuild(v_contract_id);
```

**O verificar:** Si `refresh_revenue_schedule_for_contract_safe()` existe en Supabase pero no está documentada.

---

### ⚠️ Mejoras Sugeridas:

#### 4. Revisar fórmula de VAT en standardize_invoice_items
**Acción:** 
- Documentar qué representan `vat` y `total_invoice_currency`
- Validar que la fórmula `vat / (total - vat)` es correcta
- Considerar usar una tasa fija o campo específico

---

#### 5. Validar dependencia de contract_invoices
**Acción:**
- Verificar que la tabla `contract_invoices` existe
- Si no existe, implementar lógica alternativa en `sync_invoice_item_contract_id()`
- Considerar buscar directamente en `contract_items` por `product_id` o `product_name`

---

#### 6. Optimizar triggers de revenue schedule
**Acción:**
- Evitar que múltiples triggers actualicen el revenue schedule en la misma transacción
- Implementar un sistema de "dirty flag" o cola para actualizar una sola vez al final
- Considerar usar `CONSTRAINT TRIGGER` con `DEFERRABLE` para ejecutar al final de la transacción

---

## 📝 TABLA RESUMEN DE TRIGGERS

| Tabla | Trigger | Timing | Eventos | Función | Estado |
|-------|---------|--------|---------|---------|--------|
| invoices | trg_assign_invoice_group_id | BEFORE | INSERT | assign_invoice_group_id() | ✅ OK |
| invoices | trigger_auto_populate_invoice_tax_rate | BEFORE | INSERT, UPDATE | auto_populate_invoice_tax_rate() | ⚠️ Inconsistencia #2 |
| invoices | trigger_auto_populate_invoice_fx_to_system | BEFORE | INSERT, UPDATE | auto_populate_invoice_fx_to_system() | ⚠️ Inconsistencia #2 |
| invoices | invoices_revenue_schedule_trigger | AFTER | INSERT, UPDATE, DELETE | trigger_revenue_schedule_update() | ⚠️ Duplicado |
| invoices | trigger_revenue_schedule_after_invoice_change | AFTER | INSERT, UPDATE | trigger_revenue_schedule_on_invoice_change() | 🔴 Función inexistente |
| invoices | trigger_sync_invoice_items_on_invoice_update | AFTER | UPDATE | sync_invoice_items_on_invoice_update() | ✅ OK |
| invoices | trg_invoice_status_change | AFTER | UPDATE | refresh_revenue_schedule_for_invoice_contract() | ⚠️ Duplicado |
| invoice_items | update_invoice_items_updated_at_trigger | BEFORE | UPDATE | update_invoice_items_updated_at() | ✅ OK |
| invoice_items | trigger_auto_populate_invoice_item_fields | BEFORE | INSERT | auto_populate_invoice_item_fields() | ✅ OK |
| invoice_items | trigger_sync_invoice_item_contract_id | BEFORE | INSERT, UPDATE | sync_invoice_item_contract_id() | ⚠️ Depende de contract_invoices |
| invoice_items | standardize_invoice_items_trigger | BEFORE | INSERT | standardize_invoice_items() | ⚠️ Fórmula VAT |
| invoice_items | trg_invoice_item_change | AFTER | INSERT, UPDATE, DELETE | refresh_revenue_schedule_for_invoice_contract() | ⚠️ Duplicado |

---

## 🔍 DEPENDENCIAS EXTERNAS

Funciones que se llaman pero no están en la lista analizada:

1. ✅ `revenue_schedule_rebuild(contract_id, affected_month?)` - Llamada por múltiples triggers
2. 🔴 `refresh_revenue_schedule_for_contract_safe(contract_id)` - **NO EXISTE**
3. ✅ `calculate_system_fx_rate(holding_id, from_currency, to_currency, date, policy)` - Para conversión FX
4. ✅ `get_frequency_months(billing_frequency)` - Para calcular meses según frecuencia

Tablas referenciadas:

1. ✅ `contracts` - Tabla principal de contratos
2. ✅ `contract_items` - Items de contratos
3. ✅ `companies` - Configuración de companies
4. ✅ `holding_settings` - Configuración de holdings
5. ✅ `financial_settings` - Configuración financiera
6. ⚠️ `contract_invoices` - **Verificar existencia**

---

## 📅 Fecha de Análisis

**Fecha:** 26 de febrero de 2026  
**Versión:** 1.0  
**Analista:** Sistema de análisis automático

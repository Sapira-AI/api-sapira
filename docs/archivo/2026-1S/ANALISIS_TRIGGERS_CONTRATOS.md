# Análisis de Triggers y Funciones de Contratos

## 📊 Resumen Ejecutivo

Este documento analiza el sistema de triggers y funciones PostgreSQL que gestionan el ciclo de vida de los contratos en Sapira AI. El sistema implementa automatizaciones críticas para:

-   **Gestión de monedas y tipos de cambio (FX)**
-   **Generación automática de facturas**
-   **Control de flujo de trabajo (workflow)**
-   **Validaciones de integridad de datos**
-   **Gestión de revenue schedule**
-   **Manejo de churn**

### Panorama Global de las Lógicas

El sistema se organiza en **5 áreas funcionales principales**:

#### 1. **Gestión de Monedas y FX** (3 triggers)

-   Auto-población de moneda de compañía
-   Cálculo automático de conversiones FX
-   Validación de confirmación FX antes de firmar

#### 2. **Generación de Facturas** (2 triggers)

-   Generación al firmar contrato (Firmado/Activo)
-   Generación al activar contrato (solo Activo)

#### 3. **Validaciones de Integridad** (3 triggers)

-   Prevención de cambios en fecha de término
-   Consistencia de monedas entre contrato e items
-   Validación de políticas FX confirmadas

#### 4. **Gestión de Workflow y Fechas** (2 triggers)

-   Logging de transiciones de workflow
-   Auto-asignación de booking_date

#### 5. **Revenue Schedule** (2 triggers)

-   Reconstrucción al activar contrato
-   Limpieza de períodos futuros al registrar churn

---

## 🔍 Análisis Detallado por Función

### 1. GESTIÓN DE MONEDAS Y FX

#### 1.1 `set_contract_company_currency()`

**Trigger:** `trigger_set_contract_company_currency` (BEFORE INSERT OR UPDATE)

**Propósito:** Auto-completar el campo `company_currency` desde la tabla `companies`.

**Lógica:**

```
SI company_currency es NULL Y company_id NO es NULL
  ENTONCES obtener currency de la tabla companies
  Y asignarla a company_currency
```

**Dependencias:**

-   Tabla: `companies`
-   Campo: `companies.currency`

**Timing:** BEFORE - permite modificar el registro antes de guardarlo

---

#### 1.2 `auto_calculate_contract_fx()`

**Trigger:** `trigger_auto_calculate_contract_fx` (AFTER INSERT OR UPDATE)

**Propósito:** Calcular automáticamente los montos en diferentes monedas cuando el contrato está en estado Firmado o Activo.

**Lógica:**

```
SI es INSERT:
  SI status es 'Firmado' O 'Activo'
    ENTONCES calcular FX

SI es UPDATE:
  SI status cambió a 'Firmado' O 'Activo'
    ENTONCES calcular FX
  O SI ya está en 'Firmado'/'Activo' Y cambiaron:
    - total_value
    - contract_currency
    - booking_date
    ENTONCES calcular FX
```

**Dependencias:**

-   Función: `calculate_contract_fx_amounts(contract_id)`
-   Retorna: RECORD con campos `success` y `message`

**Timing:** AFTER - ejecuta después de guardar para no interferir con validaciones

**Comportamiento:** No bloquea la transacción si falla, solo emite WARNING

---

#### 1.3 `validate_fx_confirmation_before_firmado()`

**Trigger:** `validate_fx_before_firmado` (BEFORE UPDATE)

**Propósito:** Validar que las políticas FX estén confirmadas antes de firmar el contrato.

**Lógica:**

```
SI status cambia a 'Firmado':
  SI fx_company_confirmed_at es NULL
    ENTONCES lanzar EXCEPTION
  SI fx_invoice_confirmed_at es NULL
    ENTONCES lanzar EXCEPTION
```

**Campos requeridos:**

-   `fx_company_confirmed_at` (timestamp)
-   `fx_invoice_confirmed_at` (timestamp)

**Timing:** BEFORE - bloquea la transacción si no se cumplen las condiciones

**Comportamiento:** EXCEPTION - impide guardar el registro

---

### 2. GENERACIÓN DE FACTURAS

#### 2.1 `trigger_generate_invoices_on_contract_signed()`

**Trigger:** `unified_generate_invoices_on_contract_signed` (AFTER INSERT OR UPDATE)

**Propósito:** Generar facturas cuando el contrato cambia a estado 'Firmado' o 'Activo'.

**Lógica:**

```
SI status cambió a 'Firmado' O 'Activo':
  Verificar si ya existen facturas en tabla invoices
  SI existen facturas:
    ENTONCES salir (no generar duplicados)
  SI NO existen:
    Llamar generate_missing_invoices_for_contract(contract_id)
    Registrar resultado en logs
```

**Dependencias:**

-   Tabla: `invoices`
-   Función: `generate_missing_invoices_for_contract(contract_id)`
-   Retorna: RECORD con `success`, `generated_count`, `message`

**Timing:** AFTER INSERT OR UPDATE

**Comportamiento:** No bloquea si falla, solo emite WARNING

---

#### 2.2 `trigger_generate_invoices_on_status_change()`

**Trigger:** `generate_invoices_on_contract_active` (AFTER UPDATE)

**Propósito:** Generar facturas cuando el contrato cambia específicamente a estado 'Activo'.

**Lógica:**

```
SI status cambió a 'Activo':
  Verificar si ya existen facturas en tabla invoices
  SI existen facturas:
    ENTONCES salir (no generar duplicados)
  SI NO existen:
    Llamar generate_missing_invoices_for_contract(contract_id)
    Registrar resultado en logs
```

**Dependencias:**

-   Tabla: `invoices`
-   Función: `generate_missing_invoices_for_contract(contract_id)`

**Timing:** AFTER UPDATE (solo en updates)

**Comportamiento:** No bloquea si falla, solo emite WARNING

---

### 3. VALIDACIONES DE INTEGRIDAD

#### 3.1 `prevent_end_date_update_when_active()`

**Trigger:** `trg_prevent_end_date_update_when_active` (BEFORE UPDATE)

**Propósito:** Prevenir modificación de `contract_end_date` cuando el contrato está Activo.

**Lógica:**

```
SI es UPDATE:
  SI (OLD.status = 'Activo' O NEW.status = 'Activo')
    Y contract_end_date cambió
    ENTONCES lanzar EXCEPTION
```

**Timing:** BEFORE UPDATE

**Comportamiento:** EXCEPTION - bloquea la transacción

**Nota:** La condición `OR` significa que previene cambios tanto si YA está activo como si SE ESTÁ activando.

---

#### 3.2 `validate_contract_currency_consistency()`

**Trigger:** `validate_contract_currency_trigger` (BEFORE INSERT OR UPDATE)

**Propósito:** Validar que todos los items del contrato tengan la misma moneda que el contrato.

**Lógica:**

```
SI existe algún contract_item con currency diferente a contract_currency:
  ENTONCES lanzar EXCEPTION
```

**Dependencias:**

-   Tabla: `contract_items`
-   Campos: `contract_items.currency`, `contracts.contract_currency`

**Timing:** BEFORE INSERT OR UPDATE

**Comportamiento:** EXCEPTION - bloquea la transacción

---

#### 3.3 `validate_fx_confirmation_before_firmado()`

_(Ya descrita en sección 1.3)_

---

### 4. GESTIÓN DE WORKFLOW Y FECHAS

#### 4.1 `log_contract_workflow_transition()`

**Trigger:** `trigger_log_contract_workflow_transition` (BEFORE UPDATE)

**Propósito:** Registrar automáticamente las transiciones de workflow en la tabla de historial.

**Lógica:**

```
SI current_step_id cambió:
  Insertar en contract_workflow_history:
    - contract_id
    - workflow_step_id (usa OLD si NEW es NULL)
    - status ('completed' si NEW es NULL, sino 'pending')
    - comments (automáticos)
    - transition_type: 'automatic'
    - metadata (JSON con detalles de la transición)
    - user_id (de get_current_user_id())
    - created_at
```

**Dependencias:**

-   Tabla: `contract_workflow_history`
-   Función: `get_current_user_id()`

**Timing:** BEFORE UPDATE

**Comportamiento:** No bloquea si falla (INSERT podría fallar por constraints)

**Caso especial:** Cuando `current_step_id` pasa a NULL, se considera workflow completado.

---

#### 4.2 `set_booking_date_on_activate()`

**Trigger:** `trg_set_booking_date_on_activate` (BEFORE INSERT OR UPDATE)

**Propósito:** Auto-asignar `booking_date` cuando el contrato se activa.

**Lógica:**

```
SI es INSERT:
  SI status = 'Activo' Y booking_date es NULL
    ENTONCES booking_date = CURRENT_DATE

SI es UPDATE:
  SI status cambió a 'Activo' Y booking_date es NULL
    ENTONCES booking_date = CURRENT_DATE
```

**Timing:** BEFORE INSERT OR UPDATE

**Comportamiento:** Modifica el registro antes de guardarlo

**Nota:** Solo asigna si booking_date es NULL, respeta valores existentes.

---

### 5. REVENUE SCHEDULE

#### 5.1 `trigger_revenue_schedule_on_contract_activation()`

**Trigger:** `trigger_revenue_schedule_on_contract_activation` (AFTER UPDATE)

**Propósito:** Reconstruir el revenue schedule cuando el contrato se activa.

**Lógica:**

```
SI status cambió a 'Activo':
  INTENTAR:
    Ejecutar revenue_schedule_rebuild(contract_id, NULL)
    Registrar NOTICE de éxito
  EN CASO DE ERROR:
    Registrar NOTICE de error (no bloquea transacción)
```

**Dependencias:**

-   Función: `revenue_schedule_rebuild(contract_id, param2)`

**Timing:** AFTER UPDATE

**Comportamiento:** Captura excepciones para no bloquear la transacción principal

**Nota:** Usa `COALESCE(OLD.status, '') <> 'Activo'` para manejar INSERTs (OLD sería NULL).

---

#### 5.2 `trigger_rsm_on_churn()`

**Trigger:** `trg_rsm_on_churn` (AFTER UPDATE)

**Propósito:** Eliminar períodos futuros del revenue schedule cuando se registra un churn.

**Lógica:**

```
SI churn_date cambió de NULL a una fecha:
  Calcular v_churn_period = inicio del mes de churn_date
  Eliminar de revenue_schedule_monthly:
    - Donde contract_id = contrato actual
    - Y period_month > v_churn_period
    - Y NO es fila de total (is_total_row = false)
```

**Dependencias:**

-   Tabla: `revenue_schedule_monthly`

**Timing:** AFTER UPDATE

**Comportamiento:** Solo actúa cuando churn_date pasa de NULL a valor

**Nota:** Preserva las filas de total (`is_total_row = true`).

---

## ⚠️ PROBLEMAS E INCONSISTENCIAS DETECTADAS

### 🔴 CRÍTICO: Duplicación de Lógica de Generación de Facturas

**Problema:** Existen DOS triggers que generan facturas con lógicas ligeramente diferentes:

1. **`unified_generate_invoices_on_contract_signed`** (AFTER INSERT OR UPDATE)

    - Se dispara en: 'Firmado' O 'Activo'
    - Usa: `NEW.contract_number` en logs
    - Timing: INSERT OR UPDATE

2. **`generate_invoices_on_contract_active`** (AFTER UPDATE)
    - Se dispara en: solo 'Activo'
    - Usa: `NEW.id` en logs
    - Timing: solo UPDATE

**Consecuencias:**

-   Cuando un contrato cambia a 'Activo', **AMBOS triggers se ejecutan**
-   Aunque tienen protección contra duplicados (verifican tabla `invoices`), esto genera:
    -   Doble consulta a la BD
    -   Logs duplicados/confusos
    -   Overhead innecesario
    -   Posibles race conditions en transacciones concurrentes

**Recomendación:**

```
OPCIÓN A: Mantener solo unified_generate_invoices_on_contract_signed
  - Cubre ambos casos (Firmado y Activo)
  - Eliminar generate_invoices_on_contract_active

OPCIÓN B: Separar responsabilidades claramente
  - unified_generate_invoices_on_contract_signed: solo 'Firmado'
  - generate_invoices_on_contract_active: solo 'Activo'
  - Asegurar que no se solapen
```

---

### 🟡 ADVERTENCIA: Orden de Ejecución de Triggers

**Problema:** Los triggers BEFORE y AFTER se ejecutan en orden alfabético cuando tienen el mismo timing.

**Triggers BEFORE INSERT OR UPDATE (orden alfabético):**

1. `trg_set_booking_date_on_activate`
2. `trigger_set_contract_company_currency`
3. `validate_contract_currency_trigger`

**Triggers BEFORE UPDATE:**

1. `trigger_log_contract_workflow_transition`
2. `trg_prevent_end_date_update_when_active`
3. `validate_fx_before_firmado`

**Posible problema:**

-   `validate_contract_currency_trigger` se ejecuta DESPUÉS de `trigger_set_contract_company_currency`
-   Si `set_contract_company_currency` cambia la moneda, la validación podría no ser la esperada
-   Sin embargo, `set_contract_company_currency` solo asigna si es NULL, por lo que probablemente está bien

**Recomendación:**

-   Documentar el orden esperado
-   Considerar renombrar triggers para controlar el orden si es crítico

---

### 🟡 ADVERTENCIA: Validación de Moneda Puede Fallar en INSERT

**Problema:** `validate_contract_currency_consistency()` verifica que los items tengan la misma moneda que el contrato.

**Escenario problemático:**

```sql
-- Si se inserta un contrato con items en una transacción:
BEGIN;
  INSERT INTO contracts (...) VALUES (...); -- Trigger valida items
  -- Pero los items aún no existen!
COMMIT;
```

**Análisis:**

-   Si los items se insertan DESPUÉS del contrato, la validación pasa (no hay items que validar)
-   Si los items se insertan ANTES (con contract_id), el contrato aún no existe (FK falla)
-   La validación es más útil en UPDATE que en INSERT

**Recomendación:**

-   Mantener el trigger pero documentar que la validación real ocurre en UPDATE
-   Considerar agregar un trigger en `contract_items` que valide al insertar/actualizar items

---

### 🟡 ADVERTENCIA: Manejo de Errores Inconsistente

**Problema:** Diferentes estrategias de manejo de errores:

**Funciones que BLOQUEAN (EXCEPTION):**

-   `prevent_end_date_update_when_active`
-   `validate_contract_currency_consistency`
-   `validate_fx_confirmation_before_firmado`

**Funciones que NO BLOQUEAN (WARNING/NOTICE):**

-   `auto_calculate_contract_fx` (WARNING)
-   `trigger_generate_invoices_on_contract_signed` (WARNING)
-   `trigger_generate_invoices_on_status_change` (WARNING)
-   `trigger_revenue_schedule_on_contract_activation` (NOTICE con EXCEPTION capturada)

**Análisis:**

-   Las validaciones de negocio DEBEN bloquear (correcto)
-   Las operaciones de cálculo/generación NO deben bloquear (correcto)
-   Sin embargo, si falla `calculate_contract_fx_amounts`, el contrato queda en estado inconsistente

**Recomendación:**

-   Documentar claramente qué funciones son críticas vs opcionales
-   Considerar si `auto_calculate_contract_fx` debería bloquear en ciertos casos
-   Implementar alertas/monitoreo para WARNINGs frecuentes

---

### 🟢 INFORMACIÓN: Dependencias Externas No Verificadas

**Funciones externas llamadas (no definidas en estos archivos):**

1. `calculate_contract_fx_amounts(contract_id)` - usada por `auto_calculate_contract_fx`
2. `generate_missing_invoices_for_contract(contract_id)` - usada por generación de facturas
3. `revenue_schedule_rebuild(contract_id, param)` - usada por revenue schedule
4. `get_current_user_id()` - usada por workflow logging

**Recomendación:**

-   Verificar que estas funciones existan
-   Documentar sus contratos (parámetros, retorno, excepciones)
-   Asegurar que manejen errores apropiadamente

---

### 🟢 INFORMACIÓN: Campo `is_total_row` en Revenue Schedule

**Observación:** `trigger_rsm_on_churn` filtra por `COALESCE(is_total_row, false) = false`

**Pregunta:** ¿Por qué preservar filas de total al hacer churn?

**Posibles razones:**

-   Las filas de total son agregaciones que no deben eliminarse
-   Se usan para reportes históricos
-   Se recalculan por otro proceso

**Recomendación:**

-   Documentar el propósito de `is_total_row`
-   Verificar que la lógica de churn sea la esperada

---

### 🟡 ADVERTENCIA: Trigger de Workflow Solo en UPDATE

**Problema:** `trigger_log_contract_workflow_transition` solo se ejecuta en UPDATE.

**Escenario problemático:**

```sql
-- Si se inserta un contrato con current_step_id ya asignado:
INSERT INTO contracts (current_step_id, ...) VALUES (123, ...);
-- No se registra en contract_workflow_history
```

**Recomendación:**

-   Considerar agregar INSERT al trigger si se necesita logging desde el inicio
-   O documentar que el primer paso del workflow debe registrarse manualmente

---

### 🟡 ADVERTENCIA: Condición de Churn Podría Ser Más Robusta

**Problema:** `trigger_rsm_on_churn` solo verifica:

```sql
IF OLD.churn_date IS NOT NULL OR NEW.churn_date IS NULL THEN
  RETURN NEW;
END IF;
```

**Escenario no manejado:**

-   ¿Qué pasa si `churn_date` cambia de una fecha a otra fecha diferente?
-   Actualmente, no se ejecutaría la limpieza

**Recomendación:**

```sql
-- Considerar:
IF OLD.churn_date IS DISTINCT FROM NEW.churn_date
   AND NEW.churn_date IS NOT NULL THEN
  -- Ejecutar limpieza con la nueva fecha
END IF;
```

---

## 📋 Resumen de Triggers por Timing

### BEFORE INSERT OR UPDATE

1. `trg_set_booking_date_on_activate` → `set_booking_date_on_activate()`
2. `trigger_set_contract_company_currency` → `set_contract_company_currency()`
3. `validate_contract_currency_trigger` → `validate_contract_currency_consistency()`

### BEFORE UPDATE

1. `trigger_log_contract_workflow_transition` → `log_contract_workflow_transition()`
2. `trg_prevent_end_date_update_when_active` → `prevent_end_date_update_when_active()`
3. `validate_fx_before_firmado` → `validate_fx_confirmation_before_firmado()`

### AFTER INSERT OR UPDATE

1. `trigger_auto_calculate_contract_fx` → `auto_calculate_contract_fx()`
2. `unified_generate_invoices_on_contract_signed` → `trigger_generate_invoices_on_contract_signed()`

### AFTER UPDATE

1. `generate_invoices_on_contract_active` → `trigger_generate_invoices_on_status_change()`
2. `trigger_revenue_schedule_on_contract_activation` → `trigger_revenue_schedule_on_contract_activation()`
3. `trg_rsm_on_churn` → `trigger_rsm_on_churn()`

---

## 🎯 Recomendaciones Prioritarias

### 1. **CRÍTICO - Resolver Duplicación de Generación de Facturas**

-   Eliminar uno de los dos triggers de generación de facturas
-   O clarificar responsabilidades para evitar ejecución doble

### 2. **ALTO - Documentar Orden de Ejecución**

-   Crear diagrama de flujo de triggers por operación (INSERT/UPDATE)
-   Documentar dependencias entre triggers

### 3. **MEDIO - Mejorar Manejo de Churn**

-   Permitir actualización de churn_date (no solo NULL → fecha)
-   Documentar comportamiento esperado

### 4. **MEDIO - Verificar Funciones Externas**

-   Asegurar que todas las funciones llamadas existan
-   Documentar sus contratos

### 5. **BAJO - Agregar Trigger en contract_items**

-   Para validar moneda al insertar/actualizar items
-   Complementa la validación en contracts

---

## 📊 Matriz de Impacto por Estado del Contrato

| Trigger                       | INSERT            | UPDATE a Firmado | UPDATE a Activo | UPDATE (otros)   | Churn           |
| ----------------------------- | ----------------- | ---------------- | --------------- | ---------------- | --------------- |
| set_contract_company_currency | ✅                | ✅               | ✅              | ✅               | ✅              |
| set_booking_date_on_activate  | Si Activo         | -                | ✅              | -                | -               |
| validate_contract_currency    | ✅                | ✅               | ✅              | ✅               | ✅              |
| validate_fx_before_firmado    | -                 | ✅               | -               | -                | -               |
| log_workflow_transition       | -                 | Si cambió step   | Si cambió step  | Si cambió step   | Si cambió step  |
| prevent_end_date_update       | -                 | Si cambió fecha  | Si cambió fecha | Si cambió fecha  | Si cambió fecha |
| auto_calculate_contract_fx    | Si Firmado/Activo | ✅               | ✅              | Si cambió campos | -               |
| generate_invoices (signed)    | Si Firmado/Activo | ✅               | ✅              | -                | -               |
| generate_invoices (active)    | -                 | -                | ✅              | -                | -               |
| revenue_schedule_rebuild      | -                 | -                | ✅              | -                | -               |
| rsm_on_churn                  | -                 | -                | -               | -                | ✅              |

---

## 🔗 Dependencias entre Triggers

```
BEFORE INSERT/UPDATE:
  1. set_contract_company_currency (asigna company_currency)
  2. set_booking_date_on_activate (asigna booking_date si Activo)
  3. validate_contract_currency (valida monedas)
     ↓
BEFORE UPDATE (solo updates):
  4. log_workflow_transition (registra cambios de step)
  5. prevent_end_date_update (valida fecha término)
  6. validate_fx_before_firmado (valida FX si Firmado)
     ↓
  [REGISTRO SE GUARDA EN BD]
     ↓
AFTER INSERT/UPDATE:
  7. auto_calculate_contract_fx (calcula FX si Firmado/Activo)
  8. unified_generate_invoices (genera facturas si Firmado/Activo)
     ↓
AFTER UPDATE (solo updates):
  9. generate_invoices_active (⚠️ DUPLICADO - genera si Activo)
  10. revenue_schedule_rebuild (reconstruye RSM si Activo)
  11. rsm_on_churn (limpia RSM futuro si churn)
```

---

## 📝 Notas Finales

### Fortalezas del Sistema

-   ✅ Separación clara entre validaciones (BEFORE) y acciones (AFTER)
-   ✅ Protección contra duplicados en generación de facturas
-   ✅ Manejo de errores apropiado para operaciones no críticas
-   ✅ Logging automático de transiciones de workflow
-   ✅ Auto-población de campos para mejorar UX

### Áreas de Mejora

-   ⚠️ Eliminar duplicación en generación de facturas
-   ⚠️ Documentar orden de ejecución y dependencias
-   ⚠️ Mejorar manejo de casos edge (churn update, workflow en INSERT)
-   ⚠️ Verificar existencia de funciones externas
-   ⚠️ Considerar agregar tests unitarios para triggers

### Próximos Pasos Sugeridos

1. Revisar y decidir estrategia para generación de facturas
2. Crear tests de integración para flujos completos
3. Documentar funciones externas y sus contratos
4. Implementar monitoreo de WARNINGs en producción
5. Crear diagrama visual del flujo de triggers

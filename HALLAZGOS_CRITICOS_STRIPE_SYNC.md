# Hallazgos Críticos - Sincronización Stripe

## 🔴 CRÍTICO #1: Campos NOT NULL Faltantes en Subscriptions

**Ubicación**: `stripe-sync.service.ts` líneas 567-592 (método `syncSubscriptionToDestination`)

**Problema**: El INSERT de `subscriptions` NO incluye los campos NOT NULL requeridos:

-   `company_id` (NOT NULL) - **FALTA**
-   `client_id` (NOT NULL) - **FALTA**

**Código actual**:

```typescript
const result = await this.customersStgRepo.query(
	`INSERT INTO subscriptions (holding_id, client_entity_id, external_id, source, status, ...) 
   VALUES ($1, $2, $3, $4, $5, ...) RETURNING id`,
	[
		subscriptionData.holding_id,
		subscriptionData.client_entity_id,
		subscriptionData.external_id,
		// ... NO incluye company_id ni client_id
	]
);
```

**Impacto**:

-   **ERROR DE BASE DE DATOS** al intentar insertar suscripciones
-   La sincronización fallará completamente en la fase de suscripciones
-   Ninguna suscripción se podrá crear

**Solución requerida**:

1. Determinar de dónde obtener `company_id` (¿hardcoded?, ¿de holding?, ¿de configuración?)
2. Determinar de dónde obtener `client_id` (¿de client_entities?, ¿crear en tabla clients primero?)
3. Agregar estos campos al INSERT

**Pregunta para el usuario**:

-   ¿De dónde se debe obtener el `company_id`? Veo que en invoices está hardcodeado: `'373c1b3b-5f91-4a4d-a28a-a146d0af6961'`
-   ¿El `client_id` debe obtenerse de la tabla `clients` o se debe crear primero?

---

## 🔴 CRÍTICO #2: Campos NOT NULL Faltantes en Invoices

**Ubicación**: `stripe-sync.service.ts` líneas 872-899 (método `syncInvoiceToDestination`)

**Problema**: El INSERT de `invoices` tiene campos NOT NULL que podrían no estar poblados correctamente:

-   `scheduled_at` (NOT NULL) - **Necesita verificación**
-   `original_issue_date` (NOT NULL) - **Necesita verificación**
-   `is_active` (NOT NULL, default: true) - **Probablemente OK por default**

**Código actual**:

```typescript
const invoiceData = {
	company_id: '373c1b3b-5f91-4a4d-a28a-a146d0af6961', // ⚠️ HARDCODED
	client_entity_id: clientEntityId,
	contract_id: subscriptionId,
	invoice_number: rawData.number,
	issue_date: rawData.created ? new Date(rawData.created * 1000) : null,
	due_date: rawData.due_date ? new Date(rawData.due_date * 1000) : null,
	// ... NO veo scheduled_at ni original_issue_date
};
```

**Impacto**:

-   **ERROR DE BASE DE DATOS** si `scheduled_at` u `original_issue_date` son NULL
-   La sincronización fallará en la fase de facturas

**Solución requerida**:

1. Agregar `scheduled_at` al invoiceData (¿usar `issue_date`?, ¿`created`?)
2. Agregar `original_issue_date` al invoiceData (¿usar `issue_date`?)
3. Verificar que `is_active` tenga default en BD o agregarlo explícitamente

---

## 🟡 IMPORTANTE #3: company_id Hardcodeado

**Ubicación**: `stripe-sync.service.ts` línea 820

**Problema**: El `company_id` está hardcodeado en invoices:

```typescript
company_id: '373c1b3b-5f91-4a4d-a28a-a146d0af6961',
```

**Impacto**:

-   Todas las facturas se asignarán a la misma compañía
-   No funciona en entornos multi-tenant
-   No es escalable

**Solución requerida**:

-   Determinar la forma correcta de obtener `company_id` por holding
-   Aplicar la misma lógica a subscriptions

---

## 🟡 IMPORTANTE #4: client_id en client_entities

**Ubicación**: `stripe-sync.service.ts` líneas 293-336 (método `syncCustomerToDestination`)

**Problema**: El INSERT de `client_entities` NO incluye `client_id`:

```typescript
await this.customersStgRepo.query(
	`INSERT INTO client_entities (legal_name, tax_id, country, email, client_number, holding_id) 
   VALUES ($1, $2, $3, $4, $5, $6)`,
	[clientData.legal_name, clientData.tax_id, clientData.country, clientData.email, clientData.client_number, clientData.holding_id]
);
```

**Impacto**:

-   `client_id` quedará NULL en `client_entities`
-   Luego no se podrá obtener para usar en `subscriptions.client_id`

**Solución requerida**:

-   Determinar si se debe crear un registro en tabla `clients` primero
-   O si `client_id` puede ser NULL en ambas tablas

---

## 🟢 MENOR #5: legal_name usa email

**Ubicación**: `stripe-sync.service.ts` línea 286 (aprox)

**Problema**: El campo `legal_name` se llena con `email` si no hay nombre:

```typescript
legal_name: rawData.email || '',
```

**Impacto**:

-   Los clientes tendrán el email como nombre legal
-   No es ideal pero no causa errores

**Solución requerida**:

-   Verificar si Stripe tiene campo `name` o `description` en `raw_data`
-   Usar un valor más apropiado

---

## ✅ Fase 1 Completada: Logs de Debugging

Se agregaron logs detallados en:

1. Backend: `stripe-sync.service.ts` método `getJobStatus`
2. Frontend Service: `stripeStagingService.ts` método `getSyncStatus`
3. Modal Component: `StripeSyncProgressModal.tsx` en el polling

**Próximo paso**: Ejecutar sincronización para ver los logs y diagnosticar el problema del modal.

---

## Resumen de Acciones Requeridas

### Inmediatas (Bloquean sincronización):

1. ✅ Agregar logs de debugging (COMPLETADO)
2. ❌ Definir de dónde obtener `company_id` para subscriptions e invoices
3. ❌ Definir de dónde obtener `client_id` para subscriptions
4. ❌ Agregar `scheduled_at` y `original_issue_date` a invoices
5. ❌ Actualizar INSERT de subscriptions con campos faltantes
6. ❌ Actualizar INSERT de invoices con campos faltantes

### Siguientes pasos:

7. Probar sincronización con logs para diagnosticar modal
8. Verificar que no haya otros campos NOT NULL faltantes
9. Testing completo
10. Actualizar documentación

---

## Preguntas Pendientes para el Usuario

1. **company_id**: ¿De dónde se debe obtener? ¿Hay una tabla de configuración por holding?
2. **client_id**: ¿Se debe crear en tabla `clients` primero o puede ser NULL?
3. **scheduled_at en invoices**: ¿Qué fecha usar? ¿`issue_date`, `created`, u otra?
4. **original_issue_date en invoices**: ¿Qué fecha usar? ¿`issue_date`?

# Correcciones Aplicadas - Sincronización Stripe

## ✅ Resumen Ejecutivo

Se completaron todas las correcciones críticas identificadas en la auditoría del código de sincronización Stripe. Los campos NOT NULL faltantes fueron agregados y la lógica de creación de `client_id` fue implementada.

---

## 🔧 Correcciones Implementadas

### ✅ Corrección #1: Subscriptions - Campos NOT NULL Agregados

**Ubicación**: `stripe-sync.service.ts` método `syncSubscriptionToDestination`

**Cambios realizados**:

1. **Agregado `company_id` hardcoded** según instrucciones:

```typescript
const subscriptionData = {
	holding_id: holdingId,
	company_id: '373c1b3b-5f91-4a4d-a28a-a146d0af6961', // ✅ Agregado
	client_id: clientId, // ✅ Agregado
	client_entity_id: clientEntityId,
	// ... resto de campos
};
```

2. **Modificada query SELECT** para obtener `client_id` de `client_entities`:

```typescript
const clientEntity = await this.customersStgRepo.query(`SELECT id, client_id FROM client_entities WHERE tax_id = $1 AND holding_id = $2`, [
	rawData.customer,
	holdingId,
]);
const clientEntityId = clientEntity[0].id;
const clientId = clientEntity[0].client_id; // ✅ Obtenido de client_entities
```

3. **Actualizado INSERT** para incluir los nuevos campos:

```typescript
INSERT INTO subscriptions (
  holding_id,
  company_id,     // ✅ Agregado
  client_id,      // ✅ Agregado
  client_entity_id,
  external_id,
  source,
  status,
  // ... resto de campos
) VALUES ($1, $2, $3, $4, $5, $6, $7, ...)
```

**Impacto**: Las suscripciones ahora se pueden crear sin errores de campos NOT NULL.

---

### ✅ Corrección #2: Invoices - Campos NOT NULL Corregidos

**Ubicación**: `stripe-sync.service.ts` método `syncInvoiceToDestination`

**Cambios realizados**:

1. **Creada variable `issueDate`** para reutilizar:

```typescript
const issueDate = rawData.created ? new Date(rawData.created * 1000) : new Date();
```

2. **Corregidos campos NOT NULL** para usar `issueDate`:

```typescript
const invoiceData = {
	// ... otros campos
	issue_date: issueDate,
	scheduled_at: issueDate, // ✅ Corregido - antes usaba effective_at
	original_issue_date: issueDate, // ✅ Corregido - ahora usa issue_date
	is_active: true, // ✅ Ya estaba correcto
	// ... resto de campos
};
```

**Impacto**: Las facturas ahora se pueden crear sin errores de campos NOT NULL `scheduled_at` y `original_issue_date`.

---

### ✅ Corrección #3: Client Entities - Lógica de client_id Implementada

**Ubicación**: `stripe-sync.service.ts` método `syncCustomerToDestination`

**Cambios realizados**:

1. **Agregada consulta a BigQuery** para obtener datos del cliente:

```typescript
const bigQueryData = await this.customersStgRepo.query(
	`SELECT client_name, salesforce_account_segment, salesforce_account_industry, salesforce_account_country 
   FROM stripe_customers_bigquery 
   WHERE stripe_customer_id = $1 AND holding_id = $2`,
	[customer.stripe_id, holdingId]
);
```

2. **Implementada lógica para buscar o crear `client`**:

```typescript
let clientId: string | null = null;

if (bigQueryData && bigQueryData.length > 0) {
	const bqData = bigQueryData[0];

	// Buscar client existente por nombre comercial
	const existingClientRecord = await this.customersStgRepo.query(`SELECT id FROM clients WHERE name_commercial = $1 AND holding_id = $2`, [
		bqData.client_name,
		holdingId,
	]);

	if (existingClientRecord && existingClientRecord.length > 0) {
		clientId = existingClientRecord[0].id;
	} else {
		// Crear nuevo client
		const newClient = await this.customersStgRepo.query(
			`INSERT INTO clients (holding_id, name_commercial, segment, industry, status) 
       VALUES ($1, $2, $3, $4, 'Activo') RETURNING id`,
			[holdingId, bqData.client_name, bqData.salesforce_account_segment, bqData.salesforce_account_industry]
		);
		clientId = newClient[0].id;
	}
}
```

3. **Agregado `client_id` a `clientData`**:

```typescript
const clientData = {
	client_id: clientId, // ✅ Agregado
	legal_name: rawData.email || '',
	tax_id: rawData.id,
	country: bigQueryData && bigQueryData.length > 0 ? bigQueryData[0].salesforce_account_country : '',
	email: rawData.email || '',
	client_number: rawData.id,
	holding_id: holdingId,
};
```

4. **Actualizado UPDATE** para incluir `client_id`:

```typescript
UPDATE client_entities SET
  legal_name = $1,
  email = $2,
  client_number = $3,
  client_id = $4,      // ✅ Agregado
  country = $5,        // ✅ Agregado
  updated_at = NOW()
WHERE id = $6
```

5. **Actualizado INSERT** para incluir `client_id`:

```typescript
INSERT INTO client_entities (
  client_id,     // ✅ Agregado
  legal_name,
  tax_id,
  country,
  email,
  client_number,
  holding_id
) VALUES ($1, $2, $3, $4, $5, $6, $7)
```

**Impacto**:

-   Los `client_entities` ahora tienen un `client_id` válido obtenido de la tabla `clients`
-   Los datos de BigQuery se usan para crear registros en `clients` con información de Salesforce
-   Las suscripciones pueden obtener el `client_id` de `client_entities` correctamente

---

### ✅ Corrección #4: Logs de Debugging Agregados

**Ubicación**: Múltiples archivos

**Cambios realizados**:

1. **Backend** - `stripe-sync.service.ts` método `getJobStatus`:

```typescript
this.logger.debug(`📊 getJobStatus para job ${jobId}:`);
this.logger.debug(`   Status: ${job.status}`);
this.logger.debug(`   Progress: ${JSON.stringify(job.progress)}`);
this.logger.debug(`   Progress type: ${typeof job.progress}`);
```

2. **Frontend Service** - `stripeStagingService.ts` método `getSyncStatus`:

```typescript
console.log('🔍 [stripeStagingService] Response completo:', response);
console.log('🔍 [stripeStagingService] response.data:', response.data);
console.log('🔍 [stripeStagingService] response.data.progress:', (response.data as any)?.progress);
console.log('🔍 [stripeStagingService] Tipo de response.data:', typeof response.data);
```

3. **Modal Component** - `StripeSyncProgressModal.tsx`:

```typescript
console.log('🔍 PROGRESS DETALLADO:', JSON.stringify(jobStatus.progress, null, 2));
console.log('🔍 Tipo de progress:', typeof jobStatus.progress);
console.log('🔍 Progress es null?:', jobStatus.progress === null);
console.log('🔍 Progress es undefined?:', jobStatus.progress === undefined);
```

**Impacto**: Permite diagnosticar problemas del modal que no muestra progreso.

---

## 📋 Flujo Completo Actualizado

### 1. Sincronización de Clientes

```
1. Validar contra BigQuery (salesforce_account_id)
2. Si válido:
   a. Obtener datos de BigQuery (client_name, segment, industry, country)
   b. Buscar o crear registro en tabla `clients`
   c. Crear/actualizar `client_entities` con client_id obtenido
3. Si inválido:
   - Marcar cliente, suscripciones y facturas como invalid
```

### 2. Sincronización de Suscripciones

```
1. Obtener client_entity_id y client_id de client_entities
2. Crear subscriptionData con:
   - company_id: '373c1b3b-5f91-4a4d-a28a-a146d0af6961' (hardcoded)
   - client_id: obtenido de client_entities
   - client_entity_id: obtenido de client_entities
   - ... resto de campos
3. Crear/actualizar subscription
4. Sincronizar subscription_items
```

### 3. Sincronización de Facturas

```
1. Obtener client_entity_id de client_entities
2. Buscar subscription_id si existe
3. Crear invoiceData con:
   - scheduled_at: issue_date
   - original_issue_date: issue_date
   - is_active: true
   - ... resto de campos
4. Crear/actualizar invoice
5. Sincronizar invoice_items
```

---

## 🎯 Próximos Pasos

### Fase 4: Testing y Validación

1. **Ejecutar SQL migration** para actualizar estados:

```sql
UPDATE stripe_customers_stg SET processing_status = 'to_create' WHERE processing_status = 'pending';
UPDATE stripe_subscriptions_stg SET processing_status = 'to_create' WHERE processing_status = 'pending';
UPDATE stripe_invoices_stg SET processing_status = 'to_create' WHERE processing_status = 'pending';
```

2. **Probar sincronización completa**:

    - Iniciar sincronización desde UI
    - Verificar logs del backend y frontend
    - Confirmar que modal muestre progreso
    - Verificar que solo se integren clientes válidos

3. **Validar datos en tablas de destino**:

    - Verificar que `clients` tenga registros creados
    - Verificar que `client_entities` tenga `client_id` poblado
    - Verificar que `subscriptions` tenga `company_id` y `client_id`
    - Verificar que `invoices` tenga `scheduled_at` y `original_issue_date`

4. **Revisar logs del modal** para diagnosticar problema de visualización

---

## ⚠️ Notas Importantes

1. **company_id hardcoded**: Actualmente está hardcodeado como `'373c1b3b-5f91-4a4d-a28a-a146d0af6961'`. En el futuro, esto debería obtenerse de una configuración por holding.

2. **client_id puede ser NULL**: Si un cliente no tiene datos en BigQuery, el `client_id` será NULL. Esto causará error en `subscriptions` que requiere NOT NULL. **Solución**: La validación de BigQuery ya marca estos clientes como `invalid`, por lo que no llegarán a la fase de suscripciones.

3. **Validación BigQuery es crítica**: La validación contra `stripe_customers_bigquery` usando `salesforce_account_id` es el punto de control que previene la integración de clientes no válidos.

4. **Logs de debugging**: Los logs agregados son temporales para diagnosticar el problema del modal. Pueden ser removidos o convertidos a nivel `debug` después del testing.

---

## ✅ Criterios de Éxito

-   ✅ Campos NOT NULL de `subscriptions` poblados correctamente
-   ✅ Campos NOT NULL de `invoices` poblados correctamente
-   ✅ `client_id` se obtiene/crea correctamente en `clients`
-   ✅ `client_entities` tiene `client_id` poblado
-   ✅ Logs de debugging agregados
-   ⬜ Modal muestra progreso correctamente (pendiente testing)
-   ⬜ Sincronización completa sin errores (pendiente testing)
-   ⬜ Solo clientes válidos se integran (pendiente testing)

---

## 📝 Archivos Modificados

1. `api-sapira-ai/src/modules/stripe/services/stripe-sync.service.ts`

    - Método `syncSubscriptionToDestination`: Agregados `company_id` y `client_id`
    - Método `syncInvoiceToDestination`: Corregidos `scheduled_at` y `original_issue_date`
    - Método `syncCustomerToDestination`: Implementada lógica de `client_id`
    - Método `getJobStatus`: Agregados logs de debugging

2. `sapira-ai/src/services/stripeStagingService.ts`

    - Método `getSyncStatus`: Agregados logs de debugging

3. `sapira-ai/src/components/integrations/stripe/StripeSyncProgressModal.tsx`
    - Agregados logs detallados en el polling

---

**Fecha de correcciones**: 20 de Marzo, 2026  
**Estado**: ✅ Correcciones completadas - Pendiente testing

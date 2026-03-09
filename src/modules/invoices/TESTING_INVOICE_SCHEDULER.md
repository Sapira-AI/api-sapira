# Guía de Testing - Invoice Scheduler

Esta guía te ayudará a probar el sistema de emisión automática de facturas con conversión de moneda.

## 📋 Prerequisitos

1. Tener facturas en estado "Por Emitir"
2. Configurar variable de entorno `INVOICE_ADMIN_EMAILS` en tu `.env`
3. Tener configurado `SENDGRID_API_KEY` y `SYSTEM_EMAIL_FROM` para notificaciones

## 🔧 Paso 1: Preparar Facturas de Prueba

### Opción A: Actualizar una factura existente

```sql
-- Ver facturas disponibles para prueba
SELECT
    id,
    invoice_number,
    status,
    issue_date,
    contract_currency,
    invoice_currency,
    amount_contract_currency,
    amount_invoice_currency
FROM invoices
WHERE status = 'Por Emitir'
ORDER BY created_at DESC
LIMIT 10;

-- Actualizar issue_date de una factura específica a HOY
UPDATE invoices
SET issue_date = CURRENT_DATE
WHERE id = 'TU_INVOICE_ID_AQUI';

-- Verificar el cambio
SELECT
    id,
    invoice_number,
    issue_date,
    contract_currency,
    invoice_currency,
    status
FROM invoices
WHERE id = 'TU_INVOICE_ID_AQUI';
```

### Opción B: Crear factura de prueba completa

```sql
-- Insertar factura de prueba con conversión de moneda
INSERT INTO invoices (
    contract_id,
    invoice_number,
    issue_date,
    due_date,
    amount_contract_currency,
    contract_currency,
    invoice_currency,
    status,
    holding_id,
    client_entity_id,
    company_id,
    notes
) VALUES (
    'tu-contract-id',
    'TEST-001',
    CURRENT_DATE,
    CURRENT_DATE + INTERVAL '30 days',
    1000.00,
    'USD',
    'CLP',
    'Por Emitir',
    'tu-holding-id',
    'tu-client-entity-id',
    'tu-company-id',
    'Factura de prueba para testing de scheduler'
);

-- Obtener el ID de la factura creada
SELECT id, invoice_number FROM invoices WHERE invoice_number = 'TEST-001';
```

### Opción C: Actualizar múltiples facturas para prueba masiva

```sql
-- Actualizar las primeras 5 facturas "Por Emitir" a fecha de hoy
UPDATE invoices
SET issue_date = CURRENT_DATE
WHERE id IN (
    SELECT id
    FROM invoices
    WHERE status = 'Por Emitir'
    ORDER BY created_at DESC
    LIMIT 5
);
```

## 🚀 Paso 2: Ejecutar el Scheduler Manualmente

### Opción 1: Usando el endpoint HTTP (Recomendado)

```bash
# Ejecutar en modo DRY RUN (no envía a Odoo, solo simula)
curl -X POST http://localhost:8081/invoices/scheduler/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_TOKEN_AQUI" \
  -d '{
    "dryRun": true
  }'

# Ejecutar en modo REAL (envía a Odoo)
curl -X POST http://localhost:8081/invoices/scheduler/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_TOKEN_AQUI" \
  -d '{
    "dryRun": false
  }'

# Ejecutar solo para un holding específico
curl -X POST http://localhost:8081/invoices/scheduler/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_TOKEN_AQUI" \
  -H "X-Holding-Id: tu-holding-id" \
  -d '{
    "dryRun": true
  }'
```

### Opción 2: Usando Postman/Insomnia

**Endpoint**: `POST http://localhost:8081/invoices/scheduler/send`

**Headers**:

```
Content-Type: application/json
Authorization: Bearer TU_TOKEN_AQUI
X-Holding-Id: tu-holding-id (opcional)
```

**Body**:

```json
{
	"dryRun": true
}
```

## 📊 Paso 3: Verificar Resultados

### 3.1 Revisar Respuesta del Endpoint

La respuesta incluirá:

```json
{
	"success": true,
	"dryRun": true,
	"summary": {
		"total": 5,
		"sent": 4,
		"errors": 0,
		"skipped": 1
	},
	"results": [
		{
			"invoiceId": "uuid-1",
			"invoiceNumber": "FAC-001",
			"status": "sent",
			"details": "DRY RUN - Factura se enviaría a Odoo...",
			"odooInvoiceId": null
		},
		{
			"invoiceId": "uuid-2",
			"invoiceNumber": "FAC-002",
			"status": "skipped",
			"error": "No hay tipo de cambio disponible...",
			"details": "No se pudo calcular tipo de cambio..."
		}
	],
	"executedAt": "2026-03-09T07:00:00.000Z"
}
```

### 3.2 Verificar Logs del Servidor

Busca en los logs:

```bash
# Logs de inicio
🚀 Iniciando procesamiento de facturas - DryRun: true

# Logs de cálculo de tipo de cambio
Calculando montos para factura FAC-001 (uuid-1)
✓ Montos calculados para factura FAC-001: USD 1000 → CLP 950000.00 (FX: 950)

# Logs de tipo de cambio fallback (warning)
⚠️ Tipo de cambio fallback usado para factura FAC-001: USD/CLP = 950 (fecha: 2026-03-08)

# Logs de error (si no hay tipo de cambio)
✗ No se pudo obtener tipo de cambio para factura FAC-002
✗ Factura FAC-002 omitida: No hay tipo de cambio disponible...

# Logs de envío a Odoo
📤 Enviando factura FAC-001 a Odoo...
✓ Factura FAC-001 enviada exitosamente (Odoo ID: 12345)
```

### 3.3 Verificar Base de Datos

```sql
-- Ver facturas procesadas
SELECT
    id,
    invoice_number,
    status,
    contract_currency,
    invoice_currency,
    amount_contract_currency,
    amount_invoice_currency,
    fx_contract_to_invoice,
    odoo_invoice_id,
    sent_to_odoo_at
FROM invoices
WHERE issue_date = CURRENT_DATE
ORDER BY created_at DESC;

-- Ver items de factura con montos calculados
SELECT
    ii.id,
    i.invoice_number,
    ii.description,
    ii.unit_price_contract_currency,
    ii.unit_price_invoice_currency,
    ii.total_contract_currency,
    ii.total_invoice_currency,
    ii.fx_contract_to_invoice
FROM invoice_items ii
JOIN invoices i ON i.id = ii.invoice_id
WHERE i.issue_date = CURRENT_DATE;
```

### 3.4 Verificar Emails de Notificación

Revisa tu bandeja de entrada (emails configurados en `INVOICE_ADMIN_EMAILS`):

**Email 1: Tipo de Cambio Fallback**

-   Asunto: `⚠️ Factura Emitida con Tipo de Cambio Fallback - FAC-001`
-   Contenido: Información de la factura y tipo de cambio usado

**Email 2: Tipo de Cambio No Disponible**

-   Asunto: `🚨 Factura NO Emitida - Tipo de Cambio No Disponible - FAC-002`
-   Contenido: Información de la factura y acción requerida

## 🧪 Escenarios de Prueba

### Escenario 1: Factura con Misma Moneda (Sin Conversión)

```sql
UPDATE invoices
SET
    issue_date = CURRENT_DATE,
    contract_currency = 'CLP',
    invoice_currency = 'CLP'
WHERE id = 'tu-invoice-id';
```

**Resultado esperado**:

-   ✅ Factura enviada sin cálculo de tipo de cambio
-   ✅ No se envían notificaciones
-   ✅ `fx_contract_to_invoice = 1`

### Escenario 2: Factura con Conversión y Tipo de Cambio Disponible

```sql
UPDATE invoices
SET
    issue_date = CURRENT_DATE,
    contract_currency = 'USD',
    invoice_currency = 'CLP'
WHERE id = 'tu-invoice-id';
```

**Resultado esperado**:

-   ✅ Factura enviada con montos calculados
-   ✅ No se envían notificaciones (tipo de cambio exacto)
-   ✅ `amount_invoice_currency` y `fx_contract_to_invoice` calculados

### Escenario 3: Factura con Conversión y Tipo de Cambio Fallback

```sql
-- Usar fecha de mañana (probablemente no hay tipo de cambio aún)
UPDATE invoices
SET
    issue_date = CURRENT_DATE + INTERVAL '1 day',
    contract_currency = 'USD',
    invoice_currency = 'CLP'
WHERE id = 'tu-invoice-id';
```

**Resultado esperado**:

-   ✅ Factura enviada con tipo de cambio del día anterior
-   ⚠️ Email de notificación de fallback enviado
-   ✅ Montos calculados con tipo de cambio fallback

### Escenario 4: Factura sin Tipo de Cambio Disponible

```sql
-- Usar moneda exótica o fecha muy futura
UPDATE invoices
SET
    issue_date = CURRENT_DATE,
    contract_currency = 'EUR',
    invoice_currency = 'MXN'
WHERE id = 'tu-invoice-id';
```

**Resultado esperado**:

-   ❌ Factura NO enviada
-   🚨 Email de notificación de error enviado
-   ❌ Status permanece en "Por Emitir"

## 🔍 Troubleshooting

### Problema: No se envían emails

**Verificar**:

```bash
# En tu .env
INVOICE_ADMIN_EMAILS=admin@example.com,finance@example.com
SENDGRID_API_KEY=tu_api_key
SYSTEM_EMAIL_FROM=noreply@tudominio.com
SYSTEM_EMAIL_FROM_NAME=Sistema Sapira
```

### Problema: Factura no se procesa

**Verificar**:

1. `status = 'Por Emitir'`
2. `issue_date <= CURRENT_DATE`
3. `client_entity_id` tiene `odoo_partner_id`
4. `company_id` tiene `odoo_integration_id`
5. Factura tiene items

```sql
-- Query de diagnóstico
SELECT
    i.id,
    i.invoice_number,
    i.status,
    i.issue_date,
    i.client_entity_id,
    ce.odoo_partner_id,
    i.company_id,
    c.odoo_integration_id,
    (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id) as items_count
FROM invoices i
LEFT JOIN client_entities ce ON ce.id = i.client_entity_id
LEFT JOIN companies c ON c.id = i.company_id
WHERE i.id = 'tu-invoice-id';
```

### Problema: Error de tipo de cambio

**Verificar que existan tipos de cambio**:

```sql
SELECT * FROM exchange_rates
WHERE from_currency = 'USD'
  AND to_currency = 'CLP'
  AND rate_date >= CURRENT_DATE - INTERVAL '7 days'
ORDER BY rate_date DESC;
```

## 📝 Checklist de Testing

-   [ ] Configurar variables de entorno
-   [ ] Actualizar `issue_date` de factura de prueba
-   [ ] Ejecutar scheduler en modo `dryRun: true`
-   [ ] Verificar logs del servidor
-   [ ] Revisar respuesta del endpoint
-   [ ] Verificar base de datos (montos calculados)
-   [ ] Verificar emails recibidos
-   [ ] Ejecutar scheduler en modo `dryRun: false`
-   [ ] Verificar factura en Odoo
-   [ ] Probar escenarios de error

## 🎯 Comandos Rápidos

```bash
# Ver facturas listas para procesar
psql -d tu_database -c "SELECT id, invoice_number, issue_date, status FROM invoices WHERE status = 'Por Emitir' AND issue_date <= CURRENT_DATE LIMIT 10;"

# Actualizar issue_date a hoy
psql -d tu_database -c "UPDATE invoices SET issue_date = CURRENT_DATE WHERE id = 'tu-invoice-id';"

# Ejecutar scheduler (dry run)
curl -X POST http://localhost:8081/invoices/scheduler/send -H "Content-Type: application/json" -H "Authorization: Bearer TU_TOKEN" -d '{"dryRun": true}'

# Ver resultado en BD
psql -d tu_database -c "SELECT id, invoice_number, status, amount_invoice_currency, fx_contract_to_invoice, odoo_invoice_id FROM invoices WHERE id = 'tu-invoice-id';"
```

## 📚 Referencias

-   Endpoint: `POST /invoices/scheduler/send`
-   Servicio: `InvoiceSchedulerService.processInvoicesToSend()`
-   Método de cálculo: `InvoiceSchedulerService.calculateInvoiceAmountsAtIssue()`
-   Notificaciones: `InvoiceNotificationService`

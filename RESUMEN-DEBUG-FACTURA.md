# 🔍 Resumen Debug - Factura no se envía a Odoo

**Factura ID:** `d0d561c1-8908-440b-9581-c9c65431ab14`  
**Cliente:** Avicola Nacional S.A. (RUT: 890911625-1)  
**Fecha:** 2026-04-25

---

## ❌ Problemas Encontrados

### 1. **Cliente sin `odoo_partner_id`** (CRÍTICO)

El cliente "Avicola Nacional S.A." no tiene configurado el `odoo_partner_id` en la tabla `client_entities`.

**Estado actual:**

```json
{
  "id": "6da66d80-d62a-4d2d-a355-4347d88dfab4",
  "legal_name": "Avicola Nacional S.A.",
  "odoo_partner_id": null  ❌
}
```

**Solución:**

1. Ve a Odoo → Contactos
2. Busca "Avicola Nacional S.A." o RUT "890911625-1"
3. Abre el contacto y obtén el ID de la URL (ejemplo: `/web#id=123&...`)
4. Ejecuta en la BD:

```sql
UPDATE client_entities
SET odoo_partner_id = 123  -- Reemplaza con el ID real
WHERE id = '6da66d80-d62a-4d2d-a355-4347d88dfab4';
```

### 2. **Comparación de fechas incorrecta** (CORREGIDO)

La comparación `invoice.issue_date <= new Date()` estaba fallando porque comparaba un string con un objeto Date.

**Solución aplicada:**

-   ✅ Convertir `issue_date` a Date antes de comparar
-   ✅ Configurar hora del día a 23:59:59 para incluir todo el día actual

---

## ✅ Verificaciones que SÍ pasaron

-   ✅ Status = "Por Emitir"
-   ✅ Sent to Odoo At IS NULL
-   ✅ Issue Date en el mismo mes
-   ✅ Client Entity existe
-   ✅ Company existe
-   ✅ Company tiene `odoo_integration_id` = 3
-   ✅ Contract existe
-   ✅ Contract tiene `auto_send_to_odoo` = true
-   ✅ Factura tiene items (1 item)

---

## 📋 Datos de la Factura

```json
{
	"invoice_number": null,
	"status": "Por Emitir",
	"issue_date": "2026-04-25",
	"holding_id": "5652e95e-bb99-48f5-aa1c-13c8c2638fc6",
	"contract_id": "25e87362-8af0-4ed9-9d73-67c8ee07a736",
	"contract_number": "S06900"
}
```

---

## 🚀 Próximos Pasos

1. **URGENTE:** Configurar `odoo_partner_id` para el cliente "Avicola Nacional S.A."
2. Volver a ejecutar el debug: `GET /invoices/scheduler/debug/d0d561c1-8908-440b-9581-c9c65431ab14`
3. Verificar que todos los checks pasen
4. Ejecutar el scheduler: `POST /invoices/scheduler/send` con `dryRun: false`

---

## 🛠️ Herramientas Creadas

-   ✅ Endpoint de debug: `GET /invoices/scheduler/debug/:invoiceId`
-   ✅ Script SQL: `scripts/debug-invoice.sql`
-   ✅ Script Node.js: `scripts/debug-invoice.js`
-   ✅ Script de corrección: `scripts/fix-missing-odoo-partner-id.sql`
-   ✅ Campo `auto_send_to_odoo` agregado a entidad Contract
-   ✅ Corrección de comparación de fechas en método `debugInvoice()`

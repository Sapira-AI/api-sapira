# Cambio: FX fijo + filtro `is_active` en envío a Odoo

> **Rama:** `feature/odoo-fx-fijo-is-active` (desde `qa`) · Fase 5 del lote FX fijo (junio 2026)
> **Repo front (par):** `sapira-ai` — UI + RPC ya cerradas y commiteadas (pendiente solo pasar a producción).
> **Mapa completo del flujo de envío:** `sapira-ai/docs/integraciones/odoo/flujo-envio-facturas-odoo.md`

## Contexto

La feature "FX fijo contrato→factura" se reparte entre dos repos:

- **`sapira-ai` (front):** calcula y **persiste** los montos en moneda de factura
  (`invoices.amount_invoice_currency`, `invoice_items.*_invoice_currency`,
  `fx_contract_to_invoice`) y marca el contrato con `fx_invoice_policy='fixed'`.
- **`api-sapira` (este repo):** al enviar a Odoo solo debe **dejar de pisar esos montos
  con un FX spot**. Odoo no recibe ni aplica FX: recibe montos ya convertidos en
  `invoice_currency`.

Se aprovecha la misma rama para corregir un bug crítico de duplicados (`is_active`).

## Alcance — 2 cambios, ambos en `src/modules/invoices/invoice-scheduler.service.ts`

### 5a — Filtro `is_active` en `getInvoicesToSend`

- **Antes:** selecciona `status='Por Emitir' AND sent_to_odoo_at IS NULL` (sin `is_active`).
- **Después:** se agrega `AND inv.is_active = true`.
- **Motivo:** las facturas **originales de una consolidación** quedan `is_active=false`
  pero siguen en `status='Por Emitir'` → se enviaban a Odoo como **borradores duplicados**.
  Caso de referencia: CTR-2026-44 TNT EXPRESS (2026-06-10), se enviaron 10 borradores
  cuando lo correcto eran 4.
- **Afecta:** cron diario **y** envío manual (ambos usan el mismo selector).

```ts
.andWhere('inv.sent_to_odoo_at IS NULL')
.andWhere('inv.is_active = true')   // ← nuevo
.andWhere("DATE_TRUNC('month', inv.issue_date) = DATE_TRUNC('month', CURRENT_DATE)")
```

### 5b — Guard de FX fijo en `calculateInvoiceAmountsAtIssue`

- **Antes:** siempre pide tasa spot a Banco Central y reescribe
  `amount_invoice_currency` + montos de items + `fx_contract_to_invoice`.
- **Después:** si `contract.fx_invoice_policy='fixed'` **y** `invoice.fx_contract_to_invoice > 0`,
  retorna ese FX **sin consultar Banco Central y sin reescribir la BD** (deja los montos
  que ya persistió el front).
- **Precedencia:** `spot` → recalcula día (actual) · `fixed` + FX seteado → respeta ·
  `fixed` + FX NULL → cae al flujo spot (fallback).

```ts
if (
  invoice.contract?.fx_invoice_policy === 'fixed' &&
  invoice.fx_contract_to_invoice != null &&
  Number(invoice.fx_contract_to_invoice) > 0
) {
  return { success: true, usedFallback: false, exchangeRate: Number(invoice.fx_contract_to_invoice) };
}
```

> El `invoice.contract` ya viene cargado en `InvoiceWithRelations` (`getInvoicesToSend`
> lo adjunta), y las entidades mapean los campos (`contract.entity.ts` → `fx_invoice_policy`,
> `invoice.entity.ts` / `invoice-item.entity.ts` → `fx_contract_to_invoice`). Sin query extra.

**Supuesto (acoplamiento con el front):** el guard *confía* en que la RPC del front haya
guardado `amount_invoice_currency` y los `*_invoice_currency` de cada item con el FX fijo.
Si solo se hubiese guardado `fx_contract_to_invoice` sin los montos, la validación posterior
(`!amount_invoice_currency`) **omite la factura con log** (falla seguro, no envía mal).

## No-regresión

- Tras el backfill, **todos los contratos están en `fx_invoice_policy='spot'`** → el `if`
  de 5b nunca entra → comportamiento **bit a bit idéntico** al actual.
- 5a solo **excluye** facturas que no debían enviarse; no cambia cómo se arma ninguna factura.
- **No se toca** ninguna lógica de emisión electrónica: tipo de documento (PE-only),
  detracción Perú, exportación Chile, IVA/retenciones Colombia (posición fiscal),
  T&C (`narration`), referencias, ni la estructura del payload Odoo.

## Validación

- [ ] `npm run build` + `npm run lint` (sin errores nuevos).
- [ ] **FX fijo:** contrato `fx_invoice_policy='fixed'` + factura con `fx_contract_to_invoice`
      seteado → el envío respeta el FX y **no** llama a Banco Central (log `💱 FX fijo aplicado`).
- [ ] **is_active:** contrato con consolidaciones → el envío **no** incluye las originales
      inactivas (solo consolidadas activas + individuales activas).
- [ ] **Gate de release:** validar junto al front en QA antes de promover a producción.

## Pendiente — próxima sesión, con plan específico

**Tabla de tipos de documento por país/compañía del holding.** Hoy el tipo de documento
solo se asigna automáticamente para **Perú** (`document-type-mapping.service.ts`: códigos
hardcodeados en `ALLOWED_INVOICE_CODES_BY_COUNTRY`, "primero por `sequence`"); para el resto
de países se manda `l10n_latam_document_type_id = undefined` y **lo decide Odoo**. Se quiere
una tabla catálogo en Sapira (con `odoo_document_type_id`) que gobierne la selección para
**todos** los países. Mayor blast radius (toca el envío productivo) → requiere diseño +
validación país por país en sesión aparte (modo plan).

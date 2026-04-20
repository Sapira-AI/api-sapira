# Plan de integración — SimpleFactura (Chile) contra empresa demo

> Documento de planificación técnica detallada para revisión previa del dev senior.
> **Alcance**: integración de Sapira con SimpleFactura (Chile) usando la empresa demo pública de SimpleFactura para desarrollo y pruebas.
> **Estado**: propuesta de ejecución — no implementado aún.
> **Documento padre**: [e-invoicing-feasibility.md](./e-invoicing-feasibility.md) (factibilidad general CL/BR/MX).

---

## 1. Objetivo y alcance

### 1.1 Objetivo

Implementar el primer adaptador de facturación electrónica de terceros en api-sapira — SimpleFactura para Chile — validándolo contra la empresa demo pública antes de conectar a cuentas productivas de clientes reales (prospecto Webdox u otros).

En el camino, **extraer el framework genérico** `ElectronicInvoiceProvider` que permitirá agregar los otros dos facturadores electrónicos (FacturAPI México, NFE.io Brasil) en ciclos sucesivos reusando la mayoría de la infraestructura.

### 1.1.1 Principio de diseño — separación de dominios

**Odoo y los facturadores electrónicos son dominios distintos y se mantienen como módulos independientes.**

- **Odoo** es una integración con un **ERP**: sincroniza partners, productos, contabilidad, asientos, además de crear borradores de facturas. Tiene su propio módulo ([src/modules/odoo/](../../src/modules/odoo/)) con su propio scheduler, sus propios webhooks, su propia conexión y su propio modelo de datos.
- **SimpleFactura / FacturAPI / NFE.io** son **facturadores electrónicos puros**: reciben un documento y lo emiten a la autoridad tributaria. No gestionan contabilidad, productos ni clientes.

En consecuencia: este plan **no extiende, ni refactoriza, ni fuerza Odoo bajo una misma abstracción**. La interfaz `ElectronicInvoiceProvider` aplica únicamente a los tres facturadores electrónicos. Odoo convive en paralelo, intocado.

### 1.2 Dentro del alcance

- Módulo nuevo `src/modules/billing-providers/` con interfaz abstracta + adaptador SimpleFactura. **No incluye Odoo** (que sigue viviendo en [src/modules/odoo/](../../src/modules/odoo/) sin cambios).
- Extensión **aditiva** del modelo `Invoice` con campos fiscales — columnas nullable, los campos `odoo_invoice_id` y `sent_to_odoo_at` existentes permanecen intactos.
- Tabla nueva `e_invoice_provider_configs` para credenciales multi-tenant encriptadas.
- Servicio de encriptación `pgcrypto` para credenciales en reposo.
- Webhook receptor para callbacks SimpleFactura (eventos SII) — endpoint propio, **no reemplaza ni modifica** el webhook Odoo existente.
- **Scheduler dedicado nuevo y separado** (`EInvoiceEmissionScheduler`) que corre en cron propio y procesa **únicamente** invoices que tienen una `e_invoice_provider_config` activa. El scheduler Odoo ([invoice-scheduler.service.ts](../../src/modules/invoices/invoice-scheduler.service.ts)) **no se modifica**.
- Endpoint admin manual `POST /billing-providers/simplefactura/emit/:invoiceId` para disparar emisiones bajo demanda — útil en marcha blanca y troubleshooting.
- Marcha blanca end-to-end contra empresa demo: emisión de factura afecta, exenta, boleta, NC, consulta de estado, descarga PDF/XML, cancelación.
- Runbook de troubleshooting.

### 1.3 Fuera del alcance (explícito)

- **Cualquier modificación al módulo Odoo** ([src/modules/odoo/](../../src/modules/odoo/)) — sin cambios de código, sin refactor, sin tocar su scheduler ni su webhook. Odoo queda literalmente intocado.
- **Unificación Odoo + facturadores bajo una misma interfaz** — explícitamente rechazado (ver §1.1.1). Odoo es ERP; los facturadores son otra cosa.
- Adaptadores FacturAPI (México) y NFE.io (Brasil) — irán en iteraciones posteriores reutilizando esta base.
- Migración de cuenta productiva de Webdox desde partner Piriod — trámite comercial, no técnico.
- Constitución de Sapira como partner SimpleFactura — trámite comercial en paralelo.
- Migración de data legacy de facturas existentes al nuevo modelo — los campos nuevos son nullable; históricas permanecen sin ellos.
- Reemplazo del scheduler cron por queue Bull — se deja como mejora futura (sección 15).
- Validación HMAC formal de webhook Odoo (G4 del doc de factibilidad) — gap conocido, tracking aparte.

### 1.4 Supuestos

- Empresa demo SimpleFactura tiene credenciales en la documentación pública de SimpleFactura y no requiere trámite previo.
- El repo api-sapira corre localmente con `yarn` — Postgres y MongoDB ya están configurados para desarrollo.
- PostgreSQL tiene o permite habilitar la extensión `pgcrypto`.
- El dev senior revisará la serie de PRs propuestos abajo en una única sesión al final del ciclo.

---

## 2. Arquitectura propuesta

### 2.1 Diagrama lógico — pistas paralelas, sin puntos de contacto

```
Invoice (status='Por Emitir')
        │
        ├───────────────────────────────┬─────────────────────────────┐
        │                               │                             │
        ▼                               ▼                             │
 ─────────────────────          ─────────────────────                 │
 │  PISTA ODOO (ERP)  │          │  PISTA e-INVOICE   │                │
 │  (intocada)        │          │  (nueva)           │                │
 ─────────────────────          ─────────────────────                 │
        │                               │                             │
        ▼                               ▼                             │
 InvoiceSchedulerService         EInvoiceEmissionScheduler            │
 (existente, sin cambios)        (NUEVO, cron propio)                 │
        │                               │                             │
        │  toma invoices sin            │  toma invoices CON           │
        │  e_invoice_provider_config    │  e_invoice_provider_config   │
        │                               │  activa                      │
        ▼                               ▼                             │
   OdooInvoicesService            SimpleFacturaProvider                │
        │                               │                             │
        ▼                               ▼ HTTPS REST                   │
   ┌─────────┐                    ┌─────────────────────┐              │
   │  Odoo   │                    │  SimpleFactura demo │              │
   │ (ERP)   │                    │  Bearer auth        │              │
   └────┬────┘                    │  DTE → SII demo     │              │
        │                         └──────────┬──────────┘              │
        ▼ callback                           │ callback                │
 POST /odoo/webhooks              POST /webhooks/e-invoice             │
 (existente, sin cambios)         /simplefactura (NUEVO)               │
        │                                    │                         │
        ▼                                    ▼                         │
 odoo_invoice_id,                  external_provider,                  │
 sent_to_odoo_at                   external_invoice_id,                │
 (campos existentes)               fiscal_status, ...                  │
                                   (campos nuevos)                     │
                                                                       │
                                                                       │
 ── Trigger alternativo bajo demanda ──────────────────────────────────┘
 POST /billing-providers/simplefactura/emit/:invoiceId
 (endpoint admin manual — para marcha blanca y troubleshooting)
```

**Clave**: el invoice con `e_invoice_provider_config` activa va por la pista nueva; cualquier otro sigue por Odoo como hoy. Ambas pistas no se tocan ni compiten.

### 2.2 Decisiones de diseño

| Decisión | Elegido | Alternativa descartada | Motivo |
|---|---|---|---|
| Relación con módulo Odoo | **Paralelo, sin puntos de contacto** — Odoo y e-invoicing son módulos independientes | Unificar ambos bajo una interfaz común `InvoiceProvider` | Odoo es ERP (partners, productos, contabilidad); SimpleFactura es solo emisor DTE. Dominios distintos con ciclos de vida distintos. |
| Ubicación del módulo | `src/modules/billing-providers/` (paraguas) + subcarpetas por facturador electrónico | `src/modules/simplefactura/` plano (como `src/modules/odoo/`) | Anticipa MX/BR; permite compartir interfaz/DTO/encryption entre facturadores. **Odoo queda fuera de este paraguas por diseño.** |
| Scheduler | **Scheduler nuevo dedicado** (`EInvoiceEmissionScheduler`) corriendo en paralelo al de Invoices/Odoo | Reusar `InvoiceSchedulerService` con resolver dinámico y fallback a Odoo | Mantener Odoo literalmente intocado durante la validación contra demo. Unificación posible a futuro si surgiera necesidad — no ahora. |
| Queue vs cron | Cron `@nestjs/schedule` (consistente con `InvoiceSchedulerScheduler` existente) | Bull desde día 1 | Bull es mejora futura — fuera de alcance. |
| Migración de Invoice | Aditiva (columnas nullable) | Nueva tabla `fiscal_documents` separada | Minimiza refactor; el modelo actual soporta ambas pistas con los campos existentes + los nuevos. |
| Encriptación credenciales | `pgcrypto` con clave maestra en env | KMS (AWS/GCP) | MVP — KMS se evalúa al formalizar SOC2. |
| Client HTTP | `@nestjs/axios` | `fetch` nativo | Consistencia con stack NestJS + interceptores. |
| Webhook storage | Log en MongoDB propio (inspirado en patrón `odoo-webhook.service.ts` pero colección separada) | Solo Postgres | Reusa patrón ya productivo sin mezclar eventos Odoo con eventos de facturadores. |

---

## 3. Estructura de directorios nueva

```
src/modules/billing-providers/
├── billing-providers.module.ts
├── types/
│   ├── electronic-invoice-provider.interface.ts
│   ├── provider-country.enum.ts
│   └── fiscal-status.enum.ts
├── dto/
│   ├── create-invoice-input.dto.ts
│   ├── create-invoice-result.dto.ts
│   ├── get-status-result.dto.ts
│   ├── cancel-invoice-input.dto.ts
│   ├── cancel-invoice-result.dto.ts
│   └── webhook-event.dto.ts
├── entities/
│   └── e-invoice-provider-config.entity.ts
├── schemas/                               ← Mongoose (eventos webhook)
│   └── e-invoice-webhook-event.schema.ts
├── services/
│   ├── encryption.service.ts
│   ├── provider-configs.service.ts
│   └── e-invoice-emission.scheduler.ts    ← SCHEDULER NUEVO, independiente
├── controllers/
│   ├── provider-configs.controller.ts
│   ├── e-invoice-webhooks.controller.ts
│   └── e-invoice-admin.controller.ts      ← endpoint manual emit/:invoiceId
└── simplefactura/
    ├── simplefactura.module.ts
    ├── simplefactura.provider.ts         ← implementa ElectronicInvoiceProvider
    ├── simplefactura-http.client.ts      ← HttpService wrapper
    ├── simplefactura.mapper.ts            ← Invoice → payload DTE
    ├── simplefactura.webhook-handler.ts   ← parseo callbacks
    └── types/
        ├── dte-type.enum.ts
        ├── simplefactura-api.types.ts
        └── simplefactura-webhook.types.ts

spikes/simplefactura/           ← fuera de src, no productivo
├── README.md
├── requests.http
└── .env.spike.example

src/databases/postgres/migrations/
└── {timestamp}-add-e-invoicing-base.ts   ← migración aditiva
```

**El módulo Odoo ([src/modules/odoo/](../../src/modules/odoo/)) NO aparece arriba porque no se toca.** Es un módulo hermano e independiente.

**Archivos existentes modificados** (cambios mínimos y aditivos — **ninguno en `src/modules/odoo/` ni en `src/modules/invoices/invoice-scheduler*`**):

| Archivo | Cambio |
|---|---|
| [src/modules/invoices/entities/invoice.entity.ts](../../src/modules/invoices/entities/invoice.entity.ts) | + 11 columnas nullable (ver §5). Los campos `odoo_invoice_id` / `sent_to_odoo_at` no se tocan. |
| [src/app.module.ts](../../src/app.module.ts) | + Import de `BillingProvidersModule`. `OdooModule` no se toca. |
| `.env.example` | + variables nuevas (ver §11). |

**Archivos del scheduler Odoo** ([invoice-scheduler.service.ts](../../src/modules/invoices/invoice-scheduler.service.ts), [invoice-scheduler.scheduler.ts](../../src/modules/invoices/invoice-scheduler.scheduler.ts)): **no se modifican**. La emisión SimpleFactura corre en su propio scheduler separado (`EInvoiceEmissionScheduler`).

---

## 4. Interfaz `ElectronicInvoiceProvider`

### 4.1 Contrato TypeScript

```ts
// src/modules/billing-providers/types/electronic-invoice-provider.interface.ts
// NOTA: esta interfaz aplica solo a facturadores electrónicos.
// Odoo (ERP) NO la implementa — vive en su propio módulo con su propia API.

export interface ElectronicInvoiceProvider {
  readonly providerName: 'simplefactura' | 'facturapi' | 'nfe_io';
  readonly country: ProviderCountry;

  validateCredentials(
    config: EInvoiceProviderConfig,
  ): Promise<{ ok: boolean; errors?: string[] }>;

  createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult>;

  /** Opcional — presente si el provider no timbra sincrónicamente en createInvoice */
  submitInvoice?(externalId: string): Promise<SubmitInvoiceResult>;

  getStatus(externalId: string): Promise<GetStatusResult>;

  cancelInvoice(
    externalId: string,
    input: CancelInvoiceInput,
  ): Promise<CancelInvoiceResult>;

  downloadPdf(externalId: string): Promise<Buffer>;
  downloadXml(externalId: string): Promise<Buffer>;

  handleWebhook(
    payload: unknown,
    headers: Record<string, string | undefined>,
  ): Promise<WebhookEvent>;
}
```

### 4.2 DTOs clave (resumen)

```ts
// CreateInvoiceInput: agnóstico de facturador electrónico
export interface CreateInvoiceInput {
  invoiceId: string;                 // id Sapira (trazabilidad)
  holdingId: string;
  companyId: string;                 // emisor (razón social)
  documentType: DocumentType;        // afecta | exenta | boleta | nc | nd
  issueDate: Date;
  currency: string;                  // CLP en Chile
  receiver: ReceiverInput;
  items: InvoiceLineInput[];
  totals: InvoiceTotals;
  metadata?: Record<string, string>; // notas, folio interno, etc.
}

export interface CreateInvoiceResult {
  externalId: string;
  externalFolio?: string;            // asignado sincrónicamente en CL
  fiscalStatus: FiscalStatus;        // 'submitted' | 'accepted' | 'pending'
  rawProviderResponse: unknown;      // para audit log
}
```

Definiciones completas quedarán en `src/modules/billing-providers/dto/`.

### 4.3 Enum `FiscalStatus`

```ts
export enum FiscalStatus {
  Draft = 'draft',
  Submitted = 'submitted',
  Accepted = 'accepted',    // SII aceptó
  Rejected = 'rejected',    // SII rechazó (con fiscal_rejection_reason)
  Cancelled = 'cancelled',  // NC emitida
}
```

---

## 5. Cambios en el modelo de datos

### 5.1 Migración aditiva Invoice

Columnas nuevas en tabla `invoices`:

| Columna | Tipo | Nullable | Default | Notas |
|---|---|---|---|---|
| `external_provider` | `varchar(32)` | Sí | `NULL` | `simplefactura` / `facturapi` / `nfe_io` / `odoo` |
| `external_invoice_id` | `varchar(128)` | Sí | `NULL` | ID del provider |
| `external_folio` | `varchar(64)` | Sí | `NULL` | Folio DTE (CL) / UUID CFDI (MX) / chave NFe (BR) |
| `external_uuid` | `varchar(64)` | Sí | `NULL` | UUID adicional (MX) — CL no usa |
| `xml_url` | `text` | Sí | `NULL` | URL firmada o blob ref |
| `pdf_url` | `text` | Sí | `NULL` | URL firmada o blob ref |
| `fiscal_status` | `varchar(32)` | Sí | `NULL` | Ver enum `FiscalStatus` |
| `fiscal_stamped_at` | `timestamptz` | Sí | `NULL` | Timestamp SII/SAT/SEFAZ |
| `fiscal_rejection_reason` | `text` | Sí | `NULL` | Mensaje de rechazo |
| `cancellation_motive` | `varchar(16)` | Sí | `NULL` | Motivo (formato del provider) |
| `substitution_invoice_id` | `uuid` | Sí | `NULL` | FK lógica a factura sustituta |

**Índice**: `CREATE INDEX idx_invoices_external ON invoices(external_provider, external_invoice_id) WHERE external_provider IS NOT NULL;`

**Compatibilidad Odoo**: los campos existentes `odoo_invoice_id` y `sent_to_odoo_at` **se mantienen sin cambios** — nada del flujo Odoo actual se altera. Opcionalmente, el adaptador Odoo (refactor futuro) puede duplicar sus valores en `external_*`.

### 5.2 Tabla nueva `e_invoice_provider_configs`

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE e_invoice_provider_configs (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  holding_id             UUID NOT NULL,
  company_id             UUID NOT NULL,
  country                CHAR(2) NOT NULL,
  provider               VARCHAR(32) NOT NULL,
  environment            VARCHAR(16) NOT NULL
                         CHECK (environment IN ('sandbox','production')),
  credentials_encrypted  BYTEA NOT NULL,
  certificate_blob_ref   TEXT,
  certificate_expires_at TIMESTAMPTZ,
  is_active              BOOLEAN NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (holding_id, company_id, country, environment)
);

CREATE INDEX idx_e_invoice_configs_holding
  ON e_invoice_provider_configs(holding_id);
```

### 5.3 Encriptación

- `credentials_encrypted` almacena JSON (`{apiKey, baseUrl, webhookSecret}`) cifrado con `pgp_sym_encrypt`.
- Clave maestra en env var `E_INVOICE_ENCRYPTION_KEY` (32 bytes, base64).
- `EncryptionService.encrypt(obj)` / `decrypt(buffer)` — un servicio NestJS inyectable.
- Rotación de clave: documentada en runbook, no automatizada en MVP.

---

## 6. Adaptador SimpleFactura — flujo de emisión

### 6.1 Secuencia

```
1. Cron trigger en EInvoiceEmissionScheduler (scheduler NUEVO dedicado)
   └─ query:
        SELECT invoices
        WHERE status='Por Emitir'
          AND fiscal_status IS NULL
          AND EXISTS (
            SELECT 1 FROM e_invoice_provider_configs c
            WHERE c.holding_id = invoices.holding_id
              AND c.company_id = invoices.company_id
              AND c.is_active = TRUE
          )
      ⇒ Este scheduler procesa ÚNICAMENTE invoices con config activa.
      ⇒ El scheduler Odoo sigue tomando el resto como hoy, sin cambios.

2. Para cada invoice:
   └─ Resolver la config activa (holding, company, country='CL', environment)
   └─ Instanciar provider correspondiente (SimpleFacturaProvider para CL)

3. SimpleFacturaProvider.createInvoice(input)
   └─ SimpleFacturaMapper: Invoice + InvoiceItem → payload DTE
   └─ SimpleFacturaHttpClient.POST /dte
   └─ Response → CreateInvoiceResult { externalId, externalFolio, fiscalStatus }

4. Persistir en Invoice:
   invoice.external_provider = 'simplefactura'
   invoice.external_invoice_id = externalId
   invoice.external_folio = externalFolio
   invoice.fiscal_status = 'submitted' | 'accepted'

   (Los campos odoo_invoice_id / sent_to_odoo_at quedan NULL para estas
   invoices — no se usan. No hay doble emisión porque el scheduler Odoo
   filtra por status='Por Emitir' y este ya no lo tiene después de este
   paso. Ver §6.4 para detalle de la coordinación.)

5. [Async] Webhook /webhooks/e-invoice/simplefactura recibe estado final
   └─ actualiza invoice.fiscal_status = 'accepted' | 'rejected'
   └─ si rejected, fiscal_rejection_reason = mensaje SII
```

### 6.4 Coordinación entre los dos schedulers (sin tocar Odoo)

Ambos schedulers leen la misma tabla `invoices`, pero filtran por condiciones **mutuamente excluyentes**:

| Scheduler | Filtro adicional | Comportamiento |
|---|---|---|
| `InvoiceSchedulerService` (Odoo — existente, sin cambios) | `status='Por Emitir'` y `sent_to_odoo_at IS NULL` (filtro actual) | Sigue tomando todas las invoices pendientes como hoy |
| `EInvoiceEmissionScheduler` (nuevo) | Agrega `AND EXISTS (e_invoice_provider_config activa)` | Toma únicamente las invoices donde existe config |

**Pregunta honesta**: como ambos leen la misma tabla, ¿puede pasar que el scheduler Odoo levante una invoice que también tiene config activa de SimpleFactura? **Sí, en teoría puede pasar** si:

- El cron Odoo corre antes que el cron SimpleFactura en el mismo ciclo.
- La invoice tiene config activa pero aún no se procesó por el scheduler nuevo.

Dos mitigaciones posibles **sin tocar Odoo**:

- **Mitigación A — Marcado previo (recomendada)**: al crear una `e_invoice_provider_config` activa para un `(holding_id, company_id)`, se marcan las invoices **futuras** de ese holding+company con un flag `fiscal_status='pending_e_invoice'` apenas entran al estado `'Por Emitir'`. El scheduler Odoo ya filtra por `sent_to_odoo_at IS NULL`; sumamos como convención que ese scheduler respete `fiscal_status`. **Esto requeriría un mínimo cambio a la query de Odoo** — contradice la premisa de cero cambios.
- **Mitigación B — Tabla de routing previo (sin tocar Odoo)**: al crear la invoice, un hook (trigger DB o servicio en el flujo de creación — no en el scheduler) resuelve el provider una sola vez y setea `invoice.external_provider='simplefactura'`. El scheduler Odoo, **ya hoy**, tiene tolerancia a este campo — si no, verificamos. El scheduler nuevo toma invoices con `external_provider='simplefactura'` AND `status='Por Emitir'` AND `fiscal_status IS NULL`. El scheduler Odoo ignora las que tienen `external_provider='simplefactura'` porque **su query ya las descarta** (tendríamos que verificar — si no, sí necesitaríamos **un mínimo filtro** ahí).

**Decisión para la revisión del senior (§16)**: cómo garantizar exclusión mutua **sin modificar el archivo del scheduler Odoo**. Opciones:

1. Aceptar un **único cambio mínimo** en la query Odoo: `AND external_provider IS NULL OR external_provider = 'odoo'`. Es un filtro aditivo trivial, no altera lógica.
2. Desactivar el cron Odoo para los holdings específicos donde exista config SimpleFactura (flag de exclusión en el servicio Odoo sin tocar el scheduler).
3. Dejar la exclusión al nivel de **estado**: el servicio de creación de invoice marca `status='Por Emitir Externa'` (nuevo estado) para invoices con config — Odoo solo levanta `'Por Emitir'`, el nuevo scheduler `'Por Emitir Externa'`. Odoo no se toca.

**La opción 3 es la más limpia y es la recomendada** — se resuelve por convenciones de estado, no por modificación de código Odoo.

### 6.2 Mapeo Invoice → SimpleFactura

| Campo Sapira | Campo SimpleFactura | Transformación |
|---|---|---|
| `invoice.company.rut` | `Encabezado.Emisor.RUTEmisor` | directo |
| `invoice.company.giros[0]` | `Encabezado.Emisor.GiroEmis` | primer giro SII |
| `invoice.client_entity.rut` | `Encabezado.Receptor.RUTRecep` | directo |
| `invoice.client_entity.razon_social` | `Encabezado.Receptor.RznSocRecep` | directo |
| `invoice.items[]` | `Detalle[]` | por línea |
| `item.tax_code='19'` | `item.IndExe=0` (afecto) | 19% = IVA afecto |
| `item.tax_code='0'` | `item.IndExe=1` (exento) | IVA exento |
| `invoice.amount_invoice_currency` | `Totales.MntTotal` | entero CLP |
| `documentType: 'factura_afecta'` | `TipoDTE=33` | código SII |
| `documentType: 'factura_exenta'` | `TipoDTE=34` | |
| `documentType: 'boleta'` | `TipoDTE=39` | |
| `documentType: 'nc'` | `TipoDTE=61` | |

Detalle completo se cerrará en Fase 0 (spike) contra respuestas reales.

### 6.3 Manejo de errores y reintentos

| Escenario | Acción |
|---|---|
| 4xx validación payload | No-retry. Log + marcar `fiscal_status='rejected'` con `fiscal_rejection_reason`. |
| 401/403 auth | No-retry. Alerta — credenciales inválidas o expiradas. |
| 429 rate limit | Retry con backoff exponencial (3 intentos: 2s, 4s, 8s). |
| 5xx / timeout | Retry con backoff (3 intentos). Si falla, invoice queda como `Por Emitir` para próximo ciclo de cron. |
| Rechazo SII vía webhook | `fiscal_status='rejected'` + `fiscal_rejection_reason`. Notificación (fuera de alcance de esta iteración). |

Idempotencia: la clave es `sent_to_simplefactura_at IS NOT NULL` — una vez fijado, no se reintenta emisión. Si hay que re-emitir tras fallo definitivo, se reestablece el campo manualmente (endpoint admin futuro).

---

## 7. Webhook handler

### 7.1 Endpoint

```
POST /webhooks/e-invoice/simplefactura
Headers: (según documentación — a confirmar en Fase 0 spike)
Body: payload SimpleFactura
Respuesta: 200 OK en <2s
```

### 7.2 Flujo

```
1. Validación de autenticidad
   - Shared secret en header (ej. X-Webhook-Secret) comparado contra webhook_secret
     guardado en e_invoice_provider_configs.credentials_encrypted
   - Si falla, 401

2. Persistir evento crudo
   - Mongo collection e_invoice_webhook_events (patrón odoo-webhook.service.ts)
   - { provider, received_at, headers, body, processed: false }

3. Procesar
   - Buscar Invoice por external_invoice_id
   - Idempotencia: chequear si el evento (externalId + event_type + provider_timestamp)
     ya fue procesado → skip
   - Actualizar fiscal_status según evento
     - 'invoice.accepted' → accepted + fiscal_stamped_at
     - 'invoice.rejected' → rejected + fiscal_rejection_reason
     - 'invoice.cancelled' → cancelled
   - Marcar processed = true

4. Responder 200
```

### 7.3 Reuso del patrón Odoo

Reutilizamos la estructura de [odoo-webhook.service.ts](../../src/modules/odoo/odoo-webhook.service.ts) como referencia — pero **añadimos** validación de firma desde día 1 (el endpoint Odoo actual es un gap conocido, no replicamos la omisión).

---

## 8. Tests

### 8.1 Estrategia

| Tipo | Qué cubre | Framework |
|---|---|---|
| Unit — mapper | `SimpleFacturaMapper` con casos afecta/exenta/boleta/NC, montos redondeados, múltiples líneas | Jest |
| Unit — provider | `SimpleFacturaProvider` con `HttpService` mockeado: happy path + cada branch de error (4xx, 429, 5xx, timeout) | Jest |
| Unit — encryption | Round-trip encrypt/decrypt, clave inválida | Jest |
| Unit — scheduler nuevo | `EInvoiceEmissionScheduler` toma solo invoices con `status='Por Emitir Externa'` y config activa; ignora las `'Por Emitir'` (flujo Odoo) | Jest |
| Integration — adaptador | Emisión real contra empresa demo SimpleFactura (marcado `@Integration`, skip si no hay env var `SIMPLEFACTURA_DEMO_API_KEY`) | Jest + supertest |
| Integration — webhook | Simular POST de webhook con payload real capturado en Fase 0, verificar update en DB | Jest + supertest |
| E2E — ciclo completo | Crear Invoice con config → scheduler nuevo → emisión → webhook → `fiscal_status='accepted'` | Jest E2E (existe `test/` en el repo) |
| **Regresión Odoo (crítico)** | (a) Invoices con estado `'Por Emitir'` y sin config siguen siendo tomadas por el scheduler Odoo igual que antes. (b) Invoices con estado `'Por Emitir Externa'` NO son tomadas por Odoo. (c) El archivo `invoice-scheduler.service.ts` no tiene diffs en este PR set. | Jest + verificación de git diff en CI |

### 8.2 Cobertura objetivo

- Unit + integration mockeado: >80% del módulo `billing-providers/`.
- Integration real contra demo: smoke test que corre manualmente en CI opt-in.

---

## 9. Spike (Fase 0) — qué entrega y qué no

El spike **no es código productivo**. Va en `spikes/simplefactura/` (fuera de `src/`) y no se mergea a `qa`/`main`. Sí se pushea a la rama para que el senior lo vea.

### 9.1 Entregables del spike

1. `spikes/simplefactura/README.md` — URL base, credenciales demo, estructura del payload real, observaciones.
2. `spikes/simplefactura/requests.http` — colección REST Client con:
   - `POST` emisión factura afecta
   - `POST` emisión factura exenta
   - `POST` emisión boleta
   - `POST` emisión NC con referencia
   - `GET` consulta estado por ID
   - `GET` descarga PDF
   - `GET` descarga XML
3. Respuestas reales pegadas en el README (headers + body) para referencia del mapper.
4. Formato y ejemplo de payload del webhook (capturando un callback real via ngrok apuntando a un endpoint temporal de eco).

### 9.2 Criterios de éxito del spike

- Emití al menos 1 DTE de cada tipo contra la demo.
- Tengo el JSON de respuesta de cada uno guardado.
- Tengo 1 payload de webhook capturado en vivo.
- Tengo claridad sobre headers de autenticidad del webhook (si los hay).

Si algo de esto no se logra, se reporta como riesgo antes de avanzar a Fase 1.

---

## 10. Plan por fases y PRs

Todo se desarrolla en la rama `feature/e-invoicing-simplefactura` (o subramas). PRs apilados en draft, revisión final del senior en una sola sesión.

| Fase | PR | Rama | Entregable | Archivos tocados | Duración FT |
|---|---|---|---|---|---|
| 0 | — (push a rama) | `feature/e-invoicing-simplefactura-spike` | Spike: docs, `.http`, payloads capturados | solo `spikes/simplefactura/*` | 0.5 día |
| 1 | PR#1 | `feature/e-invoicing-simplefactura` | Estructura vacía + interfaz + DTOs + module stub | solo nuevos archivos en `src/modules/billing-providers/` (sin `simplefactura/`) | 1-2 días |
| 2 | PR#2 | idem | Migración Invoice + tabla configs + encryption service + endpoints admin CRUD | + migración + entity + controllers + app.module.ts | 2-3 días |
| 3 | PR#3 | idem | Adaptador SimpleFactura completo + endpoint admin manual `POST /billing-providers/simplefactura/emit/:invoiceId` | + `simplefactura/` completo + `e-invoice-admin.controller.ts` | 4-6 días |
| 4 | PR#4 | idem | Webhook receiver + persistencia eventos Mongo (colección propia) + update `fiscal_status` | + controller webhooks + handler + schema mongoose (**sin tocar Odoo webhook**) | 2-3 días |
| 5 | PR#5 | idem | **Scheduler NUEVO y dedicado** `EInvoiceEmissionScheduler` + convención de estado `'Por Emitir Externa'` al crear invoices con config activa | `e-invoice-emission.scheduler.ts` (nuevo) + ajuste en servicio de creación de invoice. **El scheduler Odoo no se modifica.** | 2-3 días |
| 6 | PR#6 | idem | Runbook + smoke test script + README update | `docs/integrations/simplefactura-runbook.md` + scripts | 2-3 días |

**Garantía de no-regresión**: PR#5 es el único que podría afectar al flujo Odoo existente. El mecanismo de separación propuesto (estado `'Por Emitir Externa'` para invoices con config, `'Por Emitir'` para las que siguen el flujo Odoo clásico) deja el archivo del scheduler Odoo literalmente sin una sola línea modificada. Se valida con tests explícitos en §8.

**Total**: 13-20 días hábiles full-time.

### 10.1 Definición de "Done" por fase

Cada PR cierra cuando:

- [ ] `yarn build` limpio
- [ ] `yarn lint` sin errores nuevos
- [ ] Tests de la fase pasan localmente
- [ ] Cambios del schema: migración `up` y `down` probadas localmente (Postgres limpio)
- [ ] No hay regresión: `yarn test` completo sigue pasando
- [ ] El módulo Odoo sigue emitiendo facturas en modo dev (test manual o mock)
- [ ] Variables de entorno nuevas documentadas en `.env.example`

---

## 11. Variables de entorno nuevas

A agregar en `.env.example`:

```
# Billing providers — base
E_INVOICE_ENCRYPTION_KEY=       # 32 bytes base64, generar con `openssl rand -base64 32`

# SimpleFactura — demo/sandbox
SIMPLEFACTURA_BASE_URL=
SIMPLEFACTURA_DEMO_API_KEY=     # de la documentación pública SimpleFactura
SIMPLEFACTURA_WEBHOOK_SECRET=   # compartido con SimpleFactura para validar callbacks
```

No se commitea `.env` real. Secretos productivos irán al vault que use el proyecto.

---

## 12. Setup local para correr el spike y el dev loop

### 12.1 Requisitos

- Repo levantado con `yarn` (ya cubierto).
- **ngrok** instalado (`brew install ngrok`) para exponer el webhook local a SimpleFactura durante el spike y la marcha blanca.
- Variables de `.env` agregadas con credenciales demo.

### 12.2 Flujo spike

```bash
# 1. Levantar api-sapira local
yarn start:dev

# 2. En otra terminal, exponer con ngrok
ngrok http 3000
# copiar la URL https://xxxxx.ngrok.io

# 3. Configurar esa URL como webhook target en la cuenta demo SimpleFactura
#    (dashboard o llamada API según lo que permita)

# 4. Disparar una emisión desde requests.http
#    (REST Client en VS Code, o httpie/curl equivalente)

# 5. Verificar: logs de api-sapira muestran webhook recibido
```

### 12.3 Base de datos para desarrollo

Se usa la instancia Postgres/Mongo ya configurada en `.env` local. No se requiere acceso a las cuentas del dev senior — desarrollo contra DB local o dev compartida según la práctica del repo.

---

## 13. Riesgos y mitigaciones

| # | Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|---|
| R1 | Webhook SimpleFactura no documenta validación de firma clara | Media | Medio | Mitigar con shared secret custom + IP allowlist si SimpleFactura publica rango. Si no, loggear pero procesar — documentar como deuda. |
| R2 | Payload real del DTE distinto al esperado → refactor del mapper | Media | Bajo | Cubierto por Fase 0 (spike) antes de escribir el mapper. |
| R3 | Romper emisión Odoo productiva | **Muy baja** | Alto | Diseño explícito: **el archivo del scheduler Odoo no se modifica**. La separación se hace por convención de estado (`'Por Emitir'` vs `'Por Emitir Externa'`). Test de regresión verifica en CI que no hay diffs sobre los archivos del módulo Odoo. |
| R3b | Una invoice con config activa queda con estado `'Por Emitir'` por error de código y Odoo la toma | Baja | Medio | El servicio de creación de invoice setea el estado inicial según haya o no config activa (una sola fuente de verdad). Test unitario cubre ambos caminos. En último caso, si Odoo la levanta, simplemente emite por ERP como hoy — no hay doble emisión porque cada scheduler es único tomador de su estado respectivo. |
| R4 | `pgcrypto` no está habilitado / no es aceptable políticamente | Baja | Medio | Validar con senior en PR#2 antes de apoyarse. Alt: KMS o crypto en Node. |
| R5 | Empresa demo SimpleFactura con rate limits agresivos → spike lento | Baja | Bajo | Rate limit backoff ya previsto en el cliente HTTP. |
| R6 | Estructura `billing-providers/` no es la que el senior prefiere | Media | Bajo | PR#1 se entrega **primero y pequeño** para aprobar estructura antes de gastarle tiempo al resto. |
| R7 | Campo `tax_code` de `invoice_item` es texto plano — insuficiente para mapeo a IVA afecto/exento | Media | Medio | Fase 3 introduce helpers de mapeo; si el texto no alcanza, se agrega columna aditiva `tax_kind` enum. |
| R8 | Concurrencia: cron y webhook actualizando el mismo invoice a la vez | Baja | Medio | `UPDATE ... WHERE fiscal_status IS NULL OR fiscal_status = 'submitted'` + transacción; handler webhook idempotente. |

---

## 14. Observabilidad y logging

- Logs con Pino (stack actual) estructurados: `{ provider, invoice_id, external_invoice_id, event, duration_ms }`.
- Correlación: cada emisión genera un `correlation_id` que viaja en logs + headers a SimpleFactura (si el provider lo acepta).
- Sin métricas/dashboards nuevos en esta iteración (fuera de alcance); se emiten logs que después cualquier agregador puede consumir.

---

## 15. Fuera de alcance — deudas reconocidas

Quedan **fuera** de este plan y se proponen como tracking aparte:

1. Queue Bull para emisión fiscal con DLQ.
2. Validación HMAC del webhook Odoo existente (gap G4 del doc de factibilidad).
3. Rotación automatizada de `E_INVOICE_ENCRYPTION_KEY`.
4. Alerta por certificados próximos a expirar (aplica para BR/MX, no CL).
5. UI admin para gestionar configs de providers (MVP usa endpoints REST, la UI va después).
6. Adaptadores FacturAPI (MX) y NFE.io (BR) — iteraciones siguientes.

**Explícitamente NO se contempla** (por decisión, no por omisión):

- Forzar al módulo Odoo a implementar la interfaz `ElectronicInvoiceProvider`. Odoo es ERP, no facturador electrónico; la interfaz no le aplica.
- Unificar `InvoiceSchedulerService` (Odoo) y `EInvoiceEmissionScheduler` (facturadores) en uno solo.

---

## 16. Preguntas abiertas para el dev senior

Estas decisiones se piden validar **antes** de empezar Fase 1, idealmente en la revisión del PR#1 draft:

1. **Convención de estado para separar pistas** (§6.4): ¿aceptas la propuesta de agregar el estado `'Por Emitir Externa'` para invoices con config activa, de modo que el scheduler Odoo siga tomando únicamente `'Por Emitir'` y no tengamos que tocar ni una línea de su código? ¿O prefieres otra forma de separación (por ejemplo, flag `external_provider='simplefactura'` setter al crearse la invoice, sin tocar el enum de estado)?
2. **Estructura del módulo**: ¿`src/modules/billing-providers/` (paraguas con subcarpetas por facturador) te parece bien, o prefieres cada facturador como módulo top-level hermano de `odoo/` (ej. `src/modules/simplefactura/`, `src/modules/facturapi/`, `src/modules/nfe-io/`)?
3. **Migraciones TypeORM**: ¿convención actual del repo para generar y nombrar migraciones? (el plan asume `src/databases/postgres/migrations/`, a validar).
4. **Encriptación**: ¿pgcrypto es aceptable en esta fase, o prefieres otro approach (ej. `node:crypto` + clave en env)?
5. **Webhook secret management**: ¿hay un patrón establecido en el repo para shared secrets de webhooks? No vi uno en Odoo (es un gap).
6. **`tax_code` de `invoice_item`**: ¿se puede cambiar el tipo/semántica o hay que tratarlo como legacy y agregar columna aditiva?
7. **Admin endpoints**: ¿hay convención para endpoints de admin/ops (guards, paths, swagger tags)?
8. **DB de dev**: ¿hay docker-compose.yml oficial para levantar Postgres+Mongo local, o cada dev gestiona lo suyo?

---

## 17. Checklist del dev senior para el review

Al revisar la serie de PRs, validar especialmente:

- [ ] **`git diff main src/modules/odoo/` es vacío** — Odoo no se toca en ningún PR.
- [ ] **`git diff main src/modules/invoices/invoice-scheduler*.ts` es vacío** — el scheduler Odoo queda intocado.
- [ ] Migración aditiva con `down` funcional (PR#2); `odoo_invoice_id` y `sent_to_odoo_at` sin cambios.
- [ ] Credenciales nunca logueadas ni serializadas en respuestas API (PRs #2 y #3).
- [ ] Webhook endpoint valida autenticidad antes de procesar (PR#4).
- [ ] Idempotencia cubierta en emisión (PR#3) y en webhook (PR#4).
- [ ] El nuevo scheduler `EInvoiceEmissionScheduler` solo toma invoices con config activa y estado `'Por Emitir Externa'` (PR#5).
- [ ] Tests de regresión Odoo presentes y verdes (PR#5).
- [ ] Convenciones del repo respetadas (naming, estilo, Swagger tags, auth guards).
- [ ] `.env.example` actualizado; `.env` real sin cambios.
- [ ] No hay commits con secretos.

---

## 18. Cronograma de PRs (propuesta)

Asumiendo arranque un lunes, 1 dev full-time, sin bloqueos externos:

```
Semana 1  Spike (Fase 0) + PR#1 estructura              [cierre viernes]
Semana 2  PR#2 schema + encriptación                    [merge a fin de semana si aprobado]
Semana 3-4  PR#3 adaptador SimpleFactura                  [grueso del trabajo]
Semana 4  PR#4 webhook                                  [se puede paralelizar con fin PR#3]
Semana 5  PR#5 scheduler + regresión + PR#6 docs        [cierre viernes semana 5]
```

Si el dev trabaja al 60% (multitasking con otras tareas), escalar a 8-10 semanas.

---

## Changelog

| Fecha | Cambio | Autor |
|---|---|---|
| 2026-04-20 | Creación del plan de ejecución SimpleFactura contra empresa demo. Para revisión previa del dev senior antes de arrancar Fase 0. | Equipo Sapira |
| 2026-04-20 | **Rediseño a "pistas paralelas"**: Odoo (ERP) y SimpleFactura (facturador electrónico) quedan en módulos y schedulers totalmente independientes. Se elimina la integración al `InvoiceSchedulerService` existente; se agrega scheduler nuevo dedicado `EInvoiceEmissionScheduler`. Separación por convención de estado (`'Por Emitir'` vs `'Por Emitir Externa'`). El módulo Odoo no se modifica en absoluto. Actualización de §§1, 2, 3, 4, 6, 8, 10, 13, 15, 16 y 17. | Equipo Sapira |

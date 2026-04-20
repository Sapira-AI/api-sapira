# Factibilidad técnica — Integración con facturadores electrónicos (CL / BR / MX)

> Estado: documento de factibilidad — referencia interna. **No se ha implementado código** para SimpleFactura / NFE.io / FacturAPI. El patrón Odoo existente se usa como referencia de diseño y baseline a generalizar.

---

## 1. Contexto y alcance

Prospecto (Webdox) factura electrónicamente en Chile, Brasil y México usando hoy **Piriod** como capa unificadora sobre tres emisores reales vía API:

| País | Emisor | Documentación |
|---|---|---|
| Chile | SimpleFactura | https://documentacion.simplefactura.cl/ |
| Brasil | NFE.io | https://nfe.io/docs/rest-api/ |
| México | FacturAPI | https://docs.facturapi.io/api/ |

Sapira propone reemplazar Piriod con una solución end-to-end (suscripciones + Order-to-Cash + facturación electrónica). Hasta hoy los clientes productivos de Sapira usan **Odoo** como ERP/facturador; no existen adaptadores contra SimpleFactura, NFE.io ni FacturAPI.

El objetivo de este documento es:
1. Confirmar factibilidad técnica de los tres providers.
2. Identificar los gaps de la arquitectura actual para soportar un modelo multi-provider.
3. Definir los requerimientos del cliente (credenciales, certificados, datos fiscales).
4. Dejar una secuencia de implementación clara para cuando el deal avance.

---

## 2. Arquitectura actual y gaps

### 2.1 Stack

NestJS 10 · TypeScript · TypeORM (PostgreSQL) · Mongoose (MongoDB) · `@nestjs/schedule` (cron) · Pino.

### 2.2 Patrón Odoo — referencia de diseño

El módulo [src/modules/odoo/](../../src/modules/odoo/) contiene el único provider de facturación en producción hoy:

- [odoo.provider.ts](../../src/modules/odoo/odoo.provider.ts) — factory XML-RPC por conexión.
- [odoo-connection.service.ts](../../src/modules/odoo/odoo-connection.service.ts) + tabla `odoo_connections` — una fila por `holding_id` con `url`, `api_key`, `database_name`, `username`, `is_active`, `last_sync_at`.
- [odoo-invoices.service.ts](../../src/modules/odoo/odoo-invoices.service.ts) — emisión de borradores hacia Odoo.
- [odoo-partners.service.ts](../../src/modules/odoo/odoo-partners.service.ts) — sincronización bidireccional de clientes.
- [odoo-webhook.controller.ts](../../src/modules/odoo/odoo-webhook.controller.ts) + [odoo-webhook.service.ts](../../src/modules/odoo/odoo-webhook.service.ts) — recepción de callbacks de Odoo (log en MongoDB).
- [invoice-scheduler.service.ts](../../src/modules/invoices/invoice-scheduler.service.ts) — cron que busca facturas `status='Por Emitir'` y dispara `sendInvoiceToOdoo()`; idempotencia vía `sent_to_odoo_at`.

### 2.3 Modelo de Invoice actual

[src/modules/invoices/entities/invoice.entity.ts](../../src/modules/invoices/entities/invoice.entity.ts):

- Multi-tenant: `holding_id`.
- Multi-entidad legal: `company_id`, `client_entity_id`.
- Multi-moneda: `contract_currency`, `invoice_currency`, `fx_contract_to_invoice` (con `ExchangeRatesService` de `banco-central/` como fuente).
- Hooks Odoo: `odoo_invoice_id`, `sent_to_odoo_at`.

Items en [invoice-item.entity.ts](../../src/modules/invoices/entities/invoice-item.entity.ts) — `tax_code` hoy es **texto libre (porcentaje simple)**, sin catálogo estructurado.

### 2.4 Gaps para un framework multi-provider

| # | Gap | Impacto | Severidad |
|---|---|---|---|
| G1 | No existe interfaz `ElectronicInvoiceProvider` abstracta; Odoo está acoplado al scheduler. | Cada provider nuevo implicaría ramificaciones `if/else` en el scheduler. | Alta |
| G2 | Catálogos fiscales inexistentes (claveProdServ/claveUnidad SAT, lista serviço municipal BR, giros SII CL). | Bloqueante para MX (SAT exige códigos por línea) y BR (código de serviço municipal). | Alta |
| G3 | `tax_code` como texto plano — sin tasas/códigos oficiales por país. | No se puede mapear a `iva`/`ISS`/`IEPS` por provider. | Alta |
| G4 | Webhooks Odoo sin validación HMAC/firma ([odoo-webhook.controller.ts](../../src/modules/odoo/odoo-webhook.controller.ts)). | Riesgo de aceptar callbacks falsificados en producción fiscal. | Media |
| G5 | Sin queue/retry — solo cron puro con flag `isRunning`. | Emisión fiscal necesita backoff y dead-letter (429/503/rechazo autoridad). | Media |
| G6 | Credenciales en `odoo_connections.api_key` sin encriptación en reposo. | Para CSD SAT (.key) y .pfx A1 es requisito de compliance guardar cifrado. | Alta |
| G7 | Una sola conexión por `holding_id`. | Webdox tiene 3+ razones sociales por país — se requieren N configuraciones por holding. | Alta |

---

## 3. Diseño objetivo — interfaz `ElectronicInvoiceProvider`

Interfaz común que los adaptadores implementan. Odoo se refactoriza para cumplirla también (no rompiente — adaptador wraps lógica existente).

```
ElectronicInvoiceProvider
  createInvoice(dto): { externalId, status }
  submitInvoice(externalId): { fiscalStatus, folio?, uuid?, stampedAt? }
  getStatus(externalId): { fiscalStatus, rejectionReason? }
  cancelInvoice(externalId, motive, substitutionId?): { status }
  downloadPdf(externalId): Buffer
  downloadXml(externalId): Buffer
  validateCredentials(config): { ok: boolean, errors?: string[] }
  handleWebhook(payload, signature): { invoiceId, event }
```

### 3.1 Selección dinámica

El scheduler resuelve el provider por tupla `(holding_id, company_id, country)`:

- Chile → `SimpleFacturaProvider`
- Brasil → `NfeIoProvider`
- México → `FacturApiProvider`
- Cualquier otro → `OdooProvider` (fallback al comportamiento actual)

### 3.2 Tabla nueva: `e_invoice_provider_configs`

| Columna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `holding_id` | uuid FK | |
| `company_id` | uuid FK | Razón social del emisor |
| `country` | char(2) | `CL` / `BR` / `MX` |
| `provider` | enum | `simplefactura` / `nfe_io` / `facturapi` / `odoo` |
| `environment` | enum | `sandbox` / `production` |
| `credentials_encrypted` | bytea | JSON cifrado (pgcrypto o KMS) |
| `certificate_blob_ref` | text | Ref a Supabase Storage / S3 para `.pfx` / `.cer`/`.key` (si aplica) |
| `certificate_expires_at` | timestamptz | Alerta proactiva 30 días antes |
| `is_active` | boolean | |
| `created_at` / `updated_at` | timestamptz | |

Índice único `(holding_id, company_id, country, environment)`.

### 3.3 Encriptación

- **Recomendado**: pgcrypto (`pgp_sym_encrypt` con clave maestra de env) para MVP; migración a KMS (AWS/GCP) cuando se formalicen SOC2.
- Certificados binarios (`.pfx`, `.cer`, `.key`) se almacenan como blob cifrado en bucket privado con ACL por `holding_id`, referencia en `certificate_blob_ref`.

---

## 4. Extensión del modelo Invoice

Migración **aditiva** — no altera flujo Odoo existente.

Campos nuevos en [invoice.entity.ts](../../src/modules/invoices/entities/invoice.entity.ts):

| Campo | Tipo | Notas |
|---|---|---|
| `external_provider` | varchar | `simplefactura` / `nfe_io` / `facturapi` / `odoo` |
| `external_invoice_id` | varchar | ID en el provider |
| `external_folio` | varchar | Folio DTE (CL) / número NFS-e (BR) / folio CFDI (MX) |
| `external_uuid` | varchar | UUID CFDI (MX) / chave NFe (BR) |
| `xml_url` | text | URL firmada / blob ref |
| `pdf_url` | text | URL firmada / blob ref |
| `fiscal_status` | enum | `draft` / `submitted` / `accepted` / `rejected` / `cancelled` |
| `fiscal_stamped_at` | timestamptz | Timbre SAT / timestamp SII / autorización prefeitura |
| `fiscal_rejection_reason` | text | Mensaje de rechazo de la autoridad |
| `cancellation_motive` | varchar | Motivo SAT (`01`-`04`) u homólogo |
| `substitution_invoice_id` | uuid | FK a factura sustituta (CFDI motivo `01`) |

Los campos `odoo_invoice_id` y `sent_to_odoo_at` se **mantienen** por compatibilidad; `external_provider='odoo'` los duplica a `external_invoice_id` / sin `fiscal_stamped_at`.

---

## 5. Provider: SimpleFactura (Chile)

### 5.1 Características

- **Auth**: Bearer token / API key en header.
- **Certificado SII y folios CAF**: **administrados por SimpleFactura**. El cliente no entrega certificado digital SII ni gestiona folios manualmente.
- **Ambientes**: sandbox + producción con endpoints diferenciados.
- **Documentos**: factura afecta, factura exenta, boleta electrónica, nota de crédito, nota de débito, guía de despacho.
- **Envío al SII**: automático.
- **Webhooks**: disponibles para eventos SII (aceptación, rechazo, reparos).
- **Onboarding de desarrollo**: SimpleFactura publica **documentación abierta** y ofrece una **empresa demo** compartida contra la que se puede desarrollar y testear sin contratar plan productivo. Los planes se contratan una vez validada la integración — el desarrollo no queda bloqueado por credenciales del cliente.

### 5.2 Flujo de emisión

```
Sapira Invoice (status='Por Emitir')
  └─> SimpleFacturaProvider.createInvoice({ rut, giro, lineas, totales })
       └─> POST /dte  → { externalId, folio, status='pending' }
  └─> submitInvoice(externalId)   // si no es sincrónico
  └─> webhook: invoice.accepted | invoice.rejected
       └─> update fiscal_status, folio, pdf/xml url
```

### 5.3 Mapeo de datos

| Campo Sapira | Campo SimpleFactura | Notas |
|---|---|---|
| `client_entity.rut` | `receptor.rut` | Requerido |
| `company.giros` | `emisor.giros` | Lista de giros SII |
| `invoice_item.tax_code='19'` | `items[].impuesto=IVA` | Mapeo directo a IVA afecto/exento |
| `invoice.total_amount` | `totales.montoTotal` | |

### 5.4 Requerimientos del cliente

- [ ] Cuenta SimpleFactura activa (ver 5.5 — modelo partner) + plan que cubra los tipos de DTE requeridos (afecta/exenta/boleta).
- [ ] API key en **sandbox** y **producción**.
- [ ] Razón social, RUT, giros SII y dirección de cada entidad legal emisora en Chile.
- [ ] Confirmación del email de alerta para rechazos/reparos SII.

> **No se requiere certificado digital SII del cliente** — diferencia operacional importante frente a BR/MX.

### 5.5 Modelo partner SimpleFactura y portabilidad desde Piriod

SimpleFactura opera con un modelo de **partner / integrador** — un tercero (Piriod hoy, Sapira mañana) administra las cuentas SimpleFactura de múltiples clientes finales bajo su propio paraguas, en vez de que cada cliente contrate SimpleFactura directamente.

**Estado actual del prospecto (Webdox)**:
- Webdox **no tiene contrato directo** con SimpleFactura.
- Su cuenta SimpleFactura vive bajo el **partner de Piriod**; la emisión la orquesta Piriod y la cuenta la administra Piriod.
- Al reemplazar Piriod con Sapira, la cuenta SimpleFactura tiene que migrar de partner o abrirse nuevamente bajo partner Sapira.

**Implicancias para Sapira**:
- **Sapira tiene que constituirse como partner SimpleFactura** (proceso comercial con SimpleFactura directo) para poder administrar cuentas de clientes bajo su paraguas.
- Este paso es **independiente del desarrollo técnico** — el desarrollo puede avanzar contra la empresa demo mientras se cierra el acuerdo partner.
- Para Webdox específicamente, la migración cuenta-bajo-Piriod → cuenta-bajo-Sapira es operacional: la misma plataforma SimpleFactura está detrás, por lo que el cambio no altera el comportamiento fiscal (mismos RUTs emisores, mismos folios CAF ya autorizados por SII, misma serie de documentos). Se traduce a reasignar la cuenta del partner Piriod al partner Sapira dentro del dashboard SimpleFactura (o abrir cuenta nueva bajo Sapira y coordinar corte limpio para no duplicar folios).

**Coordinación necesaria con SimpleFactura**:
- Confirmar con ellos el procedimiento formal de transferencia entre partners (vs. apertura nueva + cierre anterior).
- Definir fecha de corte con Webdox para evitar emisión doble durante la transición.
- Validar que el histórico de DTEs emitidos bajo partner Piriod siga accesible (consulta/PDF/XML) tras la migración.

---

## 6. Provider: NFE.io (Brasil)

### 6.1 Características

- **Auth**: dos API keys distintas — *Chave de Dados* (consultas) y *Chave de Nota Fiscal* (emisión). Header `Authorization: $NFEIO_API_KEY` o Bearer.
- **Certificado**: **requiere certificado A1 (.pfx)** del contribuyente emisor — upload en la plataforma NFE.io (no se transmite por cada request).
- **Ambientes**: homologação + produção (endpoints separados).
- **Documentos**: NFe (producto, modelo 55), NFC-e (consumidor), **NFS-e (servicios — modelo ABRASF municipal)**. Para SaaS aplica NFS-e.
- **Envío a SEFAZ / prefeitura**: automático — NFE.io abstrae la diferencia por municipio.
- **Webhooks**: entrega **at-least-once** — validar idempotencia a nivel de Sapira.

### 6.2 Endpoints clave

| Acción | Endpoint |
|---|---|
| Emitir nota | `POST /v2/nota-fiscal` |
| Consultar estado | `GET /v2/nota-fiscal/{id}` |
| Datos de empresa | `GET /v2/companies` |

Header recomendado: `Idempotency-Key: <uuid>` por cada emisión.

### 6.3 Mapeo de datos — NFS-e

| Campo Sapira | Campo NFE.io | Notas |
|---|---|---|
| `company.cnpj` | `prestador.cnpj` | Emisor brasileño |
| `company.inscricao_municipal` | `prestador.inscricaoMunicipal` | Crítico — sin esto no emite |
| `company.cnae` | `prestador.cnae` | |
| `product.codigo_servico_municipal` | `servico.codigo` | Mapeo LC 116 + tabela prefeitura |
| `invoice_item.tax_code` | `servico.aliquotaIss` | Aliquota ISS aplicable |
| `client_entity.cpf_cnpj` | `tomador.cpfCnpj` | |

### 6.4 Resiliencia

- Retry con backoff exponencial solo en `429` / `503` / timeout.
- Timeout sugerido: 30s lectura, 5s conexión.
- Dead-letter queue para errores no retriables (validación SEFAZ, datos fiscales inválidos).

### 6.5 Requerimientos del cliente

- [ ] Cuenta NFE.io con CNPJ(s) vinculados por cada razón social brasileña.
- [ ] API keys de **datos** y **emisión**, en **homologação** y **produção**.
- [ ] **Certificado digital A1 (.pfx) vigente + senha** — cargado por el cliente en NFE.io (no se transmite por API cada vez).
- [ ] Para cada CNPJ: inscrição municipal, CNAE principal.
- [ ] Tabla de códigos de serviço municipal aplicables (LC 116 + tabela de la prefeitura correspondiente) y aliquotas ISS / retenciones.

---

## 7. Provider: FacturAPI (México)

### 7.1 Características

- **Auth**: secret keys por organización — `sk_test_*` (test) / `sk_live_*` (live). Header `Authorization: Bearer sk_*`.
- **Certificado**: **requiere CSD SAT** del emisor — `.cer` + `.key` + contraseña. Se carga **una vez** vía `PUT /organizations/{id}/csd`.
- **Ambientes**: test y live determinados por la secret key; test **no envía al SAT** y no tiene validez fiscal.
- **Documentos**: CFDI 4.0 tipos `I` (ingreso), `E` (egreso), `P` (pago), `N` (nómina), `T` (traslado). Para SaaS aplica tipo `I`.
- **Timbrado**: automático al SAT en modo live.
- **Webhooks**: eventos `invoice.created`, `invoice.status_updated`, `cancellation.status_updated`.

### 7.2 Flujo de emisión

```
POST /invoices (con status=draft)       → invoice.id
POST /invoices/{id}/stamp               → timbrado SAT (UUID, folio)
GET  /invoices/{id}/pdf  |  /xml        → descarga
DELETE /invoices/{id}?motive=01&substitution={otroId}  → cancelación
```

Opcional: `?async=true` para invoices grandes → polling con `status: pending`.

### 7.3 Catálogos SAT (mapeo interno)

| Catálogo | Campo FacturAPI | Ejemplo |
|---|---|---|
| ClaveProdServ | `product_key` | `81111504` (software SaaS) |
| ClaveUnidad | `unit_key` | `E48` (servicio) o `H87` (pieza) |
| Régimen fiscal | `tax_system` | `601` (General ley PM) |
| Uso CFDI | `use` | `G03` (gastos en general) |
| Método de pago | `payment_form` / `payment_method` | `PUE` (una sola exhibición) o `PPD` (diferido) |

Estos catálogos deben vivir en tablas `sat_*_catalog` y mapearse desde `products` / `client_entities`.

### 7.4 Cancelación CFDI 4.0

Motivos SAT:
- `01` — comprobantes con errores con relación (**requiere** `substitution` apuntando al nuevo CFDI).
- `02` — comprobantes con errores sin relación.
- `03` — no se llevó a cabo la operación.
- `04` — operación nominativa relacionada en una factura global.

La aceptación del SAT puede ser asíncrona (aceptación del receptor en 72h) — manejar `cancellation.status_updated` vía webhook.

### 7.5 Requerimientos del cliente

- [ ] Organización FacturAPI creada + secret keys en **test** y **live**.
- [ ] **CSD SAT vigente** del emisor: `.cer` + `.key` + contraseña (entrega por canal seguro; se carga una vez en la organización).
- [ ] RFC, régimen fiscal (clave), código postal de expedición del emisor.
- [ ] Mapeo del catálogo de productos/planes de Webdox a `claveProdServ` y `claveUnidad` SAT (Sapira puede proponer base inicial).
- [ ] Uso CFDI default (ej. `G03`) y método de pago estándar (`PUE` o `PPD` según contrato).
- [ ] Logo y datos de serie/folio si usan series específicas.

---

## 8. Cambios transversales

### 8.1 Encriptación en reposo

Habilitar `pgcrypto` y envolver `credentials_encrypted` con `pgp_sym_encrypt`. Clave maestra en env → rotación vía variable separada, documentada en runbook.

### 8.2 Queue de emisión fiscal

Introducir Bull (o BullMQ sobre Redis) para el dispatch hacia providers:

- Job `emit_invoice` con retries exponenciales (`attempts: 5`, `backoff: exponential`).
- Dead-letter queue `emit_invoice_failed` con notificación al equipo fiscal.
- Scheduler actual ([invoice-scheduler.service.ts](../../src/modules/invoices/invoice-scheduler.service.ts)) enqueue en vez de llamar directo al provider.

### 8.3 Webhooks unificados

Patrón genérico `/webhooks/e-invoice/:provider` con handler por provider — cada uno valida firma según su esquema:

- SimpleFactura: por confirmar (documentación no explicita esquema HMAC; usar secret compartido con header custom).
- NFE.io: validar por token + request IP allowlist.
- FacturAPI: HMAC sobre body con `Stripe-Signature`-style (o equivalente documentado).

Reusar patrón de [odoo-webhook.controller.ts](../../src/modules/odoo/odoo-webhook.controller.ts) pero **agregando** validación de firma (gap G4).

### 8.4 Observabilidad

- Log estructurado (Pino) con `invoice_id`, `provider`, `country`, `fiscal_status`.
- Métrica: tasa de rechazo por provider/país.
- Alertas en: rechazos consecutivos, certificado próximo a expirar (<30 días).

---

## 9. Plan de implementación (secuencia sugerida)

| Sprint | Entregable | Dependencia |
|---|---|---|
| 1 | Interfaz `ElectronicInvoiceProvider`, tabla `e_invoice_provider_configs`, migración aditiva de Invoice, encriptación pgcrypto. | — |
| 2 | Adaptador **SimpleFactura** (camino corto — sin certificado del cliente), webhook handler, marcha blanca en sandbox. | Sprint 1 **(sin dependencia de credenciales del cliente — usa empresa demo pública de SimpleFactura)** |
| 3 | Adaptador **FacturAPI**, catálogos SAT (`claveProdServ`, `claveUnidad`, `régimen`, `uso`), flujo de cancelación CFDI. | Sprint 1 + CSD + credenciales MX |
| 4 | Adaptador **NFE.io**, catálogo de serviço municipal, manejo de ISS. | Sprint 1 + A1 + credenciales BR |
| 5 | Queue Bull, validación HMAC unificada de webhooks, alertas de expiración de certificados, refactor Odoo adapter para implementar la interfaz. | Sprints 1–4 |

La secuencia privilegia SimpleFactura en sprint 2 porque:
1. No bloquea en certificados del cliente (los administra SimpleFactura).
2. **Tampoco bloquea en credenciales del cliente** — la empresa demo pública permite desarrollar y pasar los tests sandbox completos antes de activar la cuenta productiva. Permite mostrar emisión fiscal viva en demos internas antes de que cualquier dato real de Webdox esté disponible.

En paralelo al Sprint 2 debe avanzar el **trámite comercial de partner SimpleFactura** para Sapira (ver 5.5), que es prerequisito para operar producción con Webdox.

---

## 10. Checklist por país — qué pedir al cliente

### 🇨🇱 Chile · SimpleFactura
- [ ] Razón social, RUT, giros SII, dirección de cada entidad emisora
- [ ] Email de alerta para rechazos/reparos SII
- [ ] Definición conjunta con SimpleFactura y Piriod del procedimiento de portabilidad de la cuenta productiva (hoy bajo partner Piriod → partner Sapira — ver 5.5) y fecha de corte para evitar doble emisión
- [ ] Los tipos de DTE habilitados se resuelven en el marco partner Sapira (no requiere contrato directo Webdox ↔ SimpleFactura)

> **Desarrollo y sandbox no requieren insumos del cliente** — Sapira avanza contra la empresa demo pública de SimpleFactura.

### 🇧🇷 Brasil · NFE.io
- [ ] API keys NFE.io (datos + emisión) en homologação y produção
- [ ] Certificado digital A1 (.pfx) vigente + senha, cargado en NFE.io
- [ ] CNPJ, inscrição municipal y CNAE por cada razón social
- [ ] Códigos de serviço municipal aplicables (LC 116 + tabela prefeitura)
- [ ] Aliquota ISS y retenciones aplicables por servicio

### 🇲🇽 México · FacturAPI
- [ ] Secret keys FacturAPI en test y live
- [ ] CSD SAT vigente del emisor (.cer + .key + contraseña)
- [ ] RFC, régimen fiscal, código postal de expedición
- [ ] Mapeo productos → claveProdServ / claveUnidad SAT
- [ ] Uso CFDI default y método de pago estándar (PUE/PPD)
- [ ] Series/folios si aplica; logo del emisor

---

## 11. Referencias a código reusable

- [OdooConnectionService](../../src/modules/odoo/odoo-connection.service.ts) — patrón de credenciales por tenant (generalizable a `e_invoice_provider_configs`).
- [InvoiceSchedulerService](../../src/modules/invoices/invoice-scheduler.service.ts) — idempotencia vía `sent_to_<x>_at`; extensible con `fiscal_status`.
- [ExchangeRatesService](../../src/modules/banco-central) — tipos de cambio, reusable cross-provider para normalizar `invoice_currency`.
- [OdooWebhookController](../../src/modules/odoo/odoo-webhook.controller.ts) — esqueleto de recepción de callbacks (a extender con validación HMAC).
- [Invoice entity](../../src/modules/invoices/entities/invoice.entity.ts) — base multi-tenant + multi-moneda ya lista; solo requiere campos fiscales adicionales (sección 4).

---

## 12. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Certificados A1 / CSD caducan silenciosamente y bloquean emisión. | Job diario que verifique `certificate_expires_at` y alerte a 30 / 15 / 5 días. |
| Cambios de catálogo SAT (claveProdServ) sin aviso. | Actualización trimestral del catálogo desde fuente oficial SAT; test de smoke en sandbox. |
| Rate limits en NFE.io (429). | Backoff exponencial en Bull + circuit breaker por provider. |
| Rechazo por dato fiscal (ej. CNAE inválido). | Validar contra catálogo local **antes** de enviar al provider; logs con payload sanitizado. |
| Pérdida de credenciales por error de operador. | Rotación documentada + acceso a `credentials_encrypted` por rol (auditable). |

---

## Changelog

| Fecha | Cambio | Autor |
|---|---|---|
| 2026-04-20 | Creación del documento — análisis de factibilidad inicial para prospecto Webdox. | Equipo Sapira |
| 2026-04-20 | Adición sección 5.5 (modelo partner SimpleFactura y portabilidad desde Piriod) + actualización de Sprint 2 y checklist CL tras conversación directa con SimpleFactura. | Equipo Sapira |

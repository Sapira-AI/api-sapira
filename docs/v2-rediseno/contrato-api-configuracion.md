# Contrato API · Configuración v2

> **v5 · 03-10-2026 · usuarios** (§10: invitar, reenviar, acceso, eliminar invitación y recuperar contraseña §10.6; migraciones M15 y M16).
> v4 · 03-10-2026 · ronda 4 (§9: zona horaria, escalera de recordatorios, numeración de cotizaciones
> y documento tributario solo con cambio de razón social; migración M14).
> v3 · 03-10-2026 · ronda 3 (§8: tasa por documento tributario (lectura por compañía), campos personalizados con más tipos,
> país ISO y listas del holding en clientes, comunicaciones, detalle de tipos de
> cambio, mercados/segmentos/industrias, tipos de negocio y de contacto, `holdings_count`, `company_id` en `no_account_mapping`).
> v2.1 · 03-10 ronda de arreglos de la auditoría §12 (rama `domi`, sin commit). v2 · 02-10 construido. Contrato de los endpoints del módulo Configuración (`src/modules/settings`) y de Productos
> (`src/modules/products`) para el front nuevo (`/lab/configuracion` y pestaña Productos de `/lab/precios`).
> Fuente de decisiones: [`spec-configuracion-v2.md`](./spec-configuracion-v2.md) (manda "Decisiones v3").
> Estado: código, tests y build verdes. M2, M3, M7, M8, M9 y el seed 004 **aplicados en QA y producción el 02-10**; pendientes sin aplicar:
> migración `1790810000000` (límites del bucket de logos), seed 005 y la función de roles por defecto (§11).
> Código: `src/modules/settings` (README), `src/modules/products`, guards en `src/guards/` (`require-permission.guard.ts`,
> `super-admin-only.guard.ts`, `permissions.service.ts`; uso en [`autorizacion-y-tenancy.md`](./autorizacion-y-tenancy.md)).

## 0. Reglas comunes

- **Auth**: `Authorization: Bearer <token Supabase>` (`SupabaseAuthGuard`).
- **Holding**: header `x-holding-id` obligatorio (`HoldingScopeGuard`): sin header → 400 `Falta el holding activo (header x-holding-id)`;
  holding al que no perteneces → 403 `No tienes acceso a este holding`. Ningún body ni query lleva `holding_id`.
  Excepción: `GET /catalog/countries` (catálogo global, solo sesión).
- **Editar incluye Ver** (03-10): tener `EDIT_X` satisface `VIEW_X` en todos los módulos (guard y `PermissionsService.allows`).
- **Recurso por id de otro holding** → **404** (no se confirma que exista).
- **Permisos** (`@RequirePermission`, `src/guards/require-permission.guard.ts`): super admin pasa siempre; `ALL_PERMISSIONS` cubre todo
  salvo los permisos internos (`VIEW_LAB`, `VIEW_DOCUMENTACION`); el rol se lee de `users.role_id` y **debe ser del holding activo**
  (`roles.holding_id`). Sin el código → **403** `No tienes permiso para <acción> · pídeselo a un administrador`.
  | Área | Leer | Escribir |
  |---|---|---|
  | Configuración (todo `/settings/*`) | `VIEW_CONFIGURACION` | `EDIT_CONFIGURACION` |
  | Cierre de períodos (`POST .../periods/close|reopen`) | `VIEW_CONFIGURACION` | `CLOSE_PERIODS` |
  | Productos (`/products`) | `VIEW_CONTRATOS` | `EDIT_CONTRATOS` |
  Acciones del mensaje 403: `ver la configuración`, `editar la configuración`, `cerrar y reabrir períodos contables`,
  `ver contratos y precios`, `editar contratos y precios`.
- **Errores**: siempre `{ message }` en español de negocio (sin nombres de columnas); validación → 400 `{ message, errors: [{ field, message }] }`.
  Campos desconocidos en el body → 400 (`forbidNonWhitelisted`). Conflictos de negocio → 409 `{ message }`.
- **Nunca 500 sin mensaje** (03-10): un interceptor (`settings-db-errors.ts`) traduce los errores esperables de Postgres en Configuración y
  Productos: unicidad → 409 (`Ya existe un registro con esos datos`, o el propio de la constraint: tasa repetida
  `Ya existe una tasa para ese par en esas fechas`, documento `Este documento ya está registrado`); FK al borrar → 409
  `Está en uso en otros registros: no se puede eliminar`; FK al insertar → 400; CHECK → 400; fecha/número/texto inválido → 400;
  trigger `validate_holding_fx_period_rates` por solapamiento → 409 `Ya existe una tasa para ese par en esas fechas`; otro `RAISE` → 409 con
  su texto; bloqueo/serialización → 409 `Otra persona modificó estos datos al mismo tiempo: vuelve a intentarlo`.
- **Fechas**: `YYYY-MM-DD` en fechas puras, **validadas contra el calendario** (`2026-02-30` → 400 `La fecha de fin no es válida (AAAA-MM-DD)`);
  ISO 8601 en marcas de tiempo. **Montos/tasas**: número JSON.
- **Moneda**: código ISO de 3 letras, validado contra el catálogo `currencies` (activas). 400 `Moneda no reconocida: XXX`.
- **DELETE** exitoso → `204` sin cuerpo.

## 1. Holding

### `GET /settings/holding` · VIEW
```json
{ "id": "uuid", "name": "Hanka", "website": "https://…", "phone": "+56…", "email": "hola@…", "logo_url": "https://…/company-logos/holdings/<id>/<uuid>.png",
  "users_count": 4, "last_activity_at": "2026-10-02T12:00:00Z" }
```
`users_count`: miembros activos del holding (`user_holdings.is_active`) sin super admins. `last_activity_at`: el `users.last_access` más reciente
de esos miembros (`null` si nadie entró).

### `PATCH /settings/holding` · EDIT
Body (todo opcional): `{ "website": "url|null", "phone": "texto|null", "email": "email|null", "logo_url": "url|null" }` → mismo shape que GET.
- **El holding no se renombra** (Domi 03-10): `name` en el body → 400 `El nombre del holding no se puede cambiar`.
- `logo_url` solo puede ser `null` o una URL pública del bucket `company-logos` bajo la carpeta del holding
  (la que devuelve `logo-upload`) → 400 `El logo debe subirse con "Subir logo"`.

### `POST /settings/holding/logo-upload` · EDIT
Body `{ "file_name": "logo.png", "mime_type": "image/png|image/jpeg|image/webp", "size": 12345 }` (máx. 2 MB; SVG fuera desde 03-10).
```json
{ "path": "holdings/<holding_id>/<uuid>.png", "upload_url": "https://…signed…", "token": "…", "public_url": "https://…/object/public/company-logos/holdings/<holding_id>/<uuid>.png" }
```
El navegador sube con `upload_url` (PUT, o `uploadToSignedUrl(path, token)`) y luego hace `PATCH /settings/holding { logo_url: public_url }`.
400: `El logo debe ser PNG, JPG o WEBP`, `El logo no puede superar 2 MB`. El bucket aplica los mismos límites con la migración
`1790810000000-CompanyLogosBucketLimits` (sin aplicar; hoy el bucket no tiene límites y solo guarda PNG de hasta 125 KB).

### `GET /settings/holding/preferences` · VIEW
```json
{ "system_currency": "USD", "fx_system_policy": "monthly_avg", "auto_renewal_notice_days": 30,
  "locked": true, "locked_reason": "El holding ya tiene contratos: la moneda de consolidación y la política de tipo de cambio no se pueden cambiar porque cambiarían todas las métricas históricas" }
```
`locked` = el holding tiene contratos no borrados → el front muestra moneda de consolidación y política de solo lectura con `locked_reason`
(`null` si no está bloqueado). `system_currency` = **moneda de consolidación**. `fx_system_policy`: `fixed_period` (tasa fija por período, §1.1) | `monthly_avg` (promedio mensual).
Si el holding no tiene fila en `holding_settings` se devuelven esos valores por defecto.

### `PATCH /settings/holding/preferences` · EDIT
Body (opcional cada uno): `{ "system_currency": "CLP", "fx_system_policy": "fixed_period", "auto_renewal_notice_days": 1–180 }` → mismo shape (upsert).
400: `Moneda no reconocida: XXX`, `La política de tipo de cambio debe ser tasa fija por período o promedio mensual`, `Los días de aviso deben estar entre 1 y 180`.
409 (con contratos no borrados; enviar el mismo valor no cuenta como cambio):
`No se puede cambiar la moneda de consolidación: el holding ya tiene contratos y cambiaría todas las métricas históricas` (Domi 02-10) y
`No se puede cambiar la política de tipo de cambio: el holding ya tiene contratos y cambiaría todas las métricas históricas` (Domi 03-10).

### 1.1 Tasas fijas por período · `holding_fx_period_rates`
- `GET /settings/holding/fx-rates?from_currency=CLP&to_currency=USD` · VIEW → `[FxRate]` ordenado por `period_start` desc.
  ```json
  { "id": "uuid", "from_currency": "CLP", "to_currency": "USD", "rate": 0.00105, "period_start": "2026-01-01", "period_end": "2026-03-31", "notes": null, "created_by_name": "Domi", "created_at": "…", "updated_at": "…" }
  ```
- `POST /settings/holding/fx-rates` · EDIT · body `{ from_currency, to_currency, rate (>0), period_start, period_end, notes? }` → `FxRate` (201).
- `PATCH /settings/holding/fx-rates/:id` · EDIT · cualquiera de los campos anteriores → `FxRate`.
- `DELETE /settings/holding/fx-rates/:id` · EDIT → 204.
- Errores: 400 `Las monedas de origen y destino deben ser distintas`, `La tasa debe ser mayor que cero`,
  `La fecha de fin debe ser igual o posterior a la de inicio`, `La fecha de inicio no es válida (AAAA-MM-DD)` (también `2026-02-30`);
  409 `Ya hay una tasa CLP→USD que se cruza con ese período (01-01-2026 a 31-03-2026)` (si dos guardados se cruzan en carrera, el trigger
  responde 409 `Ya existe una tasa para ese par en esas fechas`);
  404 `Tasa no encontrada`.

### `GET /settings/holding/fx-sync-status` · VIEW
Estado de la sincronización automática (solo lectura). Monedas en uso = moneda de consolidación + monedas de las compañías + monedas de ítems
de contrato del holding. Base `USD` (los pares se cargan como USD→moneda).
```json
{ "base_currency": "USD",
  "currencies": [
    { "currency": "CLP", "pair": "USD/CLP", "last_rate_date": "2026-10-02", "rate": 943.1, "source_type": "BANCOCENTRAL", "source_label": "Banco Central de Chile", "days_old": 0 },
    { "currency": "PEN", "pair": "USD/PEN", "last_rate_date": "2026-10-02", "rate": 3.71, "source_type": "PERU_API", "source_label": "Perú API (SUNAT)", "days_old": 0 },
    { "currency": "GBP", "pair": "USD/GBP", "last_rate_date": null, "rate": null, "source_type": null, "source_label": null, "days_old": null } ] }
```
Las filas `source_type = 'system'` (cruces calculados una vez) no cuentan como sincronización.

### `GET /settings/holding/tree` · VIEW
```json
{ "holding": { "id": "uuid", "name": "Hanka", "logo_url": null, "system_currency": "USD", "fx_system_policy": "monthly_avg" },
  "companies": [
    { "id": "uuid", "legal_name": "Hanka SpA", "country_code": "CL", "country": "Chile", "currency": "CLP", "logo_url": null,
      "closed_until": "2026-07-31", "accounts_complete": false, "sii_configured": true, "erp_linked": false } ] }
```
- `closed_until`: `accounting_period_cutoff.cutoff_date` (null = nada cerrado).
- `accounts_complete`: existe fila en `company_account_mappings` con las 5 cuentas con código y nombre (criterio único
  `accountsCompleteSql`, `src/core/utils/account-mappings.ts`; Ingresos usa el mismo para la excepción `no_account_mapping`).
- `sii_configured`: `sii_configurations.is_enabled = true` para la compañía.
- `erp_linked`: `companies.odoo_integration_id` no nulo.

## 2. Catálogos

Todos devuelven `in_use` (cuántos registros lo usan). Borrar solo si `in_use = 0`; si no → **409** con sugerencia de desactivar.
Desactivar/activar = `PATCH { "is_active": false|true }`. Listas: activos e inactivos, orden por nombre/valor.

### 2.1 Vendedores · `/settings/sellers`
- `GET` → `[{ "id", "name", "email", "phone", "is_active", "created_at", "in_use" }]` (`in_use` = cotizaciones con ese vendedor).
- `POST` `{ "name": 1–200, "email": email, "phone"?: texto|null }` → vendedor (201).
- `PATCH /:id` `{ name?, email?, phone?, is_active? }` → vendedor.
- `DELETE /:id` → 204 · 409 `Este vendedor está en 4 cotizaciones: desactívalo en vez de eliminarlo`.
- 409 `Ya existe un vendedor con ese correo` (único por holding, sin distinguir mayúsculas).

### 2.2 Motivos de baja · `/settings/churn-reasons`
- `GET` → `[{ "id", "name", "is_active", "created_at", "updated_at", "in_use" }]` (`in_use` = contratos con ese motivo).
- `POST` `{ "name": 1–200 }`; `PATCH /:id` `{ name?, is_active? }`; `DELETE /:id`.
- 409 `Ya existe un motivo de baja con ese nombre`; 409 `Este motivo está en 3 contratos: desactívalo en vez de eliminarlo`.

### 2.3 Datos maestros · `/settings/master-data/:category`
`:category` ∈ `item_types` (Tipos de ítem) · `units_of_measure` (Unidades de medida) · desde la ronda 3 también `markets`, `segments`,
`industries` (§8.4). **Condiciones de pago salió de Configuración** (Domi 03-10): `payment_terms` u otra → 400
`Lista no válida: tipos de ítem, unidades de medida, mercados, segmentos o industrias`. Las filas `payment_terms` siguen en
`master_data` y Contratos las lee igual.
- `GET` → `[{ "id", "category", "value", "is_active", "created_at", "updated_at", "in_use", "usage": { "contracts", "quotes", "subscriptions", "invoices", "quantities" } }]`.
  `in_use` = suma del desglose `usage` (para el tooltip del front). Conteo por texto exacto en el holding (columnas verificadas 03-10):
  tipos → `contract_items`, `quote_items`, `subscription_items`, `invoice_items_legacy` (`item_type`); unidades → `contract_items`, `quote_items`,
  `invoice_items` + `invoice_items_legacy` (= `invoices`), `quantities` + `sapira_quantity_imports` (= `quantities`) (`unit_of_measure`).
- `POST` `{ "value": 1–100 }`; `PATCH /:id` `{ value?, is_active? }`; `DELETE /:id`.
- 409 `Ya existe ese valor en esta lista`; 409 `Este valor está en uso (12 registros): desactívalo en vez de eliminarlo`;
  409 `Este valor está en uso (12 registros): no se puede renombrar; desactívalo y crea uno nuevo` (renombrar un valor en uso).

### 2.4 Campos personalizados · `/settings/custom-fields`
- `GET ?entity_type=contract_item` → `[{ "id", "entity_type", "field_name", "field_label", "field_type", "is_required", "is_active", "display_order", "created_at", "values_count" }]`
  orden `entity_type, display_order, created_at`.
  `entity_type` ∈ `client`, `contract`, `contract_item`, `quote`, `quote_item`, `invoice`, `invoice_item`.
  `values_count` = filas del holding con valor no vacío en `custom_fields->>field_name` (`quote` no tiene columna `custom_fields` → 0). En la lista
  se cuenta agrupado: una consulta por entidad para todos sus campos.
- `POST` `{ "entity_type", "field_name": snake_case /^[a-z][a-z0-9_]{0,62}$/, "field_label": 1–100, "field_type": "text|number", "is_required"?: false, "display_order"?: int ≥ 0 }` → campo (201).
  Sin `display_order` → al final de su entidad.
- `PATCH /:id` `{ field_label?, field_type?, is_required?, is_active?, display_order?, field_name? }`.
  `field_name` y `field_type` solo cambian si `values_count = 0` → 409 `Este campo ya tiene valores guardados: no se puede cambiar su nombre interno ni su tipo`.
- `DELETE /:id` → 204 · 409 `Este campo tiene valores en 102 registros: desactívalo en vez de eliminarlo`.
- 409 `Ya existe un campo con ese nombre interno para esta entidad`.

## 3. Compañías · `/settings/companies`

`Company`:
```json
{ "id": "uuid", "legal_name": "Hanka SpA", "tax_id": "76.123.456-7", "country_code": "CL", "country": "Chile",
  "legal_address": "…", "representative_name": "…", "email": "…", "phone": "…", "website": "…",
  "invoice_prefix": "F", "contract_prefix": "C", "tax_rate": 19, "currency": "CLP", "logo_url": null,
  "erp_linked": false, "odoo_integration_id": null, "created_at": "…" }
```
- **`tax_rate` en porcentaje**: `19` = 19 %. Rango 0–100, hasta 4 decimales. Las filas antiguas guardadas como fracción (`0.19`) se
  devuelven normalizadas (`19`) y al guardar se escriben siempre en porcentaje.
- `country_code` ISO 3166-1 alfa-2 validado contra `countries`; la API escribe además `country` con el nombre en español (D16).

| Método | Ruta | Permiso | Body / respuesta |
|---|---|---|---|
| GET | `/settings/companies` | VIEW | `[Company]` orden por `legal_name` |
| GET | `/settings/companies/:id` | VIEW | `Company` + `"sii_configured": bool` (SII habilitado; el front lo muestra solo si `country_code = 'CL'`), `"usage": { "contracts", "invoices", "period_events", "bank_movements", "subscriptions", "other" }`, `"can_delete": bool` |
| POST | `/settings/companies` | EDIT | `{ legal_name (req, 1–200), country_code (req), currency (req), tax_id?, legal_address?, representative_name?, email?, phone?, website?, invoice_prefix? (≤10), contract_prefix? (≤10), tax_rate? }` → `Company` (201). `holding_name` se copia del holding |
| PATCH | `/settings/companies/:id` | EDIT | cualquiera de los anteriores + `logo_url` → `Company` |
| DELETE | `/settings/companies/:id` | EDIT | 204 |
| POST | `/settings/companies/:id/logo-upload` | EDIT | igual que el del holding; ruta `companies/<company_id>/<uuid>.<ext>` |

Errores: 400 `País no reconocido: XX`; 400 `Moneda no reconocida: XXX`; 400 `El impuesto va en porcentaje (19 = 19 %), entre 0 y 100`;
404 `Compañía no encontrada`; 409 `No se puede cambiar la moneda: la compañía ya tiene 12 contratos y 30 facturas` (el trigger
`sync_contracts_company_currency` reescribiría la moneda de compañía de todos sus contratos);
409 `No se puede eliminar: la compañía tiene 3 contratos, 10 facturas y cierres de período` (se cuentan contratos, facturas, cierres/eventos de
período, movimientos y cargas de cartola, suscripciones, revenue, plantillas/cláusulas, agentes, reglas, configuraciones de integración,
splits de facturación, legado y configuración SII).
`quotes` no tiene `company_id` y **no** cuenta para bloquear el borrado: por diseño, una cotización llega solo con el cliente comercial
(la compañía emisora se elige al pasar a contrato).

### 3.1 Cuentas contables · `GET|PUT /settings/companies/:id/accounts`
```json
{ "company_id": "uuid", "configured": true, "complete": false,
  "accounts": [
    { "key": "receivable",   "label": "Cuentas por cobrar",     "code": "1.1.02", "name": "Clientes",          "external_code": null },
    { "key": "deferred",     "label": "Ingresos diferidos",     "code": "2.2.05", "name": "Ingresos diferidos",    "external_code": null },
    { "key": "unbilled",     "label": "Ingresos por facturar",  "code": "1.1.03", "name": "Ingresos por facturar", "external_code": null },
    { "key": "revenue",      "label": "Ingresos",               "code": "4.1.01", "name": "Ingresos",              "external_code": "400100" },
    { "key": "fx_difference","label": "Diferencia de cambio",   "code": null,     "name": null,                "external_code": null } ] }
```
- `configured`: hay fila en `company_account_mappings`. Sin fila, `code`/`name` vienen `null` (no se muestran los defaults de la tabla
  como si estuvieran configurados). Al leer, los nombres por defecto en inglés de la tabla (`Revenue`, `Deferred Revenue`,
  `Unbilled Revenue (Contract Asset)`) se devuelven en español; un nombre propio se respeta.
- `PUT` (EDIT) body `{ "accounts": [{ "key", "code": 1–50, "name": 1–200, "external_code"?: ≤ 100 | null }] }` con **las 5 claves**, una vez
  cada una → respuesta GET. 400 `Faltan cuentas: Diferencia de cambio`, `Cuenta repetida: Ingresos`, `Cuenta no reconocida: x`.
- **Ingresos › Asientos lee las 5 cuentas** (OK de Domi 03-10): `GET /metrics/revenue/journal` devuelve en `accounts` y en cada línea
  `{ code, name, external_code }` de las 5 (incluye `receivable_*` y `fx_difference_*`, y el código del ERP para el export); la excepción
  `no_account_mapping` aparece si la compañía no tiene las 5 completas (mismo criterio que el árbol).

### 3.2 Cuentas bancarias · `/settings/companies/:id/bank-accounts`
`BankAccount`: `{ "id", "company_id", "bank_name", "account_type", "account_number", "currency", "account_holder", "created_at", "in_use" }`
(`in_use` = cargas de cartola con esa cuenta).
- `GET` → `[BankAccount]`; `POST` `{ bank_name 1–100, account_type 1–50 (p. ej. "Cuenta Corriente"), account_number 1–50, currency, account_holder? }` (201);
  `PATCH /:accountId` (cualquiera); `DELETE /:accountId` → 204.
- 409 `Ya existe esa cuenta (banco y número) en esta compañía`; 409 `Esta cuenta tiene 3 cargas de cartola: no se puede eliminar`;
  409 `La cuenta ya tiene cartolas cargadas: no se puede cambiar su moneda ni su número` (el número se compara sin separadores; banco, tipo y
  titular sí cambian);
  404 `Cuenta bancaria no encontrada`.

### 3.3 Documentos legales · `/settings/companies/:id/legal-documents`
Bucket **privado** `company-files` (M8). Ruta `<holding_id>/<company_id>/legal/<document_id>/<archivo>`.
`LegalDocument`: `{ "id", "document_name", "document_type", "upload_date", "file_name", "mime_type", "file_size", "uploaded_by_name", "legacy": false, "file_url": null, "created_at" }`
(`legacy: true` = fila antigua sin archivo en Storage; trae su `file_url` si tenía. La descarga de una fila antigua devuelve ese `file_url`).
1. `POST .../legal-documents/upload-url` (EDIT) `{ "file_name", "mime_type", "size" }` → `{ "document_id", "path", "upload_url", "token" }`.
   PDF, PNG, JPG, WEBP, Word, Excel; máx. 20 MB → 400 `Tipo de archivo no permitido`, `El archivo no puede superar 20 MB`.
2. El navegador sube a `upload_url`.
3. `POST .../legal-documents` (EDIT) `{ "document_id", "path", "document_name" 1–200, "document_type" 1–100, "file_name", "mime_type" }` → `LegalDocument` (201).
   400 `La ruta del archivo no corresponde a esta compañía`; 400 `El archivo no se subió: vuelve a intentarlo`; 409 `Este documento ya está registrado`
   (mismo `document_id` confirmado dos veces).
- `GET .../legal-documents` (VIEW) → `[LegalDocument]`.
- `GET .../legal-documents/:docId/download` (VIEW) → `{ "url": "firmada, 60 s" }`.
- `DELETE .../legal-documents/:docId` (EDIT) → 204 (borra la fila y el archivo).

### 3.4 Cierre de períodos · `/settings/companies/:id/periods`
- `GET` (VIEW) →
  ```json
  { "company_id": "uuid", "cutoff_date": "2026-07-31", "last_action": "CLOSED", "last_action_at": "…",
    "last_action_by_name": "Ana", "last_action_by_email": "ana@…", "last_action_reason": "Cierre contable julio",
    "events": [{ "id", "action": "CLOSED|REOPENED", "cutoff_date_before": "2026-06-30", "cutoff_date_after": "2026-07-31",
                 "performed_by_name", "performed_by_email", "performed_at", "reason" }] }
  ```
  Sin cierre: `cutoff_date`, `last_*` en `null` y `events: []`.
- `POST .../periods/close` (**CLOSE_PERIODS**) `{ "until_date": "2026-08-31", "reason": "≥ 10 caracteres" }` → respuesta GET.
  400 `La fecha de cierre debe ser el último día de un mes`; 400 `El motivo debe tener al menos 10 caracteres`;
  409 `Ya está cerrado hasta el 31-08-2026`; 409 `No se puede cerrar antes del cierre actual (31-08-2026): para retroceder, reabre desde el mes que necesitas`;
  409 `Solo se pueden cerrar meses terminados: Octubre 2026 aún no termina (puedes cerrar hasta el 30-09-2026)` (Domi 03-10: `until_date` ≤ último
  día del mes anterior a hoy, **hora Chile**).
- `POST .../periods/reopen` (**CLOSE_PERIODS**) `{ "from_date": "2026-07-01", "reason": "≥ 10" }` → respuesta GET; nuevo cierre = `from_date − 1 día`.
  400 `La fecha de reapertura debe ser el día 1 de un mes`; 409 `No hay períodos cerrados para reabrir`;
  409 `Julio 2026 ya está abierto (cerrado hasta 30-06-2026)`.
- Una transacción que escribe `accounting_period_cutoff` (upsert) y `accounting_period_events` con los mismos datos que
  `close_period_until`/`reopen_period_from` (`performed_by`, `_name`, `_email` del usuario de la sesión), con la compañía bloqueada
  `FOR NO KEY UPDATE`. Los triggers de bloqueo de período no cambian.
- **Qué protege el cierre** (Domi 03-10): contratos e ítems (triggers `trg_period_guard_contracts` / `_contract_items` y modificaciones de
  contrato). **Pagos, facturas y consumos se pueden registrar o mover en meses cerrados**: la cola Por emitir, registrar/anular pagos y
  los consumos ya no generan `period_closed`.

## 4. Usuarios · `/settings/users`
(Invitar, reenviar, desactivar y eliminar invitación: al final del bloque, D5/D6.)
- `GET` (VIEW) → miembros del holding activo (`user_holdings`):
  ```json
  [{ "id": "uuid", "name": "Ana", "email": "ana@…", "avatar": { "kind": "initials" }, "status": "Activo|Pendiente|Inactivo", "access_active": true,
     "last_access": "…", "last_invitation_sent_at": "…", "role": { "id": "uuid", "name": "Finanzas" } | null,
     "is_super_admin": false, "is_self": false }]
  ```
  Los super admin no aparecen salvo que quien consulta sea super admin. `role` es `null` si el rol no es de este holding.
  `avatar` (03-10): forma de Mi perfil §3 (`initials` | `preset` + `preset_id` | `upload` + `url`), en la misma consulta; también en el
  usuario que devuelven cambiar rol, invitar, reenviar y acceso (mismo shape).
- `PATCH /settings/users/:id/role` (EDIT) `{ "role_id": "uuid" }` → el usuario.
  404 `Usuario no encontrado`; 404 `Rol no encontrado`; 409 `El rol de un super admin no se cambia desde aquí`;
  409 `Este usuario pertenece a más de un holding y su rol es único: cámbialo desde soporte`;
  409 `El holding quedaría sin nadie que pueda editar la configuración` (si el cambio deja en 0 a los miembros activos —no super admin— con
  `EDIT_CONFIGURACION` o `ALL_PERMISSIONS`, cuando antes había al menos uno).

## 5. Permisos y roles

### `GET /settings/permissions` (VIEW)
```json
{ "modules": [
    { "key": "clientes", "label": "Clientes", "view": { "code": "VIEW_CLIENTES", "label": "Ver" }, "edit": { "code": "EDIT_CLIENTES", "label": "Editar" } },
    { "key": "precios", "label": "Precios y productos", "view": null, "edit": null, "note": "Usan Contratos (VIEW/EDIT_CONTRATOS)" } ],
  "special": [{ "code": "CLOSE_PERIODS", "label": "Cerrar y reabrir períodos contables" }],
  "internal": [{ "code": "ALL_PERMISSIONS", "label": "Acceso completo (comodín)" }] }
```
Módulos (orden): Dashboard, Clientes, Cotizaciones, Contratos, Facturación, Ingresos y Métricas (`*_REVENUE`), Reportes, Agentes IA,
Integraciones, Configuración. Solo se listan códigos que existen en el catálogo `permissions`.
Ocultos: `MANAGE_*`, `VIEW_REPORTS`, `*_FINANCIAL_DATA`. `internal` (`VIEW_LAB`, `VIEW_DOCUMENTACION`, `ALL_PERMISSIONS`,
`ADMIN_FULL_ACCESS`; solo los que existen en el catálogo —hoy `ALL_PERMISSIONS`—) **solo para super admin**; para el resto es `[]`.

### Roles · `/settings/roles`
`Role`: `{ "id", "name", "description", "is_default", "users_count", "permissions": ["VIEW_CLIENTES", …], "created_at" }`.
- `GET` (VIEW) → `[Role]` (por defecto primero, luego por nombre). `GET /:id` → `Role`.
- `POST` (EDIT) `{ "name": 1–100, "description"?: ≤ 300, "permissions": ["CODE", …] }` → `Role` (201). **Editar incluye Ver**: por cada `EDIT_X`
  se agrega `VIEW_X` (si existe en el catálogo); igual al editar y al duplicar.
- `PATCH /:id` (EDIT) `{ name?, description?, permissions? }` → `Role` (reemplaza la lista completa).
- `DELETE /:id` (EDIT) → 204.
- `POST /:id/duplicate` (EDIT) `{ "name"?: texto }` (por defecto `"<nombre> (copia)"`) → `Role` (201). Si el rol original tiene
  `ALL_PERMISSIONS` y quien duplica no es super admin, la copia recibe **todos los códigos visibles** explícitos en lugar del comodín. La copia
  solo lleva códigos del catálogo que quien duplica puede otorgar (`isGrantable`: sin internos ni heredados como `MANAGE_*` o `VIEW_REPORTS`).
- Errores: 409 `Los roles por defecto no se editan: duplícalo para personalizarlo` / `… no se eliminan`;
  409 `Ya existe un rol con ese nombre`; 409 `El rol tiene 3 usuarios: asígnales otro rol antes de eliminarlo`;
  400 `Permiso no válido: X` (no existe o es interno y no eres super admin);
  409 `El holding quedaría sin nadie que pueda editar la configuración`; 404 `Rol no encontrado`.

### Alertas del rol · `/settings/roles/:id/alerts`
- `GET` (VIEW) →
  ```json
  { "role_id": "uuid", "alerts": [
    { "type": "invoice_odoo_failure", "label": "No se pudo enviar una factura al ERP", "module": "facturacion",
      "module_label": "Facturación", "icon": "receipt-text", "enabled": true },
    … ] }
  ```
  Desde Notificaciones v2 (03-10) ofrece **todos los tipos suscribibles con productor del catálogo** (10, en el orden del catálogo; ver
  `contrato-api-notificaciones.md` §1); los reservados de fase 2 se suman cuando tengan productor.
- `PUT` (EDIT) `{ "types": ["salesforce_staging_blocked", …] }` → respuesta GET. Reemplaza solo las suscripciones de **ese rol**
  (`notification_role_subscriptions`); las de otros roles y la de super admins (`role_id NULL`) no se tocan. Vale también para roles por
  defecto (las alertas son configuración del holding, no del rol). 400 `Tipo de alerta no válido: x`.

## 6. Productos · `/products`
`Product`:
```json
{ "id": "uuid", "product_code": "TMS-01", "name": "TMS", "is_recurring": true, "status": "active|archived", "created_at": "…",
  "usage": { "contracts": 12, "quotes": 30, "prices": 2 },
  "mappings": { "odoo": true, "salesforce": 3, "stripe": false } }
```
`mappings.odoo`/`stripe`: columna del producto o fila en `odoo_product_mappings`/`stripe_product_mappings`; `salesforce`: nº de mapeos activos
en `salesforce_product_mappings` (+1 si `products.salesforce_product_id`). Sin precio ni moneda (viven en Precios).
- `GET ?status=active|archived|all (default all)&search=texto` (VIEW_CONTRATOS) → `[Product]` orden por nombre.
- `GET /:id` → `Product`.
- `POST` (EDIT_CONTRATOS) `{ "product_code": 1–50, "name": 1–200, "is_recurring"?: true }` → `Product` (201).
- `PATCH /:id` `{ product_code?, name?, is_recurring? }`. `is_recurring` solo cambia si el producto no está en uso.
- `POST /:id/archive` · `POST /:id/reactivate` → `Product` (idempotentes, 200).
- `DELETE /:id` → 204 solo si nunca se usó (contratos, cotizaciones, precios, facturas, suscripciones, líneas de facturas antiguas emparejadas
  `invoice_items_legacy_match`) ni está mapeado.
- `search` busca `%` y `_` literales (no como comodines).
- Errores: 409 `Ya existe un producto con el código TMS-01` (único por holding, sin distinguir mayúsculas ni espacios);
  409 `El producto está en uso (12 contratos, 30 cotizaciones): archívalo en vez de eliminarlo`;
  409 `El producto está vinculado con Odoo/Salesforce/Stripe: quita el vínculo en Integraciones o archívalo`;
  409 `El producto está en uso: no se puede cambiar si es recurrente`; 404 `Producto no encontrado`.

## 7. Países · `GET /catalog/countries`
Solo sesión (sin `x-holding-id`). → `[{ "code": "CL", "name_es": "Chile", "name_en": "Chile" }]` (249 países ISO 3166-1 alfa-2, orden por
`name_es`). Tabla `countries` (M7).

## 8. Ronda 3 (03-10)

Mismas reglas comunes del §0 (holding por header, VIEW/EDIT de Configuración, 404 por id de otro holding, `{ message }` en 4xx,
interceptor `settings-db-errors.ts`). Todo lo de esta sección es **nuevo**; no cambia ninguna respuesta anterior salvo lo marcado
como "agrega".

### 8.1 Documentos tributarios de la compañía · `GET /settings/companies/:id/tax-documents` (solo lectura)

Decisión de Domi (03-10, simplificada): **sin activación por compañía**. Cada documento del catálogo global `tax_document_types` puede fijar
su tasa de impuesto (`tax_rate`, `null` = usa la de la compañía); Configuración solo la **muestra**. Requiere la migración M11 (§11).
Tasas cargadas: CL 33 = 19, 34 = 0, 110 = 0, 111 = 0, 112 = 0; PE 01 = 18, 03 = 18; MX CFDI-I = 16; **CO FE = 0**; notas nacionales y
genéricos `*` = `null`. No se crean ni editan tipos desde la API.

`GET` (VIEW) →
```json
{ "company_id": "uuid", "country_code": "CL", "company_tax_rate": 19, "generic": false,
  "documents": [
    { "id": "uuid", "country_code": "CL", "code": "33", "name": "Factura electrónica", "kind": "invoice", "is_electronic": true,
      "tax_rate": 19, "effective_tax_rate": 19, "tax_rule": "document", "in_use": 12, "in_use_open": 10 },
    { "id": "uuid", "country_code": "CL", "code": "61", "name": "Nota de crédito electrónica", "kind": "credit_note", "is_electronic": true,
      "tax_rate": null, "effective_tax_rate": 19, "tax_rule": "company", "in_use": 0, "in_use_open": 0 } ] }
```
- `documents`: los del país de la compañía (`country_code`; si falta, el país normalizado de `companies.country`), todas las familias
  (`invoice`, `export_invoice`, `credit_note`, `debit_note`, `receipt`), por `sort`. Si el país no tiene documentos propios (o no se conoce),
  los genéricos `*` y `generic: true`. Solo filas activas del catálogo.
- `tax_rate`: tasa del catálogo en % o `null`. `effective_tax_rate` + `tax_rule` = lo que aplica el motor: `export` (exportación → 0),
  `colombia_erp` (Colombia → `effective_tax_rate: null`: en Por Emitir va 0 y el IVA lo aplica el ERP), `document` (la tasa del documento),
  `company` (la de la compañía; `null` si no tiene).
- `in_use`: contratos no borrados de la compañía con ese documento; `in_use_open`: de esos, los no cancelados.
- 404 `Compañía no encontrada`.

**Efecto en Contratos** (autorizado, módulo cerrado):
- `GET /contracts/form-options` → igual que hoy (catálogo del país de la compañía; genéricos si no tiene); cada opción de
  `tax_document_types` **agrega** `tax_rate` (número o `null`). Sin documento por defecto por compañía.
- **Motor de facturación** (Por Emitir, vista previa, activación y re-cálculos): exportación → 0; Colombia → 0 (lo aplica el ERP); si el
  contrato tiene `tax_document_type_id` y ese documento tiene `tax_rate` → esa tasa; si no → la de la compañía. La integración con Odoo
  no cambia (sigue mandando tipo de documento y `export_type`). Cambiar el documento de un contrato a otro de la misma familia con distinta
  tasa (p. ej. 33 → 34) re-calcula el IVA de sus Por Emitir desde la fecha efectiva, como al cambiar de familia. Activar un contrato cuyo
  documento tiene tasa propia ya no exige tasa en la compañía.
- **Una sola regla** (`resolveTaxRate`, `src/modules/contracts/billing-engine.ts`) para todo camino que crea o recalcula facturas; las
  facturas que nacen de otra (NC/ND de anulación o descuento, consolidación, OC parcial, consumos sobre una factura, revalorización
  multimoneda) **heredan la tasa de la factura de origen**. Solo hacia adelante: no se recalculan Por Emitir existentes (los contratos
  activos conservan sus facturas; un recálculo ocurre solo por una acción de la usuaria, p. ej. una modificación). Detalle por camino en
  [`spec-configuracion-v2.md`](./spec-configuracion-v2.md) §13.
- **Familia del documento en el alta (05-10)**: con el documento **sugerido**, la familia sale del país emisor vs el receptor; en México,
  Perú y Colombia la exportación usa el documento local (CFDI, 01, FE) y antes el contrato quedaba como factura nacional con IVA. Un
  documento **elegido** sigue fijando la familia por su `kind`.
- **Corrección de datos del 05-10 (OK de Domi)**: 614 contratos activos sin `document_type`/`tax_document_type_id` quedaron con la familia
  por país y el documento del catálogo de esa familia (si el país no tiene uno de exportación, sin documento), y 421 Por Emitir con
  documento, exportación, tasa, IVA y totales según `resolveTaxRate` (netos sin tocar; Chile 18 % → 19 %, Colombia → 0, exportaciones →
  0). Fuera: Hanka Inc. (demo). Después, con OK, U-PLANNER INC (EE. UU. → EE. UU., 21 % → 0, contrato 237: 3 Por Emitir).
  Respaldo en `sapira_backups.contracts_documento_20261005[b]`, `invoices_iva_20261005[b]` e `invoice_items_iva_20261005[b]`.

### 8.2 Comunicaciones (dominios y remitentes del holding) · `/settings/communications/*`

Rutas nuevas sobre las tablas de siempre (`holding_email_sender_settings`, `email_sender_addresses`) y SendGrid. **Siempre** con el holding
del header: cada id se filtra por holding (404 si no es suyo). Las rutas viejas `/emails/*` y `/email/*` no cambian.

`Domain`:
```json
{ "id": "uuid", "sender_domain": "mail.empresa.com", "display_name": "Principal", "status": "pending|verified|failed",
  "verified_at": "…|null", "is_default": true, "is_active": true,
  "dns_records": [{ "type": "CNAME", "name": "em123.mail.empresa.com", "value": "u123.wl.sendgrid.net", "status": "pending|verified" }],
  "created_at": "…", "updated_at": "…", "senders": [Sender] }
```
`Sender`: `{ "id", "domain_id", "from_name", "from_email", "reply_to_email", "purpose", "is_default", "is_active", "in_use", "created_at", "updated_at" }`
(`in_use` = configuraciones de agentes de clientes que usan ese remitente, `client_agent_configs.config_json.email_sender_address_id`).

| Método | Ruta | Permiso | Body / respuesta |
|---|---|---|---|
| GET | `/settings/communications/domains` | VIEW | `[Domain]` (por defecto primero, luego más recientes) |
| POST | `/settings/communications/domains` | EDIT | `{ sender_domain, from_name 1–100, from_email, display_name?, is_default? }` → `Domain` (201). Registra el dominio en SendGrid, guarda los registros DNS a configurar y crea el remitente por defecto. El primer dominio del holding queda por defecto |
| PATCH | `/settings/communications/domains/:id` | EDIT | `{ display_name?, is_default?, is_active? }` → `Domain`. Marcar por defecto desmarca el resto |
| DELETE | `/settings/communications/domains/:id` | EDIT | 204. Lo quita de SendGrid (si falla, se registra y sigue) y borra sus remitentes |
| POST | `/settings/communications/domains/:id/verify` | EDIT | Pide a SendGrid validar los DNS ahora → `{ "status": "verified|pending", "domain": Domain, "results": [{ "record": "mail_cname|dkim1|dkim2", "valid": true, "reason": null }] }` |
| POST | `/settings/communications/domains/:id/check-status` | EDIT | Lee el estado actual en SendGrid sin pedir validación y refresca el estado guardado → `{ "status", "domain": Domain }` |
| GET | `/settings/communications/senders?domain_id=` | VIEW | `[Sender]` de los dominios del holding (o de uno) |
| POST | `/settings/communications/senders` | EDIT | `{ domain_id, from_name 1–100, from_email, reply_to_email?, purpose? ≤ 50, is_default? }` → `Sender` (201) |
| PATCH | `/settings/communications/senders/:id` | EDIT | `{ from_name?, from_email?, reply_to_email?, purpose?, is_default?, is_active? }` → `Sender` |
| DELETE | `/settings/communications/senders/:id` | EDIT | 204 |
| POST | `/settings/communications/test-email` | EDIT | `{ "to": email, "sender_id"?: uuid }` → `{ "message": "Correo de prueba enviado a ana@…", "to", "from" }`. Sin `sender_id` usa el remitente por defecto del dominio por defecto |

Errores:
- 400 `El servicio de correo no está configurado: avisa a soporte` (sin `SENDGRID_API_KEY`).
- 400 `El dominio no es válido (ejemplo: mail.empresa.com)`; 409 `Ese dominio ya está registrado en el holding`;
  400 `El correo del remitente debe ser del dominio mail.empresa.com`; 400 `SendGrid rechazó el dominio: <motivo>`;
  503 `No se pudo conectar con el servicio de correo: vuelve a intentarlo`.
- 409 `Marca otro dominio por defecto antes de desactivar este`; 409 `Ya existe ese remitente en este dominio`;
  409 `Este remitente lo usan 2 agentes de clientes: cámbialo antes de eliminarlo` (también al eliminar un dominio con remitentes en uso:
  `Un remitente de este dominio lo usan 2 agentes de clientes: cámbialo antes de eliminar el dominio`).
- Correo de prueba: 400 `Solo puedes enviar la prueba a tu correo o al de un miembro del holding` (destino = el correo del usuario de la
  sesión o de un miembro activo del holding, sin distinguir mayúsculas); 409 `El dominio aún no está verificado: configura los registros DNS
  y verifica`; 409 `El remitente está desactivado`; 404 `No hay un dominio por defecto con remitente: configúralo primero`.
- 404 `Dominio no encontrado`, `Remitente no encontrado`.

### 8.3 Tipos de cambio sincronizados (detalle) · `/settings/holding/fx-sync/*`

Solo lectura (VIEW). `currency` debe ser una moneda en uso del holding (las de `fx-sync-status`) y distinta de la de consolidación. La
tasa es **unidades de la moneda de consolidación por 1 unidad de `currency`** (p. ej. CLP→USD = 0,00106). Las filas `source_type = 'system'`
no cuentan. `banco-central` y `peru-api` no se tocan.

`GET /settings/holding/fx-sync/history?currency=CLP&from=2026-07-01&to=2026-10-03` → (sin fechas: últimos 90 días hasta hoy)
```json
{ "currency": "CLP", "to_currency": "USD", "from": "2026-07-01", "to": "2026-10-03",
  "points": [{ "date": "2026-07-01", "rate": 0.00106, "source_type": "BANCOCENTRAL", "source_label": "Banco Central de Chile", "method": "direct|inverse|cross_usd" }] }
```
Orden por fecha ascendente, un punto por día con dato. `method`: `direct` (fila CLP→USD), `inverse` (fila USD→CLP, se usa 1/tasa),
`cross_usd` (cruce por USD, `source_label` = el de la pata de `currency`). Por día gana la carga más reciente.
400: `Moneda no reconocida: XXX`; `La moneda XXX no está en uso en el holding`; `CLP es la moneda de consolidación: no tiene tipo de cambio`;
`La fecha de inicio no es válida (AAAA-MM-DD)`; `La fecha de inicio debe ser anterior o igual a la de fin`; `El rango no puede superar 2 años`.

`GET /settings/holding/fx-sync/monthly?currency=CLP&year=2026` → (sin `year`: el año actual, hora Chile)
```json
{ "currency": "CLP", "to_currency": "USD", "year": 2026,
  "months": [{ "month": 1, "avg_rate": 0.00105, "min_rate": 0.00103, "max_rate": 0.00107, "data_points": 21,
               "source": "monthly_avg|monthly_avg_inverse|daily", "calculated_at": "…|null" }] }
```
Siempre 12 meses (`avg_rate: null` y `source: null` sin datos). `monthly_avg` = fila de `exchange_rates_monthly_avg` del par;
`monthly_avg_inverse` = la del par inverso (1/promedio; mín. y máx. invertidos); `daily` = calculado desde el detalle diario (mismo criterio
que `history`). 400 `El año debe estar entre 2000 y 2100` + los de moneda.

### 8.4 Catálogos (agrega)

- **`/settings/master-data/:category`** vuelve a aceptar `markets` (Mercados), `segments` (Segmentos) e `industries` (Industrias), con el
  mismo CRUD del §2.3. Uso = clientes del holding con ese texto exacto en `clients.market` / `clients.segment` / `clients.industry`.
  `usage` **agrega** la clave `clients` (0 en tipos de ítem y unidades). Otra categoría → 400
  `Lista no válida: tipos de ítem, unidades de medida, mercados, segmentos o industrias`.
- **`GET /settings/business-types`** (VIEW, solo lectura) → los 7 tipos de negocio del sistema:
  ```json
  [{ "code": "new_business", "label": "Nuevo negocio", "mrr_effect": "new", "mrr_effect_label": "Nuevo",
     "description": "Cliente sin contratos vigentes: crea un contrato nuevo y su MRR entra como Nuevo",
     "salesforce_types": ["NewBusiness", "Nuevo cliente"] }]
  ```
  Orden: `new_business`, `upsell`, `cross_sell`, `downsell`, `renewal`, `renegotiation`, `reactivation`. `mrr_effect` ∈ `new`, `expansion`,
  `contraction`, `none`, `reactivation`, `depends` (el movimiento real de MRR lo calcula Métricas desde el cambio del contrato; esto es la
  guía). `salesforce_types`: tipos de oportunidad de Salesforce del holding mapeados a ese tipo (`salesforce_quote_type_mappings` activos);
  `[]` si no hay integración.
- **`GET /settings/contact-types`** (VIEW, solo lectura) → lista fija:
  ```json
  [{ "value": "Facturación", "label": "Facturación", "description": "Recibe facturas y recordatorios de cobranza",
     "used_by": ["Cobranza (recordatorios)"], "in_use": 3 }]
  ```
  Orden: Principal, Comercial, Facturación, Cobranza, Proforma. `in_use` = contactos del holding con ese tipo (texto exacto).

### 8.5 Usuarios (agrega)

`GET /settings/users` → cada usuario **agrega** `"holdings_count": 2` (holdings activos a los que pertenece; > 1 = su rol es único y
"Cambiar rol" responde 409).

### 8.6 Ingresos (agrega)

La excepción `no_account_mapping` de `GET /metrics/revenue/exceptions` **agrega** `company_id` (para enlazar a las cuentas de la Compañía 360).

### 8.7 Campos personalizados: más tipos (agrega, Domi 03-10)

Requiere la migración M12 (§11): `custom_field_definitions.options jsonb NULL` y el CHECK de `field_type` ampliado (las definiciones
existentes, todas `text`/`number`, no cambian).
- `field_type` ∈ `text`, `number`, `select` (una opción de la lista), `boolean` (sí/no), `date` (`YYYY-MM-DD`).
- `options`: `[{ "value": "enterprise", "label": "Enterprise" }]` **obligatoria para `select`** (1–100 opciones; `value` 1–100 sin repetir
  —sin distinguir mayúsculas—; `label` 1–100); en los otros tipos debe faltar o ser `null`.
- `GET` agrega a cada campo `"options": [...] | null` y, en `select`, `"option_usage": { "enterprise": 12, "smb": 0 }` (registros del holding
  cuyo valor es esa opción, mismo conteo que `values_count`); en los otros tipos `option_usage: null`.
- `POST` / `PATCH` aceptan `options`. Errores: 400 `Las opciones son obligatorias para un campo de lista`; 400 `Solo los campos de lista
  tienen opciones`; 400 `Opción repetida: Enterprise`; 409 `La opción "Enterprise" está en 12 registros: no se puede quitar` (quitar o
  cambiar el `value` de una opción en uso; el `label` sí cambia); el tipo sigue sin poder cambiar si hay valores (409 ya existente).
- Los valores en sí los escriben los módulos dueños de cada entidad; Configuración solo define y cuenta.

### 8.8 Clientes y razones sociales: país ISO y listas del holding (autorizado, módulo cerrado `src/modules/clients`)

Requiere la migración M13 (§11): `clients.country_code` y `client_entities.country_code` (`char(2)`, FK `countries`), con backfill desde
el texto (mismo mapeo tolerante de M7: sin tildes ni mayúsculas, nombre en español o inglés, código `CL`/`UY`, alias `EEUU`/`USA`,
`República Dominicana`/`Dominican Republic`…). Lo que no calza queda `NULL` y se lista (no se toca el texto).
- **Respuestas** de clientes (`GET /clients`, `/clients/:id`, `/clients/:id/with-entities`) y razones sociales (`GET /client-entities`,
  `/client-entities/:id`, las de `/clients/:id/entities`) **agregan** `country_code` (`"CL"` o `null`). `country` (texto) sigue igual.
- **Escrituras** (`POST/PATCH /clients`, `POST/PATCH /client-entities`, y toda alta de razón social de la API —"Traer desde ERP",
  `change_entity` con `new_entity` en Contratos— por el escritor único `insertClientEntity`) aceptan `country_code` (ISO-2,
  validado contra `countries` → 400 `País no reconocido: XX`) y escriben además `country` con el nombre en español. Si solo llega
  `country` (front actual), la API intenta el código con el mismo mapeo y lo guarda si calza (si no, `country_code` queda `null`). El alta de
  razón social exige `country` **o** `country_code` (400 `Elige el país`).
- **Mercado, segmento e industria** (`market`, `segment`, `industry` en `POST/PATCH /clients`): si vienen con valor, deben existir y estar
  activos en `master_data` del holding (`markets`, `segments`, `industries`) → 400 `El mercado "X" no está en la lista del holding (Configuración
  › Catálogos)` (ídem `El segmento…`, `La industria…`). Mandar el **mismo valor que ya tiene** el cliente no se valida (los valores viejos
  fuera de la lista se siguen devolviendo y se pueden conservar; la limpieza es antes del switch). `null`/`''` lo borra.
- **`GET /clients/form-options`** (mismos guards que `/clients`) →
  `{ "markets": ["Nacional", …], "segments": ["Enterprise", …], "industries": ["Retail", …] }` (activos del holding, orden alfabético).

## 9. Ronda 4 (03-10) · preferencias del holding que ya funcionan

Mismas reglas del §0. Requiere la migración **M14** `1790850000000-HoldingSettingsPreferencesV4` (§11, una sola, aditiva): columnas nuevas en
`holding_settings` con defaults que reproducen exactamente el comportamiento de hoy. Si el holding no tiene fila, la API usa esos defaults.
Mientras M14 no esté aplicada la API **lee** con defaults (no se cae), pero `PATCH /settings/holding/preferences` necesita la migración.

### 9.1 `GET /settings/holding/preferences` (agrega)

```json
{ "system_currency": "USD", "fx_system_policy": "monthly_avg", "auto_renewal_notice_days": 30, "locked": true, "locked_reason": "…",
  "timezone": "America/Santiago",
  "renewal_reminder_days": [15, 7, 0],
  "renewal_overdue_every_days": 7,
  "renewal_reminder_ladder": [30, 15, 7, 0],
  "quote_numbering": { "mode": "prefixed", "prefix": "COT", "include_year": true, "width": 4, "next_number_preview": "COT-2026-0013" } }
```
- `timezone`: zona IANA del holding (default `America/Santiago`). Define el "hoy" del holding (§9.4).
- `renewal_reminder_days`: escalera de recordatorios de vencimiento, en días antes del fin (0 = el día del fin), **de mayor a menor**, sin
  repetidos (default `[15, 7, 0]`, que con la propuesta en 30 reproduce el comportamiento anterior; el front no deja guardar recordatorios ≥ la propuesta). `renewal_overdue_every_days`: vencido sin decisión, un recordatorio cada N días (default 7, 1–90).
- `renewal_reminder_ladder` (solo lectura): escalones que **realmente** usa el job = `auto_renewal_notice_days` (primer aviso) + los de
  `renewal_reminder_days` menores que él (misma regla de hoy: 30 → `[30, 15, 7, 0]`; 90 con escalera [60, 15, 7, 0] → `[90, 60, 15, 7, 0]`).
- `quote_numbering.next_number_preview`: el número que recibiría la próxima cotización creada en Sapira hoy (hoy = zona del holding);
  `null` en modo `manual`. Es una vista previa: el número real se reserva al crear (con lock), así que dos altas simultáneas no lo repiten.

### 9.2 `PATCH /settings/holding/preferences` (agrega)

Body (todo opcional, upsert; `quote_numbering` se mezcla con lo guardado):
```json
{ "timezone": "America/Lima",
  "renewal_reminder_days": [90, 30, 7, 0], "renewal_overdue_every_days": 14,
  "quote_numbering": { "mode": "prefixed", "prefix": "PROP", "include_year": false, "width": 5 } }
```
→ mismo shape que el GET. Validaciones (400 `{ message, errors[{ field, message }] }`):
- `timezone`: debe estar en `Intl.supportedValuesOf('timeZone')` (+ `UTC`) → `Zona horaria no reconocida: X`.
- `renewal_reminder_days`: lista de 1 a 10 enteros 0–180 sin repetidos → `Los recordatorios deben ser días entre 0 y 180`,
  `Hay días de recordatorio repetidos`, `Indica entre 1 y 10 recordatorios`. La API la **guarda ordenada de mayor a menor**.
- `renewal_overdue_every_days`: entero 1–90 → `La frecuencia de recordatorios vencidos debe estar entre 1 y 90 días`.
- `quote_numbering.mode` ∈ `prefixed` | `sequential` | `manual` → `Formato de numeración no válido: con prefijo, correlativo o manual`.
- `quote_numbering.prefix`: 1–10 letras o números → `El prefijo solo admite letras y números (máximo 10)`. Solo se usa en `prefixed`.
- `quote_numbering.include_year`: booleano (solo `prefixed`). `quote_numbering.width`: entero 1–8 → `El ancho del correlativo debe estar entre 1 y 8`
  (se usa en `prefixed` y `sequential`).
Sin 409 nuevos: estas preferencias se pueden cambiar con contratos (rigen hacia adelante; nada histórico se recalcula).

### 9.3 Numeración de cotizaciones (Cotizaciones, autorizado)

Solo para cotizaciones **creadas en Sapira** (`POST /quotes`; también `POST /quotes/:id/duplicate`, que la UI ya no ofrece). Las que llegan
del CRM conservan su número (id de la oportunidad) y no pasan por aquí. El número es **único por holding** (también contra borradas).
Editar (`PUT /quotes/:id`) no cambia el número. Cambio respecto de hoy: en los modos automáticos ya no se acepta un número escrito a mano.

| Modo | Número | Ejemplo | `quote_number` en el body de `POST /quotes` (y del alta desde el wizard) |
|---|---|---|---|
| `prefixed` (default) | lo genera la API: `{prefijo}-{año}-{correlativo}` o, sin año, `{prefijo}-{correlativo}`; correlativo con ceros a la izquierda hasta `width` | `COT-2026-0001` (formato actual) · `PROP-00001` | **no se acepta** → 400 `Este holding numera las cotizaciones automáticamente: no escribas el número` |
| `sequential` | lo genera la API: solo el correlativo con `width` dígitos | `0001` | **no se acepta** (mismo 400) |
| `manual` | lo escribe la usuaria al **crear** la cotización (1–40 caracteres: letras, números, `.`, `-`, `/`, `_`) | `ACME-OCT-1` | **obligatorio** → 400 `Escribe el número de la cotización (el holding usa numeración manual)`; repetido en el holding (también contra borradas) → 409 `code: quote_number_taken` `Ya existe una cotización con el número X` |

- Correlativo = el mayor de los números del holding que calzan el formato vigente + 1 (con año: por año calendario de la zona del holding,
  se reinicia cada año; sin año o `sequential`: un solo correlativo). Lock por holding y formato (`pg_advisory_xact_lock`): dos altas en
  paralelo no repiten número.
- Cambiar el formato no renumera nada; el correlativo del formato nuevo parte del mayor existente con ese formato.
- `POST /quotes/:id/duplicate` **agrega** `quote_number?` con las mismas reglas que `POST /quotes`.
- `GET /quotes/form-options` **agrega** `quote_numbering: { mode, next_number_preview }` (para que el formulario sepa si pedir el número).

### 9.4 Zona horaria del holding

"Hoy" del holding = fecha calendario en `holding_settings.timezone` (utilidad única `todayFor(timezone)` en
`src/modules/contracts/business-date.ts`; la zona se lee con `holdingTimezone(db, holdingId)` de `src/core/utils/holding-preferences.ts`).
Se usa en: jobs de contratos (propuestas de renovación, recordatorios de vencimiento, pactos por vencer, horizonte), cambios de contrato,
activación, alta (borradores), consumo, 360 de contrato, Facturación (cola, pagos, conciliación, cobranza y su job de recordatorios),
actividad del cliente (día de cada evento) y el año del correlativo de cotizaciones. Los crons siguen disparándose a su hora en
`America/Santiago` (hora del servidor); lo que cambia es el "hoy" que cada holding calcula dentro de la corrida.
Sin cambios de contrato en las respuestas (las fechas ya eran `YYYY-MM-DD`).

### 9.5 Horizonte de ítems sin término: fijo, no configurable

Decisión de Domi (03-10): el horizonte **no** es preferencia del holding. Queda **fijo en 12 períodos por sistema**, como calendario rodante
tipo ERP: la activación genera 12 Por Emitir por ítem sin término y el job diario `contracts-extend-horizon` mantiene siempre 12 períodos
por delante de hoy (constante `HORIZON_PERIODS_AHEAD`). Sin columna en `holding_settings`, sin campo en preferencias ni en
`GET /contracts/form-options` (el front sigue con su constante de 12). MRR, TCV y devengo sin cambios.

### 9.6 Recordatorios de vencimiento

- Job `contracts-renewal-reminders` (06:15): escalones = `renewal_reminder_ladder` (§9.1); vencido sin decisión, uno cada
  `renewal_overdue_every_days` días. Misma idempotencia (contrato, fin y escalón) y mismos eventos/notificaciones.
- Tarjeta de recordatorio del detalle de contrato: el escalón se calcula con la escalera del holding (antes siempre la de 30 días).
- **360 del cliente**: `GET /clients/form-options` **agrega** `renewal_notice_days` (= `auto_renewal_notice_days`), la ventana del aviso
  "vence pronto" (reemplaza los 90 días fijos del front).

### 9.7 Documento tributario del contrato: solo con cambio de razón social (Contratos, autorizado)

Decisión de Domi (03-10): el documento tributario de un contrato **no cambia solo**; solo en el mismo cambio en que cambia la razón social
receptora (o la emisora, que hoy no tiene camino de cambio en un contrato activo).
- `POST /contracts/:id/changes[/preview]` con `change.type = billing_conditions` y un `tax_document_type_id` (o `document_type`) distinto del
  actual → **bloqueo** `tax_document_requires_party_change`: el preview responde `can_apply: false` con el bloqueo y aplicar responde **409**
  `No se puede aplicar el cambio: El documento tributario solo cambia junto con la razón social emisora o receptora` (`code: blocked`).
  Mandar el mismo documento que ya tiene no cuenta como cambio.
- `change.type = change_entity` **agrega** `tax_document_type_id?` (y `document_type?` para holdings sin catálogo): el documento nuevo
  (del país de la compañía emisora; si no → 400 `El documento tributario no existe o no corresponde al país de la compañía emisora`) se
  guarda en el contrato y el IVA de las Por Emitir desde la fecha efectiva se **recalcula con el resolver único** (`resolveTaxRate`)
  con el documento nuevo. Sin `tax_document_type_id`, `change_entity` funciona como hoy (aviso `document_type_review` si el país cambia y
  el contrato usa catálogo).
- Borradores (`PUT /contracts/drafts/:id`) y el alta siguen eligiendo documento libremente (aún no hay facturas).

## 10. Usuarios: invitar, reenviar, acceso, eliminar (03-10, diseño aprobado por Domi)

Todo bajo `/settings/users*` con `HoldingScopeGuard` + `@RequirePermission(EDIT_CONFIGURACION)`. Quien actúa sale **siempre de la
sesión** (`PermissionContext`); ningún body lleva id de invitador ni de holding. Cada acción queda en `user_access_events` (M15).
Supabase Auth se usa solo desde la API con la clave de servicio (`SupabaseAdminService`: `generateLink`, `updateUserById`, `deleteUser`);
el correo sale por Resend desde la API (`AuthMailer`). Ambos viven en `src/auth/accounts/` (módulo `AuthAccountsModule`), compartidos
con recuperar contraseña (§10.6).

**Variables de entorno**

| Variable | Uso |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Admin de Auth. Sin ellas → 503 `La invitación de usuarios no está configurada` |
| `RESEND_API_KEY` | Envío del correo. Sin ella el correo cuenta como `failed` (la invitación queda creada) |
| `INVITE_FROM` | Remitente de invitación y recuperación; default `Sapira <noreply@aisapira.com>` |
| `EMAIL_LOGO_URL` | Opcional: logo PNG del correo; default `https://aisapira.com/assets/branding/email-logo-dark.png` |
| `INVITE_LANDING_URL` | Base del enlace (front nuevo). Sin ella → 503 `La invitación de usuarios no está configurada` |
| `INVITE_TEST_ALLOWLIST` | Opcional, **solo QA**: lista separada por comas de dominios (`aisapira.com`) o correos completos. Si existe, cualquier destinatario fuera → 400 `En este ambiente solo se puede invitar a correos autorizados para pruebas` (`errors[{ field: "email" }]`). Si no existe, no limita |

**Correo** (plantillas versionadas en `src/auth/accounts/email-templates/`: layout común con la marca —logo, violeta `#4917C6`, pie
`Sapira · aisapira.com`, tablas, estilos en línea, 600 px, texto alternativo—, HTML + texto plano, todo valor interpolado escapado):
asunto `{Invitador} te invita a {Holding} en Sapira`; botón `Aceptar invitación`; nota `El enlace vence en 24 horas.`. Invitador =
`users.name` (o correo) de quien actúa, Holding = `company_holdings.name`: **leídos de la base**, nunca del body. Enlace:
`${INVITE_LANDING_URL}/auth/confirm?token_hash=<hash>&type=invite|magiclink&next=/dashboard` (`invite` si la cuenta de Auth se creó
ahora; `magiclink` si ya existía o en reenvíos). Header `Idempotency-Key` = `invite-<user_id>-<n.º de envío>`.

### 10.1 `POST /settings/users/invitations` · EDIT · máx. 20 por minuto por quien invita (429)

Body `{ "email": "ana@cliente.com", "name": "Ana Pérez", "role_id": "uuid" }` (email válido, `name` 1–120, `role_id` UUID;
el email se guarda `trim().toLowerCase()`).

→ **201**
```json
{ "user": { …mismo shape que GET /settings/users… },
  "invitation": { "status": "sent" | "failed", "sent_at": "2026-10-03T…Z" | null } }
```
Con `status: "failed"` agrega `"message": "La invitación quedó creada pero el correo no salió: usa Reenviar"`.

| Caso | Respuesta |
|---|---|
| Rol que no es del holding | 404 `Rol no encontrado` |
| Correo fuera de `INVITE_TEST_ALLOWLIST` (si está definida) | 400 (ver arriba) |
| Ya es miembro activo de este holding | 409 `Ya tiene acceso a este holding` |
| Es miembro desactivado de este holding | 409 `Está desactivado: reactívalo` |
| Es super admin | 409 `No se puede invitar a este correo` |
| Usa Sapira en otro holding (y no en este) | 409 `Esta persona ya usa Sapira en otra empresa: escríbenos a soporte` |
| Supabase Auth falla (se deshace todo lo creado) | 502 `No se pudo crear la cuenta de acceso: vuelve a intentarlo en unos minutos` |
| Más de 20 en 1 minuto | 429 |

Flujo: transacción `users` (status `Pendiente`, `role_id`, `name`) + `user_holdings` (`is_active = true`) → `generateLink` tipo `invite`
(`data.full_name`, `redirectTo` = enlace); si Auth responde `email_exists` → tipo `magiclink` → guarda `users.auth_id` → correo →
`last_invitation_sent_at` / `last_invitation_status` (`sent` | `failed`) / `last_invitation_email_id` (id de Resend).

### 10.2 `POST /settings/users/:id/invitation/resend` · EDIT

→ **200** `{ "status": "sent" | "failed", "sent_at": "…" | null }` (con `failed` agrega `message: "El correo no salió: vuelve a intentarlo"`).
Genera un token nuevo (`magiclink`) y manda el mismo correo.

| Caso | Respuesta |
|---|---|
| No es miembro del holding, o es super admin | 404 `Usuario no encontrado` |
| Ya inició sesión alguna vez, o no está Pendiente | 409 `Ya activó su cuenta` |
| Su acceso a este holding está desactivado | 409 `Está desactivado: reactívalo` |
| Último envío hace < 60 s | 429 `Espera un minuto antes de reenviar la invitación` |
| Ya van 5 envíos en 24 h (contados en `user_access_events`: `invited` + `invitation_resent`) | 429 `Ya se enviaron 5 invitaciones en 24 horas: vuelve a intentarlo mañana` |
| Supabase Auth falla | 502 `No se pudo generar el enlace: vuelve a intentarlo en unos minutos` |

### 10.3 `PATCH /settings/users/:id/access` · EDIT

Body `{ "active": true | false }` → **200** el usuario (shape de GET).

| Caso | Respuesta |
|---|---|
| No es miembro del holding (super admin no visible) | 404 `Usuario no encontrado` |
| Es uno mismo | 409 `No puedes desactivarte` |
| Es super admin | 409 `El acceso de un super admin no se cambia desde aquí` |
| Desactivar dejaría al holding sin quien edite la configuración | 409 `El holding quedaría sin nadie que pueda editar la configuración` |
| Ya está en el estado pedido | 200 sin cambios (idempotente, sin evento) |

- **Desactivar**: `user_holdings.is_active = false, selected = false` en este holding. Si no le quedan holdings activos:
  `users.status = 'Inactivo'` y bloqueo en Auth (`ban_duration = 876000h`), así tampoco entra al front actual.
- **Reactivar**: `user_holdings.is_active = true`. Si estaba `Inactivo`: `status = 'Activo'` si alguna vez entró (`last_access`), si no
  `Pendiente`; desbloqueo en Auth (`ban_duration = none`). Si Auth falla al bloquear/desbloquear → 502 y no se cambia nada en la base.

### 10.4 `DELETE /settings/users/:id` · EDIT → 204

Solo invitaciones que nunca se usaron: `status = 'Pendiente'`, `last_access IS NULL` y **sin referencias** (cada FK hacia `users`,
leída de `pg_constraint` en el momento, salvo las propias de la persona que caen en cascada: `user_holdings`, `user_view_preferences`,
`app_notification_recipients`, y `user_access_events` que queda con `user_id = NULL`).
- Si pertenece a otros holdings: solo se quita la membresía de este (la cuenta sigue).
- Si no: se borra `users` y después la cuenta de Auth (`deleteUser`; si esto último falla queda registrado en el log, la fila ya no existe).

| Caso | Respuesta |
|---|---|
| No es miembro del holding (o es super admin y quien consulta no lo es) | 404 `Usuario no encontrado` |
| Super admin, uno mismo, Activo, Inactivo, ya entró alguna vez o con referencias | 409 `Ya activó su cuenta: desactívala en vez de eliminarla` |

### 10.5 `GET /settings/users` (agrega)

Cada usuario agrega:
```json
{ "access_active": true, "ever_signed_in": false, "invitation_status": "sent" | "failed" | null }
```
`access_active` = `user_holdings.is_active` de **este** holding (ya existía; se documenta); `ever_signed_in` = `last_access` no nulo;
`invitation_status` = `users.last_invitation_status` normalizado (`sent` | `failed`; otro valor heredado del front actual → `sent`
si hay `last_invitation_sent_at`, si no `null`).

### 10.6 `POST /auth/password-recovery` · **público** (sin sesión ni holding)

Recuperar contraseña pasa a la API: el correo de Supabase no tiene formato. Body `{ "email": "ana@cliente.com" }` (email válido; si no
→ 400 de validación).

→ **200 siempre** con el mismo cuerpo, exista o no la cuenta:
```json
{ "message": "Si el correo tiene una cuenta en Sapira, te enviamos un enlace para crear una nueva contraseña." }
```
- **Rate limit**: la llamada llega desde la BFF de Next, así que la API limita por la **IP real**: primera IP de `X-Forwarded-For` (la BFF
  debe enviarla; si no viene, la IP del socket) → **10 por minuto** (`@Throttle`, 429; la BFF ya aplica 3/min por IP real). El límite que de
  verdad protege es **por correo**: 1 por minuto y 5 por día (se omite **en silencio**, siempre 200).
- Solo cuentas con `users.auth_id` y `status` distinto de `Inactivo` (un desactivado está baneado en Auth). Sin cuenta: no hace nada.
- La respuesta no espera el trabajo (mismo tiempo exista o no el correo). `generateLink({ type: 'recovery', email, options: { redirectTo } })`
  y correo por `AuthMailer` con su plantilla: asunto `Restablece tu contraseña de Sapira`, título `Restablece tu contraseña`, botón
  `Crear nueva contraseña`, nota `El enlace vence en 24 horas. Si no lo pediste, ignora este correo.`.
- Enlace: `${INVITE_LANDING_URL}/auth/confirm?token_hash=<hash>&type=recovery&next=/bienvenida?modo=recuperar` (`next` va codificado
  en la URL: `next=%2Fbienvenida%3Fmodo%3Drecuperar`).
- Errores de Auth o Resend solo se registran en el log (la respuesta no cambia).

## 11. Migraciones y assets

| # | Archivo | Estado | Endpoints que la necesitan |
|---|---|---|---|
| M2 | `1790760000000-CompanyAccountMappingsFiveAccounts` | aplicada en QA y producción el 02-10 | `/accounts`, asientos de Ingresos |
| M3 | `1790770000000-ProductsStatus` | aplicada en QA y producción el 02-10 | `/products` |
| M4 | `seed/004-close-periods-permission.sql` | aplicada en QA y producción el 02-10 | `CLOSE_PERIODS` para Administrador y Finanzas |
| M7 | `1790780000000-CountriesAndCompanyCountryCode` | aplicada en QA y producción el 02-10 | `/catalog/countries`, compañías, árbol |
| M8 | `1790790000000-CompanyLegalDocumentsStorage` | aplicada en QA y producción el 02-10 | documentos legales |
| M9 | `1790800000000-RolesIsDefault` | aplicada en QA y producción el 02-10 | roles, permisos de rol |
| M10 | `1790810000000-CompanyLogosBucketLimits` | **sin aplicar** | límites del bucket `company-logos` (2 MB; PNG, JPG, WEBP). La API ya valida lo mismo |
| S5 | `seed/005-finanzas-view-configuracion.sql` | **sin aplicar** | `VIEW_CONFIGURACION` al rol por defecto Finanzas de los 7 holdings (entra a Configuración y a la Compañía 360 para cerrar períodos) |
| F | `functions/create_default_roles_for_holding.sql` | **sin aplicar**, revisión de Domi | holdings nuevos: `is_default`, `CLOSE_PERIODS` (Administrador, Finanzas), `VIEW_CONFIGURACION` (Finanzas); sin `ADMIN_FULL_ACCESS` (no existe en el catálogo) |
| M11 | `1790820000000-TaxDocumentTypesTaxRate` | **sin aplicar** | `tax_document_types.tax_rate` (con valores, CHECK 0–100); §8.1, form-options y motor |
| M12 | `1790830000000-CustomFieldTypes` | **sin aplicar** | `custom_field_definitions.options jsonb` + CHECK `field_type` con `select`, `boolean`, `date` (§8.7) |
| M13 | `1790840000000-ClientsCountryCode` | **sin aplicar** | `clients.country_code` y `client_entities.country_code` (FK `countries`) con backfill desde el texto (§8.8) |
| M14 | `1790850000000-HoldingSettingsPreferencesV4` | **sin aplicar** | `holding_settings`: `timezone`, `renewal_reminder_days`, `renewal_overdue_every_days`, `quote_numbering_mode`, `quote_number_prefix`, `quote_number_include_year`, `quote_number_width` (defaults = comportamiento actual) (§9) |
| S6 | `seed/006-tax-document-types-tax-rate.sql` | **sin aplicar** (no-op donde corrió M11) | tasas del catálogo en entornos nuevos, donde el seed 003 corre después de M11 |
| M15 | `1790860000000-UserAccessEvents` | **sin aplicar** | tabla `user_access_events` (auditoría + límite de reenvíos), RLS sin policies. **Antes de desplegar** las acciones de usuarios (§10) |
| M16 | `1790870000000-UserHoldingsReadOnlyForClients` | **sin aplicar** | `user_holdings_policy_direct` pasa a solo SELECT + `REVOKE INSERT, UPDATE, DELETE` de `anon`/`authenticated` (el asset `rls/user_holdings_policy_direct.sql` queda igual al estado nuevo) |
| G40 | `grants/040-user-holdings-read-only.sql` | **sin aplicar** | mismo REVOKE como asset (por si se re-aplica `grants/000`) |

Orden pendiente (QA y después prod, cada paso con OK): `migration:run` (M10, M11, M12, M13, M14, M15, M16) → `postgres:assets --apply --only seed/005-finanzas-view-configuracion.sql`
→ `--only functions/create_default_roles_for_holding.sql` → `schema:snapshot` en prod → `postgres:assets --apply --only rls/user_holdings_policy_direct.sql --only grants/040-user-holdings-read-only.sql` (registran el estado que ya dejó M16) → desplegar la API.

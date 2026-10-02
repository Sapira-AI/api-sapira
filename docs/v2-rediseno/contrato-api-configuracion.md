# Contrato API · Configuración v2

> **v2 · 02-10-2026 · construido** (rama `domi`, sin commit). Contrato de los endpoints del módulo Configuración (`src/modules/settings`) y de Productos
> (`src/modules/products`) para el front nuevo (`/lab/configuracion` y pestaña Productos de `/lab/precios`).
> Fuente de decisiones: [`spec-configuracion-v2.md`](./spec-configuracion-v2.md) (manda "Decisiones v3").
> Estado: código, tests y build verdes; las migraciones M2, M3, M7, M8, M9 y el seed M4 están escritos y **sin aplicar**
> (ver §11). Hasta que se apliquen, los endpoints que leen columnas o tablas nuevas responden 500.
> Código: `src/modules/settings` (README), `src/modules/products`, guards en `src/guards/` (`require-permission.guard.ts`,
> `super-admin-only.guard.ts`, `permissions.service.ts`; uso en [`autorizacion-y-tenancy.md`](./autorizacion-y-tenancy.md)).

## 0. Reglas comunes

- **Auth**: `Authorization: Bearer <token Supabase>` (`SupabaseAuthGuard`).
- **Holding**: header `x-holding-id` obligatorio (`HoldingScopeGuard`): sin header → 400 `Falta el holding activo (header x-holding-id)`;
  holding al que no perteneces → 403 `No tienes acceso a este holding`. Ningún body ni query lleva `holding_id`.
  Excepción: `GET /catalog/countries` (catálogo global, solo sesión).
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
- **Errores**: siempre `{ message }` en español; validación → 400 `{ message, errors: [{ field, message }] }`. Campos desconocidos en el body
  → 400 (`forbidNonWhitelisted`). Conflictos de negocio → 409 `{ message }`.
- **Fechas**: `YYYY-MM-DD` en fechas puras; ISO 8601 en marcas de tiempo. **Montos/tasas**: número JSON.
- **Moneda**: código ISO de 3 letras, validado contra el catálogo `currencies` (activas). 400 `Moneda no reconocida: XXX`.
- **DELETE** exitoso → `204` sin cuerpo.

## 1. Holding

### `GET /settings/holding` · VIEW
```json
{ "id": "uuid", "name": "Hanka", "website": "https://…", "phone": "+56…", "email": "hola@…", "logo_url": "https://…/company-logos/holdings/<id>/<uuid>.png" }
```

### `PATCH /settings/holding` · EDIT
Body (todo opcional): `{ "name": "texto 1–200", "website": "url|null", "phone": "texto|null", "email": "email|null", "logo_url": "url|null" }` → mismo shape que GET.
- `logo_url` solo puede ser `null` o una URL pública del bucket `company-logos` bajo la carpeta del holding
  (la que devuelve `logo-upload`) → 400 `El logo debe subirse con "Subir logo"`.

### `POST /settings/holding/logo-upload` · EDIT
Body `{ "file_name": "logo.png", "mime_type": "image/png|image/jpeg|image/webp|image/svg+xml", "size": 12345 }` (máx. 2 MB).
```json
{ "path": "holdings/<holding_id>/<uuid>.png", "upload_url": "https://…signed…", "token": "…", "public_url": "https://…/object/public/company-logos/holdings/<holding_id>/<uuid>.png" }
```
El navegador sube con `upload_url` (PUT, o `uploadToSignedUrl(path, token)`) y luego hace `PATCH /settings/holding { logo_url: public_url }`.
400: `El logo debe ser PNG, JPG, WEBP o SVG`, `El logo no puede superar 2 MB`.

### `GET /settings/holding/preferences` · VIEW
```json
{ "system_currency": "USD", "fx_system_policy": "monthly_avg", "auto_renewal_notice_days": 30 }
```
`system_currency` = **moneda de consolidación**. `fx_system_policy`: `fixed_period` (tasa fija por período, §1.1) | `monthly_avg` (promedio mensual).
Si el holding no tiene fila en `holding_settings` se devuelven esos valores por defecto.

### `PATCH /settings/holding/preferences` · EDIT
Body (opcional cada uno): `{ "system_currency": "CLP", "fx_system_policy": "fixed_period", "auto_renewal_notice_days": 1–180 }` → mismo shape (upsert).
400: `Moneda no reconocida: XXX`, `fx_system_policy debe ser fixed_period o monthly_avg`, `Los días de aviso deben estar entre 1 y 180`.
409: `No se puede cambiar la moneda de consolidación: el holding ya tiene contratos y cambiaría todas las métricas históricas`
(decisión de Domi 02-10; cuenta contratos no borrados del holding; enviar la misma moneda no cuenta como cambio).

### 1.1 Tasas fijas por período · `holding_fx_period_rates`
- `GET /settings/holding/fx-rates?from_currency=CLP&to_currency=USD` · VIEW → `[FxRate]` ordenado por `period_start` desc.
  ```json
  { "id": "uuid", "from_currency": "CLP", "to_currency": "USD", "rate": 0.00105, "period_start": "2026-01-01", "period_end": "2026-03-31", "notes": null, "created_by_name": "Domi", "created_at": "…", "updated_at": "…" }
  ```
- `POST /settings/holding/fx-rates` · EDIT · body `{ from_currency, to_currency, rate (>0), period_start, period_end, notes? }` → `FxRate` (201).
- `PATCH /settings/holding/fx-rates/:id` · EDIT · cualquiera de los campos anteriores → `FxRate`.
- `DELETE /settings/holding/fx-rates/:id` · EDIT → 204.
- Errores: 400 `Las monedas de origen y destino deben ser distintas`, `La tasa debe ser mayor que cero`,
  `La fecha de fin debe ser igual o posterior a la de inicio`; 409 `Ya hay una tasa CLP→USD que se cruza con ese período (01-01-2026 a 31-03-2026)`;
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
- `accounts_complete`: existe fila en `company_account_mappings` con las 5 cuentas con código y nombre.
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
`:category` ∈ `payment_terms` (Condiciones de pago) · `item_types` (Tipos de ítem) · `units_of_measure` (Unidades de medida). Otra → 400
`Categoría no válida: solo payment_terms, item_types o units_of_measure`.
- `GET` → `[{ "id", "category", "value", "is_active", "created_at", "updated_at", "in_use" }]`.
  `in_use` por texto exacto en el holding: condiciones → `quotes.payment_terms`; tipos → `contract_items`, `quote_items`, `subscription_items`
  (`item_type`); unidades → `contract_items`, `quote_items`, `invoice_items`, `quantities` (`unit_of_measure`).
- `POST` `{ "value": 1–100 }`; `PATCH /:id` `{ value?, is_active? }`; `DELETE /:id`.
- 409 `Ya existe ese valor en esta lista`; 409 `Este valor está en uso (12 registros): desactívalo en vez de eliminarlo`;
  409 `Este valor está en uso (12 registros): no se puede renombrar; desactívalo y crea uno nuevo` (renombrar un valor en uso).

### 2.4 Campos personalizados · `/settings/custom-fields`
- `GET ?entity_type=contract_item` → `[{ "id", "entity_type", "field_name", "field_label", "field_type", "is_required", "is_active", "display_order", "created_at", "values_count" }]`
  orden `entity_type, display_order, created_at`.
  `entity_type` ∈ `client`, `contract`, `contract_item`, `quote`, `quote_item`, `invoice`, `invoice_item`.
  `values_count` = filas del holding con valor no vacío en `custom_fields->>field_name` (`quote` no tiene columna `custom_fields` → 0).
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
| GET | `/settings/companies/:id` | VIEW | `Company` + `"usage": { "contracts", "invoices", "period_events", "bank_movements", "subscriptions", "other" }`, `"can_delete": bool` |
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
    { "key": "deferred",     "label": "Ingresos diferidos",     "code": "2.2.05", "name": "Deferred Revenue",  "external_code": null },
    { "key": "unbilled",     "label": "Ingresos por facturar",  "code": "1.1.03", "name": "Unbilled Revenue",  "external_code": null },
    { "key": "revenue",      "label": "Ingresos",               "code": "4.1.01", "name": "Revenue",           "external_code": "400100" },
    { "key": "fx_difference","label": "Diferencia de cambio",   "code": null,     "name": null,                "external_code": null } ] }
```
- `configured`: hay fila en `company_account_mappings`. Sin fila, `code`/`name` vienen `null` (no se muestran los defaults de la tabla
  como si estuvieran configurados).
- `PUT` (EDIT) body `{ "accounts": [{ "key", "code": 1–50, "name": 1–200, "external_code"?: ≤ 100 | null }] }` con **las 5 claves**, una vez
  cada una → respuesta GET. 400 `Faltan cuentas: fx_difference`, `Cuenta repetida: revenue`, `Clave de cuenta no válida: x`.
- No toca Ingresos/Métricas: los asientos siguen leyendo lo de siempre hasta el OK de D12.

### 3.2 Cuentas bancarias · `/settings/companies/:id/bank-accounts`
`BankAccount`: `{ "id", "company_id", "bank_name", "account_type", "account_number", "currency", "account_holder", "created_at", "in_use" }`
(`in_use` = cargas de cartola con esa cuenta).
- `GET` → `[BankAccount]`; `POST` `{ bank_name 1–100, account_type 1–50 (p. ej. "Cuenta Corriente"), account_number 1–50, currency, account_holder? }` (201);
  `PATCH /:accountId` (cualquiera); `DELETE /:accountId` → 204.
- 409 `Ya existe esa cuenta (banco y número) en esta compañía`; 409 `Esta cuenta tiene 3 cargas de cartola: no se puede eliminar`;
  404 `Cuenta bancaria no encontrada`.

### 3.3 Documentos legales · `/settings/companies/:id/legal-documents`
Bucket **privado** `company-files` (M8). Ruta `<holding_id>/<company_id>/legal/<document_id>/<archivo>`.
`LegalDocument`: `{ "id", "document_name", "document_type", "upload_date", "file_name", "mime_type", "file_size", "uploaded_by_name", "legacy": false, "file_url": null, "created_at" }`
(`legacy: true` = fila antigua sin archivo en Storage; trae su `file_url` si tenía. La descarga de una fila antigua devuelve ese `file_url`).
1. `POST .../legal-documents/upload-url` (EDIT) `{ "file_name", "mime_type", "size" }` → `{ "document_id", "path", "upload_url", "token" }`.
   PDF, PNG, JPG, WEBP, Word, Excel; máx. 20 MB → 400 `Tipo de archivo no permitido`, `El archivo no puede superar 20 MB`.
2. El navegador sube a `upload_url`.
3. `POST .../legal-documents` (EDIT) `{ "document_id", "path", "document_name" 1–200, "document_type" 1–100, "file_name", "mime_type" }` → `LegalDocument` (201).
   400 `La ruta del archivo no corresponde a esta compañía`; 400 `El archivo no se subió: vuelve a intentarlo`.
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
  409 `Ya está cerrado hasta el 31-08-2026`; 409 `No se puede cerrar antes del cierre actual (31-08-2026): para retroceder, reabre desde el mes que necesitas`.
- `POST .../periods/reopen` (**CLOSE_PERIODS**) `{ "from_date": "2026-07-01", "reason": "≥ 10" }` → respuesta GET; nuevo cierre = `from_date − 1 día`.
  400 `La fecha de reapertura debe ser el día 1 de un mes`; 409 `No hay períodos cerrados para reabrir`;
  409 `Julio 2026 ya está abierto (cerrado hasta 30-06-2026)`.
- Una transacción que escribe `accounting_period_cutoff` (upsert) y `accounting_period_events` con los mismos datos que
  `close_period_until`/`reopen_period_from` (`performed_by`, `_name`, `_email` del usuario de la sesión). Los triggers de bloqueo de período
  no cambian.

## 4. Usuarios · `/settings/users`
(Invitar, reenviar, desactivar y eliminar invitación: al final del bloque, D5/D6.)
- `GET` (VIEW) → miembros del holding activo (`user_holdings`):
  ```json
  [{ "id": "uuid", "name": "Ana", "email": "ana@…", "status": "Activo|Pendiente|Inactivo", "access_active": true,
     "last_access": "…", "last_invitation_sent_at": "…", "role": { "id": "uuid", "name": "Finanzas" } | null,
     "is_super_admin": false, "is_self": false }]
  ```
  Los super admin no aparecen salvo que quien consulta sea super admin. `role` es `null` si el rol no es de este holding.
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
`ADMIN_FULL_ACCESS`) **solo para super admin**; para el resto es `[]`.

### Roles · `/settings/roles`
`Role`: `{ "id", "name", "description", "is_default", "users_count", "permissions": ["VIEW_CLIENTES", …], "created_at" }`.
- `GET` (VIEW) → `[Role]` (por defecto primero, luego por nombre). `GET /:id` → `Role`.
- `POST` (EDIT) `{ "name": 1–100, "description"?: ≤ 300, "permissions": ["CODE", …] }` → `Role` (201).
- `PATCH /:id` (EDIT) `{ name?, description?, permissions? }` → `Role` (reemplaza la lista completa).
- `DELETE /:id` (EDIT) → 204.
- `POST /:id/duplicate` (EDIT) `{ "name"?: texto }` (por defecto `"<nombre> (copia)"`) → `Role` (201). Si el rol original tiene
  `ALL_PERMISSIONS` y quien duplica no es super admin, la copia recibe **todos los códigos visibles** explícitos en lugar del comodín.
- Errores: 409 `Los roles por defecto no se editan: duplícalo para personalizarlo` / `… no se eliminan`;
  409 `Ya existe un rol con ese nombre`; 409 `El rol tiene 3 usuarios: asígnales otro rol antes de eliminarlo`;
  400 `Permiso no válido: X` (no existe o es interno y no eres super admin);
  409 `El holding quedaría sin nadie que pueda editar la configuración`; 404 `Rol no encontrado`.

### Alertas del rol · `/settings/roles/:id/alerts`
- `GET` (VIEW) →
  ```json
  { "role_id": "uuid", "alerts": [
    { "type": "salesforce_staging_blocked", "label": "Importación de Salesforce bloqueada", "enabled": true },
    { "type": "salesforce_sync_failure", "label": "Falla de sincronización de Salesforce", "enabled": false },
    { "type": "invoice_odoo_failure", "label": "Falla de envío de factura al ERP", "enabled": true } ] }
  ```
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
- `DELETE /:id` → 204 solo si nunca se usó (contratos, cotizaciones, precios, facturas, suscripciones) ni está mapeado.
- Errores: 409 `Ya existe un producto con el código TMS-01` (único por holding, sin distinguir mayúsculas ni espacios);
  409 `El producto está en uso (12 contratos, 30 cotizaciones): archívalo en vez de eliminarlo`;
  409 `El producto está vinculado con Odoo/Salesforce/Stripe: quita el vínculo en Integraciones o archívalo`;
  409 `El producto está en uso: no se puede cambiar si es recurrente`; 404 `Producto no encontrado`.

## 7. Países · `GET /catalog/countries`
Solo sesión (sin `x-holding-id`). → `[{ "code": "CL", "name_es": "Chile", "name_en": "Chile" }]` (249 países ISO 3166-1 alfa-2, orden por
`name_es`). Tabla `countries` (M7).

## 11. Migraciones que el contrato necesita (sin aplicar)

| # | Archivo | Endpoints que la necesitan |
|---|---|---|
| M2 | `1790760000000-CompanyAccountMappingsFiveAccounts` | `/accounts` |
| M3 | `1790770000000-ProductsStatus` | `/products` |
| M4 | `seed/004-close-periods-permission.sql` + `functions/create_default_roles_for_holding.sql` (asset, no migración: receta "Agregar un permiso al catálogo" de la GUIA) | `CLOSE_PERIODS` para Finanzas (Administrador ya pasa con `ALL_PERMISSIONS`) |
| M7 | `1790780000000-CountriesAndCompanyCountryCode` | `/catalog/countries`, compañías, árbol |
| M8 | `1790790000000-CompanyLegalDocumentsStorage` | documentos legales |
| M9 | `1790800000000-RolesIsDefault` | roles, permisos de rol |

Orden de aplicación (QA y después prod, cada paso con OK): `migration:run` (M2, M3, M7, M8, M9) → `postgres:assets --apply --only
seed/004-close-periods-permission.sql` → `--only functions/create_default_roles_for_holding.sql` (marcada para revisión de Domi) →
`schema:snapshot` en prod (los specs de `base-tenancy` y `clientes` quedan rojos hasta entonces) → desplegar la API.

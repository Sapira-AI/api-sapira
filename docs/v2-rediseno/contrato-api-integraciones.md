# Contrato API · Integraciones v2

> 03-10-2026. Fuente: [`spec-integraciones-v2.md`](./spec-integraciones-v2.md) (§5 AJUSTES A1–A10 mandan sobre §2). Código:
> `src/modules/integrations/**`. Todo endpoint va con `SupabaseAuthGuard` + `HoldingScopeGuard` (header `x-holding-id`) +
> `RequirePermissionGuard`. Las rutas viejas (`/odoo/*`, `/salesforce/*`, `/stripe/*`, `/bigquery/*`, `/bigquery-connections/*`,
> `/invoices/scheduler/*`) **no cambian**: las usa la app actual hasta el switch.

## 0. Reglas comunes

- **Holding**: solo lo del holding del header y solo si el usuario es miembro activo. Sin header → `400 { message: 'Falta el holding activo (header x-holding-id)' }`;
  holding ajeno → `403 { message: 'No tienes acceso a este holding' }`; registro de otro holding (corrida, mapeo, vendedor) → `404`.
- **Permisos**: `VIEW_INTEGRACIONES` para leer, `EDIT_INTEGRACIONES` para cambiar (`EDIT` incluye `VIEW`; `ALL_PERMISSIONS` y super admin pasan).
  Sin permiso → `403 { message: 'No tienes permiso para ver las integraciones · pídeselo a un administrador' }` (o "configurar las integraciones").
- **Mapeo de campos (A1, ajuste 1 de Domi)**: es un objeto de mapeo más (`/mappings/fields`, §5). Verlo pide `VIEW_INTEGRACIONES`;
  cambiarlo pide `EDIT_INTEGRACIONES` **y** ser super admin o tener el rol **Admin Técnico** del holding. Si no →
  `403 { message: 'Solo un super admin o el Administrador técnico pueden cambiar el mapeo de campos' }`.
- **Validación** → `400 { message, errors: [{ field, message }] }` (pipe global; campos desconocidos se rechazan). Mensajes en español.
- **Conflicto** → `409 { message, errors?: [{ field, message }] }` (p. ej. sincronización en curso o borrado con impacto).
- **Sin claves**: ninguna respuesta devuelve una clave, contraseña, token ni credencial. Las claves se escriben y se informan como
  `{ has_secret: boolean, secret_last4: string | null }`.
- **Tipos** (`:tipo`): `erp` · `crm` · `stripe` · `datos`. Otro valor → `404 { message: 'Integración no encontrada' }`.
  Sistemas: `erp` → Odoo, `crm` → Salesforce, `stripe` → Stripe (categoría visible **"Invoices y suscripciones"**; no se llama "Pagos":
  el cobro con pasarela es otra función futura; en Stripe se dice **invoice**, no factura), `datos` → BigQuery.
  Dentro de Integraciones sí se nombra el sistema (D2); el resto de la app sigue diciendo ERP/CRM.
- **Stripe con varias cuentas por holding** (`stripe_connections` ya lo admite; caso SimpliRoute): su conexión va por cuenta en
  `/integrations/stripe/connections[/:id]` (§2.6); las rutas `/integrations/stripe/connection*` (singular) responden `404`.
- **Fechas**: timestamps ISO 8601; filtros `from`/`to` = `YYYY-MM-DD` inclusivos.
- **Paginado**: `{ data, total, currentPage, pages, limit }` (+ campos extra cuando se indica). `page` (1) · `limit` (20, ≤ 100).
- **Ids de corrida**: `<origen>:<id>` (p. ej. `erp-send:7f…`, `crm-job:salesforce-daily-sync:production:2026-10-03`; orígenes: `erp-send`, `erp-import`, `crm-job`, `crm-run`, `stripe-ingest`, `stripe-import`, `datos-load`, `datos-manual`). El front los
  pasa con `encodeURIComponent` en `/runs/:id`.

### Recursos comunes

```jsonc
// Ref: un elemento de un lado del mapeo (Sapira o el sistema)
{ "id": "string", "label": "string", "meta": { } }

// Run (historial unificado, D8)
{
  "id": "erp-send:6b1f…", "tipo": "erp",
  "kind": "export_invoices",          // ver tabla §3.3
  "kind_label": "Envío de facturas al ERP",
  "trigger": "automatic",              // automatic | manual
  "status": "completed",               // running | completed | partial | failed | cancelled
  "started_at": "2026-10-03T12:00:04.120Z", "finished_at": "2026-10-03T12:01:10.002Z", "duration_ms": 65882,
  "totals": { "total": 34, "ok": 0, "unchanged": 33, "errors": 1, "skipped": 33 }, // skipped = unchanged (nombre anterior)
  "error": null,                       // mensaje de la corrida si falló completa
  "metrics": { }                       // propio de cada adaptador (p. ej. datos: periodos, filas nuevas/cambiadas)
}

// Record (estado de sincronización, A2)
{
  "id": "odoo_partners_stg:812",        // clave estable del registro
  "object": "customer", "object_label": "Cliente",
  "label": "Acme SpA",                  // nombre legible
  "sapira_id": "uuid | null", "external_id": "4512 | null",
  "status": "ready",                    // pending | ready | error | imported | synced | discarded | excluded_by_rule
  "excluded_rule": null,                // nombre de la regla cuando status = excluded_by_rule
  "status_label": "Listo para importar",
  "message": "texto | null",            // motivo del error o nota
  "last_sync_at": "2026-10-02T11:00:00Z"
}
```

Estados (`status`): `pending` "Pendiente" · `ready` "Listo para importar" · `error` "Con error" · `imported` "Importado" (llegó a Sapira) ·
`synced` "Sincronizado" (salió de Sapira al sistema) · `discarded` "Descartado" (no se quiere importar; ajuste 3 de Domi) ·
`excluded_by_rule` "Excluido por regla" (cumple una regla de exclusión, §6.5).
Tabla de equivalencias por tabla intermedia en §4.

## 1. Resumen · `GET /integrations` (VIEW)

Una fila por tipo, siempre las cuatro (conectadas o no). Los números de registros salen de la **misma consulta** que los KPIs
de `records` (§3.4) con el período por defecto del 360 (`records_from` = hoy − 7 días) y las mismas exclusiones (descartados y reglas):
la lista y el 360 cuadran. `stripe`: `connected` = hay al menos una cuenta; agrega
`accounts: [{ id, name, active, mode }]`.

```jsonc
{
  "data": [
    {
      "tipo": "erp", "label": "ERP", "description": "Facturas y clientes con tu sistema contable",
      "system": "odoo", "system_label": "Odoo",            // null si no está conectada
      "available_systems": [{ "key": "odoo", "label": "Odoo" }],
      "connected": true, "active": true,
      "direction": "both", "direction_label": "Exporta e importa", // import | export | both
      "last_sync_at": "2026-10-03T12:01:10Z",
      "last_sync_status": "partial",                        // estado de la última corrida o null
      "last_error": { "message": "El ERP rechazó la factura 1234: …", "at": "2026-10-03T12:01:09Z" },
      "errors_7d": 3,                                       // obsoleto: registros con error dentro de corridas de 7 días (no es el KPI)
      "failed_runs_7d": 2,                                  // corridas failed/partial en 7 días → "N sincronizaciones con error" (Historial)
      "pending_mapping": 4,                                 // ver tabla
      "records_from": "2026-09-26",                         // = `from` por defecto del 360 ("Últimos 7 días")
      "records_kpis": { "synced": 20, "error": 0, "review": 0, "ready": 6 }, // = kpis de records?from=records_from
      "records_with_error": 0,                              // = records_kpis.error
      "pending_import": 6,                                  // = records_kpis.ready ("Listos para importar" del 360)
      "next_scheduled_at": "2026-10-04T12:00:00Z",          // null si el programado está apagado
      "href": "/lab/integraciones/erp"
    }
  ]
}
```

| Tipo | `direction` | `pending_mapping` | `next_scheduled_at` |
|---|---|---|---|
| `erp` | `both` (exporta facturas; importa clientes y facturas a revisión) | productos de Sapira sin mapeo usados en contratos activos + compañías con facturas sin compañía del ERP | envío diario de facturas (`INVOICE_SCHEDULER_HOUR`, hora del servidor) |
| `crm` | `import` | productos del CRM vistos en oportunidades sin producto de Sapira + tipos de oportunidad sin tipo de cotización + dueños del CRM sin vendedor | 08:30 America/Santiago |
| `stripe` | `import` | productos de Stripe usados en lo traído sin producto de Sapira (= "Sin mapear" de §5) | `STRIPE_SYNC_HOUR` |

| `datos` | `import` | consumos sin producto (`unmapped`) | `BIGQUERY_SYNC_HOUR` |

Errores: 400/403 comunes.

## 2. Conexión

### 2.1 `GET /integrations/:tipo/connection` (VIEW)

```jsonc
{
  "tipo": "erp", "system": "odoo", "connected": true,
  "id": "uuid", "name": "Odoo producción", "active": true,
  "fields": { "url": "https://acme.odoo.com", "database_name": "acme", "username": "api@acme.com", "subscription_code": null },
  "secrets": { "api_key": { "has_secret": true, "secret_last4": "4F2A" } },
  "last_sync_at": "2026-10-03T12:01:10Z", "created_at": "…", "updated_at": "…"
}
// Sin conexión: { "tipo": "erp", "system": null, "connected": false, "id": null, "name": null, "active": false, "fields": {}, "secrets": {}, "last_sync_at": null, "created_at": null, "updated_at": null }
```

| Tipo | `fields` | `secrets` |
|---|---|---|
| `erp` | `url`, `database_name`, `username`, `subscription_code` | `api_key` |
| `crm` | `auth_type` (`password` \| `client_credentials`), `login_url`, `username`, `client_id`, `instance_url`, `has_valid_token` | `client_secret`, `password`, `security_token` |
| `stripe` | `mode` (`test` \| `live`), `publishable_key` | `secret_key` |
| `datos` | `project_id`, `dataset_id`, `client_email` (de la cuenta de servicio) | `credentials` (`secret_last4` = últimos 4 de `private_key_id`) |

ERP con varias conexiones guardadas (la app actual lo permite): se usa la más reciente activa (la misma regla que usa el envío).

### 2.2 `PUT /integrations/{erp|crm|datos}/connection` (EDIT)

Alta o edición. **Las claves son solo de escritura**: si no vienen, se conserva la guardada; en el alta son obligatorias.
Respuesta: la conexión enmascarada (§2.1). Errores: 400 validación (`errors[]`), 400 `Falta la clave …` en el alta.

| Ruta | Body |
|---|---|
| `PUT /integrations/erp/connection` | `{ name: string (≤120), url: url, database_name: string, username: string, api_key?: string, subscription_code?: string \| null }` |
| `PUT /integrations/crm/connection` | `{ auth_type: 'password' \| 'client_credentials', login_url?: url, client_id: string, client_secret?: string, username?: string, password?: string, security_token?: string }` (`username`, `password` y `security_token` exigidos con `password` en el alta) |
| `POST /integrations/stripe/connections` | `{ name: string, mode: 'test' \| 'live', secret_key?: string, publishable_key?: string \| null }` (`secret_key` debe empezar con `sk_test_`/`rk_test_` en `test` y `sk_live_`/`rk_live_` en `live`) |
| `PUT /integrations/datos/connection` | `{ name: string, project_id: string, dataset_id?: string \| null, credentials?: string }` (`credentials` = JSON de la cuenta de servicio; se valida que sea JSON con `client_email` y `private_key`) |

CRM: guardar deja la conexión **inactiva hasta probarla** (regla de siempre: `POST …/test` la valida y la activa).

### 2.3 `POST /integrations/:tipo/connection/test` (EDIT)

Prueba **real** contra el sistema con las credenciales guardadas. Siempre 200 (el resultado es un dato); 404 si no hay conexión.

```jsonc
{ "ok": true, "tested_at": "2026-10-03T15:00:00Z", "message": "Conexión correcta", "details": { "version": "17.0", "companies": 3 } }
{ "ok": false, "tested_at": "…", "message": "El ERP rechazó las credenciales", "details": { "error": "…" } }
```

| Tipo | Qué prueba |
|---|---|
| `erp` | `common.version` + `authenticate` por XML-RPC + `res.company.search_count` |
| `crm` | autenticación guardada (SOAP o client credentials) — `SalesforceService.validateStoredCredentials`; si funciona, deja la conexión activa con token nuevo |
| `stripe` | `balance.retrieve` con la `secret_key` guardada (lectura mínima autenticada) |
| `datos` | `getDatasets` con las credenciales guardadas |

### 2.4 `PATCH /integrations/:tipo/connection/active` (EDIT)

Body `{ active: boolean }` → conexión enmascarada. 404 sin conexión. Pausar detiene la corrida programada y "Sincronizar ahora" de ese holding.

### 2.5 `DELETE /integrations/:tipo/connection?confirm=true` (EDIT)

Sin `confirm=true` y con impacto → `409 { message: 'Eliminar la conexión detiene …', errors: [{ field, message }] }`, p. ej.
`[{ field: 'invoices_pending', message: '12 facturas por enviar al ERP' }, { field: 'mappings', message: '34 productos mapeados (se conservan)' }]`.
Sin impacto o con `confirm=true` → `204`. Los mapeos **se conservan** (son del holding, no de la conexión). 404 sin conexión.

### 2.6 Stripe: cuentas · `/integrations/stripe/connections`

| Método y ruta | Permiso | Body / respuesta |
|---|---|---|
| `GET /integrations/stripe/connections` | VIEW | `{ data: ConnectionView[] }` (una por cuenta, enmascaradas) |
| `POST /integrations/stripe/connections` | EDIT | `{ name (único por holding), mode: 'test' \| 'live', secret_key, publishable_key? }` → `ConnectionView` (201) |
| `GET /integrations/stripe/connections/:id` | VIEW | `ConnectionView` · 404 si es de otro holding |
| `PUT /integrations/stripe/connections/:id` | EDIT | `{ name, mode, secret_key?, publishable_key? }` (clave solo de escritura; al cambiar de modo hay que escribirla) |
| `POST /integrations/stripe/connections/:id/test` | EDIT | `ConnectionTestResult` (`balance.retrieve` con la clave de esa cuenta) |
| `PATCH /integrations/stripe/connections/:id/active` | EDIT | `{ active }` → `ConnectionView` |
| `DELETE /integrations/stripe/connections/:id?confirm=true` | EDIT | 204 / 409 con impacto (registros traídos de esa cuenta, importaciones en curso) |

- `POST /integrations/stripe/sync` lleva `{ connection_id?, date_from?, date_to? }`: sin `connection_id` solo si hay una sola cuenta activa
  (si hay varias → 400 `errors: [{ field: 'connection_id' }]`). El lock es por cuenta (ingesta) y por holding (importación).
- `records` de Stripe trae `account: { id, name }` (cuenta de origen) y acepta `account_id` como filtro. Las corridas de ingesta traen
  `metrics.account_id` / `metrics.account_name`.
- Importar (`StripeSyncService.syncAll`) procesa lo listo de **todas** las cuentas del holding.

## 3. Día a día

### 3.1 `POST /integrations/:tipo/sync` (EDIT) · Sincronizar ahora (D9)

Body opcional `{ date_from?: 'YYYY-MM-DD', date_to?: 'YYYY-MM-DD' }` (solo `stripe` y `datos`; por defecto los últimos 2 días / el mes en curso;
ambas fechas inclusivas; en `datos` van las dos o ninguna, si no 400).
→ `202 { run_id, status: 'running', message }`.

| Tipo | Qué corre | Lock (409 "Ya hay una sincronización en curso") |
|---|---|---|
| `erp` | Envío de facturas pendientes del holding al ERP (`InvoiceSchedulerService.startSchedulerJob`, real, no simulación) | job `pending`/`running` del holding o de la corrida global (`all`) iniciado hace < 3 h |
| `crm` | Corrida diaria del holding (`syncDailyModifiedOpportunities`: oportunidades ganadas de la ventana → revisión → Sapira, solo inserción) | corrida diaria global `running` (lease 3 h), corrida manual del holding `running`, o ejecución de oportunidades activa |
| `stripe` | Ingesta de una cuenta de Stripe a revisión (`StripeIngestionService.syncAll`) | ingesta `running` del holding (< 2 h) o importación `running` |
| `datos` | Cargas de consumos (`BigQueryService.syncSapiraQuantities`: ingesta + integración) | corrida manual del holding en curso (lock en memoria de la réplica) |

Errores: `400 { message: 'La integración no está conectada' }` / `'La integración está pausada'`; `409` en curso.

### 3.2 `GET /integrations/:tipo/runs` (VIEW) · Historial (D8, A7)

Query: `page`, `limit`, `status` (lista `a,b` o repetido: running\|completed\|partial\|failed\|cancelled; p. ej. `status=failed,partial`),
`kind`, `trigger`, `from`, `to`.

**Estado y conteos (ajuste de Domi 03-10, todos los tipos)**: `totals.ok` = se creó o actualizó algo; `totals.unchanged` = procesado
bien sin nada que hacer (omitido, ya existía, sin cambios; `skipped` = mismo valor, por compatibilidad); `totals.errors` = falló.
Lo sin cambios cuenta como correcto. `completed` "Correcta" = sin errores (aunque todo sea sin cambios) · `partial` "Con errores" =
al menos un error y algo bien o sin cambios (o la corrida se cortó después de procesar registros) · `failed` "Falló" = la corrida no
pudo ejecutarse o terminó por una excepción sin procesar registros, o **todos** los procesados fallaron. Ej.: 0 bien · 1 con error ·
33 sin cambios → `partial`. Por tipo: CRM diaria/manual `unchanged` = oportunidades revisadas − cotizaciones creadas/actualizadas −
errores (`success: false` de la corrida = corte); ejecuciones del CRM = ítems − completados − con error; ERP envío = facturas omitidas;
Stripe importación = `stats.*.skipped`; datos = filas sin integrar ni error.
→ `{ data: Run[], total, currentPage, pages, limit }`, más nueva primero.

### 3.3 `GET /integrations/:tipo/runs/:id` (VIEW)

→ `Run & { records: RunRecord[], errors_summary: [{ message, count }] }` con
`RunRecord = { object, label, sapira_id, external_id, status: 'ok' | 'error' | 'skipped', message }`. 404 si no existe o es de otro holding.

| Tipo | `kind` | Fuente (sin tabla nueva) |
|---|---|---|
| `erp` | `export_invoices` "Envío de facturas al ERP" (lee Mongo directo; sirve con la versión actual y con la de la rama de Leon, que crea un job por holding) | `invoice_scheduler_jobs` (Mongo): corridas del holding + corridas globales `all` **filtradas a las facturas del holding**; sin simulaciones. Es el reporte de `/invoices/scheduler/report` simplificado (A7): totales, errores distintos y factura por factura (folio, cliente, compañía, id en el ERP, error) |
| `erp` | `import_invoices` "Importación de facturas del ERP" | trabajo en memoria de `InvoiceProcessingService` (solo mientras vive el proceso; sale en la lista y en `/runs/:id`; 409 si hay otra en curso) |
| `crm` | `crm_daily` "Sincronización diaria" | `salesforce_scheduler_jobs` (Mongo) con el resultado del holding + `salesforce_sync_logs` (eventos `opportunity` con error) |
| `crm` | `crm_manual` "Sincronización manual" | igual, corrida creada por `POST /sync` (`jobId = salesforce-holding-sync:<entorno>:<holding>:<uuid>`) |
| `crm` | `crm_staging` / `crm_import` / `crm_retry` | `salesforce_sync_runs` + `salesforce_sync_run_items` (error por oportunidad) |
| `stripe` | `stripe_ingest` "Ingesta" | `stripe_integration_logs` (Mongo) agrupados por `metadata.batch_id` |
| `stripe` | `stripe_import` "Importación a Sapira" | `stripe_sync_jobs` (`errors[]` por registro) |
| `datos` | `datos_load` "Carga de consumos" | `sapira_quantity_imports` agrupado por hora de `synced_at` (§3.6) |

### 3.4 `GET /integrations/:tipo/records` (VIEW) · Estado de sincronización (A2, A4)

Query: `object`, `status` (lista `a,b`; **sin `status` no vienen los `discarded` ni los `excluded_by_rule`**: se ven con
`status=discarded` / `status=excluded_by_rule`, y `rule=<nombre>` filtra por regla), `from`, `to`
(fecha de última sincronización), `search` (nombre o id, ≤ 120), `page`, `limit`.
Orden: primero lo **no importado** (`error` → `ready` → `pending`), después `imported`/`synced`/`discarded`; dentro de cada grupo, la
última sincronización más nueva primero (ajuste 4: en el CRM se muestran arriba las oportunidades sin importar y abajo las importadas).
Reglas del tipo (§6.1) se aplican al leer: en `erp · erp_invoice`, con `exclude_sapira_invoices` (por defecto `true`) no se listan
las facturas del ERP que nacieron en Sapira (`odoo_id` = `invoices.odoo_invoice_id` de una factura del holding).

```jsonc
{
  "kpis": { "synced": 120, "error": 3, "review": 3, "ready": 12, "pending": 15, "discarded": 4, "excluded_by_rule": 9 },
  "rules": [{ "id": "…", "name": "Suscripciones automáticas de Stripe", "count": 9 }],
  "objects": [{ "key": "customer", "label": "Cliente", "direction": "import", "count": 40 }],
  "data": [ Record ], "total": 138, "currentPage": 1, "pages": 7, "limit": 20
}
```

Cuatro grupos **disjuntos** (tarjetas del 360) y el `status` que filtra exactamente lo que cuenta cada uno (también con `object`,
`account_id`, `from`/`to` y `search`): `synced` = `imported,synced` · `error` = `error` · `review` "Por revisar" = `pending` ·
`ready` "Listos para importar" = `ready`. `synced + error + review + ready = total` sin `status`. `kpis.pending` (= `pending + ready`)
queda por compatibilidad; no usarlo en tarjetas. Descartados y excluidos no suman en los demás.

| Tipo | `object` | Tabla | `sapira_id` / `external_id` |
|---|---|---|---|
| `erp` | `invoice` "Factura enviada" (exporta) | `invoices` del holding (no canceladas, emitidas o por emitir) + alerta abierta `invoice_odoo_failure` como error | id de la factura / `odoo_invoice_id` |
| `erp` | `erp_invoice` "Factura del ERP" | `odoo_invoices_stg` | — / `odoo_id` |
| `erp` | `customer` "Cliente del ERP" | `odoo_partners_stg` | — / `odoo_id` |
| `crm` | `opportunity` "Oportunidad" | `salesforce_opportunities_stg` | cotización creada (`quotes.salesforce_opportunity_id`) / id del CRM |
| `crm` | `account` "Cuenta" | `salesforce_accounts_stg` | — / id del CRM |
| `stripe` | `customer` · `subscription` · `invoice` | `stripe_{customers,subscriptions,invoices}_stg` | — / id de Stripe (+ `account`) |
| `datos` | `consumption` "Consumo" | `sapira_quantity_imports` (sin `no_quantity_data` ni `not_variable`; `pending` = `ready`, lo importa la integración) | `quantity_id` / `sf_id · product · billing_date` |

### 3.5 `POST /integrations/:tipo/records/import` (EDIT) · Importar a Sapira (A4)

Body `{ object: string, ids?: string[] (1–500, los `external_id`), all?: boolean, period?: 'YYYY-MM' }` (`ids` o `all: true`).
→ `202 { run_id: string | null, status: 'running' | 'completed', message, accepted: number }`.

| Tipo · objeto | Proceso existente | `ids` |
|---|---|---|
| `erp · customer` | `PartnersProcessorService.processPartners` con el mapeo de campos activo `res.partner` del holding (400 si no hay: "Falta configurar el mapeo de campos de clientes (Avanzado)") | sí |
| `erp · erp_invoice` | `InvoiceProcessingService.startAsyncProcessing` (todas las listas) | no (`all`) |
| `crm · opportunity` | ejecución `process_final` (`SalesforceSyncRunService.createRun`); con `all` toma las elegibles `create`/`update` | sí |
| `crm · account` | `processAccountsStaging` | sí |
| `stripe · *` | `StripeSyncService.syncAll` (clientes → suscripciones → facturas) | no (`all`) |
| `datos · consumption` | `integrateSapiraQuantities({ retryFailed: true, range })`: `range` = el mes de `period`, o sin `period` todos los meses con consumos por importar o reintentables | no (`all` + `period` opcional) |

Errores: 400 objeto inválido / `ids` no soportado / nada que importar; 409 corrida en curso.

### 3.5 bis `POST /integrations/:tipo/records/discard` · `POST /integrations/:tipo/records/restore` (EDIT)

Body `{ object: string, ids: string[] (1–500, los `external_id` del registro), reason?: string (≤ 200) }` → `{ updated: number }`.
Descartar marca registros que **no se quieren importar** (uno a uno; para patrones, reglas §6.5): salen de la lista por defecto y de los KPIs, y "Importar" (§3.5) los
excluye —igual que a los `excluded_by_rule`— cuando el proceso acepta ids (`erp · customer`, `crm · opportunity`, `crm · account`;
con `all: true` se calculan las ids elegibles sin descartados ni excluidos). Restaurar los devuelve a su estado real. No se toca la tabla intermedia ni su `processing_status`
(tienen CHECK y los reescribe la integración en cada carga): se guarda en la tabla nueva `integration_record_discards` (§8).
Objetos cuyo proceso no acepta ids (`erp · erp_invoice`, `stripe · *`, `datos · consumption`): el descarte se ve en la lista, pero
el proceso de importación existente **no lo respeta todavía** → Leon (cambio de integración).
Errores: 400 objeto inválido; ids que no existen en el holding se ignoran (`updated` cuenta solo los reales).

### 3.6 Almacén de datos · cargas (A6)

Las cargas salen en `GET /integrations/datos/runs` (`kind: datos_load`) con `metrics`:
`{ periods: ['2026-09', '2026-10'], rows: 412, new_rows: 380, changed_rows: 32, changed_after_import: 2, unmapped: 5, errors: 7 }`.
Una carga = filas con `synced_at` en la misma hora. "Cambió respecto de la carga anterior" = fila que ya existía (`created_at` anterior) y
el almacén de datos la modificó. Las filas que llegan idénticas no actualizan `synced_at`, así que no cuentan en la carga.
"Sin producto" = `unmapped`; la acción para resolverlos sigue en Facturación (reprocesar).

## 4. Equivalencia de estados (tablas intermedias → `status`)

| Valor en la tabla | `status` |
|---|---|
| `create`, `update`, `to_create`, `to_update` | `ready` |
| `processed`, `no_change`; datos `integrated` | `imported` |
| `error`, `invalid`; datos `unmapped`, `currency_mismatch`, `blocked`, `ambiguous`, `conflict`, `changed_in_source` | `error` |
| `pending`, `NULL`, otro | `pending` |
| registro en `integration_record_discards` (manda sobre todo) | `discarded` |
| cumple una regla de exclusión activa (§6.5; manda sobre lo de la tabla, no sobre el descarte) | `excluded_by_rule` |
| datos: `integrated` = integrado, `pending` = listo para importar (`ready`), `unmapped` = sin producto (error con mensaje), resto de errores = error | — |
| ERP `invoice` con `odoo_invoice_id` o `sent_to_odoo_at` | `synced`; con alerta `invoice_odoo_failure` abierta → `error`; si no → `pending` |

## 5. Mapeos (A2)

Forma común. `anchor` dice qué lado lista las filas (el otro puede venir `null`).

### 5.0 Filas por origen (ajuste de Domi 03-10)

Las filas de un mapeo salen del lado que **origina** el dato:

- **Importa a Sapira** (`stripe · products`, `crm · products`, `crm · quote_types`, `crm · owners`): `anchor: 'external'`, una fila por
  elemento del sistema que se usa (o ya mapeado) → a qué corresponde en Sapira. Lo de Sapira sin contraparte no aparece ni cuenta como
  sin mapear. `usage` = cuánto lo usa el sistema (suscripciones/invoices de Stripe, oportunidades del CRM).
- **Exporta desde Sapira** (`erp · companies`, `erp · products`): `anchor: 'sapira'`, una fila por elemento de Sapira **que se usa en lo
  que se envía** (compañías con facturas no canceladas o contratos activos; productos en contratos activos o en facturas por emitir o ya
  enviadas) o ya mapeado. Lo que no se usa queda fuera de la vista. `usage` = facturas/contratos que dependen del mapeo.
- `fields`: sin cambio.

### 5.1 `GET /integrations/:tipo/mappings/:objeto` (VIEW)

Query: `status` (`mapped` \| `unmapped` \| `suggested`), `search`.

```jsonc
{
  "object": "products", "object_label": "Productos", "anchor": "sapira",
  "external_available": true, "external_error": null,   // false + mensaje si el sistema no respondió (las filas igual llegan, con ids)
  "counts": { "total": 52, "mapped": 48, "unmapped": 3, "suggested": 1 },
  "data": [
    {
      "key": "6c1e…",
      "sapira": { "id": "6c1e…", "label": "Licencia anual", "meta": { "code": "LIC-01", "is_recurring": true } },
      "external": { "id": "42", "label": "[LIC] Licencia", "meta": { "code": "LIC", "category": "Software" } },
      "status": "mapped",
      "suggestion": null,                               // Ref cuando status = suggested
      "usage": { "contracts": 7, "invoices_pending": 3 }, // propio de cada objeto
      "meta": { "tax_ids": [1, 5] }                      // datos del mapeo (impuestos en productos del ERP)
    }
  ]
}
```

| Tipo · objeto | `anchor` | Lado Sapira | Lado sistema (opciones) | `usage` | `meta` del mapeo |
|---|---|---|---|---|---|
| `erp · companies` | sapira | `companies` del holding que facturan (o mapeadas) | compañías del ERP (en vivo) | `{ invoices_pending, invoices }` | `{ tax_rate }` |
| `erp · products` | sapira | `products` del holding en uso (o mapeados) | productos del ERP (en vivo, activos) | `{ contracts, invoices_pending }` (contratos activos y facturas por enviar que lo usan: se bloquean sin mapeo) | `{ tax_ids: number[] }` |
| `crm · products` | external | `products` del holding | productos del CRM vistos en oportunidades (`salesforce_line_items_stg`) + los ya mapeados | `{ opportunities, opportunities_waiting }` | — |
| `crm · quote_types` | external | tipos de cotización de Sapira (`new_business`, `upsell`, …) | tipos de oportunidad vistos en el CRM + los ya mapeados | `{ opportunities }` | — |
| `crm · owners` | external (key = id del dueño) | `sellers` del holding | dueños de oportunidades del CRM (`salesforce_opportunities_stg`) + los ya relacionados | `{ opportunities }` | — |
| `stripe · products` | external (N:N: una fila por par, key `<stripe_id>:<sapira_id>`; sin mapear key = `stripe_id`) | `products` del holding | productos de Stripe usados en las suscripciones/invoices traídas + los mapeados (nombre en vivo de cada cuenta activa; si no responde, el id; `meta.account_id`, `meta.account_name`) | `{ subscriptions, invoices }` | — |
| `erp · fields` | sapira | campo destino de cada mapeo activo de `field_mappings` (`id` = `<mapeo>:<sección>:<campo>`, `meta: { source_model, target_table, section }`) | campo del ERP (texto) | — | `{ transformation }` |
| `crm · fields` | sapira | campo de Sapira por objeto de `salesforce_field_mappings` (`id` = `<object_type>.<campo>`, `meta: { object_type, mapping_id, is_required, is_active }`) | campo del CRM (texto) | — | `{ transformation_key }` |

`fields` (ajuste 1): GET con VIEW; PUT/DELETE con EDIT + super admin o Admin Técnico. Se editan solo el campo de origen y la
transformación; la lógica que aplica el mapeo no cambia. `GET …/fields/options` devuelve los campos de origen ya usados (no hay
catálogo en vivo).

Sugerencias automáticas y deterministas: mismo código/SKU o nombre normalizado (sin mayúsculas, tildes ni signos); en `owners`, mismo
correo o el correo técnico `sf_<id>@salesforce.local`; en `crm · quote_types`, la equivalencia de tipos de Cotizaciones (`normalizeQuoteType`).

### 5.2 `GET /integrations/:tipo/mappings/:objeto/options` (VIEW)

Query `side` (`external` por defecto \| `sapira`), `search`. → `{ data: Ref[], available: boolean, error: string | null }`.

### 5.3 `PUT /integrations/:tipo/mappings/:objeto` (EDIT)

Body `{ items: [{ sapira_id: string, external_id: string, meta?: object }] }` (1–200). Acciones en lote = varios ítems.
→ mismo cuerpo que el GET. Errores: 400 (`items.N.sapira_id` no es del holding, `external_id` no existe en las opciones cuando se
pueden consultar, `meta.tax_ids` inválido), 404 objeto.

Reglas: ERP compañías y productos son 1:1 (reasignar limpia el anterior, como hoy); CRM productos N:1 (varios del CRM → uno de
Sapira); CRM `owners` 1:1 (`sellers.crm_owner_id` único por holding); Stripe N:N.

### 5.3 bis `POST /integrations/:tipo/mappings/:objeto/accept-suggestions` (EDIT)

Body opcional `{ keys?: string[] (≤ 500) }` (sin `keys` = todas las filas `suggested`). Acepta las sugerencias **deterministas** de §5.1
(código/SKU, nombre normalizado, correo en vendedores) con las mismas reglas del PUT. `fields` no tiene sugerencias.
→ `{ accepted: number, view: MappingView }`. Para `erp · products` las sugerencias aceptadas quedan **sin impuestos** (se completan
después en la fila). Roadmap (bloque de agentes): asistente IA que tras el primer sync propone mapeos y reglas (referencia DualEntry).

### 5.4 `DELETE /integrations/:tipo/mappings/:objeto?sapira_id=&external_id=&confirm=true` (EDIT)

Quita un mapeo. Productos y compañías del ERP con uso y sin `confirm=true` → `409 { message: 'Quitar este mapeo bloquea el envío al ERP', errors: [{ field: 'contracts', message: '7 contratos activos lo usan' }, { field: 'invoices_pending', message: '3 facturas por enviar' }] }`.
OK → `204`. 404 si el mapeo no existe.

### 5.5 `GET /integrations/erp/taxes` (VIEW)

Query `company_id` (UUID de la compañía de Sapira, mapeada) **o** `erp_company_id` (número). → `{ company: { id, label }, data: [{ id, label, amount, amount_type, use: 'sale' | 'purchase' | 'none', active }] }`.
400 si la compañía no está mapeada; 502 `{ message: 'El ERP no respondió' }` si falla la consulta.

## 6. CRM

### 6.1 `GET /integrations/:tipo/settings` (VIEW) · `PUT` (EDIT) · reglas por tipo (ajuste 3)

```jsonc
// crm
{
  "tipo": "crm",
  "auto_sync": true,   // corrida automática habilitada (holding_integration_settings.auto_enabled; fila ausente = true)
  "settings": { "opportunity_stages": ["Ganado", "Closed Won", "Cerrada Win"] },
  "defaults": { "opportunity_stages": ["Ganado", "Closed Won", "Cerrada Win"] },
  "uses_default": { "opportunity_stages": true },
  "schedule": { "daily_at": "08:30", "timezone": "America/Santiago", "window_days": 30, "enabled": true } // solo lectura
}
// erp
{ "tipo": "erp", "settings": { "exclude_sapira_invoices": true }, "defaults": { "exclude_sapira_invoices": true }, "uses_default": { "exclude_sapira_invoices": true }, "schedule": { "daily_at": "09:00", "timezone": "servidor", "enabled": true } }
// stripe, datos: settings {} (sin reglas todavía) + schedule
```

`PUT` body `{ settings: { … } }` con las claves del tipo (`null` en una clave = volver al default). `settings.auto_sync: boolean`
prende o apaga **solo la corrida automática** del holding (el "Sincronizar ahora" sigue): se guarda en `holding_integration_settings.auto_enabled`
(tabla de Leon, ya en QA y producción; `erp` → `odoo`, `crm` → `salesforce`, `stripe` → `stripe`, `datos` → `bigquery`; `stripe` entra a
su CHECK con la migración I2). Hoy solo el envío de facturas al ERP respeta el flag; Salesforce, BigQuery y Stripe → Leon.

| Tipo | Clave | Tipo | Qué hace hoy |
|---|---|---|---|
| `crm` | `opportunity_stages` | `string[]` (1–20, ≤ 80 c/u) | etapas que usa "Traer oportunidades" (§6.3) y su vista previa |
| `erp` | `exclude_sapira_invoices` | `boolean` | filtra en `records` las facturas del ERP nacidas en Sapira |

Se guardan en `holding_integration_settings.settings` (§8): **una sola tabla de ajustes por integración**, la misma fila que
`auto_enabled` (sin fila = defaults y corrida habilitada).
**La corrida diaria del CRM y la importación a revisión siguen con las etapas fijas, y la importación del ERP sigue trayendo todas
las facturas**: aplicar las reglas en la integración es cambio de Leon.

### 6.5 Reglas de exclusión (ajuste de Domi) · `GET/PUT /integrations/:tipo/rules` (VIEW/EDIT)

Reglas por integración y objeto. Un registro que cumple **todas** las condiciones de una regla activa queda `excluded_by_rule`
(no aparece por defecto, no cuenta en los KPIs, no se importa cuando el proceso acepta ids). Se guardan en
`holding_integration_settings.settings.rules` (§8; `integration_configs` no tiene dónde).

```jsonc
{
  "data": [
    {
      "id": "uuid", "name": "Ganadas sin ítems", "object": "opportunity", "enabled": true,
      "conditions": [
        { "field": "line_items_count", "operator": "is", "value": "0" }
      ],
      "matches": 1                       // registros que hoy cumple (solo en el GET)
    }
  ]
}
```

- `operator`: `is` (es) · `is_not` (no es) · `contains` (contiene, sin mayúsculas) · `empty` (vacío) · `not_empty` (no vacío). `value`
  obligatorio salvo en `empty`/`not_empty`. La forma de una sola condición del pedido (`{ objeto, campo, operador, valor, nombre }`) es una
  regla con un elemento en `conditions`; varias condiciones = todas deben cumplirse (caso "identificables por un par de campos").
- `field`: campo calculado (CRM, ver abajo), columna de la tabla intermedia o ruta dentro de `raw_data` con puntos
  (`raw_data.Forma_de_pago__c`, `raw_data.Owner.Name`). Se compara como texto (un número se escribe como texto: `"0"`).
- `PUT` body `{ rules: Rule[] }` (reemplaza la lista; ≤ 50; `id` opcional en las nuevas) → mismo cuerpo que el GET. 400 si el objeto no es
  del tipo, el campo no existe en `rules/fields` o falta `value`. En campos de correo (`owner_email`) el valor se guarda en minúsculas.
- **Ejemplo para SimpliRoute (sin aplicar, pedido de Domi)**: se excluyen las oportunidades ganadas **sin ítems** y las del dueño de
  **marketing**:
  `{ name: 'Ganadas sin ítems', object: 'opportunity', conditions: [{ field: 'line_items_count', operator: 'is', value: '0' }] }` y
  `{ name: 'Dueño marketing', object: 'opportunity', conditions: [{ field: 'owner_email', operator: 'is', value: 'marketing@simplit-solutions.com' }] }`.
  Las oportunidades de la tabla intermedia ya son las de las etapas ganadas (§6.1), así que "ganadas" no necesita otra condición.

`GET /integrations/:tipo/rules/fields?object=` (VIEW) →
`{ object, operators: [{ value, label, needs_value }], data: [{ field, label, sample: string | null, type: 'text' | 'number', computed }] }`:
primero los **campos calculados** del objeto (`computed: true`, con nombre legible), después las columnas de la tabla intermedia y las
claves de `raw_data` (hasta dos niveles, de una muestra de 200 filas) con un valor de ejemplo. Operadores: `is` "es", `is_not` "no es",
`contains` "contiene", `empty` "está vacío", `not_empty` "no está vacío".

| Objeto | `field` | `label` | De dónde sale (`salesforce_opportunities_stg.raw_data`) |
|---|---|---|---|
| `crm · opportunity` | `owner_email` | Correo del dueño | `Owner.Email` (en minúsculas) |
| | `owner_name` | Nombre del dueño | `Owner.Name` |
| | `line_items_count` (`number`) | Cantidad de ítems | largo de `OpportunityLineItems.records` (0 si viene `null`) |
| | `stage` | Etapa | `StageName` |
| | `opportunity_type` | Tipo | `Type` |
| | `payment_method` | Forma de pago | `Forma_de_pago__c` |

### 6.2 `GET /integrations/crm/stages` (VIEW)

Etapas del CRM en vivo (`OpportunityStage`). → `{ data: [{ value, label, is_won, is_closed }], available, error }`.

### 6.3 `POST /integrations/crm/opportunities/fetch` (EDIT) · Traer oportunidades (A5)

Body opcional `{ date_from?: 'YYYY-MM-DD', date_to?: 'YYYY-MM-DD', opportunity_ids?: string[] (≤ 200) }`. **Sin body = el último
mes** (de hoy menos un mes a hoy, por fecha de cierre; ajuste 4). Rango ≤ 366 días. Con `opportunity_ids` se ignora el rango.
Lee del CRM con las etapas configuradas y compara con lo que ya llegó, **sin escribir**. Respuesta ordenada: primero `new` y
`changed` (no importadas o con cambios), después `synchronized`.

```jsonc
{
  "stages": ["Ganado"], "date_from": "2026-09-03", "date_to": "2026-10-03",
  "data": [
    {
      "id": "006…", "name": "Acme · Renovación 2026", "account": "Acme SpA", "close_date": "2026-09-28", "stage": "Ganado",
      "amount": 12000, "currency": "USD", "owner": "Ana Pérez", "type": "Renewal", "line_items": 3,
      "status": "new",                   // new | changed | synchronized
      "reasons": ["La oportunidad todavía no llegó a Sapira"],
      "unmapped_products": [{ "id": "01t…", "name": "Implementación" }],
      "quote_id": null                   // cotización de Sapira si ya existe
    }
  ],
  "total": 1
}
```

Errores: 400 validación; 400 sin conexión; 502 `{ message: 'El CRM no respondió: …' }`.

### 6.4 `POST /integrations/crm/opportunities/import` (EDIT)

Body `{ opportunity_ids: string[] (1–200), mode?: 'full' | 'review' }` (`full` por defecto: revisión + Sapira, ejecución `retry_full`;
`review`: solo a revisión, `update_staging`). → `202 { run_id: 'crm-run:<uuid>', status: 'running', message, accepted }`.
409 si ya hay una ejecución de ese tipo en curso.

## 7. Vendedores del CRM (D7)

### 7.1 Vendedores

- Mapeo: `GET/PUT/DELETE /integrations/crm/mappings/owners` (§5). Guarda `sellers.crm_owner_id`.
- `GET /settings/sellers` agrega `crm_owner_id: string | null` a cada vendedor (superconjunto).
- `POST /settings/sellers/merge` (`EDIT_CONFIGURACION`, en Configuración): body `{ target_id: uuid, source_ids: uuid[] (1–50) }`.
  Reasigna al destino **todas** las referencias a los vendedores origen (hoy la única FK a `sellers` es `quotes.seller_id`; verificado
  en `pg_constraint` de QA el 03-10), copia `crm_owner_id` si el destino no tiene y hay uno solo entre los origen, y borra los origen.
  Transacción con `sapira.writer = 'api'`. → `{ seller: Seller, merged: 2, reassigned: { quotes: 14 } }`.
  Errores: 400 destino incluido en origen; 404 vendedor de otro holding; 409 `{ message: 'Los vendedores tienen dueños distintos del CRM', errors: [{ field: 'source_ids', … }] }` si destino y origen tienen `crm_owner_id` distintos.

### 7.2 Mapeo de objetos del CRM

`salesforce_object_mappings` (cuentas del CRM ↔ objetos de Sapira) no se expone en esta vuelta: sigue en la app actual
(`/salesforce/mappings/objects`). El mapeo de campos sí (§5, `fields`).

## 8. Base de datos (escrita, **sin aplicar**)

| # | Cambio | Archivo |
|---|---|---|
| I1 | `sellers.crm_owner_id text NULL` (comentario) + índice único parcial `sellers_holding_crm_owner_key (holding_id, crm_owner_id) WHERE crm_owner_id IS NOT NULL` | `migrations/1791000000000-IntegrationsV2.ts` |
| I2 | **Sin tabla nueva**: `holding_integration_settings` (de Leon, `1790400000000`, ya en QA y producción; PK `(holding_id, integration)`) agrega `settings jsonb NOT NULL DEFAULT '{}'` y `updated_by uuid NULL`, y su CHECK `holding_integration_settings_integration_check` suma `'stripe'` (`odoo`, `salesforce`, `bigquery`, `stripe`). Tipo → `integration`: `erp` → `odoo`, `crm` → `salesforce`, `stripe` → `stripe`, `datos` → `bigquery`. Entity `base-tenancy/holding-integration-settings.entity.ts` | ídem |
| I3 | Tabla `integration_record_discards` (`id uuid`, `holding_id`, `tipo`, `object`, `record_key text` (= `external_id`), `reason text NULL`, `discarded_by uuid NULL`, `created_at`; UNIQUE `(holding_id, tipo, object, record_key)`; FK holding ON DELETE CASCADE; RLS activada sin políticas) | ídem |

Orden: migración → desplegar la API. `VIEW_INTEGRACIONES` / `EDIT_INTEGRACIONES` ya existen en `permissions` (QA) y en los roles: no hay seed.

## 9. Notificaciones (D11)

- `NotificationView.action` agrega `href` (string \| null): `review_salesforce_sync_log` → `/lab/integraciones/crm?tab=historial`;
  acción nueva `open_integration` `{ tipo, tab }` → `/lab/integraciones/<tipo>?tab=<tab>`. El resto de acciones, `href: null` (las arma el front).
- Catálogo y vista agregan `integration_href` (string \| null): `invoice_odoo_failure` → `/lab/integraciones/erp?tab=mapeos`;
  `salesforce_staging_blocked` → `/lab/integraciones/crm?tab=mapeos`; `salesforce_sync_failure` → `/lab/integraciones/crm?tab=historial`;
  `bigquery_quantities_*` → `/lab/integraciones/datos?tab=estado`.
- Textos: "Integraciones › ERP › Mapeos" para productos sin mapeo (catálogo y `translateErpError`), "Integraciones › CRM › Historial"
  para la falla del CRM. Sin "Odoo"/"Salesforce" en los textos de Integraciones del catálogo.
- Pestañas del 360: `estado` · `mapeos` · `configuracion` · `historial`.

# Cambio: endpoints de Clientes para el rediseño (`/lab/clientes`) + acceso por holding

> **Rama:** `domi` · 22-09-2026 · Domi + Claude
> **Repo front (par):** `front-sapira` — módulo en construcción `app/(protected)/lab/clientes/` (README con el
> mapa pantalla → BFF → endpoint). Guía del laboratorio: `front-sapira/docs/reglas-desarrollo/modulos-en-construccion.md`.

## 👉 Leon: qué necesitamos de ti

1. ~~Validar y correr la migración de condiciones de pago~~ → aplicada el 23-09 en QA y prod según lo acordado
   (ver [Migración](#migración-condiciones-de-pago--aplicada-23-09-qa-y-producción)).
2. **Revisar el acceso por holding** ([Acceso por holding](#acceso-por-holding-clientsholdingscopeguard)): cambia
   el comportamiento de endpoints existentes de `/clients`. Encontramos que ningún endpoint de clientes, razones
   sociales o contactos validaba que el usuario perteneciera al holding pedido.
3. Opcional: decidir si unificamos `ClientsHoldingScopeGuard` con el `HoldingAccessGuard` global.

## Cómo ver el laboratorio

El front de `/lab` está apagado en producción. Para verlo en local con la rama `domi` de ambos repos:

- `front-sapira/.env.local`: `DESIGN_LAB_ENABLED=true` (variable de servidor; sin ella `/lab` y sus rutas BFF
  responden 404).
- Entrar con un usuario **super admin** (permiso interno `VIEW_LAB`) y abrir `http://localhost:8081/lab`.
- `api-sapira` local apuntando a la base de producción ("Sapira MVP"). ⚠️ Crear/editar/asignar en el lab
  **escribe en producción**: probar en el holding Hanka.

## Endpoints nuevos (todos con `SupabaseAuthGuard` + `ClientsHoldingScopeGuard`)

SQL crudo con `DataSource.query`, validado contra producción en solo lectura. Orden por lista blanca.

> Desde el 24-09 todos estos endpoints usan `HoldingScopeGuard`: el holding va en el header `x-holding-id` (no en la
> query ni el body). Regla: `docs/v2-rediseno/autorizacion-y-tenancy.md`. `GET /clients` acepta `holding_id` solo por
> compatibilidad con el front viejo (debe coincidir con el header).

| Endpoint | Para qué | Servicio |
|---|---|---|
| `GET /clients?sort_by&sort_order` | Orden por columna en la lista (nuevo parámetro; `nulls LAST` + `id` para paginación estable) | `ClientsService.findAll` |
| `GET /clients/filter-options` | Valores de segmento, industria, mercado, país y estado | `ClientsService.getFilterOptions` |
| `GET /clients/summary` | KPIs de la lista: MRR del mes, cartera abierta y vencida | `ClientMetricsService` |
| `GET /clients/:id/summary` | Indicadores del cliente | `ClientMetricsService` |
| `GET /clients/:id/receivables` | Cartera por antigüedad (por vencer, 1–30, 31–60, 61–90, +90) | `ClientMetricsService` |
| `GET /clients/:id/invoices?status&client_entity_id&search&sort_by&sort_order&page&limit` | Pestaña Facturas del 360; trae `counts` por estado | `ClientMetricsService` |
| `GET /clients/:id/contracts?status&client_entity_id&search&sort_by&sort_order&page&limit` | Pestaña Contratos del 360 (24-09); `counts` por estado, inicio = primer ítem, MRR del mes (RSM, moneda sistema y contrato) | `ClientMetricsService` |
| `GET /client-entities`, `GET /client-entities/stats` | Lista de razones sociales (filtro "sin cliente asignado", país) | `ClientDirectoryService` |
| `POST /client-entities/assign` | Vincular varias razones sociales a un cliente (transacción; marca principal si no tiene) | `ClientDirectoryService` |
| `GET /client-entities/:id`, `/:id/summary`, `/:id/invoices` | Razón social 360 | `ClientEntityMetricsService` |
| `PATCH /client-entities/:id` | Editar razón social; RUT duplicado = 409 confirmable con `allow_duplicate_tax_id` (en prod hay duplicados legítimos) | `ClientDirectoryService` |
| `GET /client-contacts`, `/stats`, `POST /client-contacts`, `POST /client-contacts/bulk-update`, `PATCH /client-contacts/:id` | Contactos: lista, crear, editar, asignar cliente / cambiar rol en lote | `ClientDirectoryService` |

Criterio de cartera = el de Facturación de la app actual: abiertas = `Emitida | Enviada | Vencida` sumando
`total_system_currency`; vencidas = abiertas con `due_date` < hoy. MRR = `revenue_schedule_monthly` + `mrr_legacy`
(mismas fuentes que el dashboard).

Tablas en que se escribe: `clients`, `client_entities`, `client_entity_clients`, `client_contacts`. No hay cambios
de esquema salvo la migración de condiciones de pago (aplicada el 23-09).

## Acceso por holding (`ClientsHoldingScopeGuard`)

`src/modules/clients/access/`. Se aplica a `ClientsController`, `ClientEntitiesController` y
`ClientContactsController`, después de `SupabaseAuthGuard`:

- Si la petición nombra un holding (`holding_id` en query o body, o header `x-holding-id`), el usuario debe tener
  una fila **activa** en `user_holdings` para él → si no, **403**. Es el mismo criterio con que
  `POST /holdings/select` deja elegir holding (los super admin tienen una fila por holding).
- Deja `request.holdingIds` (seleccionado primero, luego el más antiguo).

**Cambios de comportamiento en endpoints existentes de `/clients`:**

| Endpoint | Antes | Ahora |
|---|---|---|
| `GET /clients` | Devolvía clientes de **todos** los holdings si no venía `holding_id` | Holding del header `x-holding-id` (`HoldingScopeGuard`, 24-09) |
| `GET /clients/:id`, `/:id/with-entities`, `PATCH /:id`, `DELETE /:id`, `/:id/entities*` | Cualquier cliente por id | 404 si el cliente no es del holding activo |
| `POST /clients/:id/entities` | Roto: leía `req.user.holdingId`, que `SupabaseAuthGuard` nunca llena → siempre fallaba la validación | Toma el holding activo |

Único consumidor fuera del front nuevo: el buscador de **clientes comerciales** de Integraciones › Salesforce del
front viejo (`sapira-ai` `SalesforceClientSearchSelect`) → `GET /clients` con `holding_id` en la query **y** el header
`X-Holding-Id` (lo agrega `NestJSApiClient` desde `HoldingContext`). Por eso `QueryClientsDto` conserva `holding_id`
como campo `deprecated` de compatibilidad: el guard exige que coincida con el header y el servicio lo ignora.

**Guard (24-09):** el `ClientsHoldingScopeGuard` local se reemplazó por el guard único `HoldingScopeGuard`
(`src/guards/`), la regla de `docs/v2-rediseno/autorizacion-y-tenancy.md`. `HoldingAccessGuard` queda deprecado.

## Migración: condiciones de pago — ✅ aplicada 23-09 (QA y producción)

`src/databases/postgresql/migrations/1789200000000-AddClientEntityPaymentTerms.ts`.

**Aplicación (23-09, tras merge de `qa` en `domi`)**: `migration:show` en QA y prod → única pendiente →
`migration:run --target qa` → verificado en QA (columna jsonb + CHECK + comentario; un UPDATE con 400 días es
rechazado por el CHECK) → `migration:run --target production` → verificado en prod (1.542 razones sociales
intactas). **Después**, como exige el proceso: columna + `@Check` en la entity promovida `ClientEntity` y
`yarn schema:snapshot --target production` (solo cambió el snapshot de `client_entities`). Código: `payment_terms`
en `UpdateClientEntityDto` (`PaymentTermsDto`, espejo del CHECK), en la lista blanca de `ClientDirectoryService` y en
el detalle `GET /client-entities/:id`. Tests: DTO + servicio. El generador de facturas **todavía no lee** la
condición (sigue `+30`): conectarlo va en la auditoría de contratos (S4 · Medios #11).

- **Qué:** `client_entities.payment_terms jsonb NULL` + CHECK `client_entities_payment_terms_check` + comentario.
- **Por qué (roadmap operativo #11):** hoy el generador usa `emisión + 30 días` para todo; en agosto el SAT rechazó
  13 facturas PPD de TiMining que exigen vencimiento el mes siguiente.
- **Dónde (decisión de Domi):** en `client_entities`, no en `client_entity_clients`. Es el default de la razón
  social; la factura y el contrato copian la regla y pueden sobrescribirla.
- **Forma:** `{"kind":"net","days":30}` · `{"kind":"end_of_month","days":30}` · `{"kind":"day_of_next_month","day":17}`
  (si el mes es más corto, el último día). `NULL` = sin condición propia. El cálculo vive en
  `front-sapira/app/(protected)/lab/clientes/_lib/payment-terms.ts` (con tests).
- **CHECK verificado** en producción con un `SELECT` (sin DDL): acepta las 5 formas válidas y rechaza 5 inválidas
  (días como texto, 400 días, día 0, `kind` desconocido, sin `kind`). Usa `CASE` anidados para no castear antes de
  validar el tipo.

**Orden de despliegue (el que se siguió el 23-09):**

1. Correr la migración (`yarn migration:run`) en QA y luego en producción. Una columna nueva que TypeORM no conoce
   es inofensiva.
2. Después, en otro commit: declarar la columna en `ClientEntity` + `payment_terms` en `UpdateClientEntityDto` y en
   `ClientDirectoryService.ENTITY_FIELDS` + habilitar "Guardar" en la tarjeta del front.

Al revés (código antes que migración), TypeORM seleccionaría una columna inexistente en cada lectura de
`client_entities` y rompería producción.

**Preguntas abiertas:** ¿jsonb con CHECK o columnas separadas (`payment_terms_kind` + `payment_terms_days`)?
¿Conviene un registro en `REGISTRO-ALINEACION.md` al aplicarla? ¿Quién propaga la regla al generador de facturas
(api o RPC de `sapira-ai`)?

## Tests

`clients.service.spec`, `client-metrics.service.spec` (incluye facturas), `client-entity-metrics.service.spec`,
`client-directory.service.spec`, `access/clients-holding-scope.guard.spec`. `jest src/modules/clients
src/databases/postgresql`: 617 en verde.

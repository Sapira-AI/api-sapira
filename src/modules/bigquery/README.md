# Módulo BigQuery

Módulo para integración con Google BigQuery, permitiendo ejecutar consultas SQL y explorar datasets y tablas.

## Características

-   ✅ Ejecución de consultas SQL personalizadas
-   ✅ Listado de datasets disponibles
-   ✅ Listado de tablas por dataset
-   ✅ Autenticación mediante Service Account
-   ✅ Manejo de errores y logging
-   ✅ Documentación Swagger completa
-   ✅ Sincronización automática de clientes Stripe desde BigQuery
-   ✅ Scheduler automático diario configurable
-   ✅ Integración de cantidades variables hacia `quantities`, con tabla intermedia auditable y reproceso
-   ✅ Detección de cambios en el origen (DWH) con notificación de diferencias campo a campo

## Estructura del Módulo

```
bigquery/
├── dtos/
│   ├── query.dto.ts                      # DTO para consultas SQL
│   ├── list-quantity-imports.dto.ts      # Filtros de auditoría del canal de cantidades
│   ├── replace-quantity-record.dto.ts    # DTO para reemplazo de un override de quantities
│   └── sync-stripe-customers.dto.ts     # DTO para sincronización
├── interfaces/
│   ├── bigquery-result.interface.ts     # Interfaces de respuesta
│   ├── project-info.interface.ts        # Info del proyecto
│   └── sapira-quantities-sync-result.interface.ts # Contadores de las 2 fases de cantidades
├── bigquery.controller.ts               # Controlador con endpoints
├── bigquery.service.ts                  # Servicio con lógica de BigQuery
├── bigquery.scheduler.ts                # Scheduler automático diario
├── bigquery.module.ts                   # Definición del módulo
├── bigquery.provider.ts                 # Providers
└── README.md                            # Documentación
```

## Configuración

### 1. Credenciales por holding (fuente de verdad)

Las credenciales de BigQuery se administran por holding en la tabla `bigquery_connections`. Cada consulta se resuelve con la conexión activa del holding indicado, no con una credencial global.

Por ello, todos los endpoints y las sincronizaciones requieren el header `x-holding-id`:

```bash
x-holding-id: <uuid-del-holding>
```

Si el holding no tiene una conexión activa en `bigquery_connections`, la API responde `400` con `No hay conexión de BigQuery configurada para el holding: <id>`.

Las conexiones se gestionan mediante los endpoints de `bigquery-connection.controller.ts` (crear, listar, probar, eliminar), que ya operan por holding.

> Nota: la antigua variable de entorno `BIGQUERY_CREDENTIALS` quedó **obsoleta** y ya no se usa. La configuración global fue reemplazada por la resolución por holding.

### 2. Variables de Entorno (solo scheduler)

```bash
# Scheduler automático (opcional)
BIGQUERY_SYNC_ENABLED=true    # Habilitar/deshabilitar sincronización automática
BIGQUERY_SYNC_HOUR=3          # Hora del día para ejecutar (0-23), por defecto 3 AM
```

**Importante**:
- El scheduler se ejecuta diariamente a la hora configurada en `BIGQUERY_SYNC_HOUR` y recorre las conexiones activas por holding.
- Puedes deshabilitar el scheduler con `BIGQUERY_SYNC_ENABLED=false`.

### 2. Instalación de Dependencias

```bash
yarn add @google-cloud/bigquery
```

## API Endpoints

### 1. Ejecutar Consulta SQL

**POST** `/bigquery/query`

Ejecuta una consulta SQL personalizada en BigQuery.

**Request Body:**

```json
{
	"query": "SELECT * FROM `datawarehouse-a2e2.dataset.table` LIMIT 10",
	"params": {}
}
```

**Response:**

```json
{
  "rows": [...],
  "totalRows": 10,
  "schema": [...]
}
```

### 2. Listar Datasets

**GET** `/bigquery/datasets`

Obtiene la lista de todos los datasets disponibles en el proyecto.

**Response:**

```json
["dataset1", "dataset2", "dataset3"]
```

### 3. Listar Tablas de un Dataset

**GET** `/bigquery/datasets/:datasetId/tables`

Obtiene la lista de tablas disponibles en un dataset específico.

**Response:**

```json
["table1", "table2", "table3"]
```

## Ejemplos de Uso

### Consulta Simple

```typescript
POST /bigquery/query
{
  "query": "SELECT COUNT(*) as total FROM `datawarehouse-a2e2.mi_dataset.mi_tabla`"
}
```

### Consulta con Filtros

```typescript
POST /bigquery/query
{
  "query": "SELECT * FROM `datawarehouse-a2e2.ventas.transacciones` WHERE fecha >= '2024-01-01' LIMIT 100"
}
```

### Explorar Estructura

```typescript
// 1. Obtener datasets
GET /bigquery/datasets

// 2. Obtener tablas de un dataset
GET /bigquery/datasets/ventas/tables

// 3. Consultar una tabla específica
POST /bigquery/query
{
  "query": "SELECT * FROM `datawarehouse-a2e2.ventas.transacciones` LIMIT 5"
}
```

## Seguridad

-   ✅ Todos los endpoints requieren autenticación mediante `SupabaseAuthGuard`
-   ✅ Las credenciales se almacenan de forma segura en variables de entorno
-   ✅ Los errores no exponen información sensible

## Notas Importantes

1. **Costos**: BigQuery cobra por la cantidad de datos procesados. Ten cuidado con consultas que escanean grandes volúmenes de datos.

2. **Límites**: Considera agregar límites (`LIMIT`) a tus consultas para evitar resultados muy grandes.

3. **Location**: El servicio está configurado para usar la región `US`. Si tus datos están en otra región, ajusta el parámetro `location` en el servicio.

4. **Formato de Credenciales**: El campo `credentials` de cada fila de `bigquery_connections` debe ser el JSON de la Service Account en formato válido (los `\n` de la clave privada deben conservarse escapados).

## Troubleshooting

### Error: "No hay conexión de BigQuery configurada para el holding"

Verifica que exista una fila activa (`is_active = true`) en `bigquery_connections` para ese holding y que la petición incluya el header `x-holding-id` correcto.

### Error: "El header x-holding-id es requerido"

Todos los endpoints y sincronizaciones requieren el header `x-holding-id`. Agrégalo a la petición.

### Error al parsear credenciales

Asegúrate de que el JSON del campo `credentials` esté correctamente escapado, especialmente las nuevas líneas (`\n`) en la clave privada.

### Error de permisos

Verifica que la cuenta de servicio tenga los permisos necesarios:

-   `BigQuery Data Viewer` (para leer datos)
-   `BigQuery Job User` (para ejecutar consultas)

## Scheduler Automático

El módulo incluye un scheduler que sincroniza automáticamente los datos de clientes Stripe desde BigQuery a PostgreSQL.

### Funcionamiento

-   **Frecuencia**: Diaria, a la hora configurada (3 AM por defecto)
-   **Alcance**: Sincroniza todos los holdings registrados en `company_holdings`
-   **Tabla destino**: `stripe_customers_bigquery`
-   **Tabla origen**: `datawarehouse-a2e2.finance.sapira_stripe` en BigQuery

### Configuración

```bash
BIGQUERY_SYNC_ENABLED=true  # Habilitar/deshabilitar
BIGQUERY_SYNC_HOUR=3        # Hora de ejecución (0-23)
```

### Logs

El scheduler genera logs detallados:

```
🚀 Iniciando sincronización automática de BigQuery...
┌─────────────────────────────────────────────────────────────┐
│  Sincronizando holding: Mi Empresa                          │
│  Holding ID: 5652e95e-bb99-48f5-aa1c-13c8c2638fc6           │
└─────────────────────────────────────────────────────────────┘
✓ Holding Mi Empresa sincronizado exitosamente
   - Procesados: 150
   - Insertados: 50
   - Actualizados: 100

═══════════════════════════════════════════════════════════
  RESUMEN DE SINCRONIZACIÓN
═══════════════════════════════════════════════════════════
  Holdings procesados: 3
  Registros procesados: 450
  Registros insertados: 150
  Registros actualizados: 300
  Errores: 0
═══════════════════════════════════════════════════════════
```

### Sincronización Manual

También puedes ejecutar la sincronización manualmente:

```bash
POST /bigquery/sync-stripe-customers
{
  "holdingId": "5652e95e-bb99-48f5-aa1c-13c8c2638fc6"
}
```

## Integración `sapira_base` (retirada)

> La tabla local `sapira_base_records` y sus endpoints `/bigquery/sapira-base/*` **ya no existen**.
> Sus dos roles —copia fiel del DWH y detección de diferencias— los absorbió
> `sapira_quantity_imports`, de modo que el canal hace **una sola consulta a BigQuery por holding
> y por noche** en vez de dos sobre la misma tabla y ventana. Ver la sección siguiente.
>
> Equivalencias para quien venga de la versión anterior:
>
> | Antes | Ahora |
> |---|---|
> | `POST /bigquery/sapira-base/sync` | `POST /bigquery/quantities/sync` |
> | `POST /bigquery/sapira-base/records/:id/replace` | `POST /bigquery/quantities/:id/replace` |
> | notificación `bigquery_sapira_base_diff` | `bigquery_quantities_diff` |
> | acción `replace_sapira_base_record` | `replace_quantity_record` |
> | notificación `bigquery_sapira_base_ambiguous` | estado `ambiguous` en la tabla intermedia |
>
> La tabla física `sapira_base_records` **no se elimina automáticamente**: conserva el histórico ya
> acumulado y darla de baja es una decisión aparte.

## Integración `quantities` (cantidades variables)

El scheduler diario también integra el **consumo real del mes** desde `datawarehouse-a2e2.finance.sapira_base` hacia `public.quantities`, que es la tabla operativa que dispara el recálculo de `invoice_items` y del revenue schedule mensual.

### Arquitectura: dos fases con tabla intermedia

```
finance.sapira_base  ──fase 1──▶  sapira_quantity_imports  ──fase 2──▶  quantities
   (BigQuery)          ingesta        (tabla intermedia)     integración   (operativa)
```

La tabla intermedia no es decorativa: en los datos reales del DWH **buena parte de las filas no se puede mapear** a un ítem de contrato. Guardarlas con el motivo permite auditar qué pasó y reprocesarlas después sin volver a pagar el escaneo de BigQuery.

**Cumple dos roles con una sola consulta a BigQuery** (antes eran dos, sobre la misma tabla y ventana):

1. **Cola de integración** hacia `quantities`, vía `integration_status`.
2. **Detección de cambios en el origen**, vía `source_hash` — el rol que tenía `sapira_base_records`.
   Por eso guarda también campos que nunca se integran (`entity_name`, `tin`, `country`) y las filas
   sin datos de cantidad, que quedan en `no_quantity_data` solo para vigilarlas.

El `source_hash` se calcula sobre los valores **ya parseados**, así que un cambio de formato del DWH
(`0.050` → `0.05`) no genera un diff falso.

- **Fase 1 — ingesta** (`ingestSapiraQuantities`): consulta el mes en curso y hace *upsert* contra la clave natural del origen. Acá el upsert sí corresponde: la tabla intermedia es un espejo del DWH, no dato de usuario.
- **Fase 2 — integración** (`integrateSapiraQuantities`): resuelve, valida e inserta en `quantities`. **No consulta BigQuery**, por eso puede reejecutarse gratis.

### Contrato de sincronización

- **Ventana**: rango de fechas sobre `billing_date`, inclusivo en ambos extremos. Por defecto el mes calendario en curso en zona `America/Santiago`. Ver "Ventana de fechas" más abajo.
- **Clave natural del origen**: `(holding_id, sf_id, billing_date, product, coalesce(quote_line_id, ''))`. Se incluye `quote_line_id` porque `(sf_id, billing_date, product)` no siempre es único en el DWH.
- **Clave natural del destino**: `(contract_item_id, period)`, el índice único `quantities_unique_item_period`.
- **Solo inserción**: `quantities` **nunca se sobrescribe automáticamente**. Si ya existe un override con valores distintos, la fila queda en `conflict` y se genera una notificación con acción de reemplazo manual. Esto protege los overrides hechos a mano desde el front.
- **`amount` no se escribe**: se llena por otro canal. Además, `trigger_rsm_on_quantity_change` hace `COALESCE(NEW.amount, unit_price * quantity)`, así que mandarlo pisaría el cálculo derivado.
- **`holding_id` y `contract_id` no se envían**: los deriva `trg_quantities_set_holding`.

### Precedencia de mapeo

Replica la del trigger `quantities_set_holding_from_contract_item()`:

1. **Par Sapira** — `sapira_contract_item_id` (UUID) → `contract_items.id`. `resolution_source = 'sapira_ids'`.
2. **Par Salesforce** — `quote_line_id` → `contract_items.quote_item_number`, acotado por `opportunity_id` → `contracts.salesforce_opportunity_id` cuando el DWH lo trae (evita colisiones entre clientes). `resolution_source = 'salesforce_ids'`.
3. **Ambos pares nulos o sin match** → `unmapped`, no se integra.

> En los datos reales del DWH los IDs Sapira vienen NULL, así que el paso 2 es el que resuelve casi todo. El `quote_item_number` de un `contract_item` guarda el **`Id` de Salesforce** del line item, no un número de línea.

### Filtros y validaciones antes de escribir

| Guard | Regla | Estado si falla |
|---|---|---|
| Tenancy | El `contract_item` debe pertenecer al holding sincronizado | `unmapped` |
| Ítem variable | `contract_items.unit_price IS NOT NULL AND quantity > 0` | `not_variable` |
| Moneda | El `currency` del DWH debe coincidir con `COALESCE(contract_items.currency, contracts.currency)` | `currency_mismatch` |
| Unicidad en el batch | Dos filas del DWH no pueden apuntar al mismo `(contract_item_id, period)` con valores distintos | `ambiguous` |

El **guard de tenancy es obligatorio**: la conexión de TypeORM usa credenciales de servicio y **no pasa por RLS**, a diferencia del front.

El **guard de moneda** existe porque `quantities` no tiene columna de moneda: el `unit_price` que se escribe lo consumen los triggers como `unit_price_contract_currency`. Integrar una fila en BRL sobre un contrato en USD produciría montos silenciosamente erróneos en facturas y revenue schedule.

El filtro de ítem variable replica `isVariableItem()` del front (`src/utils/variablePricingUtils.ts`).

### Estados de `integration_status`

| Estado | Significado | ¿Reprocesable? |
|---|---|---|
| `pending` | Ingestada, aún no procesada | sí |
| `integrated` | Insertada en `quantities` (`quantity_id` poblado) | — |
| `no_quantity_data` | Sin `quantity` ni `unit_price`: no hay override que aplicar. Se guarda solo para vigilar cambios en el origen | — |
| `unmapped` | Sin IDs de mapeo, o los IDs no matchearon | **sí** |
| `not_variable` | El `contract_item` no es variable | sí |
| `currency_mismatch` | Moneda del DWH ≠ moneda del contrato | sí |
| `blocked` | `trg_validate_quantity_invoice_status` rechazó el INSERT (factura no está en "Por Emitir") | **sí** |
| `ambiguous` | Varios candidatos, o duplicados en el batch con valores distintos | no (arreglar el origen) |
| `conflict` | Ya existía un override con valores distintos | no (reemplazo manual) |
| `changed_in_source` | Ya integrada y el DWH cambió el payload después | no (reemplazo manual) |

`unmapped` y `blocked` son los que se resuelven solos con el tiempo: el primero al poblarse `contract_items.quote_item_number`, el segundo al anularse la factura del período. Para eso está el endpoint de reproceso.

### Tolerancia a error por fila

Cada INSERT en `quantities` va aislado en su propio `try/catch`. `trg_validate_quantity_invoice_status` lanza excepción cuando la factura activa del período no está en `'Por Emitir'`: sin este aislamiento, **una sola factura emitida tumbaría la corrida completa del holding**.

### Notificaciones

| Tipo | Alcance | Acción |
|---|---|---|
| `bigquery_quantities_diff` | **Por fila** | `replace_quantity_record` — el botón necesita el `quantity_id` concreto. Cubre `conflict` (ya existía un override distinto) y `changed_in_source` (el DWH cambió tras integrar); lleva el diff campo a campo en `metadata.differences` |
| `bigquery_quantities_unmapped` | Agregada por holding y corrida | — |
| `bigquery_quantities_blocked` | Agregada por holding y corrida | — |
| `bigquery_quantities_currency_mismatch` | Agregada por holding y corrida | — |

Las agregadas llevan solo el conteo: el detalle fila a fila vive en `sapira_quantity_imports` y se consulta por endpoint. Notificar fila a fila generaría cientos de notificaciones por noche. Cuando un contador vuelve a cero, la notificación abierta se resuelve por `deduplication_key`.

**Las agregadas se deduplican por rango**: la clave es `<tipo>:<holdingId>:<from>:<to>`. Es lo que permite que un backfill de un período pasado no interfiera con las alertas del mes en curso — con una clave fija por mes actual, un backfill sin hallazgos cerraría en silencio una alerta vigente. Para el scheduler la clave queda estable dentro del mes, así que la deduplicación diaria se comporta igual que antes.

### Ventana de fechas

Las tres operaciones aceptan un rango `{ from, to }` en el body, **inclusivo en ambos extremos** sobre `billing_date`. Omitirlo procesa el **mes en curso** (`America/Santiago`), que es lo que hace el scheduler diario. La respuesta siempre devuelve el `range` efectivo, así que se sabe qué ventana aplicó el default.

**Formato: `YYYY-MM-DD` estricto**, sin hora ni zona horaria.

```json
{ "from": "2026-07-01", "to": "2026-07-31" }
```

Se valida con `@Matches` y no con `@IsDateString()`: este último aceptaría cualquier ISO 8601 (`2026-07-01T10:30:00Z` incluido) y el canal asume fecha simple — el valor viaja crudo como parámetro DATE a BigQuery y la comparación `from > to` es lexicográfica. Swagger UI trae los ejemplos precargados en el body de cada endpoint.

Enviar **solo uno** de los dos extremos es un error deliberado (`400`): acotar por un lado dejaría el otro abierto y convertiría un typo en un backfill del histórico completo. `from > to` también es `400`.

**No hay tope de rango.** Un rango amplio escanea mucho DWH y BigQuery cobra por datos procesados: revisa la ventana antes de lanzar un backfill grande.

**Un rango solapado es seguro.** La fase 1 nunca agrega filas entre sí (cada fila del DWH produce a lo sumo una fila de `quantities`; dos que caigan en el mismo `(contract_item_id, period)` con valores distintos se marcan `ambiguous`, no se suman), el `source_hash` hace la re-ingesta idempotente y la escritura es insert-only. Reprocesar una ventana ya integrada reporta `unchanged` y no genera notificaciones nuevas.

### Endpoints

Los tres pasos están separados para poder revisar entremedio, que es lo recomendado en un backfill.

**POST** `/bigquery/quantities/ingest` — **solo fase 1**: DWH → tabla intermedia. No toca `quantities`.

```bash
curl -X POST .../bigquery/quantities/ingest -H "x-holding-id: <uuid>" \
  -H 'Content-Type: application/json' -d '{"from":"2026-07-01","to":"2026-07-31"}'
```

**POST** `/bigquery/quantities/integrate` — **solo fase 2**: tabla intermedia → `quantities`, acotada por `period`. **No consulta BigQuery**, así que no tiene costo de escaneo. Con `retryFailed: true` reprocesa además los estados recuperables (`unmapped`, `blocked`, `not_variable`, `currency_mismatch`) — el camino tras poblar `quote_item_number` o anular una factura bloqueante.

```bash
curl -X POST .../bigquery/quantities/integrate -H "x-holding-id: <uuid>" \
  -H 'Content-Type: application/json' -d '{"from":"2026-07-01","to":"2026-07-31","retryFailed":true}'
```

**POST** `/bigquery/quantities/sync` — **fases 1 + 2** sobre el mismo rango, resuelto una sola vez. Es lo que ejecuta el scheduler (sin rango → mes en curso).

```json
{
  "holdingId": "5652e95e-...",
  "range":       { "from": "2026-07-01", "to": "2026-07-31" },
  "ingest":      { "totalFromDwh": 120, "inserted": 30, "updated": 5, "unchanged": 85,
                   "changedInSource": 0, "noQuantityData": 4, "discarded": 0 },
  "integration": { "totalProcessed": 35, "integrated": 20, "unmapped": 10, "notVariable": 3,
                   "currencyMismatch": 1, "blocked": 1, "ambiguous": 0, "conflict": 0 }
}
```

**GET** `/bigquery/quantities/imports?integration_status=unmapped&from=2026-07-01&to=2026-07-31` — auditoría: responde "¿por qué esta fila no se integró?". Acepta `period` puntual (que gana sobre el rango) o `from`/`to`. Cada fila trae `integration_status`, `integration_reason`, `resolution_source` y `quantity_id`.

**POST** `/bigquery/quantities/:id/replace` — aplica los valores del DWH sobre un override existente, marca las importaciones asociadas como integradas y resuelve la notificación. No toca `amount`.

### Tabla `sapira_quantity_imports`

La entidad `sapira-quantity-import.entity.ts` es un `.entity.ts` **real** (tabla propia de api-sapira), no un espejo: se autoregistra por el glob de TypeORM y está en el `forFeature` del módulo. `quantities`, en cambio, se escribe con SQL crudo vía `dataSource.query`, porque es una tabla preexistente cuyo espejo (`quantity.espejo.ts`) está apagado a propósito.

DDL: vive **solo en los assets de api-sapira**, no en las migraciones de Supabase del front.

| Pieza | Archivo |
|---|---|
| Tabla, FKs, índices, RLS activado, comentarios | `src/databases/postgresql/tables/002-sapira-quantity-imports.sql` |
| Trigger de `updated_at` (reusa `set_updated_at()`) | `src/databases/postgresql/triggers/sapira_quantity_imports_set_updated_at.sql` |
| Policies | `src/databases/postgresql/rls/sapira_quantity_imports_select.sql` y `..._service_role.sql` |

Se aplican con el runner de assets. `--only` es obligatorio: un `--apply` sin filtro intentaría aplicar los 560+ assets del corpus.

```bash
SUPABASE_DATABASE_URL=... yarn postgres:assets --apply --target qa \
  --only tables/002-sapira-quantity-imports.sql \
  --only triggers/sapira_quantity_imports_set_updated_at.sql \
  --only rls/sapira_quantity_imports_select.sql \
  --only rls/sapira_quantity_imports_service_role.sql
```

> **Orden de despliegue**: primero los assets, después el código. Sin la tabla, la fase 1 falla.
> Receta general para tablas nuevas: `src/databases/postgresql/README.md`, sección "Crear una tabla nueva".

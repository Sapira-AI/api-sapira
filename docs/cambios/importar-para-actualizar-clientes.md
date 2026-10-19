# Importar para actualizar clientes (Domi 19-10-2026)

Clientes › Importar › **Actualizar**: la planilla exportada (o cualquiera con una columna clave) vuelve con las columnas que la usuaria
mapeó y **solo esas** se actualizan. Celda vacía = no cambia (el front no la manda). Cada importación queda en un lote reversible.

## Endpoints (`clients/import`, `SupabaseAuthGuard` + `HoldingScopeGuard` + `EDIT_CLIENTES` en todos)

| Método y ruta | Qué hace |
| --- | --- |
| `POST /clients/import/preview` | Body `{ key_field: client_number \| tax_id, fields[] (mapeados), rows[{ row, key, fields{ name_commercial?, segment?, industry?, market?, country?, client_since?, notes? } }] }` (máx. 5.000 filas). Responde `{ key_field, fields, counts{ total, updated, unchanged, not_found, ambiguous, failed }, rows[{ row, key, status, client{ id, name } \| null, changes[{ field, from, to }], errors[] }] }`. No escribe. |
| `POST /clients/import` | Mismo body + `label?`. Aplica en una transacción (`withApiWriter`) y guarda el lote. Responde `{ batch_id, created_at, …vista previa }`. |
| `GET /clients/import/batches` | Últimos 20 lotes del holding: `{ id, label, key_field, fields[], rows_total, updated_count, skipped_count, failed_count, created_at, created_by, reverted_at, reverted_by, reverted_summary }`. |
| `POST /clients/import/:batchId/revert` | Restaura el valor anterior de cada campo cuyo valor actual sigue siendo el importado; los editados después quedan (`kept_fields`). `{ batch_id, restored_rows, kept_rows, kept_fields }`. 404 si no es del holding; 409 `already_reverted`. |

Reglas del plan (`ClientImportService.plan`):

- **Clave.** `client_number`: `lower(trim(client_number))`. `tax_id`: RUT normalizado (`[^0-9kK]` fuera, minúscula) de una razón social del holding,
  llegando al cliente por `client_entity_clients` o por `client_entities.client_id`. Más de un cliente con la misma clave → `ambiguous`.
- **Campos.** Solo los de `fields` (mapeados) y con valor. Segmento, industria y mercado se validan contra `master_data` activo del holding
  (misma regla que editar). País: nombre en español o inglés, alias o código ISO (`resolveCountryInput`); escribe `country` + `country_code`.
  `client_since` en `AAAA-MM-DD`. Un error deja la fila en `failed` sin escribir nada de ella.
- **Sin campos personalizados ni razones sociales** en esta versión (decisión 19-10; ver `docs/documentacion-funcional/clientes` del front).

## Esquema (migración `1792200000000-CreateImportBatches`, **sin aplicar** al 19-10)

Dos tablas propias, genéricas para el motor único de import (`entity_type` texto; hoy solo `client`):

- `import_batches` (entity `entities/clientes/import-batch.entity.ts`): lote con clave, campos mapeados, conteos, quién, cuándo y la reversión.
- `import_batch_rows` (entity `entities/clientes/import-batch-row.entity.ts`): fila con `entity_id`, estado y `before`/`after` por campo; al
  revertir, `reverted_fields` y `kept_fields`.

RLS activada en la migración; policies `rls/holding_access_import_batches.sql` y `rls/holding_access_import_batch_rows.sql`. Orden: migración
en QA → assets de RLS → `schema:status` → mismo camino en prod con las confirmaciones → `schema:snapshot`. La API arranca sin las tablas (solo
el módulo de importación las necesita).

## Tests

`client-import.service.spec.ts` (plan: clave insensible a mayúsculas, cambios, sin cambios, no encontrada, ambigua, catálogo, país, RUT;
aplicar: solo filas con cambios, lote y filas con antes/después; revertir: conserva lo editado después, 404, 409) y
`dtos/client-import.dto.spec.ts` (claves, campos, columnas desconocidas, fecha, tope de filas).

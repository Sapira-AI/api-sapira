# Cambio: reporte de la pierna de vuelta de Odoo (`GET /odoo/webhooks/diagnostico`)

> **Rama:** `leon` · 01-10-2026 · Leon + Claude
> **Módulo:** `src/modules/odoo` — [`README.md`](../../src/modules/odoo/README.md) § 6
> **Regla de tenancy:** [`docs/v2-rediseno/autorizacion-y-tenancy.md`](../v2-rediseno/autorizacion-y-tenancy.md)

## Contexto

La integración con Odoo tiene dos piernas y solo una estaba observable.

| | Qué hace | Cómo se mira |
|---|---|---|
| **Ida** (Sapira → Odoo) | El scheduler crea el draft, publica y emite electrónicamente | `odoo_send_logs` en Mongo, y el reporte de integración del front |
| **Vuelta** (Odoo → Sapira) | Odoo avisa al webhook el folio y el estado de pago | **nada** |

La pierna de vuelta no es un extra: **es la única fuente del folio**. El scheduler escribe
`odoo_invoice_id` y `status = 'Emitida'`, pero `invoice_number` lo escribe exclusivamente
`processInvoiceStatusUpdate` cuando Odoo avisa. Lo mismo con el avance a `Enviada` / `Pagada`, que es
lo que después alimenta cuentas por cobrar.

El incidente que lo motivó, **con la causa ya confirmada el 01-10-2026**: la automated action de Odoo
apuntaba a la URL que Railway genera por defecto, dada de baja al pasar a `api.aisapira.com`, así que
la llamada moría antes de llegar a la API. Desde el **16-09-2026** dejaron de llegar avisos y quedaron 154 facturas
de septiembre `Emitida` y sin folio (CL 96, MX 40, PE 9, CO 8, UY 1), ya publicadas y con folio en
Odoo. El problema para diagnosticarlo es que **las dos causas posibles se ven idénticas desde la
base**:

1. Odoo dejó de llamar (automated action apagada, URL cambiada, o la llamada se rechaza antes de
   llegar al controlador).
2. Odoo llama y el webhook no puede aplicar el aviso (el payload no trae lo que necesita).

Y los códigos HTTP no las separan, porque el controlador **atrapa todo y responde `200` con
`success: false`**: un fallo total y un no-op exitoso son la misma respuesta.

## Qué se agregó

`GET /odoo/webhooks/diagnostico` cruza las tres fuentes que sí las separan y deja el triage resuelto
en un campo:

| Fuente | Qué contesta |
|---|---|
| `odoo_webhook_logs` (Mongo) | ¿llegó la llamada? |
| `odoo_invoice_update_logs` (Mongo) | ¿tuvo efecto? |
| `invoices` (PostgreSQL) | ¿qué quedó sin folio, y desde cuándo? |

### Contrato

```
GET /odoo/webhooks/diagnostico?dias=30
Authorization: Bearer <token de Supabase>
x-holding-id: <uuid del holding activo>
```

- `dias` — ventana, opcional. Se acota a 1–365; el default es 30.
- `x-holding-id` — **obligatorio** (`HoldingScopeGuard`): falta → `400`, holding ajeno → `403`.

El guard va **en el método, no en el controlador**, mismo criterio que
`GET /invoices/scheduler/report`: `POST /odoo/webhooks` lo llama Odoo sin credenciales y tiene que
seguir público, y `GET /odoo/webhooks` lo usa el front viejo sin el header. Hay una prueba por cada
una de esas tres cosas, porque el riesgo real de este cambio era dejar a Odoo afuera.

### El veredicto

```
veredicto = ok | sin_avisos | avisos_sin_efecto | hueco_parcial
```

| Veredicto | Qué significa | Qué se revisa |
|---|---|---|
| `ok` | No hay facturas sin folio | Nada |
| `sin_avisos` | Hay hueco y Odoo no llamó en la ventana | **Odoo**: automated action activa, URL, token. Y, antes, que la llamada no se esté rechazando antes del controlador (ver abajo) |
| `avisos_sin_efecto` | Odoo llama pero ninguna actualización se aplicó | **La API**: la forma del payload |
| `hueco_parcial` | Llegan y se aplican avisos, pero igual hay facturas sin folio | Caso a caso: `facturas_sin_folio.por_dia_y_pais` |

### Lo demás que devuelve

- **`avisos_recibidos`** — total histórico, total en la ventana, fecha del último, `horas_sin_avisos`,
  desglose por día, y un resumen del último aviso: `trae_x_sapira_invoice_id` y `claves_payload`.
- **`actualizaciones_aplicadas`** — lo mismo para las que **sí** se aplicaron (`was_updated: true`).
  Las omitidas conviven en esa colección y contarlas haría que `avisos_sin_efecto` nunca se dispare.
- **`facturas_sin_folio`** — total, desglose por día de envío / país / estado, y la lista de
  `odoo_invoice_ids` **lista para el backfill** (tope 500, con `lista_truncada` cuando se recorta).
- **`corte`** — los dos bordes: la última factura cuyo aviso sí llegó y la primera posterior sin
  folio. Esto pone el corte **al minuto** sin mirar ningún log, y es el hallazgo que lo hace posible:
  `status IN ('Enviada', 'Pagada')` son los dos únicos valores que escribe
  `determineInvoiceStatus`, y el scheduler deja `Emitida`. O sea: **`Emitida` = el aviso no llegó;
  `Enviada` = sí llegó.**

### `x_sapira_invoice_id` y la forma del payload

`claves_payload` existe por algo concreto. El webhook lee el registro de Odoo **en la raíz** del
payload (`extractInvoiceFields`), y `x_sapira_invoice_id` es el único amarre entre los dos sistemas:
sin él no sabe qué factura actualizar y **sale en silencio, sin dejar rastro en
`odoo_invoice_update_logs`**. Pero el ejemplo de Swagger del propio controlador documenta la forma
estándar de Odoo, con el registro dentro de `values`:

```jsonc
// Lo que el ejemplo de Swagger documenta — el webhook NO sabe leerlo
{ "model": "account.move", "record_id": 123, "action": "write", "values": { "name": "...", "state": "posted" } }

// Lo que el webhook sí lee
{ "model": "account.move", "id": 123, "name": "...", "state": "posted", "x_sapira_invoice_id": "<uuid>" }
```

Con la primera forma, `state` y `x_sapira_invoice_id` salen `undefined` y el aviso se descarta. El
reporte lo muestra directo en `ultimo_aviso`.

## Lo que el reporte NO puede decir

Se documenta porque es la parte que se presta a conclusiones falsas:

1. **Los dos contadores de Mongo son globales, no por holding.** `odoo_webhook_logs.holding_id` solo
   se llena si Odoo lo manda en el payload, y hoy no lo manda. `facturas_sin_folio` y `corte` sí
   salen acotados al holding activo.
2. **No distingue "Odoo no llamó" de "la llamada no llegó al controlador".** El webhook solo registra
   lo que ya pasó `IpFilterMiddleware` y `ThrottlerGuard`; un `403 IP_BLOCKED`, un `429` o un `404`
   por URL cambiada dan el mismo `sin_avisos`. Para separarlos: un `POST` de prueba al endpoint
   —`{"model":"test.ping"}` sale por la validación de modelo y queda identificable en la colección—
   y grepear Railway por `IP_BLOCKED`, `SECURITY_POINTS_EXCEEDED`, `INVALID_IP`.
3. **`status` de `odoo_webhook_logs` no sirve de filtro**: `markAsProcessed` y `markAsError` existen
   en el servicio pero **no tienen ningún caller**, así que todo documento queda en `received` para
   siempre. El reporte no lo usa.
4. **Solo publica las claves del último payload, nunca sus valores.** El payload de Odoo lleva datos
   del cliente y este reporte lo lee cualquier usuario autenticado del holding.
5. **Las facturas sin `sent_to_odoo_at` quedan fuera de la ventana**, porque no hay con qué fecharlas.

## Pendientes que este cambio deja a la vista

No se tocaron acá; quedan anotados para decidirlos:

- **El webhook responde `200` cuando falla.** Devolver el código real, o al menos incluir siempre
  `invoice_update` con el motivo, y llamar a `markAsError` / `markAsProcessed`.
- **Las tres salidas silenciosas no dejan log**: modelo distinto de `account.move`, sin
  `x_sapira_invoice_id`, y `state != posted`. Son justo las más probables.
- **El endpoint no valida ningún secreto**, aunque
  [`inventario-tenancy-fase-2.md`](../v2-rediseno/inventario-tenancy-fase-2.md) y
  [`plan-migracion-integraciones.md`](../v2-rediseno/plan-migracion-integraciones.md) afirman que sí
  ("autenticación propia por secreto"). Hoy cualquiera puede escribir `invoice_number` y `status` de
  cualquier factura conociendo su UUID.
- ~~**`determineInvoiceStatus` mapea mal los estados intermedios de pago**~~ — ✅ **resuelto el
  01-10-2026**: la regla salió a `helpers/odoo-invoice-status.helper.ts` y solo `paid` pasa a
  `Pagada`. Junto con el backfill de las 154, en
  [`backfill-folios-odoo.md`](./backfill-folios-odoo.md).
- **`OdooWebhookLogSchema` no tiene ningún índice**, y `getWebhookLogs` ordena por `createdAt`: es un
  sort sin índice, con el tope de 32 MB de Mongo.

## Pruebas

- [`odoo-webhook.service.spec.ts`](../../src/modules/odoo/odoo-webhook.service.spec.ts) — las cuatro
  ramas del veredicto, la suma del hueco, el truncado de la lista, los dos bordes del corte, los
  límites de la ventana, que el payload del incidente (sin `x_sapira_invoice_id` en la raíz) se
  detecte, y que los **valores** del payload no se filtren en la respuesta.
- [`odoo-webhook.controller.spec.ts`](../../src/modules/odoo/odoo-webhook.controller.spec.ts) — los
  dos casos de tenancy (sin header → `400`, holding ajeno → `403`), el caso feliz, y que `POST` y
  `GET /odoo/webhooks` sigan respondiendo sin el header.

El tercer caso obligatorio de tenancy —registro de otro holding → `404`— **no aplica**: el reporte no
se pide por id, se calcula sobre el holding activo.

# Cambio: backfill de folios desde Odoo y corrección del mapeo de estados de pago

> **Rama:** `leon` · 01-10-2026 · Leon + Claude
> **Módulo:** `src/modules/odoo` — [`README.md`](../../src/modules/odoo/README.md) § 7
> **Diagnóstico que lo precede:** [`diagnostico-pierna-de-vuelta-odoo.md`](./diagnostico-pierna-de-vuelta-odoo.md)
> **Regla de tenancy:** [`docs/v2-rediseno/autorizacion-y-tenancy.md`](../v2-rediseno/autorizacion-y-tenancy.md)

## La causa, ya confirmada

Entre el 16 y el 28-09-2026 no llegó a Sapira ningún aviso de Odoo. **La automated action de Odoo
apuntaba a la URL que Railway genera por defecto, que se dio de baja al pasar a
`api.aisapira.com`.** La llamada moría antes de llegar a la API: por eso `odoowebhooklogs` no tiene
un solo registro después del 15-09, el código del webhook nunca cambió y la base estaba sana.

El costo: **154 facturas de septiembre** (16 al 28) quedaron `status = 'Emitida'` y sin folio — CL 96,
MX 40, PE 9, CO 8, UY 1 — más las publicaciones manuales de Alicorp (ids de Odoo 199014 y 199077) y
los estados de pago que nunca avanzaron. Todas están publicadas y con folio en Odoo.

**La corrección de fondo es del lado de Odoo** (apuntar la automated action a
`https://api.aisapira.com/odoo/webhooks`, idealmente leyendo la URL de un parámetro del sistema en
vez de hardcodearla). Este cambio cubre lo otro: recuperar lo que se perdió.

## 1. El mapeo de estados de pago estaba mal

`determineInvoiceStatus` hacía:

```ts
payment_state === 'not_paid' ? 'Enviada' : 'Pagada'
```

O sea **todo** lo que no fuera `not_paid` iba a `Pagada`: `partial`, `in_payment`, `reversed`, y
también un payload publicado **sin** `payment_state`. Eso infla lo cobrado en el cierre de mes, y
había que arreglarlo *antes* del backfill o el backfill cambiaba un descuadre por otro.

La regla salió del servicio del webhook a
[`helpers/odoo-invoice-status.helper.ts`](../../src/modules/odoo/helpers/odoo-invoice-status.helper.ts),
porque ahora hay **dos** caminos que la aplican —el aviso en vivo y el backfill— y dos copias serían
dos verdades distintas sobre qué significa que una factura esté pagada.

**Decisión de Leon (01-10-2026): solo `paid` pasa a `Pagada`.**

| `state` | `payment_state` | Antes | Ahora |
|---|---|---|---|
| `posted` | `paid` | `Pagada` | `Pagada` |
| `posted` | `not_paid` | `Enviada` | `Enviada` |
| `posted` | `partial` | ❌ `Pagada` | `Enviada` |
| `posted` | `in_payment` | ❌ `Pagada` | `Enviada` |
| `posted` | `reversed` | ❌ `Pagada` | `Enviada` |
| `posted` | ausente | ❌ `Pagada` | `Enviada` |
| ≠ `posted` | cualquiera | `null` (no sincroniza) | `null` |

Las parcialmente pagadas quedan **abiertas** para cuentas por cobrar, y el cron de vencidas las pasa
a `Vencida` si corresponde. No hay estado intermedio posible: el CHECK `invoices_status_check` acota
`status` a ocho valores y ninguno representa "parcialmente pagada".

## 2. El backfill

```
POST /odoo/webhooks/backfill
Authorization: Bearer <token de Supabase>
x-holding-id: <uuid del holding activo>
Content-Type: application/json

{ "dias": 30, "aplicar": false, "odoo_invoice_ids": [199014, 199077] }
```

Todos los campos son opcionales. Sin `dias` barre toda la historia del holding; sin
`odoo_invoice_ids` toma todas las candidatas; **sin `aplicar: true` no escribe nada**; sin `campos`
sincroniza solo `folio` y `estado`; sin `estados` toma cualquier estado actual.

### El alcance (`campos`) y por qué el default es el que es

| Grupo | Columnas | Seguro de correr solo |
|---|---|---|
| `folio` | `invoice_number` | ✅ |
| `estado` | `status` | ✅ para `Emitida` → `Enviada`/`Pagada`; ⚠️ ver abajo para `Por Emitir` |
| `montos` | `vat`, `total_invoice_currency`, `amount_invoice_currency` | ❌ requiere rebuild de RSM |
| `fecha` | `issue_date` | ❌ requiere rebuild de RSM |

**`montos` y `fecha` obligan a reconstruir `revenue_schedule_monthly` a mano.**
`trg_rsm_on_invoice_change` dispara cuando cambian `total_invoice_currency` o `issue_date`, pero su
función **sale en seco con la conexión de la API** y el cronograma se queda con los números viejos,
en silencio.

Eso no es propio de este backfill: **ninguno de los 4 triggers de RSM se dispara para nada que
escriba la API**, porque los cuatro deciden si corren leyendo `get_current_user_holding_id()` →
`rls_user_holding_id()`, que necesita claims de JWT que la API no tiene. Alcance medido, mecánica
exacta y hacia dónde va el arreglo:
[`src/databases/postgresql/README.md` → Deudas conocidas del corpus, punto 7](../../src/databases/postgresql/README.md#deudas-conocidas-del-corpus).
Es un defecto de esquema **sin resolver**, anotado y no tocado: se encontró en cierre de mes.

`folio` y `estado` son seguros porque `Emitida`, `Enviada`, `Pagada` y `Vencida` están en los mismos
filtros `IN` del rebuild: moverse entre ellos no cambia ningún `billed_*`. **`Por Emitir` no está en
esos filtros**, así que pasar una factura de `Por Emitir` a `Enviada` sí cambia revenue — para eso
está `estados`, que permite separar las dos poblaciones.

### Lo que mostró el dry-run del 01-10-2026

Corrido sobre el holding de SimpliRoute con `dias: 30`: **287 candidatas**, 269 leídas de Odoo, 233
con cambios, 18 `no_existe_en_odoo` y 36 `no_publicada_en_odoo`.

Tres cosas que no se veían antes y que justifican el alcance por defecto:

1. **La población es más amplia que el incidente.** Las 154 de septiembre estaban en `Emitida`, pero
   hay muchas en `Por Emitir`: Odoo las publicó y Sapira nunca las avanzó. Son otro problema.
2. **Los deltas de monto no son redondeo.** Casos reales: `odoo_invoice_id` 198944 con `vat`
   7.283,99 → 751.710 y `total` 3.963.651 → 4.708.078; 198814 con `total` 6.655,20 → 2.643,20
   (el neto bajó de 5.640 a 2.240: **la factura se editó en Odoo**); 198264 con `vat` 0 → −59.757,6.
   El patrón de fondo es que en muchas Sapira guardó `total == neto`, sin IVA, y Odoo tiene
   `total = neto + IVA`. Odoo pinta más correcto, pero eso es una **reconciliación contable**, no un
   backfill de folios, y sobrescribirlo en bloque taparía los casos editados a mano.
3. **Hay `issue_date` con el año equivocado** (198803: `2025-09-16` → `2026-09-17`), y varias que
   mueven la factura de período. Cambiar `issue_date` reasigna revenue de mes.

**Lo que no es un riesgo**, verificado: las `Por Emitir` con `odoo_invoice_id` **no se van a reenviar
a Odoo**. `pendingInvoicesQuery` exige `sent_to_odoo_at IS NULL` y todas estas lo tienen.

Toma las facturas del holding con `odoo_invoice_id` y sin `invoice_number` —las mismas que cuenta
`facturas_sin_folio` del diagnóstico—, les lee `name`, `state`, `payment_state`, `amount_tax`,
`amount_total`, `amount_untaxed` e `invoice_date` desde Odoo por `odoo_invoice_id` (en lotes de 100
por XML-RPC) y sincroniza **los mismos campos que aplicaría el aviso del webhook**, con la misma
regla de estado.

**Lee Odoo en vez de reenviar los avisos** porque preguntar por `odoo_invoice_id` es idempotente y
se puede correr en seco, mientras que re-disparar la automation obliga a escribir 154 veces sobre
facturas ya publicadas.

### Las tres guardas

Esto escribe sobre facturas emitidas en pleno cierre de mes, así que:

1. **Corre en seco por defecto.** Sin `aplicar: true` devuelve el detalle campo por campo de lo que
   escribiría —`cambios: [{ campo, antes, despues }]`— y `actualizadas: 0`.
2. **Exige que `x_sapira_invoice_id` de Odoo coincida con el id de la factura de Sapira.** Es la
   guarda que evita escribir el folio en la factura equivocada si un `odoo_invoice_id` quedó
   desalineado. Si falta o no coincide, la factura se omite y aparece en `omitidas` con el motivo —
   **eso se revisa a mano, no se fuerza.**
3. **Solo sincroniza lo que Odoo tiene en `posted` y con `name`.** Un borrador no tiene folio que
   traer.

Además hay un tope de **1000 facturas por corrida**, y `tope_alcanzado: true` avisa que quedan más.

### Motivos de omisión

| Motivo | Qué pasó | Qué hacer |
|---|---|---|
| `no_existe_en_odoo` | Odoo no conoce ese `odoo_invoice_id` | Ver abajo: **amarre a la nada** |
| `sin_x_sapira_invoice_id_en_odoo` | El registro de Odoo no tiene el amarre | **A mano**: puede ser una factura creada fuera de Sapira |
| `x_sapira_invoice_id_no_coincide` | El amarre apunta a otra factura de Sapira | **A mano, con prioridad**: hay un `odoo_invoice_id` mal asignado |
| `no_publicada_en_odoo` | Sigue en borrador | Ver abajo: **se resuelve sola** |
| `sin_folio_en_odoo` | Publicada pero Odoo no le asignó `name` | Revisar la secuencia en Odoo |

#### Las 18 `no_existe_en_odoo` — un amarre a la nada

Tienen `odoo_invoice_id` apuntando a registros que Odoo **ya no tiene**. La hipótesis más probable es
que fueran borradores eliminados en Odoo: el scheduler crea el draft y guarda el id en el mismo paso
(`invoiceRepository.update(invoice.id, { odoo_invoice_id, sent_to_odoo_at })`), así que si después
alguien borra el borrador del lado de Odoo, Sapira se queda con el id colgando. Dos indicios que
apoyan eso: **199024, 199025 y 199026 son consecutivos** (un lote borrado de una vez), y **198805 es
un hueco exacto** entre 198804 y 198806, que sí existen.

IDs de Odoo, de la corrida del 01-10-2026 sobre el holding de SimpliRoute:

```
197653  197654  197754  197789  197790  197943  198208  198232  198275
198276  198386  198387  198388  198497  198805  199024  199025  199026
```

**Por qué importa y no es cosmético:** mientras `odoo_invoice_id` tenga valor y `sent_to_odoo_at`
también, esas facturas quedan en tierra de nadie. No las toma el backfill (Odoo no las conoce) y
tampoco las vuelve a tomar el envío nocturno, porque
[`pendingInvoicesQuery`](../../src/modules/invoices/invoice-scheduler.service.ts) exige
`sent_to_odoo_at IS NULL`. O sea: **no se van a emitir nunca**, salvo que alguien intervenga.

Para verlas antes de decidir:

```sql
SELECT i.id, i.odoo_invoice_id, i.invoice_number, i.status, i.issue_date, i.sent_to_odoo_at,
       i.total_invoice_currency, co.country, ce.legal_name AS razon_social
FROM invoices i
LEFT JOIN companies co ON co.id = i.company_id
LEFT JOIN client_entities ce ON ce.id = i.client_entity_id
WHERE i.odoo_invoice_id IN (197653,197654,197754,197789,197790,197943,198208,198232,198275,
                            198276,198386,198387,198388,198497,198805,199024,199025,199026)
ORDER BY i.sent_to_odoo_at;
```

**Decisión pendiente** (no la tomó el backfill a propósito): si se confirma que el borrador se borró
en Odoo y la factura sigue debiendo emitirse, lo correcto es **limpiar `odoo_invoice_id` y
`sent_to_odoo_at`** para que el scheduler la vuelva a tomar. Eso es corregir datos, así que va en una
**migración**, no en este endpoint — y antes hay que confirmar en Odoo, uno por uno, que el registro
no existe y no fue reemplazado por otro con folio. Si en cambio ya se emitieron por fuera, lo que
corresponde es cargarles el folio a mano.

#### Las 36 `no_publicada_en_odoo` — se resuelven solas

Siguen en `draft` en Odoo: el draft se creó bien, pero nunca se publicó. El backfill las omite por
diseño (guarda 3: un borrador no tiene folio que traer) y **no hace falta hacer nada con ellas en
Sapira**. Cuando se publiquen en Odoo pasan a `posted` con folio y entran al backfill en la siguiente
corrida, sin cambio de código.

Lo que sí conviene revisar es **por qué quedaron en borrador**, porque son 36 y el patrón sugiere
causas distintas de la URL del webhook: facturas sin `auto_invoice`, o con la emisión electrónica
rechazada. Los `odoo_send_logs` de Mongo tienen la respuesta por factura
(`operation: 'post_invoice'` / `'emit_electronic_invoice'`, con `errorMessage` y `errorType`).

```
197658  197661  197663  197730  197733  197775  197796  197799  198287  198389  198614  198615
198702  198709  198804  198830  198831  198940  198977  199138  199186  199228  199240  199251
199416  199431  199432  199441  199443  199447  199450  199458  199528  199565  199569  199571
```

### Rastro

Cada factura aplicada deja un documento en `odoo_invoice_update_logs` —la misma colección que usa el
webhook— con `skip_reason: 'backfill'` y `webhook_payload.origen: 'backfill'`, para poder distinguir
después qué vino por aviso y qué se recuperó a mano.

## Procedimiento recomendado

1. Arreglar la URL en Odoo y verificar con un POST de prueba que `odoowebhooklogs` vuelve a recibir.
2. `GET /odoo/webhooks/diagnostico` → anotar `facturas_sin_folio.total` y `corte`.
3. `POST /odoo/webhooks/backfill` **en seco** (sin `aplicar`) → revisar `omitidas` y el detalle de
   `facturas`. Los dos motivos de amarre se resuelven antes de seguir.
4. **Fase 1 — recuperar lo perdido**, acotado a las que sí se emitieron:
   `{ "aplicar": true, "estados": ["Emitida"] }`. Alcance por defecto (`folio` + `estado`), sin
   mover ninguna cifra ni fecha.
5. `GET /odoo/webhooks/diagnostico` otra vez → `facturas_sin_folio` tiene que bajar.
6. **Fase 2 — las `Por Emitir`**, como decisión aparte: `{ "estados": ["Por Emitir"] }`. Cambia
   revenue, así que va con rebuild de RSM después.
7. **Fase 3 — montos y fechas, después del cierre**: `{ "campos": ["montos", "fecha"] }`, revisado
   factura por factura con el reporte en seco, y con el rebuild de `revenue_schedule_monthly` a
   continuación. No se corre sin que Domi haya mirado los deltas.

## Pruebas

- [`odoo-invoice-status.helper.spec.ts`](../../src/modules/odoo/helpers/odoo-invoice-status.helper.spec.ts)
  — un caso por `payment_state`, incluido el payload sin `payment_state`.
- [`odoo-invoice-backfill.service.spec.ts`](../../src/modules/odoo/services/odoo-invoice-backfill.service.spec.ts)
  — que en seco no escriba nada, las cuatro guardas por separado, `in_payment` → `Enviada`,
  `paid` → `Pagada`, que un `numeric` que PostgreSQL devuelve como `'190000.0000'` y una `issue_date`
  que llega como `Date` no cuenten como cambio, el acotado por holding/ventana/ids y el tope.
- [`odoo-webhook.controller.spec.ts`](../../src/modules/odoo/odoo-webhook.controller.spec.ts) — los
  dos casos de tenancy del endpoint (sin header → `400`, holding ajeno → `403`) y el paso de
  parámetros. El tercer caso obligatorio —registro de otro holding → `404`— **no aplica**: el
  backfill no se pide por id de recurso, opera sobre el holding activo.

## Lo que sigue pendiente

Del [diagnóstico](./diagnostico-pierna-de-vuelta-odoo.md), sin resolver:

- El webhook responde `200` cuando falla, y `markAsProcessed` / `markAsError` no tienen caller.
- Las tres salidas silenciosas del webhook no dejan log.
- El endpoint público no valida ningún secreto, aunque dos documentos de `v2-rediseno` afirman que
  sí. Hoy cualquiera puede escribir `invoice_number` y `status` de cualquier factura con su UUID.
- `OdooWebhookLogSchema` no tiene índices y `getWebhookLogs` ordena por `createdAt`.
- **Del lado de Odoo**: la URL hardcodeada en el código de la automated action, y el `except`
  silencioso que dejó esto invisible 15 días desde los dos lados.

Y lo que destapó este backfill:

- **Los 4 triggers de RSM no corren para las escrituras de la API** — punto 7 de
  [Deudas conocidas del corpus](../../src/databases/postgresql/README.md#deudas-conocidas-del-corpus).
  Es el pendiente más grande de los tres y el único que no es del módulo Odoo.
- **18 facturas con `odoo_invoice_id` colgando**, que hoy no las toma ni el backfill ni el scheduler.
- **36 borradores sin publicar en Odoo**, que no necesitan acción en Sapira pero sí explicación.

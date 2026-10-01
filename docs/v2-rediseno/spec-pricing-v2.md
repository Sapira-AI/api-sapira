# Spec · Pricing v2 — modelos de precio, tramos y consumo (billable metric)

> 28-09-2026 · Domi + Claude (v2 del mismo día: decisiones de §8 aplicadas, §3.8 y §4.4 nuevos). Primera sección de la spec v2 (`mejoras-y-brechas.md` §A.3 y §E.1). Para Domi (producto) y
> para quienes la implementan a continuación. Fuentes: `glosario.md` (Consumo / billable metric), benchmarks de
> metering-pricing, consumo-desfase-MRR, Zenskar, Relvo y Maxio, `mapa-v2-contratos.md` §3 (generador v2),
> `auditoria-contratos.md` S7 (cantidades variables), `billing-engine.ts`, `contract-items.ts`, entities `contract_items`,
> `quantities`, `sapira_quantity_imports`, `products`, uso de `quantities` en `sapira-ai` y el mockup O2C (pantallas 2b, 3a,
> 3b, 4a, 3c). Lo marcado **Supuesto** no está decidido en los documentos: se propone y se confirma con Domi.

## 0. Decisiones ya tomadas (no se reabren)

-   El consumo **es parte del modelo de precio**: el precio declara cantidad `fixed | metered`; si es `metered`, apunta a una
    **métrica facturable**; el consumo es el valor de esa métrica por período (glosario, Domi 21-08).
-   Capa **nueva y compatible** con `contract_items`: el ítem apunta a un precio (`contract_items.price_id`). Los ítems
    existentes no se migran: `price_id NULL` = modelo `standard` con el comportamiento de hoy.
-   Modelos etapa 1: `standard | graduated | volume | package | seat`. `percentage` y `matrix` quedan para después.
-   Tramos `[{from, to|null, per_unit_amount, flat_amount}]`. Extras opcionales: unidades gratis, mínimo comprometido con
    true-up, tope máximo (cap). Cadencia y anticipado/vencido siguen **por línea**, como hoy.
-   `consumption_entries` por contrato + ítem + período reemplaza `quantities` ("overrides", "cantidades variables").
-   Motor: resuelve cantidad (fija o consumo) → modelo/tramos → **una línea de factura** con el detalle por tramo como sublíneas.
-   UI: modelo de precio por ítem en el wizard con vista previa en vivo; 360 › pestaña **Consumos**; métricas por holding.

## 1. Objetivo y alcance por etapa

**Objetivo.** Que un contrato cobre por lo que el cliente consume, con tramos y condiciones declaradas una sola vez, sin el
workaround "N ítems por tramo" (ValdiShopper, Turboboy, SimpliRoute en UF) ni el ajuste manual mensual; y que el consumo
registrado después de activar actualice la factura Por Emitir del período sin tocar lo emitido.

| Etapa                           | Entrega                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Incluye                                                                                     | No incluye                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **1 · Datos + motor + preview** | Tablas `billable_metrics`, `prices`, `consumption_entries`, `contract_items.price_id`; `resolveQuantity` y `priceLine` en `billing-engine.ts`; precio por ítem en `CreateContractDto` con `POST /contracts/price-preview`; CRUD de métricas; activación (C2) que persiste líneas con desglose                                                                                                                                                                                                                                                             | Los 5 modelos, unidades gratis, mínimo, tope; precio `owner = contract` (inline en el ítem) | Catálogo de precios versionado en Productos, cotizaciones, `percentage`/`matrix`, prepago/créditos |
| **2 · Consumos en el 360**      | Pestaña Consumos: registrar, corregir, importar CSV, "pendientes de informar"; recálculo de la Por Emitir del período; evento; RSM; con la factura emitida, complementaria "consumo adicional" o NC espejo + reemisión (`on_issued`, §4.4)                                                                                                                                                                                                                                                                                                                | Reglas S7-7/S7-8 (emitida no se pisa); canal DWH escribiendo `consumption_entries`          | —                                                                                                  |
| **3 · Catálogo y cotizaciones** | `prices.owner = catalog` versionados (`supersedes_price_id`), pantalla "Planes y precios" (mockup 2b), precio de lista referenciado desde el contrato (`list_price_id`), tramos en cotizaciones. **Construido en api-sapira (28-09)**: catálogo `GET/POST /prices`, `GET/PATCH /prices/:id`, `publish`/`archive`/`new-version`, e `items[].price_id` en alta, PUT e `item_add` (el contrato recibe una **copia** `owner = contract` con `list_price_id`). Pendiente: pantalla en front-sapira, tramos en cotizaciones, "a cuáles aplica en la renovación" | Publicar versión sin tocar contratos firmados; elegir a cuáles aplica en la renovación      | —                                                                                                  |

Principios transversales que cumple: preview antes de persistir (§4, §5), bloqueos explicativos con el paso siguiente
(§4.3), IA como capa de usabilidad (copiloto del wizard y de métricas, §6), flexibilidad con trazabilidad (correcciones
como revisiones, §2.3).

## 2. Modelo de datos

Convenciones: `holding_id uuid NOT NULL` FK `company_holdings(id) ON DELETE CASCADE`; RLS activa con policies espejo de
`holding_access_contract_items` (SELECT/INSERT/UPDATE/DELETE por holding); `created_at/updated_at timestamptz`,
`created_by/updated_by uuid` FK `users(id)`; montos `numeric(18,6)` para unitarios y `numeric(18,2)` para totales (misma
escala que `contract_items`). Esquema **aditivo** (mapa §1.1): nada se renombra ni se borra hasta el switch.

### 2.1 `billable_metrics` — qué se mide y cómo se agrega (por holding)

| Columna               | Tipo    | Regla                                                                           |
| --------------------- | ------- | ------------------------------------------------------------------------------- |
| `id`                  | uuid PK |                                                                                 |
| `holding_id`          | uuid    | FK, RLS                                                                         |
| `code`                | text    | UNIQUE (`holding_id`, `code`); slug estable para API y DWH                      |
| `name`, `description` | text    | `name` obligatorio; es lo que ve la usuaria ("Rutas completadas")               |
| `aggregation`         | text    | CHECK `sum \| count \| max \| min \| last \| unique_count` (Zenskar/Relvo/Lago) |
| `unit`                | text    | Unidad en singular para glosa y UI ("ruta", "usuario", "GB")                    |
| `source_kind`         | text    | CHECK `manual \| csv \| dwh \| api`; default `manual`                           |
| `source_config`       | jsonb   | Para `dwh`: referencia a la consulta/tabla de BigQuery; para el resto `{}`      |
| `status`              | text    | CHECK `active \| archived`; una métrica con precios activos no se archiva (409) |
| auditoría             |         | `created_*`, `updated_*`, `archived_at`                                         |

### 2.2 `prices` — el modelo de precio (catálogo o contrato)

| Columna                          | Tipo                          | Regla                                                                                                                                                                                                                                                                   |
| -------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                             | uuid PK                       |                                                                                                                                                                                                                                                                         |
| `holding_id`                     | uuid                          | FK, RLS                                                                                                                                                                                                                                                                 |
| `owner`                          | text                          | CHECK `catalog \| contract`. `contract` = precio inline del ítem o **copia** de un precio de catálogo; `catalog` = versionado por holding (etapa 3, `prices.service.ts`)                                                                                                |
| `product_id`                     | uuid                          | FK `products(id)` NOT NULL (el ítem exige producto, S1-12)                                                                                                                                                                                                              |
| `contract_id`                    | uuid                          | FK `contracts(id) ON DELETE CASCADE`; NOT NULL si `owner = contract`, NULL si `catalog` (CHECK)                                                                                                                                                                         |
| `name`                           | text                          | Etiqueta ("Tramos LatAm — UF"); para `contract` default = nombre del producto (o el del catálogo si es copia)                                                                                                                                                           |
| `currency`                       | text                          | = moneda del contrato (S1-2); en catálogo, la del precio                                                                                                                                                                                                                |
| `model`                          | text                          | CHECK `standard \| graduated \| volume \| package \| seat`                                                                                                                                                                                                              |
| `quantity_type`                  | text                          | CHECK `fixed \| metered`; `metered` exige `billable_metric_id` (CHECK)                                                                                                                                                                                                  |
| `billable_metric_id`             | uuid                          | FK `billable_metrics(id)`; NULL si `fixed`                                                                                                                                                                                                                              |
| `unit_amount`                    | numeric(18,6)                 | `standard` y `seat`: precio por unidad **del período** (no mensual, ver §4.1)                                                                                                                                                                                           |
| `tiers`                          | jsonb                         | `graduated`/`volume`: `[{from, to, per_unit_amount, flat_amount}]`; validación §3.1                                                                                                                                                                                     |
| `package_size`, `package_amount` | numeric(18,6) / numeric(18,2) | `package`: bloque de N unidades y su precio; ambos > 0                                                                                                                                                                                                                  |
| `seat_minimum_quantity`          | numeric(18,6)                 | `seat`: asientos mínimos cobrados (default 0)                                                                                                                                                                                                                           |
| `free_units`                     | numeric(18,6)                 | Unidades gratis por período (default 0)                                                                                                                                                                                                                                 |
| `minimum_amount`                 | numeric(18,2)                 | Mínimo comprometido por período con true-up; NULL = sin mínimo                                                                                                                                                                                                          |
| `cap_amount`                     | numeric(18,2)                 | Tope máximo por período; NULL = sin tope; CHECK `cap >= minimum`                                                                                                                                                                                                        |
| `invoice_line_mode`              | text                          | NOT NULL default `single`; CHECK `single \| per_tier`. Presentación en la factura (§3.8): una línea con el detalle en la glosa, o una línea por tramo más los ajustes                                                                                                   |
| `charge_flat_when_free`          | boolean                       | NOT NULL default `false`. `graduated`/`volume`: cobrar el cargo fijo del tramo aunque todo el consumo caiga en unidades gratis (§3.5)                                                                                                                                   |
| `status`                         | text                          | CHECK `draft \| active \| archived`; `contract` nace `active`; `catalog` nace `draft` y pasa a `active` con `POST /prices/:id/publish`                                                                                                                                  |
| `version`                        | int                           | Default 1; en catálogo = `max(version)` de la cadena producto + moneda + 1; en contrato sube con cada `supersedes_price_id`                                                                                                                                             |
| `supersedes_price_id`            | uuid                          | FK `prices(id)`; versión anterior. Un precio referenciado por ítems no se edita: se crea la versión siguiente. En catálogo lo fija `publish` (la activa anterior queda `archived`) o `new-version`                                                                      |
| `list_price_id`                  | uuid                          | FK `prices(id)`; en `owner = contract`, el precio de catálogo del que salió la copia (descuento efectivo explícito, A.2). NULL en precios inline. El contrato **nunca** apunta a la fila del catálogo: cambios posteriores del catálogo no alteran contratos existentes |
| `notes`                          | text                          | Catálogo: nota interna de la versión (qué cambió, para quién aplica)                                                                                                                                                                                                    |
| auditoría                        |                               | `created_*`, `updated_*`, `published_at`, `archived_at`                                                                                                                                                                                                                 |

Índices: (`holding_id`, `product_id`, `status`), (`contract_id`) parcial `WHERE owner = 'contract'`, (`billable_metric_id`).
Se mantiene `products.default_price` para el precio simple de hoy; el catálogo versionado vive en `prices.owner = catalog` (etapa 3).

### 2.3 `consumption_entries` — el consumo de un ítem en un período

| Columna                                         | Tipo          | Regla                                                                                                                                                                                                                |
| ----------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                            | uuid PK       |                                                                                                                                                                                                                      |
| `holding_id`, `contract_id`, `contract_item_id` | uuid          | FKs; `contract_item_id` → `contract_items(id) ON DELETE CASCADE`                                                                                                                                                     |
| `period_start`, `period_end`                    | date          | **Período de servicio** de la línea a la que alimenta (= `invoice_items.billing_period_start/end`, S7 §1); no la fecha de emisión                                                                                    |
| `quantity`                                      | numeric(18,6) | NOT NULL, CHECK `>= 0`; 0 significa "sin consumo" y deja la línea en 0 (nunca cobra la cantidad base, Medios #2)                                                                                                     |
| `amount_override`                               | numeric(18,2) | **Supuesto**: monto final informado por el cliente (S7 §7); si viene, la línea usa este monto y `quantity` queda informativa                                                                                         |
| `apply_item_discount`                           | boolean       | Default `true` (S7-9): el descuento del ítem se aplica sobre el consumo                                                                                                                                              |
| `account`                                       | text          | Cuenta del período si difiere de la del ítem (hoy `quantities.account`, DWH)                                                                                                                                         |
| `is_estimated`                                  | boolean       | Default `false`; `true` = fila estimada al cierre (benchmark consumo §1), se reemplaza al llegar el real                                                                                                             |
| `source`                                        | text          | CHECK `manual \| csv \| dwh \| api`                                                                                                                                                                                  |
| `idempotency_key`                               | text          | UNIQUE (`holding_id`, `idempotency_key`) parcial `WHERE NOT NULL`; el DWH y la API reenvían sin duplicar                                                                                                             |
| `revision`                                      | int           | Default 1; sube en cada corrección                                                                                                                                                                                   |
| `correction_reason`, `notes`                    | text          | Motivo obligatorio desde la revisión 2                                                                                                                                                                               |
| `invoice_id`                                    | uuid          | FK `invoices(id) ON DELETE SET NULL`; índice parcial. **Qué factura lleva este consumo**: la Por Emitir recalculada (§4.3), la complementaria o la reemitida (§4.4). NULL si el período solo tenía facturas anuladas |
| auditoría                                       |               | `created_*`, `updated_*`                                                                                                                                                                                             |

Constraint pedido: **UNIQUE (`contract_item_id`, `period_start`)** — una fila vigente por ítem y período. Para no perder la
versión anterior (decisión S7 24-09: nunca update destructivo sin rastro), cada corrección escribe además en
`consumption_entry_revisions` (append-only: `entry_id`, `revision`, `quantity`, `amount_override`, `apply_item_discount`,
`source`, `reason`, `changed_by`, `changed_at`). Factura, RSM, reportes y DWH leen solo `consumption_entries`; la pestaña
Consumos muestra el historial desde las revisiones.

### 2.4 Cambios en tablas existentes

| Cambio                                              | Para qué                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract_items.price_id uuid NULL` FK `prices(id)` | El ítem apunta a su modelo de precio. NULL = `standard` fijo de hoy (`unit_price` mensual × cantidad × meses)                                                                                                                                                                                      |
| `invoice_items.pricing_breakdown jsonb NULL`        | Sublíneas del desglose (§3.6) tal como las produjo el motor. Con `invoice_line_mode = single` la línea sigue siendo una (`quantity`, `unit_price` efectivo, `subtotal`), así ningún lector actual (RSM, Odoo, reportes, front viejo) cambia; con `per_tier` cada fila lleva su sub-desglose (§3.8) |
| `invoice_items.quantity_source text NULL`           | CHECK `fixed \| consumption \| estimated \| pending`; `pending` = línea metered sin consumo informado                                                                                                                                                                                              |
| `contract_lifecycle_events.type`                    | Nuevos: `CONSUMPTION_RECORDED`, `CONSUMPTION_CORRECTED`, `CONSUMPTION_ADDITIONAL_INVOICE`, `CONSUMPTION_REISSUE`, `PRICE_CHANGED`                                                                                                                                                                  |

Ningún trigger nuevo: la lógica vive en la API, con `SET LOCAL sapira.writer = 'api'` (costura del mapa §1.3) para que
`standardize_invoice_items` no pise cantidad/unitario/subtotal de las líneas con desglose.

## 3. Reglas de cálculo

Orden fijo de aplicación (Orb): **unidades gratis → modelo/tramos → descuento del ítem → mínimo comprometido → tope**.
Todo se calcula sobre la cantidad del período de la línea; el resultado es un `subtotal` a 2 decimales.

### 3.1 Validación de tramos

`from` del primer tramo = 1; cada `from` = `to` anterior + 1 (sin huecos ni solapes; el wizard los calcula solos, mockup 4a);
el último `to` es `null` (∞); `per_unit_amount >= 0`, `flat_amount >= 0`; al menos un tramo. El motor rechaza tramos
inválidos con `errors[{ field: 'tiers[i].from', message }]`.

### 3.2 `graduated` vs `volume` (ejemplo de 12 unidades, benchmark §2)

Tramos que reproducen los totales citados de Stripe: 1–5 a 13,00 · 6–10 a 7,00 · 11+ a 5,50, sin cargo fijo.

| Modelo                               | Cálculo                                                            | Total      |
| ------------------------------------ | ------------------------------------------------------------------ | ---------- |
| `graduated` (cada tramo a su precio) | 5 × 13,00 + 5 × 7,00 + 2 × 5,50 = 65,00 + 35,00 + 11,00            | **111,00** |
| `volume` (todo al tramo alcanzado)   | 12 unidades caen en 11+ → 12 × 5,50 (+ `flat_amount` de ese tramo) | **66,00**  |

En `graduated` el `flat_amount` de un tramo se cobra una vez si el tramo tiene al menos una unidad tarifada; en `volume` solo
el del tramo alcanzado.

### 3.3 `package` (redondeo hacia arriba)

`paquetes = ceil(cantidad_tarifada / package_size)`; `subtotal = paquetes × package_amount`. Ejemplo: bloques de 1.000 rutas a
25,00; consumo 2.350 → `ceil(2,35) = 3` → **75,00**. Consumo 0 → 0 paquetes → 0,00 (si hay mínimo, cobra el mínimo).

### 3.4 `seat` (agregación `max` o `last`)

La métrica del asiento usa `max` (pico del período) o `last` (foto al cierre); `cantidad = max(valor_agregado,
seat_minimum_quantity)`; `subtotal = cantidad × unit_amount`. Ejemplo: 12,00 por asiento, mínimo 10, valores del mes 8 → 11 → 9:
con `max` = 11 → **132,00**; con `last` = 9 → se cobra el mínimo 10 → **120,00**. En etapa 2 la usuaria registra el valor ya
agregado del período (una fila); el detalle por evento llega con el canal DWH/API.

### 3.5 Unidades gratis, mínimo y tope (precio del mockup 2b/4a)

Tramos: 1–500 a 0,08 + fijo 10,00 · 501–2.000 a 0,06 · 2.001+ a 0,045 · 100 unidades gratis · descuento del ítem −10 % ·
mínimo UF 50 · tope UF 80. Las unidades gratis ocupan las **primeras posiciones del primer tramo** (mockup: "Gratis · 100" y
luego "400 × 0,08 + fijo 10").

| Caso        | Sublíneas                                                                                                           | Subtotal                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1.250 rutas | gratis 100 → 0,00 · tramo 1: 400 × 0,08 + 10 = 42,00 · tramo 2: 750 × 0,06 = 45,00 · descuento −10 % = −8,70        | **78,30** (igual al mockup; sobre el mínimo, bajo el tope) |
| 300 rutas   | gratis 100 · tramo 1: 200 × 0,08 + 10 = 26,00 · descuento −2,60 = 23,40 · **ajuste por mínimo comprometido +26,60** | **50,00**                                                  |
| 1.400 rutas | gratis 100 · tramo 1: 42,00 · tramo 2: 900 × 0,06 = 54,00 · descuento −9,60 = 86,40 · **tope máximo −6,40**         | **80,00**                                                  |

El mínimo es **por período de la línea** (**Supuesto**, ver pregunta 1) y su ajuste es una sublínea `minimum`, nunca una línea
aparte: así la factura muestra "Rutas optimizadas … UF 50,00" con el detalle debajo (mockup 3c: "Mínimo comprometido ·
cubierto / no se factura diferencia").

**Cargo fijo con todo el consumo en unidades gratis** (pregunta 5, configurable por precio con `charge_flat_when_free`,
default `false`). Ejemplo: mismo precio con 500 gratis y 300 rutas en el período, sin mínimo ni tope.

| `charge_flat_when_free` | Sublíneas                                                                                                                           | Subtotal |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `false` (default)       | gratis 300 → 0,00 (el tramo 1 no tiene unidades tarifadas: su cargo fijo no se cobra)                                               | **0,00** |
| `true`                  | gratis 300 → 0,00 · tramo 1: 0 unidades + fijo 10,00 (`quantity 0`, label "Tramo 1 (1–500) - cargo fijo") · descuento −10 % = −1,00 | **9,00** |

Solo aplica con consumo mayor que 0 (con 0 = "sin consumo" la línea queda en 0) y solo cuando **ninguna** unidad quedó tarifada;
si el tramo 1 quedó cubierto por las gratis pero el tramo 2 tiene unidades, el cargo fijo del tramo 1 no se cobra en ningún
caso (misma regla de hoy). En `graduated` es el cargo fijo del primer tramo; en `volume`, el del tramo que alcanza la cantidad
total. Con mínimo comprometido, manda el mínimo (50,00 en ambos casos). `validatePriceSpec` rechaza `true` en modelos sin tramos.

### 3.6 Redondeo y desglose

-   Cada sublínea se calcula con precisión completa y se muestra a 2 decimales; el `subtotal` de la línea = `round2(Σ sublíneas
sin redondear)`; el **residuo va a la última sublínea de tramo** (misma regla S1-11 de las cuotas: "la diferencia en la
    última"). Ejemplo: tres tramos de 1/3 → 0,33 + 0,33 + 0,34 = 1,00.
-   `invoice_items.quantity` = cantidad del período (consumo, no la tarifada); `unit_price` = `round6(subtotal / quantity)`
    (0 si la cantidad es 0); `subtotal` y `pricing_breakdown` con las sublíneas `{kind: free|tier|package|seat|discount|minimum|cap,
tier_index?, from?, to?, quantity, unit_amount?, flat_amount?, amount, label}`. IVA y total como hoy (`round2`).
-   Cómo se muestra en el DTE (una línea con anexo o una línea por tramo) se decide en el mapa de Facturación (pregunta 2).

### 3.7 Cantidad del período

`fixed` → `contract_items.quantity` (o la del precio `seat` mínima). `metered` → `consumption_entries` del ítem con
`period_start` = inicio del período de la línea; si no hay → `quantity_source = pending` y la línea usa la **cantidad base del
ítem** (`contract_items.quantity`, hoy el valor que hereda un mes sin override) con advertencia (**Supuesto**, pregunta 3).
`amount_override` presente → el subtotal es ese monto (menos descuento si `apply_item_discount`), sin tramos. Un ítem `metered`
es **Vencido** en etapa 1 (400 si viene Anticipado, salvo `seat`, pregunta 6). Para líneas trimestrales o anuales, un solo
consumo por período de la línea (el agregado del trimestre), no uno por mes.

### 3.8 Presentación en la factura (`invoice_line_mode`, pregunta 2)

Se decide **por precio** (`prices.invoice_line_mode`, default `single`); el motor calcula igual en los dos modos y solo cambia
cómo se escriben las filas de `invoice_items`. Ejemplo con el precio del mockup y 1.250 rutas (78,30):

| Modo               | Filas de `invoice_items`                                                                                                                                                                                                                                                                                                                                                                                           | Glosa                                                                                                                                                                                                                                                                                             | `pricing_breakdown`                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `single` (default) | **Una**: `quantity` = 1.250 (cantidad del período), `unit_price` = 0,06264 (efectivo), `subtotal` 78,30                                                                                                                                                                                                                                                                                                            | Glosa base + detalle compacto en ASCII: `Rutas optimizadas - Periodo 01/10/2026 a 31/10/2026 - Tramos: gratis 100; 101-500 x 0,08 + fijo 10,00; 501-1.250 x 0,06; descuento -8,70` (`pricingGlosa`; rangos reales, las gratis corren el primer tramo; `minimo comprometido +26,60`, `tope -6,40`) | El desglose completo                                                                                                                                                                                                                                  |
| `per_tier`         | **Una por sublínea de cargo** (tramo/paquete/asiento: `quantity` = unidades de la sublínea, `unit_price` = monto / unidades con el cargo fijo incluido) **más una por ajuste** (descuento, mínimo, tope: `quantity` 1, `unit_price` = monto, negativo o positivo): `400 × 0,105 = 42,00` · `750 × 0,06 = 45,00` · `1 × −8,70`. Todas con el mismo `contract_item_id` (patrón B), mismo período y `quantity_source` | `Glosa base - <label de la sublínea>` ("… - Tramo 1 (1-500)", "… - Descuento del ítem 10 %")                                                                                                                                                                                                      | Cada fila lleva **su** sublínea con `period_quantity` (1.250), `line_index` y `line_count`; la primera fila suma las sublíneas `free` para que la glosa las muestre. Sin cargos ni ajustes (todo gratis): una sola fila en 0 con el desglose completo |

Reglas comunes: Σ filas = `subtotal` de la línea lógica (el residuo del redondeo ya viene en la última sublínea de tramo, §3.6);
el IVA se reparte por fila con `round2(fila × tasa)` y el residuo contra `round2(subtotal × tasa)` va a la última fila de cargo
(`distributeTax`), así el encabezado (= Σ filas) coincide con el de `single`. El generador (`generateInvoices`) emite las filas
`per_tier` como líneas del preview con `line_group = item_key|period_start` y `line_part { part: charge|adjustment, index,
count }`; la activación las persiste tal cual. El recálculo por consumo (§4.3) reescribe la fila en `single` (glosa base
conservada + detalle nuevo; si la glosa fue editada a mano se respeta la base) y **reemplaza el conjunto** en `per_tier`
(DELETE de las filas del ítem y período en esa factura + INSERT con patrón B). Cambiar el modo en el borrador crea una versión
nueva del precio (`samePriceSpec` lo compara). Los lectores (`GET /:id/consumption`, 360) agrupan las filas `per_tier` de un
mismo ítem, período y factura en una línea lógica (`groupConsumptionLines`: cantidad del período, Σ subtotal, desglose
concatenado, `line_ids`).

## 4. Integración con `billing-engine.ts`, activación y Por Emitir

### 4.1 Nuevas piezas puras (mismo archivo o `pricing-engine.ts` junto a él)

```ts
export interface PriceSpec {
	model: 'standard' | 'graduated' | 'volume' | 'package' | 'seat';
	quantity_type: 'fixed' | 'metered';
	billable_metric_id?: string | null;
	unit_amount?: number | null; // standard, seat (por período)
	tiers?: Array<{ from: number; to: number | null; per_unit_amount: number; flat_amount: number }>;
	package_size?: number | null;
	package_amount?: number | null;
	seat_minimum_quantity?: number | null;
	free_units?: number | null;
	minimum_amount?: number | null;
	cap_amount?: number | null;
	invoice_line_mode?: 'single' | 'per_tier'; // §3.8, default single
	charge_flat_when_free?: boolean; // §3.5, default false (solo graduated/volume)
}
export interface ConsumptionInput {
	period_start: string;
	quantity: number;
	amount_override?: number | null;
	apply_item_discount?: boolean;
	is_estimated?: boolean;
}
export interface ResolvedQuantity {
	quantity: number;
	source: 'fixed' | 'consumption' | 'estimated' | 'pending';
	amount_override: number | null;
	apply_item_discount: boolean;
}
export interface PricedLine {
	quantity: number;
	quantity_source: ResolvedQuantity['source'];
	billable_quantity: number;
	subtotal: number;
	effective_unit_price: number;
	breakdown: Array<{
		kind: 'free' | 'tier' | 'package' | 'seat' | 'discount' | 'minimum' | 'cap';
		tier_index?: number;
		from?: number;
		to?: number | null;
		quantity: number;
		unit_amount?: number;
		flat_amount?: number;
		amount: number;
		label: string;
	}>;
	warnings: string[];
}

/** Cantidad de la línea para un período: fija, del consumo registrado, estimada o pendiente (§3.7). */
export function resolveQuantity(
	item: Pick<BillingEngineItem, 'quantity' | 'price'>,
	period: { start: string; end: string },
	entries: ConsumptionInput[]
): ResolvedQuantity;
/** Aplica gratis → modelo → descuento → mínimo → tope y redondea (§3). Pura: sin fechas ni base. */
export function priceLine(
	price: PriceSpec,
	quantity: number,
	discountPct: number,
	options?: { amount_override?: number | null; apply_item_discount?: boolean }
): PricedLine;
/** Valida tramos (§3.1) y coherencia del modelo; devuelve `errors[{ field, message }]`. */
export function validatePriceSpec(price: PriceSpec): Array<{ field: string; message: string }>;
```

`BillingEngineItem` suma `price?: PriceSpec | null` y `consumption?: ConsumptionInput[]`; `PreviewLine` suma `pricing?:
PricedLine`. `generateInvoices` no cambia para ítems sin `price` (o `standard` + `fixed`): sigue `monthlyNet × meses` y el
residuo en la última cuota. Con `price` distinto de ese caso, cada cuota llama `resolveQuantity` → `priceLine` y la línea
lleva `quantity_source` y `pricing.breakdown`; `totals.contract_value` suma solo lo `fixed` (el consumo no es valor
contratado; con mínimo, suma el mínimo por período — **Supuesto**). El `unit_amount` de `standard`/`seat` es **por período**
de la línea (no mensual) porque la cantidad es del período; el wizard lo deja claro.

### 4.2 Preview y activación

-   `POST /contracts/preview` (existente) ya devuelve las facturas con las líneas priced; las `pending` salen con advertencia
    "Consumo por informar: se recalcula al registrar".
-   `POST /contracts/activate` (C2) persiste exactamente el preview: línea con `quantity_source`, `pricing_breakdown`,
    encabezado = Σ líneas, FX fijo por período si aplica; `sapira.writer = 'api'`. El precio `owner = contract` se crea en la misma
    transacción del borrador (C1) y `contract_items.price_id` queda fijado.

### 4.3 Recalcular la Por Emitir al registrar consumo (etapa 2)

Al crear o corregir una `consumption_entry` (una transacción):

1. Buscar las líneas del ítem con `billing_period_start` en `[period_start, period_end]` en facturas **Por Emitir activas**,
   de tipo factura (no NC, U13/B4), no unificadas ni legacy.
2. Si hay una: `priceLine` con el consumo → según `invoice_line_mode` (§3.8): en `single` actualizar `quantity`, `unit_price`,
   `subtotal`, `tax_amount`, `total`, `pricing_breakdown`, `description` (glosa base + detalle) y `quantity_source =
consumption`; en `per_tier` borrar las filas del ítem y período en esa factura e insertar las nuevas (patrón B). Encabezado
   = Σ líneas; si la factura tiene FX fijo, montos en moneda de factura con su tasa (nunca clonada). Las demás líneas y las
   ediciones manuales de otras líneas no se tocan. La entry guarda `invoice_id` = esa Por Emitir. Si la Por Emitir del
   período es una **complementaria** (§4.4), se recalcula solo la **diferencia** contra la factura a la que complementa
   (emitida, o la Por Emitir del período si nació con `apply_as = additional`).
   **Ítems estándar** (sin modelo de precio, decisión Domi 29-09): también aceptan cantidad mientras la factura del período
   esté Por Emitir. La entry se guarda igual (revisiones, evento) y la línea queda como con las "cantidades variables" del
   front viejo: `quantity` = la informada, `unit_price` = el unitario del período que dejó la activación en la línea (si falta,
   el del ítem), descuento el de la línea, `subtotal`/IVA/total recalculados, `quantity_source = consumption`,
   `pricing_breakdown` = una sublínea `tier` "Por unidad" (más el descuento); la glosa **no** cambia (`priceStandardLine`).
3. `revenue_schedule_rebuild(contrato, mes del período)`; evento `CONSUMPTION_RECORDED` / `CONSUMPTION_CORRECTED` con
   usuario, fuente, cantidad anterior y nueva, motivo.
4. Si la única factura del período está **emitida y no anulada**, decide `apply_as` del body (§4.4). Con `recompute`
   (default) → 409 `consumption_period_issued` con el mensaje "La factura F-xxxx del período ya fue emitida: anula y reemite,
   o registra el consumo adicional" (S7-7/S7-8), más `issued_invoice`, `additional_amount`, `additional_allowed`,
   `additional_reason` y `options[]`. En un ítem estándar el 409 es `item_not_metered` (mismo `invoice` y `options[]`): la
   cantidad solo entra como `additional` o `reissue`. No se escribe nada. Al anular una factura, la entry del período conserva
   su valor: la Por Emitir de reemplazo se recalcula con ella.
5. Si no hay ninguna línea del período (ítem terminado, período fuera del ítem) → 409 `period_out_of_item`.

**No se toca nunca**: facturas emitidas, canceladas, NC/ND, períodos cerrados (guard existente), líneas de otros ítems.

**Etapa 4 de facturas en el 360 (30-09,** [`spec-facturas-en-contrato-360.md`](./spec-facturas-en-contrato-360.md) **§3.4):**
- Una fila del ítem en la Por Emitir **editada a mano** (`quantity_source = 'manual'`) no se recalcula: la entry se guarda, la factura no
  cambia y la respuesta trae `warning_codes: ['manual_edit_kept']` (el conciliador de desvíos de la factura muestra la diferencia).
- `per_tier`: al reinsertar las filas se conserva una glosa protegida (`description_locked`) en la fila del mismo tramo (`line_index`; una
  fila única anterior cuenta como la 0).
- **Sin cobro**: si con el consumo TODAS las líneas de la factura quedan en 0 (cantidad y monto), pasa a `Cancelada` con `INVOICE_NO_CHARGE`
  (`reason: zero_consumption`; líneas conservadas; `warning_codes: ['becomes_no_charge']`, `invoice.status = 'Cancelada'`). Un consumo > 0 en
  un período cuya factura está sin cobro (y sin Por Emitir ni emitida) la devuelve a Por Emitir recalculada con `INVOICE_NO_CHARGE_REVERTED`
  (`warning_codes: ['no_charge_reverted']`). Una Por Emitir con borrador en el ERP que quedaría sin cobro → 409 `sent_to_erp_draft` (con
  `action: 'erp_reset'`). Otras canceladas nunca se reactivan (siguen como `void_only`).
- Una línea con cantidad 0 con mínimo comprometido (monto > 0) **no** cuenta como "en 0" para sin cobro.

### 4.4 Cómo se aplica la cantidad (`apply_as`, pregunta 4 y S7-8)

El PUT y el preview aceptan `apply_as?: 'recompute' | 'additional' | 'reissue'` (default `recompute`). `on_issued` sigue
aceptándose como alias (`block` = `recompute`; si vienen los dos manda `apply_as`) y la respuesta devuelve ambos. La
importación masiva no lo acepta: ninguna fila salta la regla 4. Una emitida **nunca se modifica**; en `additional` y `reissue`
se escriben la entry (revisión +1 con motivo si ya existía, `invoice_id` = la factura nueva), su revisión,
`revenue_schedule_rebuild(contrato, mes)` y el evento.

**Con la factura del período Por Emitir** (decisión Domi 29-09): `recompute` = §4.3 (hoy); `additional` = la Por Emitir del
período **no se toca** y se crea una factura nueva Por Emitir con **una línea** por la diferencia entre el nuevo cálculo y lo
que la del período ya lleva para el ítem (más lo que lleve la emitida a la que complemente, si es una complementaria):
`issue_date = hoy` (día del registro), vencimiento con la condición de pago del contrato, clon del encabezado de la Por Emitir
(receptor, emisor, monedas, FX según política), mismos vínculos que la complementaria de una emitida (`notes` "…sobre la
factura Por Emitir X: N informados, M ya incluidos", sublínea `invoiced` "Ya incluido en …" con `invoice_id`,
`consumption_entries.invoice_id`, evento `CONSUMPTION_ADDITIONAL_INVOICE` con `complements_invoice_status`); diferencia ≤ 0 →
400 `no_additional_consumption` ("…usa recalcular (apply_as = recompute)"). Una corrección posterior del período recalcula
la complementaria por la diferencia (entre varias Por Emitir gana la complementaria). `reissue` con la Por Emitir equivale a
`recompute` con aviso. Preview soporta los tres.

**Con la factura del período emitida:**

| `apply_as` (`on_issued`) | Qué hace                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Evento                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `recompute` (`block`)    | 409 explicado (regla 4; `item_not_metered` en ítems estándar). El body trae la emitida y si la complementaria es posible, para que la pantalla ofrezca las dos salidas sin otra llamada                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | —                                |
| `additional`             | **Factura complementaria** Por Emitir del **mismo período**: clon de la emitida (compañía, cliente, razón social, monedas, emisor, condiciones, `requires_references_for_billing`, `auto_invoice`, términos), `document_type` del contrato (o el de la emitida), FX según política (misma moneda → 1; `fixed` → la tasa de la emitida; spot → NULL), fechas de hoy y vencimiento con la condición de pago. `invoice_type = 'Automatica'` (el CHECK de `invoices` no admite "Complementaria"): el vínculo va en `notes` ("Consumo adicional del período P sobre F-xxxx: N informados, M ya facturados"), en la sublínea `invoiced` del desglose (`invoice_id` de la emitida), en `consumption_entries.invoice_id` y en el evento. **Una sola línea**: `subtotal` = nuevo cálculo − Σ lo ya facturado del ítem en ese período; `quantity` = unidades adicionales (o 1 si el consumo no subió pero el monto sí), `unit_price` = diferencia / cantidad; `pricing_breakdown` = el desglose nuevo completo + `{ kind: 'invoiced', amount: −ya facturado, invoice_id }`. Si la diferencia ≤ 0 → 400 `no_additional_consumption` ("…usa reemplazar (apply_as = reissue)"). En ítems estándar la diferencia sale de cantidad × unitario del período. Una corrección posterior del mismo período recalcula la complementaria **por la diferencia** (§4.3 paso 2) | `CONSUMPTION_ADDITIONAL_INVOICE` |
| `reissue`                | **NC espejo** de la emitida completa (misma función que usan las modificaciones, `insertMirrorCreditNote`: ratio 1 en todas las líneas, montos negativos, `credit_type = cancellation`, `credit_reason = issue_error`, nace Por Emitir según el supuesto vigente) **más una factura nueva Por Emitir** del período con **todas** las líneas de la emitida: las de otros ítems copiadas tal cual (montos en moneda de factura con el FX de la nueva) y las de este ítem reemplazadas por las recalculadas (según `invoice_line_mode`). Vínculo viejo → nuevo en `notes` ("Reemisión de F-xxxx por consumo corregido…"), en el evento (`cancelled_invoice_id`, `credit_note_id`) y en `consumption_entries.invoice_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `CONSUMPTION_REISSUE`            |

Respuesta del PUT y del preview (misma forma; el preview no escribe y devuelve `id: null` en lo que se crearía):

```ts
{
	entry, line, lines[],                   // línea lógica y filas de factura (§3.8); en additional, la fila única de la complementaria
	invoice,                                // la que lleva el consumo: Por Emitir recalculada, complementaria o reemitida
	event, mode: 'recompute' | 'none' | 'additional' | 'reissue',
	apply_as: 'recompute' | 'additional' | 'reissue', on_issued,  // eco del body; on_issued = alias (block = recompute)
	complements_invoice: { id, invoice_number, status, issue_date } | null,  // additional: la factura a la que complementa (emitida o Por Emitir)
	issued_invoice: { id, invoice_number, status, issue_date, total, currency } | null,
	additional_amount: number | null,       // nuevo cálculo − ya facturado
	additional_allowed: boolean, additional_reason: string | null,
	credit_note: { id, number, total } | null, cancelled_invoice: { id, invoice_number } | null,   // solo reissue
	created: { invoice_id?, credit_note_id?, invoice_number? },
	warnings, idempotent
}
```

`GET /contracts/:id/consumption` lista **todos** los ítems (los estándar con `uses_usage_pricing: false`) con sus períodos y
`accepts_consumption: true` cuando la factura del período está Por Emitir; `pending[]` sigue siendo solo de ítems medidos y
`uses_usage_pricing` del contrato no cambia. Marca la factura de cada fila y período con `invoice.is_complementary` y
`invoice.complements_invoice_id` (desde la sublínea `invoiced`); la entry se cruza con la factura de su `invoice_id`.

### 4.4.1 Reglas transversales del consumo (auditoría 01-10, construido)

- `write()` bloquea el contrato (`FOR UPDATE`) inmediatamente después de la costura, antes de leer ítem, líneas y consumo.
- **Período cerrado**: si el período de la línea (`period_start`) o la emisión de la factura que lleva el consumo (la Por Emitir recalculada,
  o la complementaria/reemisión de hoy) caen en un período cerrado (`get_cutoff_date`) → 409 `blocked` con `period_closed`; el preview igual.
- **Borrador en el ERP**: ya no bloquea (tampoco al pasar a "sin cobro"); se recalcula y se avisa `erp_draft_stale` en preview y resultado
  (`warning_codes`).
- **Reemisión** (`apply_as = reissue`): la NC espejo es exacta (`insertMirrorCreditNote` con `exact: true`: copia el IVA guardado de cada
  línea) y la factura nueva copia `description_locked` (las otras líneas y la del ítem en `single`; por tramo en `per_tier`).
- El historial de una factura incluye los eventos que la nombran como `created_credit_notes`, `credit_note_id`, `cancelled_invoice_id` o
  `complements_invoice_id`.
- Modificaciones de contrato sobre líneas con consumo: ver `spec-modificaciones-contrato-v2.md` §4.1 (la cantidad registrada se conserva).
- Preview del borrador (`POST /contracts/preview` y `GET /contracts/:id/invoices/preview`): el motor recibe plantilla de glosa, contexto,
  límite del documento y los consumos ya registrados, igual que la activación.

### 4.5 Devengo de ítems variables (pendiente)

**Hallazgo (29-09, CTR-2026-142):** el RSM legado (`revenue_schedule_rebuild`) devenga solo el MRR base del ítem (19,62 plano
por mes) e ignora las cantidades variables facturadas, así que en el Contrato 360 "Devengado a la fecha (MRR base)" queda
por debajo de lo facturado y el widget lo avisa ("Los consumos variables aún no entran al devengo"). **Sin código todavía.**

Regla a implementar: el devengo de un ítem variable en un período de servicio = **el monto facturado para ese período**
(Σ de sus líneas de factura, complementarias incluidas, en moneda del contrato). Una Por Emitir cuenta como **estimado**
hasta emitirse (se marca así en el RSM); una corrección de consumo (§4.3/§4.4, cualquier `apply_as`) **re-devenga el
período** con el nuevo monto, nunca el siguiente. Los ítems estándar siguen con el MRR base. Se implementa en la API
(servicio propio que escribe `revenue_schedule_monthly` para los ítems medidos) **sin tocar la función legada del RSM**
hasta el switch; hasta entonces `overview.financial.recognized_to_date` sigue siendo el MRR base y el front lo dice.

## 5. API (todo tras `SupabaseAuthGuard` + `HoldingScopeGuard` + `@HoldingId()`, body validado con DTO espejo en la BFF)

| Método y ruta                                                                                                                 | Etapa | Qué hace                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /billable-metrics` · `POST /billable-metrics` · `GET/PATCH /billable-metrics/:id` · `POST /billable-metrics/:id/archive` | 1     | CRUD por holding; `GET` incluye `prices_count` y `last_sync_at`; archivar con precios activos → 409                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST /contracts` y `PUT /contracts/:id`                                                                                      | 1 → 3 | `items[].price?: PriceSpecDto` (inline, `owner = contract`) o `items[].price_id` (catálogo, etapa 3 ✅): el catálogo debe estar `active`, ser del mismo producto y de la moneda del contrato (400 `items.N.price_id`); no se combinan (400). El contrato recibe su **copia** (`owner = contract`, v1, `list_price_id`, nombre del catálogo). `GET /:id/form` devuelve `price` (la copia) y `list_price_id`; en PUT, cambiar de catálogo o de spec crea la versión siguiente de la copia. Sin ambos = standard fijo. `metered` + `Anticipado` → 400 salvo `seat` (también con catálogo). Mismo `price_id` en `item_add` (`POST /contracts/:id/changes`) |
| `POST /contracts/price-preview`                                                                                               | 1     | Body `{ price: PriceSpecDto, discount_pct?, quantities: number[] }` → `PricedLine[]` (uno por cantidad simulada); alimenta la vista previa en vivo del wizard sin guardar. `PriceSpecDto` incluye `invoice_line_mode` y `charge_flat_when_free`                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET /contracts/:id/consumption`                                                                                              | 1→2   | Existente; pasa a leer `consumption_entries` y `uses_usage_pricing` = existe ítem con `quantity_type = metered`; filas con `quantity_source`, `pricing_breakdown` de la línea, factura del período y estado, `revision`, `source`, `is_estimated`; `items[]` con `uses_usage_pricing` y `metric`                                                                                                                                                                                                                                                                                                                                                       |
| `PUT /contracts/:id/items/:itemId/consumption/:periodStart`                                                                   | 2     | Upsert idempotente `{ quantity, amount_override?, apply_item_discount?, account?, notes?, correction_reason? (obligatorio si ya existe), idempotency_key?, on_issued? }` → aplica §4.3 (o §4.4 si la factura está emitida) y devuelve `line`, `lines[]`, la factura que lleva el consumo y los campos de §4.4                                                                                                                                                                                                                                                                                                                                          |
| `POST /contracts/:id/consumption/preview`                                                                                     | 2     | Mismo body que el PUT, sin escribir: misma respuesta (lo que se crearía con `id: null`) o el 409/400 explicado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `POST /contracts/:id/consumption/bulk`                                                                                        | 2     | `{ rows: [{ item_id \| product_name + account, period_start, quantity, amount_override?, notes? }] }` (1–500, desde CSV): una transacción por fila, respuesta `{ applied, skipped[{ row, reason }] }`; ninguna fila salta la regla 4                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /consumption/pending?period=YYYY-MM&client_id&company_id`                                                                | 2     | "Pendientes de informar": líneas `metered` con período de servicio terminado y `quantity_source = pending`, con contrato, ítem, métrica, factura Por Emitir y su fecha de emisión; paginado `{ data, total, currentPage, pages, limit }`                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /prices?owner=catalog&status=active\|draft\|archived\|all&product_id&currency&model&search&sortBy&sortOrder&page&limit`  | 3 ✅  | Catálogo del holding paginado `{ data, total, currentPage, pages, limit }`; orden por lista blanca (`name`, `product_name`, `currency`, `model`, `version`, `status`, `contracts_count`, `updated_at`). Cada fila: `{ id, name, product_id, product_name, currency, model, quantity_type, billable_metric: { id, code, name, unit } \| null, version, status, supersedes_price_id, contracts_count, notes, published_at, archived_at, created_at, updated_at, spec: PriceSpec }`; `contracts_count` = contratos no eliminados con una copia del precio (`list_price_id`)                                                                               |
| `GET /prices/:id`                                                                                                             | 3 ✅  | Detalle + `versions[]` (cadena producto + moneda, la más nueva primero: `{ id, name, version, status, supersedes_price_id, contracts_count, published_at, archived_at, updated_at }`) + `contracts[]` (hasta 50: `{ contract_id, contract_number, contract_status, client_name, item_id }`)                                                                                                                                                                                                                                                                                                                                                            |
| `POST /prices` `{ name, product_id, currency, spec: PriceSpecDto, notes? }`                                                   | 3 ✅  | Borrador con `version` = siguiente de producto + moneda; 400 `errors[]` por producto ajeno, moneda no habilitada, `spec.<campo>` y métrica inexistente o archivada                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `PATCH /prices/:id` `{ name?, spec?, notes? }`                                                                                | 3 ✅  | Solo borradores (409 si está publicado o archivado); producto y moneda no cambian                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /prices/:id/publish`                                                                                                    | 3 ✅  | Borrador → `active` con `published_at`; la activa anterior de producto + moneda queda `archived` y la nueva la apunta con `supersedes_price_id` (una transacción, `FOR UPDATE`). Devuelve el detalle + `superseded_price_id`. No toca contratos. 409 si ya está publicado o archivado                                                                                                                                                                                                                                                                                                                                                                  |
| `POST /prices/:id/archive`                                                                                                    | 3 ✅  | Deja de poder elegirse; permitido con contratos que la usan (conservan su copia): detalle + `warnings[]` con `contracts_count`. Idempotente                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `POST /prices/:id/new-version` `{ name?, spec?, notes? }`                                                                     | 3 ✅  | Copia la versión como borrador con `version + 1` y `supersedes_price_id` = origen; el body reemplaza lo copiado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Errores con `message` estable y `errors[{ field, message }]` para validación (contrato de la BFF).

## 6. Pantallas (front-sapira, `/lab/contratos` y configuración del holding)

**Wizard "Nuevo contrato" › ítem › Precio** (mockups 3b y 4a, adaptados de "Nuevo precio" a precio inline del ítem). Selector
de modelo con tarjetas y una frase cada una: Fijo ("monto fijo por período, el caso de hoy"), Por unidad, Por tramos
("cada tramo a su precio, el caso SimpliRoute/ValdiShopper"), Volumen, Paquete, Asiento (Porcentaje deshabilitado: "después").
Cantidad `fija | medida`; si medida, `Combobox` de métrica con su resumen ("SUM · BigQuery DWH · corte día 1"). Cadencia y
anticipado/vencido siguen en el ítem; el copiloto sugiere Vencido para consumo. Editor de tramos (4a): tabla Desde / Hasta /
Precio unit. / Cargo fijo, "los desde se calculan solos, el último cierra en ∞", pegar desde Excel o dictar "3 tramos, 0,08
bajando 25 %". Condiciones: unidades gratis, mínimo con true-up, tope. **Vista previa en vivo** a la derecha (`POST
/contracts/price-preview` con debounce): campo "simular: 1.250 rutas", chips de tramo, sublíneas y total del período, "≈ CLP …
al FX de hoy". `PasoRevisar` muestra el modelo por ítem y las líneas `pending` del calendario con su aviso.

**Transición: cantidad fija con modelo de precio (30-09).** En régimen, un ítem con modelo de precio distinto de "Fijo" usa
una **métrica facturable** (cantidad medida). Mientras los holdings no tengan sus métricas armadas, el editor mantiene la
opción de cantidad **Fija** con cualquier modelo (tramos, volumen, paquete, asiento): el motor tarifa la cantidad del ítem en
cada período, la prorratea en períodos parciales y su mensual equivalente suma al MRR. Es **transitorio**: el editor lo avisa
con una nota ("Transitorio: en régimen, un modelo de precio usa una métrica facturable. Las métricas se pre-arman en el setup
del holding."). Insumo para el **onboarding / setup del holding** (copiloto de setup y tour de producto): pre-armar las
métricas facturables del holding (qué se mide, agregación, unidad, fuente) antes de cargar contratos con precio por consumo,
para que el alta de contratos elija métrica en vez de cantidad fija. Cuando eso exista, la opción Fija con modelo no estándar
se puede retirar o dejar solo para migraciones.

**MRR y valor en el wizard (30-09).** El "Mensual · Total" de un ítem con modelo de precio y el MRR / valor total del paso
Ítems y del panel lateral salen de la vista previa del motor (`POST /contracts/preview` → `totals.mrr`,
`totals.contract_value`, `items[].monthly_equivalent`); mientras la vista previa no llega, el ítem dice "Según modelo de
precio" y los totales usan la estimación local (que solo cuenta lo estándar).

**Contrato 360 › Consumos** (mockup 3c; solo si algún ítem es `metered`, decisión 25-09). Encabezado: ítem, precio y versión
("Tramos LatAm — UF · v2"), acciones **Registrar cantidad** e **Importar CSV**. Tabla por período: Período · Cantidad (unidad
de la métrica) · Origen (DWH / manual / corregido, con revisión) · Monto · Factura y estado · menú (corregir, ver historial).
Período en curso marcado "en curso · estimado". Panel derecho: desglose por tramo del período seleccionado (gratis, tramos,
descuento, mínimo/tope con "Cubierto / se factura diferencia"), botón "Ver precio". Aviso fijo: "Los períodos ya facturados
quedan anclados: una corrección genera ajuste o NC, nunca pisa la factura emitida". Copiloto: tendencia y "en octubre entraría
al tramo 3". Formulario Registrar cantidad: período (`Combobox` de períodos del ítem), cantidad, casilla "es el monto final: no
aplicar descuento" (S7-9), motivo si corrige, vista previa del recálculo antes de guardar.

**Configuración del holding › Métricas facturables** (mockup 3a). Lista: Métrica · Agregación (`SUM(rutas) WHERE …`) ·
Fuente · Unidad · Precios que la usan · Última sync · Estado; acciones Nueva métrica, Sincronizar ahora (canal DWH, etapa 2),
Reintentar en las fallidas; copiloto que explica una falla del DWH y ofrece reapuntar y reprocesar. Formulario: nombre, código,
agregación, unidad, fuente (manual / DWH con referencia de consulta).

**Planes y precios** (mockup 2b, etapa 3): precio de catálogo con tramos, condiciones, medición, vista previa y **versiones**
(v1 archivada, v2 activa "24 contratos", v3 borrador); "publicar v3 no toca contratos firmados". La API ya existe (§5,
`/prices`; `versions[]` y `contracts_count` alimentan la lista de versiones); la pantalla en front-sapira está pendiente.

## 7. Migración y compatibilidad

-   **Ningún dato se migra en etapa 1.** Ítems existentes: `price_id NULL` = standard fijo; el generador se comporta igual.
-   **`quantities` sigue viva y la escribe solo el front viejo** hasta el switch de Contratos; v2 la lee como hoy
    (`GET /:id/consumption`) y no la escribe. En el switch: `quantities` pasa a **solo lectura** (REVOKE INSERT/UPDATE/DELETE,
    triggers anotados "reemplazados por consumption.service") y se migran a `consumption_entries` solo los períodos **no
    emitidos o futuros** de contratos activos; los emitidos quedan como historia en `quantities` (la factura ya tiene sus montos).
-   **Canal DWH** (`sapira_quantity_imports`, `bigquery.service.ts`): hoy integra a `quantities` (0 filas integradas, B7). En
    etapa 2 pasa a escribir `consumption_entries` con `source = dwh`, `idempotency_key` = clave natural del origen, ventana de
    backfill configurable y la regla 4 de §4.3 para períodos emitidos.

| `quantities`                                    | `consumption_entries`                                                                 | Nota                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `contract_item_id`, `contract_id`, `holding_id` | iguales                                                                               |                                                                                                |
| `period` (día 1 del mes)                        | `period_start` / `period_end` de la línea cuyo mes de `billing_period_start` coincide | Con día de ciclo ≠ 1 se toma el período de la línea, no el mes calendario                      |
| `quantity`                                      | `quantity`                                                                            | NULL → no se migra (heredaba la del ítem)                                                      |
| `unit_price` (override de precio)               | **no se migra**                                                                       | El precio vive en `prices`; se lista para revisión manual (Domi): crear precio inline o ajuste |
| `amount`                                        | `amount_override`                                                                     | S7 §7 (monto final, cantidad informativa)                                                      |
| `account`, `notes`                              | `account`, `notes`                                                                    |                                                                                                |
| `created_by` (nunca lleno), `created_at`        | `created_by`, `created_at`, `source = manual`, `revision = 1`                         |                                                                                                |
| `salesforce_*`                                  | `idempotency_key` = `sf:<line_item>:<period>`                                         | Trazabilidad DWH                                                                               |

El front viejo no cambia: sus 5 triggers de `quantities` siguen operando su flujo. El fix compartido U13 (sync excluye NC) se
hace igual porque conviven.

## 8. Preguntas abiertas para Domi — estado (28-09)

| #   | Pregunta                                                                         | Estado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Mínimo comprometido**: ¿por período de la línea o acumulado anual con true-up? | **Pendiente de análisis de Domi.** Hoy está construido **por período de la línea**: en cada cuota, después de gratis → tramos → descuento, si el neto queda bajo `minimum_amount` se agrega la sublínea `minimum` por la diferencia (`priceLine`, §3.5). Ejemplo con el precio del mockup (mínimo UF 50): octubre 300 rutas → 23,40 + ajuste **+26,60** = 50,00; noviembre 1.250 rutas → 78,30 (sobre el mínimo, sin ajuste); diciembre 0 rutas → 0 + **50,00**. El año factura 178,30 y el RSM devenga cada ajuste en su mes. La **alternativa anual** (Metronome postpaid) cambiaría: (a) el mínimo se declara por período de compromiso (p. ej. UF 600/año) y ninguna cuota lleva ajuste; (b) al cierre del compromiso se compara Σ consumo facturado con el mínimo y, si falta, se emite **una línea de true-up** por la diferencia (en el ejemplo: 3 cuotas = 101,70 → true-up 498,30 si el compromiso fuera 600); (c) `contract_value` sumaría el mínimo anual en vez de mínimo × períodos; (d) el RSM tendría que devengar el compromiso linealmente y ajustar al cierre (hoy devenga lo facturado por mes). Requiere además `prices.minimum_period` (`line \| commitment`) y una fecha de cierre del compromiso en el ítem. Domi decide si se agrega como segunda opción del mismo campo o queda por período |
| 2   | **DTE/Odoo**: ¿una línea con desglose en glosa o una línea por tramo?            | ✅ **Configurable por precio** (`invoice_line_mode`, §3.8): `single` (default, una línea con el detalle compacto en la glosa) o `per_tier` (una fila por tramo/paquete/asiento más una por ajuste). El mapeo a Odoo/DTE no cambia: cada fila de `invoice_items` sigue siendo `MontoItem = Qty × Prc`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 3   | **Línea `metered` antes de informar el consumo**: ¿cantidad base, mínimo o 0?    | **Pendiente de análisis de Domi.** Hoy está construido con la **cantidad base del ítem** (`contract_items.quantity`, el valor que hereda un mes sin override): `resolveQuantity` devuelve `{ quantity: base, source: 'pending' }`, la cuota se tarifa con esa cantidad (con el precio del mockup y base 1.000: 64,80) y la línea queda en la Por Emitir con `quantity_source = pending`, `quantity` = 1.000, `unit_price` 0,0648 y su desglose; el preview (`POST /contracts/preview`) la muestra igual con la advertencia "Consumo por informar en «Rutas optimizadas»: la línea usa la cantidad base del ítem y se recalcula al registrar" (una vez por ítem). `GET /consumption/pending` lista esas líneas cuando el período ya terminó y `contract_value` no las cuenta (suma el mínimo, si hay). Alternativas: **mínimo** (la línea nace en `minimum_amount` con cantidad 0: no sobreestima, pero sin mínimo nace en 0) o **0** (la línea nace en 0,00 y la factura no se puede emitir hasta informar: es la más segura contra emitir de más, pero deja la Por Emitir "vacía" y el RSM en 0 hasta el registro). Cambiar es un solo punto (`resolveQuantity`) más el texto del aviso                                                                                                                             |
| 4   | **Consumo con factura ya emitida**: ¿solo bloqueo o complementaria?              | ✅ **Dos caminos, elige la usuaria** (`on_issued`, §4.4): `additional` crea la complementaria Por Emitir del período solo con la diferencia; `reissue` anula con NC espejo y reemite el período con el consumo corregido. `block` (default) mantiene el 409, que ahora trae la emitida y si la complementaria es posible                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 5   | **Cargo fijo del tramo con todo el consumo en gratis**                           | ✅ **Configurable por precio** (`charge_flat_when_free`, default `false`, §3.5): 300 rutas con 500 gratis → 0,00 o 9,00 (10 − 10 %)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 6   | **`metered` + Anticipado**                                                       | ✅ **Confirmado**: prohibido en etapa 1 salvo `seat` (400 en alta y bloqueo en activación)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

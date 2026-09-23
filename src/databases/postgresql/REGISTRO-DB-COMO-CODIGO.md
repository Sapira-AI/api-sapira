# REGISTRO — lo que falta para que la base sea código

> Registro vivo. **Se actualiza en el mismo commit que resuelve un punto**: se cambia su ⬜ por ✅,
> se anota la fecha y qué quedó como evidencia. Si un punto se decide NO hacer, va a ❌ con el motivo.

**Qué significa "la base es código" acá:** el repo describe el estado deseado del esquema `public`,
cada entorno se lleva a ese estado con un procedimiento repetible
([GUIA → Sincronizar cambios](./GUIA-CAMBIOS-DE-ESQUEMA.md#-sincronizar-cambios-a-qa-y-producción)),
y cuando el código y una base difieren, **manda el código**. Hoy eso último no es cierto en todos
los casos: los puntos 1, 5 y 7 son exactamente donde la base todavía manda.

**Lo que ya está** (no se repite abajo): las 129 tablas de `public` con datos de negocio tienen
entity viva y no queda ningún espejo inerte; 887 assets cubren enums, extensiones, índices
especiales, funciones, triggers, policies, permisos y semillas; `yarn schema:status --target <e>`
mide cualquier base en solo lectura; y hay guardas en las pruebas para que nada de eso se
desarme (GUIA → Guardas automáticas).

Desde el 2026-09-22 se suma: los **140 comentarios de función** y la secuencia suelta `invoice_number_seq` están en el corpus; `schema:status` reporta **FUERA DEL CORPUS** (lo que ninguna fase puede describir); y el CLI **exige** `--only` en `--apply`, rechaza aplicar archivos sin commitear y ya no infiere el `--target`.

Desde el 2026-09-23 se suma la fase **`cron/`**: los 4 jobs de pg_cron son assets verificables. Los 2 que llamaban edge functions tenían la service role key escrita en `cron.job.command`; ahora pasan por `public.cron_invoke_edge_function`, que lee la URL y la clave de **Vault** (un secreto por entorno, fuera del repo). La captura redacta cualquier `Bearer`/JWT antes de escribir el snapshot —que está commiteado— y una prueba falla si aparece un secreto en el corpus o en los snapshots. Validado sin efectos: el wrapper autenticó contra una función inexistente (404) y los dos comandos nuevos se ejecutaron dentro de una transacción revertida.

## Estado

| # | Pendiente | Estado | Cerrado |
|---|---|---|---|
| 1 | [Funciones donde la base y el repo difieren de verdad](#1-funciones-con-deriva-real-en-producción) | ✅ | 2026-09-21 |
| 2 | [Línea base de prod sin registrar](#2-línea-base-de-producción-sin-registrar) | ✅ | 2026-09-22 |
| 3 | [QA sin alinear con el repo](#3-qa-sin-alinear) | ✅ | 2026-09-23 |
| 4 | [23 assets huérfanos](#4-23-assets-huérfanos) | ✅ | 2026-09-21 |
| 5 | [El generador reescribe 74 entities desde prod](#5-el-generador-de-espejos-todavía-manda-sobre-74-entities) | ✅ | 2026-09-22 |
| 6 | [94 sentencias de ruido en `migration:generate`](#6-94-sentencias-de-ruido-al-generar-una-migración) → 53 | ✅ | 2026-09-23 |
| 7 | [2 vistas sin asset ni entity](#7-dos-vistas-fuera-del-código) (eliminadas; falta confirmar con Domi) | 🔶 | 2026-09-21 |
| 8 | [No se puede reconstruir una base desde cero](#8-no-hay-bootstrap-desde-cero) — decidido: se clona prod | ✅ | 2026-09-22 |
| 9 | [Rotar las contraseñas de QA y producción](#9-rotar-las-contraseñas) | ⬜ | |
| 10 | [Permisos: `grants/` sigue sin ser verificable](#10-permisos-grants-sigue-sin-ser-verificable) | 🔶 | 2026-09-23 |

Las cifras de abajo se midieron el **2026-09-21**. La fuente vigente siempre es el comando, no esta
tabla: `DOTENV_CONFIG_PATH=.env.<qa|prod>.db yarn schema:status --target <qa|production>`.

---

## 1. Funciones con deriva real en producción

> ✅ **CERRADO el 2026-09-21** (sesión Domi+Claude, todo por el flujo de la GUIA):
> `rsm_metrics(jsonb)` re-aplicada en prod (tenía `\r\n` de Windows; ahora byte-idéntica al repo) ·
> `create_default_roles_for_holding` **revertida en el repo** a la versión de prod (la edición
> v0.0.15 regalaba `VIEW_DOCUMENTACION` a roles de cliente, contradiciendo el diseño de permisos
> internos del 21-09: commits `07cf64d` sapira-ai / `ce38839` front-sapira — el permiso interno NO
> lo cubre el comodín y solo lo otorga un super admin explícitamente) · `seed/002` reescrito para
> solo registrar el permiso en el catálogo (bootstrap), **sin otorgamientos y sin aplicar** por
> decisión de Domi (todo funciona sin la fila; se aplica cuando se quiera otorgar a un rol) ·
> `grants/010` re-aplicado en prod (Leon lo editó tras aplicarlo). `schema:status --target
> production`: migraciones 0 · pendientes 0 · solo-en-base 0.
> **De paso se cerró un bug del corpus**: los archivos con funciones sobrecargadas no tenían `;`
> entre definiciones (pg_get_functiondef no lo emite) y el runner no podía aplicarlos — corregido
> el emisor (`generate-assets.ts`) y los 11 archivos afectados.

**Historial del punto** (cómo se llegó al cierre):

- 2026-09-18 (`8846d14`): recapturadas `apply_quote_downsell_to_contract` y
  `prevent_end_date_update_when_active` (prod tenía código más nuevo que el repo).
- 2026-09-21 AM (`a2647bc`, Domi): `check_contract_item_continuity` e `invoice_reschedule_items`
  commiteadas y aplicadas a QA y prod por el flujo de la GUIA — los checksums del historial hoy
  coinciden con el repo (el párrafo anterior de este punto las daba como "aplicadas desde copia
  sin commitear"; quedó resuelto con ese commit).
- 2026-09-21 PM: el resto (banner de arriba). Regla que queda de todo esto: **aplicar solo
  contenido commiteado**; si se aplica desde el working tree, el commit va inmediatamente después.

**Cómo se verifica:** `schema:status --target production` sin `PENDIENTE` ni `REAPLICAR`
(salvo lo `NO VERIFICABLE`, que siempre se aplica a conciencia). Medido así el 2026-09-21.

## 2. Línea base de producción sin registrar

> ✅ **CERRADO el 2026-09-22.** `--baseline` registró 853 assets en producción y 830 en QA (más los
> que ya estaban). Antes se re-aplicaron las 2 funciones cuyo archivo había cambiado al incorporar
> los comentarios. Estado al cierre: **prod 862 APLICADO, 0 pendientes, 0 deriva, 0 solo-en-base**;
> QA 855 APLICADO. Los 3 `NO VERIFICABLE` (`grants/000`, `seed/001`, `seed/002`) siguen fuera por
> diseño hasta el punto de permisos verificables.
>
> Desde ahora `schema:status` dice la verdad sobre qué está pendiente en cada base: esa es la
> diferencia entre tener historial y no tenerlo.

`public.sapira_sql_asset_history` tiene **9 filas de 887 assets** (7 entre el 2026-09-09 y el 09-15,
más las 2 del 09-21); **851** están verificados idénticos a la base y esperan registro.

**Por qué importa:** sin historial nadie sabe qué está aplicado. Todo `--apply` depende de que el
desarrollador recuerde qué archivo tocó, y `--dry-run` no informa nada útil.

**Cómo se cierra:** `postgres:assets --baseline --target production --allow-production --confirm-target production`
(solo escribe filas de historial, no ejecuta SQL), y después `schema:status` para confirmar que no
aparece `DERIVA`. Detalle: [GUIA → Línea base](./GUIA-CAMBIOS-DE-ESQUEMA.md#4-línea-base).

**Cómo se verifica:** `schema:status --target production` no muestra `LINEA BASE`.

## 3. QA sin alinear

> ✅ **CERRADO el 2026-09-23.** QA y producción quedaron **idénticas: 867 assets `APLICADO` en cada
> una, 0 pendientes, 0 deriva, 0 solo-en-base**. Lo que faltaba de las 3 decisiones abiertas:
>
> - **`types/000-extensions` (`NO CONVERGE`)**: QA no tenía `pg_trgm` ni `pgjwt`. No era cosmético —
>   `search_contracts_by_client_identity` y `suggest_contract_item_matches` usan `similarity()`, así
>   que existían en QA y habrían fallado al ejecutarse. Aplicar el asset las instaló.
> - **6 funciones con comentarios solo en QA**: se trajo la versión de QA al repo (documentaba mejor,
>   incluidos ~20 comentarios en `standardize_invoice_items`) y se aplicó a las dos bases.
> - Las policies y objetos que solo existían en QA ya se habían resuelto el 21-09.

> 🔶 **CASI CERRADO el 2026-09-21** (sesión Domi+Claude, procedimiento §6 de la GUIA en el orden
> documentado): 2 policies del paso 1 → **las 5 migraciones TypeORM** → 24 assets con `--only`
> (las 16 funciones donde dev tenía versiones viejas de fixes ya vivos en prod, los 7 de
> `sapira_quantity_imports`/quote-stages y `grants/010`). También: tablas de prueba `example`/
> `examples` eliminadas (0 filas, 0 FKs, 0 referencias). `schema:status --target qa`:
> migraciones 0 · PENDIENTE 0 · SIN CONTRAPARTE 0. **Contexto clave**: QA es la rama `dev`
> PERSISTENTE del mismo proyecto Supabase (parent = `main`); el flujo viejo del front la mantenía
> en paridad y lo único que le faltaba era el carril api, estrenado directo en `main`.
> ⚠️ Mientras convivan ambos mecanismos: ninguna operación de rama por Supabase
> (merge/rebase/reset) sin acuerdo Domi+Leon — un reset reconstruiría dev sin el carril api.
>
> **Quedan 3 decisiones (Leon)**: (a) `types/000-extensions` NO CONVERGE (extensiones de dev
> difieren; va por migración o se acepta); (b) 5 policies viejas de `salesforce_connections` +
> mappings que solo existen en dev (prod las eliminó; dropearlas = paridad); (c) la
> mini-divergencia de migraciones del front del 16-09 (dev +2 / main +1).


Medido en QA el 2026-09-21: **5 migraciones pendientes** (la base nunca corrió ninguna), 17 funciones
con otra definición, 2 `REAPLICAR` (las del punto 1), 1 asset que `NO CONVERGE`
(`types/000-extensions.sql`: sus extensiones difieren), 32 `SIN CONTRAPARTE` y **15 objetos que
existen solo ahí** (policies de salesforce, funciones legacy de `integration_logs`). Desde el
2026-09-21 ya tiene tabla de historial, con las 2 filas de ese día.

**Por qué importa:** QA es el paso previo obligatorio antes de prod. Mientras no refleje el repo, lo
que se pruebe ahí no dice nada sobre lo que va a pasar en producción.

**Cómo se cierra:** el orden está en
[GUIA → Puesta al día de QA](./GUIA-CAMBIOS-DE-ESQUEMA.md#6-estado-de-las-bases), que no es el
procedimiento genérico: primero dos policies con `--only` (crean la tabla de historial que la
migración de RLS necesita), después `migration:run`, después `--baseline`, y por último lo pendiente
por lotes. Los 15 objetos que solo existen en QA se deciden caso a caso.

**Cómo se verifica:** `schema:status --target qa` sin migraciones pendientes y con los mismos
pendientes que prod.

## 4. 23 assets huérfanos

> ✅ **CERRADO el 2026-09-21** (autorizado por Domi): los 23 archivos se eliminaron del corpus en un
> solo commit, **sin migración** — no había nada que dropear en ninguna base. Antes de borrar se
> verificó en vivo (prod y QA) que ningún objeto existe, que ninguna de las 79 funciones que el
> front llama por `rpc()` está en la lista, y que cada familia tiene su reemplazo operando:
> promedios FX → servicio `banco-central` (API); clasificación del staging →
> `invoice-processing.service.ts`; partner por tax_id → `process_partner_staging_*` + endpoints de
> `odoo-partners`; triggers RSM viejos → `trg_rsm_on_{invoice,contract_item,quantity}_change` +
> `apply_contract_contraction`; NC legacy → `invoices.document_type='NC'` + `create_credit_note_safe`.
> Origen del arrastre: scripts sueltos de feb-2026 (commits `efdccff`, `45f1a06`) que la
> reorganización de v0.0.9 movió al corpus sin contrastar contra prod. Las tablas de abajo quedan
> como registro histórico de qué era cada uno.

23 archivos describían objetos que **no existen en prod ni en QA**, y en los 23 casos el objeto se
eliminó a propósito con una migración del front (hoy archivo congelado), sin borrar el asset:

| Grupo | Assets | Quién los eliminó |
|---|---|---|
| Notas de crédito legacy (`invoice_credit_notes`) | 4 policies + 2 triggers + 1 función | `20260727195654_nc_drop_invoice_credit_notes_legacy.sql` |
| Revenue schedule por triggers | 5 triggers + 1 función | `20260226120000_rsm_consolidate_triggers.sql`, `20260419190000_unified_contraction.sql` |
| Clasificación del staging de Odoo | 3 triggers + 3 funciones | `20260204083003_remove_invoice_classification_triggers.sql`, `20260202090037_drop_trigger_check_partner_by_tax_id.sql` |
| Promedio mensual de tipos de cambio | 2 triggers + 2 funciones | `20260219112216_remove_exchange_rates_triggers.sql` |

**Por qué importa:** un `--apply` sin `--only` hoy **fallaría en 10** (tabla o función inexistente) y,
peor, **aplicaría 13 sin error, reactivando en prod comportamiento que se eliminó a propósito**:
clasificación del staging, recálculo de revenue por churn y promedios de FX.

### Los 23 archivos

El runner aplica `functions/` **antes** que `triggers/`, así que en una corrida sin filtro las
funciones huérfanas se crean primero y sus triggers dejan de fallar: por eso 13 se aplican y
10 fallan. Aplicado de a uno con `--only`, un trigger cuya función todavía no existe falla.

**Notas de crédito legacy** (7) — eliminado por `20260727195654_nc_drop_invoice_credit_notes_legacy.sql` (borró la tabla y la función)

| Asset | Objeto que describe | En un `--apply` sin filtro |
|---|---|---|
| `rls/tenant_isolation_select_invoice_credit_notes.sql` | policy sobre `invoice_credit_notes` | ❌ falla: `invoice_credit_notes` no existe |
| `rls/tenant_isolation_insert_invoice_credit_notes.sql` | policy sobre `invoice_credit_notes` | ❌ falla: `invoice_credit_notes` no existe |
| `rls/tenant_isolation_update_invoice_credit_notes.sql` | policy sobre `invoice_credit_notes` | ❌ falla: `invoice_credit_notes` no existe |
| `rls/tenant_isolation_delete_invoice_credit_notes.sql` | policy sobre `invoice_credit_notes` | ❌ falla: `invoice_credit_notes` no existe |
| `triggers/trg_update_invoice_credit_notes_updated_at.sql` | trigger sobre `invoice_credit_notes` → `update_updated_at_column()` | ❌ falla: `invoice_credit_notes` no existe |
| `triggers/trigger_revenue_schedule_after_credit_note.sql` | trigger sobre `invoice_credit_notes` → `trigger_revenue_schedule_on_credit_note()` | ❌ falla: `invoice_credit_notes` no existe |
| `functions/trigger_revenue_schedule_on_credit_note.sql` | función | ⚠️ **se crea la función** |

**Recálculo de revenue schedule por triggers** (6) — eliminado por `20260226120000_rsm_consolidate_triggers.sql` (los 4 de facturas) y `20260419190000_unified_contraction.sql` (el de churn)

| Asset | Objeto que describe | En un `--apply` sin filtro |
|---|---|---|
| `triggers/invoices_revenue_schedule_trigger.sql` | trigger sobre `invoices` → `trigger_revenue_schedule_update()` | ❌ falla: `trigger_revenue_schedule_update()` no existe ni tiene asset |
| `triggers/trg_invoice_status_change.sql` | trigger sobre `invoices` → `refresh_revenue_schedule_for_invoice_contract()` | ❌ falla: `refresh_revenue_schedule_for_invoice_contract()` no existe ni tiene asset |
| `triggers/trg_invoice_item_change.sql` | trigger sobre `invoice_items` → `refresh_revenue_schedule_for_invoice_contract()` | ❌ falla: `refresh_revenue_schedule_for_invoice_contract()` no existe ni tiene asset |
| `triggers/trigger_revenue_schedule_after_invoice_change.sql` | trigger sobre `invoices` → `trigger_revenue_schedule_on_invoice_change()` | ❌ falla: `trigger_revenue_schedule_on_invoice_change()` no existe ni tiene asset |
| `triggers/trg_rsm_on_churn.sql` | trigger sobre `contracts` → `trigger_rsm_on_churn()` | ⚠️ **se crea el trigger en `contracts`** |
| `functions/trigger_rsm_on_churn.sql` | función | ⚠️ **se crea la función** |

**Clasificación del staging de Odoo** (6) — eliminado por `20260204083003_remove_invoice_classification_triggers.sql` y `20260202090037_drop_trigger_check_partner_by_tax_id.sql`

| Asset | Objeto que describe | En un `--apply` sin filtro |
|---|---|---|
| `triggers/invoice_processing_status_classifier.sql` | trigger sobre `odoo_invoices_stg` → `set_invoice_processing_status()` | ⚠️ **se crea el trigger en `odoo_invoices_stg`** |
| `functions/set_invoice_processing_status.sql` | función | ⚠️ **se crea la función** |
| `triggers/classify_invoice_line_trigger.sql` | trigger sobre `odoo_invoice_lines_stg` → `classify_invoice_line_before_insert()` | ⚠️ **se crea el trigger en `odoo_invoice_lines_stg`** |
| `functions/classify_invoice_line_before_insert.sql` | función | ⚠️ **se crea la función** |
| `triggers/trigger_check_partner_by_tax_id_before_insert.sql` | trigger sobre `odoo_partners_stg` → `check_partner_by_tax_id_before_insert()` | ⚠️ **se crea el trigger en `odoo_partners_stg`** |
| `functions/check_partner_by_tax_id_before_insert.sql` | función | ⚠️ **se crea la función** |

**Promedio mensual de tipos de cambio** (4) — eliminado por `20260219112216_remove_exchange_rates_triggers.sql`

| Asset | Objeto que describe | En un `--apply` sin filtro |
|---|---|---|
| `triggers/trigger_calculate_monthly_avg.sql` | trigger sobre `exchange_rates` → `calculate_monthly_avg_fx()` | ⚠️ **se crea el trigger en `exchange_rates`** |
| `functions/calculate_monthly_avg_fx.sql` | función | ⚠️ **se crea la función** |
| `triggers/trigger_update_monthly_avg.sql` | trigger sobre `exchange_rates` → `update_monthly_avg_on_rate_change()` | ⚠️ **se crea el trigger en `exchange_rates`** |
| `functions/update_monthly_avg_on_rate_change.sql` | función | ⚠️ **se crea la función** |

**Cómo se cierra:** borrar los 23 archivos. **No hace falta migración**: no hay nada que eliminar en
ninguna base. Para regenerar esta lista: `schema:status --target production`, sección `SIN CONTRAPARTE`.

**Cómo se verifica:** `schema:status --target production` no muestra `SIN CONTRAPARTE`, y con eso
`--apply` sin `--only` deja de ser peligroso.

## 5. El generador de espejos todavía manda sobre 74 entities

> ✅ **CERRADO el 2026-09-22.** El generador ya no escribe los `.entity.ts` promovidos: solo emite
> para ellos el snapshot de prod, el barrel, el registro y el README. Verificado con el criterio de
> este punto —regenerar los 16 módulos no modifica ningún `.entity.ts`—. Además: la fecha de los
> archivos generados salía de una constante `2026-08-22` y ahora se deriva del catálogo, y el
> refresco (4 pasos sueltos) quedó en un solo comando, `yarn schema:snapshot --target <entorno>`,
> que se corre **después** de aplicar a prod. Las 74 cabeceras se reescribieron para que ningún
> archivo siga afirmando que se regenera.

Las 74 entities promovidas desde espejo (cabecera "PROMOVIDA desde espejo") las reescribe
`scripts/espejo/generate-espejo.py` desde los snapshots de prod.

**Por qué importa:** para esas tablas la fuente de verdad sigue siendo prod. Se pueden editar para
cambiar su tabla, pero **regenerar con snapshots anteriores al cambio lo revierte en silencio**.

**Cómo se cierra:** que el generador deje de emitir las entities promovidas y solo documente su
diferencia con prod (como ya hace con las entities del repo en la sección A de cada README), más
actualizar sus pruebas y `entities/README.md`.

**Cómo se verifica:** regenerar todos los módulos no modifica ningún `.entity.ts`.

## 6. 94 sentencias de ruido al generar una migración

> ✅ **CERRADO el 2026-09-23: 94 → 53.** Los 41 `DROP INDEX` de `special-index/` desaparecieron al
> declarar cada uno en su entity con `@Index('<nombre>', { synchronize: false })` —TypeORM entonces
> sabe que el índice existe y no lo crea ni lo borra— en 26 entities. Una guarda nueva en
> `indices-declarados.spec.ts` exige esa marca para cada asset de `special-index/`, así que el ruido
> no puede volver. Las 53 restantes son churn del propio TypeORM (28 FKs que elimina y recrea
> idénticas, 21 de defaults y 4 de dos índices) y no tienen arreglo desde el repo.

`yarn schema:log` contra prod emite 94 sentencias, todas clasificadas y ninguna cambiaría la base:
41 índices de `special-index/`, 28 FKs que TypeORM elimina y recrea idénticas, 14 del churn de
`gen_random_uuid()`, 4 de dos índices que recrea igual, 4 defaults `CURRENT_DATE` y 3 `ARRAY[]`.
Desglose y evidencia: [`entities/REGISTRO-ALINEACION.md`](./entities/REGISTRO-ALINEACION.md).

**Por qué importa:** `migration:generate` emite ese ruido dentro de cada migración nueva, y hay que
recortarlo a mano. Es el paso donde se cuela un `DROP` real sin que nadie lo note.

**Cómo se cierra:** declarar los 41 índices especiales en su entity con
`@Index('<nombre>', { synchronize: false })`, que le dice a TypeORM que el índice existe y no lo
toca (verificado en `RdbmsSchemaBuilder`: no lo borra ni lo crea). Las otras 53 son churn del propio
TypeORM y no tienen arreglo desde el repo.

**Cómo se verifica:** `yarn schema:log` baja de 94 a 53 sentencias.

## 7. Dos vistas fuera del código

> 🔶 **Sin objeto desde el 2026-09-21**: las dos vistas **ya no existen** ni en prod ni en QA (se
> midió en vivo a las ~10:30 y a las ~11:30 del 21-09; entre medio desaparecieron). Falta que Domi
> confirme que fue a propósito y el punto se cierra. Lo que queda del punto está resuelto por otro
> lado: `schema:status` ahora lista **FUERA DEL CORPUS**, así que una vista nueva se reporta sola en
> vez de pasar inadvertida, y crear la fase `views/` dejó de tener sentido sin archivos que poner.

`invoices_with_net_amounts` e `invoice_items_consolidated` existen en prod y no tienen asset ni
entity. `fetch-catalog.ts` ya las captura (consulta `views`), pero no hay fase que las aplique.

**Por qué importa:** son objetos de `public` que ningún archivo describe, así que un entorno nuevo no
los tendría y nadie revisa sus cambios.

**Cómo se cierra:** decidir si se modelan como fase nueva de assets (`views/`, con
`CREATE OR REPLACE VIEW`, que converge al re-aplicarse) o si se reemplazan por consultas del backend.

**Cómo se verifica:** la consulta `views` del catálogo no devuelve nada sin contraparte en el repo.

## 8. No hay bootstrap desde cero

> ✅ **CERRADO el 2026-09-22 como decisión, no como desarrollo** (Leon): **el camino oficial para un
> entorno nuevo es clonar producción**, no reconstruir desde el repo. No se escribe la migración
> inicial de las 131 tablas. La receta quedó en
> [GUIA → Crear un entorno nuevo](./GUIA-CAMBIOS-DE-ESQUEMA.md#crear-un-entorno-nuevo).
> Consecuencia aceptada: el repo describe el estado y las transiciones, pero no construye la base
> desde vacío; los assets pueden asumir que las tablas existen.

Las 131 tablas de prod existían antes de este sistema y `migrations/` solo tiene las 5 posteriores:
**ninguna migración las crea**. Un entorno nuevo solo se puede levantar clonando prod.

**Por qué importa:** es el límite real de "la base es código": el código describe el estado, pero no
alcanza para construir la base desde vacío. Además, los seeds fallan sobre una base vacía.

**Cómo se cierra:** o se genera una migración inicial que cree las 131 tablas desde las entities
(`migration:generate` sobre una base vacía) y se prueba en un entorno desechable, o se decide
explícitamente que el camino oficial es clonar prod. Las dos son respuestas válidas; hoy no hay
ninguna escrita.

**Cómo se verifica:** `migration:run` + `postgres:assets --apply` sobre una base vacía la dejan
igual a prod.

## 10. Permisos: `grants/` sigue sin ser verificable

> 🔶 **Observable desde el 2026-09-23, todavía no verificable.** `schema:status` ahora captura los
> ACL reales (`aclexplode` sobre `relacl`/`proacl`, con `COALESCE(acl, acldefault(...))` para que
> "sin ACL" signifique los permisos por defecto) y reporta la firma mayoritaria, las excepciones y
> los `ALTER DEFAULT PRIVILEGES`. Medido en prod: **las 131 tablas comparten una sola firma**, así
> que lo que declara `grants/000-table-privileges.sql` es cierto.

**Lo que falta para cerrarlo (D2):** que `grants/000`, un `grants/001-default-privileges` nuevo y
`grants/010` se **generen desde el catálogo** en vez de escribirse a mano. Recién entonces se puede
sacar `grants` de `UNVERIFIABLE_DIRECTORIES` —lo que además hace que `--baseline` los registre—.

**Hallazgo del reporte (2026-09-23):** `change_contract_currency` **no tiene `EXECUTE` para PUBLIC** y
ningún asset lo explica. Es el único caso así: `cleanup_duplicate_partners_by_vat` también se aparta,
pero eso sí está documentado en `grants/010`. Alguien revocó ese permiso por fuera del repo. Hay que
decidir si se conserva —y entonces se escribe en un asset— o si se restituye.

## 9. Rotar las contraseñas

Las contraseñas de QA y de producción quedaron escritas en una conversación con un asistente el
2026-09-16.

**Cómo se cierra:** rotarlas en Supabase → Settings → Database y actualizar `.env.qa.db`,
`.env.prod.db`, el `.env` de cada desarrollador y el entorno donde está desplegada la API.

**Relacionado, sin resolver:** el `.env` local de la app apunta a producción. `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET` y `SUPABASE_DATABASE_URL` van juntas, así que cambiar
solo la URL rompe la validación de tokens. Los scripts de esquema no dependen de eso si se usa
`DOTENV_CONFIG_PATH`.

---

## Orden recomendado

1, 2 y 3 dan una base operable: se resuelve la deriva real, el historial pasa a ser confiable y QA
sirve como paso previo. 4 y 6 la dejan limpia, y recién ahí `--apply` sin `--only` y
`migration:generate` dejan de necesitar cuidado manual. 5 y 7 cierran "el código manda". 8 es una
decisión de alcance y 9 es independiente: se puede hacer cuando quieras.

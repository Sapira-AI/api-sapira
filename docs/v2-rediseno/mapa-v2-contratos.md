# Mapa v2 · Contratos (módulo `contracts` + `/lab/contratos`)

> 25-09-2026 · Domi + Claude. Estrategia acordada con Domi (25-09): **construir la v2 al lado de lo viejo**. Endpoints y
> lógica nuevos, rediseñados (no copias de lo que funciona a medias), sobre las **mismas tablas**; lo del front viejo no se
> toca y se retira módulo por módulo al switch. Fuentes: [`auditoria-contratos.md`](./auditoria-contratos.md) (S1–S8 y
> sus decisiones), [`manual-modificaciones-contratos.md`](./manual-modificaciones-contratos.md),
> [`flexibilidad-con-trazabilidad.md`](./flexibilidad-con-trazabilidad.md), [`mejoras-y-brechas.md`](./mejoras-y-brechas.md),
> [`spec-tablas-por-modulo.md`](./spec-tablas-por-modulo.md), `sapira-ai/docs/ROADMAP-OPERATIVO.md` y las memorias de
> soporte. Registro de lo ejecutado: [`saneamiento-contratos.md`](./saneamiento-contratos.md).

## 1. Cómo se construye (reglas del módulo)

1. **Misma base, esquema aditivo.** v2 escribe en `contracts`, `contract_items`, `invoices`, `invoice_items`,
   `revenue_schedule_monthly` porque las leen el RSM, el scheduler de Odoo, Reportes, el Dashboard y el front viejo
   mientras conviva. Lo nuevo (día de ciclo, términos de pago, tipo de documento, eventos) entra como **columnas o
   tablas nuevas**; nada se renombra ni se borra hasta el switch.
2. **La lógica vive en la API**, en servicios con **una transacción por operación** y **preview antes de persistir**
   (mismo cálculo, sin escribir). Una función SQL nueva solo si la atomicidad lo exige, con nombre de operación, nunca
   `_v2`. Las funciones viejas quedan intactas y anotadas "reemplazada por X".
3. **Costura con los triggers heredados** (propuesta, decisión de Leon): la API abre cada transacción con
   `SET LOCAL sapira.writer = 'api'` y los triggers que hoy **rellenan o pisan** datos se hacen a un lado cuando la ven,
   porque v2 escribe el valor explícito. El front viejo nunca la setea → su comportamiento no cambia. Ya es un patrón de
   la casa (`sapira.bypass_period_guard`, `sapira.skip_currency_validation`, `sapira.bypass_end_date_guard`).
   Candidatos (ver §4): `standardize_invoice_items`, `trigger_generate_invoices_on_status_change` /
   `trigger_generate_invoices_on_contract_signed`, `set_contract_item_end_date`, `inherit_auto_renew_from_quote_item`,
   `trg_set_contract_item_categoria`, `set_booking_date_on_activate`. **No** se saltan los invariantes (moneda
   consistente, guard de período cerrado) ni la auditoría.
4. **RSM explícito.** Cada operación v2 termina llamando `revenue_schedule_rebuild(contrato, desde_mes)` en la misma
   transacción; no depende de triggers condicionados al holding de la sesión.
5. **Evento siempre.** Toda operación deja un evento en `contract_lifecycle_events` con usuario, motivo, tipo
   normalizado (`UPSELL`, `CROSS_SELL`, `DOWNSELL`, `RENEGOTIATION`, `CHURN`, `RENEWAL`, `REACTIVATION`,
   `CORRECTION`, `ACTIVATION`…), fecha efectiva, delta de MRR, ítems afectados y origen (`manual` | `quote:<id>`).
6. **Holding** por `HoldingScopeGuard` + `@HoldingId()` (regla única de `autorizacion-y-tenancy.md`).
7. **Flexibilidad con trazabilidad**: lo no emitido se edita libre y se regenera; los desvíos quedan como evento con
   motivo; solo bloquean los invariantes (emitido inmutable, período cerrado, tenancy, holding). El desbalance
   plan ↔ facturado ↔ devengado **no se impide: se marca** en el 360 (alerta de 4 patas).
8. **Switch = cerrar la puerta vieja.** `migrated: true` + el front viejo del módulo redirige al nuevo. Recién ahí
   `REVOKE`/`DROP` de lo reemplazado (§5), con el procedimiento del 24-09.

## 2. Operaciones

Veredicto: **Nueva** = lógica v2 en la API · **Delega** = el endpoint llama la función existente tal cual · **Se quita**
= no se construye en v2. "Lunes" = alcance propuesto para el lunes 28-09 9:00.

### 2a · Lectura

| # | Operación v2 | Cómo funciona | Hoy | Veredicto | Evita de raíz | Lunes |
|---|---|---|---|---|---|---|
| L1 | Lista de contratos | Paginada y filtrada en servidor (estado, cliente, razón social, compañía, producto, **vencimiento por ítem**, con factura en ERP), orden, columnas, vistas guardadas, export; estado calculado como en Clientes | `select *` sin filtro ni paginación en el navegador | Nueva | "próximos a vencer" por fecha del contrato (Tanda 2) | ✅ |
| L2 | KPIs | MRR **sin** pendiente de renovar (S5-3) y pendiente como tarjeta aparte; `HoldingMetricsService` | 3 cálculos distintos | Nueva (reusa servicio) | dos cifras de MRR para el mismo mes | ✅ |
| L3 | Contrato 360 | Encabezado, **ítem madre** por producto+cuenta (regla CIS: vigentes iniciados, ajustes de precio aportan 0) con desplegable de ítems y **tipo de ítem**, facturas, historial (eventos normalizados), resumen RSM, documentos con URL firmada, alertas (4 patas, FX sin tasa, sin partner Odoo, ítem sin producto) | Varias lecturas directas del front | Nueva | tipo de ítem perdido (U7), bloqueos silenciosos (Medios #1) | ✅ |

**Estados y lista (Domi 25-09).**
- **Estado guardado vs mostrado**: `contracts.status` solo lo cambian acciones explícitas (crear → En revisión,
  activar → Activo, contracción total → Cancelado; pausar → Pausado cuando exista S2-12). El estado **mostrado** se
  calcula al leer, nunca se guarda ni lo cambia un cron (el `auto_expire_contracts` nunca corrió): Borrador ·
  Vigente · **Por renovar** (algún ítem recurrente terminó sin renovar ni baja; el ex "Ítem vencido (renovación
  parcial)") · **Vencido** (terminaron todos, reversible solo si se renueva, S2-1) · **Pausado** (reservado: el
  modelo, los filtros y la tarjeta ya lo consideran, hoy 0) · Cancelado. Sin estados de workflow (S1-9, S2-11).
- **Pestañas = listas distintas**: Contratos | Suscripciones (Stripe). Legacy y MRR legacy van a su vista (S8, al
  final). El estado es filtro: tarjetas clicables + opción múltiple en el panel.
- **Tarjetas que filtran**: Por renovar, Vencen en 30 días, Vencidos, Borradores (el número = lo que muestra la
  tabla al hacer clic; una activa a la vez, con chip). MRR y Pendiente de renovar son montos: no filtran.
  Cubre TiMining 29-07 #8 (vencimiento por ítem) y #10 (pendientes: renovaciones).
- **Filtros avanzados** en panel lateral (Clientes queda con el básico): los 16 del front viejo (estado, vencimiento,
  cliente, tipo, valor, fechas de inicio y fin, multiempresa, multimoneda, país del cliente y de la razón social,
  compañía, producto, auto-envío, auto-emisión, con factura en ERP) + razón social, moneda y próximo vencimiento;
  selección múltiple con el componente estándar (`docs/reglas-desarrollo/componentes-seleccion.md` en front-sapira).

**Contrato 360 (Domi 25-09, referencias 1g y 1h del mockup O2C).** Encabezado con línea de vida (Borrador → Activo →
Renovación/Vencimiento → Cerrado) y franja de datos clave. Pestañas: **Resumen** personalizable (mismo estándar que
Clientes: widgets de resumen financiero, próxima factura con bloqueos, vínculos, estado de cobro, FX aplicado, estado
vigente por producto, etc.) · Ítems · Facturas (cronograma por período + vista de facturas) · Devengo · Historial (con
Documentos dentro). **Consumos solo si el contrato declara un modelo de precio por uso**: el tipo de ítem "Variable/Fijo"
es master data de cada holding y no gobierna comportamiento; la declaración llega con Pricing (A.3: cantidad `fixed |
metered` por ítem/precio). Hasta entonces la pestaña no se muestra.

### 2b · Creación y activación

| # | Operación v2 | Cómo funciona | Hoy | Veredicto | Evita de raíz | Lunes |
|---|---|---|---|---|---|---|
| C1 | Crear contrato (manual o desde cotización Firmada) | Borrador en **una transacción**. Pide lo que hoy falta: moneda y política FX de facturación (S1-3, default moneda del contrato + spot), política FX de compañía si difiere (S1-17), **términos de pago** (default de la razón social, S1-4), **tipo de documento** sugerido por país emisor vs receptor (S1-7), **día de ciclo** explícito (S3-16), agrupación juntas/por ítem guardada (S1-10). Ítems con **producto obligatorio**, tipo, frecuencia, inicio y término (S1-12); moneda del ítem = la del contrato (S1-2); auto-renovación como viene y respetando lo desmarcado (S1-5). Número correlativo por compañía y prefijo (S1-1). Preview del calendario antes de guardar | Inserts sin transacción desde el front (`useProgressiveContractCreation`), schema Zod que nunca corre, términos y tipo de documento perdidos | Nueva | ítems sin producto (ROADMAP 12, CTR-2026-184), términos perdidos (Medios #11), número hex duplicado (Medios #7), auto-renovación forzada, agrupación no guardada | ✅ |
| C2 | Activar (uno o masivo) | Valida (tasa de IVA de la compañía, FX de compañía confirmado, ítems completos); **genera las facturas con el generador v2** (§3) en la misma transacción **antes** de pasar a Activo (el trigger viejo ve facturas y se salta; con la costura, ni corre); booking intacta si existe (S2-7); rebuild RSM; evento `ACTIVATION` | `bulk_activate_contracts` / `mark_contract_signed_safe` + triggers de activación + `generate_missing_invoices_for_contract` | Nueva | Activo sin facturas (S2-6), `due +30` (SAT MX), `export_type` fijo (Complejos #4), one shot en cada período (U6), Bianual = 12, historial duplicado, `bulk_confirm_fx_policy` pisando `fixed_period` | ✅ |
| C3 | Duplicar | — | `useContractLifecycle` | Se quita (S1-14) | — | — |
| C4 | Workflow de aprobación | Solo Borrador → Activo (S1-9); los pasos configurables se ocultan (S2-11) | `workflow_steps`, `mark_contract_signed_safe` | Se quita por ahora | — | — |
| C5 | Borrar | Solo Borrador y **lógico** (con evento) (S2-9) | DELETE físico desde el navegador | Nueva | borrados sin auditoría | ✅ |

**Endpoints de C2, C5 masivo y configuración masiva (26-09).**
- `POST /contracts/activate/preview` `{ ids }` (1–100): por contrato `can_activate`, `blockers[{ code, message }]`
  (`not_found`, `not_draft`, `has_invoices` (no legacy ni canceladas), `has_legacy_invoices`, `no_client_entity`, `no_company`, `no_tax_rate`, `no_items`,
  `items_without_product`, `incomplete_items`, `currency_mismatch`, `fx_company_policy_missing`, `fixed_fx_without_rate`,
  `no_invoices`; `fixed_fx_without_rate` = alguna factura sin tasa en `contract_fx_period_rates` que cubra el inicio de su
  período, directa contrato→factura o inversa como 1/tasa), `warnings`, `invoices_count`, `first_issue_date`, `total_to_invoice` (neto), `currency`,
  `document_type` y `sample` (3 primeras facturas del generador). No escribe.
- `POST /contracts/activate` `{ ids }`: solo los sin bloqueos, **una transacción por contrato**. Orden: facturas Por
  Emitir (encabezado = Σ líneas) → líneas sin `contract_item_id` y UPDATE que lo fija (patrón B: `standardize_invoice_items`
  solo corre en INSERT) → `status = 'Activo'` (los triggers de generación vieja ven facturas y se saltan; booking la fija
  `set_booking_date_on_activate` si es null) → `revenue_schedule_rebuild(id, NULL)` → evento `ACTIVATION`. Sin
  `contract_invoices` ni `bypass_period_guard` (el cambio de estado no toca campos del guard). Responde
  `{ activated, skipped, failed }`. Con FX fijo, `fx_contract_to_invoice` y los montos en moneda de factura se llenan
  con esa tasa como la rama fija de `apply_fixed_fx_to_contract` (monto × fx; IVA y total del encabezado redondeados).
- `POST /contracts/bulk-delete` `{ ids }` (1–500): misma regla que `DELETE /contracts/:id`, una transacción; los que no
  califican vuelven en `skipped` con el motivo. Sin la columna `deleted_at` (migración `1790358766159` pendiente) → 409.
- `PATCH /contracts/bulk-settings` `{ ids, auto_send_to_odoo?, auto_invoice? }`: una transacción, evento
  `SETTINGS_CHANGED` por contrato que cambia (`metadata.before/after`), S6-10 (emisión automática exige envío al ERP).
- `GET /contracts` busca además por RUT sin puntos ni guion, número de cotización y producto de cualquier ítem; devuelve
  `totals { contracts, mrr, total_value_system, currency }` sobre todo el conjunto filtrado; `limit` hasta 500.

### 2c · Facturas del contrato

| # | Operación v2 | Cómo funciona | Hoy | Veredicto | Evita de raíz | Lunes |
|---|---|---|---|---|---|---|
| F1 | Generador único (§3) | Una sola pieza para crear Por Emitir: al activar, al modificar y al renovar | 6 generadores (2 front, 4 SQL) | Nueva | ver §3 | ✅ |
| F2 | Editar borrador | La Por Emitir se edita libre como un todo (líneas, cantidades, precio, descuento, fechas, receptor, glosa) sin pasar por el contrato (S4-1); cada línea **sigue ligada a su ítem**; el desvío plan ↔ facturado queda como evento con motivo y se **marca** | `edit_pending_invoice` (0 usos), Reestructurar, bulk sueltos | Nueva | "no me deja", Reestructurar como única salida, líneas `1 × total` | ✅ |
| F3 | Aplicar cambios (S4-2) | Recibe el estado objetivo y aplica el **cambio mínimo**: emitidas intocables, líneas no afectadas no se reescriben, ediciones manuales no se pisan sin confirmar, consumos registrados y líneas netas se respetan, FX nunca clonado, header = Σ líneas, evento. Lo usan editar ítems, modificaciones y el "repartir distinto" que hoy hace Reestructurar | `sync_invoices_for_contract_item`, `invoice_reschedule_items`, `check_contract_item_continuity` | Nueva | U1, U11, U2, FX pegado (79 PE), cuenta perdida en la glosa (Tanda 3 #2) | Parcial (lo que usen C/M) |
| F4 | Editar ítems (corrección) | Envía **solo los campos cambiados** (el fin como campo explícito); corrige glosa, cuenta, tipo, unidad, booking, y cantidad/precio si fue error de carga; deriva a Modificar si cambia el MRR hacia adelante, hay emitidas afectadas o cambia la frecuencia; ítems con consumos avisan y conservan su cantidad del período (S7-7); preview + F3 | UPDATE directo que reenvía todo + sync por ítem | Nueva | fin recalculado al guardar (Bosch), neteo deshecho, cambio comercial por "editar" | ✅ |
| F5 | Tipo de cambio | Política y tasa **por factura** (S6-1); "fijo" sin tasa nunca se envía (S6-2, U12); una línea que se suma a una PE hereda su FX | `apply_fixed_fx_to_contract` (fija todo el contrato), guard del scheduler | Nueva (con Facturación) | fijo sin tasa a spot en silencio, FX de contrato mal usado | Con Facturación |

### 2d · Modificaciones (S3, manual de modificaciones)

| # | Operación v2 | Cómo funciona | Hoy | Veredicto | Evita de raíz | Lunes |
|---|---|---|---|---|---|---|
| M1 | **Modificar contrato** (una sola entrada) | "Valores nuevos completos" por ítem (cantidad, unitario mensual o anual, descuento, frecuencia, fin) + fecha efectiva + origen (manual o cotización). Un solo cálculo (fórmula unificada del delta, manual §8) decide UPSELL / DOWNSELL / RENEGOTIATION; **CROSS-SELL** si el producto no existe en el contrato. Ítem de ajuste acumulativo con `related_item_id`; hereda tipo, método, moneda y política del padre como **defaults editables** (S3-19, obs. 3); termina con el contrato (D-B); primer tramo proporcional por días en upsell/cross-sell en la factura del ciclo, o factura suelta si la usuaria lo elige (S3-5, S3-17); downsell sin prorrateo, rige desde el próximo período (S3-5/6); downsell al 100% se deriva a M2 (S3-7); opción de **línea neta** en upsell (S3-14); facturas vía F1/F3 agrupando **por período**, excluyendo unificadas; preview obligatorio "se suma a la factura X / se crea nueva"; aviso de posible duplicado (misma dirección, producto y fechas); cotización pasa a "Contrato creado" solo al final | `UpsellingModal` e `AssignToContractModal` inline (6 tablas sin transacción), `create_contract_cross_sell` → `approve_contract_amendment`, `apply_quote_downsell_to_contract`, `ContractionModal` en 7 modos | Nueva | período "1 a 1" (23-09 #1), ancla al booking (Bosch), plazo sin acotar (S04191, 20 de 44), UPSELL de producto nuevo, moneda/FX de la cotización (U10, S02656), IVA 19% fijo (129 MX + 37 PE), merge por fecha exacta, facturas del ítem nuevo no generadas (Stanhome), sin evento ni usuario (duplicado S04191), downsell sin descuento (Sinba), doble prorrateo en RSM (Bosch −10,51), dos ejes que pierden el término cruzado (STG) | ✅ |
| M2 | Contracción (churn total o de un ítem) | Early (fecha ≤ fin) vs non-renewal (fin + 1). **Manda el inicio del ítem CHURN** (U5): `churn_date`, cortes y NC usan esa fecha; en las Por Emitir **se quita solo la línea del ítem** y se recalcula el header (ROADMAP #11); emitidas del período con NC **espejo exacto de la original** en moneda y FX (ROADMAP #10); ítems con MRR 0 no bloquean; contrato Cancelado si no quedan recurrentes; motivo de catálogo | `apply_contract_contraction` | Nueva | U5 / La Mascota, PE entera cancelada (Stanhome, NSAgro), 13 NC en moneda equivocada | ✅ |
| M3 | Renovar (uno o varios ítems, atómico) | Una operación (S3-8); nunca sobre ítems renovados, cancelados o con churn; cambio de precio = RENEWAL al precio anterior + ajuste explícito (S3-15); facturas con F1 (tipo de documento, vencimiento por términos, último período proporcional S4-16); actualiza fin del contrato = **el más próximo** de los recurrentes vigentes (S2-13) y `total_value` | `create_contract_renewal` v2, una llamada por ítem | Nueva | `export_type = 1` fijo, `+30`, fin y TV sin actualizar (27 de 33) | Si alcanza; si no, después |
| M4 | Reactivar | Revierte un churn o contracción con motivo: restaura ítems y Por Emitir cuidando fechas (S2-8) | Solo SQL nuestro | Nueva | "revertir churn" por SQL | Después |
| M5 | Cambiar razón social | Actualiza `client_entity_id` + PE pendientes (RUT, IVA, tipo de documento, serie) con evento (Medios #13) | Solo BD | Nueva | swap manual (Ransa SV) | Después |
| M6 | Pausar | Acción propia, investigar industria (S2-12, Complejos #9) | Workaround RENEWAL+DOWNSELL | Diseño | sub-bug B del RSM | — |

### 2e · Estados y vencimiento

| # | Operación v2 | Cómo funciona | Veredicto | Lunes |
|---|---|---|---|---|
| E1 | Vencimiento | Ítem vencido sin decisión = "Pendiente de renovar" con alertas crecientes; cuando vencen todos, Expirado reversible (S2-1, S5-4) | Nueva | Después |
| E2 | Auto-renovación | **Propone** N días antes (30 por defecto, por holding) y la usuaria confirma (S2-2/3). El cron viejo no se arregla (decisión #5) | Nueva | Después |

## 3. El generador v2 (una sola pieza)

Entradas: contrato (día de ciclo, agrupación, términos de pago, moneda y política FX de facturación, tipo de documento)
+ ítems. Reglas:

- **Períodos** desde el día de ciclo; `fin = siguiente inicio − 1 día`; período de la línea = período de servicio de su
  ítem, calculado en una sola función.
- **Frecuencias** de una tabla única (Bianual = 24, S4-11); Anticipado emite al inicio, Vencido al inicio del siguiente;
  la factura del mes M puede juntar anticipados de M con vencidos de M−1 (S3-13).
- **No recurrentes** una sola vez (U6).
- **Montos**: cuota con 2 decimales y la diferencia en la última (S1-11); último período corto proporcional (S4-16);
  línea = cantidad × unitario × (1 − descuento) con precio de lista y descuento visibles, nunca `1 × total`;
  header = Σ líneas.
- **Moneda**: misma moneda → FX 1 y montos llenos; con conversión → montos en moneda de factura NULL (se valorizan al
  emitir o con la tasa fija de la factura); nunca mixto, nunca clonado.
- **Fiscal**: tipo de documento del contrato (sugerido por país emisor vs receptor) → `document_type` + `export_type`
  coherentes; IVA desde la compañía y la regla del país (Colombia: 0 en Por Emitir, lo aplica Odoo).
- **Vencimiento** = emisión + términos de pago (México: emisión + 1 mes); nunca `+30` fijo.
- **Glosa** "PRODUCTO Cuenta X - Periodo dd/mm/aaaa a dd/mm/aaaa", solo guion `-`.
- **Agrupación**: juntas por mes de emisión o por ítem según el contrato; fusión solo con Por Emitir activas, no legacy,
  no unificadas ni NC.
- Escribe con `sapira.writer = 'api'` (standardize no pisa) y devuelve el preview idéntico a lo que persiste.

## 3b. Tipo de cambio (modelo FX v2, Domi 28-09)

- **Una sola regla para toda tasa guardada:** "1 [from] = rate [to]". Fila directa (`from` = moneda del contrato) → se
  **multiplica**; fila inversa (`from` = otra moneda, `to` = moneda del contrato) → `1 / rate`. La inversa queda solo por
  datos viejos: v2 escribe siempre contrato → otra moneda. Misma regla que `invoices.fx_contract_to_invoice` y
  `apply_fixed_fx_to_contract` (multiplican).
- **`contract_fx_period_rates.purpose`** (`company` | `invoice`, default `company`): la tabla guarda las tasas fijas de
  devengo en moneda de la compañía (`fx_company_policy = 'fixed_period'`) y las de facturación (`fx_invoice_policy =
  'fixed'`). Leen solo `company`: `revenue_schedule_apply_fx_for_contract` (rama `fixed_period`, ahora directa × tasa e
  inversa 1/tasa, igual que `monthly_avg`), `calculate_contract_fx_rate` y `bulk_confirm_fx_policy`. Lee solo `invoice`:
  la activación v2 (y la vista previa al crear, con las tasas del body).
- **`companies.fx_company_policy`**: política por defecto de la compañía para el devengo de contratos en otra moneda;
  hoy solo `monthly_avg`. **Un FX fijo se define solo por contrato** (`fixed_period` + tasas `company` propias): la
  política de la compañía nunca crece a `fixed_period`. El contrato la copia al crearse (`company_default`; en el
  wizard, "Usar la política de la compañía (promedio mensual)"). Se editará en Configuración del holding →
  configuración de las compañías cuando ese módulo migre (no ahora).
- **Al crear (C1)**: `invoice_currency` (default la del contrato); `fx_invoice_policy` obligatoria si difiere;
  `fx_invoice_rates[]` ≥ 1 si es `fixed`; `fx_company_policy` `company_default` | `fixed_period` (+ `fx_company_rates[]`)
  solo si la moneda del contrato ≠ la de la compañía. Una tasa sin fechas cubre el contrato; fin > inicio y sin solapes.
  Los `*_confirmed_at` quedan en `now()` cuando la política aplica. Todo en la transacción del borrador.
- **UF (CLF) nunca es moneda de facturación** (Domi 28-09): `invoice_currency = CLF` → 400 ("La UF no se factura…"). Un
  contrato en UF sin moneda de facturación se factura en CLP si la compañía es CLP; si no, es obligatoria. Al activar,
  un borrador viejo con moneda de facturación CLF (o en UF sin ella) → bloqueo `uf_invoice_currency`.
- **Al activar (C2)**: cada factura toma la tasa `invoice` que cubre el inicio de su período; si alguna no tiene →
  bloqueo `fixed_fx_without_rate`. Contrato viejo con `fx_company_policy` NULL y otra moneda → `fx_company_policy_missing`.
- **Corrección de datos**: las 5 tasas CLF → CLP de Hanka Robotics (0.000025, cargadas al revés y compensadas por la
  inversión vieja del RSM) pasan a 40.000 con la migración `1790610000001`, que exige el asset nuevo ya aplicado y
  reconstruye el RSM de esos contratos: el devengo no cambia. SimpliRoute CTR-2026-215 queda fuera (lo revisa Domi).
- **Orden de despliegue**: migración `1790610000000` → assets (3 funciones) → migración `1790610000001` → código.
  `fx.entities.spec` queda en rojo hasta aplicar en producción y refrescar el snapshot (GUIA).

## 4. Triggers compartidos: qué se hace

| Trigger | Qué hace hoy | v2 | Front viejo |
|---|---|---|---|
| `standardize_invoice_items` (BEFORE INSERT) | Pisa cantidad/unitario/subtotal de toda línea con ítem | Costura: se salta con `sapira.writer='api'` | Igual |
| `trigger_generate_invoices_on_status_change` + `..._on_contract_signed` | Generan facturas al pasar a Activo (se saltan si ya hay facturas) | Costura (y de todos modos v2 crea las facturas antes) | Igual |
| `set_contract_item_end_date` | Recalcula `end_date = inicio + término − 1` en cada UPDATE de inicio/término | Costura: v2 escribe el fin explícito | Igual |
| `inherit_auto_renew_from_quote_item` | Trata `false` como null y hereda de la cotización | Costura | Igual (S1-5 diferido) |
| `trg_set_contract_item_categoria` | Categoría por trigger | Costura: v2 manda la categoría calculada | Igual |
| `set_booking_date_on_activate` | Fija booking al activar si es null | Se mantiene (coherente con S2-7) | Igual |
| `trigger_rsm_on_*` (ítems, facturas, cantidades) | Rebuild parcial condicionado al holding de la sesión | v2 hace rebuild explícito; **fix compartido U9** (holding del registro) | Se arregla para ambos |
| `sync_invoice_items_amounts_from_quantities` + restore | Sync de consumos, toca NC | **Fix compartido U13** | Se arregla para ambos |
| `revenue_schedule_rebuild_contract_ccy` | Rebuild parcial reinicia el acumulado | **Fix compartido U8** + rebuild completo (OK aparte) | Se arregla para ambos |
| Guards de período, moneda, `prevent_end_date_update_when_active`, auditoría | Invariantes y log | Se respetan (v2 no los salta; el fin del contrato lo mueve con su bypass explícito y evento) | Igual |

## 5. Se retira al switch de Contratos (anotado, no se toca antes)

`bulk_activate_contracts`, `mark_contract_signed_safe`, `generate_missing_invoices_for_contract` y los 2 triggers de
generación (si ningún otro camino los usa), `create_contract_cross_sell` + `approve_contract_amendment` +
`recalc_revenue_for_contract`, `apply_quote_downsell_to_contract`, `apply_contract_contraction`,
`create_contract_renewal` (+ cron `auto-renew-contract-items`, `process_auto_renewals`, `execute_auto_renewal_for_item`),
`sync_invoices_for_contract_item`, `invoice_reschedule_items`, `check_contract_item_continuity`,
`regenerate_contract_invoices_from_items` / `_for_restructure`, `bulk_restructure_contract_start_dates`,
`change_contract_currency`, `change_contract_commercial_client`, `bulk_confirm_fx_policy`, `apply_fixed_fx_to_contract`,
`migrate…` ya retirada. Y los triggers de la costura, cuando nada escriba sin ella. Cada uno con la doble confirmación.

## 6. Esquema aditivo que pide Contratos v2

| Cambio | Para qué | Nota |
|---|---|---|
| `contracts.billing_anchor_day` (smallint) | Día de ciclo explícito (S3-16) | Backfill = día de `MIN(start_date)` de recurrentes (lo que hoy se deriva) |
| `contracts.payment_terms` (jsonb, misma forma que `client_entities.payment_terms`) | Vencimiento (S1-4, Medios #11) | Default desde la razón social |
| `contracts.document_type` | Tipo de documento del contrato (S1-7) | Deriva `export_type` |
| `contracts.deleted_at` | Borrado lógico (S2-9) | |
| UNIQUE (compañía, número) | Correlativo (S1-1) | Antes resolver los 2 duplicados de prod (CTR-2026-200, 210): **dato, lo revisa Domi** |
| `invoices.fx_policy` (+ tasa por factura) | FX por factura (S6-1) | Se define en el mapa de Facturación |

## 7. Decisiones para Domi (y Leon)

1. **Costura `sapira.writer`** (§1.3 y §4): OK de Domi y de Leon.
2. ✅ Domi 25-09: **las facturas nacen al activar** y el cronograma (`contract_invoices`) es solo la **vista previa
   antes de activar**: v2 no lo escribe (la vista previa sale del generador en memoria). Después de activar mandan las
   facturas (`invoices`). Lectores de `contract_invoices` post-activación en el front viejo: solo el panel de vendedores
   (`useVendedorAnalytics`, Medios #9, ya cuestionado) y el detalle viejo; en v2 esos reportes leen `invoices`.
   El 360 v2 nunca llama "cronograma" a las facturas reales ("Facturas por período").
3. ✅ Domi 25-09: editar borrador (F2) entra en v2; **Reestructurar no se descarta**: se decide al construir, viéndolo
   (puede delegar en las funciones actuales o reemplazarse por F2/F3).
4. **Alcance del lunes** (columna "Lunes"): Contratos = L1–L3, C1, C2, C5, F1, F2, F4, M1, M2; M3 si alcanza. Lo
   demás, después del switch o con enlace temporal al front viejo solo si no corrompe datos v2.
5. AGENTS.md dice que Facturación operativa vive en Vite; si Facturas entra el lunes, se actualiza esa regla.

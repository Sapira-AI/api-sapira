# Spec · Renovación y ajustes pactados (uplift, IPC/UF, cambios programados)

> 29-09-2026 · borrador para revisión de Domi; implementadores: api-sapira (`src/modules/contracts`) y front-sapira
> (`app/(protected)/lab/contratos`). Desarrolla la decisión pendiente #6 (y cierra la #5) de
> [`spec-modificaciones-contrato-v2.md`](./spec-modificaciones-contrato-v2.md) §2.5, §2.8 y §8, con S1-18, S2-2/S2-3 y
> S3-15 de [`auditoria-contratos.md`](./auditoria-contratos.md), el ROADMAP Estratégico #25
> (`sapira-ai/docs/ROADMAP-OPERATIVO.md:179`) y los benchmarks de `benchmarks/`. Lo ya cerrado se cita como
> **DECIDIDO**; lo que este documento propone va como **Propuesta**; lo que no está en ningún doc va como **Supuesto**.
> Este documento no crea esquema: describe lo que habría que construir si Domi lo aprueba.

## 1. Problema y alcance

**Lo que hay hoy**

- Por ítem: `auto_renew`, `auto_renew_term_months` (NULL = mismo plazo), `auto_renewed_at`; relaciones
  `renews_item_id` / `renewed_by_item_id`; categoría `RENEWAL`; `renewal_base_unit_price` para el split del RSM
  (`src/databases/postgresql/entities/contratos/contract-item.entity.ts:93-97,185-197,252`). El contrato solo guarda
  `contract_end_date`, `term` (MAX de ítems) y `renewed_from/to_contract_id` (`contract.entity.ts:112-118,189`); no
  hay política de renovación ni de reajuste en ninguna tabla.
- Renovación automática **rota**: cron 02:00 → `process_auto_renewals(90)` → `create_contract_renewal` v2 falla con
  "Usuario no encontrado" (exige `auth.uid()`), no filtra estado, pierde los ítems que vencen sin procesarse y no hay
  control en el contrato para verla o apagarla. En producción **383 ítems `auto_renew`, 0 renovados nunca**; 290 (casi
  todos SimpliRoute) vencen dic-2026/ene-2027 y entran a la ventana de 90 días desde ~02-10 (`auditoria-contratos.md`
  §S2 y :484-490). Verificado 29-09 en QA (`BEGIN READ ONLY`): 0 ítems `auto_renew`, 182 ítems `RENEWAL`,
  `indicadores_economicos` vacía → **QA no es copia de prod; las cifras de arriba son de la auditoría**.
- Renovación manual v2 (fase C, construida): `renewal` en `contract-changes.ts` `planRenewal` (:1318) renueva N ítems
  atómicamente al **mismo precio**, `term_months` o `end_date` en meses enteros, absorbe ajustes co-terminados, avisa
  retroactiva (`catch_up = backdate`) y **rechaza** `quantity` / `unit_price` / `discount_value` hasta confirmar
  S3-15 (:1333-1340). El front viejo sí permite precio nuevo en un paso (`EnhancedRenewalModal.tsx:106-128`), guardado
  como 1 RENEWAL + `renewal_base_unit_price` + split RSM (`manual-modificaciones-contratos.md` §9).
- Reajuste IPC/UF/%: **no existe** (§2.8 "Hoy"). UF es moneda de contrato, no un reajuste. SimpliRoute hace el ajuste
  anual en diciembre con upsells manuales y términos a diciembre para renovar todo junto (#25).
- El lab ya muestra el interruptor "Auto-renovación" y su plazo por ítem (`PasoItems.tsx:323-343`,
  `contrato-form.ts:59-60,526-528`) y el stepper distingue "Renovación automática" (`LifecycleStepper.tsx:33-49`).

**Lo que Domi pide** (S1-18, #25, precisiones 23-09): pactar **en el alta** cambios que se apliquen **en la renovación**
o **en fechas** del contrato: reajuste por IPC, UF o % fijo, nuevo precio, nueva cantidad, nuevo plazo; que afecten
ítems (categoría y momentum) y facturas futuras; y que el 360 lo muestre ("renueva el 31-12 con +5 % pactado").

**Fuera de alcance**: pausa (§2.6), multimoneda (M3), término indefinido como estado propio (M5: aquí solo se
contempla como renovación automática sin fin), clasificación a nivel cliente (§8 #9).

## 2. Cómo lo modelan los referentes

| Referente | Cambios futuros dentro del plazo | Cambio en la renovación | Índice externo (IPC/CPI) | Fuente |
|---|---|---|---|---|
| **Stripe** | `subscription_schedules` con hasta 10 `phases` secuenciales; cada fase fija precio, cantidad, cupones, `proration_behavior`; `end_behavior release \| cancel`; preview con `invoices/create_preview` | No hay uplift: la "renovación" es la fase siguiente | No | [docs.stripe.com/billing/subscriptions/subscription-schedules](https://docs.stripe.com/billing/subscriptions/subscription-schedules) |
| **Chargebee** | *Ramps* con `effective_from` (hasta ~100, ≥24 h entre sí, hasta 5 años); cambian plan, cantidades, precios, cupones; **vuelven a borrador** si cambia el fin del término o la frecuencia | `contract_terms.action_at_term_end = renew \| evergreen \| cancel \| renew_once`, `contract_billing_cycle_on_renewal` | No | [ramps](https://www.chargebee.com/docs/billing/2.0/subscriptions/ramps) · [contract_terms](https://apidocs.chargebee.com/docs/api/contract_terms) |
| **Zuora** | *Ramp deals*: intervalos (normalmente anuales) con precio/cantidad distintos, métricas por intervalo, cambios mid-interval por orden | *Automated price change (uplift)*: `No Change \| Percentage Increase \| Latest Catalog Pricing`, por tenant, cargo del catálogo o suscripción; solo termed | No | [ramp deals](https://docs.zuora.com/en/zuora-billing/manage-accounts-subscriptions-and-non-subscriptions/manage-subscription-transactions/orders/ramps-and-ramp-metrics/ramp-deals-creation/create-ramp-deals-using-the-zuora-application) · [uplift](https://docs.zuora.com/en/zuora-billing/manage-accounts-subscriptions-and-non-subscriptions/manage-subscription-transactions/common-subscription-information/automated-price-change-uplift-for-renewed-subscriptions) (página requiere JS; contenido según `benchmarks/benchmark-modificaciones-pausa-escalamientos.md` §3) |
| **Maxio** | No hay escalador dentro del plazo documentado (`benchmark-maxio.md` :150) | Auto-renewal con **Renewal Factor**: el % se aplica al renovar y todo pasa a *custom pricing* de la suscripción (deja de seguir el catálogo) | No (sin UF/indexación, :41) | [Auto-Renewal](https://docs.maxio.com/hc/en-us/articles/34239378510349-Auto-Renewal) |
| **Alguna** | `price_escalation {percentage, interval_months, escalate_metered_unit_rates}` + versiones programadas; Changes API con `effective: immediate \| next_billing_period \| next_term_renewal \| fecha` y `POST /changes/preview` | `renewal {...}` en la suscripción | No | `benchmarks/benchmark-alguna.md` :11,24,30 |
| **Zenskar** | Fases (`ContractPhase[]`, `is_enabled [{value, effective_from}]`) como primitiva única de cambio temporal | `renewal_policy` (incompleto en API) | No | `benchmarks/benchmark-zenskar-docs.md` :65-68 |
| **Ordway** | "Schedule percentage increases, apply fixed dollar amounts, or tie changes to benchmarks such as CPI" | Mismo mecanismo "upon renewal" | **Sí (CPI)** | [ordwaylabs.com/products/subscription-billing-software](https://ordwaylabs.com/products/subscription-billing-software/) |
| **Younium** | *Order adjustment* con Effective Change Date; **indexación** con fecha futura bloquea cambios anteriores; herramienta de *price index adjustments* masiva para cláusulas CPI/índice propio | Renewal como cambio de orden | **Sí (CPI / índice propio)** | [Order adjustment](https://support.younium.com/hc/en-us/articles/24629130762002-Order-adjustment) · [product updates](https://www.younium.com/blog/younium-product-updates) |
| **Relvo** | Contrato sucesor completo (`amended_from_contract_id`, `revision_number`); CLF/UF como moneda | — | UF como moneda, no como reajuste | `benchmarks/benchmark-relvo-api.md` :26-29,39 |

**Lectura para Sapira.** Tres familias: (1) **fases** (Stripe, Zenskar, ramps de Chargebee/Zuora): el contrato es una
secuencia de estados completos; (2) **política en el objeto** (Zuora uplift, Maxio renewal factor, Chargebee
`action_at_term_end`, Alguna `price_escalation`): un parámetro que el motor lee al renovar; (3) **cambios
programados con fecha efectiva y preview** (Alguna Changes API, Younium indexación, Ordway): el cambio es un registro
que se materializa en su fecha. Ninguno de los cinco grandes indexa a CPI de forma nativa: solo Ordway y Younium
(mercados con cláusulas de indexación, como Chile con IPC/UF).

**Patrón que encaja** (confirma §2.8 recomendación (3) y §8 #6): **cambios programados tipados** que al llegar su
momento se materializan con el **mismo motor de Changes API con preview** (`contract-changes.ts`) como ítems de ajuste
del modelo acumulativo (RENEWAL + UPSELL/DOWNSELL con `related_item_id`), evento en `contract_lifecycle_events` y
facturas Por Emitir del generador v2 (`billing-engine.ts`). No introduce fases ni versiones: el ítem madre, el estado
derivado (`contract-status.ts`) y el RSM siguen funcionando igual. La "política en el objeto" (familia 2) queda cubierta
como caso particular: un cambio programado con `trigger = on_renewal`. Ventaja frente a Chargebee: como el cambio se
guarda como intención y se recalcula al aplicarse, editar el contrato no lo invalida; solo se re-previsualiza.

## 3. Propuesta de modelo

### 3.1 Entidad `contract_scheduled_changes` ("ajustes pactados")

Nombre tentativo (§9 Supuesto 4 de la spec de modificaciones). Una fila = una promesa comercial sobre el contrato o
sobre un ítem, con su regla de disparo y su valor. **Esquema aditivo**: no toca `contract_items` ni `contracts`.

| Campo | Tipo | Notas |
|---|---|---|
| `id`, `holding_id`, `contract_id` | uuid | RLS por holding como el resto de `contratos/*` |
| `contract_item_id` | uuid nulo | NULL = alcance contrato (todos los ítems recurrentes vigentes al aplicar); con valor = solo ese ítem (y sus ajustes co-terminados, como hace `planRenewal`) |
| `trigger` | `on_renewal` \| `on_date` \| `every_n_months` | `on_renewal`: se aplica cuando el ítem se renueva (manual o automática). `on_date`: `effective_date` fija. `every_n_months`: recurrente desde `anchor_date` cada `interval_months` (p. ej. 12 = ajuste anual en diciembre) |
| `effective_date`, `anchor_date`, `interval_months` | date, date, int | Según trigger. Para `every_n_months` cada aplicación genera una fila hija `applied` y deja la madre `scheduled` con `next_effective_date` |
| `kind` | `percent_uplift` \| `index` \| `new_unit_price` \| `quantity` \| `term` | Ver 3.2. Una fila = un solo `kind`; varios cambios en la misma fecha = varias filas con el mismo `group_key` (se previsualizan y aplican juntas) |
| `value` | numeric(18,6) | %, precio, cantidad o meses según `kind` |
| `index_code` | text nulo | Solo `kind = index`: código de `indicadores_economicos.codigo` (IPC `F07.IPC.IND.Z.Z.EP18.Z.Z.Z.M`, UF `F073.UFF.PRE.Z.D`, dólar `F073.TCO.PRE.Z.D`; enum `IndicadorEconomico` en `src/modules/banco-central/interfaces/banco-central.interface.ts:21-33`) |
| `index_base_date`, `index_base_value` | date, numeric | Referencia del índice al pactar (se congela al crear la fila, como snapshot); la variación = `valor(fecha_aplicación) / index_base_value − 1` |
| `index_lag_months` | int, default 1 | IPC se publica con desfase: usar el último valor publicado ≤ `effective_date − lag` (Supuesto) |
| `rounding` | `none` \| `unit_2` \| `unit_0` \| `monthly_0` | Redondeo del **precio unitario** resultante (Supuesto: default `unit_2`; CLP suele pedir `unit_0`) |
| `status` | `scheduled` \| `applied` \| `skipped` \| `cancelled` | `skipped` = la usuaria decidió no aplicarlo en esa renovación/fecha, con motivo; `cancelled` = retirado antes de vencer |
| `applied_change_id` | uuid nulo | Enlace al evento `contract_lifecycle_events.id` del cambio que lo materializó (Supuesto 5 de la spec: `Idempotency-Key`/origen en `metadata`); desde ahí se llega a los ítems creados |
| `applied_at`, `applied_value` | timestamptz, numeric | Valor efectivamente usado (p. ej. IPC real 4,3 % vs "IPC" pactado) |
| `origin` | jsonb | `{ type: 'manual' }` \| `{ type: 'quote', quote_id }`: los pactos suelen venir de la cotización/CRM |
| `notes`, `created_by`, `created_at`, `updated_at`, `cancelled_by`, `cancel_reason` | | Trazabilidad (`flexibilidad-con-trazabilidad.md` §1) |

### 3.2 Semántica por `kind` (qué cambio tipado produce)

| `kind` | Al aplicarse se traduce en | Categoría / momentum |
|---|---|---|
| `percent_uplift` | `unit_price_nuevo = unit_price_vigente × (1 + value/100)` sobre el valor del ítem madre | UPSELL (o DOWNSELL si negativo) subtipo `price_step` (benchmark §3 opinión); se reporta como **expansión de precio** separada del volumen |
| `index` | igual, con `value` = variación del índice entre `index_base_value` y el valor vigente a la fecha; si no hay dato publicado → blocker `index_value_missing` (no se aplica en silencio) | idem |
| `new_unit_price` | `unit_price_nuevo = value` (moneda del contrato) | UPSELL/DOWNSELL por signo (fórmula unificada de `item_change`) |
| `quantity` | `quantity_nueva = value` | UPSELL/DOWNSELL por signo |
| `term` | `term_months = value` para la renovación (reemplaza `auto_renew_term_months` cuando ambos existen; Supuesto: la fila gana) | Afecta el RENEWAL, no crea ajuste |

### 3.3 Cómo se aplica

- **`on_renewal`**: `planRenewal` lee las filas `scheduled` del ítem (y las del contrato) y arma el plan
  **RENEWAL al valor anterior + ítem de ajuste** (S3-15 con dos ítems explícitos, decisión #2). El preview muestra
  "renueva 12 m · 1.000 → 1.050 (+5 % pactado)". La usuaria puede **omitir** el pacto en ese acto (fila → `skipped`,
  motivo obligatorio) o cambiar el valor (se aplica el nuevo y la fila guarda `applied_value` ≠ `value`). Esto
  **desbloquea S3-15 en la práctica**: la renovación con cambio de precio deja de ser un `unit_price` libre y pasa a
  ser un pacto trazable; el precio libre queda como `new_unit_price` creado en el momento (misma tabla, `status`
  `applied` de inmediato). **Propuesta**: aceptar `unit_price`/`quantity` en `renewal` solo por esta vía.
- **`on_date` / `every_n_months`**: un **job diario** (`@Cron`, mismo patrón que `exchange-rates.scheduler.ts`)
  materializa las filas con `effective_date ≤ hoy + N` como un `item_change` **con preview y evento**, en dos modos por
  holding (Supuesto): `auto` (aplica y notifica) o `confirm` (crea la propuesta, notifica, la usuaria aplica desde el
  360; default `confirm`, coherente con S2-2 "propone y la usuaria confirma"). El job usa un usuario de sistema del
  holding en el evento (`created_by = system`, `metadata.trigger = scheduled_change:<id>`), que es justo lo que le
  faltó al cron viejo. Idempotente por `id` de la fila.
- **Fecha efectiva**: `on_date` rige desde el inicio de período ≥ `effective_date` (sin prorrateo, como downsell y
  renegociación S3-5/S3-6; Supuesto: el reajuste no prorratea porque las cláusulas chilenas aplican al período
  siguiente). Si Domi quiere prorrateo, se reusa `first_period_invoice: 'cycle' | 'immediate'` (S3-17).
- **Facturas Por Emitir**: regla existente de `item_change` (spec §3 y decisión #11): las PE **no emitidas** con
  período ≥ fecha efectiva se regeneran con el generador v2 (fusión por período, línea neta S3-14); emitidas no se tocan
  (NC/ND solo si la usuaria lo pide). El preview cuenta cuántas PE cambian y cuántas quedan fuera.
- **RSM**: `revenue_schedule_rebuild(contrato, desde_mes)` en la misma transacción (mapa §1.4); mes 1 separa base y
  delta como hoy con la renovación (manual #12).
- **CMRR / proyección**: mientras la fila está `scheduled`, **no** cambia el MRR (S5-3 solo excluye pendiente de
  renovar); se expone como "MRR pactado" en el widget del 360 y en un KPI opcional de la lista (Supuesto; Chargebee lo
  incluye en el CMRR, Maxio no cuenta renovación al mismo valor).
- **Cambios manuales posteriores**: si la usuaria modifica el ítem antes de la fecha, la fila sigue `scheduled` y el
  preview recalcula sobre el valor vigente (a diferencia de los ramps de Chargebee, que vuelven a borrador). Si el ítem
  termina (churn) o se renueva sin ella, la fila pasa a `cancelled` con `cancel_reason = item_ended` automáticamente.

### 3.4 Fuente del índice

`indicadores_economicos` (`src/databases/postgresql/entities/fx/indicador-economico.entity.ts`: `codigo`, `fecha`,
`valor`, único por código+fecha) ya se sincroniza a diario desde el Banco Central con `syncIndicators`
(`banco-central.service.ts:76-91` incluye UF e IPC) cuando `BANCO_CENTRAL_SYNC_ENABLED`. **Verificar en prod** que la
serie IPC tiene datos (en QA la tabla está vacía; Supuesto: en prod sí, porque el reporte FX depende de UF/USD). El IPC
del BC es un **índice mensual** (base 2018): la variación entre dos meses es `valor_m2 / valor_m1 − 1`; el preview
muestra ambos valores y fechas para que la usuaria valide contra el INE. UF y dólar son **diarios**: para `index =
UF` la variación se toma entre `index_base_date` y `effective_date` (solo tiene sentido en contratos en CLP; en
contratos en UF el reajuste ya está implícito y el sistema lo advierte).

## 4. UI (lab `/lab/contratos`)

- **Alta** (`PasoCondiciones.tsx`, nuevo bloque **Renovación**): `Renovación: automática | manual` (default manual;
  automática marca `auto_renew` en todos los ítems recurrentes, editable por ítem en `PasoItems`) · `Plazo de
  renovación` (meses; default = plazo del ítem) · `Aviso previo` (días, default del holding: 30, S2-3) · tabla
  **Cambios pactados** con filas `Cuándo (En la renovación | Fecha | Cada N meses desde…) · Qué (Reajuste % | Reajuste
  por índice IPC/UF/USD | Nuevo precio unitario | Nueva cantidad | Nuevo plazo) · Valor · Redondeo · Nota`. Alcance por
  defecto: contrato; por ítem con selector "Aplicar a…". `PasoRevisar` muestra la línea "Renovación automática cada 12
  m · +IPC pactado" y `FacturasPreview` **no** cambia (los pactos no generan facturas hasta aplicarse).
- **360**: `LifecycleStepper` paso "Renovación automática · 31-12-2026 · +5 % pactado" (o "Renovación manual · 31-12
  · sin cambios pactados"); widget **Próxima renovación** en `resumen-widgets.tsx`: fecha, ítems que renuevan, MRR
  actual → MRR simulado con los pactos (llamado al preview de `renewal` en modo simulación), botones "Renovar ahora" /
  "Ver pactos"; en `ContratoFactsStrip` chip "N cambios pactados"; `ContratoHistorialTab` lista los `applied` como
  eventos normales (con ΔMRR y enlace a facturas) y los `scheduled` en una sección "Programados" con acción
  Cancelar/Omitir (motivo obligatorio).
- **Modificar contrato** (drawer de cambios existente): nuevo tipo **Programar cambio** = crear una fila
  `contract_scheduled_changes` desde un contrato activo (mismo formulario que el alta). Los tipos ya construidos no
  cambian.
- **Lista**: columna opcional "Pactos" (icono + tooltip "+5 % en renovación 31-12") y filtro "Con cambios pactados";
  tarjeta KPI **Renuevan en 30 días** (ya existe "Vencen en 30 días", mapa L3 :63; se separa lo que renueva solo de
  lo que necesita decisión).

## 5. Renovación automática v2 (reemplazo del cron roto)

**DECIDIDO** (#5, §2.5, E2): el cron viejo no se arregla; se apaga al publicar E2. **Propuesta de E2 con pactos**:

1. **Job diario** `contracts-auto-renewal` (`@Cron` en `src/modules/contracts`, 06:00 después del RSM), por holding:
   - selecciona ítems recurrentes con `auto_renew = true`, `renewed_by_item_id IS NULL`, `churn_date IS NULL`,
     contrato en estado derivado `active | pending_renewal` (nunca `cancelled`/`draft`, S2-2/S2-10) y `end_date` ≤ hoy +
     `aviso_previo` (30 días por holding, S2-3);
   - **N días antes**: crea una **propuesta de renovación** (evento `RENEWAL_PROPOSED` con el plan preview: ítems,
     plazo, pactos `on_renewal`, MRR antes/después) y notifica (infra `app_notifications`, ROADMAP C-Notificaciones);
     no toca ítems ni facturas;
   - **al vencer** (`end_date < hoy`): modo por holding (Supuesto, default `confirm`): en `confirm` la propuesta queda
     en el KPI "Por renovar" con alertas crecientes (S2-1/S5-4); en `auto` ejecuta `planRenewal` + pactos con
     `created_by = system`, evento `RENEWAL` con `metadata.trigger = auto_renewal`, facturas nuevas con el generador
     v2 (F1: tipo de documento, vencimiento por términos, último período proporcional S4-16) y actualiza fin del
     contrato (el más próximo) y `total_value` (M3).
   - Idempotente por ítem (`auto_renewed_at`), atómico por contrato (S3-8), y **nunca renueva más de un plazo** aunque
     el ítem lleve meses vencido: la renovación tardía parte en `fin + 1` con `catch_up = backdate` (S5-4) y lo avisa.
2. **Control visible**: el 360 muestra la propuesta con "Renovar ahora / Omitir esta vez / Apagar auto-renovación"
   (hoy no hay control, auditoría :487). Apagar = `auto_renew = false` en los ítems + evento `CONDITIONS_UPDATED`.
3. **Migración de los 290 ítems de SimpliRoute**: al publicar E2 en modo `confirm` **no pasa nada automático**; la
   usuaria ve "Renuevan en 30 días" desde ~02-12 y decide. Si SimpliRoute quiere el ajuste anual de diciembre en el
   mismo acto, se cargan filas `on_renewal` `percent_uplift` (o `index IPC`) masivas por contrato (acción en
   `ajustes-masivos`) antes de esa fecha. Así desaparece el riesgo de "renovación en masa antes del ajuste" (:488-490).
4. **Apagado del legado**: `cron.job` `auto-renew-contract-items`, `process_auto_renewals`,
   `execute_auto_renewal_for_item`, `get_items_pending_auto_renewal` → RETIRAR junto con `create_contract_renewal`
   (spec §7 fila `renewal`). El trigger `inherit_auto_renew_from_quote_item` se corrige para respetar `false` (S1-5).

## 6. Etapas de construcción y esquema aditivo

| Etapa | Contenido | Prerrequisito | Esquema |
|---|---|---|---|
| **R0 · Decidir** | Preguntas de §7; confirmar S3-15 (dos ítems) y modo `confirm` por defecto | — | ninguno |
| **R1 · Renovación con precio pactado** | `contract_scheduled_changes` + CRUD en `POST/GET/PATCH /contracts/:id/scheduled-changes` (BFF `app/api/contratos/[id]/cambios-pactados`); `planRenewal` acepta pactos `on_renewal` y `new_unit_price`/`quantity`/`term` declarados en el acto (dos ítems explícitos); alta con bloque Renovación; 360 stepper + widget + Historial | Fase C ya construida; U8/U9 RSM | **Migración 1**: tabla nueva + índices (`contract_id, status`, `effective_date`) + RLS por holding; entity a mano según `GUIA-CAMBIOS-DE-ESQUEMA.md` (commit antes de aplicar; `schema:status` en QA) |
| **R2 · Auto-renovación E2** | Job diario propuesta/ejecución, notificaciones, KPI "Renuevan en 30 días", control en el 360; apagar cron legado; fix S1-5 | R1; infra notificaciones | **Migración 2**: `holding_settings.auto_renewal_notice_days` (default 30) y `auto_renewal_mode` (`confirm \| auto`) — o `custom_fields` del holding si Domi prefiere no tocar esquema (Supuesto) |
| **R3 · Cambios en fecha e índices** | `on_date` / `every_n_months`; job de materialización; `index` con `indicadores_economicos`; "Programar cambio" en Modificar contrato; filtro en la lista | Fase D (`item_change`) construida; IPC verificado en prod | ninguno adicional (misma tabla) |
| **R4 · Masivo y CRM** | Carga masiva de pactos (SimpliRoute diciembre); `origin = quote` desde cotización/Salesforce/HubSpot | R3; mapa de cotizaciones | ninguno |

Tests (regla dura): `planRenewal` con pacto `percent_uplift` (1.000 → 1.050: RENEWAL 1.000 + UPSELL 50, mes 1 split),
`index` sin dato → blocker, `skipped` con motivo, `every_n_months` genera fila hija y `next_effective_date`, job
idempotente, ítem con churn cancela sus pactos; front: `PasoCondiciones` bloque Renovación, widget con MRR simulado.

## 7. Preguntas para Domi — estado 01-10

> Decisiones finales de Domi (01-10). Diseño y migración en [`spec-modificaciones-contrato-v2.md`](./spec-modificaciones-contrato-v2.md) §9
> (9.3.4 renovación con precio, 9.3.5 auto-renovación, 9.3.6 pactos, 9.4 migración). Cambios respecto de §3–§6: la columna
> `applied_change_id` se llama `applied_event_id`; `kind` suma `billing_frequency` (cambio de frecuencia = ítem nuevo + pacto, S3-15); se agregan
> `parent_id`, `next_effective_date`, `status_reason`/`status_changed_by` (reemplazan `cancelled_by`/`cancel_reason`). El cron legacy ya está
> desprogramado; sus funciones se retiran al switch.

1. **Modo de la renovación automática** — ✅ **DECIDIDO: confirmación del holding** (`confirm`). El job solo propone (`RENEWAL_PROPOSED`) y la
   usuaria confirma, omite o apaga; el modo `auto` **no se construye** y la Migración 2 queda reducida a `holding_settings.auto_renewal_notice_days`
   (default 30). Los pactos `on_date`/`every_n_months` siguen el mismo criterio (evento `SCHEDULED_CHANGE_DUE` + confirmación).
2. **Reajuste por IPC** (acumulado desde la base vs. 12 meses; desfase) — sin decisión explícita: se construye con la propuesta (acumulado desde
   `index_base_value`, `index_lag_months = 1` por fila, editable al pactar); el preview muestra ambos valores. Pendiente de confirmar en R3.
3. **Prorrateo del reajuste `on_date`** — sin decisión explícita: se construye **sin prorrateo** (rige desde el próximo inicio de período, como
   downsell/renegociación). Pendiente de confirmar en R3.
4. **Redondeo** — sin decisión explícita: `rounding` por fila (default `unit_2`, `unit_0` sugerido en CLP). Pendiente de confirmar en R3.
5. **Métrica del pacto pendiente** — sin decisión explícita: solo "MRR pactado" en el 360; el MRR real no cambia hasta aplicarse. KPI de lista
   (CMRR) queda pendiente.
6. **Precio libre en la renovación** (S3-15) — ✅ **DECIDIDO: sí**. `renewal` acepta `quantity`/`unit_price`/`discount_value`, guarda **dos ítems**
   (RENEWAL al valor anterior + ajuste) y registra el pacto aplicado (`new_unit_price`/`quantity`, `status applied`) en el mismo acto; además
   **extiende la tasa FX de todo el contrato** (o pide la del nuevo término) en la misma operación. `EnhancedRenewalModal` y `create_contract_renewal`
   se retiran al switch.

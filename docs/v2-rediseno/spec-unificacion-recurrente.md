# Unificación recurrente de facturas desde Razón social 360

Decisiones de Domi (05-10). Caso de origen: Ironside → Ninja Hubs, dos clientes comerciales que facturan a la misma razón social.

## 1. Qué hace

En **Razón social 360**, la tarjeta **"Facturación unificada"** guarda una **regla**: qué contratos de esa razón social se facturan en
un solo documento cada mes y cuál es el **contrato principal**. Al confirmarla:

- Se unifican **todas las Por Emitir** de esos contratos, mes a mes, **incluidas las de meses pasados** (D3 de Domi: si sigue Por
  Emitir se unifica, no importa el mes), mientras no se hayan enviado al ERP.
- Las que nazcan después (renovación, modificación, consumo que crea una complementaria) se unifican solas con un **job diario**
  antes del envío automático.
- La **fecha de emisión** de la unificada es la de la factura del contrato principal en ese mes (D1: por defecto el principal, y la
  usuaria **confirma** esa fecha antes de guardar). Sin factura del principal ese mes, la más temprana. El vencimiento es el más
  tardío de las facturas del principal ese mes. La regla **no guarda un día propio** (Domi 07-10, sin campos duplicados: el día ya vive
  en las facturas del principal): para otro día **en un mes**, se **reprograma la factura unificada** (Reprogramar, ver §5); para
  **todos los meses**, se cambia el día de facturación del contrato
  principal o se elige otro principal. Una fecha que ya
  pasó se mantiene: no se mueve a "hoy".
- Si después aparece **otro contrato activo** a esa razón social que no está en la regla, **no se suma solo** (D2, opción A): la
  tarjeta lo avisa con "Sumar a la unificación" y aparece la tarea **"Contratos nuevos para unificar"**.

Reutiliza la consolidación existente (`invoice-consolidation.ts`, `ContractInvoiceConsolidationService`, spec multimoneda §7): mismas
condiciones (compañía, moneda de factura, mes, documento, `export_type`, serie, tasa), mismo documento `Unificada`, deshacer y
re-copia por consumo. Tipo de cambio sin cambios: **fija** sin tasa → la unificada queda bloqueada hasta cargarla; **spot** → la del
día de emisión.

## 2. Esquema (único objeto nuevo)

Revisado contra producción: no hay nada que guarde una regla entre contratos. `contract_billing_splits` reparte **un** contrato entre
compañías; `contracts.group_invoices_by_period` agrupa líneas **dentro** de un contrato; `invoices.consolidated_into_invoice_id` es el
vínculo de cada documento, no la regla.

`invoice_consolidation_rules` (entity `contratos/invoice-consolidation-rule.entity.ts`, migración nueva, RLS por holding):

| Columna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `holding_id` | uuid NOT NULL | FK `company_holdings` |
| `client_entity_id` | uuid NOT NULL | FK `client_entities`; **UNIQUE (`holding_id`, `client_entity_id`)**: una regla por razón social |
| `main_contract_id` | uuid NOT NULL | FK `contracts`; fecha de emisión y encabezado |
| `contract_ids` | uuid[] NOT NULL | CHECK `cardinality >= 2`; incluye al principal |
| `status` | text NOT NULL default `active` | CHECK `active`/`paused` (nunca se borra: se pausa) |
| `created_by` / `updated_by` | uuid NULL | FK `users` |
| `created_at` / `updated_at` | timestamptz | |

Nada más se guarda: el estado por mes (unificado, pendiente, bloqueado, un solo contrato) se **deriva** en cada lectura de las Por
Emitir y de los eventos `INVOICE_CONSOLIDATED` (cuya metadata ahora lleva `rule_id`).

## 3. API (`client-entities/:id/invoice-consolidation`, módulo contracts)

- `GET` → `{ rule, contracts[], new_contract_ids[], months[], summary }`
  - `rule`: `null` o `{ id, status, main_contract_id, contract_ids, created_at, updated_at, created_by: { id, name } | null }`.
  - `contracts[]`: contratos **activos** de la razón social `{ id, contract_number, client_id, client_name, company_id, company_name,
    invoice_currency, document_type, in_rule, emission_day }` (`emission_day` = día del mes de sus próximas Por Emitir, o null; se
    calcula en cada lectura, no se guarda).
  - `new_contract_ids[]`: activos que no están en la regla (solo con regla).
  - `months[]` (solo con regla; Por Emitir de los contratos de la regla, del más antiguo al más nuevo):
    `{ month, state: 'unified' | 'pending' | 'blocked' | 'single', issue_date, due_date, unified_invoice: { id, invoice_number, status, issue_date,
    total, currency } | null, invoices: [{ id, contract_id, contract_number, issue_date, total, currency }], totals, lines[], blockers:
    [{ code, message }], warnings: [{ code, label, message }] }` (`due_date` y `lines[]` solo en los meses por unir; ver §5).
  - `summary`: `{ unified, pending, blocked, single }`.
- `POST …/preview` `{ contract_ids, main_contract_id }` → `{ main_contract: { id, contract_number, emission_day },
  months[] (state 'will_unify' | 'already_unified' | 'blocked' | 'single', issue_date, due_date, invoices, totals: [{ currency, total }],
  lines, blockers, warnings), summary: { will_unify, already_unified, blocked, single } }`. Sin escribir. `main_contract.emission_day` es
  el día de las Por Emitir del principal (el de la unificada).
- `PUT` `{ contract_ids, main_contract_id, confirm_issue_date: true }` → guarda la regla (crea o reemplaza contratos/principal; queda
  `active`) y unifica ya → el `GET` más `result: { unified, blocked }`. 400 si falta `confirm_issue_date`, menos de 2 contratos, un
  contrato que no es de la razón social o el principal fuera de la lista.
- `POST …/pause` `{ undo_pending: boolean }` → `paused`; con `undo_pending`, deshace las unificadas de la regla que sigan Por Emitir y
  sin borrador en el ERP. `POST …/resume` → `active` y unifica.

Formas: `month` es `YYYY-MM`; `blockers` son `{ code, message }` y `warnings` `{ code, label, message }` (§5); `result.unified` / `result.blocked` cuentan **documentos**
(un mes puede dar más de uno si hay facturas en otra moneda o de otra compañía); `pause` devuelve el `GET` más `result: { undone, kept }`;
`resume` no lleva body y devuelve el `GET` más `result`. Un contrato de la regla que dejó de estar activo sigue en `rule.contract_ids` y no
aparece en `contracts[]`; al editar la regla se quita. Las facturas que nacieron unificadas no se deshacen al quitar un contrato.

Re-unificación: si un mes ya tiene la unificada de la regla y aparece otra Por Emitir de un contrato de la regla, el job (y el `PUT`)
deshace la unificada (si sigue Por Emitir sin borrador en el ERP) y la vuelve a armar con todas; si ya salió, el mes queda `blocked`
con `unified_already_sent`. Deshacer y volver a armar van en **una transacción** (`reunifyInvoices`) y la nueva **hereda** lo que la
usuaria hizo en la anterior (ver §5): referencias OC/HES, glosas escritas a mano y fechas reprogramadas.

Job diario `contracts-consolidation-rules` (`ContractsScheduler`, 06:30 America/Santiago: después del horizonte y las renovaciones y antes
del envío automático), con el interruptor de los jobs de contratos `CONTRACT_JOBS_ENABLED` (encendido por defecto; **apagado en la API
local que lee producción**). Actúa a nombre de quien dejó la regla (`updated_by`, si no `created_by`): el historial del contrato exige autor.

Tarea `consolidation_new_contracts` (Facturación, warning): razones sociales con regla activa y contratos activos fuera de ella; con una
sola, el enlace va a su 360.

## 4. Front (Razón social 360)

- Tarjeta **"Facturación unificada"** en la columna derecha (sobre Condiciones de pago). Solo con 2 o más contratos activos.
  - Sin regla: una línea de qué hace y botón **"Unificar facturas"**.
  - Con regla: contratos (principal marcado), "Se emite el día N, como CTR-…" (N = `emission_day` del principal), resumen (unificadas · pendientes · bloqueadas con
    motivo), aviso de contratos nuevos con **"Sumar a la unificación"**, **Editar** y **Pausar** (con la opción de deshacer las que
    siguen Por Emitir) / **Reanudar**.
- Drawer **"Unificar facturas"**: elegir contratos (casillas, con compañía y moneda), elegir el principal (radio, con su día de
  emisión), vista previa por mes (unifica · ya unificada · no se puede: motivo · un solo contrato) y casilla **"Confirmo que la factura
  unificada se emite en la fecha del contrato principal"**; Guardar (`SaveButton`) deshabilitado sin confirmar.
- BFF `app/api/razones-sociales/[id]/unificacion/*` (`withAuth`; leer `LECTURA_O2C`, escribir `EDIT_FACTURACION`; entrada propia en
  `PERMISOS_BFF`); la vista previa es `…/unificacion/vista-previa` para que cuente como lectura. Ayuda: `docs/documentacion-funcional/clientes/unificar-facturas.md` + novedad.

## 5. Glosas, avisos, referencias, re-unificar y líneas en 0 (Domi 07-10)

- **Glosa de la unificada**: la glosa original va primero (producto, período y lo que siga) y el número de contrato **al final**
  (`PLATAFORMA - Periodo 01/09/2026 a 30/09/2026 - CTR-2026-12`; `suffixContractNumber` en `invoice-consolidation.ts`). Si supera el
  límite del documento (`description_max_chars` del contrato principal): primero se quita el número de contrato; si la glosa sola tampoco
  cabe, se recorta su **final** (nunca el comienzo ni el período por delante). La línea queda `description_fitted: true` y el plan avisa
  `description_fitted`. No duplica el número (ni al final ni el prefijo de antes del 07-10). La re-copia por consumo
  (`resyncFromOrigins`) usa la misma regla y el principal de la unificada.
- **Avisos** `{ code, label, message }`: `label` es un chip de 2–4 palabras y `message` el tooltip de una línea, sin jerga. Los `code` no
  cambian.

  | code | label | message |
  |---|---|---|
  | `auto_invoice_differs` | Emisión manual | Un contrato se emite solo y otro no: la factura unificada no se emite sola; emítela tú. |
  | `auto_send_to_erp_differs` | Envío al ERP: manual / Envío al ERP: automático | Un contrato envía solo al ERP y otro no: la factura unificada sigue al contrato principal (CTR-…) y no se envía sola; envíala tú. / … y se envía sola. |
  | `pair_rates_differ` | Tipos de cambio distintos | Las líneas en USD>CLP mantienen el tipo de cambio de su factura: no hay uno solo. |
  | `spot_document` | Cambio al emitir | Hay líneas sin tipo de cambio: toda la factura usa el del día de emisión (…, también las que tenían uno fijo). |
  | `references_inherited` | Pide OC | Pide OC: puedes enviarla como borrador y agregar la OC antes de emitir. |
  | `description_fitted` | Descripciones acortadas | N descripciones no caben en el documento: va sin número de contrato o acortada al final. |

  Envío al ERP: no se guarda en la factura; el envío automático (`InvoiceSchedulerService`) mira `contracts.auto_send_to_odoo` del
  contrato de la factura, y la unificada lleva el **contrato principal**. Por eso el aviso y `header.auto_send_to_erp` siguen al principal
  (antes el encabezado decía "AND de los orígenes", que no era lo que pasa). La emisión automática (`auto_invoice`) sí es AND de los
  orígenes y se guarda en la unificada.
- **Fecha de emisión**: la de la factura del principal del mes (`planConsolidation` con `main_contract_id`); el vencimiento, el más
  tardío de esas facturas. Se quitó el día propio de la regla (07-10): duplicaba el día que ya tienen las facturas del
  principal. Otro día para un mes = **Reprogramar** la unificada; para todos los meses = cambiar el día de facturación del contrato
  principal (o elegir otro principal). Re-unificar conserva una fecha reprogramada (ver abajo) y la re-copia por consumo también
  (`resyncFromOrigins` mantiene las fechas de la unificada).
- **La unificada v2 Por Emitir sale como cualquier factura** (Domi 07-10, caso Brightcell: una unificada de un principal sin envío
  automático no tenía cómo salir). `ContractInvoiceRow.unified_v2` (columna derivada en `CONTRACT_INVOICE_SELECT`: `Unificada` con evento
  `INVOICE_CONSOLIDATED`, `unifiedV2Sql`) e `isPendingUnifiedV2` (v2, Por Emitir, activa, no origen) dejan fuera `unified_invoice` vía
  `operationBlockers` en: **Enviar al ERP ahora** (`planSendNow`: 360, masivo de Facturación y la cola), **Reprogramar** (una, "esta y las
  siguientes" del principal, y masivo), **Restablecer borrador del ERP** (`planErpReset` y `erp_reset_available` del 360) y **Tipo de
  cambio** (`planFx`) **solo con un par que convierte o ninguno**: con dos o más pares queda `unified_invoice` con "Tiene líneas con
  distintos tipos de cambio: ajústalos en cada contrato de origen y se re-copian"; con un par avisa `unified_recopy_fx` (una re-copia
  desde los orígenes vuelve a la tasa de cada origen). Sus demás bloqueos reales siguen (borrador en el ERP, OC exigida al emitir, IVA,
  producto sin mapeo, `erp_send_disabled` si el principal no envía al ERP…). La cola de Facturación y Tareas (`BillingReadService.queue`)
  ya no la cuentan bloqueada por `unified_invoice`. `commonBlockers` no cambia: editar líneas, anular, NC, facturar por OC, reorganizar y
  registrar emisión externa siguen bloqueados en la unificada; los orígenes, las históricas y las `Consolidada`, en todo.
  - **Reprogramar y devengo**: reprogramar escribe solo `issue_date`/`scheduled_at`/`due_date`/`original_issue_date` de la unificada; los
    orígenes (inactivos) no se tocan ni se re-copian. El devengo (`revenue_schedule_rebuild_contract_ccy`) reparte por el período de
    servicio de las líneas (`billing_period_start`), no por la emisión, y el facturado por `issue_date` cuenta solo emitidas: una Por Emitir
    reprogramada no lo mueve, así que no hay rebuild (la unificada no lleva `nc_revenue_treatment`, el único caso que reconstruye). Los
    grupos de la regla se arman por el mes de los **orígenes**, así que reprogramar la unificada a otro mes no crea otra.
  - **Envío al ERP**: el scheduler (`InvoiceSchedulerService`, manual `sendInvoiceById` y automático `getInvoicesToSend`) carga **todas**
    las líneas por `invoice_id` (sin filtrar por `contract_id`), el encabezado y el contrato del principal (condiciones T&C,
    `invoice_origin`, política de FX); las líneas de varios pares se valorizan por par (`requiresPairValuation`).
- **Referencias OC/HES en la unificada** (caso Brightcell de SimpliRoute): la unificada hereda "Pide OC" (`requires_references_for_billing`
  y el aviso `references_inherited`), así que la OC se agrega **en la unificada** antes de emitir, por la ruta de siempre:
  `PUT /contracts/:contratoPrincipal/invoices/:unificadaId/references` (`planReferences` con `unified_v2`). Se admite en la unificada v2
  Por Emitir activa **sin borrador en el ERP** (con borrador: `sent_to_erp_draft` con `action: 'erp_reset'`, igual que el texto manual);
  las unificadas históricas, las ya emitidas y los orígenes inactivos siguen con `unified_invoice`. El aviso/bloqueo `needs_reference`
  cuenta las referencias propias (`invoice_references`) y las vinculadas (`invoice_reference_links`) de la unificada, así que se resuelve
  al guardar la OC (360, cola de Facturación y envío automático).
- **Re-unificar conserva lo de la anterior** (`ContractInvoiceConsolidationService.reunifyInvoices`, que usa
  `InvoiceConsolidationRulesService.runRule`): en una sola transacción lee de la unificada anterior sus referencias (propias y
  vinculadas), sus líneas protegidas (`description_locked`) y sus fechas; la deshace (`Cancelada`) y arma la nueva. (a) Las referencias
  entran al plan como `carried_references`, después de las de los orígenes y con la misma deduplicación tipo+folio (`dedupeReferences`):
  las propias se copian, las del contrato se vinculan. (b) Las glosas escritas a mano pasan a la línea que calza por ítem, período y fila
  de tramo (`keptUnifiedDescriptions`, como la re-copia por consumo); las ambiguas se regeneran. (c) Si la anterior estaba reprogramada
  (su emisión o su fecha programada no son las del plan), la nueva conserva `issue_date`, `scheduled_at` y `due_date` (`keptUnifiedDates`).
  El evento `INVOICE_CONSOLIDATED` lleva `previous_consolidated_invoice_id`, `kept_descriptions` y `kept_dates`. Si la nueva queda
  bloqueada, rollback: la anterior sigue vigente. Deshacer a mano y volver a consolidar a mano no traspasa nada (solo el flujo de la regla).
  Límite: una referencia heredada de un origen que la usuaria quitó en la unificada vuelve al re-unificar (sigue en el origen).
- **Líneas en 0**: el plan y la vista previa marcan cada línea con `is_visible` (misma regla que el detalle, `isVisibleLine`: cantidad
  distinta de 0). Las de cantidad 0 se copian igual pero no van al ERP; el front las pliega o atenúa. Una línea con cantidad y subtotal 0
  tampoco es visible; una con cantidad distinta de 0 y subtotal 0 sí va al ERP.
- **Editar la glosa de la unificada**: una unificada v2 Por Emitir acepta el texto manual en sus líneas por la ruta de siempre,
  `PATCH /contracts/:contratoPrincipal/invoices/descriptions` `{ line_ids, mode: 'set', text }` (vista previa en `…/descriptions/preview`):
  solo la glosa, sin montos; la línea queda protegida (`description_locked`). Las plantillas (`apply_template`, `apply_blocks`, `unlock`)
  la saltan con `unified_invoice` (renderizarían con el contrato principal las líneas de otros contratos); las unificadas históricas y los
  orígenes siguen bloqueados. La re-copia por consumo conserva esas glosas (`keptUnifiedDescriptions`: por ítem, período y fila del
  tramo), y re-unificar también (ver arriba).


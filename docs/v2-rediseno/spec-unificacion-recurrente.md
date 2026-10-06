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
  usuaria **confirma** esa fecha antes de guardar). Sin factura del principal ese mes, la más temprana.
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
    invoice_currency, document_type, in_rule, issue_day }` (`issue_day` = día del mes de sus próximas Por Emitir, o null).
  - `new_contract_ids[]`: activos que no están en la regla (solo con regla).
  - `months[]` (solo con regla; Por Emitir de los contratos de la regla, del más antiguo al más nuevo):
    `{ month, state: 'unified' | 'pending' | 'blocked' | 'single', unified_invoice: { id, invoice_number, status, issue_date, total, currency } | null,
    invoices: [{ id, contract_id, contract_number, issue_date, total, currency }], blockers: [{ code, message }] }`.
  - `summary`: `{ unified, pending, blocked, single }`.
- `POST …/preview` `{ contract_ids, main_contract_id }` → `{ main_contract: { id, contract_number, issue_day }, months[] (state
  'will_unify' | 'already_unified' | 'blocked' | 'single', issue_date, invoices, totals: [{ currency, total }], blockers, warnings),
  summary: { will_unify, already_unified, blocked, single } }`. Sin escribir.
- `PUT` `{ contract_ids, main_contract_id, confirm_issue_date: true }` → guarda la regla (crea o reemplaza contratos/principal; queda
  `active`) y unifica ya → el `GET` más `result: { unified, blocked }`. 400 si falta `confirm_issue_date`, menos de 2 contratos, un
  contrato que no es de la razón social o el principal fuera de la lista.
- `POST …/pause` `{ undo_pending: boolean }` → `paused`; con `undo_pending`, deshace las unificadas de la regla que sigan Por Emitir y
  sin borrador en el ERP. `POST …/resume` → `active` y unifica.

Formas: `month` es `YYYY-MM`; `warnings` y `blockers` son `{ code, message }`; `result.unified` / `result.blocked` cuentan **documentos**
(un mes puede dar más de uno si hay facturas en otra moneda o de otra compañía); `pause` devuelve el `GET` más `result: { undone, kept }`;
`resume` no lleva body y devuelve el `GET` más `result`. Un contrato de la regla que dejó de estar activo sigue en `rule.contract_ids` y no
aparece en `contracts[]`; al editar la regla se quita. Las facturas que nacieron unificadas no se deshacen al quitar un contrato.

Re-unificación: si un mes ya tiene la unificada de la regla y aparece otra Por Emitir de un contrato de la regla, el job (y el `PUT`)
deshace la unificada (si sigue Por Emitir sin borrador en el ERP) y la vuelve a armar con todas; si ya salió, el mes queda `blocked`
con `unified_already_sent`.

Job diario `contracts-consolidation-rules` (`ContractsScheduler`, 06:30 America/Santiago: después del horizonte y las renovaciones y antes
del envío automático), con el interruptor de los jobs de contratos `CONTRACT_JOBS_ENABLED` (encendido por defecto; **apagado en la API
local que lee producción**). Actúa a nombre de quien dejó la regla (`updated_by`, si no `created_by`): el historial del contrato exige autor.

Tarea `consolidation_new_contracts` (Facturación, warning): razones sociales con regla activa y contratos activos fuera de ella; con una
sola, el enlace va a su 360.

## 4. Front (Razón social 360)

- Tarjeta **"Facturación unificada"** en la columna derecha (sobre Condiciones de pago). Solo con 2 o más contratos activos.
  - Sin regla: una línea de qué hace y botón **"Unificar facturas"**.
  - Con regla: contratos (principal marcado), "Se emite el día N, como CTR-…", resumen (unificadas · pendientes · bloqueadas con
    motivo), aviso de contratos nuevos con **"Sumar a la unificación"**, **Editar** y **Pausar** (con la opción de deshacer las que
    siguen Por Emitir) / **Reanudar**.
- Drawer **"Unificar facturas"**: elegir contratos (casillas, con compañía y moneda), elegir el principal (radio, con su día de
  emisión), vista previa por mes (unifica · ya unificada · no se puede: motivo · un solo contrato) y casilla **"Confirmo que la factura
  unificada se emite en la fecha del contrato principal"**; Guardar (`SaveButton`) deshabilitado sin confirmar.
- BFF `app/api/razones-sociales/[id]/unificacion/*` (`withAuth`; leer `LECTURA_O2C`, escribir `EDIT_FACTURACION`; entrada propia en
  `PERMISOS_BFF`); la vista previa es `…/unificacion/vista-previa` para que cuente como lectura. Ayuda: `docs/documentacion-funcional/clientes/unificar-facturas.md` + novedad.

# Saneamiento de Contratos (bloque previo al módulo `contracts`)

> Desde el 24-09-2026 · Domi + Claude. Criterio rector (14-09): **ningún módulo pasa al front nuevo sucio**; el paso 0
> de cada módulo es sanear su familia de funciones. Diagnóstico y decisiones: [`auditoria-contratos.md`](./auditoria-contratos.md).
> Este documento es el **registro de lo ejecutado** y la lista de la **segunda capa** (lo que cambia al pasar al front nuevo).

## Reglas del bloque

- El front viejo (`sapira-ai`, `app.aisapira.com`) **sigue funcionando**: todo lo que usa se mantiene compatible.
- Esquema solo como código en `api-sapira` (migraciones + assets), primero QA y después producción con OK de Domi.
- No se tocan datos de clientes en producción (filas, contratos concretos): Domi los revisa caso a caso.
- **Retiro con doble confirmación** (sin ventana de observación, decisión de Domi 24-09: el front viejo se reemplaza en
  semanas): (1) código — ningún llamador alcanzable en los tres repos, ni función, trigger o `cron.job` que la use;
  (2) uso real — 0 llamadas en los logs del gateway (`/rest/v1/rpc/<nombre>`) de los últimos 30 días.

## Capa 1 · Ejecutado

### 1. Retiro de funciones sin uso (24-09)

| Qué | Dónde |
|---|---|
| `DROP` de 14 firmas: `create_contract_renewal` **v1** (la v2 se queda), `create_contract_upsell`, `create_contract_downsell`, `create_contract_churn`, `register_item_non_renewal`, `migrate_contracts_to_new_workflow`, `get_contract_reconciliation`, `activate_legacy_contract`, `validate_legacy_activation`, `derive_contract_items_from_legacy`, `confirm_legacy_invoice_reconciliation` ×2, `bulk_reconcile_legacy_invoices` ×2 | migración `1790292150143-RetiraFuncionesContratosYLegacyMuertas` + 11 assets borrados de `functions/` + v1 quitada de `functions/create_contract_renewal.sql` |
| `recalc_revenue_for_contract`: sin `EXECUTE` para PUBLIC/anon/authenticated (la sigue llamando `approve_contract_amendment`, cross-sell vivo) | `grants/020-contracts-internal-functions-execute.sql` |
| Código muerto del front viejo: 3 paneles legacy sin montar (`ContractActivationPanel`, `ContractLegacyAnalysisPanel`, `LegacyInvoiceReconciliationTable`) con sus hooks, servicio, tipos y `README_RECONCILIACION_MASIVA.md`; `WorkflowDashboard` + `WorkflowMigrationCard` + `useMigrateContracts`; `ContratosGlobalReconciliation` + `ContractReconciliationModal` + `useContractReconciliation`; `AmendmentApprovalsModal` + `useAmendmentApprovals`; `DownSellingModal`; mutaciones sin consumidor de `useContractAmendments` (`createUpsell`, `createDownsell`, `createChurn`, `registerNonRenewal`, `createAmendmentWithInvoices`) | `sapira-ai/src/components/contratos/**` |

**Evidencia**: grep en `sapira-ai`, `api-sapira`, `front-sapira`; cadena de imports hasta una página (ninguna llega); en
prod `pg_proc.prosrc` (única dependencia interna: `activate_legacy_contract` → `validate_legacy_activation`, ambas salen;
el cron de auto-renovación usa la v2 de renovación), `pg_trigger`, `cron.job`; logs del gateway 25-08 → 24-09 con los 30
días con datos: 0 llamadas a las 14 firmas y a `recalc_revenue_for_contract` (`create_contract_renewal`: 11, todas v2).
Verificación: `vite build` del front viejo OK, `tsc` sin errores nuevos (los 96 existentes no tocan estos archivos),
tests de `src/databases/postgresql` 617/617.

**Estado**: ✅ QA y ✅ producción (24-09). En ambas, `schema:status` final: 0 migraciones pendientes, 857 assets
aplicados, 0 "solo en la base"; verificado en el catálogo que las 14 firmas no existen, que la v2 de renovación y sus
llamadores (auto-renovación, cross-sell, `approve_contract_amendment`) siguen, y que `recalc_revenue_for_contract` ya no
es ejecutable por `anon`/`authenticated` (su llamador corre como `postgres`). Snapshot de prod refrescado: solo cambia el
catálogo de funciones (las 14) y el conteo de `sapira_typeorm_migrations`; ningún `*.prod-snapshot.ts`. Front viejo:
commit `d0a98ae` en `sapira-ai` (se puede desplegar en cualquier orden: lo borrado no era alcanzable).

### 2. Modelo FX v2: `purpose` en tasas de contrato y dirección única (28-09, código listo, sin aplicar)

- Migración `1790610000000-AddFxRatePurposeAndCompanyFxPolicy`: `contract_fx_period_rates.purpose` (company | invoice,
  default company) + índice (contract_id, purpose); `companies.fx_company_policy` (monthly_avg). `down()` se niega si
  ya hay tasas `invoice`.
- Assets: `revenue_schedule_apply_fx_for_contract` (fixed_period: directa × tasa, inversa 1/tasa, solo `company`),
  `calculate_contract_fx_rate` y `bulk_confirm_fx_policy` (solo `company`). Firmas sin cambios.
- Migración de datos `1790610000001-FixHankaCompanyFxRatesDirection`: 5 tasas CLF → CLP de Hanka Robotics
  (CTR-2025-004, -007, -009, CTR-2026-007) de 0.000025 a 40.000 + rebuild del RSM. Solo corre con el asset nuevo
  aplicado (si no, aborta y queda pendiente); idempotente; `down()` simétrico. SimpliRoute CTR-2026-215 fuera.
- Pendiente fuera de este repo: el front viejo (`useContractFxRates`, `ContractFxCompanyConfig`) lee todas las filas de
  `contract_fx_period_rates`; con tasas `invoice` las mostraría como de compañía. Filtrar `purpose = 'company'` allá.
- Detalle: `mapa-v2-contratos.md` §3b.

## Cambio de estrategia (Domi 25-09)

En vez de corregir en su lugar las funciones que el front viejo usa, **se construye la v2 al lado** (endpoints y lógica
nuevos, rediseñados) y lo viejo se retira módulo por módulo al switch. Plan por módulo:
[`mapa-v2-contratos.md`](./mapa-v2-contratos.md) (luego Facturas y Cotizaciones). Los U de la auditoría quedan
cubiertos por diseño en ese mapa (columna "Evita de raíz").

## Capa 1 · Lo único que se corrige en su lugar (triggers compartidos, afectan a los dos fronts)

Cada uno se presenta a Domi antes de tocarlo (funciones, casos que corrige, qué no debe romper, prueba).

| # | Qué | Piezas |
|---|---|---|
| 2 | U13 · el sync de cantidades no toca NC (+ su gemela al borrar) | `sync_invoice_items_amounts_from_quantities`, `restore_invoice_items_amounts_on_quantity_delete` |
| 3 | U9 · los triggers del RSM toman el holding del registro, no de la sesión | `trigger_rsm_on_*` |
| 4 | U8 · el rebuild parcial carga el devengo acumulado previo + rebuild completo (OK aparte: reescribe el devengo de todos los clientes) | `revenue_schedule_rebuild_contract_ccy` |
| 5 | Costura `sapira.writer = 'api'` en los triggers que rellenan o pisan datos (decisión de Leon) | ver `mapa-v2-contratos.md` §4 |

## Capa 2 · Al pasar al front nuevo (se documenta ahora, se ejecuta con el módulo `contracts`)

Cambios que exigen que el front viejo deje de llamar la función, o que son rediseño y no fix:

| Pieza | Cambio | Fuente |
|---|---|---|
| `mark_contract_signed_safe` | Fusionar en `bulk_activate_contracts` (`POST /contracts/activate`) y retirar | auditoría §2b |
| `approve_contract_amendment` + `recalc_revenue_for_contract` | Portar solo la rama CROSS_SELL a la API; retirar ambas (el flujo de aprobación se elimina, S3-10) | §2a |
| `regenerate_contract_invoices_from_items` / `_for_restructure` | Fusionar en una | §2c |
| Generación y mantenimiento de facturas | Dos piezas: **Generar** (al activar) y **Aplicar cambios** (estado objetivo, cambio mínimo); absorben sync, reschedule, modificaciones, cantidades | S4-2 |
| `standardize_invoice_items` | Desaparece o solo rellena lo vacío (el generador calcula la línea) | S4a, Complejos #3 |
| Unificar / consolidar / desunificar | Se retiran por multimoneda en el contrato y ruta declarada | S4-5, S4-6 |
| FX | Política y tasa por factura; una sola convención de tasa; nunca 1 silencioso | S6, S5-10/11 |
| Creación y activación (S2-6) | En vez de bloquear al activar, **garantizar la base desde la creación**: el contrato nace siempre con cronograma y la compañía emisora con `tax_rate` (validado en `POST /contracts` y en la configuración de compañías). La guarda al activar queda solo como red. **Domi (25-09)**: no se prioriza como fix del front viejo; la base se hace bien desde el inicio en el módulo nuevo | S2-6, S1-12 |
| `inherit_auto_renew_from_quote_item` (S1-5) | Respetar la auto-renovación desmarcada en la cotización (hoy trata `false` igual que null). **Diferido por Domi (25-09)** a Contratos + Cotizaciones en el front nuevo: no bloquea el día a día | S1-5 |
| `invoice-scheduler.service.ts` (U12) | "Fijo" sin tasa bloquea el envío y alerta, en vez de salir a spot en silencio. **Diferido por Domi (25-09)** al módulo que toque la emisión en el front nuevo. Expuestas al 24-09: 11 PE desde el 1-oct (CTR-2026-74 y 96 con auto-envío, 151 sin auto-envío) + 8 de meses pasados que el scheduler ya no toma | S6-2, B3 |
| RSM | Motor con granularidad, cierre de meses, variables leídos en el rebuild | S5 |
| Legacy | Módulo Historia del cliente; fusionar los dos "crear contrato" y las dos reconciliaciones | S8 |
| Tenancy | Todas las funciones vivas validan el holding de la sesión, o pasan a la API | §1, decisión #2 |
| `REVOKE` a `authenticated` | Al migrar cada módulo, las funciones que el front viejo deja de llamar quedan solo para la API | §1 |

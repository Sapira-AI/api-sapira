# Estrategia de base de datos para Sapira ERP + FP&A

> Propuesta del 19-10-2026 para discutir con Domi y Leon antes de escribir una sola migración. Sigue las reglas vigentes: entity + migración para tablas, assets para lo demás, `withApiWriter`, triggers solo para invariantes, `HoldingScopeGuard` + `@RequirePermission`. Índice: [README](README.md).

## 1. Decisión de fondo: misma base, nuevos dominios, un solo libro

| Opción | Veredicto | Por qué |
|---|---|---|
| Base de datos separada para el ERP | **No** | Postear una factura o un pago debe crear su asiento en la misma transacción; las FK a `companies`, `client_entities`, `invoices`, `invoice_payments` y `bank_movements` son el valor. Dos bases = sincronización eterna. |
| Misma base, todo en `public` con prefijos (`gl_`, `ap_`, `tr_`, `fp_`) | **Sí para arrancar** | Cero riesgo con el tooling actual (`schema:status`, snapshots, assets manifest, specs de espejo). Las entities se agrupan por carpeta de dominio como hoy (`entities/ledger/`, `entities/treasury/`, `entities/payables/`, `entities/planning/`). |
| Misma base, schemas Postgres propios (`ledger`, `treasury`…) | Deseable, **después** | Más limpio para ownership y extracción futura, pero exige extender snapshot, manifest y specs a multi-schema. Hacerlo como tarea aparte cuando el tooling lo soporte; los prefijos facilitan moverlas. |
| Embeber Odoo/ERPNext como motor contable | **No** | Marca prohibida en la UI, licencias, modelo de datos ajeno, nada AI-first. El libro mayor "lean" es chico; el valor está en IA + cumplimiento local + lo que Sapira ya tiene. Odoo sigue como ERP externo integrado para quien lo tenga. |
| Seguir en Supabase | Sí | Postgres estándar; vigilar `statement_timeout` y pgbouncer (ya conocidos). Logs y colas fuera de Postgres (Mongo hoy; evaluar BullMQ con Redis cuando el volumen de bancos lo pida). |

## 2. Principios que no se negocian

1. **Partida doble inmutable.** Un asiento posteado no se edita: se revierte con otro asiento y se re-postea. Estados `draft → posted → reversed`. El bloqueo de período y la inmutabilidad viven en la **capa de persistencia** (triggers de invariante, que la regla actual permite), para que apliquen igual a UI, API, integraciones y agentes.
2. **Todo documento llega como borrador.** Facturas recibidas, cartolas, contratos leídos por IA y asientos propuestos por agentes entran con `status = draft` y `proposed_by` (usuario o agente). Solo lo aprobado postea ("approval is the posting event").
3. **El origen siempre se conserva.** Cada línea de libro guarda `source_type` y `source_id` (invoice, invoice_payment, bank_transaction, supplier_bill, revenue_schedule, depreciation, manual…) y cada documento conserva `raw_data` o el XML. Trazabilidad celda → asiento → documento → DTE.
4. **Moneda original + funcional + sistema**, con tasa, fuente y fecha, como ya hace `invoices`. Montos `numeric(20,6)`; redondeo a 2 decimales al postear; CLP sin decimales en documentos fiscales. UF, UTM y UDI se tratan como monedas indexadas (ya existen en `indicadores_economicos`).
5. **`book` desde el día uno.** Columna `book` (`statutory` por defecto, `ifrs`, `management`) en asientos y saldos. Casi gratis hoy, imposible de agregar después; es el multi-book que DualEntry todavía no tiene y que Chile necesita (tributario vs IFRS pymes).
6. **Dimensiones acotadas.** Cuatro FK fijas (centro de costo, proyecto, contraparte, producto) más `tags jsonb` para lo custom. La lección de Abacum: menos de 7 dimensiones o el sistema se arrastra.
7. **Saldos no se guardan como verdad**: se calculan de las líneas con índice `(company_id, book, account_id, period_month)`; una tabla de saldos mensuales materializada es caché reconstruible, igual que RSM hoy.
8. **Tenancy igual que hoy**: `holding_id` y `company_id` en toda tabla de negocio, RLS habilitada en la migración (convención de `budgets`), queries `WHERE … AND holding_id = $2`.
9. **Eventos tipados** (`document_events`, decisión A6 ya planeada) como columna vertebral de agentes, notificaciones y auditoría; no un segundo mecanismo.
10. **Catálogos por país como datos, no código**: plantillas de plan de cuentas, tipos de documento fiscal (`fiscal_document_types`, planeada), impuestos y retenciones, calendario tributario.

## 3. Dominios y tablas propuestas (nombres tentativos)

### Libro (`gl_`)
- `gl_chart_templates` (país, régimen, versión) y `gl_chart_template_accounts`: plantillas (Chile tributario y IFRS pymes primero).
- `gl_accounts`: por compañía; `code`, `name`, `parent_id`, `level`, `type` (asset, liability, equity, revenue, expense, memo), `normal_balance`, `cash_flow_category`, `tax_tags jsonb`, `is_reconcilable`, `is_bank`, `external_codes jsonb` (ERP anterior), `is_active`. Reemplaza y absorbe `company_account_mappings` (las 5 cuentas pasan a ser filas marcadas por rol).
- `gl_account_roles`: compañía × rol (`revenue`, `deferred_revenue`, `unbilled`, `receivable`, `payable`, `vat_debit`, `vat_credit`, `bank:<id>`, `fx_gain`, `fx_loss`, `retained_earnings`…) → `account_id`. Es lo que hoy hace `company_account_mappings`, generalizado.
- `gl_journal_entries`: `company_id`, `book`, `entry_number` (correlativo por compañía y año, con regex anclada: lección de los contratos), `entry_date`, `period_month`, `status`, `source_type`, `source_id`, `description`, `reverses_entry_id`, `proposed_by_kind` (user, agent, system), `proposed_by_id`, `approved_by`, `posted_at`, `fx_rate_set jsonb`.
- `gl_journal_lines`: `entry_id`, `line_no`, `account_id`, `debit`, `credit` (funcional), `amount_original`, `currency_original`, `fx_rate`, `amount_system`, `cost_center_id`, `project_id`, `counterparty_id`, `product_id`, `tags jsonb`, `memo`, `reconciliation_group_id` (para cuentas conciliables: por cobrar, por pagar, banco).
- `gl_periods`: compañía × mes × book: `status` (open, soft_closed, closed), `closed_by`, `closed_at`. Reemplaza `accounting_period_cutoff` manteniendo su API y el permiso `CLOSE_PERIODS`.
- `gl_balances_monthly` (caché materializada): compañía, book, cuenta, mes, debe, haber, saldo inicial y final por moneda funcional y sistema.
- `gl_fx_revaluations`: corridas de revalorización de saldos en moneda extranjera al cierre.

### Contrapartes (`cp_`)
- Evolucionar `client_entities` a **contrapartes** sin romper nada: agregar `is_customer`, `is_vendor`, `is_employee`, `vendor_payment_terms`, `vendor_bank_accounts jsonb` y, más adelante, renombrar con vista de compatibilidad. En LatAm el mismo RUT compra y vende: una sola tabla de entidades legales.

### Cuentas por pagar (`ap_`)
- `ap_bills`: `company_id`, `counterparty_id`, `fiscal_document_id` (si vino del SII/SAT), `bill_number`, `document_type`, `issue_date`, `due_date`, `expected_payment_date` (≠ vencimiento, con `expected_method`), `status` (draft, approved, scheduled, paid, void), montos triple moneda, `approval_status`, `cost_center_id`, `raw_data jsonb`.
- `ap_bill_lines`: cuenta, impuesto, dimensiones, `pricing_breakdown` si aplica.
- `ap_payment_orders` (lotes de pago, aprobación, archivo al banco) y **`payments` general** (dirección `in`/`out`, `counterparty_id`, `bank_transaction_id`, `method`, moneda y FX) con `payment_allocations` (pago → documentos, parciales). `invoice_payments` se mantiene como vista o se migra con compatibilidad: hoy es solo AR y nunca borra filas (conservar esa regla).

### Documentos fiscales (`fd_`)
- `fd_documents`: documento electrónico **recibido o emitido** tal cual llegó del portal (SII RCV, SAT, DIAN): `direction`, `country`, `document_type`, `folio`, `issuer_tax_id`, `receiver_tax_id`, fechas, neto, IVA, total, `xml`/`raw_data`, `match_status`, `matched_to_type/id` (invoice emitida o ap_bill). Es la fuente de AR/AP que los AI-native globales no tienen; separada de `invoices` (documento comercial generado desde el contrato) para no mezclar roles.
- `fd_sync_runs` por compañía y portal.

### Tesorería (`tr_`)
- `tr_bank_connections`: compañía × agregador (fintoc, belvo, prometeo, archivo) × credenciales en Vault, `last_sync`, `status`.
- Evolucionar `bank_movements` → `tr_bank_transactions` (misma tabla, columnas nuevas): `bank_account_id` (FK a `company_bank_accounts`), `connection_id`, `external_id`, `counterparty_hint`, `category_id`, `category_confidence`, `category_source` (rule, model, user), `balance_after`, y matching generalizado: `matched_type` (invoice, ap_bill, tax_payment, transfer, payroll, fee, other) + `matched_id`. Conservar fingerprint, lotes y el motor de matching existente.
- `tr_categories` (árbol de categorías de caja por holding, con mapeo a `gl_accounts`) y `tr_rules` (reglas de categorización: contraparte, glosa, monto → categoría/cuenta; las propone la IA y las aprueba el usuario).
- `tr_expected_flows`: la tabla central del flujo proyectado. `company_id`, `direction`, `expected_date`, `amount`, `currency`, `amount_system`, `category_id`, `source_type` (invoice, ap_bill, recurring, budget, tax, loan, payroll, manual), `source_id`, `method` (due_date, promise, avg_days_counterparty, model), `confidence`, `scenario_id`, `settled_transaction_id`, `superseded_at`. Se regenera por fuente y se compara con lo real.
- `tr_recurring_patterns`: recurrentes detectados del historial (arriendo, sueldos, suscripciones) con periodicidad, monto típico y confianza.
- `tr_forecast_versions` y `tr_forecast_lines`: foto del 13 semanas / 12 meses por fecha de corte para medir precisión (patrón Trovata).
- `tr_tax_obligations`: calendario tributario por compañía (IVA/F29, PPM, retenciones, renta, ISR provisional) con monto estimado desde `fd_documents` y vencimiento legal: salidas de caja de primera clase.

### Planificación (`fp_`)
- Extender `budgets` sin romper: nuevos `kind` (expense, cash_out, headcount, capex) o, mejor, un `fp_plan_versions` (holding, nombre, tipo budget/forecast, año fiscal, `locked_at`, `base_version_id`) con `fp_scenarios` (dentro de la versión, hereda del base hasta congelarse) y `fp_plan_lines` al grano **cuenta o categoría × dimensión × mes** en moneda sistema con `amount_original`/`currency`. `budgets`/`budget_lines` actuales pasan a ser la versión "cash_in/bookings" o se migran con script y OK.
- `fp_drivers` (nombre, unidad, valores por mes, escenario; FX, DSO, DPO, churn, precio, cargas patronales por país) y `fp_formulas` acotadas (línea = driver × driver).
- `fp_headcount_positions`: empleado actual o posición planificada (rol, área, país, fecha de inicio y término, salario, moneda, cargas, estado de aprobación, `hris_external_id`).
- `fp_variance_comments`: explicación (humana o de IA) por celda de variación, con autor, fecha y fuentes citadas.
- Actuals no se copian: se leen de `gl_balances_monthly`, RSM, `tr_bank_transactions` y `fd_documents` con mappings aprobados (`fp_account_mappings`: cuenta contable → línea de plan).

### Migración (`mg_`)
- `mg_imports` (compañía, fuente: odoo, defontana, softland, nubox, csv; archivo, hash, estado), `mg_trial_balances` (balance de comprobación por período importado), `mg_ledger_lines_raw` (mayor histórico crudo), `mg_coa_mappings` (cuenta origen → `gl_accounts`, propuesta por IA, aprobada por usuario), `mg_tie_out_reports` (TB por período, roll-forward, RCV vs libros, F29 vs IVA calculado; diferencias con explicación).

### Transversal
- `document_events` (tipado, por documento y compañía) y `ai_action_catalog` (de `spec-agentes-ia.md`): los agentes del ERP (conciliador, clasificador, tesorero, cerrador, migrador) son filas de `ai_agents` con acciones del catálogo, no código nuevo por agente.
- `api_keys` por holding con alcances (prioridad 4 del roadmap): prerequisito del MCP.

## 4. Convenciones concretas para las tablas nuevas

- UUID `gen_random_uuid()`; `created_at`/`updated_at timestamptz` con trigger `update_updated_at_column()`; fechas de negocio `date` como texto `YYYY-MM-DD`; `text` + `CHECK` en lugar de enums Postgres nuevos (convención reciente de `budgets`); `numeric(20,6)` para montos y `numeric(20,10)` para tasas; moneda ISO en columna adyacente; `jsonb` solo para `raw_data`, `tags`, `fx_rate_set` y configuraciones.
- Correlativos por compañía y año con secuencia propia y validación de regex anclada, únicos por holding (lección de `CTR-2026-218`).
- Nada de soft delete en libro y documentos fiscales: estados y reversos. `deleted_at` solo en borradores no posteados si hace falta.
- Índices mínimos: `(holding_id, company_id, period_month)` en líneas y saldos; `(company_id, status, due_date)` en bills; `(bank_account_id, movement_date)` en transacciones; parcial `WHERE status = 'draft'` para colas de aprobación. Particionar `gl_journal_lines` por año solo si un piloto supera decenas de millones de líneas (no es el caso en 2027).
- Toda escritura por API con `withApiWriter`; triggers nuevos solo: inmutabilidad de posteados, bloqueo de período por `gl_periods`, suma debe = haber por asiento (invariante que `database.module.spec.ts` puede cubrir también), moneda válida.
- Permisos nuevos: `VIEW_/EDIT_TESORERIA`, `VIEW_/EDIT_CONTABILIDAD`, `VIEW_/EDIT_PROVEEDORES`, `VIEW_/EDIT_PLANIFICACION`, `POST_JOURNAL` y reutilizar `CLOSE_PERIODS`; seeds, `PERMISSION_MODULES`, `permission-codes.ts`, `create_default_roles_for_holding.sql` y `PERMISOS_BFF` en el front en la misma tarea.
- Grants a la Data API: ninguno (el front viejo no leerá estas tablas).

## 5. Orden de construcción del esquema (sigue las fases del roadmap)

1. **Fase 0**: `document_events`, `cp_` (flags en `client_entities`), `gl_accounts` + plantillas + roles de cuenta (absorbe `company_account_mappings` con vista de compatibilidad), `gl_periods` (compatibilidad con `accounting_period_cutoff`). Decidir prefijos vs schemas y ampliar el tooling si se eligen schemas.
2. **Fase 1 Caja**: `tr_bank_connections`, evolución de `bank_movements`, `tr_categories`, `tr_rules`, `tr_expected_flows`, `tr_recurring_patterns`, `tr_forecast_versions`, `tr_tax_obligations`, `fd_documents` (RCV recibidos), `ap_bills` mínimas (desde RCV, sin aprobación compleja) y `payments` general.
3. **Fase 2 Libro**: `gl_journal_entries`, `gl_journal_lines`, `gl_balances_monthly`, `gl_fx_revaluations`; posteo desde RSM (devengo), facturas, pagos, bancos y bills; `ap_payment_orders`; `mg_*`.
4. **Fase 3 Planificación**: `fp_*` y evolución de `budgets`.
5. **Fase 4 Consolidación**: `gl_intercompany_links`, `gl_eliminations`, `fa_assets` + `fa_depreciation_schedules`, `gl_prepaids`; `book` ya existe.
6. **Después**: inventario y compras solo si un piloto lo exige (`inv_`, `po_`).

## 6. Riesgos específicos de datos

- **Doble verdad transitoria** entre `invoice_payments` y `payments`, entre `company_account_mappings` y `gl_account_roles`, entre `accounting_period_cutoff` y `gl_periods`: resolver con vistas de compatibilidad y un corte explícito por holding, nunca con escrituras duplicadas.
- **Snapshots de prod**: aplicar las migraciones en QA y prod apenas se mergean, aunque el módulo esté apagado, para que el espejo no se rompa.
- **Volumen bancario**: una compañía mediana genera miles de transacciones al mes; el matching fuzzy actual es O(n·m) por lote: medir en el primer piloto y mover a job si pasa de segundos.
- **Datos de prod existentes**: ningún script toca datos de holdings reales sin OK de Domi y tabla de respaldo en `sapira_backups.*` (regla vigente).

# Spec — Onboarding de datos históricos y MRR histórico (v2)

> **Estado: aprobada para construir en el laboratorio (Domi, 13-10-2026).** Base: decisiones S8-1…S8-8 de
> [`auditoria-contratos.md`](./auditoria-contratos.md) (24-09), §1.8 de [`spec-revenue-y-metricas.md`](./spec-revenue-y-metricas.md),
> [`analisis-fx-y-mrr-historico.md`](./analisis-fx-y-mrr-historico.md), el diseño de onboarding masivo del front viejo
> (`sapira-ai/docs/onboarding/DISEÑO_onboarding_masivo.md`) y la práctica de la industria (ChartMogul, Baremetrics, Chargebee,
> Zuora, Maxio, Stripe, Ordway, Zenskar). No cubre el pre-onboarding comercial (`spec-preonboarding-prueba-guiada.md`).
> Nace en `/lab/onboarding` (solo super admin) y se publica como submódulo de Administración ("Datos históricos").

## 1. Por qué desde cero

- Hoy **ninguna ruta de la API escribe el histórico**: `mrr_legacy`, `invoices_legacy`, `invoice_items_legacy` y
  `invoice_items_legacy_match` se cargaban con RPC del front viejo o con SQL en producción; las funciones siguen expuestas y
  nadie las llama.
- El front viejo tenía **tres caminos paralelos** (factura → MRR legacy → contrato; contrato legacy → conciliar facturas →
  activar; relacionar a contrato existente), conciliación línea a línea con cuatro triggers y mucho código muerto.
- **El histórico sí se usa.** Solo SimpliRoute: 11.848 filas (2024-01 → 2027-02, 684 clientes, 863 pares cliente × producto),
  9.657 empalmadas a 527 contratos, 1.615 "no aplica" con motivo en texto libre y **665 pendientes** en 67 líneas (63 ya
  terminaron y salen como churn falso; 4 vigentes). 196 clientes con histórico no tienen contrato. Empalme: 403 exactos, 83 con
  solape (U14 lo corta), **28 con hueco**, **12 sin MRR en el devengo**. Facturas previas: SimpliRoute 8.975 (132 pendientes),
  TiMining 119 y uPlanner 254 (migradas a `invoices` con `is_legacy`).
- **Brasil y Argentina** (SimpliRoute, no facturan desde el ERP): 60 + 35 razones sociales, cero contratos, cero historia. Hay
  una planilla con 1.921 facturas de Brasil (nov-2024 → ago-2026, 126 clientes, 100 con factura en 2026, BRL, sin RUT, sin
  producto ni descripción en las líneas; 95 facturas de 79 clientes en jul-2026). Es el **piloto** del módulo.

### Por qué las facturas son la fuente (Domi)

Los clientes grandes no conocen sus contratos ni tienen el MRR cuadrado con lo facturado: las planillas de MRR de
SimpliRoute estaban infladas y desactualizadas; la única fuente honesta fue la factura. Otros holdings (uPlanner, TiMining)
sí tienen sus contratos controlados en planillas. El módulo soporta las tres entradas y las lleva al mismo resultado.

## 2. Principios

1. **Arranque rápido es el camino principal** (S8-1): por cliente, la **última factura** a una fecha define el estado
   vigente; de ahí nace el contrato con fecha de corte. La historia anterior (MRR histórico) es opcional y se completa
   después, o nunca.
2. **Dos cosas distintas**: el contrato vigente factura y devenga desde el corte; el histórico entra como MRR por cliente ×
   producto × mes. Nunca se generan facturas ni devengo "sintéticos" de meses históricos ni saldos de apertura: con el
   arranque desde la última factura el saldo sale solo, y cuando hay facturas reales se reconstruye desde ellas (como se hizo
   con TiMining y uPlanner).
3. **Un mes, una fuente por línea** (U14, ya en producción): el histórico cuenta hasta el mes anterior al primer mes con MRR
   del contrato empalmado. El cambio de fuente no es "nuevo" ni "churn".
4. **Facturas previas = evidencia y cobranza**: externas, sin DTE, sin ERP, sin impuestos recalculados, sin devengo. Las
   pendientes y vencidas sirven para cobrar; las pagadas, para el historial del cliente.
5. **Motor único de import** (S8-5): archivo → mapeo de columnas → validación con errores por fila → **vista previa
   obligatoria** → aplicar en una transacción → lote reversible. Durante la importación no salen correos, tareas ni
   sincronizaciones. **Las razones sociales nunca se crean solas**: la vista previa las propone y la usuaria las confirma en
   bloque, con país explícito. **Los clientes comerciales no se crean desde una importación**: vienen del CRM; la factura
   previa se relaciona con el cliente comercial por RUT de la razón social o por id del CRM, y si no hay coincidencia queda
   `needs_client` hasta que la usuaria lo elija (o se pide al cliente la lista con RUT e id del CRM).
6. **Sin conciliación línea a línea** ni catálogo de motivos: una línea sin contrato que terminó fue **baja**; un duplicado o
   un error de carga se **quita** (deja de contar en todo), no se marca. Nada se borra físicamente.
7. **Sin SQL en producción**: todo lo que hoy se hace a mano (registrar, empalmar, cerrar, corregir, cargar un mes nuevo)
   tiene su acción en pantalla con vista previa.

## 3. Modelo

### 3.1 Línea de MRR histórico (sobre `mrr_legacy`, sin tabla nueva)

- **Registro (18-10, Domi, definitivo) = `mrr_legacy.batch_id` × cliente comercial × moneda de contrato × contrato** (`migrated_to_contract_id`,
  vacío = sin contrato). Es "un MRR legacy": las facturas que la usuaria registró de una vez para un cliente, con **uno o varios productos**
  (lo que el front anterior agrupaba por `batch_id` en `useMRRLegacyGroups`; su modal creaba un `batch_id` por moneda en cada registro), y la
  unidad que se convierte en un contrato (todos sus productos como ítems). `batch_id` **no** es el lote de importación de facturas previas
  (`invoices_legacy.import_batch_id`): es el id del registro. Las filas siguen siendo mes × ítem de factura; el producto vive **dentro** del
  registro (`products[]`, con su primer y último mes y el MRR de su último mes vivo). Clave de la URL: base64url de
  `batch_id|client_id|contract_currency|<contract_id o vacío>`; **raíz** = las 3 primeras partes (la misma antes y después de empalmar; es lo
  que guarda `onboarding_events.line_key`). La clave anterior (`client_id|product_name|…`) ya no vale: 400.
- **Por qué `client_id` en la clave**: en prod SimpliRoute hay 736 `batch_id`; 721 de un solo cliente y 15 con varios (cargas masivas directas de
  enero y marzo, hasta 39 clientes): esos se ven como un registro por cliente sin tocar datos. 161 clientes se registraron en varias veces
  (varios `batch_id`): para eso vuelve **Unificar**. Las filas con `migrated_to_contract_id = X` forman el registro "Relacionado con X" (uno por
  contrato) y las filas sin contrato el registro sin contrato, así **cada registro tiene un solo estado** (Avon CARD USD: 5 relacionados + 2
  pendientes; Logytech CLF: 2 relacionados + 1 pendiente). Nada cambia en los datos ni en las series y Métricas (van por fila).
- **Estado derivado, tres**: con contrato, `linked`; sin contrato: `pending` (alguna fila sin marcar) o `closed` = "No activado"
  (`skip_activation`, código siempre `churn`, nota libre opcional en `skip_activation_reason`; cuenta hasta su último mes). **Se retiran** el
  estado `removed` y la acción "Quitar" (un duplicado se corrige con "Editar línea": se vuelven a registrar sus facturas) y "ya terminó"
  (`ended`: no sabemos si terminó si la usuaria no lo marca). **El texto libre no se interpreta**: toda fila `skip_activation` sin
  `skip_reason_code` es "No activado". `legacyRemovedSql`/`REMOVED_REASON_CODES` quedan en `mrr-historico.ts` por si existiera una fila con
  código `duplicate` | `error` (prod 18-10: ninguna en ningún holding).
- **Corte U14, dos casos (18-10, Domi)**: el corte sigue en el conteo (Métricas nunca cuenta dos veces), pero no es un concepto. El **mes de
  empalme** (fila en el mismo mes que el primer mes con MRR del contrato: normal con ciclos a mitad de mes) se corta en silencio y no se
  reporta; el **histórico después del inicio del contrato** (meses posteriores) es un error de datos que se muestra para corregir.
- **Validaciones**: un mes no se repite para el mismo cliente × producto × moneda; al empalmar se informa hueco (último mes + 1 ≠ primer mes
  con MRR del contrato) y solape (lo corta U14); el contrato debe ser del mismo cliente comercial (otra moneda está permitida, S8-1).
- **Edición** = volver a registrar las facturas del registro (14-10; editar meses sueltos se retiró el 18-10), con registro de cambios (M15).
  Las filas nuevas conservan el `batch_id` y el contrato del registro; cambiar un producto no mueve el registro (vive dentro), cambiar la moneda
  sí (otro registro de la misma raíz).

### 3.2 Facturas previas (`invoices_legacy` + `invoice_items_legacy`)

- Entran por planilla (mismas dos hojas que la plantilla que ya conocen los clientes) o desde el ERP (staging existente).
  Campos: número, fechas, razón social (RUT o nombre exacto), compañía emisora, moneda, neto, IVA, total, estado de cobro
  (`Pagada` | `Enviada` | `Vencida`), notas; líneas con descripción, producto (opcional), cantidad, unitario, subtotal.
- Deduplicación por `holding + invoice_number` y por id del ERP; marca `origen: externa` donde se muestren.
- **Se retiran del flujo nuevo**: `invoice_items_legacy_match`, `reconciliation_status` con cinco valores (queda `pending` |
  `mrr_legacy` | `linked`), el bloqueo `has_legacy_invoices` de la activación y las 15 RPC `*_legacy*` (DROP tras la migración
  de lo pendiente, con la ventana de observación de `saneamiento-contratos.md`).

### 3.2b Registrar histórico desde facturas previas (paso de la usuaria)

Una factura previa trae solo lo que trae el documento: razón social, compañía emisora, moneda y montos de factura, fechas y,
a veces, líneas. **Para que sirva en Métricas la usuaria completa, por factura (o por cliente, con "autocompletar desde la
primera")**: el período o períodos que cubre (desde → hasta; un plazo de N meses reparte el monto), el monto en moneda de
contrato (igual al de factura si la moneda coincide; si no, la usuaria lo indica y el tipo de cambio queda registrado) y el
o los productos del catálogo con su parte del monto. Eso crea las filas de MRR histórico (una por producto × mes) con origen
`facturas_previas`. Una importación sin este paso **no deja nada listo para Métricas**; solo deja las facturas como evidencia.
Validaciones: la suma por producto cuadra con el monto (±1 %); un mes ya cubierto por la misma línea se avisa; monto en moneda
de sistema con tipo de cambio raro se marca.

### 3.3 Arranque rápido (contrato desde la última factura)

Por cliente (razón social) con facturas previas, a una fecha `as_of` (mes):

1. Se toma la última factura del cliente hasta `as_of`; sus líneas definen los ítems (producto del catálogo elegido en la
   vista previa, cantidad, unitario, moneda); frecuencia por defecto mensual anticipada (editable).
2. La usuaria completa lo de §3.2b para esa última factura (período que cubre, monto en moneda de contrato, productos); con
   eso se crean las filas de MRR histórico de ese período (y, si lo pide, registra también las facturas anteriores).
3. Se crea el contrato **En revisión** con el generador común de Contratos (`ContractDraftsService.create`), inicio = **mes
   siguiente** al de la última factura, y la línea queda empalmada (`migrated_to_contract_id`); las facturas quedan vinculadas
   (`invoices_legacy.contract_id`). Se activa después desde Contratos (en lote).
4. Caso especial, "la última factura cubre varios meses" (anual anticipada): inicio = primer día del período de esa factura y
   la factura se migra a `invoices` como externa cubriendo ese período (`is_legacy`, `legacy_invoice_id`,
   `contract_invoices.satisfied_by_legacy_id`), que es el mecanismo que ya usaron TiMining y uPlanner. **Entrega 2.**

### 3.4 Configuración por holding

- `holding_settings.metrics_history_start` (A7, opción a): primer mes que muestran Métricas (SimpliRoute: 2025-01; hoy arranca
  en 2024-01 por el mínimo de la tabla). Editable en Administración › Holding › Preferencias.

### 3.5 Esquema (una migración, aplicar con OK de Domi: QA → prod)

| Cambio | Para qué |
|---|---|
| `holding_settings.metrics_history_start date NULL` | §3.4 |
| `invoices_legacy.import_batch_id uuid NULL` + índice | lote reversible de facturas previas |
| `mrr_legacy.skip_reason_code text NULL` (`churn` \| `duplicate` \| `error`) | motivo normalizado; el texto libre queda en `skip_reason` |
| tabla `onboarding_events` (`id, holding_id, type, line_key, entity_type, entity_id, payload jsonb, actor_id, created_at`) | registro de cambios (editar, empalmar, cerrar, quitar, importar, revertir, arranque rápido) |

## 4. Pantallas (`/lab/onboarding`; destino Administración › Datos históricos)

### 4.1 Resumen

Indicadores del empalme (líneas pendientes, pendientes que ya terminaron, huecos, solapes cortados, contratos sin MRR en el
devengo, clientes con histórico y sin contrato, facturas previas pendientes) y el inicio de la historia. Entrega 3 agrega el
checklist de onboarding del holding (compañías → usuarios → productos → conexiones → contratos → histórico → facturas previas →
empalme).

### 4.2 MRR histórico (bandeja)

Lista por registro (18-10: `batch_id` × cliente × moneda × contrato): cliente, razones sociales, **productos** (uno o varios, con el MRR de
cada uno), moneda, primer y último mes, MRR del último mes (= Σ de los productos en su último mes vivo; moneda de contrato y de sistema),
estado (Pendiente, Relacionada, No activado), contrato, fecha de registro, facturas de respaldo. Filtros: estado, cliente, producto
(registros que lo contienen), registro (`batch_id`), contrato, problema de datos, búsqueda. Vista rápida con meses × producto y facturas.
Acciones en la barra de selección:

| Acción | Qué hace |
|---|---|
| Relacionar con contrato | Contrato del mismo cliente (sugiere por producto y moneda); todas las filas pendientes del registro; muestra hueco o solape antes de confirmar. |
| Crear contrato desde el histórico | Alta En revisión prellenada: **un ítem por producto** (cantidad y precio del último mes de cada uno), inicio = mes siguiente al último; se puede dejar un producto fuera (queda pendiente). Vista previa del backend. |
| No activar | `skip_reason_code = churn` con nota opcional; cuenta hasta su último mes. Reversible (Reabrir). |
| Unificar | Varios registros pendientes del mismo cliente y moneda (registrado en varias veces) pasan a uno (el `batch_id` del primero). |
| Desvincular | Quita el empalme (vuelve a pendiente). |
| Editar línea | Vuelve a registrar las facturas del registro (también así se corrige un duplicado: ya no hay "Quitar"). |

### 4.3 Facturas previas

Lista con estado de cobro, cliente, contrato vinculado y lote; vista rápida con líneas. **Importar** (plantilla de dos hojas,
mapeo de columnas recordado por holding, vista previa con `new | duplicate | error | needs_entity`, confirmación en bloque de
razones sociales y clientes comerciales faltantes con país y moneda, aplicar, revertir lote). **Registrar histórico** (§3.2b) sobre las
facturas seleccionadas: por factura, período que cubre, monto en moneda de contrato y productos con su parte, con
"autocompletar desde la primera" por cliente; vista previa con avisos y aplicar. **Arranque rápido** (§3.3): elegir mes de
corte y razones sociales, completar por cliente lo mismo que en Registrar histórico sobre su última factura más frecuencia y
método, revisar la propuesta, aplicar.

### 4.3b Adoptar como factura del contrato (18-10, Domi: "como reconciliar legacy con Por Emitir del front anterior")

Una factura previa ya emitida en el ERP pasa a ser **la factura de un mes del contrato**: conserva número, fecha de emisión y vencimiento,
moneda, neto, IVA, estado (Pagada / Vencida / Enviada; cualquier otro → Emitida) e id del ERP. Es la reconciliación legacy ↔ Por Emitir
del front anterior (`reconcile_legacy_with_por_emitir`), rehecha en la API y sin `contract_invoices` (la API v2 no la usa).

- **Meses y destino.** Una previa cubre **uno o varios meses** (`months`; por defecto el de emisión, regla: el MRR va en el mes en que inicia
  el período; una factura trimestral cubre tres). El neto se reparte entre los meses en proporción al neto de cada destino. Por mes: si el
  contrato tiene una **Por Emitir** (sin borrador en el ERP, y no tomada por otra previa de la misma selección), se reescribe en el mismo
  lugar (`replace`), con sus líneas (`contract_item_id` incluido, para que el devengo la cuente como facturado) reescaladas a la cobertura por
  peso del neto actual, IVA repartido igual y centavos cuadrados en la línea mayor. Si el mes **no tiene factura**, se **crea** (`create`)
  copiando encabezado y líneas de la factura más cercana del contrato como plantilla, con `billing_period_*` = el mes. Si ya hay una
  **emitida** ese mes → bloqueo `month_already_invoiced`; si la Por Emitir ya está como borrador en el ERP → `erp_draft` (restablecer desde el
  contrato); mes anterior al primer mes facturado → `before_contract`; contrato sin facturas → `contract_without_invoices` (activarlo primero).
- **Cobertura parcial (`keep_remainder`, Domi: la usaban otros holdings).** Si la cobertura es menor que la Por Emitir, el resto queda como
  una **Por Emitir nueva** (remanente): copia del encabezado original con `split_from_invoice_id` y `split_reason = 'legacy_partial'`, líneas
  reescaladas al remanente. Sin `keep_remainder`, la Por Emitir se reemplaza completa por la cobertura (aviso `amount_differs` si difiere > 10 %).
- **Montos y moneda.** Neto e IVA en moneda de factura son los de la previa; en moneda de contrato se convierten con `fx_contract_to_invoice`
  de la previa, si no con el de la Por Emitir/plantilla; sin tasa y monedas distintas → bloqueo `fx_missing`. Avisos `entity_differs` /
  `company_differs` si la razón social o compañía no son las del contrato.
- **Otros bloqueos.** `already_adopted`, `no_client` (relacionar cliente primero), `other_client` (selección de varios clientes),
  `contract_other_client`, `no_issue_date`, `no_amount`.
- **Escrituras (una transacción, contrato `FOR UPDATE`, marca `sapira.writer`):** `invoices` (+ `is_legacy`, `legacy_invoice_id`,
  `legacy_source_system`, `odoo_invoice_id` = id del ERP de la previa, `sent_to_odoo_at = now()` para que ningún job la reenvíe, `pdf_url`,
  nota "Adoptada desde la factura previa …"), `invoice_items`, `refreshInvoiceSystemAmounts`, `revenue_schedule_rebuild(contrato, mes)`,
  **las filas `mrr_legacy` de la previa se eliminan** (sus meses quedan en el evento; volver a registrar la factura los recrea),
  `invoices_legacy.reconciliation_status = 'migrated'` + `reconciled_invoice_id` + `contract_id` + `reconciled_at`, evento
  `INVOICE_ADOPTED_FROM_PREVIOUS` en `contract_lifecycle_events` (360 del contrato) y `previous_invoice_adopted` en `onboarding_events`.
- **Todo o nada:** `POST /onboarding/previous-invoices/adopt` con un bloqueo responde 409 `adopt_blocked` con la vista previa.
- **Pagos.** El ERP actualiza pagos buscando la factura por el id de Sapira (`x_sapira_invoice_id`), que la factura del ERP no lleva: una
  adoptada conserva el estado con que se adoptó. La factura previa sí sigue sincronizándose por `odoo_integration_id` (import de staging);
  propagar su estado a la adoptada queda como mejora (requiere tocar el import del ERP: Leon).
- **Registrar histórico** rechaza una factura adoptada (`adopted`). **Fuera de alcance (v1):** deshacer una adopción.

Contrato en §5 (`adopt/preview`, `adopt`, `adopted` en lista, detalle y resumen).

### 4.4 Lo que cambia en otros módulos

- Cliente 360: el resumen suma el histórico con corte U14 y solo recurrentes (hoy no); pestaña "Histórico" con las líneas.
- Contrato 360: sección "MRR histórico empalmado".
- Métricas: etiquetas "MRR histórico" en API y front (hoy "Legacy"); inicio de la historia por holding.
- Administración › Holding › Preferencias: campo "Inicio de la historia en Métricas".
- Facturación: el ítem "Facturas (próximamente)" del menú Importar enlaza a Datos históricos › Facturas previas cuando se publique.

## 5. Contrato de la API (módulo `onboarding`, `HoldingScopeGuard`; lectura `VIEW_CONFIGURACION`, escritura `EDIT_CONFIGURACION`)

Paginación `{ data, total, currentPage, pages, limit }`; errores `{ message, errors?[{ field, message }] }`; 409 `{ code, blockers? }`.

> **Construido 13-10 (API, sin commit; migración `1791900000000-OnboardingDatosHistoricos` sin aplicar)**: todas las filas de esta tabla.
> Formas exactas en [`mapa-v2-onboarding.md`](./mapa-v2-onboarding.md). Desvíos, con motivo:
> - Import: campos opcionales extra por fila `erp_invoice_id` (dedup por id del ERP, que la planilla no traía) además de `client_crm_id` y
>   `client_number`. 409 extra `already_reverted` en revertir y `invoice_without_entity` en `:id/client`.
> - Registrar histórico: `sum_mismatch` bloquea al aplicar (el resto de los avisos no); se salta la factura que ya tiene MRR histórico
>   (`already_registered`) o no tiene líneas (`invoice_without_items`: la fila de `mrr_legacy` exige un ítem). `mrr_legacy` no tiene
>   `product_id`: se guarda el nombre del catálogo. La respuesta agrega `batch_id`; la vista previa agrega `errors[]` y `products[]`.
> - Arranque rápido: inicio del contrato = mes siguiente al último mes cubierto (`period_to`, o el de emisión si es posterior). El body ya
>   no lleva `history_months` (las facturas anteriores se registran con Registrar histórico). `skipped[]` agrega `message`.
> - `link`/`contract` reconstruyen el devengo solo si el contrato está Activo (un borrador no tiene devengo hasta activarse).
> - El `origin` del alta desde una línea no se guarda en el contrato (no hay columna): queda en el empalme y en el evento.
> - Líneas: los 409 extra `line_not_linked` (desvincular), `line_not_removable` (quitar) y `line_not_closed` (reabrir).

> **Cierre v1 14-10 (decisiones de Domi, API sin commit, sin migración nueva).** Formas exactas en [`mapa-v2-onboarding.md`](./mapa-v2-onboarding.md) §2b.
> 1. **Editar línea = volver a registrar sus facturas** (no existen meses sin factura): `POST …/lines/:key/edit/preview` y `PATCH
>    …/lines/:key` con el registro de §3.2b por factura de la línea; se borran sus filas en la línea y se regeneran con el motor de Registrar
>    histórico (empalme conservado). Vista previa por factura × mes con MRR en moneda de contrato y de sistema (regla del trigger,
>    `src/modules/metrics/mrr-historico-fx.ts`), avisos, `rekey` y `lines_touched`. Producto o moneda en meses empalmados → 409
>    `line_linked_rekey`. El detalle de línea trae `invoices[].registration` para prellenar.
> 2. **Contrato desde el histórico = Renovación**: los ítems de `…/contract` y del arranque rápido nacen `RENEWAL` (`items[].category`
>    explícito en `CreateContractDto`, que `ContractDraftsService` respeta solo cuando viene); `contract/defaults` lo devuelve.
> 3. **Un solo estado pendiente**: `status` = `pending | linked | closed | removed`; "terminó sin resolver" = filtro `ended=true` sobre las
>    pendientes; `summary.history.pending` cuenta todas y `pending_ended` el subconjunto. Orden por defecto: prioridad de estado y cliente.
> 4. **Facturas previas**: filtros `hasHistory`, `companyId`, `country`; fila con `notes` y `country`; `GET …/previous-invoices/filter-options`;
>    `summary.previous_invoices.without_history`.
> 5. **Tipo de cambio visible**: moneda y monto de factura + fx en Registrar histórico, arranque rápido y el detalle de línea; aviso
>    `fx_one_with_different_currencies` (monedas distintas con fx entre 0,98 y 1,02).
> 6. **Plantilla con histórico en el mismo paso**: campos de histórico por línea; `import/preview` devuelve `history` por fila
>    (`none | ready | incomplete | error`) y `import` registra el de las `ready` con el motor de Registrar histórico; revertir el lote revierte
>    también su histórico propio.
> 7. Cliente comercial en la importación también por `client_crm_id` (CRM) y `client_number`.
>
> Desvíos del cierre, con motivo: el tipo de cambio al volver a registrar parte del monto en moneda de factura que la línea tenía asignado
> de la factura (no del neto completo, que puede repartirse en otras líneas); el 409 `line_linked_rekey` se evalúa por factura con meses
> empalmados; la suma de productos que no cuadra es 400 en el PATCH (aviso en la vista previa). El arranque rápido acepta además `proposals?`
> en la vista previa (para calcular fx y avisos antes de aplicar).

> **Ajustes 18-10 (decisiones de Domi, API sin commit, sin migración).** Formas exactas en [`mapa-v2-onboarding.md`](./mapa-v2-onboarding.md) §2c.
> 1. **Serie mensual del MRR histórico** para el Resumen: `GET /onboarding/history/series` (`counted` con la regla U14 única, `cut` por solape,
>    `removed`, `contracts` = devengo de los contratos empalmados en moneda de sistema; modos `system | contract | invoice`; filtros compañía
>    emisora, cliente, razón social receptora y país) y `GET /onboarding/history/filter-options`.
> 2. **Resumen**: `previous_invoices = { total, without_history, with_history, linked, by_status }` (se retira `pending`); `history` ya traía
>    `closed` (fue baja) y `removed` (duplicado o error) por separado, así que no se agregó un campo nuevo.
> 3. **Línea con sus compañías emisoras**: `companies[{ id, legal_name }]` en la lista y el detalle.
> 4. **Retiro** de `PATCH /onboarding/history/lines/:key/months`: la línea se corrige solo con `PATCH …/lines/:key` por factura.
> 5. **Línea de destino en las vistas previas** de Registrar histórico y del arranque rápido: por fila `line_key` (cliente comercial | producto
>    del catálogo | moneda de contrato, igual que al aplicar; por producto en `products[]` y en la fila la del primer producto) y `line_exists`
>    (la línea ya tiene filas en el holding); en el total `lines_touched[]` (claves distintas de lo que se aplicaría).
>
> Desvío, con motivo: `contracts` usa `mrr_period_contracted_system_ccy` sin pendiente de renovar (la columna y el filtro de Métricas, para que
> el contraste cuadre) en vez de `mrr_period_system_ccy`; en SimpliRoute ambas columnas son idénticas (0 filas distintas jul–sep 2026).

> **Ajustes 18-10, segunda tanda (decisiones de Domi, API sin commit, sin migración).** Formas exactas en [`mapa-v2-onboarding.md`](./mapa-v2-onboarding.md) §1 y §2c.
> 1. **"No aplica" viejo = "No activado"** sin interpretar el texto libre (§3.1): `legacySkipCodeSql`/`skipReasonCodeOf` = `skip_reason_code` o
>    `churn`. Afecta a Métricas, Dashboard, Clientes, Cliente 360, Ingresos (aviso `legacy_unlinked`) y este módulo. `summary.history.closed`
>    conserva la clave y cuenta las "No activado"; `removed` solo las quitadas con código.
> 2. **Serie por concepto**: `counted` = `counted_linked` (empalmadas, meses antes del corte) + `counted_not_activated` (marcadas, motivo `churn`)
>    + `counted_pending` (ni una ni otra), también por moneda.
> 3. **Serie por dimensión**: `groupBy` (`client`, `entity` = razón social receptora de la factura de origen, `product`, `company` = emisora) y
>    `top`; `rows[]` alineado con `months` (la `counted` del mes en la moneda del modo; en `contract`/`invoice` una fila por entidad × moneda),
>    las `top` primeras por el último mes con datos (desempate por suma) y "Otros" con el resto (uno por moneda); `totals.rows_total`.
>    **Filtro por concepto** (Domi 18-10, para la vista por dimensión): `concept` (`linked` | `not_activated` | `pending`) limita `counted`,
>    `by_currency`, `rows` y `rows_total` a las filas de ese concepto con el mismo predicado que separa los `counted_*` (los otros dos van en 0);
>    `after_contract` y `removed` no cambian; `filters_applied.concept`.
> 4. **Corte U14 en dos casos** (§3.1): `cut` → `after_contract` (solo meses posteriores al primer mes del contrato); el mes de empalme no se
>    expone. `summary.splice.overlap_cut` → `seam_months` (informativo) + `history_after_contract{ months, lines, contracts }`. Bandeja: filtro
>    `issue=history_after_contract` y `issues[]` en la línea. `splice.overlap_months` → `seam_month` + `months_after_contract[]` (detalle, empalmar
>    y vista previa del contrato).
> 5. **Un registro = serie × contrato, un solo estado** (§3.1). La clave `key` pasa a 4 partes (`…|<contract_id o vacío>`); la de 3 partes sigue
>    valiendo como el registro sin contrato (URLs y eventos guardados). La fila trae `series_key` (clave de la serie, común a sus registros).
>    `status` = `linked` si tiene contrato; si no, `pending | closed | removed` solo con sus filas. `link` y `…/contract` operan sobre el registro sin
>    contrato y devuelven el **registro relacionado** resultante (clave nueva); `unlink` opera sobre un registro con contrato y devuelve el registro
>    sin contrato; `close`/`remove`/`reopen` solo sobre el sin contrato (409 con el código de siempre sobre uno relacionado); editar vale en
>    cualquiera y las filas nuevas heredan su contrato. `onboarding_events.line_key` sigue siendo la serie (3 partes) y `GET /onboarding/events?
>    lineKey=` acepta cualquiera de las claves y busca por la serie. Registrar histórico identifica la serie por la raíz (`line_exists` = la serie
>    ya tiene registros) y sus filas nacen en el registro sin contrato (el arranque rápido, en el del contrato nuevo). `summary.history.lines`
>    cuenta registros y **se retira `clients_without_contract`** (segunda derivada, Domi). Prod SimpliRoute 18-10: 913 líneas (85 pendientes, 16
>    con contrato; 630 relacionadas; 198 no activadas) → 969 registros sobre las mismas 913 series: 85 pendientes **sin ningún contrato**, 674
>    relacionadas, 208 no activadas, 2 quitadas; Avon CARD PATHFINDER+ USD = 5 relacionadas + 1 pendiente.

> **Ajustes 18-10, tercera tanda — registro = `batch_id` (decisión definitiva de Domi; API sin commit, sin migración).** Formas exactas en
> [`mapa-v2-onboarding.md`](./mapa-v2-onboarding.md) §1, §2 y §2b. Reemplaza el punto 5 de la segunda tanda y los puntos 3 (estados) de 14-10 y
> 5 (línea de destino) de la primera tanda del 18-10.
> 1. **Registro = `mrr_legacy.batch_id` × cliente comercial × moneda de contrato × contrato** (§3.1), con uno o varios productos (`products[]`,
>    cada uno con su primer y último mes y el MRR de su último mes vivo; `mrr_last` = Σ). Clave `batch_id|client_id|contract_currency|<contrato o
>    vacío>` y `root_key` (3 partes). Se retiran `series_key`, `product_name`, `product_id`, `batch_ids[]`, `skip_reason_code` y `ended` de la fila;
>    entran `batch_id`, `products[]`, `legal_names[]`, `registered_at`, `root_key`. Filtros nuevos `contractId` y `batchId` (= registro);
>    `product` = registros que contienen el producto. Orden por defecto pendiente → relacionada → no activada.
> 2. **Tres estados**: `pending | linked | closed`. **Se eliminan** `removed`, `POST …/:key/remove`, el filtro `status=removed`,
>    `summary.history.removed`, `ended`/`pending_ended` y `summary.history.lines` (→ `records`). `close` solo acepta `{ notes? }` (código `churn`
>    siempre). `summary.splice.history_after_contract.lines` → `records` (registros con el problema).
> 3. **Nuevo `POST /onboarding/history/lines/unify`** `{ keys[] }` (2–50 registros pendientes del mismo cliente y moneda): `UPDATE mrr_legacy SET
>    batch_id = <el del primero>` para los demás, los eventos de sus raíces se re-clavan a la raíz resultante y queda `history_unified`.
> 4. **Contrato desde el registro: un ítem por producto** (`contract/defaults`: `items[]` con la cantidad y el unitario del último mes vivo de cada
>    producto, `products[]`, `origin.record_key`); `preview` y `create` aceptan `products?: string[]` para dejar alguno fuera (sus filas quedan
>    pendientes en el registro sin contrato). `origin.line_key` → `origin.record_key`.
> 5. **Registrar histórico, importación con histórico y arranque rápido: un `batch_id` por cliente × moneda** dentro de la misma aplicación (como
>    el modal anterior), nunca uno por importación. `target_key?` (por factura o global) suma las facturas a un registro pendiente existente del
>    mismo cliente y moneda ("continuar un registro"; errores `target_not_found` | `target_mismatch`). Las vistas previas cambian `line_key` /
>    `line_exists` / `lines_touched` por `record_key` (solo con `target_key`, si no `null`) / `record_exists` / `existing_records[]` (registros
>    pendientes del cliente en esa moneda) / `records_touched[]` + `records_to_create`; aplicar devuelve `records_touched[]` y `batch_ids[]`. La
>    importación devuelve `history_records_touched[]` + `history_batch_ids[]` (guardados en el evento del lote: revertir el lote borra ese
>    histórico; importaciones anteriores siguen revirtiéndose por el lote mismo). El arranque rápido devuelve `record_key` por contrato creado.
> 6. **Editar línea** conserva el `batch_id` del registro; cambiar un producto ya no mueve filas (409 `line_linked_rekey` solo al cambiar la
>    moneda de una factura empalmada); la vista previa trae `products[]` por mes y en `line`. El detalle trae `months[].product_name` y
>    `invoices[].registration.products[]` (uno por producto con su parte).
> 7. **Eventos**: `line_key` = raíz (`batch_id|client_id|contract_currency`); `GET /onboarding/events?lineKey=` acepta la clave del registro o la
>    raíz. Sin `history_removed`; con `history_unified`.
>
> Prod SimpliRoute 18-10 (solo lectura, SQL nueva): 11.845 filas, 736 `batch_id` → **960 registros** (68 pendientes · 692 relacionados · 200 no
> activados; antes 969 por serie × contrato), 123 con varios productos (máx. 6); 15 `batch_id` con varios clientes (hasta 39) → un registro por
> cliente; Avon CARD USD = 5 relacionados + 2 pendientes (+1 no activado MXN con 2 productos); Logytech CLF = 2 relacionados + 1 pendiente;
> 0 filas con código `duplicate` | `error` en todos los holdings; 0 eventos guardados. Lista paginada: ~450 ms.

| Método y ruta | Entrada | Salida |
|---|---|---|
| `GET /onboarding/summary` | — | `{ history: { records, pending, linked, closed }, splice: { gap, seam_months, history_after_contract{ months, records, contracts }, contract_without_mrr }, previous_invoices: { total, without_history, with_history, linked, adopted, by_status{Pagada,Enviada,Vencida} }, settings: { metrics_history_start, system_currency } }` |
| `GET /onboarding/history/series` | `currency`(`system,contract,invoice`), `companyId`, `clientId`, `entityId`, `country`, `from`, `to` (`AAAA-MM`), `groupBy`(`none,client,entity,product,company`), `top` (1–1000, 15), `concept`(`linked,not_activated,pending`; opcional: solo ese concepto en `counted`, `by_currency`, `rows` y `rows_total`; `after_contract` y `removed` no cambian) | `{ currency_mode, system_currency, months[{ month, counted, counted_linked, counted_not_activated, counted_pending, after_contract, removed, contracts, by_currency[{ currency, …mismos montos }] }], rows[{ key, label, currency, values[] }], totals{ last_month, counted_last, lines, clients, rows_total }, filters_applied }` |
| `GET /onboarding/history/filter-options` | — | `{ companies[{ id, legal_name }], countries[], currencies{ contract[], invoice[] } }` |
| `GET /onboarding/history/lines` | `status`(`pending,linked,closed`), `issue`(`history_after_contract`), `clientId`, `product` (registros que lo contienen), `batchId` (registro), `contractId`, `search`, `page`, `limit`, `sortBy`(`client,product,last_month,mrr,status,registered_at`), `sortOrder` | paginado de registros (`batch_id` × cliente × moneda × contrato) `{ key, root_key, batch_id, client{id,name}, currency, products[{ product_name, product_id, first_month, last_month, months_count, mrr_last, mrr_last_system }], first_month, last_month, months_count, mrr_last (= Σ products), mrr_last_system, status, contract{id,contract_number,status}\|null, invoices_count, skip_reason, companies[{id,legal_name}], legal_names[], registered_at, issues[] }` |
| `GET /onboarding/history/lines/:key` | — | registro + `months[{ id, period_month, product_name, subtotal_contract_currency, mrr_legacy, mrr_legacy_system_currency, term, is_recurring, invoice_number, invoice_legacy_id, counted (U14), state }]`, `invoices[{ …, registration{ period_from, period_to, contract_currency, amount_contract_currency, is_recurring, products[{ product_id, product_name, amount_contract_currency }] } }]`, `splice{ gap_months, seam_month, months_after_contract[], contract_first_month }`, `candidates[{ id, contract_number, status, products[], currency, start_date, end_date, score }]`, `events[]` (de la raíz) |
| `POST /onboarding/history/lines/:key/link` | `{ contract_id }` (registro sin contrato) | `{ line, splice }` (`line` = el registro relacionado resultante, clave nueva; mismo `splice` que el detalle); 409 `contract_other_client` \| `line_not_pending` |
| `POST /onboarding/history/lines/:key/unlink` | — (registro con contrato) | el registro sin contrato resultante (`pending`); 409 `line_not_linked` |
| `POST /onboarding/history/lines/:key/close` | `{ notes?: string }` (registro sin contrato; "No activar") | registro (`closed`); 409 `line_not_pending` |
| `POST /onboarding/history/lines/:key/reopen` | — (registro sin contrato) | registro (`pending`); 409 `line_not_closed` |
| `POST /onboarding/history/lines/unify` | `{ keys: string[] }` (2–50 registros pendientes del mismo cliente y moneda; el primero manda) | el registro resultante; 409 `record_not_pending` \| `unify_mismatch` |
| `GET /onboarding/history/lines/:key/contract/defaults` | — | `CreateContractDto` prellenado (`client_id`, `client_entity_id` sugerida, `company_id`, `contract_currency`, `items[{ key, product_id, product_name, quantity, unit_price, billing_frequency: 'Mensual', billing_method: 'Anticipado', term_months: 12, start_date: último mes + 1, category: 'RENEWAL' }]` **uno por producto**, `products[]`, `origin: { type: 'history', record_key }`) + `warnings[]` |
| `POST /onboarding/history/lines/:key/contract/preview` | `CreateContractDto` + `origin?` + `products?` | vista previa de Contratos (`POST /contracts/preview`) + `splice` (de los productos elegidos) |
| `POST /onboarding/history/lines/:key/contract` | `CreateContractDto` + `products?` (registro sin contrato) | `{ contract{id, contract_number}, line }` (`line` = el registro relacionado nuevo; crea En revisión con `ContractDraftsService.create` y empalma las filas pendientes de los productos elegidos, por defecto todos) |
| `GET /onboarding/previous-invoices` | `status`, `linked`(`true/false`), `clientId`, `entityId`, `batchId`, `search`, `from`, `to`, `page`, `limit`, `sortBy` | paginado de `{ id, invoice_number, issue_date, due_date, entity{id,legal_name,tax_id}\|null, legal_client_name, client_tax_id, client{id,name}\|null, company{id,legal_name}, currency, amount, vat, total, status, source_type, source_system, contract{id,contract_number}\|null, batch_id, has_history, adopted{ invoice_id, invoice_number, status, contract_id, contract_number }\|null }`; filtro `adopted` (`true/false`) |
| `GET /onboarding/previous-invoices/:id` | — | factura + `items[]` + `history_months[]` + `events[]` |
| `POST /onboarding/previous-invoices/import/preview` | `{ invoices:[{ row, invoice_number, issue_date, due_date?, legal_client_name, client_tax_id?, company_name, source_type?, source_system?, currency, amount, vat?, total, status?, notes?, items:[{ description?, product_external_code?, quantity?, unit_price?, discount_pct?, subtotal, tax_amount?, total? }] }], batch_label? }` (máx. 2.000) | `{ rows:[{ row, status: 'new' \| 'duplicate' \| 'error' \| 'needs_entity' \| 'needs_client', errors[], entity{id,legal_name}\|null, client{id,name}\|null (por RUT o id del CRM), entity_suggestion{ legal_name, tax_id, country?, client_candidates[{id,name,score}] }, company{id}\|null }], summary{ new, duplicate, error, needs_entity, needs_client, by_currency[] }, missing_entities[{ legal_name, tax_id, rows, client_candidates[] }], missing_companies[] }` |
| `POST /onboarding/previous-invoices/import` | `{ invoices, batch_label?, create_entities?: [{ legal_name, tax_id?, country, client_id? }] }` (nunca crea clientes comerciales; `client_id` es uno existente del CRM) | `{ batch_id, inserted, skipped_duplicates, errors, entities_created, needs_client, history_rows_created, history_records_touched[], history_batch_ids[], history_skipped[] }`; 409 `nothing_to_import` |
| `POST /onboarding/previous-invoices/:id/client` | `{ client_id }` | relaciona la razón social de la factura con un cliente comercial existente (`client_entity_clients`) |
| `POST /onboarding/previous-invoices/register-history/preview` | `{ invoices:[{ invoice_id, period_from: 'YYYY-MM', period_to: 'YYYY-MM', contract_currency, amount_contract_currency, is_recurring?, products:[{ product_id, amount_contract_currency }], target_key? }], target_key? }` | `{ rows:[{ invoice_id, months[], mrr_per_month, fx_contract_to_invoice, products[], record_key\|null, record_exists, existing_records[{ key, batch_id, products[], first_month, last_month, months_count, mrr_last, registered_at }], warnings[] (`sum_mismatch`, `month_already_covered`, `fx_outlier`, `no_client`), errors[] (+ `target_not_found`, `target_mismatch`) }], summary{ …, records_touched[], records_to_create } }` |
| `POST /onboarding/previous-invoices/register-history` | mismo body | `{ created_rows, records_touched[], batch_ids[], skipped[{ invoice_id, reason }] }` (un `batch_id` por cliente × moneda, o el del `target_key`); marca `reconciliation_status = mrr_legacy` |
| `POST /onboarding/previous-invoices/import/:batchId/revert` | — | `{ batch_id, removed }`; 409 `batch_has_history` \| `batch_linked` |
| `GET /onboarding/previous-invoices/batches` | — | `[{ id, label, created_at, created_by, count, reverted }]` |
| `POST /onboarding/previous-invoices/adopt/preview` (§4.3b) | `{ contract_id?, invoices:[{ invoice_id, months?: ['YYYY-MM'], keep_remainder? }] }` (1–50) | `{ client{id,name}\|null, contracts[{ id, contract_number, status, contract_currency, client_entity_id, company_id, first_month, last_month, pending_months[] }], contract\|null, invoices[{ invoice{ id, invoice_number, issue_date, status, invoice_currency, amount_invoice_currency, vat, total_invoice_currency, entity_legal_name, client_name, company_legal_name, erp_invoice_id, has_history }, months[], keep_remainder, targets[{ month, kind: 'replace' \| 'create', invoice_id, target_amount_contract_currency, coverage_contract_currency, remainder_contract_currency\|null, template_invoice_number }], amounts{ contract_currency, invoice_currency, fx_contract_to_invoice, amount_contract_currency, vat_contract_currency, status }\|null, history_months[], blockers[{code,message}], warnings[], can_apply }], can_apply }`. Sin `contract_id`: candidatos y ningún destino |
| `POST /onboarding/previous-invoices/adopt` | `{ contract_id, invoices[], notes? }` | todo o nada: `{ applied, contract, adopted[{ previous_invoice_id, invoice_number, invoices[{ invoice_id, month, created, remainder_invoice_id }] }] }`; 409 `adopt_blocked` (con `preview`) \| `target_changed` \| `template_missing` |
| `POST /onboarding/quick-start/preview` | `{ as_of: 'YYYY-MM', entity_ids?: [], history_months?: 0..24, proposals? }` | `{ proposals:[{ entity{id,legal_name}, client{id,name}\|null, last_invoice{id,number,issue_date,total,currency}, items:[{ description, quantity, unit_price, product_id\|null, product_suggestion }], contract{ start_date, currency, billing_frequency, billing_method }, history_months_found, flags[] (`no_client`, `no_product`, `already_has_contract`, `multi_currency`), existing_records[] }], summary{ …, records_to_create } }` |
| `POST /onboarding/quick-start` | `{ as_of, proposals:[{ entity_id, period_from, period_to, contract_currency, amount_contract_currency, products:[{ product_id, amount_contract_currency, quantity?, unit_price? }], billing_frequency?, billing_method?, term_months? }] }` (lo de §3.2b por cliente; sin producto o sin cliente comercial no se aplica) | `{ created:[{ entity_id, contract{id,contract_number}, history_rows, record_key }], skipped:[{ entity_id, reason }] }` (un registro nuevo por propuesta) |
| `GET /onboarding/events` | `lineKey?` (clave de un registro o su `root_key`: busca por la raíz), `entityId?`, `page` | paginado de eventos (`line_key` = raíz codificada) |
| `PATCH /settings/holding/preferences` | `+ metrics_history_start` | (existente, un campo más) |

Reglas: toda escritura abre transacción con `setApiWriter`; ninguna escritura dispara notificaciones, correos ni
sincronizaciones; `link`/`contract` recalculan el devengo del contrato afectado (`revenue_schedule_rebuild`) y nada más.

## 6. Plantillas

- **Facturas previas**: la misma de dos hojas que ya usan los clientes (hoja Facturas: `invoice_number, issue_date, due_date,
  legal_client_name, client_tax_id, company_name, source_type, source_system, invoice_currency, amount_invoice_currency, vat,
  total_invoice_currency, status, pdf_url, notes`; hoja Items: `invoice_number, product_external_code, description, quantity,
  unit_price, discount_pct, tax_code, currency, subtotal, tax_amount, total, account_code`). Entrega 2: mapeo libre de columnas.
- **MRR histórico directo** (holdings con historia en planilla, entrega 2): `cliente_rut | cliente_nombre, razon_social_rut?,
  producto, moneda, monto_mensual, desde (YYYY-MM), hasta (YYYY-MM), recurrente, compania?, nota?`.
- **Contratos vigentes** (entrega 2): la plantilla de tres hojas actual más `facturar_desde`.

## 7. Qué no haremos

Facturas o devengo sintéticos ni saldos de apertura; dos fuentes en un mismo cliente × producto × mes; conciliación línea a
línea; recalcular impuestos o prorrateos de facturas previas; enviar facturas previas al ERP o al SII; crear clientes o
razones sociales sin confirmación; borrados físicos; catálogo de motivos visible (solo "fue baja" / "duplicado o error").

## 8. Entregas

1. **Lab, para SimpliRoute hoy (esta semana)**: módulo `onboarding` en la API (§5 completo salvo lo marcado entrega 2),
   `/lab/onboarding` con Resumen, bandeja de MRR histórico con sus acciones, Facturas previas con importación por plantilla,
   arranque rápido, inicio de la historia por holding, Cliente 360 con corte, etiquetas "MRR histórico". Con esto Domi
   resuelve desde la pantalla las 67 líneas pendientes, los 28 huecos, los 12 contratos sin MRR y carga Brasil (piloto).
2. **Importadores y casos especiales**: mapeo libre de columnas, planilla de MRR histórico directo, contratos vigentes con
   `facturar_desde`, última factura multi período (§3.3.4), facturas previas pendientes en Cobranza como externas.
3. **Setup y publicación**: alta de holding por firma de términos (S8-3), checklist guiado con agente (S8-4), migración
   rápida desde conexiones (S8-6), retiro de RPC y tablas viejas; publicación como Administración › Datos históricos (el
   sidebar de Administración se despliega en submódulos: Holding y compañías · Usuarios y permisos · Datos históricos).
4. **Sugerencias de empalme** (idea de Domi 18-10, solo anotada; "da para más"): proponer el contrato activo a una factura previa
   pendiente o a un registro de MRR histórico pendiente cuando calcen y cierren un hueco. Criterio: mismo cliente comercial, mismo
   producto y misma moneda de contrato; el último mes del histórico (o el período de la factura previa) cae **justo antes** del primer
   mes con MRR del contrato = cierra hueco → sugerencia directa; si se solapan con el contrato, se sugiere igual pero con aviso de que
   habría que ajustar el contrato (inicio o primer mes facturable) antes de empalmar. Sin construir hasta que Domi lo priorice.

## 9. Decisiones tomadas (13-10) y pendientes

Tomadas: D1 fuente = facturas cuando el cliente no conoce sus contratos, planilla de contratos cuando sí; la línea de MRR
histórico es la unidad de métricas · D2 corte U14 por línea + inicio de la historia por holding · D3 sin catálogo: cerrar =
baja, quitar = duplicado/error · D4 arranque rápido desde la última factura como camino principal; sin saldos de apertura; sin
conciliación línea a línea · D5 nace en el lab y se publica en Administración › Datos históricos · D6 piloto Brasil con la
planilla existente · D7 migración §3.5 con OK de Domi antes de aplicar.

Pendientes: la planilla de Brasil no trae RUT ni id del CRM, así que las facturas no se pueden relacionar con los clientes
comerciales (en prod, las 35 razones sociales de Brasil y las 60 de Argentina sí están relacionadas a su cliente del CRM): pedir
a SimpliRoute la lista de facturas con RUT y el id del cliente comercial del CRM (Brasil y Argentina), al menos la última factura
por cliente activo en 2026 · el producto, el período y el monto en moneda de contrato los completa la usuaria al registrar (§3.2b)
· si Brasil se carga completo (1.921 facturas) o solo desde jul-2026.

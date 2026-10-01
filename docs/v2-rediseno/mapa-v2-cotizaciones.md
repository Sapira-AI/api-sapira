# Mapa v2 · Cotizaciones (módulo `quotes` + `/lab/cotizaciones`)

> 28-09-2026 · Domi + Claude. Propuesta para revisión; lo construido el 28-09 (API, sin aplicar en ninguna base) está en [§10](#10-construido-28-09-código-listo-sin-aplicar). Misma estrategia que Contratos
> ([`mapa-v2-contratos.md`](./mapa-v2-contratos.md) §1): **la v2 se construye al lado de lo viejo**, sobre las mismas tablas
> (`quotes`, `quote_items`, `quote_stages`, `quote_attachments`), con la lógica en la API y el front viejo intacto hasta el
> switch. Orden acordado de módulos: Contratos → **Cotizaciones** → Facturación ([`auditoria-contratos.md`](./auditoria-contratos.md)
> l.9: "Cotizaciones casi no tiene funciones"). Fuentes: auditoría §S1 "Desde cotización" y §S3a, [`spec-tablas-por-modulo.md`](./spec-tablas-por-modulo.md)
> §4, [`matriz-scope-migracion-front.md`](./matriz-scope-migracion-front.md) fila 9, [`mejoras-y-brechas.md`](./mejoras-y-brechas.md),
> [`inventario-rpc-front-viejo.md`](./inventario-rpc-front-viejo.md), [`spec-pricing-v2.md`](./spec-pricing-v2.md) etapa 3,
> `sapira-ai/docs/ROADMAP-OPERATIVO.md` (Medios #4, #9, #11; Complejos #1), el front viejo `sapira-ai/src/components/cotizaciones/**`,
> el código v2 que ya toca cotizaciones (`contract-drafts.service.ts`, `contract-changes.service.ts`, `client-quotes.service.ts`) y el
> mockup O2C (pantallas 1d "Cotizaciones — lista unificada", 4c "Planes", 2b/1h vínculos). Datos: lectura de QA (`obvwrhvyuimjoejqmuqf`,
> 104 cotizaciones · 172 ítems · 3 holdings) y cifras de prod ya publicadas en `entities/cotizaciones-catalogo/README.md` (411 · 460 · 37,
> 28-09) y `censo-prod.md` (330 · 387 · 43 · 0 adjuntos). No se consultó prod. "Supuesto" marca lo que asumo.

## 1. Objetivo y alcance

**Entra en v2 (una sola construcción, funcional contra `api-sapira` desde el día 1):**

1. **Lista** paginada y filtrada en servidor, con KPIs, pestañas por estado, filtros avanzados, columnas, export y acciones
   masivas: misma anatomía que Contratos (mockup 1d: "misma anatomía que 1e y 1f").
2. **Cotización 360** (`/lab/cotizaciones/[id]`, reemplaza el diálogo `?detail=`): encabezado con línea de vida, franja de datos,
   pestañas Resumen · Ítems · Vínculos · Historial, acciones.
3. **Creación y edición** (wizard) con ítems que reutilizan el modelo de precio de Pricing v2 (`PriceSpec`) y el catálogo.
4. **Estados** (etapas por holding, hoy `quote_stages`) con transiciones validadas en la API, y el **flujo hasta contrato**:
   crear contrato nuevo (ya construido en Contratos: `GET /contracts/from-quote/:id` + `POST /contracts`) o aplicar a un contrato
   existente (ya construido: `POST /contracts/:id/changes` con `origin: quote`). Cotizaciones **no reimplementa** nada de eso: enlaza.
5. **Etapas del holding**: CRUD y orden (hoy `StageManagement` en la pestaña Kanban).

**Queda fuera o se marca 🔲 (no decidido):**

- 🔲 **PDF**: hoy no existe (`CotizacionesList.tsx:603-606` es un toast que dice "PDF descargado" sin generar nada). Requiere plantilla
  por compañía → misma decisión que S1-8 (plantillas de contrato, "oculto por ahora"). v2 no lo promete.
- 🔲 **Envío por correo y firma electrónica**: hoy "Enviar" solo mueve la etapa a Enviada (`:275-288`) y "Firmada" es manual con
  booking date. v2 mantiene el semántico (etapa + fecha) y deja el canal (email/e-sign) como integración futura.
- 🔲 **Adjuntos** (`quote_attachments`, 0 filas en prod, 4 policies): "barata y útil" (spec-tablas). Entra solo si Domi confirma;
  iría con URL firmada emitida por la API (regla AGENTS). Depende del gate OC/HES (A11).
- **Kanban** (`CotizacionesCanvas`): no se migra como vista principal; la lista con pestañas por estado la reemplaza. Supuesto.
- **Panel de vendedores** (`VendedoresAnalytics`, Medios #9 "cero commits desde julio"): va a Reportes cuando migre, leyendo `invoices`
  y no `contract_invoices` (decisión 2 del mapa de Contratos).
- **Configuración de productos y vendedores** (diálogos de la página vieja): productos → "Planes y precios" (Pricing etapa 3);
  vendedores → Configuración del holding.
- **Import CSV de cotizaciones** (`dataImportService.importQuotes`): roto y oculto (U17). **Pantalla CRM/Salesforce**
  (`CotizacionesCRMIntegration.tsx`, 2.425 líneas): vive en Integraciones, que ya tiene cobertura total de API (matriz fila 3).

## 2. Flujo actual en el front viejo (paso a paso)

Todo va directo a Supabase (PostgREST) desde el navegador; **0 endpoints** de API y una sola RPC de negocio
(`apply_quote_downsell_to_contract`, 2 sitios de llamada). `SRC` = `sapira-ai/src/components/cotizaciones/`.

| Paso | Cómo funciona hoy | Tablas / RPC / triggers | Problemas conocidos (cita) |
|---|---|---|---|
| **Origen A · Salesforce** | Oportunidades ganadas por `CloseDate` → `quotes` con `quote_number` = Id de la oportunidad, `quote_type` vía `salesforce_quote_type_mappings`, etapa `ILIKE '%enviada%'` o la primera del holding, `payment_terms` texto de master data, nota automática "Stage SF → Enviada"; ítems con `data_source = 'salesforce'`, `price = plazo × unitario × cantidad` calculado en el sync | `salesforce-sync-complete.service.ts:1841-1890, 1940-1990`; `trg_quote_items_calculate_pricing` | **`end_date = inicio + plazo` sin −1 día** (`:1956-1963`; auditoría S3a: 165 de 260 ítems; QA: 57/172 con ese patrón) → líneas "1 a 1" y fin al día 1 al asignar (ROADMAP Complejos #1 fila 1) |
| **Origen B · Manual** | `CotizacionesForm` en 3 tarjetas: Información básica (cliente*, contacto, vendedor, fecha*, términos texto, moneda, número, tipo), Ítems (tabla inline: producto, tipo, unidad, cantidad, unitario, precio, dcto, duración, inicio/fin, frecuencia, método, recurrente, moneda, cuenta, auto-renew, custom fields) y 4 flags. `precio_final = precio − dcto` **en el navegador**; `total_amount = Σ final`; etapa inicial "Procesando" o la primera por `position` | `cotizacionSubmitService.ts:1-275` (`from('quotes').insert`, `from('quote_items').insert`) | El schema Zod (`cotizacionTypes.ts`) exige duración ≥ 1 pero nada más; el trigger no recalcula `price`/`final_price` (solo mensual/período/anual) → **Medios #4** "editar ítem no recalcula precios" (NSAgro, Sinba): una cotización SF corregida a mano queda en 0 y `final_price > 0` bloquea Enviada→Firmada. QA: `total_amount ≠ Σ final_price` en **95 de 103** |
| **Edición** | Solo si la etapa no es "firmada" (`useEditableValidation.canEditQuote`). UPDATE del encabezado → **DELETE de todos los ítems → INSERT nuevos** | `cotizacionSubmitService.ts:120-190` | Sin transacción; los ítems **cambian de `id`** (rompe `contract_items.quote_item_id` — la FK es NO ACTION, así que el DELETE falla con 23503 después de haber pisado el encabezado). En "Contrato creado" el botón se oculta, pero la regla vive solo en el front |
| **Duplicar** | Copia encabezado e ítems a la etapa "Procesando"/primera; conserva `quote_number` (el Id de SF) | `CotizacionesList.tsx:536-600`, `useCotizacionesCanvas.ts:100-130` | Duplica el número; masivo = loop uno a uno |
| **Lista** | `quotes.select('*', clients, client_contacts, sellers, quote_items(monthly_price, billing_period_price, product_id), quote_stages)` **sin filtro ni paginación**; segundo viaje `contracts.in(quote_id)` y tercero `quote_items → contract_items` para las asignadas; filtros y orden en el navegador (`AdvancedFilters`) | `CotizacionesList.tsx:360-470` | KPIs por **nombres de etapa hardcodeados** (`'Enviada'`, `'Firmada'`, `'Perdido'`; `pages/Cotizaciones.tsx:75-125`): conversión = firmadas / (firmadas + enviadas). Holding con nombres distintos (los defaults del trigger son "Borrador… Cerrada - Ganada") ve ceros |
| **Detalle `?detail=`** | Diálogo con Información general, tabla de ítems, flags y custom fields; título = 8 caracteres del UUID | `CotizacionDetailDialog.tsx`, `useCotizacionDetailDialog.ts` | Sin historial, sin vínculo al contrato, sin totales por frecuencia |
| **Cambio de etapa** | UPDATE `quote_stage_id`. Bloqueado si `contracts.quote_id` existe (solo mira la relación directa). Hacia "Firmada": valida ítems (producto, `final_price > 0`, inicio, fin, plazo, frecuencia, método) y **pide/confirma `booking_date`** (`BookingDateDialog`). "Contrato creado" nunca se elige a mano (`:1171`) | `CotizacionesList.tsx:183-345` | Reglas solo en el front; una cotización aplicada por `AssignToContract` (sin `contracts.quote_id`) sí puede retroceder |
| **Enviar / Marcar firmada (uno o masivo)** | = cambio de etapa por nombre | `:275-340, 746-772` | No envía nada; "Enviada" inexistente → error |
| **Crear contrato** | Solo en Firmada: `navigate('/contratos?cotizacionId=…&fuente=cotizacion')` → wizard viejo precargado (`useQuoteHandler.ts`) → al guardar marca "Contrato creado" (`contractCreationService.ts:264-276`, si la etapa existe) | `contracts.quote_id`, `contract_items.quote_item_id/_number`, `trg_inherit_auto_renew_from_quote_item` | Auditoría S1: términos de pago **100 % perdidos** (17/21), booking de cabecera ≠ cotización (4/21), Hanka sin etapa "Contrato creado" (15 quedaron en Firmada); S1-5 auto-renew heredado aunque se desmarque |
| **Asociar a contrato existente** | `AssignToContractModal` (1.583 líneas): lista contratos Activo/En revisión del cliente; categoría por `quote_type`; downsell/renegociación por RPC, upsell/cross-sell inline en 6 tablas sin transacción; al final marca "Contrato creado" (`:995-997`, **sin filtrar holding**) | `apply_quote_downsell_to_contract`, inserts en `contract_items`, `invoices`, `invoice_items`, `contract_amendments(_items)`, `contract_lifecycle_events` | Todo Complejos #1 (auditoría S3a: IVA 0,19 fijo, merge por fecha exacta, moneda de la cotización con fx 1, plazo sin acotar, UPSELL de producto inexistente, sin agrupación —ROADMAP l.63—). **Ya reemplazado** en la API por `POST /contracts/:id/changes` (mapa Contratos §2d) |
| **Eliminar (uno o masivo)** | DELETE físico; bloqueado en Firmada / Contrato creado solo por el front | `:610-640, 774-805` | Sin auditoría; una cotización SF borrada **vuelve** en la próxima sincronización (Supuesto: el mapping `Opportunity` sigue y `findOne` por `salesforce_opportunity_id` no la encuentra → la recrea) |
| **Etapas** | CRUD y drag & drop (`StageManagement`, `useQuoteStages`); reordenar = UPDATE a posiciones negativas y luego finales (UNIQUE `holding_id, position`) | `quote_stages` | Colores de "Firmada"/"Perdido" fijos en código; sin noción de etapa "de sistema" más allá de `is_system_stage` (solo 2 holdings la usan) |

**Etapas reales (QA, 3 holdings):** `Recepcionado > Negociando > Enviada* > Firmada* > Perdido` · `Recibido > Procesando > Enviada* > Firmada* > Perdido`
· `Enviada > Modificada > Firmada > Perdido` (`*` = `is_system_stage`). **Ninguna tiene "Contrato creado"** y ninguna coincide con el
seed del trigger (`create_default_quote_stages_for_holding`: Borrador, Enviada, En Revisión, Aprobada, Rechazada, Cerrada - Ganada,
Cerrada - Perdida). Prod: 43 etapas en ~9 holdings (censo); la auditoría confirma que Hanka no tiene "Contrato creado". El front
busca por nombre exacto y la API v2 por `lower(name)`: el nombre es hoy el contrato implícito. → M16 "mejorar nombres de estados".

## 3. Modelo de datos hoy

| Tabla | Prod / QA | Columnas relevantes | Nota |
|---|---|---|---|
| `quotes` | 411 / 104 | `holding_id`, `client_id` (FK CASCADE), `client_contact_id`, `seller_id`, `quote_stage_id` (NOT NULL), `quote_number` (texto; en SF = Id de oportunidad, 6 nulos en QA), `quote_type` (texto libre), `quote_date`, `booking_date` (29 nulos), `currency`, `total_amount`, `payment_terms` (texto: "Net 30", "30 días", vacío en 62), `notes`, 4 flags `requires_*`, `salesforce_opportunity_id` (UNIQUE parcial por holding), `created_at` | **Sin `updated_at`, sin `company_id`, sin `client_entity_id`, sin vigencia, sin borrado lógico, sin `created_by`**. RLS `tenant_isolation_*` + INSERT |
| `quote_items` | 460 / 172 | `quote_id` (FK CASCADE, nullable), `product_id` (FK, nullable), `product_name`, `item_type`, `unit_of_measure`, `quantity`, `unit_price`, `annual_unit_price`, `price_entry_mode` (CHECK monthly/annual), `price`, `discount_type` (CHECK Monto fijo/Porcentaje), `discount_value`, `final_price`, `monthly_price`, `billing_period_price` (trigger), `billing_frequency` (CHECK 5), `billing_method` (CHECK 2), `start_date`, `end_date`, `term_months`, `is_recurring`, `auto_renew`, `auto_renew_term_months`, `account`, `custom_fields` jsonb, `quote_item_number` (UNIQUE parcial), `salesforce_line_item_id` (UNIQUE parcial), `salesforce_product_id`, `data_source`, `currency` | 33 columnas: identidad + precio duplicado + facturación + SF en una fila (spec-tablas: "el ítem referencia un precio v2 en vez de duplicar price/final_price"). QA: 10 sin inicio, 11 sin fin, 30 no recurrentes, 53 con auto-renew, 115 con descuento, 0 con moneda ≠ encabezado |
| `quote_stages` | 43 / 14 | `holding_id`, `name`, `position`, `color`, `is_system_stage`, `is_deletable`; UNIQUE (holding, name) y (holding, position) | Seed por trigger al crear holding. Sin tipo semántico |
| `quote_attachments` | 0 / 0 | `attachment_type` CHECK acceptance/purchase_order/hes/contract/other, `file_url` | Nunca operada |
| `products` | 88 / — | catálogo con `default_price` (se mantiene; el precio vive en `prices` en etapa 3) | spec-tablas §4 |
| `salesforce_quote_type_mappings` | 6 / 5 | `salesforce_type` → `sapira_quote_type` por holding | Origen de los sinónimos de `quote_type` |

**Estados reales en datos (QA):** Enviada 61 · Firmada 18 · Negociando 12 · Perdido 7 · Recepcionado 6. `quote_type`: Upselling 27 ·
New Business 17 · Upsell 15 · Downselling 11 · Nuevo cliente 11 · NewBusiness 11 · Renewal 8 · Despliegue 1 · nulo 3 (**tres grafías
para "nuevo negocio" y dos para upsell**: `AssignToContractModal:270-283` las normaliza por `includes('down'|'cross')`, todo lo demás es
UPSELL). Monedas: USD 23, MXN 21, CLF 18, COP 12, CLP 10, PEN 9, BRL 6, ARS 5. Volumen: 55 en jul-26 (todas SF), 41 en mar-26 (manuales).

**Relación cotización → contrato (dos caminos):**

- **Contrato nuevo**: `contracts.quote_id` (QA: 15 contratos, 15 cotizaciones, ninguna con más de uno; v2 lo garantiza con
  `assertQuoteUnused` → 409) + `contract_items.quote_item_id` y `quote_item_number` (este último cruza con `quantities`/DWH).
- **Aplicada a contrato existente**: solo `contract_items.quote_item_id` (QA: 1 cotización cuyos ítems viven en un contrato con otro
  `quote_id`) y, en v2, `contract_lifecycle_events.metadata.origin.quote_id` (`contract-changes.service.ts:769-775` lo usa para
  `already_applied`). La lista vieja hace el lookup inverso a mano; v2 lo resuelve en SQL.
- **Firmadas sin contrato**: 11 de 18 en QA (en prod, las 15 de Hanka de la auditoría). Con la etapa "Contrato creado" inexistente,
  Firmada mezcla "por contratar" con "ya contratada": v2 lo deriva del vínculo (§5).

**Lo que Contratos v2 ya consume de la cotización** (`contract-drafts.service.ts:433-560, 1871-1954`):
`GET /contracts/from-quote/:quoteId` lee `quote_number`, `quote_type`, `booking_date`, `currency`, `payment_terms`
(`parsePaymentTermsText`: "Net 30" → condición estructurada; si no se interpreta, aviso), `salesforce_opportunity_id`, `client_id`, la
etapa (aviso si no es Firmada) y las razones sociales del cliente (la razón social **siempre se elige**); por ítem `product_id`,
`product_name`, `account`, `item_type`, `unit_of_measure`, `quantity`, `unit_price` (o `price / (qty × plazo)`), `annual_unit_price` +
`price_entry_mode`, descuento (Monto fijo → % con aviso), `billing_frequency`, `billing_method`, `start_date`, `term_months`,
`is_recurring`, `auto_renew(_term_months)`; devuelve `warnings[]` (sin producto, sin tipo, sin inicio). `POST /contracts` con `quote_id`:
`FOR UPDATE` de la cotización, copia los 4 flags y `type = quote_type`, valida que cada `items[].quote_item_id` pertenezca a la
cotización, corrige S1-5 tras el trigger, marca la etapa **"Contrato creado" por `lower(name)`** (warn si el holding no la tiene) y deja
`origin: quote:<id>` en el evento. `PUT /contracts/:id` no permite cambiar `quote_id`. `POST /contracts/:id/changes` con `origin.type =
'quote'`: bloqueos `quote_already_applied` y `new_business_quote_on_existing_contract` (S3-3), y marca la misma etapa al final (M1).
En el front nuevo: `CrearDesdeCotizacionDrawer` (cliente → cotizaciones firmadas vía `GET /clients/:id/quotes?stageId=`, etapa firmada
detectada por regex `/^firmad[ao]s?$/`) y el 360 de contrato muestra "Cotización de origen" (mockup 1h, `overview.quote`).
`GET /clients/:id/quotes` (`client-quotes.service.ts`) ya es una lista paginada por cliente con `stages[]` y conteos: **es el embrión
de `GET /quotes`**.

## 4. Decisiones ya tomadas vs abiertas

**Tomadas (se respetan, no se reabren):**

| # | Decisión | Fuente |
|---|---|---|
| Q-D1 | Cotizaciones se construye **después de Contratos** y antes de Facturación; su brecha es "CRUD directo más que funciones" | auditoría l.9; inventario-rpc l.150; matriz fila 9 (prioridad 2, 0 endpoints) |
| Q-D2 | Aplicar cotización a contrato existente vive en la API (`POST /contracts/:id/changes`, origen `quote:<id>`), no en el front; D-A (función SQL `apply_quote_upsell_to_contract`) quedó superada por M1 | auditoría D-A; mapa Contratos §2d |
| Q-D3 | Solo contratos **Activo** reciben una cotización; método de facturación lo elige la usuaria con default del contrato; "Nuevo cliente" sobre contrato existente **se bloquea** con validador; fecha efectiva default = inicio del ítem cotizado | S3-1, S3-2, S3-3, S3-4 |
| Q-D4 | Términos de pago **se propagan** cotización → contrato → factura como condición estructurada (default razón social) | S1-4, Medios #11 |
| Q-D5 | Auto-renovación de la cotización es **propuesta**, lo desmarcado se respeta; el fix del trigger se difiere a Contratos + Cotizaciones en el front nuevo | S1-5; saneamiento l.165 (Domi 25-09) |
| Q-D6 | Booking = fecha de cierre del negocio; desde cotización, la booking de la cotización; siempre editable | S1-13, S2-7 |
| Q-D7 | "Contrato creado" solo se alcanza por el flujo real (crear/aplicar), nunca a mano | `CotizacionesList.tsx:1171`; v2 lo cumple en la API |
| Q-D8 | `quotes` "funciona bien (B1, ventaja que nadie tiene)": ajustes de etapa/flags, `booking_date`, flag OC/HES conectado al gate real (A11). `quote_items` referencia un **precio v2** en vez de duplicar `price/final_price`. `products` = catálogo sin precio | spec-tablas §4; mejoras-y-brechas §B1 |
| Q-D9 | Pricing etapa 3 = catálogo versionado (`prices.owner = catalog`), "Planes y precios" (mockup 2b/4c), **tramos en cotizaciones**, `list_price_id` para negociado vs lista; "publicar v3 no toca contratos firmados; las cotizaciones nuevas usan v3" | spec-pricing §1 y §6; mockup l.388, 748-822 |
| Q-D10 | Estado guardado solo por acción explícita; el mostrado se calcula al leer; sin workflow de aprobación; Supabase solo auth, todo por BFF → API; `x-holding-id` + `HoldingScopeGuard` | mapa Contratos §2a; AGENTS.md; `autorizacion-y-tenancy.md` |
| Q-D11 | Lista, filtros avanzados en panel lateral y selección múltiple con el componente estándar, como Contratos | mapa Contratos §2a; mockup 1d |

**Abiertas (opciones + recomendación):**

| # | Tema | Opciones | Recomendación |
|---|---|---|---|
| Q-A1 | **Modelo de estados**: (1) etapas 100 % libres por holding como hoy; (2) estados fijos del sistema y se descartan las etapas; (3) **etapas configurables con un `kind` de sistema** (`draft · sent · signed · lost · contract_created`) y etapas intermedias libres | (3): conserva lo configurable (B1) y le da a la API y a los KPIs un contrato estable; el nombre deja de ser el contrato. Backfill por nombre (§8) |
| Q-A2 | **Vigencia** ("Válida hasta" en el mockup 1d; no existe en BD) | (a) no modelar; (b) `valid_until` con estado derivado "Vencida" y recordatorio | (b): es lo que el mockup muestra en la fila Q-235 ("Recordar"). Aditivo, opcional, default `quote_date + N días` por holding (Supuesto: 30) |
| Q-A3 | **Precio del ítem** en v2: (a) seguir con `unit_price × cantidad × plazo − dcto` calculado en la API; (b) `items[].price: PriceSpec` inline desde el día 1 (mismo DTO y motor que Contratos); (c) además precio de catálogo (`price_id`, etapa 3) | (b) ahora, (c) cuando llegue etapa 3: reutiliza `validatePriceSpec`/`priceLine` y el preview; `quote_items.price_id` es aditivo y `fromQuote` copia el precio al contrato. Sin `price_id` = standard fijo (idéntico a hoy) |
| Q-A4 | **Compañía emisora en la cotización** (hoy no existe; se elige en el contrato) | (a) no; (b) opcional, sugiere razón social/compañía al crear el contrato | **Decidido (Domi, 29-09): (a) no.** La compañía emisora se elige solo al crear el contrato, por la usuaria; la cotización no la guarda ni la sugiere |
| Q-A5 | **Eliminar**: físico (hoy) vs lógico | Lógico solo en `draft`/`sent`/`lost` sin vínculo (`deleted_at`), como C5 | Lógico; una SF borrada no debe "resucitar": se excluye del sync por `deleted_at` (Supuesto: requiere una línea en el sync) |
| Q-A6 | **Duplicar**: se quita (como en Contratos, S1-14) o se mantiene | Mantener: es la forma natural de re-cotizar (nuevo borrador, **sin** `quote_number` ni `salesforce_*`, `data_source = manual`) | Mantener |
| Q-A7 | **Panel de vendedores** y funnel cotización → contrato → facturas (Medios #9) | En Cotizaciones · en Reportes · en Clientes | Reportes, leyendo `invoices` (decisión 2 del mapa de Contratos); en Cotizaciones solo la conversión de la lista |
| Q-A8 | **Adjuntos / PDF / envío / firma** | Ver §1 🔲 | Fuera de la primera entrega; el modelo (`kind = sent/signed` con fechas) queda listo para colgarlos |
| Q-A9 | **`quote_type`** libre vs catálogo | Catálogo cerrado en código (`new_business · upsell · cross_sell · downsell · renewal · renegotiation · reactivation`) + etiqueta; el mapping SF apunta al código | Catálogo: quita las 3 grafías y alinea con las categorías de M1 |

## 5. Diseño v2

### 5a · Estados y transiciones

- **Guardado**: `quotes.quote_stage_id` (como hoy) y, con Q-A1, `quote_stages.kind`. Cambia solo por acción explícita (crear → `draft`;
  enviar → `sent`; marcar firmada → `signed` con `booking_date` obligatoria; marcar perdida → `lost` con motivo; crear/aplicar contrato →
  `contract_created`, **lo hace Contratos** en su transacción, como hoy). Etapas intermedias libres (Negociando, Modificada…) cuentan como
  `kind = 'draft'` o `'sent'` según lo que configure el holding (Supuesto: default `draft`).
- **Mostrado** (calculado al leer, nunca guardado): Borrador · Enviada · **Vencida** (Q-A2: `kind ∈ {draft, sent}` y `valid_until <
  hoy`) · Firmada · **Contrato creado** (si existe `contracts.quote_id` no borrado o un evento con `origin.quote_id`, **aunque el holding
  no tenga la etapa**: arregla Hanka sin tocar datos) · Perdida. La etapa configurada se muestra como chip secundario.
- **Transiciones válidas** (API, 409 si no): `draft ⇄ sent` · `draft|sent → signed` (ítems completos: producto del catálogo, precio > 0 o
  `PriceSpec` válido, inicio, plazo o fin, frecuencia, método; `booking_date`) · `draft|sent → lost` · `signed → sent` (destrabar; solo
  sin vínculo) · `signed → lost` (solo sin vínculo) · **nada sale de `contract_created`** ni entra a mano. Editar: `draft`, `sent`;
  `signed` → 409 `quote_signed_locked` (hoy igual, pero en la API); con vínculo → 409 `quote_has_contract`.
- Cada transición y edición deja un evento (§8 `quote_events`) con usuario, antes/después y motivo. Hoy no hay historial.

### 5b · Lista (`/lab/cotizaciones`, mockup 1d)

- **Cabecera**: "330 en total · 41 abiertas por UF 4.820 · conversión 62 % últimos 90 días". **Tarjetas que filtran** (una activa, con
  chip): Abiertas (`draft + sent`, con monto) · Enviadas · Firmadas sin contrato (**la cola de trabajo**: hoy 11/18 en QA) · Vencidas ·
  Perdidas 90 d. **Montos** (no filtran): Valor cotizado abierto y MRR cotizado por moneda del holding (conversión con las tasas del
  sistema como `totals` de Contratos; Supuesto). Conversión = `signed + contract_created` / (`+ lost`) cerradas en 90 días, no la
  fórmula actual firmadas/(firmadas+enviadas).
- **Pestañas** = filtro por estado mostrado: Todas | Abiertas | Enviadas | Firmadas | Perdidas (+ Vencidas dentro de Abiertas).
- **Columnas**: Nº (`quote_number` o correlativo, §8) · Cliente (+ país) · Tipo de negocio · Etapa (chip) · Vendedor · Monto (moneda) ·
  MRR (Σ `monthly_price` recurrentes) · Válida hasta · Booking · Origen (Salesforce/Manual, derivado de `salesforce_opportunity_id`) ·
  Contrato (link al 360 de contrato; también cuando fue aplicada) · Fecha · Contacto · Términos de pago · Ítems (n) · Creada por.
- **Búsqueda**: número, cliente (nombre o RUT sin puntos/guion), producto de cualquier ítem, oportunidad SF (mismo criterio que
  `GET /contracts`).
- **Filtros avanzados** (panel lateral, selección múltiple): los 14 del front viejo (`cotizacionesFilters.ts`: etapa, período de booking,
  cliente, país, vendedor, moneda, producto, valor, fechas de creación/cotización/booking, términos, origen, con contrato) + tipo de
  negocio, estado mostrado, válida hasta, ítems con precio medido, sin producto del catálogo, creada por.
- **Acción por fila** según estado (mockup: "Enviar", "Recordar", "→ Crear contrato", "Contrato C-0389 →"). **Masivas**: enviar, marcar
  firmada (pide booking por cotización o una para todas), marcar perdida (motivo), asignar vendedor, exportar, eliminar borradores.
  Todo en la API, una transacción por cotización, respuesta `{ updated, skipped[{ id, reason }] }`.
- **Vista rápida** (drawer) con ítems y totales, como Contratos; el 360 completo en su ruta.

### 5c · Cotización 360 (`/lab/cotizaciones/[id]`)

- **Encabezado**: número, cliente, tipo de negocio, chip de estado + etapa, línea de vida Borrador → Enviada → Firmada → Contrato creado
  (rama Perdida), **franja**: monto total y MRR en moneda, vendedor, contacto, booking, válida hasta, términos de pago, origen (SF con Id
  de oportunidad), creada/actualizada.
- **Pestañas**: **Resumen** (widgets: totales por frecuencia y método, primer período estimado por ítem, alertas: ítems sin producto,
  sin inicio, fin sin −1 heredado de SF, moneda del ítem ≠ cotización, términos no interpretables, cliente sin razón social, vencida) ·
  **Ítems** (tabla con modelo de precio y desglose `priceLine`, descuento, plazo, fechas, auto-renew, cuenta, custom fields) ·
  **Vínculos** (contrato creado o contratos donde se aplicó, con el evento y su delta de MRR; cliente 360) · **Historial** (eventos de
  §8; Documentos dentro cuando existan adjuntos, 🔲).
- **Acciones**: Editar · Duplicar · Enviar · Marcar firmada (booking) · Marcar perdida · **Crear contrato** (→
  `/lab/contratos/nuevo?cotizacion=<id>`, que ya llama `GET /contracts/from-quote/:id`) · **Aplicar a contrato existente** (→ selector de
  contratos Activo del cliente y `POST /contracts/:id/changes/preview` con `origin: quote`; S3-1/S3-3 los valida Contratos) · Eliminar
  (lógico). Las dos últimas solo en `signed`; "Crear contrato" oculto si ya hay vínculo (409 `quote_already_applied` de respaldo).

### 5d · Creación y edición (wizard, `/lab/cotizaciones/nueva` y `/[id]/editar`)

1. **Cliente y contexto**: cliente comercial (Combobox), contacto, vendedor (default: el del cliente si existe, Supuesto), **tipo de
   negocio** (catálogo Q-A9; default `new_business` si el cliente no tiene contratos activos, `upsell` si tiene: mismo validador de S3-3),
   fecha, válida hasta, moneda (default: la del último contrato del cliente o la del holding). Sin compañía emisora (Q-A4: se elige en el contrato).
2. **Ítems**: producto del catálogo obligatorio (nombre editable), tipo de ítem (master data del holding), unidad, cantidad, **precio**
   con el mismo control que Contratos (`standard` fijo con unitario mensual/anual y `price_entry_mode`, o `PriceSpec` con tramos/paquete/
   asientos/medido + métrica), descuento %, frecuencia, método, inicio, plazo en meses (o fin; el fin **siempre** `inicio + plazo − 1
   día`), recurrente, auto-renovación (propuesta), cuenta, custom fields. Vista previa en vivo con `POST /quotes/preview` (reusa el motor:
   línea por período, MRR, total, primer período). Importar desde plan (Pricing etapa 3, mockup 4c) llena esta tabla.
3. **Condiciones**: términos de pago **estructurados** (misma forma que `client_entities.payment_terms`; default el de la razón social
   principal del cliente; se guarda además el texto para el front viejo), 4 flags (`requires_references_for_billing` conectado al gate
   OC/HES cuando exista), notas.
4. **Revisión**: totales por moneda, MRR, Σ por frecuencia, avisos, y "Guardar borrador" / "Guardar y enviar".

Edición = mismo formulario; `PUT /quotes/:id` con `items[].id` (con id UPDATE, sin id INSERT, ausentes DELETE; ausente con vínculo →
409) en **una transacción**: los `quote_item_id` referenciados sobreviven. Recalcular en el servidor: `price`, `final_price`,
`monthly_price`, `billing_period_price`, `total_amount` (cierra Medios #4 de raíz y alinea los 95/103 desalineados al primer guardado).

## 6. API `quotes` (módulo nuevo `src/modules/quotes/`, `SupabaseAuthGuard` + `HoldingScopeGuard` + `@HoldingId()`)

| Endpoint | Cuerpo / query | Devuelve | Errores |
|---|---|---|---|
| `GET /quotes` | `page`, `limit` (≤ 500), `search`, `status[]` (mostrado), `stageId[]`, `clientId[]`, `sellerId[]`, `quoteType[]`, `currency[]`, `productId[]`, `clientCountry[]`, `origin` (`salesforce`/`manual`), `hasContract`, `validUntilFrom/To`, `bookingFrom/To`, `quoteDateFrom/To`, `createdFrom/To`, `amountMin/Max`, `sortBy` ∈ whitelist `QUOTE_SORT_FIELDS` (`quote_number, client_name, status, stage, seller, quote_type, total_amount, mrr, currency, quote_date, booking_date, valid_until, created_at, contract`), `sortOrder` | `{ data, total, currentPage, pages, limit, totals { quotes, open_amount_by_currency, mrr_by_currency, conversion_90d }, stages[] }` (contrato paginado de la casa) | 400 `errors[]` |
| `GET /quotes/:id` | — | 360: encabezado, `status`, `stage`, `items[]` con `pricing`, `links { contract, applied_to[] }`, `alerts[]`, `events[]` | 404 |
| `GET /quotes/form-options` | `clientId?` | clientes, contactos, vendedores, tipos de negocio, etapas, monedas, productos, tipos de ítem, unidades, métricas facturables, `payment_terms_default`, `suggested_quote_type` | — |
| `POST /quotes/preview` | `CreateQuoteDto` | ítems tarifados (`priceLine`), MRR, total, primer período, `warnings[]`; no escribe | 400 |
| `POST /quotes` | `CreateQuoteDto` = `{ client_id, client_contact_id?, seller_id?, quote_type, quote_date, valid_until?, currency, payment_terms?, payment_terms_text?, notes?, requires_* , items[{ product_id, product_name?, item_type, unit_of_measure?, quantity, unit_price? / annual_unit_price? + price_entry_mode, price?: PriceSpec, discount_value?, billing_frequency, billing_method, start_date, term_months, is_recurring, auto_renew?, auto_renew_term_months?, account?, custom_fields? }] }` | 360; etapa `kind = draft`; correlativo `quote_number` si no viene (§8) | 400 (espejo Zod en la BFF) |
| `PUT /quotes/:id` | `CreateQuoteDto` + `items[].id` | 360 | 409 `quote_signed_locked`, `quote_has_contract`, `item_linked_to_contract` |
| `POST /quotes/:id/duplicate` | `{ quote_date? }` | 360 nuevo (borrador, sin SF) | 404 |
| `POST /quotes/:id/transition` | `{ to: 'sent' \| 'signed' \| 'lost' \| 'draft', stage_id?, booking_date?, reason?, notes? }` | 360 | 409 `invalid_transition`, `items_incomplete` (+ `errors[]` por ítem), `booking_date_required`, `stage_kind_mismatch`, `quote_has_contract` |
| `POST /quotes/bulk-transition` | `{ ids (1–500), to, booking_date?, reason? }` | `{ updated, skipped[{ id, reason }] }` | — |
| `PATCH /quotes/bulk-settings` | `{ ids, seller_id? }` | idem | — |
| `DELETE /quotes/:id` · `POST /quotes/bulk-delete` | — / `{ ids }` | lógico (`deleted_at`) | 409 `quote_not_deletable` (signed/contract_created/vinculada) |
| `GET /quotes/:id/contract-targets` | — | contratos **Activo** del cliente con MRR, productos y moneda (insumo de "Aplicar a contrato existente") | 404 |
| `GET/POST /quote-stages` · `PATCH/DELETE /quote-stages/:id` · `POST /quote-stages/reorder` | `{ name, color, kind, position }` | etapas del holding | 409 al borrar con cotizaciones o etapa de sistema; `kind` único para `signed` y `lost` (`contract_created` admite varias) |
| `GET /quotes/:id/events` | paginado | historial | — |

**Costura con Contratos (sin duplicar lógica):** `GET /contracts/from-quote/:quoteId` y `POST /contracts` con `quote_id` quedan como
están (Contratos es dueño de la transacción que crea el contrato y marca `contract_created`); `GET /quotes/:id` expone `links.contract`
y `can_create_contract` / `can_apply_to_contract` (solo `signed` sin vínculo). Cuando exista `quote_stages.kind`, `markQuoteContractCreated`
busca `kind = 'contract_created'` antes que `lower(name)` (cambio de una línea en Contratos, compatible). `GET /clients/:id/quotes` se
mantiene y delega en el mismo servicio de lista con `clientId` fijo. La BFF (`app/api/cotizaciones/*`) valida con schemas Zod espejo y
reenvía `x-holding-id`; `quote_type` viaja como código y la UI muestra la etiqueta.

## 7. Funciones y triggers legacy

| Pieza | Qué hace hoy | v2 | Front viejo |
|---|---|---|---|
| `trg_quote_items_calculate_pricing` → `auto_calculate_pricing_fields` (compartido con `contract_items`) | Deriva `monthly_price`, `billing_period_price`, sincroniza anual ↔ mensual; **no** toca `price`/`final_price` | **Se mantiene**: v2 escribe los mismos valores explícitos y el trigger los recalcula igual (idempotente). Con `PriceSpec` no estándar, v2 escribe el mensual equivalente en `unit_price` (misma regla que Contratos §2f) | Igual |
| `trigger_create_quote_stages_on_holding_creation` → `create_quote_stages_for_new_holding` → `create_default_quote_stages_for_holding` | Seed de 7 etapas con nombres que ningún front usa | **Reemplazar el seed** por el set v2 con `kind` (Borrador, Enviada, Firmada, Perdida, Contrato creado) en el mismo asset (afecta solo holdings nuevos; los existentes se backfillean, §8) | Sin efecto (lee las etapas que haya) |
| `update_quote_stages_updated_at` | `updated_at` | Se mantiene | Igual |
| `inherit_auto_renew_from_quote_item` (en `contract_items`) | Hereda auto-renew tratando `false` como null | Ya costurado por Contratos (corrige tras el INSERT); el fix del trigger se hace en el switch de Cotizaciones (S1-5 diferido) | Igual |
| `apply_quote_downsell_to_contract` (RPC, 14 usos) | Downsell/renegociación desde cotización + `UPDATE quotes` a "Contrato creado" **sin holding** | **Se retira al switch** (ya reemplazada por `POST /contracts/:id/changes`, listada en mapa Contratos §5) | Igual hasta el switch |
| Policies `tenant_isolation_*_quotes`, `holding_access_quote_items`, `Users can … quote stages` | RLS por holding para el front viejo | Se mantienen; v2 escribe con `service_role` y valida holding en SQL (`WHERE holding_id = $n`) | Igual |
| `get_quotes_pipeline` (skill Claude, `quote-skills.ts`) | Pipeline para el agente | Pasa a leer el servicio de lista (mismo estado mostrado) | — |

Sin costura `sapira.writer` necesaria: ningún trigger de cotizaciones **pisa** lo que v2 escribe. Se fija igual por uniformidad.

## 8. Esquema aditivo (migración futura, nada se renombra ni se borra)

**Regla de Domi (esquema mínimo):** ninguna columna que duplique o se derive de datos existentes. Lo que antes iba en columnas
(`created_by`, `updated_by`, `sent_at`, `signed_at`, `lost_at`, `lost_reason`, `payment_terms_json`) se **deriva al leer**: la línea de
vida y los actores salen de `quote_events` (lateral `QUOTE_EVENTS_LATERAL`), `signed_at` es `booking_date` cuando la cotización está
firmada o con contrato, y la condición de pago estructurada sale del texto canónico de `payment_terms` (`parsePaymentTermsText`, que
reconoce todo lo que escribe `paymentTermsText`; texto no interpretable al guardar → 400). La API mantiene los **mismos nombres** de
campo en la respuesta. **Decidido por Domi (29-09):** la migración **no** crea la etapa "Contrato creado" en los holdings que no la
tienen (se retiró el bloque `PENDIENTE DECISIÓN DOMI`); Hanka sigue sin ella y sus firmadas con contrato se muestran "Contrato creado"
por el vínculo (§5a), y `markQuoteContractCreated` deja la cotización donde está con aviso en el evento. También decidido: la etapa
"Procesada previamente" (SimpliRoute; cotizaciones procesadas en el flujo anterior fuera de Sapira, el contrato nació con esa
cotización) se backfillea como `contract_created`, y como convive con "Contrato creado" en el mismo holding, `contract_created` **no**
entra en el UNIQUE parcial: solo `signed` y `lost` admiten una etapa por holding (el estado se deriva por kind, así que las dos cuentan
como contrato creado). `quotes.company_id` (Q-A4) se **decidió que no** (29-09) y se retiró de migración, entity, DTOs, servicios y
front: la compañía emisora se elige solo al crear el contrato.

| Cambio | Para qué | Nota |
|---|---|---|
| `quote_stages.kind` text CHECK (`draft · sent · signed · lost · contract_created`) NULL | Q-A1: contrato estable para API y KPIs | Backfill por nombre: `%firmad%` → signed, `%perdid%`/`%rechaz%` → lost, `%enviad%` → sent, `contrato creado` y `procesada/procesado previamente` → contract_created, resto → draft; UNIQUE parcial (holding, kind) solo para `signed` y `lost` (`contract_created` admite varias etapas). **No** se crea la etapa "Contrato creado" en los holdings que no la tienen (decidido Domi 29-09) |
| `quotes.valid_until` date | Q-A2 vigencia / "Vencida" | Sin backfill (NULL = sin vencimiento) |
| `quotes.deleted_at`, `quotes.updated_at` | Borrado lógico (Q-A5); hoy `quotes` no tiene `updated_at` | Trigger `quotes_set_updated_at` (nadie escribe `updated_at` a mano); el sync SF ignora `deleted_at IS NOT NULL`. **Sin** `created_by`/`updated_by`: el actor es el del evento `CREATED` / del último evento de `quote_events` |
| *(derivado, sin columna)* `sent_at`, `signed_at`, `lost_at`, `lost_reason` | Línea de vida y motivo de pérdida (conversión 90 d) | `sent_at` = último evento `SENT`; `lost_at`/`lost_reason` = último `LOST` (solo mientras está perdida); `signed_at` = `booking_date` si está firmada o con contrato. Sin backfill: las firmadas viejas ya tienen `booking_date` |
| *(derivado, sin columna)* `payment_terms_json` | Q-D4 estructurado | Se escribe solo el texto canónico en `payment_terms` (`paymentTermsText`: "30 días", "Contado", "Fin de mes + 15", "Día 5 del mes siguiente"); al leer, `payment_terms_json = parsePaymentTermsText(payment_terms)`; `fromQuote` lee lo mismo. Texto no interpretable en `payment_terms_text` → 400 `errors[payment_terms_text]` |
| `quotes.quote_number`: correlativo por holding para manuales (`COT-2026-0001`, Supuesto de formato) + UNIQUE parcial (holding, quote_number) | Hoy nulo o Id de SF; duplicar lo copia | Antes resolver duplicados en prod (dato, lo revisa Domi); el Id de SF sigue viviendo en `salesforce_opportunity_id` y `quote_number` conserva el valor actual |
| `quote_items.price_id` uuid FK `prices` NULL | Q-A3: `PriceSpec` inline (`owner = quote`, o `contract` reutilizado al crear el contrato) y catálogo en etapa 3 | `prices.owner` suma el valor `quote` (CHECK); `fromQuote` copia el precio al ítem del contrato |
| `quote_events` (id, holding_id, quote_id, type, from/to stage, actor, reason, metadata jsonb, created_at) + RLS por holding | Historial (§5a); hoy no existe | Tipos: `CREATED, UPDATED, SENT, SIGNED, LOST, REOPENED, DUPLICATED_FROM, CONTRACT_CREATED, APPLIED_TO_CONTRACT, DELETED` |
| `quote_types` como catálogo en código (no tabla) + `salesforce_quote_type_mappings.sapira_quote_type` apuntando al código | Q-A9 | Backfill de las 9 grafías de QA/prod a 7 códigos; la etiqueta vive en el front |

## 9. Preguntas para Domi

1. **Estados** (Q-A1): ¿etapas configurables con `kind` de sistema (recomendado) o estados fijos y se apagan las etapas por holding?
   ¿Las intermedias (Negociando, Modificada) cuentan como Borrador o como Enviada?
2. **Vigencia** (Q-A2): ¿modelamos "Válida hasta" con estado Vencida y recordatorio, y cuál es el default en días?
3. **Precio** (Q-A3): ¿`PriceSpec` (tramos, paquete, asientos, medido) en la cotización desde la primera entrega, o solo fijo mensual/anual
   y los tramos llegan con Pricing etapa 3?
4. **Compañía emisora en la cotización** (Q-A4): **decidido (29-09): no.** Sigue siendo decisión exclusiva del contrato; la cotización
   no guarda `company_id`.
5. **Alcance de la primera entrega**: ¿lista + 360 + crear/editar + transiciones + vínculo a contrato (propuesto), dejando fuera PDF,
   envío por correo, firma y adjuntos? ¿Kanban se retira?
6. **Número**: ¿correlativo por holding para las manuales (`COT-AAAA-NNNN`) manteniendo el Id de Salesforce como está, y quién resuelve los
   duplicados actuales?
7. **Eliminar y duplicar**: ¿borrado lógico solo sin vínculo, y duplicar se mantiene (nuevo borrador sin número ni datos de SF)?
8. **Conversión**: ¿KPI = firmadas + con contrato / cerradas (incluye perdidas) en 90 días, y "Firmadas sin contrato" como cola de trabajo
   principal de la lista?

## 10. Construido (28-09, código listo, sin aplicar)

Módulo `src/modules/quotes/` (`QuotesModule`, registrado en `app.module.ts`; `SupabaseAuthGuard` + `HoldingScopeGuard` + `@HoldingId()`).
Decisiones Q-D1..D11 respetadas. **Supuestos** aplicados de las abiertas (recomendación de §4, Domi confirma o cambia):

| # | Supuesto aplicado |
|---|---|
| Q-A1 | Etapas configurables con `quote_stages.kind` (`draft · sent · signed · lost · contract_created`); backfill por nombre ("Procesada previamente" → `contract_created`, Domi 29-09); intermedias sin kind = `draft`; UNIQUE parcial por holding para `signed` y `lost` (varias `contract_created` valen) |
| Q-A2 | `quotes.valid_until`; default = fecha + **30 días** (`DEFAULT_VALID_DAYS`), `null` explícito = sin vencimiento; estado mostrado `expired` y KPI `expiring_7d` |
| Q-A3 | `items[].price: PriceSpec` inline (mismo DTO y motor que Contratos, `prices.owner = quote`) **y** `items[].price_id` de catálogo (copia con `list_price_id`, etapa 3 ya construida en Contratos; mismas reglas: `catalog-prices.ts`); sin ambos = standard fijo. `fromQuote` copia el precio al contrato |
| Q-A4 | **Decidido: no** (Domi, 29-09). La cotización no guarda compañía emisora: sin `quotes.company_id`, sin `company_id` en `CreateQuoteDto`, sin filtro `companyId`, sin `companies` en `form-options`/`filter-options` ni `company` en filas/360. `GET /contracts/from-quote/:id` ya no devuelve `quote.company_id`; la compañía se elige en el formulario de contrato |
| Q-A5 | Borrado lógico (`deleted_at`) solo en `draft`/`sent`/`lost` sin vínculo; **pendiente**: una línea en el sync SF para ignorar `deleted_at IS NOT NULL` (no se tocó `salesforce-sync-complete.service.ts`) |
| Q-A6 | Duplicar se mantiene: borrador nuevo con correlativo propio, sin `salesforce_*`, sin booking, `data_source = manual`, `valid_until` = fecha + 30 |
| Q-A7 | Solo la conversión 90 d en la lista/KPIs; panel de vendedores fuera |
| Q-A8 | Fuera: PDF, envío, firma, adjuntos. `GET /quotes/:id` lista `documents[]` de `quote_attachments` si hay filas (0 hoy), sin subir ni bajar |
| Q-A9 | Catálogo en código (`QUOTE_TYPE_CODES`, 7 códigos + etiqueta): las nuevas guardan el código; las viejas se normalizan **al leer** (`normalizeQuoteType`, `Despliegue` → `new_business`) y el filtro cubre las grafías viejas. `quotes.quote_type` **no se reescribe** (el front viejo muestra el texto tal cual) |
| Otros | `quote_number` correlativo `COT-{año}-{NNNN}` con `pg_advisory_xact_lock` por holding y año; **sin UNIQUE** hasta resolver duplicados de prod. Conversión 90 d = (`signed` + `contract_created` por `booking_date`) / (+ `lost` por la fecha del último evento `LOST`). Montos de lista y KPIs **por moneda, sin conversión** (la cotización vive en su moneda). `lost → draft` se permite como reabrir (evento `REOPENED`). Descuento de ítem solo en % (los "Monto fijo" viejos se muestran y `form` los devuelve como `discount_fixed_amount` de solo lectura). Bulk (`bulk-transition`, `bulk-settings`, `bulk-delete`), `GET /quotes/:id/contract-targets` y `GET /quotes/:id/events` paginado **no** entraron en esta entrega (el historial va dentro del 360) |

### 10a · Esquema (una migración, entities primero, nada aplicado)

| Pieza | Dónde |
|---|---|
| `quote_stages.kind` + CHECK + UNIQUE parcial; `quotes.{valid_until, deleted_at, updated_at}` + 2 índices parciales; `quote_items.price_id` (FK `prices`); `prices.quote_id` (FK CASCADE) y `owner` suma `quote` (los dos CHECK de `prices` se recrean); tabla `quote_events` (RLS activado en la migración). **Sin** columnas derivadas (regla de §8): línea de vida, actores y `payment_terms_json` se calculan al leer. Sin `quotes.company_id` (Q-A4 decidido: no) | `entities/cotizaciones-catalogo/{quote,quote-stage,quote-item,quote-event}.entity.ts`, `entities/contratos/price.entity.ts`, migración `1790650000000-QuotesV2` (`.pending`) |
| **Datos** en la misma migración: backfill de `kind` por nombre (`signed`/`lost`: solo la primera por posición de cada holding; `contract_created` sin límite: "Contrato creado" y "Procesada previamente"). **Sin** creación de "Contrato creado" en los holdings que no la tienen (decidido Domi 29-09; bloque retirado). Sin backfill de fechas | idem |
| Assets: `rls/holding_access_quote_events.sql`, `triggers/quotes_set_updated_at.sql` (usa `set_updated_at()` existente), `functions/create_default_quote_stages_for_holding.sql` editada en su lugar (seed v2 con kind para holdings nuevos) | `src/databases/postgresql/` |
| Inventarios: `scripts/espejo/{existing-entities,module-map}.json`, `entities/espejo.existing.ts` (`QuoteEvent`); `pricing-v2.entity.spec.ts` actualizado (`quote_id`, FK e índice) | — |

Orden de despliegue: `1790630000000-CreatePricingV2` → `1790650000000-QuotesV2` → `postgres:assets --only` de los 3 assets → código. QA primero (`schema:status`).
Verificado en QA de solo lectura (28-09): los 3 holdings calzan el `ILIKE` (Recepcionado/Negociando/Recibido/Procesando/Modificada → draft; Enviada → sent; Firmada → signed; Perdido → lost; ninguno tiene "Contrato creado"), `quotes` no tiene triggers y no hay `quote_number` duplicado en QA. En prod, SimpliRoute tiene "Contrato creado" **y** "Procesada previamente": las dos quedan `contract_created` (por eso el UNIQUE parcial excluye ese kind).

### 10b · Endpoints (formas exactas para la BFF)

| Endpoint | Body / query | Devuelve |
|---|---|---|
| `GET /quotes` | `page`, `limit` (≤ 500), `status` (coma: `draft, sent, expired, signed, contract_created, lost, open, all`), `kind`, `stageId`, `clientId`, `entityId`, `companyId`, `sellerId`, `currency`, `quoteType` (códigos), `productId`, `clientCountry`, `origin` (`salesforce`/`manual`), `hasContract`, `validUntilFrom/To`, `bookingFrom/To`, `quoteDateFrom/To`, `createdFrom/To`, `amountMin/Max`, `search` (número, cliente, RUT de sus razones sociales, producto, oportunidad SF), `sortBy` ∈ `QUOTE_SORT_FIELDS` (`quote_number, client_name, status, stage, seller, quote_type, total_amount, mrr, currency, quote_date, booking_date, valid_until, created_at, contract, company_name, items_count`), `sortOrder` | `{ data: QuoteListRow[], items, pages, currentPage, limit, counts { all, draft, sent, expired, signed, contract_created, lost, open }, totals { quotes, by_currency[{ currency, quotes, total_amount, open_amount, mrr, open_mrr }], conversion_90d { won, lost, closed, rate } } }`. `QuoteListRow` = `{ id, quote_number, status, stage { id, name, color, kind, position }, quote_type (código), quote_type_label, client { id, name, country }, contact, seller, company, currency, total_amount, mrr, items_count, products[], quote_date, valid_until, booking_date, payment_terms, payment_terms_json, origin, salesforce_opportunity_id, contract { id, contract_number, status, relation: created \| applied } \| null, notes, sent_at, signed_at, lost_at, lost_reason, created_at, updated_at, created_by }` |
| `GET /quotes/summary` | — | `{ as_of, total, open, draft, sent, expired, expiring_7d, signed_without_contract, contract_created, lost, lost_90d, pipeline_by_currency[{ currency, open_amount, open_mrr, signed_amount }], conversion_90d }` |
| `GET /quotes/filter-options` | — | `{ stages[], statuses[{ value, label }], quote_types[{ value, label, used }], sellers[], currencies[], products[], client_countries[], contacts[{ id, name, client_id }], origins[] }` |
| `GET /quotes/form-options` | `clientId?` | `{ clients[], contacts[], sellers[], quote_types[], stages[], currencies[], products[{ …, catalog_prices }], item_types[], units_of_measure[], payment_terms_presets[], billable_metrics[], billing_frequencies[], billing_methods[], client { id, entities[], active_contracts } \| null, defaults { quote_date, valid_days, currency, payment_terms, suggested_quote_type } }` |
| `POST /quotes/preview` | `CreateQuoteDto` | `{ currency, quote_date, valid_until, payment_terms, payment_terms_text, items[{ item_key, …, unit_price, price, final_price, monthly_price, billing_period_price, end_date, pricing, priced }], totals { total_amount, mrr, one_time, by_frequency[] }, warnings[] }`; no escribe |
| `POST /quotes` | `CreateQuoteDto = { client_id, client_contact_id?, seller_id?, quote_type (código), quote_date?, valid_until?: string \| null, booking_date?, currency, payment_terms?: PaymentTerms \| null, payment_terms_text?, quote_number?, notes?, requires_multicompany?, requires_multicurrency?, requires_references_for_billing?, requires_contract_document?, items[{ key?, product_id, product_name?, account?, item_type, unit_of_measure?, quantity, unit_price? \| annual_unit_price? + price_entry_mode \| price?: PriceSpec \| price_id?, discount_value? (%), billing_frequency, billing_method, start_date, term_months, is_recurring?, auto_renew?, auto_renew_term_months?, custom_fields? }] }` | 360 (etapa `kind = draft`). 400 `errors[]`; 409 `code: quote_number_taken \| stage_kind_missing` |
| `GET /quotes/:id` | — | 360 = `QuoteListRow` + `{ client_contact_id, quote_stage_id, status_label, requires_*, totals { currency, total_amount, mrr, one_time, by_frequency[] }, items[{ id, product_id, product_name, account, item_type, unit_of_measure, quantity, unit_price, annual_unit_price, price_entry_mode, price, discount_type, discount_value, final_price, monthly_price, billing_period_price, billing_frequency, billing_method, start_date, end_date, expected_end_date, term_months, is_recurring, auto_renew, auto_renew_term_months, currency, custom_fields, quote_item_number, data_source, salesforce_line_item_id, pricing (resumen del precio o null), priced (PricedLine o null), contract }], links { contract, applied_to[], client }, alerts[{ code, severity, message, count? }], can_edit, can_delete, can_create_contract, can_apply_to_contract, events[{ id, type, from_stage, to_stage, from_kind, to_kind, reason, metadata, created_at, actor }], documents[] }`. Alertas: `items_without_product, items_without_start, items_end_date_off, items_currency_mismatch, payment_terms_unparsed, client_without_entities, expired, expiring_soon, total_mismatch, signed_without_contract` |
| `GET /quotes/:id/form` | — | `{ id, quote_number, status, editable, edit_blocker, created_at, form: CreateQuoteDto & { quote_type_raw, items[].id, items[].linked_contract, items[].discount_fixed_amount? } }` |
| `PUT /quotes/:id` | `UpdateQuoteDto` (= crear + `items[].id`) | 360. Ítems: con id UPDATE (el id sobrevive), sin id INSERT, ausentes DELETE. 409 `quote_signed_locked \| quote_has_contract \| quote_not_editable \| item_linked_to_contract (+ item_id)` |
| `POST /quotes/:id/stage` | `{ stage_id? \| kind?, booking_date?, reason? }` | 360. 409 `invalid_transition \| quote_has_contract \| items_incomplete (+ errors[{ field: items.N.<campo>, message }]) \| booking_date_required \| stage_kind_mismatch`; 400 `reason` al marcar perdida |
| `POST /quotes/:id/duplicate` | `{ quote_date? }` | 360 nuevo |
| `POST /quotes/:id/contract` | `CreateContractDto` (el de `POST /contracts`, armado con `GET /contracts/from-quote/:id`; `quote_id` se fija en la ruta) | Contrato 360 (delegado a `ContractDraftsService.create`). 409 `quote_not_signed \| quote_already_applied` + los de Contratos |
| `DELETE /quotes/:id` | — | `{ id, deleted: true }`. 409 `quote_not_deletable` |
| `GET /quote-stages` | — | `{ data[{ id, name, color, kind, position, is_system_stage, is_deletable, quotes_count }] }` |
| `PUT /quote-stages` | `{ stages[{ id?, name, color?, kind }] }` (lista completa y ordenada; ausentes se eliminan) | idem. 400 (`signed` o `lost` repetidos, sin `draft`, nombres repetidos, etapa ajena; varios `contract_created` valen); 409 `stage_in_use` |

Todos los 409 llevan `{ code, message }` (más `errors[]`/`item_id` donde se indica); los 400 llevan `message` + `errors[{ field, message }]`.

### 10c · Costura con Contratos (cambios mínimos y aditivos en `contract-drafts.service.ts`)

- `fromQuote`: deriva la condición de pago del texto (`parsePaymentTermsText(quote.payment_terms)`, ahora también "Día N del mes siguiente"), `stage_kind` (aviso "no Firmada" por kind), `qi.price_id` → `items[].price` (PriceSpec, copia al contrato como `owner = contract`); sin `quote.company_id` (Q-A4 decidido: no, la compañía se elige en el contrato); excluye borradas.
- `lockQuote`: excluye `deleted_at IS NOT NULL`.
- `markQuoteContractCreated`: busca `kind = 'contract_created'` antes que `lower(name)`; escribe solo `quote_stage_id` (`updated_at` lo pone el trigger, el actor va en el evento) y deja el evento `CONTRACT_CREATED` en `quote_events` (con `contract_id`, `contract_number`, `stage_updated`).
- `GET /clients/:id/quotes` no se tocó (sigue con su servicio; delegar en `QuoteListService` con `clientId` fijo queda para la BFF/switch).

### 10d · Verificación

Rework del esquema mínimo (29-09, sin commit, sin tocar la base): `tsc`, `eslint` y `jest src/modules/quotes src/modules/contracts` en verde
(26 suites, 556 tests; nuevos: round-trip formulario → texto → formulario de la condición de pago, `resolvePaymentTerms`, 400 por texto no
interpretable, lateral `ev` y `signed_at` derivado en `quote-list.service.spec`, `parsePaymentTermsText` con "Día N del mes siguiente").

`tsc`, `eslint` y `jest src/modules/quotes src/modules/contracts` en verde (24 suites, 483 tests; nuevos: `quote-status.spec` 9, `quote-items.spec` 5, `quote-list.service.spec` 8, `quote-stages.service.spec` 3, `quotes.service.spec` 20, `quotes.module.spec` 3). En `src/databases/postgresql` quedan en rojo solo los 4 tests previos a este cambio (`contract_items` vs snapshot de prod por `price_id` de Pricing v2 sin aplicar, y `holding_integration_settings` sin entity). El proceso local en `:8082` corre un `dist/` de las 22:33 (no se reinició ni se levantó otra instancia: el worker de Salesforce escribiría en la base): `GET /quotes`, `/quotes/summary`, `/quote-stages` → 401 y una ruta inexistente → 404; el cableado de DI de este código lo cubre `quotes.module.spec.ts`.

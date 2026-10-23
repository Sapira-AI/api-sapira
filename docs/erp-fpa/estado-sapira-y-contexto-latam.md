# Punto de partida: qué tiene Sapira hoy y qué ofrece la infraestructura LatAm

> Relevado el 19-10-2026 sobre `api-sapira` (149 entities, 129 tablas en `public`), `front-sapira`, Notion y fuentes públicas. Solo lectura. Índice: [README](README.md).

## 1. Lo que ya existe y sirve de base para el ERP

| Pieza | Dónde | Qué aporta al ERP |
|---|---|---|
| Tenancy holding → compañías | `company_holdings`, `companies` (moneda funcional, país, impuestos Odoo), `holding_settings` (`system_currency`), `HoldingScopeGuard` + `x-holding-id` | Multi-entidad y multimoneda ya resueltos; una compañía = una entidad legal con libro propio |
| Terceros | `client_entities` (RUT, razón social, país, términos de pago, `odoo_partner_id`) | Semilla de "contrapartes" (cliente y proveedor comparten RUT en LatAm) |
| Cuentas contables | `company_account_mappings` (5 cuentas por compañía: ingreso, no facturado, diferido, por cobrar, diferencia de cambio) | Único rastro de plan de cuentas: hay que crear el plan completo |
| Asientos | `GET /metrics/revenue/journal` genera al vuelo débito/crédito por compañía y mes; `journal_entries` planeada en `spec-tablas-por-modulo.md` §7, no construida | El devengo IFRS 15 ya produce asientos: será el primer subledger que postea al libro |
| Subledger de ingresos | `revenue_schedule_monthly` (RSM) en 3 monedas, reconstruible | Actuals de ingresos de primera clase para FP&A |
| AR, pagos, DSO | `invoices` (triple moneda, DTE, NC espejo), `invoice_payments` (nunca se borran, `settlement_reason`), aging, DSO, **proyección de cobros** (`billing-forecast.ts`) | Mitad del flujo de caja ya calculada (entradas) |
| Conciliación bancaria | `bank_movements`, `bank_upload_batches`, `bank_column_mappings`; motor determinista + fuzzy (1-1, 1-N, N-1, parcial), deshacer | Reutilizable para AP y tesorería: hoy solo concilia contra facturas de venta |
| Períodos | `accounting_period_cutoff`, `accounting_period_events`, period guard en triggers, permiso `CLOSE_PERIODS`, cierre FX mensual | Cierre contable: extender a bloqueo del libro |
| Presupuestos | `budgets` / `budget_lines` genéricos (kinds de ingresos y caja, escenarios base/optimista/pesimista, dimensiones total/compañía/vendedor/producto/segmento/mercado/cliente); migración `1790750000000-Budgets` escrita, **verificar si está aplicada** con `schema:status` | Se extiende a gasto y caja de salida sin rehacer el modelo |
| FX | `exchange_rates` (Banco Central, SUNAT), promedios mensuales, tasas por período y por contrato con `purpose`, `indicadores_economicos` (UF) | Multimoneda con FX volátil ya modelada |
| Integraciones | Adapter pattern (`erp`, `crm`, `stripe`, `datos`), staging con `raw_data` jsonb y `processing_status`, `field_mappings`, lector Odoo XML-RPC sobre `account.move` | Patrón para bancos, SII/RCV y migración; Odoo ya se lee |
| Facturación electrónica | DTE 33/34/56/61 nativo vía api-factura, SII config, CAF, certificados en Key Vault | Foso que ningún AI-native global tiene |
| Datos históricos | `invoices_legacy`, `mrr_legacy`, `onboarding_events`, import/adopt/revert con `import_batch_id` | Semilla del módulo de migración con tie-out |
| Notificaciones y agentes | `app_notifications` accionables, `ai_agents` (cron, aprobación), `ai_runs`, `ai_messages`, `claude_skills`, `rag_documents` (pgvector), copilot | Catálogo de acciones y aprobación humana ya diseñados (`spec-agentes-ia.md`) |
| Permisos | `PERMISSION_MODULES` VIEW_/EDIT_ por módulo, roles por holding, `CLOSE_PERIODS` | Cada módulo nuevo agrega su par VIEW_/EDIT_ |
| Front | Next.js 16, BFF `app/api/*`, laboratorio `/lab` con flag + `VIEW_LAB`, `components/ui`, data-table, 360, migas | Los módulos nuevos nacen en `/lab/<modulo>` y se publican con `switch-rutas-finales.md` |

## 2. Lo que no existe (brecha ERP)

Nada de: plan de cuentas completo, libro mayor ni asientos materializados, cuentas por pagar (proveedores, facturas recibidas, órdenes de pago), tesorería (posición de caja, flujo proyectado de salidas, conexión bancaria por API), impuestos (IVA, F29, retenciones), activos fijos, gastos anticipados, inventario, compras, nómina, consolidación con eliminaciones, multi-book, estados financieros, log de eventos tipado (`document_events` planeado), outbox ni cola de trabajo (BullMQ): los jobs son `@nestjs/schedule` en proceso y Mongo. Tampoco hay webhooks de salida, MCP ni API key pública (está en prioridades 4). Ningún repo corre tests en CI.

## 3. Deuda que conviene cerrar antes o durante la Fase 0

- **Seguridad**: `src/modules/odoo/README.md` tiene una API key de producción de Odoo en texto plano y commiteada (sección "Conexiones de Odoo Configuradas"); `inventario-integracion-odoo.md` menciona otra en `front-sapira-vite`. Tratarlas como comprometidas: rotar en Odoo y borrar del README. Pendientes ya listados para Leon: Swagger público en prod, 5 rutas `@Public()` del analizador de base de datos.
- **Tenancy fase 2**: ~25 controladores legacy (odoo, stripe, salesforce, bigquery, subscriptions) aún sin `HoldingScopeGuard` (`inventario-tenancy-fase-2.md`).
- **Snapshots de esquema**: los specs `*.entities.spec.ts` comparan entities contra el snapshot de prod; una entity nueva que no esté aplicada en prod rompe el espejo hasta que se aplique y refresque. Esto condiciona la estrategia de ramas (ver [roadmap](roadmap-erp-fpa.md) §3).
- **Migración `Budgets` y `BankReconciliationV2`**: confirmar con `yarn schema:status` que están aplicadas en QA y prod.

## 4. Infraestructura LatAm disponible (verificado 19-10-2026)

### Bancos
| Proveedor | Cobertura | Nota |
|---|---|---|
| **Fintoc** (CL) | Chile y México: movimientos, pagos, transferencias, cuentas empresa "agénticas" | Docs ahora detrás de login; Sapira ya lo nombra como integración de pagos. Primera opción para Chile y México. |
| **Belvo** (MX) | México, Brasil, Colombia: datos bancarios, categorización, gastos recurrentes, **datos fiscales (SAT)**, débito directo MX, Pix BR, MCP propio | Da el CFDI del SAT además del banco: fuente de AR/AP en México. |
| **Prometeo** (UY) | 9–11 países; cobertura de cuentas reportada: CL 63 %, CO 83 %, MX 100 %, PE 80 %, BR 95 % (sin fecha); pagos A2A | Candidato para Perú y Colombia. |
| **Pluggy** (BR) | Brasil Open Finance | Para Brasil cuando toque. |
| Cartolas (archivo) | Universal | Ya existe import con mapeo de columnas: sigue siendo ciudadano de primera clase. |

Regulación: Brasil con Open Finance obligatorio; Chile con el Sistema de Finanzas Abiertas **pospuesto a julio 2027**; Colombia obligatorio desde el Decreto 0368 (abril 2026); México estancado; Perú sin marco. Conclusión: adaptador por agregador + archivo, no apuesta a un solo proveedor.

### Facturación electrónica y datos fiscales
- **Chile (SII)**: DTE nativo ya en Sapira. Falta explotar el **Registro de Compras y Ventas** (facturas recibidas = AP esperado; emitidas = control) y la **Contabilidad Electrónica** (Res. 150/2005 y 86/2017: Libro Diario, Mayor y Balance en XML con firma; resoluciones 2026 autorizan a nuevos contribuyentes). Libros auxiliares electrónicos al día 10 (Res. 13/2021, verificar vigencia). F29 mensual como salida de caja de primera clase.
- **México (SAT)**: CFDI emitido y recibido vía PAC (Facturapi y similares) o vía Belvo fiscal; contabilidad electrónica (pólizas XML).
- **Colombia (DIAN)**, **Perú (SUNAT)**, **Brasil (NF-e)**: emisión por proveedor local (Alegra, Nubefact, Sovos, B2Brouter multi-país). Un proveedor multi-país como Sovos o Alegra API cubre la emisión; la recepción (AP) se toma del portal fiscal o del proveedor.
- **Ecuador (SRI)**: tiempo real desde enero 2026 (irrelevante hoy, muestra la tendencia).

### ERPs locales a migrar (Chile primero)
Defontana (el más usado en pymes, desde ~60.000 CLP/mes, quejas de costo y curva), Softland (medianas, costoso e implementación compleja), Nubox (contabilidad + SII + remuneraciones, desde 15 USD/mes, no es ERP completo), Manager, Laudus, Bsale (facturación; ahora de Siigo), Odoo (SimpliRoute, otros clientes de Sapira), SAP B1, KAME (TiMining; integración ya en prioridades). Fuentes de migración ordenadas por facilidad: Odoo (XML-RPC ya existe) → exportes Excel/CSV de Defontana, Softland, Nubox (balance de comprobación, mayor, maestros) → SII como árbitro (RCV y F29 históricos).

### Nómina y gastos
No construir: integrar Buk, Rankmi, Talana (nómina) y Rinde Gastos, Xpendit (rendiciones) como fuentes de asientos y de caja. Nota: Buk compró Bemmbo (tesorería) y lanzó "Buk Finanzas"; Siigo compró Bsale. Los dueños del canal pyme chileno se están moviendo a finanzas.

## 5. Lo que ya se dijo afuera (no contradecir)
En la reunión con Caravela (14-10-2026) Sapira presentó: "En noviembre partimos con Sapira ERP, el primer ERP nativo en IA de Latinoamérica, referente DualEntry; primero pymes y medianas, después corporate; dos clientes piloto de otras industrias". Mercado citado: ERP LatAm 2,8 B USD/año, pymes y medianas 1,1 B, SOM 11–33 M ARR a 3–5 años. Diferenciadores publicados en Notion (oct-2026): entregar el resultado con FDE, hecho desde finanzas, **camino por etapas hacia el ERP** ("partes ordenando tus ingresos y cuando quieras sumas la contabilidad"), emisión local en varios países. IFRS 18 no se usa como gancho.

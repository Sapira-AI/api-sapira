# Referentes ERP AI-native: Sintropix y DualEntry

> Ingeniería inversa hecha el 19-10-2026 con fuentes públicas (sitios, docs de API y MCP, prensa, reseñas). **(V)** = declarado por el proveedor; **(T)** = terceros. Sin registro en ninguna cuenta. Índice: [README](README.md).

## 1. Sintropix (sintropix.com) · Chile, YC Fall 2026

| Campo | Dato |
|---|---|
| Quiénes | Hermanos Alfonso (CEO, ex Director de Producto de Toku, YC S21) y Borja Márquez de la Plata (CTO). **2 personas.** Santiago; en SF por el batch. |
| Historia | Dic-2025 idea de logística; **abril 2026** arrancan como servicio contable para startups (4 clientes por referidos); pivote a producto tras feedback de YC; aceptados 28-08-2026; Demo Day 2-12-2026. Rechazados antes por Platanus, Start-Up Chile y YC. |
| Capital | Solo el deal estándar YC (500 k USD), aún no desembolsado al 19-10. |
| Clientes | **10 activos** (V) en Chile, México, Brasil y EE. UU. Meta: 15x antes del Demo Day. |
| ICP declarado | Empresas que "superaron el ERP local" (Defontana, Nubox, Softland) pero no están para NetSuite/SAP: **varias sociedades o países**, auditadas. Software, ecommerce/retail, servicios profesionales. Explícitamente no la pyme "que solo quiere pagar menos impuestos". |
| Módulos (sitio) | Libro mayor automático; multi-entidad con eliminaciones intercompany; multimoneda (transacción → funcional → reporte); **reconocimiento de ingresos desde el contrato** (lee el PDF, extrae 6 campos, identifica la obligación de desempeño, asienta y programa devengos); dashboard (caja consolidada, ARR, burn, runway, CxC/CxP); **cola de acciones** (conciliar, facturas por emitir, asientos por aprobar); **checklist de cierre**; reportes fijos (EERR, balance, mayor, flujo). |
| No aparece | Inventario, compras, activos fijos, nómina propia (integra Buk y Rankmi), AP/AR como módulos, aprobaciones configurables, facturación electrónica propia. YC dice que conecta a SII, SAT y Receita; el sitio no. |
| IA concreta | **Erwin**: "responde con tus datos, no con estimaciones" ("¿qué falta para cerrar?", "flujo a 13 semanas", "¿qué explica el cambio en burn?"). Matching banco ↔ factura y cuenta por historial, **y pregunta al usuario cuando no cuadra**. Extracción de contratos → asientos. "100 % operable por agentes" (conectar Claude o Codex al núcleo; sin doc pública de MCP ni API). |
| Integraciones | Bancos chilenos uno a uno (Santander, BCI, Chile, BICE, Itaú, BBVA), Mercado Pago, Global66, Mercury, Ramp; Buk, Rankmi; Rinde Gastos, Xpendit; HubSpot, Salesforce; Stripe. "+100 integraciones" con contador en 0. Fintoc no aparece (probablemente por debajo). |
| Precio | No publicado. Prensa: mensual **por número de integraciones y sociedades, sin fee de implementación**. Página `/servicios` (contabilidad tercerizada: conciliación diaria, cierre, impuestos, remuneraciones) **"desde 20 UF/mes"**. |
| Migración | **Nada descrito.** Signup de 3 campos. Ninguna mención a migrar desde Softland, Defontana, Nubox u Odoo. |
| Posicionamiento | "El ERP de finanzas AI-native para LATAM", "Al fin un ERP que vas a querer usar", "Tu flujo de caja listo, todos los días", "Pregúntale a tus finanzas". Sitio con enlaces placeholder (Nosotros, Seguridad, Estado, Trabaja con nosotros). |
| Debilidades | 2 personas, 10 clientes, sin caja hasta el flip; sin métricas de precisión ni de autonomía; sin docs, API, precio, seguridad (SOC 2) ni migración; modelo híbrido servicio + software todavía abierto. |

**Lectura para Sapira.** Es el competidor con el mismo discurso (multi-país, asistente, cierre continuo, rev rec desde contratos) y con prensa YC, pero sin producto profundo. Sapira ya tiene lo que Sintropix promete en ingresos (contratos, pricing, facturación, DTE nativo, devengo, 9.000 facturas reales); le falta el libro. Sintropix tiene el libro (al menos en el landing) y le falta todo lo demás.

## 2. DualEntry (dualentry.com) · Nueva York, Serie A 90 M USD

| Campo | Dato |
|---|---|
| Quiénes | Santiago Nestares (CEO) y Benedict Dohmen; vivieron una implementación de ERP fallida y una exitosa (9 meses, ~100 k USD). Oficinas Nueva York y Londres. ~40 personas al anuncio (oct-2025), ~90 (sep-2026, T). |
| Capital | Pre-seed 8 M (2024), **Serie A 90 M (oct-2025, Lightspeed y Khosla, con GV y Contrary)**. Valuación ~415 M post (T). |
| Clientes | "Miles de usuarios", desde 5 M USD de ingresos hasta cotizadas; "100 B USD en asientos"; 50+ países. Casos: Slash (600 M ARR con finanzas de 2 personas), Graphite (cierre 20 → 1 día), **Nelo (México, QuickBooks → DualEntry, cierre 8–10 → 3 días, conexión en 1,5 días)**, Obsidiam (6 entidades CH/UE), On Track Storage (43 locales, 6 entidades, 1 contador). |
| Módulos | **Core**: GL, AR, AP, Cash, Tax (IVA/GST 13.000 jurisdicciones, multi-registro por entidad), Órdenes de compra, **Órdenes de venta**, Conciliación, **Close Management**, Allocations, **Approval Workflows**. **Avanzado**: Rev Rec (ASC 606), Prepaid Amortization, Subscription Billing, Fixed Assets. **Plataforma**: consolidación multi-entidad, 180+ monedas, **Multi-Book (GAAP/IFRS/tax, "coming soon")**, Audit & Compliance, Reporting, **Planning & Budgeting**, Treasury, API/CLI/MCP. **No** listan inventario ni gastos (vía Ramp/Brex/Bill.com) ni nómina (Gusto). |
| IA | Chat y Q&A ("Accounting Intelligence"), resúmenes, reportes custom; matching bancario con excepciones; OCR de facturas que aprende de asientos previos; categorización pre-GL; copiloto que redacta asientos; anomalías antes de aprobar; flux commentary; eliminaciones intercompany automáticas; checklists de cierre generados. **Tasks (13-oct-2026)**: workspace donde agentes, excepciones y alertas generan tareas; agentes de cobranza, codificación y aprobaciones con audit trail propio. **MCP Server (ago-2026)**: 15 tools, OAuth 2.1, permisos por rol. **CLI** con recetas. **7 "Claude finance skills"** gratis (close-readiness, flux, muestreo de asientos con Benford, 13-week cash flow…). **Benchmark público** de modelos sobre tareas contables ("la IA aún falla 1 de 3"). |
| Migración (su cuña) | **"Datos en 24 h"**, live en 4–6 semanas, **0 USD de implementación**. Fuentes: NetSuite, Sage Intacct, SAP, Dynamics, QuickBooks, Xero. Proceso: **sandbox sembrado con los libros reales antes de pagar** → **tie-out** (balance de comprobación por período, roll-forward de utilidades retenidas, cuadre de subledgers AR/AP) → runbook de cutover hora a hora ejecutado por su equipo → go-live; migran registros vivos, no saldos (plan de cuentas, clasificaciones, terceros, ítems, histórico, adjuntos); parallel run para NetSuite. "CPA-led". |
| Integraciones | "13.000+" = conexiones bancarias (tipo Plaid) + 200+ integraciones de software. J.P. Morgan, Citi, HSBC, Revolut, Stripe, Gusto, BILL, Salesforce, HubSpot, Snowflake, Looker, Power BI. Partners Avalara, Ramp, Stripe, Bill.com. |
| API | Pública, OpenAPI 3.1, v2 actual; `X-API-KEY`; paginación offset (`limit` ≤ 100); 200 req/min; idempotencia; building blocks: adjuntos, **bank feed inbound**, cálculo de impuesto pre-factura, **e-invoicing con webhook** (`e_invoice_status`). Recursos: `/invoices` (`/send`, `/lines`, `/attachments`), `/sales-orders`, `/bills`… |
| Precio | **Quote-only, sin trial** (sandbox como sustituto). Tiers por **número de entidades**: DualEntry (≤ 3), Plus (≤ 20), Ultra (ilimitadas, SAML). "Usuarios ilimitados" con fee por usuario extra (contradicción en su FAQ). Incluye implementación, 13 roles, training, Slack/Teams dedicado. "Bastante caro" (Gartner). |
| Reseñas | G2 4,9 (120), Capterra 4,7, Gartner 4,7. **Quejas**: defectos en conciliación bancaria, features prometidas que no llegaron, migraciones que se alargaron a meses, documentación inmadura, curva para no técnicos, precio opaco. **Elogios**: UI "para contadores", consolidación, soporte CPA, implementación incluida. |
| GTM extra | **ERP Rescue Fund 6 M USD** (pagan lo que queda del contrato del ERP anterior); programa de partners (firmas contables con referral, co-billing y certificación; implementadores; PE/VC con precio de portafolio); páginas `/versus/` contra NetSuite, QuickBooks, Xero, Intacct, SAP, Dynamics; subreddit; benchmark como contenido. Narrativa: de "AI-native" a **"Agentic ERP"**. Admiten que NetSuite es mejor para manufactura, bodega y e-commerce pesado. |

## 3. Arquitectura y modelo de datos inferidos (DualEntry, vía MCP y OpenAPI)

- **Organización → Companies** (entidades legales) con moneda funcional y reglas fiscales propias; **un solo libro mayor** del que se derivan vistas por entidad y consolidadas (misma data, no copias). Permisos por entidad y por tipo de registro.
- **Maestros**: vendors, customers, **accounts**, companies, **items**, **classifications** (sus dimensiones: departamento, clase, ubicación), **terms**, **ownership** (estructura de propiedad para consolidar).
- **Records** con numeración por tipo (`JE-`, `BI-`, `IN-`, órdenes, pagos), `record_status` (draft → …), `approval_status` (el workflow puede devolver a draft), `payment_status`, `e_invoice_status`; `get_record_history` = audit trail por registro; `get_related_records` (pagos contra factura). **Solo lo posteado genera asientos.**
- **Subledgers**: AR, AP, bank feed (líneas de cartola + `list_bank_match_suggestions`), contratos de rev rec con schedule (`preview_contract_schedule` → `create_contract`), activos fijos con schedule de depreciación (preview → create), prepaids, allocations por plantilla.
- **Multi-entidad y multimoneda**: intercompany AR/AP posteado en ambas entidades a la vez; eliminaciones, traducción y CTA automáticos; tasas diarias; no realizadas al cierre; reporte en cualquier moneda. Multi-book como roadmap.
- **Cierre**: bloqueos de período e inmutabilidad **en la capa de persistencia**, no en la UI; checklist con adjuntos y responsables; Tasks como cola única.
- **Agentes como identidades**: proponen bajo su propio nombre en el audit trail; "approval is the posting event". Patrón MCP **draft → validate → aprobación humana → save**.

**Sintropix** (inferido del landing): entidades por país con moneda funcional; GL con estado **"Sin clasificar"** por línea (el matching deja la transacción en el mayor con cuenta pendiente, no fuera de él); cola de acciones = inbox de excepciones; contratos → obligaciones → devengos. Sin evidencia de dimensiones, aprobaciones, períodos bloqueados ni API.

## 4. Patrones AI-first (dónde está la IA y qué guardrails)

1. **Ingesta**: documento (bill, contrato, cartola) → **registro borrador**, nunca directo al libro. OCR que aprende de asientos previos.
2. **Categorización** de cuenta antes del GL, por historial; fallback explícito "pregunta cuando no cuadra" → la UX de la IA es una **cola de preguntas**.
3. **Conciliación** con sugerencias y excepciones. Es a la vez el punto más criticado de DualEntry: el matching es donde se juega la confianza.
4. **Cierre continuo** como narrativa; métrica de marketing = días de cierre antes y después.
5. **Q&A sobre el libro** con la misma promesa ("tus datos, no estimaciones"); prompts canónicos: qué falta para cerrar, 13 semanas de caja, explicar variaciones.
6. **Migración asistida por IA** (mapeo de plan de cuentas e histórico) con **tie-out determinista** y sandbox con datos reales: es la cuña comercial de DualEntry, no una feature.
7. **Agentes con aprobación**: "el agente lleva el trabajo, el humano lleva la firma"; autonomía por cuenta y por riesgo; identidad propia en el audit trail; controles en el modelo de datos para que apliquen igual a UI, API y agentes. Campfire añade umbrales de confianza ajustables.
8. **Apertura a agentes externos**: MCP con OAuth y permisos espejo del rol; **read tools amplias, write tools pocas y con validate previo**.
9. **Etiquetado epistémico** en los skills ("Supported / Hypothesis / Open"; "los flags son preguntas para tu contador, no conclusiones").
10. **El mismo outcome vendido por todos**: equipo de finanzas de 1 a 3 personas para 100–600 M ARR.

## 5. Pares, una línea cada uno

- **Campfire** (US, 100 M+ de Accel/Ribbit): rev rec y billing + agentes "Ember" sobre Claude, 400+ clientes, saca startups de NetSuite.
- **Rillet** (US, Serie C 100 M a 1 B, ago-2026): GL en tiempo real para SaaS, 600+ clientes, alianza EY.
- **Puzzle** (7.000 clientes, AI Close con humano) comprado por Accrual (sep-2026): consolidación del segmento firmas contables.
- **Digits** (~97 M): "libro mayor autónomo" contra QuickBooks.
- **Light** (Copenhague, Serie A 30 M): GL automatizado para multinacionales en hipercrecimiento.
- **Alegra** (CO/MX): 2,1 M usuarios, motor con GPT, "Agente IA Global", MCP solo lectura en México; GTM por contadores.
- **Siigo / Siigo Aspel** (CO/MX/PE/CL): "Siigo Fiscal" con IA ante el SAT, **compra de Bsale (Chile)** y 100 M USD para expansión.
- **Defontana** (CL): "Defontana IA Agéntico" (abr-2026): agentes de compras y personas, proyecciones automáticas, chat.
- **Nubox** (CL): asistente de Operación Renta desde 2024; sin anuncio agéntico 2026.
- **Cifrato** (CO, YC W25): agentes para firmas contables conectados a la DIAN, 270+ clientes, 1 M ARR en menos de 12 meses.

## 6. Brechas y oportunidades para Sapira

1. **Facturación electrónica por país es el foso que nadie AI-native cubre.** DualEntry tiene un building block genérico de e-invoicing; cero mención a DTE, CFDI, NF-e, DIAN o SUNAT. Sintropix lo promete en YC y no lo muestra. Sapira ya opera DTE nativo vía api-factura.
2. **Conectividad bancaria LatAm**: DualEntry presume 13.000 bancos (cobertura US/EU). En LatAm la cobertura real pasa por Fintoc, Belvo, Prometeo y Pluggy, más cartolas. El **Registro de Compras y Ventas del SII** y el CFDI del SAT son datasets de AR/AP que los players US no tienen.
3. **Impuestos locales como primera clase**: IVA con F29 y propuesta de declaración, retenciones, PPM, boletas de honorarios, tributario vs IFRS pymes (multi-book que DualEntry aún no tiene), UF/UTM como moneda indexada.
4. **Español-first con trazabilidad al asiento y al DTE**: Erwin y Accounting Intelligence son un "Pregúntale a tus finanzas"; la diferencia está en responder con la fuente.
5. **Migración con tie-out verificable contra el SII** (RCV y F29 históricos): nadie lo ofrece y el cliente puede comprobarlo. "Datos históricos" de Sapira es la semilla.
6. **Canal contador**: todos lo construyen; Sintropix arrancó haciendo la contabilidad (20 UF). En LatAm, servicio + software es la puerta. Sapira ya tiene multi-holding por `x-holding-id`.
7. **Agentes con aprobación dentro del ERP + MCP**: estándar emergente que coincide con el roadmap de Sapira (Automatizaciones + Slack/Teams → agentes → MCP).
8. **Precio publicado por sociedad y documentos, implementación incluida**: contraste directo con DualEntry y con el "desde 20 UF" ambiguo.
9. **Segmento abierto con inventario** (retail, distribución, agro): DualEntry y Sintropix no lo tocan; sigue en Defontana, Softland y SAP B1. Hueco grande, pero exige inventario y compras.
10. **Riesgo directo**: Sintropix por discurso y prensa; DualEntry si entra a LatAm será por México y fintechs con matriz US, no por Chile.

## 7. No encontrado
Sintropix: precio concreto, docs, API, MCP, seguridad, integraciones reales, proveedor de SII/SAT, onboarding. DualEntry: precios en USD, headcount oficial, lista completa de recursos de la API v2, webhooks generales, países de e-invoicing, el término "Clone" (no existe en su sitio), inventario y gastos como módulos.

## Fuentes principales
sintropix.com (home, /servicios, /crear-cuenta) · ycombinator.com/companies/sintropix · df.cl (hermanos ingenieros en Y Combinator) · ecosistemastartup.com · enter.co · startupjournal.io · pitchbook.com · dealroom.co · dualentry.com (home, /funding-announcement, /pricing, /implementation-and-migration, /scale/*, /core-financials/*, /versus/*, /partners, /rescue, /api, /benchmarks, /builders/the-agentic-erp, /claude-finance-skills, /customers/nelo, blog MCP y Tasks) · docs.dualentry.com (guides, MCP, OpenAPI v2, migration-overview) · prnewswire.com y accountingtoday.com (Serie A) · tracxn.com · rfp.wiki, getapp, gartner (reseñas) · campfire.ai · techcrunch.com (Campfire) · fintech.global y pulse2.com (Rillet) · 01net.it (Accrual compra Puzzle) · globenewswire.com (Digits) · atomico.com (Light) · portafolio.co (Siigo compra Bsale) · portalerp.com y revistaeconomia.com (Defontana agéntico) · descubre.vc (Siigo Fiscal) · latamlist.com y forbes.co (Cifrato) · blog.nubox.com · contxto.com.

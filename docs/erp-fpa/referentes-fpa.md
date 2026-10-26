# Referentes FP&A: Aleph, Abacum y herramientas de caja

> Ingeniería inversa hecha el 19-10-2026 con fuentes públicas (sitios, prensa, reviews de terceros). **[v]** = dicho por el proveedor; **[3p]** = terceros. Sin acceso a docs técnicas ni a cuentas de prueba: el modelo de datos de la sección 3 es inferido. Índice: [README](README.md).

## 1. Aleph (getaleph.com)

| Dato | Valor |
|---|---|
| Origen | YC S21, HQ Nueva York; fundadores argentinos (Albert Gozzi, ex CFO; Santiago Pérez De Rosso, CTO). Contrata en LatAm. |
| Capital | Seed 5,2 M (Khosla) → Serie A 11,5 M (Bain Capital Ventures, 2023) → **Serie B 29 M (Khosla, sep-2025)**; total 46 M USD [v]. |
| Clientes | Zapier, Notion, Y Combinator, Harvey, Chess.com, Turo, Envoy, **Rappi** (único LatAm), Graphite Financial y Rooled (firmas de CFO fraccional). G2 4,9. |
| Tesis | **Planilla como front-end, Aleph como capa de datos gobernada.** No reemplaza el modelo del cliente: le pone una base de datos debajo con add-ins bidireccionales Excel/Sheets. |
| Datos | "150+ conectores": ERP (NetSuite, QuickBooks, Xero, Sage Intacct, Rillet, Campfire), HRIS/ATS (BambooHR, ADP, Rippling, Greenhouse), CRM (Salesforce, HubSpot), Stripe, Ramp, DWH (Snowflake, BigQuery, Databricks). **Sin bancos** ni ERPs LatAm. Conector nuevo "en 48 h". |
| Modelo | Tablas Actuals / Budget / BvA; versiones de forecast que corren contra actuals; repositorio de escenarios; dimensiones compartidas entre tablas; tablas calculadas; checks de calidad con alertas a Slack; SQL con IA. Headcount = Current + Hiring Plan + Assumptions. Los drivers viven en la planilla del cliente. |
| IA | **Scan** (análisis de variación con driver por dimensión, su feature más madura), AI mappings, **Aleph Agent** en web/Slack/Teams con fuentes citadas, **MCP público** (mcp.getaleph.com), **Agentic Budgeting** (2026): agentes arman la línea base por dueño de presupuesto y recolectan inputs en Slack. Regla: "los agentes razonan probabilísticamente; todo lo que se escribe pasa checks deterministas". |
| Precio | No publicado. ACV estimado 20–40 k USD/año + implementación [3p]. Free trial completo. |
| Implementación | "Misma semana" a "menos de 3 semanas" [v]; 4–8 semanas con 1–2 FTE de finanzas [3p]. |
| Debilidades | Consolidación básica, lentitud con datasets grandes y refresh de Sheets, setup del add-in, dashboards limitados, puede exigir SQL [3p]. |

## 2. Abacum (abacum.ai)

| Dato | Valor |
|---|---|
| Origen | Barcelona 2020 (Julio Martínez, Jorge Lluch), YC; HQ Nueva York. |
| Capital | **Serie B 60 M USD (jun-2025, Scale Venture Partners)**; total > 90 M. "500+ clientes en 40 países" (oct-2026). Único FP&A nuevo aceptado en Built for NetSuite en una década [v]. |
| Clientes | PostHog, CoreWeave, Strava, Replit, BetterUp, Kajabi; históricos españoles Typeform, Cabify, Ebury. Sin evidencia LatAm. G2 4,8. |
| Tesis | App-first "finance-owned, not expert dependant": planning por drivers, budgeting colaborativo con dueños de presupuesto, escenarios, headcount, revenue planning, P&L/BS/CF desde actuals vivos, roll-ups multi-entidad con FX simple. Excel/Sheets como válvula de escape, no como modelo. |
| Modelo | "Dimension-based, not template-based"; **Versions** (snapshots: Budget FY26, Reforecast Q2) y **Scenarios dentro de una versión**; "Spaces" por stakeholder; overrides de actuals con trazabilidad; ledger completo de cambios. Límite práctico: menos de 7 dimensiones [3p]. |
| IA | **Abacum Intelligence** (abr-2026): Modeling (AI Modeler, Formula Builder), Scenario (Goal Seek, sensibilidad, AI Forecasting), Context (clasifica cuentas nuevas y marca anomalías sin prompt), Narrative (AI Summaries), Workflow. **Modeler** (13-oct-2026): prompt o Excel → blueprint → variables propuestas → aprobación; "nada se guarda sin aprobación; el motor determinista hace la matemática". |
| Integraciones | ERP: Acumatica, D365, Exact, Light, NetSuite, **Odoo**, QuickBooks, Rillet, Sage, SAP, Xero; 34 HRIS (incluye Factorial, Sesame); Chargebee, Maxio, Stripe, Ramp; Salesforce, HubSpot; DWH. **Sin bancos** ni facturación electrónica. |
| Precio | Mediana 36,9 k USD/año (Vendr), rango 24–110 k; implementación incluida en año 1 [3p]. |
| Implementación | 4–6 semanas [v]; 4–8 fundacional, 12–16 completa [3p]. |
| ICP | 50–500 M USD de ingresos, Serie B a pre-IPO, equipo de finanzas 3–30. Mal fit: < 10 M ARR, consolidación estatutaria. |

## 3. Modelo de datos FP&A inferido (común a Aleph, Abacum, Runway, Agicap, Trovata, Tesorio)

**Hechos**
- `actuals`: línea de libro mayor o transacción (fecha, cuenta, entidad, dimensiones, monto en moneda origen y en moneda de reporte, id externo). Overrides solo con trazabilidad.
- `plan`: mismo grano (cuenta × dimensiones × mes) identificado por **version** (snapshot inmutable) y **scenario** (rama dentro de la versión que hereda del base hasta congelarse).
- `variance`: derivada (actual − plan) por versión, con comentario de IA y drill a la transacción.
- Grano temporal: **mes** en FP&A; **día o semana** en caja (13 semanas en Agicap y Tesorio, diario en Trovata).

**Dimensiones**: entidad legal, departamento, centro de costo, cuenta (jerarquía del plan de cuentas → plan gerencial), producto, cliente, región, proveedor, proyecto. **Mappings como objeto de primera clase**: la IA sugiere, el humano aprueba, se aplica a datos nuevos.

**Drivers y asunciones**: tabla centralizada (impuestos, cargas, FX, DSO/DPO, churn, precio) referenciada por fórmulas. **Headcount como objeto propio**: empleados actuales (HRIS) + posiciones planificadas (rol, área, fecha de inicio, banda, estado de aprobación) + cargas → líneas de gasto y de caja.

**Capa de caja** (Agicap, Trovata, Tesorio: lo más cercano a lo que Sapira quiere primero)
- `bank_accounts` y `bank_transactions` (fecha, monto, contraparte, glosa, saldo) por API o archivo; categorización por reglas + IA; match a facturas 1:N y parciales.
- **`expected_flows`**: cada fila proyectada tiene origen (factura AR/AP, recurrente detectado, presupuesto, préstamo, impuesto), fecha esperada, monto, categoría, **confianza** y **método** (vencimiento, promesa de pago, promedio de días por contraparte, predicción ML). Tesorio predice fecha de pago por factura con ~100 features y recalibra contra cobros reales.
- `forecast_version` guardada como línea base para medir precisión semana a semana (Trovata).
- Reconciliación transacción bancaria ↔ factura ↔ asiento (Agicap "journal posting").

## 4. Patrones de IA y guardrails (copiar tal cual)

| Dónde | Aleph | Abacum | Caja |
|---|---|---|---|
| Generar modelo | No (baseline por dueño vía agentes) | Modeler: prompt/Excel → blueprint → aprobación | Smart templates (Runway) |
| Mapping y limpieza | AI mappings, checks | Clasifica cuentas nuevas, anomalías | Auto-categorización bancaria |
| Explicar variación | **Scan** | Narrative Intelligence | Varianza de forecast vs real |
| Q&A | Agente en Slack/Teams + MCP | Dentro del modelo | Agicap y Tesorio: chat + MCP |
| Forecast sugerido | Varios algoritmos | Aceptar u override, Goal Seek | Fecha de pago por factura |
| Workflow | Recolecta inputs en Slack | Rutea tareas | Agente de cobranza lee respuestas y extrae promesas |

Guardrails recurrentes: (1) probabilístico afuera, determinista adentro; (2) nada se guarda sin aprobación y se muestra el diff; (3) el agente hereda los permisos del usuario; (4) trazabilidad por celda con fuentes clicables; (5) ledger de cambios con autor y motivo; (6) los datos no entrenan modelos; (7) "IA entrenada en lógica financiera" como copy.

## 5. GTM observado

- **Cuña**: Aleph entra por reporting/BvA sobre la planilla existente (valor en días); Abacum por budgeting colaborativo; Runway por runway y escenarios; Agicap/Trovata/Tesorio por **caja** (saldos consolidados → 13 semanas → AR/AP). Nadie en FP&A puro entra por caja y nadie en caja hace presupuesto completo: el hueco es **"cash-first FP&A"**.
- **Comprador**: CFO firma, FP&A lead o controller es el campeón; HR y RevOps amplían seats.
- **Precio**: casi todos quote-only (20–75 k ACV). Publicado: Trovata (base 24 k/año por banco y volumen), Jirav (canal de estudios contables, 50–150 USD/mes por cliente final, marca blanca), Drivepoint (449 USD/mes). Seats ilimitados para dueños de presupuesto (Runway).
- **Implementación como arma**: Aleph días, Abacum/Runway 4–6 semanas, Pigment 6–10, Anaplan 3–6 meses. El cuello de botella declarado por todos: validar datos contra la fuente.
- **Canal**: firmas de CFO fraccional y estudios contables (Aleph, Jirav). Replicable en LatAm.
- **Consolidación del mercado**: Mosaic → HiBob ("Bob Finance"), Causal → Lucanet, **Bemmbo → Buk (ago-2025, ~6 M USD) → "Buk Finanzas" en Chile**. El FP&A/tesorería SMB se absorbe dentro de plataformas con distribución. El análogo para Sapira: caja y presupuesto nativos del order-to-cash.
- **Convergencia 2026**: todos ofrecen MCP o agente para operar desde Claude/ChatGPT/Slack. "La planilla y el chat son las UIs; la app es el backend gobernado".

## 6. Qué copiar, saltar y hacer distinto en LatAm

**Copiar**: capa de datos gobernada con mappings aprobados; tablas actuals/plan(version, scenario)/variance con drill; objeto de flujo esperado con origen, confianza y método; predicción de fecha de pago por cliente (Sapira ya ve el historial de cobros); Scan de variaciones como primer feature de IA; headcount como objeto; guardrails de la sección 4; free trial sobre los datos del prospecto; canal de estudios contables; MCP propio.

**Saltar por ahora**: motor multidimensional propietario tipo Abacum/Pigment (meses de ingeniería, lentitud, curva); consolidación estatutaria, eliminaciones intercompañía, multi-GAAP; add-in Excel bidireccional complejo (sync a Sheets programado + export bastan); Agentic Budgeting en Slack como primera capacidad (el presupuesto de la pyme LatAm es anual y simple; la caja es semanal y dolorosa).

**Hacer distinto (ventajas estructurales LatAm)**
1. **La factura electrónica como fuente de verdad de AR y AP**, no el ERP: SII, SAT/CFDI, DIAN, SUNAT y NF-e entregan el 100 % de facturas emitidas y **recibidas** con RUT/RFC, fechas y montos, antes de contabilizarlas. Ningún competidor global lo tiene; Xepelin y Chipax lo usan en Chile.
2. **Conectividad bancaria realista por país**: Brasil con Open Finance obligatorio; Chile con el Sistema de Finanzas Abiertas pospuesto a **julio 2027** (hoy Fintoc, scraping y cartolas); México con la Ley Fintech estancada (Belvo con SAT y bancos); Colombia con el Decreto 0368 de abril 2026 que vuelve obligatorio el open finance; Perú sin marco. Diseño: adaptador por agregador (Fintoc, Belvo, Prometeo) + **importación de cartolas como ciudadano de primera clase** con categorización por IA.
3. **Multimoneda con FX volátil**: cada hecho con moneda origen, tasa y fecha; UF, UDI e índices como monedas indexadas; escenarios de FX como driver explícito; sensibilidad de caja.
4. **Crédito informal y de corto plazo como flujos de primera clase**: factoring y adelanto de facturas, sobregiro, mora habitual de proveedores a 30/60/90, anticipos de clientes, cuotas de impuestos. "Vencimiento ≠ fecha esperada" con distribución por contraparte.
5. **Impuestos como categoría nativa de caja**: IVA débito y crédito desde la factura electrónica, retenciones (Colombia, Perú), PPM (Chile), ISR provisional (México). Mueven 10–20 % de la caja mensual de una pyme.
6. **Español nativo, sin marcas y ERPs locales**: Odoo (Abacum lo tiene), Defontana, Softland, Nubox, Bsale (Chile); Contpaq, Aspel (México); Siigo, Alegra (Colombia); Omie, Bling (Brasil).
7. **Entrar por caja, no por presupuesto**: "cuánto tengo, cuánto entra, cuánto sale, cuándo me quedo sin caja". El presupuesto se construye desde el forecast de caja y los contratos (ingresos ya comprometidos en Sapira), no al revés.
8. **Precio publicado por entidad y volumen**, no por seat ni quote-only de 30 k USD.

## 7. No encontrado
Precios oficiales de Aleph y Abacum; documentación técnica de ambos; reviews de G2 (bloqueadas); clientes LatAm de Abacum; método de flujo de caja de Abacum; sitio de Trovata (bloqueado); Finvero y Treinta sin fuentes útiles en 2026.

## Fuentes principales
getaleph.com (home, /integrations, /platform/*, /solutions/*, /blog/series-b, /agentic-budgeting, /answers/top-fpa-software-2026, mcp.getaleph.com) · cfoshortlist.com/vendors/aleph y /abacum · drivepoint.ai/post/aleph-alternatives · abacum.ai (home, /product/*, /use-cases/*, /newsroom/*) · vendr.com/marketplace/abacum · metapraxis.com/abacum-implementation-cost · openvalegroup.com (deep dive Abacum) · tech.eu (Serie B Abacum) · agicap.com · trovata.io/pricing · tesorio.com · hibob.com (compra de Mosaic) · lucanet.com (compra de Causal) · descubre.vc/bemmbo · df.cl (planes de Fintoc 2026) · latinia.com (mapa regulatorio open finance LatAm 2026) · open-conversations.org (postergación SFA Chile a julio 2027) · facephi.com (open finance Colombia).

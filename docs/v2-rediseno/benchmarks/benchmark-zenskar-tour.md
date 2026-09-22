# 🎥 Benchmark — Zenskar product tour (3 videos Jam, analizados 2026-08-21)

> Fuente: las 3 grabaciones de Domi del tour de Zenskar (jam.dev). Complementa el informe del agente sobre docs.zenskar.com (`01-benchmark-zenskar-docs.md`).
> Visión declarada de Zenskar: _"99% del billing, revenue recognition, collections, reporting y cierre debería correrlo una máquina"_ — plataforma "AI-native" con agentes.

## 🧭 Módulos (navegación completa vista en el tour)

Analytics · Customers · **Metering** · Contracts · Invoices · Payments · **Accounting** · Communications · **Entitlements** · Monitoring · Integrations.

## 1. Contracts Agent (ingesta de contratos con IA)

- Subes el **PDF del contrato firmado** → el agente lo lee en tiempo real, identifica pricing, términos comerciales, y **crea el contrato en Zenskar** (demo con contrato "complejo": suscripción + usage por API calls + texto legal).
- Motions: sales-led (contrato firmado) y product-led (suscripción web).
- Entrada alternativa: CRM (HubSpot/Salesforce), API, o **carga masiva CSV** de contratos.
- 💡 Para Sapira v2: nuestra entrada hoy es Salesforce/cotización (mejor estructurada), pero la ingesta de PDF con IA es una idea potente para onboarding/legacy (donde Relvo y Zenskar subestiman el desorden real de la data).

## 2. Pricing (visto en el editor de precio del contrato)

- Modelos cambiables por línea: **Flat Fee · Per Unit · Tiered · Percent · Matrix (por dimensiones con alias)**.
- Por precio: moneda (cambiable USD→CAD en el acto), **descuentos, mínimos (commitments), free units, usage grants/créditos, tax** (integración Avalara para cálculo por geografía).
- Usage por precio: **Fixed o Metered** (elige la métrica, ej. "Count of Successful API Calls"); cadencia **Recurring o One-time**.
- 💡 El precio vive EN la línea del contrato apuntando a un modelo + métrica — no como N ítems paralelos (nuestro workaround actual de tramos).

## 3. Usage / Metering

- **Data sources**: API idempotente, CSV, o **conexión directa a la base del cliente** (PostgreSQL, MySQL, "100+ conectores" a DB/DWH) con flags de sync/agregación → Zenskar jala data cruda.
- **Eventos crudos** por meter (tabla con `data.id`, `data.quantity`, `timestamp`, customer).
- **Billable Metrics**: transforman eventos en cantidad facturable vía **Visual Builder** (columna + SUM/COUNT/MIN/MAX + filtros) o **SQL Builder** con preview.
- 💡 Sapira ya tiene la mitad de esto con BigQuery/DWH → la tabla `quantities`; falta formalizar el concepto "métrica de cobro" (hoy la agregación vive en el DWH del cliente).

## 4. Invoices y Payments

- Factura generada automáticamente del contrato; **editable antes de enviar** (cantidad, precio, usage/entitlement quantity); plantilla customizable (logo, líneas, service periods).
- Pagos: gateways (Stripe, Adyen) + **pagos offline registrados a mano** (transferencia/cheque/efectivo/tarjeta), por interfaz, planilla o API; reconciliación → paid/partially paid.
- 💡 Mismo patrón nuestro (registro manual + conciliación); ellos suman gateway nativo.

## 5. Accounting / Revenue Recognition (lo más valioso del tour)

- Concepto central: **Performance Obligations** (ASC 606 / IFRS 15) por contrato, con tipos de revenue (**Usage Based, Straight Line**…).
- Por obligación: satisfacción **point-in-time u over-time**; distribución **equally by days / by months / by usage / by entitlements**; para períodos cerrados con ajustes: **front-load / straight-line / back-load**; y **override manual del schedule** ("control total").
- **Revenue Rule Library**: reglas con filtros (por producto, por pricing model) → cuenta contable de revenue + método de distribución → **journal entries** automáticos.
- Zenskar se declara **revenue sub-ledger**: revisas asientos y los empujas al GL (NetSuite, QuickBooks, Xero, Zoho); soporta **GL distinto por entidad**.
- 💡 Sapira v2: nuestro RSM ya hace devengo real; lo que Zenskar agrega como diseño: (a) la obligación de desempeño como entidad explícita entre ítem y schedule, (b) reglas de reconocimiento como LIBRERÍA con filtros (nuestra tabla `revenue_rules` existe vacía), (c) métodos de distribución nombrados, (d) sub-ledger con push al ERP (nosotros ya generamos asientos + mapeo de cuentas por razón social).

## 6. Communications / Collections (dunning)

- **Email templates** por intención: factura, payment reminder, usage report, receipt.
- **Dunning configurable por segmento de cliente** (ej.: cadencias distintas US vs UK) — workflows de cobranza completos, no solo recordatorios.
- **Usage Alerts**: umbral (ej. 90% del límite) → email de upsell al cliente **o webhook** para que CS aprovisione/desaprovisione acceso según pago/uso.
- 💡 Nuestro agente de cobranza ya tiene niveles por vencimiento y aprobación humana; falta el concepto "workflow por segmento" y las alertas de consumo.

## 7. Customer Portal

- El cliente final entra y ve: **facturas, pagos, entitlements, usage reports**; gestiona medio de pago, paga, cambia suscripción.
- **Embebible en el producto del cliente vía API** y personalizable a su marca.
- 💡 Nosotros tenemos `PersonalizacionPortal` comentado y cero portal — decidir si v2 lo contempla en el modelo (aunque no se construya el día 1: el modelo de datos debe permitir "el receptor ve sus documentos").

## 8. Agentes (taxonomía de Zenskar)

- **Migration agent**: ingesta de contratos (PDF→contrato).
- **Actions agent**: interfaz tipo Perplexity, desde la plataforma o **Slack** — "¿facturas vencidas sobre $2.000?", "contratos que vencen en 30 días", emite NC, reconcilia pagos.
- **Insights agent**: analytics en lenguaje natural (MRR trend, breakdown por producto/segmento/geografía) con gráficos cambiables (bar/line/stacked/pie) y recomendaciones.
- 💡 Mapeo directo a lo nuestro: Copilot RAG (=Insights), agentes proforma/cobranza (=Actions parcial), y el MCP planificado nos daría el "desde Slack/Claude". La narrativa de ellos es idéntica a la de Relvo — es la narrativa de la categoría.

## ⚠️ Lo que el tour NO mostró (verificar contra sus docs)

Multi-moneda con FX fijo contractual o indexación (UF) · multi-entidad emisora con documentos tributarios LATAM · notas de crédito complejas (distribución, devengo) · unificación multi-contrato · manejo de data legacy sucia en onboarding · cierre de períodos con bloqueo. **Estas son exactamente nuestras fortalezas** — el informe del agente sobre sus docs debe confirmar o matizar.

# Rediseño v2 — material de trabajo (carpeta consolidada única, 21-09)

El **plan** (fases, carriles, reglas) es [`ROADMAP-V2.md`](../../ROADMAP-V2.md), en la raíz del repo.
Esta carpeta reúne TODO el material del rediseño (antes repartido en 3 repos; en los otros quedaron stubs):

## Planificación de la migración del front

| Documento | Qué es |
|---|---|
| [`matriz-scope-migracion-front.md`](./matriz-scope-migracion-front.md) | Los 18 módulos × (front viejo, rpc/endpoints, roadmap, web pública): trenes, limpieza en 2 capas, decisiones |
| [`inventario-rpc-front-viejo.md`](./inventario-rpc-front-viejo.md) | Las 79 funciones rpc() del front viejo + los 272 endpoints de la API: mapa de brechas y lista de "no borrar" |
| [`auditoria-contratos.md`](./auditoria-contratos.md) | Auditoría del dominio Contratos (23-09): las 27 rpc (retirar/fusionar/delegar/portar), triggers, lecturas directas, hallazgos de seguridad y propuesta del módulo `contracts` |
| [`activacion-costura-triggers.md`](./activacion-costura-triggers.md) | Costura `sapira.writer = 'api'`: qué triggers legacy dejan de correr para la API, assets, orden de aplicación y prueba en QA |
| [`cambios-integracion-para-leon.md`](./cambios-integracion-para-leon.md) | Cambios puntuales hechos desde Contratos v2 en código de integración con el ERP (envío a Odoo, scheduler), para revisión de Leon: qué, por qué, test y estado |
| [`activacion-campos-api.md`](./activacion-campos-api.md) | Campo por campo lo que escribe la API (alta, edición, activación, cambios, consumos): regla v2 o réplica, bugs corregidos, qué cambia frente al front viejo y decisiones pendientes |
| [`manual-modificaciones-contratos.md`](./manual-modificaciones-contratos.md) | Cómo funcionan hoy las modificaciones de contrato caso por caso (upsell, cross-sell, downsell, churn, renegociación, renovación, ítem madre, prorrateo), con fórmulas, ejemplos y lo que debe seguir funcionando |

## Specs del modelo v2

| Documento | Qué es |
|---|---|
| [`spec-tablas-por-modulo.md`](./spec-tablas-por-modulo.md) | Las tablas de prod con veredicto por módulo: definió los dominios de `entities/` y guía lo nuevo y la limpieza |
| [`spec-agentes-ia.md`](./spec-agentes-ia.md) | Funcionalidad agéntica: catálogo de acciones, agentes configurables, add-ons |
| [`spec-revenue-y-metricas.md`](./spec-revenue-y-metricas.md) | Revenue y Métricas v2: inventario del front viejo, definiciones únicas (MRR, movimientos, NRR/GRR, netting, RPO, legacy), endpoints `/metrics/*`, revisión de industria y propuestas sobre el devengo |
| [`spec-facturacion-v2.md`](./spec-facturacion-v2.md) | Facturación v2: inventario del front viejo, estados derivados, cola Por emitir, NC, cobranza, recordatorios y endpoints `/billing/*` |
| [`mapa-v2-facturacion.md`](./mapa-v2-facturacion.md) | Lo construido de Facturación v2 en la API (módulo `billing`): formas exactas de respuesta, códigos de bloqueo, asset de pagos y brechas |
| [`cobertura-facturacion-v2.md`](./cobertura-facturacion-v2.md) | Auditoría funcional de Facturación v2: front viejo → v2, bugs del legado verificados, casos de negocio, arreglos y brechas por riesgo |
| [`flexibilidad-con-trazabilidad.md`](./flexibilidad-con-trazabilidad.md) | Principio de producto: facturar distinto a lo planificado, con todo registrado |
| [`budgets-forecast-real.md`](./budgets-forecast-real.md) | Feature: presupuesto vs proyección vs real |
| [`spec-preonboarding-prueba-guiada.md`](./spec-preonboarding-prueba-guiada.md) | Flujo comercial pre-onboarding: sandbox guiado, clickwrap, sizing declarado, calculadora web (propuesta en discusión) |
| [`glosario.md`](./glosario.md) | Vocabulario oficial del modelo |
| [`documentacion-publicable-y-mcp.md`](./documentacion-publicable-y-mcp.md) | Convención de docu publicable por módulo (docs públicas, OpenAPI, MCP de una sola fuente) |

## Análisis e insumos (cerrados 21-08)

| Documento | Qué es |
|---|---|
| [`mejoras-y-brechas.md`](./mejoras-y-brechas.md) | Síntesis de mejoras y decisiones A1–A12 |
| [`censo-prod.md`](./censo-prod.md) | Censo del estado real de la base al 21-08 |
| [`benchmark-zenskar-tour.md`](./benchmarks/benchmark-zenskar-tour.md) · [`benchmark-zenskar-docs.md`](./benchmarks/benchmark-zenskar-docs.md) · [`benchmark-maxio.md`](./benchmarks/benchmark-maxio.md) · [`benchmark-alguna.md`](./benchmarks/benchmark-alguna.md) · [`benchmark-relvo-api.md`](./benchmarks/benchmark-relvo-api.md) | Benchmarks de competidores (pricing por tramos, modelos de contrato, APIs) |

Único doc del rediseño fuera de acá: `front-sapira/docs/v2-rediseno/08-checklist-publicacion-www.md`
(operativo de la publicación de www en ese repo).

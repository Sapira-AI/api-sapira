# Rediseño v2 — material de trabajo (carpeta consolidada única, 21-09)

El **plan** (fases, carriles, reglas) es [`ROADMAP-V2.md`](../../ROADMAP-V2.md), en la raíz del repo.
Esta carpeta reúne TODO el material del rediseño (antes repartido en 3 repos; en los otros quedaron stubs):

## Planificación de la migración del front

| Documento | Qué es |
|---|---|
| [`matriz-scope-migracion-front.md`](./matriz-scope-migracion-front.md) | Los 18 módulos × (front viejo, rpc/endpoints, roadmap, web pública): trenes, limpieza en 2 capas, decisiones |
| [`inventario-rpc-front-viejo.md`](./inventario-rpc-front-viejo.md) | Las 79 funciones rpc() del front viejo + los 272 endpoints de la API: mapa de brechas y lista de "no borrar" |

## Specs del modelo v2

| Documento | Qué es |
|---|---|
| [`spec-tablas-por-modulo.md`](./spec-tablas-por-modulo.md) | Las tablas de prod con veredicto por módulo: definió los dominios de `entities/` y guía lo nuevo y la limpieza |
| [`spec-agentes-ia.md`](./spec-agentes-ia.md) | Funcionalidad agéntica: catálogo de acciones, agentes configurables, add-ons |
| [`flexibilidad-con-trazabilidad.md`](./flexibilidad-con-trazabilidad.md) | Principio de producto: facturar distinto a lo planificado, con todo registrado |
| [`budgets-forecast-real.md`](./budgets-forecast-real.md) | Feature: presupuesto vs proyección vs real |
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

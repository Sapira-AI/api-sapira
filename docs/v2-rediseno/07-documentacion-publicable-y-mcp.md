# 📚 Documentación publicable y preparación del MCP — convención por módulo

> **Pedido de Domi (22-08)**: (1) en el repo front, mantener una documentación **publicable y ordenada** para dejar pública una página de documentación como todos los competidores analizados; (2) una página de **documentación de API** en el repo api, publicada solo con versiones finales del rediseño; (3) **para construir el MCP**, definir qué documentación/desarrollo adicional hay que ir dejando módulo a módulo. Formato HOY → DELTA.

## HOY (verificado en los repos)

- **front-sapira ya tiene el sitio de docs**: rutas `app/(public)/docs/[...slug]` (público, renderiza markdown con `remark-gfm`) y `app/(protected)/documentacion/[...slug]` (interno, con `poc-diagramas`). Carpeta `docs/` con taxonomía hecha: `documentacion-funcional/` (la publicable — hoy con contenido del **template notarial** a reemplazar: appointments, caja, consulta-escrituras…), `documentacion-tecnica/`, `documentacion-regulatoria/`, `reglas-desarrollo/`, `contexto-y-justificacion/`. Reglas vigentes: README como entrada por carpeta, kebab-case, rutas relativas, diagramas (**React Flow** para procesos de negocio, **D2** para técnico), `functional-docs-rules-and-tests`, `module-readme`.
- **api-sapira ya genera OpenAPI**: `@nestjs/swagger` + `swagger-ui-express`, `SwaggerModule`/`DocumentBuilder` en `src/main.ts` — uso interno, descripciones no pensadas para publicar ni para LLMs.
- **Help Center público actual** = HelpKit sobre Notion (help.aisapira.com), mantenido con `/update-helpcenter` — fuera del repo.
- **Copilot**: RAG sobre `rag_documents` (vacía en prod), `analytics.semantic_catalog` (text-to-SQL) y `claude_skills` (tools).
- **Benchmarks**: Zenskar (docs producto + API reference: 168 + 186 páginas), Relvo (docs producto en markdown + API en Scalar + `public-openapi.json`), **Alguna (markdown crudo + `llms.txt` + OpenAPI JSON + servidor MCP propio — el patrón a seguir)**, Maxio (Zendesk + portal APIMatic + SDKs).

## DELTA — se documenta UNA vez y se sirve cuatro veces

Principio: una sola fuente por tipo de contenido, y de ahí salen **(1)** docs de producto públicas, **(2)** API reference, **(3)** MCP (tools + recursos) y **(4)** copilot/agentes (RAG + skills). Las fuentes:

**A. Markdown de producto** — `front-sapira/docs/documentacion-funcional/<modulo>/` (se reemplaza el contenido notarial). Español neutro, sin nombres técnicos (regla UI), vocabulario del glosario. Estructura por módulo: `README.md` (qué es y para quién) · `conceptos.md` · `como-hacer/<tarea>.md` (paso a paso con capturas anonimizadas por sustitución) · `casuisticas.md` (los casos reales que hoy resuelve soporte → base de la autoatención) · `preguntas-frecuentes.md`. Render público en `www.aisapira.com/docs/<modulo>` con la ruta existente; hasta la versión final del módulo: `noindex` y sin link en navegación. Además `llms.txt` en la raíz de docs y markdown crudo accesible por URL (patrón Alguna) → es lo que ingiere `rag_documents` y lo que el MCP expone como recursos.

**B. OpenAPI** — api-sapira (ya existe). Cada endpoint con `@ApiOperation`/`@ApiResponse` escritos para humanos **y** LLMs: propósito, cuándo usarlo, precondiciones, efectos (¿tiene efecto económico?), ejemplos, errores; schemas con descripción por campo; convenciones del benchmark (versionado por header, `Idempotency-Key` en writes, montos como string en `Money {amount, currency}`, `external_id` en todo). Publicación: `/docs` + `openapi.json` público **solo con versiones finales** (hoy Swagger interno; al publicar evaluar Scalar, como Relvo).

**C. Catálogo de acciones** — `ai_action_catalog` (evolución de `claude_skills`, doc de agentes): por acción `name`, `description` LLM-ready, `input_schema`/`output_schema`, efecto económico, permiso, ejemplos. Regla: **toda acción del catálogo es un endpoint de la API** → los tools del MCP se **generan** del catálogo + OpenAPI, no se documentan aparte.

**D. Semantic catalog** de datos (`analytics.semantic_catalog`) actualizado por módulo → preguntas en lenguaje natural (copilot y recursos "insights" del MCP).

**E. Glosario** (`04-spec-modelo-dominio-v2/glosario.md`) = vocabulario oficial de A–D.

## MCP de Sapira — qué hay que ir dejando por módulo

Forma propuesta: **servidor MCP remoto** (HTTP) con token scoped a tenant (igual que la API), que expone **tools** (acciones del catálogo, con la misma política de aprobación humana que los agentes cuando hay efecto económico), **resources** (docs de producto en markdown/`llms.txt`, glosario, esquemas) y **prompts** (tareas guiadas: "preparar el cierre de facturación del mes", "revisar vencimientos de la semana"). Al cerrar cada módulo hay que dejar:

1. Sus endpoints en OpenAPI con descripciones LLM-ready (B).
2. Sus acciones en el catálogo con schemas y ejemplos (C).
3. Su semantic catalog (D).
4. Sus docs de producto + `llms.txt` (A).
5. Sus **casos dorados** como tests de los tools (entrada real → salida esperada).
6. Sus eventos en el event log tipado (base de notificaciones y webhooks).

Con eso, exponer un módulo en el MCP es generación y pruebas, no desarrollo nuevo. Referencias: Alguna (MCP + SDK TS), Zenskar (Action Agent desde Slack sobre los mismos tools).

## Definition of Done documental por módulo (carriles B y C)

Un módulo **no pasa de `domi` a `main`** sin: código + tests · README del módulo (regla existente) · docs de producto del módulo (A) · OpenAPI con descripciones LLM-ready de sus endpoints (B) · acciones en el catálogo (C) · semantic catalog (D) · glosario (E) · casos dorados · nota de migración para usuarios si reemplaza un módulo de v1.

## Publicación (tiempos)

- **Docs de producto**: se escriben módulo a módulo desde ahora; se publican con el repo front (www.aisapira.com/docs) con `noindex` hasta la versión final de cada módulo. HelpKit sigue siendo el Help Center de v1 hasta el switch.
- **API reference**: solo con versiones finales del rediseño (decisión de Domi); mientras, Swagger interno.
- **MCP**: cuando ≥1 módulo tenga catálogo + docs completos. Propuesta de primer módulo: **Reportes/insights o Clientes** (lectura antes que escritura).

## Decisiones para Domi y Leon

1. Render de docs en Next: mantener la ruta existente con markdown (propuesto) vs migrar a un generador (Fumadocs/Nextra).
2. UI de API reference al publicar: Swagger (actual) vs **Scalar** (propuesto, como Relvo).
3. Idiomas: español primero; inglés para API reference y landing (Relvo publica EN/ES).
4. Destino de HelpKit al publicar las docs del repo: redirigir o mantener para v1.
5. MCP: remoto con token por tenant (propuesto) vs local; y el primer módulo expuesto.

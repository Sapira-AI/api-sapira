# 🏗️ Sapira v2 — Plan y método del rediseño

> **Actualizado: 2026-08-21** — plan DEFINITIVO acordado entre Domi y Leon (reemplaza el plan exploratorio previo de la misma jornada). **Deciden:** Domi + Leon · **Ejecutan:** Claude Code (Domi) + Cursor (Leon).
> Este documento es la guía maestra del rediseño. Se actualiza al cierre de cada sesión.

## 🎯 Estrategia definitiva (acordada con Leon, 21-08)

**Incremental sobre el producto vivo — no un rebuild de cero.** El cambio de arquitectura (lógica Supabase RPC → NestJS con TypeORM + front nuevo) es el vehículo para las mejoras estructurales, liberando módulo a módulo en el front nuevo. **NO hay proyecto Supabase nuevo**: las entities se conectan al Supabase actual, y el manejo de tablas/constraints pasa de migraciones manuales a schema-as-code TypeORM.

## 🎯 Objetivos de producto de la v1.2 (Domi, 22-08)

Más allá del cambio de arquitectura, la v1.2 persigue tres objetivos de producto que tocan front Y lógica de datos:
1. **Una versión más agéntica**: agentes que ejecutan acciones, alertan y guían, configurables por el usuario, vendidos como add-on por tipo (contratos/cotizaciones ganadas, facturación, cobranza/proformas, alertas/guía, analítico) → `04-spec-modelo-dominio-v2/agentes-ia-funcionalidad-agentica.md`.
2. **Flexibilidad con trazabilidad**: Sapira nació muy estricto y eso quitó adopción; el usuario debe poder facturar distinto a lo planificado, mezclar monedas y métodos de FX por línea, repartir la facturación por % o montos entre razones sociales, y hacer upsell/downsell (desde Salesforce, HubSpot o manual) de forma simple — con todo registrado y lo derivado recalculado → `05-flexibilidad-con-trazabilidad.md`.
3. **Presupuesto vs proyección vs real** de ventas, facturación y caja (cumplimiento de vendedores como primera vista) → `06-budgets-forecast-real.md`.

## 📋 El plan en 7 pasos

1. **Entities espejo de la DB actual** en `api-sapira` — todas las tablas tal como están hoy, como entidades TypeORM, dentro de la carpeta existente `src/databases/postgresql/entities/` reorganizada en **subcarpetas por módulo** (facturación, contratos, clientes, revenue, integraciones, etc. — según los módulos del doc `04-spec-modelo-dominio-v2/00-tablas-por-modulo.md`). Lo opera Claude Code introspectando la DB real vía MCP; el servicio `database-generator` de Leon (`src/modules/database/`) queda como **referencia**, no como herramienta (tuvo fallas; hoy la carpeta está plana, con ~10 entities sueltas + ~28 JSON de análisis y archivos huérfanos que se limpian en este paso).
2. **Agregar las entidades nuevas** que definimos como necesarias — guiadas por las decisiones A1–A12 de `03-mejoras-y-brechas.md` y los ➕ del doc de tablas por módulo (pricing/tramos, fases-versiones de contrato, invoice_routes, referencias OC/HES, matriz fiscal, event log, **capa agéntica: catálogo de acciones + agentes configurables**…). Cada grupo nuevo se cierra como sección de spec con Domi ANTES de crearlo.
3. **Validación final → conectar las entities al Supabase actual**: desde ahí, ajustes de tablas y constraints se hacen por TypeORM (sincronización/migraciones generadas), no por `supabase/migrations`.
4. **Inventario COMPLETO de funciones y triggers — sin dejar NADA fuera** (base: censo `02-censo-prod.md`, ~150 funciones + ~120 triggers) + **sesión estratégica dedicada** para analizarlos, limpiarlos, simplificarlos y reducir la cantidad al mínimo conservando la funcionalidad clave (insumos: veredictos 🗑️/🔀 del doc de tablas, auditoría del trigger standardize, funciones RSM dev≠prod).
5. **Versión final de funciones y triggers**, lista para ser usada al momento del cambio de front.
6. **Front nuevo (front-sapira)**: partir por la **web/landing que vive en el repo del front**, y luego módulo por módulo con análisis + mejoras UX-UI sustanciales usando **Claude Design** (que tiene el design system de Sapira). Insumo de contenido para la landing: la subpágina de Notion "Contenido nueva web" (proyecto Refresh de Messaging y Web con Camila).
7. **Switch**: el front antiguo se reemplaza por el nuevo, conectado a Supabase (vía api-sapira).

## 🤝 Reglas de trabajo (acordadas 21-08)

- **Mejoras incrementales, no de 0 a 100** — el producto vivo sigue operando y recibiendo fixes críticos durante todo el proceso.
- **Política de comunicación entre IAs**: Claude (Domi) y Cursor (Leon) se comunican mediante **documentación en el repositorio**, actualizada ante cada cambio o mejora, y mantenida LIMPIA (sin docs zombis).
- **Reglas de agentes**: en `front-sapira` y `api-sapira` existen **reglas de Cursor** (Leon) y **reglas de Claude** (Domi). Ambas deben respetarse, conversar entre sí y mantenerse siempre actualizadas — cualquier cambio de convención se refleja en las dos.
- **Ramas de trabajo**: `sapira-ai` → `salesforce-integration` (como siempre). `front-sapira` y `api-sapira` → rama **`domi`** (se crean una vez y TODO el trabajo de Domi/Claude va siempre ahí).
- **Convención de commits en `front-sapira` y `api-sapira` (regla de Leon)**: cada commit es un **bump de versión** hecho con el script `version-commit.sh`, que vive en la **raíz del workspace** (`/Users/domizamora/apps/nodeapps/sapira/`, a la altura de todas las apps — no dentro de los repos). Flujo: `git add <archivos>` → `yarn vcp "comentario"` (= `yarn version:commit patch`; `minor`/`major` para releases) → el script sube `package.json`, lo agrega y commitea como `vX.Y.Z - comentario` → `git push`. Nunca `git commit` directo en esos repos. Aplica con certeza a `front-sapira` (historial 100 % `vX.Y.Z`); `api-sapira` tiene los mismos scripts y commits `v0.0.x`, pero Leon los usa con menos consistencia — **confirmar con él** si allá también es obligatorio (mientras tanto se usa igual, es lo que el propio repo declara). `sapira-ai` mantiene su convención `tipo(módulo): descripción`.
- Del método anterior se conservan: **spec por secciones cerrada con Domi antes de construir**, **casos dorados** de prueba con datos reales (tramos ValdiShopper, NC32 devengo, FX fijo, ancla de emitidas, unificada), y los benchmarks + censo como insumos de diseño.
- **HOY → DELTA** (feedback Domi 21-08): toda propuesta estructural parte del diseño ACTUAL verificado (docs del repo + schema real de prod + catálogo semántico del copilot) y especifica solo la diferencia/mejora. Nada se propone "de cero" si ya existe.
- **Definition of Done documental por módulo** (Domi 22-08): un módulo no pasa de `domi` a `main` sin sus docs de producto publicables (`front-sapira/docs/documentacion-funcional/<modulo>/`, render en www.aisapira.com/docs con `noindex` hasta versión final), su OpenAPI con descripciones LLM-ready, sus acciones en el catálogo, su semantic catalog, glosario y casos dorados — así las docs públicas, la API reference y el MCP salen de una sola fuente. Detalle y tiempos de publicación en `07-documentacion-publicable-y-mcp.md`.
- **Usabilidad + IA como principio de diseño** (Domi 21-08): pese a la complejidad interna (funciones, casuísticas), el producto debe ser muy sencillo de usar — guiar al usuario, ejecutar solicitudes en lenguaje natural, avisos/alertas/pendientes proactivos, y **autoatención de errores de usuario** (identificar el error, explicarlo simple, ofrecer la reparación — sin depender de soporte). Detalle en `03-mejoras-y-brechas.md` §Principio transversal; aplica con especial fuerza al paso 6 (front).

## 🛤️ Tres carriles en paralelo (definidos por Domi tras el plan con Leon)

Cada carril se trabaja en **sesiones separadas y frescas**; su kickoff vive aquí y en la memoria de Claude.

**Carril A — Producción (`sapira-ai`, rama `salesforce-integration`)**: fixes urgentes y quick wins de la lista original (`docs/ROADMAP.md` P0/P1 + quick wins) y los que quedaron a medias. Sin mezcla con el rediseño. Cuando un módulo haga switch a `front-sapira`, sus fixes pasan allá; mientras un módulo esté en construcción en `front-sapira`, los fixes que le caigan acá se anotan en `docs/v2-rediseno/bitacora-fixes-produccion.md` para incluirlos en la versión nueva.

**Carril B — Datos (`api-sapira`, rama `domi`)**: paso 1 del plan — espejo de TODAS las tablas actuales como entities TypeORM, en subcarpetas por módulo. 🔴 Guard: `synchronize` desactivado; nada de este carril toca la base de datos hasta el paso 3 validado con Leon.

**Carril C — Front (`front-sapira`, rama `domi`)**: la landing (public) + el sistema, por módulos, **empezando por Configuraciones**. Estrategia:
- `front-sapira` será el punto de entrada de producción: **www.aisapira.com** (landing + sistema). Los módulos aún no migrados siguen viviendo en **app.aisapira.com** (`sapira-ai`) vía links/redirects — como ya hace hoy el dashboard del shell.
- **No se replica el front actual**: cada módulo se construye UNA vez, funcional desde el día 1 contra el Supabase/API actual, con cambios importantes — el mockup de Claude Design como referencia de diseño y la pantalla actual como referencia de realidad; lo que sobra/falta por módulo alimenta el paso 2 (entities).
- **Los mockups no se documentan**: se implementan en código en la rama `domi` y se revisan en local (`yarn dev`, puerto 8081) ajustando lo necesario. Los PNG/HTML de Claude Design son insumo de trabajo y no entran al repo.
- Flujo de ramas: módulo terminado en `domi` → `main`.
- Antes de publicar el repo: (1) **primera pasada** para verificar que contiene o enlaza TODO lo que hoy se usa en producción (+ correcciones menores → commit); (2) **landing nueva completa** (todas las páginas públicas, blogs, SEO), porque el repo incluye la landing y la de Framer se da de baja. Recién ahí se publica y se sigue por módulos.
- Los mockups del sistema DENTRO de la landing quedan para una **actualización final de la landing** cuando el front esté terminado (rompe el loop landing ↔ front).
- Pendiente con Leon antes del primer switch de módulo: **sesión única** entre www y app (hoy son dos sesiones). El script `version-commit.sh` ya está instalado (ver regla de commits).

## 📚 Insumos de estudio (paso 1 del análisis — completados 21-08)

| Fuente | Doc | Estado |
|---|---|---|
| Zenskar product tour (3 Jams de Domi) | `01-benchmark-zenskar-tour.md` | ✅ |
| Zenskar docs + API | `01-benchmark-zenskar-docs.md` | ✅ |
| Maxio AB + Core (SDK 636 modelos) | `01-benchmark-maxio.md` | ✅ |
| Alguna docs + OpenAPI | `01-benchmark-alguna.md` | ✅ |
| API pública de Relvo (289 schemas) | `01-benchmark-relvo-api.md` | ✅ |

## 🗂️ Documentos de esta carpeta

- `00-plan-y-metodo.md` — este documento (guía maestra + estado).
- `01-benchmark-*.md` — los 5 estudios de competidores/referentes.
- `02-censo-prod.md` — estado real de producción (tablas, funciones, triggers, volúmenes, hallazgos) — **base del paso 4**.
- `03-mejoras-y-brechas.md` — síntesis: 12 decisiones estructurales, fortalezas propias, mapa dolor→solución — **guía del paso 2**.
- `04-spec-modelo-dominio-v2/00-tablas-por-modulo.md` — las 128 tablas con veredicto por módulo — **guía de los pasos 1, 2 y 4** y del orden de subcarpetas de entities.
- `04-spec-modelo-dominio-v2/<NN>-<sección>.md` — las secciones de spec que se van cerrando con Domi (siguiente: Pricing/catálogo).
- `05-flexibilidad-con-trazabilidad.md` — principio de producto: casos concretos de flexibilidad (facturar distinto, monedas/FX por línea, reparto entre razones sociales, upsell/downsell simple), invariantes que no se tocan, cómo se mide.
- `06-budgets-forecast-real.md` — feature nueva: presupuesto vs proyección vs real (ventas/facturación/caja), modelo de datos y decisiones.
- `07-documentacion-publicable-y-mcp.md` — convención de documentación publicable (docs de producto en el repo front, API reference en el repo api) y lo que cada módulo debe dejar para que el MCP se genere; Definition of Done documental; tiempos de publicación.
- `04-spec-modelo-dominio-v2/glosario.md` — **nombres acordados** por concepto (UI en español / técnico / hoy) — toda decisión de nomenclatura de Domi se registra aquí y se respeta en docs, código y reglas de ambos repos.
- `04-spec-modelo-dominio-v2/agentes-ia-funcionalidad-agentica.md` — **capa agéntica** (agentes que ejecutan acciones, alertan y guían; configurables por el usuario además de los genéricos): HOY → DELTA, modelo de datos, fases F0–F3, decisiones — **pendiente revisión de Domi**.

## 🧱 Carril B — decisiones y estado del espejo (2026-08-22)

- **Fuente de verdad = SOLO prod en vivo** (`hklompkypzqtglprfobu`, el `SUPABASE_URL` del `.env` de api-sapira; en el dashboard se llama "Sapira MVP"), leída por el MCP de Supabase en el momento de espejar. **Nada** se toma de `supabase/schema.sql`, `supabase/migrations`, tipos generados ni JSON antiguos (son de otro proyecto/fecha: receta para el error; ya se comprobó drift). Existe otro proyecto "Sapira Prod" `hjuidecxkvkseumjfexr` y el CLI de sapira-ai está linkeado a `obvwrhvyuimjoejqmuqf` ❓ Leon: qué es cada uno.
- **Qué entrega el MCP**: `list_tables verbose` (columnas, tipos, nullable, defaults, comentarios, uniques y CHECK de columna, PK, FKs, RLS, filas) + `execute_sql` de **solo lectura** sobre `pg_catalog` (nombres de PK/UNIQUE/CHECK, uniques compuestos, reglas ON DELETE/UPDATE, índices incl. parciales, longitudes varchar/precisión numeric, triggers y policies). `execute_sql` está bloqueado en el modo auto de Claude; en **modo manual** Domi aprueba cada consulta (así se completó base-tenancy el 22-08). Ambas lecturas se guardan en `api-sapira/scripts/espejo/snapshots/<modulo>.{pgmeta,catalog}.json` para regenerar sin volver a consultar.
- **Las entities existentes NO se tocan ni se duplican** (`src/modules/*/entities/` y las 8 planas de `entities/`: 59 clases que producción carga por glob + `forFeature`): siguen exactamente igual, prendidas como estaban. Para cada tabla que ya tiene entity, el README del módulo documenta dónde está y su **diferencia con prod** (columnas faltantes, tipo/nullable/default distintos, constraints e índices no declarados), calculada con la metadata TypeORM real de la entity (`scripts/espejo/extract-existing-metadata.ts`). Solo las tablas SIN entity se crean, en `src/databases/postgresql/entities/<modulo>/`, **apagadas en runtime**: archivos `<tabla>.espejo.ts` (fuera del glob `**/*.entity.ts` de `database.module.ts` y de todo `forFeature`); sus FKs hacia tablas con entity existente apuntan a esa entity sin duplicarla. En el paso 3 se renombran a `.entity.ts` y se completan las existentes con Leon.
- **Convención** (detalle en `api-sapira/src/databases/postgresql/entities/README.md`): una subcarpeta por módulo del 04/00; una clase por tabla con todas las columnas (tipo/nullable/default/comentario reales), CHECK y unique de columna, PK y **una relación `@ManyToOne` por FK** con el nombre real del constraint; nada se rediseña ni se omite (ni las 🗑️); rarezas verificadas en vivo → `NOTAS-ESPEJO.md`. Generador reproducible: `api-sapira/scripts/espejo/generate-espejo.py` (entrada: JSON en vivo del MCP).
- **Verificación sin tocar la DB**: por módulo, snapshot de prod (`<modulo>.prod-snapshot.ts`) + spec que construye la metadata TypeORM en memoria y la compara (columnas + nullabilidad, PK, FKs); `database.module.spec.ts` falla si algún archivo habilita `synchronize`/`dropSchema`/`migrationsRun` o si algún `.entity.ts` aparece dentro de `entities/<modulo>/`.
- **Rama de Leon `actualizacion-entities-triggers-functions`**: ya contenida en `domi`; su generador queda como referencia. Los 30 JSON de análisis obsoletos de `entities/` se eliminaron (autorizado por el plan).
- **Estado (22-08, tarde)**: ✅ **los 16 módulos generados y verificados** — 130 tablas = 55 con entity existente (documentadas con su diff vs prod en el README de cada módulo) + **75 espejos creados y apagados** (947 columnas, 163 FKs, 25 UNIQUE, 55 CHECK, 184 índices declarados + 27 documentados, 64 triggers y 238 policies en los JSDoc), todo desde las dos lecturas en vivo del 22-08; 15 specs / 495 tests en verde; build verde; producción intacta. Pendiente: revisión de Domi y su autorización para el commit (el trabajo está en el working tree de `domi`, sin commitear). Hallazgos nuevos en `NOTAS-ESPEJO.md` (FKs duplicadas, SET NULL sobre NOT NULL, enums sin uso, índices no declarables, RLS sin policies).

## ✅ Estado (2026-08-22)

- [x] Análisis: benchmarks (5/5) + censo prod + síntesis de mejoras + revisión de tablas por módulo
- [ ] **Paso 1 (carril B)** — en curso: entities espejo por módulo en `api-sapira` rama `domi`, **tal cual existen hoy en prod (solo lectura en vivo vía MCP)**, inertes en runtime y sin tocar las entities existentes. ✅ convención + verificación + carpeta limpia · ✅ **130/130 tablas**: 75 espejos nuevos apagados + 55 entities existentes documentadas con su diff vs prod, en los 16 módulos (base-tenancy, fx, clientes, cotizaciones-catalogo, contratos, facturacion, revenue, legacy, conciliacion, integraciones/{salesforce,odoo,stripe,otras}, automatizaciones-ia, suscripciones, sii) · ⏳ revisión de Domi + autorización del commit
- [ ] **Revisión detallada de Domi (entre el paso 1 y el paso 2)**: sobre las entities ya generadas — veredictos del 04/00, qué se mejora y qué entidades nuevas entran
- [ ] Paso 2: entidades nuevas por sección de spec (primera: Pricing — modelos de precio, tramos y billable metric/consumo como parte del precio)
- [ ] Paso 3: conexión TypeORM ↔ Supabase actual (validación con Leon)
- [ ] Paso 4: sesión estratégica de funciones y triggers (inventario completo ya censado)
- [ ] Paso 5: set final de funciones/triggers
- [ ] Paso 6 (carril C): front — primera pasada al repo + landing COMPLETA (publicación de www.aisapira.com), luego módulos empezando por Configuraciones
- [ ] Paso 7: switch de front

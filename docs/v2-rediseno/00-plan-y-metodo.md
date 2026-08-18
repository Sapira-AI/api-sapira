# 🏗️ Sapira v2 — Plan y método del rediseño

> **Actualizado: 2026-08-18** — plan DEFINITIVO acordado entre Domi y Leon (reemplaza el plan exploratorio del 14-08). **Deciden:** Domi + Leon · **Ejecutan:** Claude Code (Domi) + Cursor (Leon).
> Este documento es la guía maestra del rediseño. Se actualiza al cierre de cada sesión.

## 🎯 Estrategia definitiva (acordada con Leon, 18-08)

**Incremental sobre el producto vivo — no un rebuild de cero.** El cambio de arquitectura (lógica Supabase RPC → NestJS con TypeORM + front nuevo) es el vehículo para las mejoras estructurales, liberando módulo a módulo en el front nuevo. **NO hay proyecto Supabase nuevo**: las entities se conectan al Supabase actual, y el manejo de tablas/constraints pasa de migraciones manuales a schema-as-code TypeORM.

## 📋 El plan en 7 pasos

1. **Entities espejo de la DB actual** en `api-sapira` — todas las tablas tal como están hoy, como entidades TypeORM, dentro de la carpeta existente `src/databases/postgresql/entities/` reorganizada en **subcarpetas por módulo** (facturación, contratos, clientes, revenue, integraciones, etc. — según los módulos del doc `04-spec-modelo-dominio-v2/00-tablas-por-modulo.md`). Lo opera Claude Code introspectando la DB real vía MCP; el servicio `database-generator` de Leon (`src/modules/database/`) queda como **referencia**, no como herramienta (tuvo fallas; hoy la carpeta está plana, con ~10 entities sueltas + ~28 JSON de análisis y archivos huérfanos que se limpian en este paso).
2. **Agregar las entidades nuevas** que definimos como necesarias — guiadas por las decisiones A1–A12 de `03-mejoras-y-brechas.md` y los ➕ del doc de tablas por módulo (pricing/tramos, fases-versiones de contrato, invoice_routes, referencias OC/HES, matriz fiscal, event log…). Cada grupo nuevo se cierra como sección de spec con Domi ANTES de crearlo.
3. **Validación final → conectar las entities al Supabase actual**: desde ahí, ajustes de tablas y constraints se hacen por TypeORM (sincronización/migraciones generadas), no por `supabase/migrations`.
4. **Inventario COMPLETO de funciones y triggers — sin dejar NADA fuera** (base: censo `02-censo-prod.md`, ~150 funciones + ~120 triggers) + **sesión estratégica dedicada** para analizarlos, limpiarlos, simplificarlos y reducir la cantidad al mínimo conservando la funcionalidad clave (insumos: veredictos 🗑️/🔀 del doc de tablas, auditoría del trigger standardize, funciones RSM dev≠prod).
5. **Versión final de funciones y triggers**, lista para ser usada al momento del cambio de front.
6. **Front nuevo (front-sapira)**: partir por la **web/landing que vive en el repo del front**, y luego módulo por módulo con análisis + mejoras UX-UI sustanciales usando **Claude Design** (que tiene el design system de Sapira). Insumo de contenido para la landing: la subpágina de Notion "Contenido nueva web" (proyecto Refresh de Messaging y Web con Camila).
7. **Switch**: el front antiguo se reemplaza por el nuevo, conectado a Supabase (vía api-sapira).

## 🤝 Reglas de trabajo (acordadas 18-08)

- **Mejoras incrementales, no de 0 a 100** — el producto vivo sigue operando y recibiendo fixes críticos durante todo el proceso.
- **Política de comunicación entre IAs**: Claude (Domi) y Cursor (Leon) se comunican mediante **documentación en el repositorio**, actualizada ante cada cambio o mejora, y mantenida LIMPIA (sin docs zombis).
- **Reglas de agentes**: en `front-sapira` y `api-sapira` existen **reglas de Cursor** (Leon) y **reglas de Claude** (Domi). Ambas deben respetarse, conversar entre sí y mantenerse siempre actualizadas — cualquier cambio de convención se refleja en las dos.
- **Ramas de trabajo**: `sapira-ai` → `salesforce-integration` (como siempre). `front-sapira` y `api-sapira` → rama **`domi`** (se crean una vez y TODO el trabajo de Domi/Claude va siempre ahí).
- Del método anterior se conservan: **spec por secciones cerrada con Domi antes de construir**, **casos dorados** de prueba con datos reales (tramos ValdiShopper, NC32 devengo, FX fijo, ancla de emitidas, unificada), y los benchmarks + censo como insumos de diseño.
- **HOY → DELTA** (feedback Domi 18-08): toda propuesta estructural parte del diseño ACTUAL verificado (docs del repo + schema real de prod + catálogo semántico del copilot) y especifica solo la diferencia/mejora. Nada se propone "de cero" si ya existe.
- **Usabilidad + IA como principio de diseño** (Domi 18-08): pese a la complejidad interna (funciones, casuísticas), el producto debe ser muy sencillo de usar — guiar al usuario, ejecutar solicitudes en lenguaje natural, avisos/alertas/pendientes proactivos, y **autoatención de errores de usuario** (identificar el error, explicarlo simple, ofrecer la reparación — sin depender de soporte). Detalle en `03-mejoras-y-brechas.md` §Principio transversal; aplica con especial fuerza al paso 6 (front).

## 📚 Insumos de estudio (paso 1 del análisis — completados 14-08)

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

## ✅ Estado (2026-08-18)

- [x] Análisis: benchmarks (5/5) + censo prod + síntesis de mejoras + revisión de tablas por módulo
- [ ] **Paso 1 ← LO PRIMERO**: entities espejo por módulo en `api-sapira` rama `domi`, **tal cual existen hoy en la DB** (limpiar carpeta actual + generar TODAS las tablas)
- [ ] **Revisión detallada de Domi (entre el paso 1 y el paso 2)**: sobre las entities ya generadas — veredictos del 04/00, qué se mejora y qué entidades nuevas entran
- [ ] Paso 2: entidades nuevas por sección de spec (primera: Pricing/tramos)
- [ ] Paso 3: conexión TypeORM ↔ Supabase actual (validación con Leon)
- [ ] Paso 4: sesión estratégica de funciones y triggers (inventario completo ya censado)
- [ ] Paso 5: set final de funciones/triggers
- [ ] Paso 6: front — landing primero, luego módulos con Claude Design
- [ ] Paso 7: switch de front

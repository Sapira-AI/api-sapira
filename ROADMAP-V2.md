# 🗺️ ROADMAP — Sapira v2 · plan y método

> **El documento único del plan del cambio a Sapira v2**: estrategia, fases con su estado, reglas de
> trabajo. Se actualiza tachando/marcando lo hecho — no se reescribe. Absorbe al antiguo plan
> "00-plan-y-metodo" del 21-08 (historia en git) y reemplaza las copias que divergían en
> `sapira-ai` y `front-sapira`. El backlog de fixes del producto vivo es **otra documentación**:
> [`docs/ROADMAP-OPERATIVO.md`](docs/ROADMAP-OPERATIVO.md) (copia espejo; canónico en `sapira-ai/docs/ROADMAP-OPERATIVO.md`) (ver [convención](#-fixes-del-producto-vivo--convención)).
> **Deciden:** Domi + Leon · **Ejecutan:** Claude Code (Domi) + Cursor (Leon) · Actualizado: **2026-09-21**.

## 🎯 Estrategia

**Incremental sobre el producto vivo — no un rebuild de cero.** El cambio de arquitectura
(lógica Supabase RPC → NestJS/`api-sapira` + front nuevo `front-sapira`) es el vehículo de las
mejoras estructurales, liberando módulo a módulo. **No hay proyecto Supabase nuevo**: la base es la
misma (`hklompkypzqtglprfobu` = producción "Sapira MVP"; `obvwrhvyuimjoejqmuqf` = QA, confirmado
16-09; "Sapira Prod" `hjuidecxkvkseumjfexr` está vacío). El esquema se gobierna como código desde
este repo ([GUIA](src/databases/postgresql/GUIA-CAMBIOS-DE-ESQUEMA.md)).

## 🎯 Objetivos de producto de la v2

1. **Una versión más agéntica**: agentes que ejecutan acciones, alertan y guían, configurables por
   el usuario, vendidos como add-on por tipo → [`docs/v2-rediseno/spec-agentes-ia.md`](docs/v2-rediseno/spec-agentes-ia.md).
2. **Flexibilidad con trazabilidad**: facturar distinto a lo planificado, monedas y FX por línea,
   reparto entre razones sociales, upsell/downsell simple — todo registrado y recalculado →
   [`docs/v2-rediseno/flexibilidad-con-trazabilidad.md`](docs/v2-rediseno/flexibilidad-con-trazabilidad.md).
3. **Presupuesto vs proyección vs real** de ventas, facturación y caja → [`docs/v2-rediseno/budgets-forecast-real.md`](docs/v2-rediseno/budgets-forecast-real.md).

## 📋 Las fases (los 7 pasos del plan del 21-08, tachados según avance)

### Fase 0 — Cerrar base de datos ↔ repo api 🔄 EN CURSO (casi lista) · Leon + Domi

- ~~Paso 1 · Entities espejo de la DB~~ ✅ (22-08; promovidos 16-09: **129 entities, sin espejos**)
- ~~Paso 3 · Conexión TypeORM ↔ Supabase; el esquema se cambia por migraciones/assets~~ ✅ operativo
  (corpus + runner + `schema:status` + guardas)
- ~~Limpieza capa 1: 23 assets huérfanos~~ ✅ eliminados 21-09
- ~~Deriva real de funciones (REGISTRO punto 1)~~ ✅ cerrada 21-09 (recapturas, `rsm_metrics`,
  seed/roles corregidos según el diseño de permisos internos — el seed queda solo para bootstrap)
- ~~Llevar el carril api a la rama `dev`~~ ✅ 21-09 por [GUIA §6](src/databases/postgresql/GUIA-CAMBIOS-DE-ESQUEMA.md):
  5 migraciones + 26 assets; ambas ramas con `schema:status` sin migraciones, sin PENDIENTE y sin
  SIN CONTRAPARTE. ("QA" = rama `dev` persistente del MISMO proyecto Supabase; el flujo viejo del
  front la mantenía en paridad y solo le faltaba el carril api. ⚠️ Regla mientras convivan ambos
  mecanismos: **ninguna operación de rama por Supabase — merge/rebase/reset — sin acuerdo
  Domi+Leon**: un reset reconstruiría dev sin el carril api.)
- ~~2 vistas sin uso~~ ✅ eliminadas de ambas ramas 21-09 (`DropVistasSinUso`, REGISTRO punto 7)
- 🔴 **PENDIENTE GRANDE — LEON: revisión de cierre de Fase 0** (antes de pasar `domi`→`qa`→`main`).
  Resumen de lo ejecutado en la sesión del 21-09 (Domi + Claude), todo por el flujo de la GUIA y
  verificable con `schema:status`:
  1. **QA/dev sincronizada** (GUIA §6 en su orden): 2 policies → **5 migraciones TypeORM** →
     26 assets con `--only` (16 funciones donde dev tenía versiones viejas de hotfixes que se
     aplicaron directo a prod entre marzo y mayo — trazabilidad en REGISTRO punto 3 —, los 7 de
     `sapira_quantity_imports`/quote-stages, `grants/010` ×2 ramas, las 2 policies) + tablas de
     prueba `example`/`examples` eliminadas. **Las funciones de quantities no estaban entre las
     divergentes: nadie las tocó.**
  2. **Prod**: `rsm_metrics` normalizada (`\r\n`→idéntica al repo) y `grants/010` re-aplicado.
  3. **Corpus**: bug de sobrecargas cerrado (archivos multi-función sin `;` — emisor de
     `generate-assets.ts` + 11 archivos); 23 huérfanos eliminados (REGISTRO punto 4);
     `create_default_roles_for_holding` **revertido** y `seed/002` **reescrito** según el diseño
     de permisos internos (el seed queda SIN aplicar, solo para bootstrap — decisión Domi).
  4. **Estado medido al cierre**: ambas ramas con migraciones 0 · PENDIENTE 0 · SIN CONTRAPARTE 0.
  Lo que Leon debe revisar/ajustar para cerrar:
  - [ ] `types/000-extensions` NO CONVERGE — la ÚNICA decisión de QA que queda (las otras dos se
    cerraron el 21-09 PM con OK de Domi: 5 policies viejas eliminadas de dev; migraciones fantasma
    del front documentadas y NO recreadas — detalle en REGISTRO punto 3). También cerrado ese día:
    las 2 vistas sin uso, eliminadas de ambas ramas con `DropVistasSinUso` (REGISTRO punto 7 ✅).
  - [ ] Validar el seed/roles de permisos internos (o su retiro definitivo) — REGISTRO punto 1.
  - [ ] 🔶 **Subcarpetas por dominio en `functions/` y `triggers/`** (el runner ya es recursivo; la
    ruta es la identidad en el historial → decidir ANTES del baseline; hoy ~35 filas entre ambas
    ramas — nunca más barato).
  - [ ] `--baseline` en ambas ramas → `schema:status` en silencio total → Fase 0 cerrada.
  - [ ] Contraseñas (REGISTRO punto 9) y el acuerdo de no operar la rama por Supabase
    (merge/rebase/reset) mientras convivan los dos mecanismos.

### Fase 1 — Replicar el front que funciona en `front-sapira`, consumiendo la API 🔜 · ambos

Los pasos 4–5 originales ("inventario y versión final de funciones/triggers") **reformulados**: la
limpieza no es una gran sesión única sino **el paso 0 de cada módulo** que se migra — auditoría y
saneamiento de su familia de funciones/triggers (duplicadas/solapadas), aplicando ahí los fix del
roadmap operativo que correspondan y los que se vayan presentando. Nada se replica sucio. El front
nuevo consume `api-sapira` vía BFF (cero `supabase.rpc()` directo), paridad funcional como meta.

- Scope, trenes y familias: [`docs/v2-rediseno/matriz-scope-migracion-front.md`](docs/v2-rediseno/matriz-scope-migracion-front.md)
- Qué llama el front viejo / qué endpoints existen: [`docs/v2-rediseno/inventario-rpc-front-viejo.md`](docs/v2-rediseno/inventario-rpc-front-viejo.md)
- Decisión de arranque pendiente: patrón de autorización (JWT propagado a Postgres vs service role)

### Fase 2 — Rediseño UI/UX por módulo 🔄 parcial · Domi

Paso 6 original. Sobre la paridad de Fase 1: mejoras UX y diseño nuevo (mockups en `front-sapira`,
design system en Claude Design). Ya construido: ~~sitio público v1~~ ✅ (08-09) · ~~shell +
dashboard con diseño nuevo~~ ✅ (v0.1.29). Detalle operativo del carril (bloqueantes del switch,
acuerdos de sidebar, checklist www): `front-sapira/docs/`.

### Fase 3 — Mejoras estratégicas grandes 🔮 · ambos

Paso 2 original (entidades nuevas por sección de spec, primera: **Pricing**) + los estratégicos:
**modelos de precio flexibles** (rangos/tramos, consumo), **capa agéntica** (agentes + MCP de
Sapira), **budgets/forecast vs real**, contratos indefinidos con ajustes planificados, facturación
electrónica nativa, KAME. Cada grupo pasa por spec cerrada con Domi ANTES de construir, y por la
[GUIA](src/databases/postgresql/GUIA-CAMBIOS-DE-ESQUEMA.md). Insumos: `docs/v2-rediseno/` + ítems
20–25 del roadmap operativo.

**Paso 7 — el switch — va módulo por módulo** al cierre de cada uno (Fase 1→2 por módulo), con
`lib/app-links.ts` en `front-sapira` redirigiendo lo no migrado a la app actual.

## 🛤️ Los tres carriles (forma de trabajo: sesiones separadas y frescas por carril)

| Carril | Qué es | Dónde | Estado |
|---|---|---|---|
| **A — Producto vivo** | Fixes y mejoras urgentes del front actual | `sapira-ai` (+ `api-sapira` si tocan esquema) | Continuo; backlog en `sapira-ai/docs/ROADMAP-OPERATIVO.md` |
| **B — Base y API** | Schema-as-code, corpus, limpieza, módulos de API | `api-sapira` | Fase 0 casi cerrada → Fase 1 |
| **C — Front nuevo** | Sitio público + sistema módulo a módulo | `front-sapira` | www v1 ✅ · shell + dashboard ✅ · módulos por migrar |

## 🔧 Fixes del producto vivo — convención

El backlog operativo vive en **dos copias espejo**: [`docs/ROADMAP-OPERATIVO.md`](docs/ROADMAP-OPERATIVO.md) (acá, porque la mayoría de los fixes requieren cambios en la base) y `sapira-ai/docs/ROADMAP-OPERATIVO.md` (allá, porque un fix urgente de usuarias aterriza en el front viejo sin esperar al nuevo). Reglas:

- **Todo cambio a una copia se replica en la otra en la misma sesión** — mismo texto, mismo commit
  referenciado. Si divergen, manda la de `sapira-ai` y se re-sincroniza.
- Todo fix se anota con su commit, aterrice donde aterrice (front viejo o `api-sapira` vía
  migración/asset).
- Si tocó esquema, queda **además** reflejado en este repo por su propia mecánica (asset editado /
  migración + docu del corpus).
- Al migrar un módulo en Fase 1, sus ítems del roadmap operativo se revisan: resueltos se marcan,
  pendientes se resuelven en el saneamiento del módulo.

## 🤝 Reglas de trabajo vigentes (acordadas 21/22-08)

- **Mejoras incrementales**: el producto vivo sigue operando y recibiendo fixes críticos siempre.
- **Las IAs se comunican por documentación en el repo**, actualizada en cada cambio y limpia (sin
  docs zombis). Reglas de Cursor (Leon) y de Claude (Domi) conviven y se actualizan juntas.
- **Ramas**: trabajo de Domi en `domi` (front-sapira y api-sapira). Commits de front/api con
  `version-commit.sh` (`yarn vcp "comentario"`); `sapira-ai` usa `tipo(módulo): descripción`.
- **HOY → DELTA**: toda propuesta estructural parte del diseño actual verificado (repo + prod en
  vivo) y especifica solo la diferencia. Nada se propone de cero si ya existe.
- **Spec por secciones cerrada con Domi antes de construir** + **casos dorados** con datos reales
  (tramos ValdiShopper, NC32 devengo, FX fijo, ancla de emitidas, unificada).
- **Definition of Done documental por módulo**: no pasa a `main` sin doc de producto publicable,
  OpenAPI LLM-ready, catálogo de acciones, semantic catalog, glosario y casos dorados
  → `docs/v2-rediseno/documentacion-publicable-y-mcp.md`.
- **Usabilidad + IA como principio de diseño**: muy sencillo de usar pese a la complejidad interna —
  guiar, ejecutar en lenguaje natural, avisos proactivos, autoatención de errores.
- **Fuente de verdad del esquema = producción en vivo** (`schema:status`/MCP); nunca
  `supabase/schema.sql`, migraciones del front ni snapshots con fecha.

## 📚 Insumos de diseño (cerrados 21-08)

Benchmarks (Zenskar tour + docs/API, Maxio, Alguna, Relvo) · censo de prod (`02-censo-prod.md`) ·
mejoras y decisiones A1–A12 (`03-mejoras-y-brechas.md`) · revisión tabla por tabla
(`spec-tablas-por-modulo.md`). El set completo vive hoy en
`sapira-ai/` y `front-sapira/docs/v2-rediseno/`; su consolidación está abajo.

## 🧹 Mantenimiento documental (hecho el 21-09; quedan 3 puntos — luego esta sección se borra)

- ✅ Archivado en [`docs/archivo/2026-1S/`](docs/archivo/2026-1S/README.md) (con índice): los 6 de
  `docs/debugging/`, los 4 análisis pre-corpus de triggers, y los 3 sueltos de la raíz del repo.
- ✅ Borrados: `resultado.md` (log pegado), `client_entities.md` (datos de prod pegados).
- ✅ Matriz de scope e inventario rpc dentro de `docs/v2-rediseno/`; `docs/ROADMAP-OPERATIVO.md` es copia espejo del backlog de `sapira-ai`.
- ✅ Plan y roadmap fusionados en este único documento (el archivo del plan se retiró; historia en git).
- ✅ `docs/v2-rediseno/` aplanada y sin prefijos numéricos; `docs/ROADMAP-OPERATIVO.md` en mayúsculas.
- ✅ `v2-rediseno/` consolidada COMPLETA acá (21-09): benchmarks ×5, censo, mejoras A1–A12,
  flexibilidad, budgets, spec agentes, glosario y la versión más nueva de tablas-por-módulo. En
  `sapira-ai` y `front-sapira` quedaron stubs (allá solo sobrevive el checklist de www, que es
  operativo de ese repo).
- ✅ `sapira-ai/docs/ROADMAP.md` renombrado a `ROADMAP-OPERATIVO.md` (espejo de nombre con el de acá).
- ✅ Los 2 docs dudosos de Leon movidos a `docs/archivo/2026-1S/` con aviso ⚠️ en su índice.
- ⬜ **Leon**: confirmar en el archivo si `rls-README-pre-corpus.md` y `claude-REFACTORING_GUIDE.md`
  se eliminan o algo de ellos vuelve a la docu viva.

## Regla de mantenimiento

Este documento es el único índice del plan: un doc de planificación nuevo se linkea desde acá o no
existe. El estado fino se marca en el doc de detalle (REGISTRO, matriz, roadmap operativo); acá se
tachan pasos y se actualizan fases — sin reescribir ni borrar historia.

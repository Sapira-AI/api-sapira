# Matriz de scope — migración del front módulo a módulo

> Cruza las cuatro fuentes para ordenar el desarrollo del front nuevo consumiendo la API:
> **(A)** lo que existe en el front viejo (`sapira-ai`, 27 páginas), **(B)** el inventario de
> `rpc()` y el barrido de endpoints ([`inventario-rpc-front-viejo.md`](./inventario-rpc-front-viejo.md)),
> **(C)** el roadmap pausado (`sapira-ai/docs/ROADMAP.md`, act. 31-08) y **(D)** lo declarado en la
> web pública de `front-sapira` (`/plataforma/*`: contratos, facturación, cobranza,
> precios-y-consumo, revenue; más `/agentes` e `/integraciones`).
>
> Fecha: 2026-09-14 · working tree, sin commit · decisión previa (Domi): primero paridad con UX
> mejorada, después roadmap estratégico. La limpieza del corpus corre como paso previo/paralelo.

## Arquitectura ya decidida (verificada en código)

El front nuevo ya opera con patrón **BFF**: `app/api/*` (rutas server de Next) llaman a
`api-sapira` vía `lib/api/backend-fetch.ts` — la URL del backend nunca se expone al navegador —
y Supabase queda solo para auth. Rutas BFF existentes: contacto, copilot, dashboard, factura,
holdings, invoices, reportes, sii, users. **Cada módulo migrado sigue este patrón: página →
ruta BFF → endpoint NestJS.** Cero `rpc()` en el front nuevo (verificado).

## La matriz

Convenciones: **Tren 1** = migrable ya (API cubre) · **Tren 2** = requiere construir módulo API
primero (ahí viven las 79 rpc) · **Tren 3** = estratégico con diseño UX/esquema nuevo ·
Tipo **P** = paridad + mejoras UX · **R** = rediseño.

| # | Módulo | Front viejo (A) | rpc / API hoy (B) | Roadmap que lo toca (C) | Web (D) | Tipo | Tren |
|---|---|---|---|---|---|---|---|
| 1 | **Auth + onboarding** | Auth, ConfiguracionInicial | 4 rpc onboarding · `/users/me`, `/me/context`, `/holdings/select` ✓ | — | — | P | **1** (base ya en front nuevo) |
| 2 | **Dashboard** | Home/Index | 1 rpc · `GET /dashboard/home` ✓ | — | — | P | **1** (ya existe en front nuevo) |
| 3 | **Integraciones** (SF, Odoo, Stripe, BigQuery, Banco Central/Perú) | Integraciones + 5 páginas | 3 rpc utilitarias · **159+15 endpoints ✓ (cobertura total)** | Carril León: dedup import legacy, odoo_partner al crear entities, mensajes accionables | ✓ | P | **1** — el candidato ideal para estrenar el patrón |
| 4 | **SII / empresas** | (dentro de Configuración) | 0 rpc · 7 endpoints ✓ | — | — | P | **1** (ya existe: `admin/empresas-sii`) |
| 5 | **Agentes IA** | AgentesIA, AgentsPage, AgentConfigPage | 0 rpc de negocio · 12 endpoints ✓ | Estratégico: agentes de operaciones, MCP (#21) | ✓ | P ahora, R después | **1** paridad → **3** estratégico |
| 6 | **Notificaciones** | Notificaciones, NotificacionDetalle | 0 rpc · 5 endpoints ✓ | Complejos #10 (en curso León: infra en prod) | — | P | **1–2** (coordinar con León) |
| 7 | **Clientes y entidades** | Clientes, ClienteDetail | 5 rpc · 12 endpoints ✓ (falta `by_tax_id`) | Medios #10 (gestión razones sociales), Tanda 2 (tax_rate ⚠️ bomba latente), dedup entities | — | P | **1–2** (brecha API chica) |
| 8 | **Usuarios/roles/admin** | Configuracion (parte) | 6 rpc admin · users 6 + holdings 5 + devices 5 | — | — | P | **2** (falta CRUD roles/permisos en API) |
| 9 | **Cotizaciones** | Cotizaciones | 3 rpc · **0 endpoints** | Medios #4 (recalcular precios al editar); Complejos #1 (upsell desde cotización) | — | P | **2** |
| 10 | **Contratos** | Contratos, ContratoDetail, contratos/ | **~27 rpc · 0 endpoints — la brecha más grande** | El grueso del roadmap: Complejos #1 (modificaciones), #2 (ítems variables), #7 (preview), #8 (headers), #9 (pausa/ítem); Medios #7, #12 (renegociación ya desarrollada 13-09); Estratégico #25 (indefinidos + ajustes planificados) | ✓ | P con R parcial (los modales de movimientos merecen rediseño) | **2** — núcleo del sistema |
| 11 | **Facturación** | Facturacion | 12 rpc · 12 endpoints pero solo scheduler/logs | Tanda 3 (churn booking, descripciones), Medios #1, #2, #5, #11 (términos de pago); Complejos #3 (standardize), #4 (matriz fiscal), #5 (descuento NC) | ✓ | P con R parcial | **2** — junto/después de contratos (dependen entre sí) |
| 12 | **Períodos contables** | (hooks en varias páginas) | 3 rpc · 0 endpoints | Complejos #8 (choque con cierre) | — | P | **2** (módulo API chico, transversal) |
| 13 | **Revenue / RSM** | Revenue | 5 rpc · 0 endpoints | Complejos #6 (sesión RSM: sub-bugs, duplicados, overrides) | ✓ | P | **2–3** (sanear RSM antes de UI nueva) |
| 14 | **Reportes / MRR** | Reportes (hooks useMRR*) | rpc solo tenancy; consultas directas a tablas | Medios #9 (panel vendedores) | — | P/R | **2–3** (son "query → endpoint de reporte") |
| 15 | **Legacy / MRR legacy** | FacturasLegacy + flujos en contratos | ~11 rpc · 0 endpoints | V9 en validación | — | **Decisión pendiente**: ¿UI nueva completa o admin mínimo si es transitorio? | **2** (mínimo) |
| 16 | **Cobranza / AR** | Tab AR v1 (en validación V7) | 0 rpc propios · 0 endpoints | V7 + calendario cobros | ✓ **prometida** | R (es v1 aún) | **3** con diseño |
| 17 | **Pricing / precios y consumo** | overrides de cantidades (parcial) | (usa quantities/bigquery) | Estratégico #20 (rangos/tramos) + carril B paso 2 (esquema Pricing) | ✓ **prometida** | R | **3** — diseño UX + esquema |
| 18 | **Copilot** | (componentes) | 6 endpoints ✓ + BFF copilot ✓ | Estratégico #21 (MCP) | — | P | **1** |

Fuera de la matriz: `ChargeBeeTest` (descartar), `BancoCentral` como página propia (probablemente
se absorbe en Integraciones/Configuración), `documentacion` (ya migrada al front nuevo).

## Lectura del orden

- **Tren 1 (empezar ya, API lista)**: Integraciones es el candidato ideal para estrenar el patrón
  página→BFF→NestJS — API completa, UI compleja pero sin lógica de negocio en el front, y el
  roadmap casi no la toca. Dashboard/Auth/SII ya están; Agentes y Notificaciones detrás.
- **Tren 2 (construir API + front juntos)**: Contratos → Facturación → Períodos/Revenue →
  Cotizaciones → Legacy. El módulo `contracts` de la API es **el** proyecto grande: sus ~27
  funciones rpc ya son atómicas y probadas, así que la primera versión de cada endpoint puede
  delegar en la función SQL (paridad segura) y migrar lógica a NestJS después, caso a caso.
- **Tren 3 (estratégico, con diseño)**: Pricing, Cobranza/AR, Agentes de operaciones, contratos
  indefinidos (#25), KAME (#24), facturación electrónica nativa (#22). Tocan esquema → pasan por
  la guía de cambios de esquema y el paso 2 del carril B.

## La limpieza tiene dos capas (decisión Domi 14-09)

**Capa 1 — huérfanos** (borrado seguro, casi mecánico): 7 funciones, 12 triggers y 4 policies que
apuntan a objetos inexistentes. Puede correr ya, en paralelo a todo.

**Capa 2 — familias duplicadas/solapadas**: acá viven varios bugs del roadmap, y por eso **no es
una limpieza previa global sino el paso 0 de cada módulo del Tren 2**. Método por familia: mapa de
llamadas (`yarn schema:audit` + inventario rpc + grep en ambos repos) → elegir la función canónica
por operación → resolver ahí los ítems del roadmap de esa familia → retirar el resto con el
procedimiento de borrado. La API nace envolviendo **una** función por operación, no cuatro.

Familias identificadas en el catálogo vivo (auditoría 14-09):

| Familia | Piezas | Ítems del roadmap que resuelve de raíz |
|---|---|---|
| Generación de facturas | ~8: `generate_invoices_for_contract_item`, `generate_missing_…`, `regenerate_…_for_restructure`, `regenerate_…_from_items`, `sync_invoices_for_contract_item`, 2 triggers al firmar/activar | Tanda 3 #2, Medios #2, familia "líneas aplanadas/multimoneda" |
| Modificaciones de contrato | ~14: `create_contract_*` (renewal ×2 sobrecargas), `apply_quote_downsell_…`, `apply_contract_contraction`, `approve_contract_amendment` (sin protección), auto-renovación, `trg_z_fix_renewal_annual` (un parche hecho trigger) | Complejos #1 completo, Tanda 3 #1 |
| Recalc/standardize | `standardize_invoice_items` (pisa montos), `_recalc_invoice_header_from_items`, `recalculate_invoice_totals`, `recalc_invoice_status` | Complejos #3 |
| FX | ~10: `fx_rate` ×2, `fx_rate_with_indirect`, `get_fx_rate`, `calculate_contract_fx_rate` ×3, `calculate_contract_fx_amounts` ×2, `convert_amount` | Medios #5, incidente UF |
| RSM | `revenue_schedule_*` + `rsm_*` + `trigger_rsm_*` | Complejos #6 completo |
| Tenancy | `get_user_holding_id` vs `get_current_user_holding_id` + variantes `_safe/_robust/_direct`, `rls_*` vs `is_*` | Unificación al definir autorización (decisión #2) |
| Zoo `updated_at` | ~30 `update_<tabla>_updated_at` idénticas vs `set_updated_at()` canónica | Higiene (baja prioridad, alto volumen) |
| Debug/test | `debug_*`, `test_*` (test_rls_access, debug_user_access…) | Candidatas a capa 1 tras verificar no-uso |

## Cómo entra el roadmap pausado

- Los **fixes SQL** pendientes (Tanda 3, medios de facturación) conviene aplicarlos **antes o
  durante** la construcción del módulo API correspondiente — ahora vía api-sapira
  (migración/asset), ya no como migraciones del front. Cada uno endurece una función que la API
  va a envolver.
- Los **fixes de front viejo** (Tanda 2) valen solo si el módulo viejo va a vivir meses más:
  el tax_rate de razones sociales sí (bomba latente); el resto se reevalúa contra la fecha de
  migración del módulo — si el front nuevo llega primero, el fix se hace directamente ahí.
- Los ítems **en validación (V1–V9)** definen el criterio de paridad: lo que se valide queda como
  comportamiento a replicar; lo que falle se corrige en el módulo nuevo directamente.

## Criterio rector (Domi 14-09)

**Primero cumplir la funcionalidad del sistema — con auditoría y limpieza de funciones y triggers
incluida —, después agregar las mejoras.** Ningún módulo pasa al front nuevo "sucio": su migración
lleva incorporado el paso 0 de saneamiento de su familia de funciones/triggers (capa 2 de la
limpieza), aprovechando de hacer ahí los fixes del roadmap que corresponden a esa familia. Todo
módulo tendrá UI nueva (mockups e ideas viven en `front-sapira`); la paridad funcional saneada es
la meta de cada migración y las mejoras de UX/producto entran como capa siguiente por módulo.

## Decisiones

1. ✅ **Legacy (#15) — resuelta (Domi 14-09)**: se hace con UI nueva como todo lo demás; entra al
   Tren 2 por funcionalidad (endpoints mínimos primero), mejoras después.
2. ⬜ **Autorización**: el BFF ya existe — falta fijar si NestJS propaga el JWT a Postgres (RLS
   sigue vigente) o autoriza en la API con service role. Afecta a todos los endpoints del Tren 2
   y a la familia Tenancy de la limpieza.
3. ⬜ **Dónde vive esta matriz**: hoy en `api-sapira/docs/` junto al inventario; si el desarrollo
   del front se organiza desde `front-sapira`, mover ambos allá en el primer commit autorizado.
4. ⬜ **Orden dentro del Tren 2**: contratos-primero (propuesto: es el núcleo, desbloquea
   facturación, y su saneamiento de familia resuelve Complejos #1/#3 + Tanda 3) vs
   facturación-primero (más dolor de usuarias en el roadmap).

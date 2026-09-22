# 🤖 Sección de spec — Agentes de IA como funcionalidad agéntica

> **Propuesta para revisión de Domi.** Pedido: que los agentes de IA dentro de Sapira ejecuten acciones, levanten alertas y guíen al usuario, analizados como **funcionalidad agéntica** — donde el usuario pueda configurar agentes adicionales a los genéricos de Sapira. Es la capa que materializa el principio transversal "IA como capa de usabilidad" (`03-mejoras-y-brechas.md`). Formato HOY → DELTA.

## HOY (verificado en prod, `docs/automatizaciones/` y api-sapira)

**Tablas** (prod):

- `ai_agents` (16 filas): `holding_id, type, name, is_enabled, schedule (cron), auto_execute, require_approval` — la definición de agente YA es genérica (tipo + cron + aprobación).
- `ai_agent_configs` (122): pares `key / value_json` por agente (plantillas, días, umbrales). `client_agent_configs` (0): override por cliente (`agent_type, is_enabled, config_json`).
- `ai_runs` (0) y `ai_messages` (0): ejecuciones (status, stats, aprobador) y mensajes (dirección, canal, destinatario, cuerpo) — **schema correcto, nunca usado en prod**.
- `app_notifications` (3): `source, type, severity, title, message, **recommendation, action_type, action_payload**, deduplication_key, status, resolved_at, resource_type/id` + suscripciones por rol — **ya es una notificación ACCIONABLE** (explica + recomienda + ofrece acción).
- `claude_skills` (2): `name, description, input_schema, holding_id, is_active` — **registro de herramientas del copilot**.
- Familia duplicada vacía: `agents / agent_logs` (🔀 se unifica).

**Código**: api `modules/agents` (scheduler cada minuto, processors `proforma` / `collections` / `deal_validation`, modos preview/execute, `approveRun`), `modules/claude` (SDK Anthropic), `modules/sapira-copilot` (sesiones + chat), RAG 100% Supabase (pgvector, catálogo semántico, text-to-SQL sobre vistas `analytics.*`, `rsm_metrics`), edge functions `rag-chat` / `data-gateway`, `modules/notifications`. Front: `/automatizaciones` (config global y por cliente, cron, plantillas HTML con variables, aprobación manual, historial de runs), copilot flotante con widgets, `/notificaciones`, y `/agentes-ia` (mock sin conectar).

**Lectura honesta** (la dice el propio doc del módulo): _"aunque se denominan agentes, conceptualmente son automatizaciones programadas"_. Límites actuales: (1) los agentes son **3 tipos hardcodeados** como processors — el usuario no puede crear otros; (2) el único trigger es **cron**; (3) la **acción está fija** en cada processor; (4) **copilot y agentes son dos mundos separados** (uno consulta, los otros ejecutan, sin tocarse); (5) las notificaciones accionables casi no se generan (3 filas); (6) **nunca han operado en prod** (`ai_runs = 0`).

## DELTA — qué es "funcionalidad agéntica" en Sapira

**Definición de agente (v1.2)**: `Trigger` + `Alcance/condición` + `Acciones` (del catálogo) + `Política de aprobación` + `Canal/destinatarios` + `Explicación al usuario`. Los genéricos de Sapira son **plantillas** de esa misma definición; el usuario crea los suyos clonando o desde cero.

Cuatro piezas nuevas sobre lo existente:

1. **Catálogo de acciones (tools)** — acciones seguras expuestas por los servicios NestJS (que el paso 4 deja limpios): enviar recordatorio de cobranza, generar/enviar proforma, solicitar OC/HES, proponer NC, marcar factura en cero como pagada, bloquear/liberar emisión, vincular partner Odoo, completar producto de ítem, programar renovación, crear alerta, consultar datos. Cada acción declara `input_schema`, `efecto_economico` (sí → aprobación por defecto), permiso requerido y es auditable. **Semilla: `claude_skills`** (ya tiene name/description/input_schema) → se vuelve el registro único de tools compartido por agentes, copilot y MCP.
2. **Triggers más allá del cron**: evento del **event log tipado** (decisión A6: factura emitida descuadrada, vencida, OC recibida, partner sin vincular, ítem sin producto…), **regla/umbral** sobre datos (consumo > 90 % del contrato, AR vencido > X, ítem vence en 30 días), cron (existe), y **solicitud en lenguaje natural**.
3. **Builder de agentes configurables por el usuario**: elige trigger → filtros de alcance (holding / cliente / segmento / contrato / monto) → acciones del catálogo → plantilla de mensaje → aprobación (`auto` | `requiere OK` | `solo sugiere`) → destinatarios y canal. Los 3 agentes actuales + un set estándar de alertas = **plantillas precargadas de Sapira**, clonables y ajustables. Guardrails: solo acciones del catálogo (nunca código libre), alcance por holding, aprobación por defecto si hay efecto económico, runs/mensajes auditados (tablas ya existentes), dedup y límites de frecuencia (ya existen).
4. **Agente conversacional de acción**: el copilot pasa de consultar a **ejecutar con confirmación**, uniendo RAG + catálogo de acciones: _"genera las proformas de marzo de TiMining"_, _"recuérdale a Sinba sus 3 facturas vencidas"_, _"¿qué contratos vencen en 30 días? → programa las renovaciones"_. El mismo catálogo expuesto hacia afuera vía **MCP** (Claude, Slack) = el estratégico #21 sin trabajo adicional.

**Tres familias de agentes** (mapa con los benchmarks): **operativos** (ejecutan: cobranza, proformas, OC, renovaciones — hoy existen 3, se generalizan), **de alertas y guía** (vigilan eventos y reglas, explican la causa y ofrecen el fix — el corazón del principio transversal y del P1 #6), **conversacional** (lenguaje natural + MCP). Referencias: Zenskar (Migration / Actions / Insights agents, Action Agent desde Slack, usage alerts → email o webhook, dunning por segmento), Relvo (OC/HES extraídas por IA desde correos con `needs_review` — "sugerencia para revisión humana, nunca verdad financiera"), Alguna (servidor MCP propio).

## Modelo de datos propuesto (paso 2, sobre las tablas existentes)

| Tabla                     | Veredicto                         | Cambio                                                                                                                                                                                                                                                      |
| ------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai_agents`               | 🔧                                | + `kind (operativo\|alerta\|conversacional)`, + `trigger {type: cron\|event\|rule\|nl, spec}`, + `scope_filters`, + `approval_mode (auto\|approve\|suggest)` (reemplaza el par auto_execute/require_approval), + `is_template` / `created_from_template_id` |
| `ai_agent_actions`        | ➕                                | agente → acción del catálogo, orden, parámetros                                                                                                                                                                                                             |
| `ai_action_catalog`       | ➕ (evolución de `claude_skills`) | `key, name, description, input_schema, has_economic_effect, required_permission, handler, is_active, holding_id (null = global)`                                                                                                                            |
| `ai_runs` / `ai_messages` | 🔧 / ✅                           | + `trigger_payload`, + aprobaciones por acción; se conservan                                                                                                                                                                                                |
| `app_notifications`       | ✅                                | ya accionable; + `agent_run_id` — las alertas de agentes se materializan aquí                                                                                                                                                                               |
| `agents` / `agent_logs`   | 🔀                                | se eliminan (familia duplicada vacía)                                                                                                                                                                                                                       |
| Event log tipado (A6)     | dependencia                       | fuente de los triggers por evento                                                                                                                                                                                                                           |

## Cómo cumple el principio transversal

- **Guiar antes que bloquear**: los agentes de alerta explican la causa, recomiendan y ofrecen el fix en un clic (la notificación accionable ya tiene los campos).
- **IA operativa en el flujo**: agente conversacional con confirmación; sugerencia de corrección cuando un dato es inconsistente (regla + acción "corregir").
- **Avisos proactivos**: triggers por evento y umbral, resúmenes periódicos (el "resumen semanal" pedido por TiMining es un agente de alerta con cron).
- **Autoatención del error de usuario**: el catálogo incluye las reparaciones seguras del doc de orden de operaciones (vincular partner, completar producto, desunificar antes de churn, ajustar a lo emitido…), ofrecidas desde la alerta — sin soporte.

## Fases (incrementales, v1.2)

- **F0 — ahora, costo nulo**: operacionalizar los 3 agentes existentes en los holdings (activar, QA, conectar dominios de envío) — hoy `ai_runs = 0`.
- **F1 — alertas y guía**: agentes de alerta estándar sobre el event log + notificaciones accionables (absorbe P1 #6): factura emitida descuadrada, ítem sin producto, partner Odoo sin vincular, vencimientos, renovaciones, resumen semanal.
- **F2 — catálogo de acciones + builder**: agentes configurables por el usuario con plantillas genéricas clonables.
- **F3 — agente conversacional de acción + MCP**.

Ubicación en el plan: paso 2 (entidades), pasos 4–5 (los servicios limpios son las acciones del catálogo), paso 6 (front: `/automatizaciones` rediseñada como "Agentes", `/agentes-ia` mock se elimina).

## Decisiones para Domi

1. **Nombre de producto**: "Agentes de Sapira" (narrativa de mercado, como Zenskar/Relvo) desde F1, o mantener "Automatizaciones" hasta F2. Propuesta: **Agentes** desde F1 — lo que ya existe es honestamente más que un cron.
2. **Aprobación por defecto** en acciones con efecto económico: siempre requiere OK (propuesto) vs configurable por agente desde el inicio.
3. **Alcance del builder en F2**: primero solo clonar/ajustar plantillas de Sapira (propuesto), o creación libre desde cero.
4. **Canales**: in-app + email ahora; Slack/WhatsApp después (Zenskar/Relvo usan Slack).

## Modelo comercial — los agentes se facturan aparte del software (Domi, 22-08)

La guía agéntica tiene **otro consumo** (tokens, acciones ejecutadas) y se vende como **add-on** al plan base, por tipo de agente. Sapira mide ese consumo con **su propio motor de billable metric/consumo** (dogfooding: `ai_runs` + `ai_messages` ya registran cada ejecución y mensaje → son los eventos de la métrica).

**Tipos de agentes por dominio (catálogo comercial)**:
| Agente | Qué hace | Base del producto hoy |
|---|---|---|
| **Contratos y cotizaciones ganadas** | Convierte una oportunidad ganada (Salesforce/HubSpot/manual) en contrato, upsell o downsell guiado: propone el cambio, muestra el preview, el usuario confirma | Flujo AssignToContract + RPCs de lifecycle + import SF |
| **Facturación** | Prepara el ciclo del mes, detecta desvíos plan↔factura, propone ajustes/regeneración, aplica el gate OC/HES, explica bloqueos | Scheduler de facturas, proformas, referencias |
| **Cobranza y proformas** | Recordatorios escalonados, solicitud de OC/HES, promesas de pago, proformas | Agentes existentes `collections` / `proforma` |
| **Alertas y guía** | Vigila eventos y reglas, explica errores de usuario y ofrece la reparación en un clic; resúmenes periódicos; alertas de presupuesto | `app_notifications` accionables + event log |
| **Analítico / conversacional** | Preguntas en lenguaje natural, insights, acciones con confirmación; MCP hacia afuera | Copilot RAG + `claude_skills` |

**Métrica de cobro del add-on**: agente activo por mes (fijo) + **acciones ejecutadas** o tokens (variable, por tramos — el mismo motor de pricing de la sección 1). Decisión para Domi: ¿"Alertas y guía" va incluido en el plan base (es usabilidad) y el resto como add-on? Propuesta: sí — alertas/guía en base; contratos, facturación, cobranza y analítico como add-ons.

# Spec · API key de Sapira y MCP de Sapira

> **v1 · 19-10-2026 · decisiones 1–8 tomadas con Domi; nada construido.** Fuentes: código de `api-sapira` y `front-sapira`,
> consultas de solo lectura en producción, [`documentacion-publicable-y-mcp.md`](./documentacion-publicable-y-mcp.md) (22-08),
> [`spec-agentes-ia.md`](./spec-agentes-ia.md), [`autorizacion-y-tenancy.md`](./autorizacion-y-tenancy.md) § "Próximas capas",
> ingeniería inversa de Zenskar, Alguna, Chargebee, Zuora, DualEntry y Maxio, la spec MCP (2025-06-18) y el skill `mcp-builder`.
> El benchmark profundo (workflow `deep-research`, 10 plataformas) se anexa en §9 cuando llegue.
>
> Reglas del bloque (Domi, 19-10): spec corta + OK antes de construir cada fase; código y migraciones después del OK; nada en
> prod sin OK y respaldo; sin marcas en la UI; análisis de impacto en cada cambio a lo que ya corre.

## 0. En simple

Dos piezas, construidas en este orden:

1. **API key de Sapira**: una clave por holding, con alcances, para que un cliente conecte sus sistemas o scripts a la API
   sin usar una sesión de persona. Se administra en **Administración › API y conexiones**.
2. **MCP de Sapira**: un servidor remoto en `api.aisapira.com/mcp` para que Claude, Cursor u otro asistente lean (y después,
   con confirmación, escriban) en Sapira. Se autentica con la API key **o** con la cuenta de la usuaria (OAuth de Supabase).

Las dos comparten lo que ya existe: `HoldingScopeGuard`, `RequirePermissionGuard` y los servicios de los módulos v2. El MCP
y los agentes comparten además un **catálogo único de acciones** (§6): un tool del MCP y una acción de un agente son el mismo
handler.

**Orden acordado (decisión 6):** mejoras cortas → **API key** → Automatizaciones + Slack/Teams → agentes (nace el catálogo)
→ MCP de lectura → escrituras por MCP.

## 1. HOY (verificado 19-10)

- **Autorización:** `SupabaseAuthGuard` (Bearer = JWT de Supabase, validado con `auth.getUser`) → `HoldingScopeGuard`
  (`x-holding-id` + fila activa en `user_holdings`) → `RequirePermissionGuard` (`PermissionsService.assert`: códigos del
  rol en el holding activo, `EDIT_X ⊇ VIEW_X`, `ALL_PERMISSIONS`, super admin). Opt-in por controlador: 73 controladores y
  732 rutas; 37 controladores con `HoldingScopeGuard`, 15 con permisos, 13 rutas `@Public()`.
- **Catálogo `permissions`:** 23 códigos (`VIEW_/EDIT_` por módulo, `CLOSE_PERIODS`, `ALL_PERMISSIONS`, legacy). Sirven
  como alcances de una key sin inventar otro modelo.
- **No existe API key** ni token de servicio. `x-api-key` ya está en la allowlist CORS (se usa con Odoo). Rate limit en memoria
  por IP (500 req/min, `rate-limiter.middleware.ts`). Sin `Idempotency-Key` ni `X-Request-Id`. Swagger público en prod
  (pendiente de Leon, [`revision-seguridad-api.md`](./revision-seguridad-api.md) § C).
- **Preview → commit ya es el patrón de la API:** casi toda escritura tiene su `/preview` (contratos, facturas, pagos,
  consumos, cotizaciones, cobranza, cambios programados). Los tools de escritura del MCP lo heredan.
- **IA existente:** `modules/claude` (SDK Anthropic 0.71) con **35 skills de solo lectura en código**
  (`claude/skills/catalog/*`: MRR, cMRR, contratos, facturas, cohortes, cotizaciones) ejecutadas por `DynamicQueryBuilder`
  con filtro por holding; la tabla `claude_skills` tiene 2 filas. `sapira-copilot` usa `copilot_sessions`, **tabla que no
  existe en prod**. `ai_agents` 16 (8 proforma, 8 cobranza), ninguno automático; `ai_runs`, `ai_messages` y
  `rag_documents` en 0. Tenancy: 7 holdings, 30 usuarios, 35 membresías, 70 roles.
- **Supabase prod ya tiene las tablas del OAuth 2.1 server** (`auth.oauth_clients`, `oauth_authorizations`,
  `oauth_consents`; 0 clientes): Supabase Auth puede ser el *authorization server* del MCP (registro dinámico de clientes,
  PKCE, discovery en `/.well-known/oauth-authorization-server/auth/v1`). La página de consentimiento la construye el front.
  Sin costo extra (un agente cuenta como MAU de la usuaria).

## 2. Referentes (resumen; detalle en §9 cuando llegue el benchmark)

| Plataforma | Auth del MCP | Tools | Qué copiamos |
|---|---|---|---|
| Zenskar | `x-api-key` o bearer; local (npm, stdio) | su doc lista ~100 operaciones; "103 tools tipadas" refutado en §9 | Generar del catálogo, no documentar aparte; auditoría = la de la API |
| Alguna | OAuth con registro dinámico (hereda rol) **o** API key vía `mcp-remote` | lectura y escritura | Remoto en `api…/mcp`; keys en Settings › Developers; `llms.txt`; `Idempotency-Key`; `X-Request-Id` |
| Chargebee | API key (≤ 5 por servidor) u OAuth limitado por el usuario | servidores "custom" por toolsets | Límite de keys; elegir qué expone cada servidor |
| Zuora | OAuth; **modo por tenant** lectura / lectura-escritura | lectura + escritura | Admite que no puede imponer aprobación por acción vía MCP → switch por tenant |
| DualEntry | solo OAuth 2.1 | 15 (11 lectura, 4 escritura), preview antes de crear | "Controles en el modelo de datos, no en la UI"; el humano aprueba |
| Maxio | Basic auth por subdominio | sin MCP | Nada |

Spec MCP 2025-06-18: la autorización es opcional; para HTTP recomienda OAuth 2.1 con *protected resource metadata*
(RFC 9728), `WWW-Authenticate` en el 401, PKCE y `resource` (RFC 8707); los tokens deben estar emitidos para el servidor
(audiencia) y nunca se reenvían a otra API. La API key como bearer no es "spec" pero es lo que ofrecen Zenskar, Alguna y
Chargebee. Los conectores de claude.ai y Claude Desktop exigen OAuth; Claude Code, Cursor y n8n aceptan un header.

## 3. API key de Sapira (fase 1)

### 3.1 Modelo (decisión 1: cuenta de servicio por holding)

Tabla nueva `api_keys` (RLS activo, policy solo `service_role`, **sin grants al Data API**):

| Columna | Tipo | Regla |
|---|---|---|
| `id` | uuid | |
| `holding_id` | uuid FK `company_holdings` | la key pertenece al holding |
| `name` | text | único por holding entre las activas ("n8n cobranza") |
| `key_prefix` | text | primeros 14 caracteres (`sk_sapira_ab12`) para mostrar en la lista |
| `key_hash` | text único | SHA-256 del valor completo; **el valor en claro se muestra una sola vez** y no se guarda |
| `scopes` | text[] | códigos del catálogo `permissions`, ⊆ códigos del creador al crearla (`PermissionsService.allows`); nunca `ALL_PERMISSIONS` ni internos |
| `created_by` | uuid FK `users` | quien la creó; firma las acciones hechas con la key |
| `expires_at` | timestamptz NOT NULL | por defecto 1 año, máximo 2; una key vencida responde 401 |
| `last_used_at` | timestamptz | se actualiza como máximo una vez por minuto |
| `revoked_at`, `revoked_by` | timestamptz, uuid | revocación = borrado lógico; nunca se borra la fila |

Formato del valor: `sk_sapira_` + 40 caracteres aleatorios (base62, `crypto.randomBytes`). Máximo **10 keys activas por
holding**. No hay sandbox en Sapira: QA y prod son proyectos distintos, así que una key vale en un solo ambiente.

### 3.2 Autorización con key (mismo portero, decisión 3: allowlist)

- `SupabaseAuthGuard` reconoce el prefijo `sk_sapira_`: busca por hash, exige no vencida ni revocada y deja
  `request.principal = { kind: 'api_key', id, holdingId, scopes, name, createdByUserId }`. Con JWT de Supabase deja
  `{ kind: 'user', authId }` (lo de hoy).
- `HoldingScopeGuard`: con principal `api_key`, el holding **sale de la key**; si llega `x-holding-id` debe coincidir
  (403 si no). No consulta `user_holdings`.
- `RequirePermissionGuard` / `PermissionsService.assert`: con principal `api_key` el contexto es
  `{ userId: created_by, name: 'API key <nombre>', codes: scopes, isSuperAdmin: false, roleId: null }`. Las reglas
  `EDIT ⊇ VIEW` se mantienen; `ALL_PERMISSIONS` no existe en una key.
- **Allowlist:** decorador `@ApiKeyAccess()` en el controlador (o la ruta). Una key que llega a una ruta sin el decorador
  recibe 403 "Esta ruta no está disponible con API key". Superficie v1 = controladores de los módulos v2: `clients`,
  `client-entities`, `client-contacts`, `quotes`, `contracts`, `billing`, `metrics`, `products`, `prices`, `catalog`,
  `settings` (solo lecturas), `agents` (solo lecturas). Nada de integraciones, Odoo, Salesforce, Stripe, BigQuery ni rutas legacy.
- **Rate limit por key:** 300 req/min (configurable), 429 con `Retry-After`. **`X-Request-Id`** en toda respuesta de la API
  (lo pide el patrón Alguna y sirve a soporte).
- **Auditoría:** `last_used_at` + el log de telemetría con `api_key_id`. Las acciones quedan firmadas por `created_by`; en
  historiales que muestran "quién" se agrega el sufijo "(API key <nombre>)" cuando el contexto viene de una key. Límite
  conocido: si se desactiva al creador, sus keys siguen vivas (es una cuenta de servicio); se muestra en la lista para que
  un administrador decida.
- La key **nunca** se registra en logs; los errores de autenticación no dicen si existe o no.

### 3.3 Endpoints (`settings`, permiso `EDIT_CONFIGURACION`, decisión 4)

| Método y ruta | Qué hace |
|---|---|
| `GET /settings/api-keys` | Lista del holding: `{ id, name, key_prefix, scopes, created_by_name, created_at, expires_at, last_used_at, revoked_at }` |
| `POST /settings/api-keys` — `{ name, scopes[], expires_at? }` | Crea; responde **una sola vez** `{ ...fila, key: 'sk_sapira_…' }`. 409 si el nombre se repite o hay 10 activas; 403 si un scope supera los permisos del creador |
| `POST /settings/api-keys/:id/revoke` | Borrado lógico; 404 si es de otro holding; 409 si ya estaba revocada |
| `GET /settings/api-keys/scopes` | Códigos que el creador puede otorgar, con etiqueta en español (sin marcas) |

Sin `PATCH`: cambiar scopes o nombre = revocar y crear (así el cliente rota y no hereda permisos por error).

### 3.4 Front (decisión 2: Administración › API y conexiones)

- Tercera pestaña de `ConfiguracionView` junto a *Holding y compañías* y *Usuarios y permisos*. Dos bloques: **Claves de
  API** (lista, crear en drawer con nombre, alcances por módulo y vencimiento; modal "copia tu clave ahora, no la volverás a
  ver"; revocar con `AlertDialog`) y **Conexiones de asistentes** (fase 2: clientes OAuth autorizados, con desconectar).
- BFF `app/api/configuracion/api-keys/*` (cubierta por `PERMISOS_BFF` de la carpeta `configuracion`), schemas Zod espejo de
  los DTO, hook `use-api-keys.ts`. Botones con `ConPermiso` (`EDIT_CONFIGURACION`), deshabilitados con aviso (regla de
  Administración).
- Centro de ayuda: `administracion/claves-de-api.md` ("qué es, para qué, cómo crear, alcances, rotar, revocar") y novedad.

### 3.5 Tests obligatorios

API: hash y formato; vencida / revocada → 401; holding de la key vs header; scope faltante → 403 con la frase estándar;
`ALL_PERMISSIONS` rechazado al crear; ruta sin `@ApiKeyAccess()` → 403; límite de 10; rate limit; el valor en claro no
aparece en logs ni en `GET`. Front: BFF (header, Zod, 409), vista (crear, copiar una vez, revocar, permisos).

### 3.6 Tamaño

API: 1 sesión (entity + migración + servicio + guards + endpoints + tests + nota en `docs/cambios`). Front: 1 sesión
(pestaña, BFF, hook, ayuda, tests). Migración en QA y prod con OK de Domi (tabla nueva, sin tráfico).

## 4. MCP de Sapira (fase 2: lectura; fase 3: escrituras)

### 4.1 Stack (decisión 7)

- Dentro de `api-sapira`: módulo `src/modules/mcp/` con el **SDK oficial TypeScript v2** (`@modelcontextprotocol/server`,
  `@modelcontextprotocol/node`), **streamable HTTP sin estado** (una instancia de servidor por request, creada con el
  principal ya autenticado). Sin variante stdio. Requiere Node 20+ (verificar la versión del deploy antes de empezar).
- Montaje: controlador `@All('mcp')` que pasa `req`/`res` al handler del SDK; la autenticación la hace la misma cadena de
  guards de la API (§3.2), así que `request.principal` llega resuelto. Dos rutas públicas mínimas para la spec:
  `GET /.well-known/oauth-protected-resource` (apunta al authorization server de Supabase) y el `WWW-Authenticate` en el 401.
- Recurso canónico: `https://api.aisapira.com/mcp`. Hosts permitidos explícitos (sin DNS rebinding).
- Los tools llaman a los **servicios** de los módulos v2 (no a vistas ni SQL propio): una sola fuente, mismos permisos.

### 4.2 Autenticación (decisión 5: key + OAuth)

| Cliente | Cómo entra | Holding | Permisos |
|---|---|---|---|
| Claude Code, Cursor, n8n, scripts | `Authorization: Bearer sk_sapira_…` | el de la key | scopes de la key |
| claude.ai, Claude Desktop (conectores) | OAuth 2.1 de **Supabase Auth**: registro dinámico de clientes, PKCE, consentimiento en `front-sapira` (`/oauth/consent`, muestra nombre del cliente y "Permitir / Denegar"), revocación desde *API y conexiones* | `user_holdings.selected`; `sapira_select_holding` solo si la usuaria tiene más de un holding (super admin) | rol de la usuaria en ese holding |

Verificación del token OAuth: firma por JWKS de Supabase, emisor del proyecto y **cliente OAuth registrado** (claim del
cliente); se confirma al construir qué claim de audiencia emite Supabase para cumplir RFC 8707. Las sesiones normales del
front (mismo JWT) también sirven para probar desde el Inspector.

Pasos fuera del código: activar el OAuth 2.1 server en el proyecto Supabase (prod y QA) con registro dinámico y aprobación
por usuaria; es una decisión de plataforma, se hace con Leon.

### 4.3 Catálogo de tools v1 (solo lectura)

Convención: `sapira_<verbo>_<recurso>` en snake_case, `title` y `description` en español pensados para el modelo (qué
devuelve, cuándo usar el tool hermano, un ejemplo), `annotations.readOnlyHint = true`, paginación `limit` (20, máx 100) +
`offset` + `has_more` + `total`, parámetro `response_format` `markdown` (por defecto) o `json`, tope de 25 000
caracteres con aviso de truncado, `structuredContent` con el mismo contrato que la BFF. Errores accionables ("No encontrado;
`sapira_list_clients` devuelve ids válidos", "Sin permiso VIEW_FACTURACION: pídelo a un administrador"). Textos de la API
pasan por `sinMarcas`.

| Dominio | Tools | Endpoint de origen |
|---|---|---|
| Contexto | `sapira_get_context` (holding, compañías, monedas, quién soy, permisos, modo del MCP), `sapira_list_holdings`, `sapira_select_holding` (solo multi-holding) | `/users/me/context`, `/holdings` |
| Clientes | `sapira_list_clients`, `sapira_get_client` (resumen + razones sociales), `sapira_list_client_entities`, `sapira_get_client_receivables`, `sapira_get_client_activity` | `/clients*`, `/client-entities*` |
| Cotizaciones | `sapira_list_quotes`, `sapira_get_quote` | `/quotes*` |
| Contratos | `sapira_list_contracts`, `sapira_get_contract` (overview + ítems), `sapira_get_contract_schedule`, `sapira_list_contract_invoices` (con desvíos), `sapira_get_contract_consumption`, `sapira_list_renewal_proposals`, `sapira_get_contract_history` | `/contracts*` |
| Facturación | `sapira_list_invoices`, `sapira_get_invoice` (pagos y correos), `sapira_list_invoices_to_issue` (con bloqueos por referencia), `sapira_list_credit_notes`, `sapira_list_payments`, `sapira_get_receivables_aging`, `sapira_get_receivables_forecast`, `sapira_get_billing_calendar` | `/billing*` |
| Métricas e ingresos | `sapira_get_mrr_overview`, `sapira_get_mrr_movements`, `sapira_get_mrr_by_dimension`, `sapira_get_churn`, `sapira_get_renewals`, `sapira_get_cohorts`, `sapira_get_bookings`, `sapira_get_revenue_summary`, `sapira_get_revenue_by_dimension`, `sapira_get_revenue_schedule`, `sapira_list_revenue_exceptions` | `/metrics*` |
| Precios | `sapira_list_products`, `sapira_list_prices` | `/products`, `/prices`, `/catalog` |
| Automatizaciones | `sapira_list_agent_runs`, `sapira_get_agent_run` | `/agents/runs*` |

Unos 38 tools. Los 35 skills del copilot **no se duplican**: sus consultas que no tengan endpoint (cohortes de booking a
pago, momentum por producto) pasan a `/metrics/*` o se suman como tools con la misma fuente, y el copilot migra al catálogo
único (§6).

### 4.4 Escrituras v1.1 (decisión 8)

- **Switch por holding:** `holding_settings.mcp_mode` = `read_only` (por defecto) | `read_write`; lo cambia un
  administrador desde *API y conexiones*. En `read_only` los tools de escritura **no se listan**.
- Cada escritura espeja un par existente de la API: `sapira_preview_<x>` (lectura, devuelve el preview) y `sapira_<x>`
  con `confirm: true` obligatorio y `idempotency_key` (se reenvía como `Idempotency-Key`; la API la implementa en estas
  rutas). Exige el scope `EDIT_*` del módulo. `destructiveHint: true` en anular factura y nota de crédito.
- Candidatas v1.1: crear cotización, crear contrato desde cotización, registrar consumo, registrar pago, solicitar
  referencia (proforma), enviar recordatorio de cobranza, reprogramar factura, marcar emitida, anular, nota de crédito,
  nota en la actividad del cliente. Cada una con su caso dorado.
- Nunca por MCP: borrar, cerrar períodos, cambiar permisos, administrar keys o integraciones.
- **D9 (pendiente):** aprobación en el servidor con token de un solo uso para las escrituras con efecto económico, además
  de `confirm` (§9.3, punto 3).

### 4.5 Resources y prompts

- **Resources:** `sapira://ayuda/<modulo>/<articulo>` (el centro de ayuda en markdown, que ya vive en
  `front-sapira/docs/documentacion-funcional`; para servirlo, el sitio público publica `llms.txt` y el markdown crudo
  por URL, y el MCP los proxyea con caché) y `sapira://glosario`.
- **Prompts:** `cierre_de_facturacion_del_mes`, `vencimientos_de_la_semana`, `seguimiento_de_cliente` (el seguimiento
  manual del caso TiMining: Por Emitir atrasadas, bloqueadas por referencia, productos vencidos sin decisión),
  `revisar_renovaciones`.

### 4.6 Gobierno, auditoría y límites

- Tabla `mcp_tool_calls` (`holding_id`, `principal_kind`, `principal_id`, `tool`, `params_json` sin secretos, `status`,
  `duration_ms`, `mcp_client`, `created_at`): auditoría y, más adelante, la métrica de consumo del add-on (spec de agentes).
  Se muestra al administrador en *API y conexiones* con filtros por fecha, tool, estado y cliente (patrón Stripe, §9.3).
- Rate limit por principal (300 req/min). Timeout por tool 30 s, cancelación propagada.
- Pestaña *API y conexiones* lista las conexiones OAuth autorizadas y permite desconectarlas.

### 4.7 Evaluación (fase 4 del skill) y tests

- 10 preguntas de solo lectura, respuesta única y estable, sobre un holding estable (Hanka demo), corridas con el script
  de evaluación del skill `mcp-builder` y probadas con `@modelcontextprotocol/inspector`. Son los **casos dorados** del
  DoD documental y se guardan en `src/modules/mcp/evaluation/`.
- Tests: autenticación (key, JWT, vencidos, audiencia), holding, permisos por tool, modo `read_only` oculta escrituras,
  `confirm` e idempotencia, truncado y paginación, un test por tool contra el servicio simulado.

### 4.8 Tamaño

Lectura: 2–3 sesiones de API (módulo, verifier, catálogo, tools, evaluación) + 1 de front (consent page, pestaña de
conexiones, ayuda "Conectar Sapira con tu asistente de IA"). Escrituras: 1–2 sesiones después de los agentes.

## 5. Documentación y DoD

- Centro de ayuda: `administracion/claves-de-api.md`, `administracion/conectar-un-asistente-de-ia.md`, novedades.
- Técnica: `docs/guards/` (principal y allowlist), `contrato-api-configuracion.md` (endpoints de keys), README del módulo
  `mcp`, `documentacion-publicable-y-mcp.md` actualizado (el catálogo pasa de propuesta a construido).
- Reglas: `AGENTS.md` de ambos repos (una ruta nueva de módulo v2 decide si lleva `@ApiKeyAccess()`; todo tool es un
  endpoint; nada escribe por MCP sin preview + confirm). `.cursor/rules` a la par.
- OpenAPI público **filtrado a la superficie con `@ApiKeyAccess()`** y descripciones LLM-ready en esos controladores; el
  Swagger completo deja de ser público (bloque de seguridad de Leon).

## 6. Catálogo único de acciones (puente con agentes y copilot)

Un registro en código (`src/modules/ai-catalog/`): `{ key, title, description, inputSchema (Zod), outputSchema,
permission, hasEconomicEffect, handler(principal, input) }`. De ahí se **generan** los tools del MCP, los tools del copilot
y las acciones que un agente ejecuta tras la aprobación. Nace con los agentes (orden acordado) y el MCP de lectura es su
primer consumidor externo. La tabla `claude_skills` se retira cuando el copilot migre.

## 7. Seguridad y coordinación con Leon

- Antes de exponer la API con keys: cerrar #11 y #16 de la revisión de seguridad (ya en el carril de Leon) y Swagger fuera
  de producción. La allowlist evita depender del resto del bloque.
- `/claude/message` (proxy abierto, #13) no entra en la allowlist y se retira con el catálogo único.
- Activar el OAuth 2.1 server de Supabase es un cambio de configuración del proyecto: lo hacen Domi y Leon juntos, QA
  primero.

## 8. Decisiones tomadas (Domi, 19-10) y pendientes

| # | Decisión | Resultado |
|---|---|---|
| 1 | Qué es una key | Cuenta de servicio por holding con scopes ⊆ permisos del creador |
| 2 | Dónde vive la UI | Administración › API y conexiones |
| 3 | Superficie v1 | Allowlist explícita (`@ApiKeyAccess()`) de módulos v2 |
| 4 | Quién crea y revoca | `EDIT_CONFIGURACION` |
| 5 | Auth del MCP | API key + OAuth 2.1 de Supabase Auth |
| 6 | Orden | Mejoras cortas → API key → Automatizaciones + Slack/Teams → agentes → MCP lectura → escrituras |
| 7 | Stack | Dentro de api-sapira, SDK v2 oficial directo, `/mcp` sin estado |
| 8 | Escrituras | Switch por holding + `confirm` tras preview + `Idempotency-Key` + `destructiveHint` |

Pendientes menores (se resuelven al construir, sin OK extra): etiquetas en español de los scopes; vencimiento por
defecto (1 año); si `sapira_select_holding` se expone a usuarias de un solo holding (no); claim de audiencia de los tokens
OAuth de Supabase. **Pendientes de decisión:** **D9** aprobación en el servidor (token de un solo uso, 24 h) para escrituras con efecto
económico, sobre el `confirm` (§9.3); **D10** empaquetado comercial del MCP (incluido vs add-on): el benchmark no lo
resuelve (ninguna plataforma publica precio), se decide con la spec de agentes.

## 9. Benchmark profundo (workflow `deep-research`, 19-10: 24 fuentes, 105 afirmaciones, 25 verificadas a 3 votos, 22 confirmadas, 3 refutadas)

**Cobertura real.** Evidencia verificada solo para **Stripe, Chargebee, Zuora, Zenskar** y, en API keys, **Metronome**. De
Alguna, Maxio, Orb, Recurly y Relvo no sobrevivió ninguna afirmación (no significa que no tengan MCP). Alguna y DualEntry
se mantienen en §2 por lectura directa de su documentación el mismo día, sin verificación cruzada. Sin evidencia para
nadie en: precio del acceso MCP, lista oficial de clientes soportados, `llms.txt`, idempotencia y rate limits del MCP.

### 9.1 Lo confirmado, por plataforma

| Plataforma | MCP | Auth | Tools | Gobierno |
|---|---|---|---|---|
| **Stripe** | Remoto `mcp.stripe.com` + npm local | OAuth por usuaria con permisos distintos en live y sandbox **y** "agent API keys" (`rk_` restringidas con etiqueta Agent) como Bearer. Desde el 30-11-2026 deja de aceptar `sk_` y `rk_` sin etiqueta; una key no soportada recibe 401 con *discovery challenge* OAuth | **15 tools a mano**: dos "gateway" (`stripe_api_read` para GET, `stripe_api_write` para el resto) sobre una allowlist de ~150 métodos, más búsqueda de docs, planner y analytics; evita una tool por endpoint para no inflar el contexto | **Aprobación humana en el servidor** para escrituras sensibles (reembolsos, pagos salientes): la tool devuelve una URL, el humano aprueba en Stripe, se emite un *approval token*, el agente reintenta; vence a las 24 h. Toggle de MCP por equipo y por entorno; sesiones OAuth listadas y revocables por admins; **log de tool calls** (estado, argumentos, respuesta, cliente) en Workbench |
| **Stripe keys** | — | Restricted keys `rk_live_`/`rk_test_`, creadas con 2FA, se muestran una vez, **Read / Write / None por recurso, Write incluye Read**, mapeo por método HTTP; error 403 dice qué permiso falta; recomendadas explícitamente para agentes en vez de `sk_` | — | Rotación de `sk_` con hasta 7 días de solape; sin expiración documentada |
| **Chargebee** | Remoto por sitio `<sub>.mcp.chargebee.com/<slug>` (EU, AU); servidores **custom componibles** desde el catálogo completo con **toggle por tool**, más tres predefinidos | API key Bearer por servidor (máx. 5, acceso a todas las tools habilitadas) **o** OAuth por usuaria (hereda su nivel de acceso); OAuth no disponible con Multi-Business Entity | Número no establecido | Borrar el servidor revoca keys y clientes OAuth; sin aprobación server-side documentada. API REST: Basic auth con key por sitio, tipos full / publishable / read-only, rotación sugerida cada 3 meses |
| **Zuora** | npm local + remoto por tenant; **beta, solo sandbox**, se activa por ticket (doc del 08-10-2026) | Solo OAuth (OneID): un cliente estático por MCP client, sin registro dinámico, sin API keys | Lectura; escritura solo en modo Supervised | **Modo por tenant Read-Only / Supervised** (sandbox 16-06, prod 07-07-2026) + rol de la usuaria. **No aprueba por acción en el servidor**: lo delega al cliente MCP; la tool `zuora_approval` fue eliminada en la 1.0.0 ("todo se ejecuta de inmediato") |
| **Zenskar** | Solo npm local (`mcp-zenskar`, stdio, creado 09-2025); sin remoto | `x-api-key` o JWT de sesión del navegador (prefijo `eyJ`) por variables de entorno o **inline en cada tool call**; sin OAuth | La cifra "103 tools tipadas" fue **refutada 0-3** mirando el paquete; su doc sí lista operaciones por nombre | Nada documentado |
| **Metronome** | Sin MCP oficial | Tokens creados en la app, se ven una vez, **heredan los permisos del creador**; nombre del token en los audit logs; archivar es irreversible | — | Restricción de scopes vía soporte: voto 1-2, no establecido |

**Spec MCP (2025-06-18 y 2025-11-25):** autorización **opcional**; con HTTP el perfil OAuth 2.1 es SHOULD, con stdio es
SHOULD NOT. Una API key como Bearer **no viola la spec**: queda fuera del perfil OAuth, y en cuanto el servidor adopta ese
perfil entran los MUST (RFC 9728, `resource` y audiencia RFC 8707, no aceptar otros tokens). Lo que cambia en 11-25 es el
registro de clientes (CIMD pasa a SHOULD, registro dinámico a MAY) y el discovery. Los directorios de conectores
(claude.ai, ChatGPT) exigen OAuth o sin auth. Stripe es exactamente ese diseño: OAuth con *discovery challenge* en el 401
más keys de agente como Bearer.

### 9.2 Huecos que nadie cubre junto (y que esta spec sí)

(a) **Preview obligatorio antes de escribir** con el resultado del preview como requisito del commit: ninguno expone tools
de preview (Stripe aprueba pero no previsualiza; DualEntry previsualiza solo contratos y activos). (b) **Aprobación humana
en el servidor** con token de un solo uso y vencimiento: solo Stripe, y solo para algunas acciones. (c) **Keys con alcance
de holding + módulo `VIEW_/EDIT_`**: Stripe escopa por recurso y Chargebee por toolset y rol, ninguno modela una jerarquía
de tenants ni una identidad de agente distinta de la usuaria. (d) **Modo por tenant** (Zuora) + toggle por entorno (Stripe)
+ toggle por tool (Chargebee) en un solo lugar. (e) **Bitácora de acciones del agente** visible al administrador del
tenant: solo Stripe. (f) Key con nombre, vista una vez, rotación con solape, máximo y revocación inmediata: fragmentos en
Chargebee, Stripe y Metronome. (g) Idempotencia, rate limit por key, `llms.txt` y OpenAPI público: sin evidencia en ninguno.

### 9.3 Qué cambia en esta spec por el benchmark

1. **Validado sin cambios:** cuenta de servicio con scopes ⊆ permisos y sin `ALL_PERMISSIONS` (Stripe deja de aceptar
   keys de acceso total para agentes); `EDIT ⊇ VIEW` (Stripe: Write implica Read); key + OAuth (Stripe, Chargebee, Alguna);
   switch por holding (Zuora); preview + confirm (hueco a); tabla `mcp_tool_calls` (hueco e); máximo de keys (Chargebee 5;
   nosotros 10). Evitar lo de Zuora (beta solo sandbox, aprobación delegada al cliente) y lo de Zenskar (solo local, JWT de
   sesión como credencial, credenciales inline en la tool call).
2. **Se agrega (§4.6):** el log de tool calls se muestra al administrador en *API y conexiones* (estado, tool, argumentos
   sin secretos, respuesta resumida, cliente MCP, fecha), con filtros, como el Workbench de Stripe. El mensaje de 403 de
   una key dice **qué scope falta** (patrón Stripe).
3. **Se agrega (§4.4) una capa sobre `confirm`, pendiente de decisión (D9):** para escrituras con efecto económico (anular,
   nota de crédito, enviar cobranza, marcar emitida, registrar pago) la tool no ejecuta con `confirm: true`: devuelve
   "pendiente de aprobación" con enlace a Sapira; la usuaria aprueba en la app (notificación accionable / `ai_runs`, el
   mismo flujo de los agentes) y el agente reintenta con el **token de aprobación** (un solo uso, vence a las 24 h). Es el
   patrón Stripe y cierra el hueco (b). `confirm: true` basta para escrituras sin efecto económico (nota, consumo,
   solicitud de referencia, reprogramar).
4. **Se anota (§4.3):** si el catálogo crece más allá de ~40 tools, el patrón Stripe de dos tools "gateway" (`sapira_read`
   / `sapira_write` sobre una allowlist de operaciones) es la alternativa para no inflar el contexto del modelo. v1 va con
   tools por recurso (como DualEntry, 15) porque la superficie es acotada.
5. **Sigue pendiente:** empaquetado comercial (ninguna fuente lo publica) y la lista oficial de clientes soportados.

Fuentes primarias del benchmark: [Stripe MCP](https://docs.stripe.com/mcp), [Stripe restricted keys](https://docs.stripe.com/keys/restricted-api-keys),
[Chargebee custom MCP](https://www.chargebee.com/docs/billing/2.0/ai-in-chargebee/custom-mcp-server), [Chargebee API keys](https://chargebee.com/docs/billing/2.0/site-configuration/api_keys),
[Zuora MCP](https://docs.zuora.com/en/zuora-ai/zuora-mcp-server) y [modos de tenant](https://docs.zuora.com/en/zuora-ai/change-the-ai-mode-for-a-tenant),
[Zenskar MCP](https://docs.zenskar.com/docs/mcp-core-concepts) y [paquete](https://github.com/zenskar/mcp-zenskar), [Metronome auth](https://docs.metronome.com/api-reference/authorization),
[spec MCP 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [conectores de Claude](https://claude.com/docs/connectors/building/authentication),
[anotaciones de tools](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/), [OWASP MCP](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html).

## 10. Hallazgos colaterales (fuera de esta spec)

- `copilot_sessions` no existe en prod: crear sesión del copilot falla (revisar si el front nuevo la usa).
- `claude.service.ts` usa un id de modelo antiguo.
- `/claude/message` es un proxy abierto a Claude (revisión de seguridad #13).

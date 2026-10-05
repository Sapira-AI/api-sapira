# Módulo de agentes (Automatizaciones)

Automatiza dos envíos de correo por holding:

- **Proforma**: antes de emitir una factura que exige referencia (OC/HES), pide la referencia al contacto de tipo "Proforma"
  del cliente.
- **Cobranza**: recuerda facturas por vencer o vencidas al contacto de tipo "Cobranza", con niveles de recordatorio.

Los correos salen por el módulo `emails` (SendGrid). Pantallas: `front-sapira` → `/lab/automatizaciones` (en laboratorio), la
pestaña "Automatizaciones" del cliente y la lista de clientes; `front-sapira-vite` → `/automatizaciones` mientras conviven.

Últimos cambios: [`docs/cambios/automatizaciones-permisos-y-envios.md`](../../../docs/cambios/automatizaciones-permisos-y-envios.md)
y [`docs/cambios/automatizaciones-scheduler-y-tenancy.md`](../../../docs/cambios/automatizaciones-scheduler-y-tenancy.md).

## Estructura

```
agents/
├── agents.controller.ts     # REST, guards de holding y permisos
├── agents.service.ts        # ejecución, aprobación, configuración, lecturas
├── agents.scheduler.ts      # cron cada minuto: ejecuta los agentes con auto_execute
├── dtos/                    # class-validator (holding_id solo como campo deprecado del front viejo)
├── helpers/
│   ├── agent-config.helper.ts   # configuración efectiva por cliente y remitente efectivo
│   └── template.helper.ts       # {{variable}}, moneda es-CL, días de atraso
├── interfaces/
└── processors/              # proforma y cobranza
```

## Autorización

`@UseGuards(SupabaseAuthGuard, HoldingScopeGuard, RequirePermissionGuard)`. El holding sale de `x-holding-id` (400 sin
header, 403 si el usuario no pertenece o si body/query traen otro). Cada consulta filtra por holding; un registro ajeno es 404.

| Acción | Permiso |
|---|---|
| Leer (agentes, ejecuciones, mensajes, configuraciones, remitentes, resumen, render de plantilla) | `VIEW_AGENTES_IA` |
| Ejecutar, aprobar, descartar, guardar programación o configuración, volver a la global | `EDIT_AGENTES_IA` |

## Endpoints

Todas las respuestas son `{ success: true, data }`.

| Método y ruta | `data` |
|---|---|
| `GET /agents` | `[{ id, type, name, is_enabled, schedule, auto_execute, require_approval, created_at, updated_at }]` |
| `PUT /agents/:agentId/config` — `{ schedule?, auto_execute?, require_approval? }` | fila de `ai_agents` |
| `POST /agents/:agentId/run` — `{ mode: 'preview' \| 'execute' }` | `{ run_id, status, stats, messages[] }` |
| `GET /agents/runs?page&limit&agent_id&type&status` | `{ data: Run[], total, currentPage, pages, limit }` (limit ≤ 100) |
| `GET /agents/runs/:runId` | `Run` + `approver_name`, `message_count` |
| `GET /agents/runs/:runId/messages` | `[{ id, direction, channel, to, subject, body, meta_json, created_at }]` |
| `POST /agents/runs/:runId/approve` | `{ run_id, status: 'sent' \| 'error', messages_sent, messages_error, total_messages }` |
| `POST /agents/runs/:runId/cancel` | `{ id, status: 'cancelled' }` |
| `GET /agents/holding-config?agent_type` | configuración global (`source: 'global'`) o `null` |
| `POST /agents/holding-config` — `{ agent_type, is_enabled, config_json }` | configuración global |
| `GET /agents/client-config?client_id&agent_type` | la propia (`source: 'client'`), la global con `client_id`/`client_name`, o `null` |
| `POST /agents/client-config` — `{ client_id, agent_type, is_enabled, config_json }` | configuración propia (upsert) |
| `GET` / `PUT /agents/client-configs/:client_id/:agent_type` | igual que los dos anteriores |
| `DELETE /agents/client-configs/:client_id/:agent_type` | 204 (vuelve a la global); 404 si no había propia |
| `GET /agents/client-configs?agent_type` | configuraciones propias del holding, por nombre de cliente |
| `GET /agents/client-configs/summary` | `{ proforma: { total, enabled }, collections: { total, enabled }, client_ids }` |
| `GET /agents/email-senders` | remitentes activos del holding |
| `POST /agents/render-email` — `{ agent_type, template, variables }` | `{ rendered_html, rendered_text }` |

`Run` = `{ id, agent_id, agent_name, agent_type, status, started_at, ended_at, stats_json, error_message, approver_user_id, created_at }`.

## Ciclo de una ejecución

| Disparo | Resultado |
|---|---|
| `mode = 'preview'` | genera sin guardar mensajes; el run queda `cancelled` con `stats_json.mode = 'preview'` |
| `mode = 'execute'` y `require_approval = true` | guarda los mensajes en `ai_messages`; run `queued` |
| `mode = 'execute'` y `require_approval = false` | envía en el acto; run `sent` |
| `approve` sobre un `queued` | `approved` (atómico, guarda `approver_user_id`) → envía → `sent`, o `error` si no salió ninguno. 409 si no está `queued` o no tiene mensajes |
| `cancel` sobre un `queued` | `cancelled`; sus mensajes no cuentan para la frecuencia de cobranza. 409 si no está `queued` |

El scheduler ejecuta cada minuto, en modo `execute`, los agentes con `is_enabled AND auto_execute AND schedule` cuyo cron
coincide con la hora del servidor.

## Configuración

Hay dos niveles de encendido: el **agente** (`ai_agents.is_enabled`, sin él no se ejecuta) y la **configuración**
(`client_agent_configs`), por cliente o global (`client_id IS NULL`).

Para cada cliente se usa su fila propia. Si no tiene, se usa la global, y si tampoco existe, el cliente se omite. Si la fila
que toca está deshabilitada, también se omite. Ver `resolveEffectiveConfig`.

| Tipo | `config_json` |
|---|---|
| Proforma | `days_before_issue` (propia → global → `ai_agent_configs` → 10), `frequency_hours` (solo global), `custom_email_subject`, `custom_email_body`, `email_sender_address_id` |
| Cobranza | `reminder_levels: [{ level, days_before_due?, days_overdue, frequency_hours, is_enabled?, custom_subject?, custom_body? }]`, `email_sender_address_id`. Sin niveles se usan 30 y 60 días cada 168 h |

**Cobranza**:
- Toma facturas `Emitida`/`Vencida`.
- Una factura entra en un nivel si está a `days_before_due` o menos de vencer, o si su atraso es `days_overdue` o más.
- Se envía **un correo por cliente** con el nivel más alto, al primer contacto "Cobranza".
- No se repite el nivel antes de `frequency_hours`.

**Proforma**:
- Toma facturas `Por Emitir` con `requires_references_for_billing` y fecha dentro de `days_before_issue`.
- No repite facturas que ya tienen `reference_requests`.
- En `execute` registra la solicitud (`OC`, `requested`).

**Remitente**: el `email_sender_address_id` de la configuración, si es del holding y está activo. Si no, el remitente activo
del dominio por defecto del holding; en último caso, `noreply@sapira.cl` (`resolveEmailSender`).

**Plantillas**: `{{variable}}`. Variables de proforma:
- `client_name`, `contact_name`
- `invoice_number`, `formatted_date`
- `contract_number`, `holding_name`

Variables de cobranza:
- `client_name`, `contact_name`, `holding_name`
- `invoice_count`, `total_amount`, `invoices_table`
- `invoice_number`, `amount`, `due_date`, `days_overdue`

## Tablas

`ai_agents` (uno por tipo y holding, creados por el trigger `create_standard_agents_for_holding`), `ai_agent_configs`
(configuración del agente, clave/valor), `ai_runs`, `ai_messages`, `client_agent_configs`, `email_sender_addresses`,
`holding_email_sender_settings`, `reference_requests`. Entities en `src/databases/postgresql/entities/automatizaciones-ia/`.

## Pruebas

```bash
yarn test src/modules/agents
```

| Spec | Qué cubre |
|---|---|
| `agents.controller.spec.ts` | Tenancy (400/403/404), permisos VIEW/EDIT y validación |
| `agents.service.spec.ts` | Ejecución, aprobación, descarte, tenencia por cliente, paginación y resumen |
| `agents.scheduler.spec.ts` | Coincidencia del cron y aislamiento de fallos |
| `processors/*.spec.ts` | Ventana de días por cliente, `reference_requests.holding_id`, remitente, niveles y frecuencia |
| `helpers/agent-config.helper.spec.ts` | Configuración efectiva y remitente efectivo |

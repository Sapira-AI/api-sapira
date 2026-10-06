# Cambio: permisos, lecturas por API y envíos que funcionan en Automatizaciones

> **Rama:** `leon` · 05-10-2026 · Leon + Claude
> **Repo front (par):** `front-sapira` — migración de Automatizaciones desde `front-sapira-vite` (`/lab/automatizaciones`).
> **Anterior:** [`automatizaciones-scheduler-y-tenancy.md`](automatizaciones-scheduler-y-tenancy.md).

## Contexto

El front nuevo no puede leer Supabase directo: lo que `front-sapira-vite` leía con `supabase.from('ai_agents' | 'ai_runs' |
'ai_messages')` necesita endpoints. De paso, la revisión del módulo encontró cuatro fallas que impedían que un envío real
funcionara (en prod `ai_runs` sigue en 0 filas, así que ninguna llegó a mostrarse).

## Permisos (cambia el comportamiento para el front actual)

Antes bastaba con sesión y pertenencia al holding. Ahora el controlador usa `RequirePermissionGuard`:

| Acción | Permiso |
|---|---|
| Listar agentes, ejecuciones y mensajes; leer configuraciones, remitentes y resumen; previsualizar plantilla | `VIEW_AGENTES_IA` |
| Ejecutar, aprobar, descartar; guardar programación, configuración global o por cliente; volver a la global | `EDIT_AGENTES_IA` |

"Editar incluye Ver", el comodín `ALL_PERMISSIONS` y super admin aplican como en el resto de la API. **En `front-sapira-vite`**,
un rol sin `EDIT_AGENTES_IA` ahora recibe 403 ("No tienes permiso para configurar y ejecutar las automatizaciones") al guardar o
ejecutar, y uno sin `VIEW_AGENTES_IA` deja de ver los resúmenes. Los roles por defecto ya traen ambos códigos donde corresponde
(`create_default_roles_for_holding.sql`).

## Endpoints nuevos

| Método y ruta | Qué hace |
|---|---|
| `GET /agents` | Agentes de proforma y cobranza del holding con su programación |
| `GET /agents/runs?page&limit&agent_id&type&status` | Historial paginado `{ data, total, currentPage, pages, limit }` con nombre y tipo del agente |
| `GET /agents/runs/:runId` | Detalle (estadísticas, error, quién aprobó, cantidad de mensajes); 404 si es de otro holding |
| `GET /agents/runs/:runId/messages` | Mensajes salientes y entrantes de la ejecución |
| `POST /agents/runs/:runId/cancel` | Descarta una ejecución pendiente sin enviar; 409 si no está pendiente |
| `DELETE /agents/client-configs/:client_id/:agent_type` | Borra la configuración propia del cliente (vuelve a la global); 204, 404 si no tenía |
| `GET /agents/client-configs/summary` | Cuántos clientes tienen configuración propia por tipo (y cuántas habilitadas) y la lista de clientes |

## Fallas corregidas

1. **`reference_requests` sin `holding_id`.** El processor de proforma insertaba sin la columna, que es `NOT NULL` y no tiene
   trigger que la complete: en `execute` cada cliente terminaba como error.
2. **Remitente por defecto.** Ambos processors unían `email_sender_addresses` con `holding_email_sender_settings` por
   `hess.email_sender_address_id`, columna que no existe: sin remitente elegido en la configuración, la consulta reventaba. Ahora
   se une por `esa.domain_config_id = hess.id` (igual que `GET /agents/email-senders`) en un helper compartido
   (`helpers/agent-config.helper.ts`), y el remitente elegido solo se usa si es del holding y está activo.
3. **`days_before_issue` por cliente ignorado.** La ventana de proforma salía solo de `ai_agent_configs`. Ahora la consulta usa el
   mayor valor entre las configuraciones habilitadas y cada cliente se filtra con el suyo (propia → global → agente → 10).
4. **Aprobación.**
   - Guarda `approver_user_id`.
   - Pasa a `approved` de forma atómica: dos clics no envían dos veces.
   - Rechaza con 409 una ejecución sin mensajes.
   - Conserva las estadísticas de la generación: antes `errors` se pisaba con un arreglo.
   - Si ningún correo sale, la ejecución queda en `error`.
   - Una ejecución en `preview` ya no queda `queued` y vacía: se registra como `cancelled` con `stats_json.mode = 'preview'`.
5. **Tenencia por cliente.** Leer o guardar la configuración de un cliente de otro holding responde 404. Antes el nombre del
   cliente se leía sin filtro de holding y el guardado solo lo frenaba la FK.

Además, la frecuencia de cobranza ya no cuenta los mensajes de ejecuciones descartadas: si no, un descarte bloqueaba el siguiente
recordatorio durante `frequency_hours`.

## Pruebas

`agents.controller.spec.ts` (tenancy, permisos, validación), `agents.service.spec.ts` (aprobación, descarte, tenencia por
cliente, paginación, resumen), `processors/*.spec.ts` y `helpers/agent-config.helper.spec.ts`.

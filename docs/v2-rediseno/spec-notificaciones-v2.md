# Spec · Notificaciones v2

> **Borrador para decisión de Domi (03-10-2026).** Nada construido. Fuentes: auditoría de `sapira-ai`, `front-sapira`,
> `api-sapira` y SELECT en producción. Reglas: lógica en la API; no se arregla lo que solo usa el front actual; copy
> corto, sin códigos ni marcas ("ERP", "CRM"); explicaciones en tooltips.

## 1. Qué hay hoy

- **Una sola infraestructura** en la API: `app_notifications` (estado global `open/resolved`, deduplicación,
  acción con `action_type` + `action_payload`), `app_notification_recipients` (leída por usuario) y
  `notification_role_subscriptions` (por rol y tipo). Socket.IO `/notifications` con sala por usuario.
- **Producción: 16 notificaciones en total; ninguna sale por correo.** Solo 11 de 126 asignaciones leídas: la campana
  casi no se usa.
- **10 tipos** (+ `contract_notifications` heredada, solo front viejo):

| Tipo | Origen | ¿Le llega a alguien? | ¿Se cierra sola? |
|---|---|---|---|
| Falla de envío al ERP (`invoice_odoo_failure`) | Scheduler de facturas | Roles suscritos | **No** (9 abiertas en SimpliRoute, hasta 51 días) |
| Importación del CRM bloqueada (`salesforce_staging_blocked`) | Sync CRM | Roles suscritos | Sí |
| Falla de sincronización del CRM (`salesforce_sync_failure`) | Cron 08:30 | **Nadie** (0 suscripciones) | No |
| Propuesta de renovación (`contract_renewal_proposed`) | Cron 06:00 | **Solo super admins** | Solo al omitir, **no al confirmar** |
| Vencimiento sin decisión (`contract_renewal_reminder`) | Cron 06:15 | Solo super admins | No |
| Ajuste pactado por aplicar (`contract_scheduled_change_due`) | Cron 05:30 | Solo super admins | No |
| Diferencias de cantidades del DWH (`bigquery_quantities_diff`) | Cron | **Nadie** | Sí |
| Cantidades sin mapeo / bloqueadas / otra moneda (`bigquery_quantities_*`) | Cron | **Nadie** | Sí |

- **Front nuevo:** solo la campana (10 últimas); "Ver todas" y cada ítem abren la app vieja. Sin página, detalle,
  filtros, marcar todas, archivar ni preferencias.
- **Avisos que viven dentro de los módulos** (no están en la campana): alertas del contrato, propuestas y pactos del
  Resumen, consumos por informar, bloqueos de la cola Por Emitir, excepciones de Ingresos, cotizaciones en espera de
  mapeo, "Tareas pendientes" del Dashboard.
- **Pedidos de clientes** (TiMining 29-07, SimpliRoute 10-07; `ROADMAP-OPERATIVO` Complejos #10, "en curso por Leon"):
  tareas pendientes (por emitir, renovaciones), alertas de desalineación y **resumen semanal por correo**.

## 2. Propuesta

### 2.1 Dos conceptos en un solo centro

| | **Tareas** | **Alertas** |
|---|---|---|
| Qué son | Cosas que **hay que hacer hoy**, calculadas en vivo desde los módulos | Cosas que **pasaron** (un evento) |
| Ejemplos | Facturas por emitir hoy y bloqueadas; renovaciones por decidir; pactos por aplicar; consumos por informar; cotizaciones en espera de mapeo; excepciones de Ingresos; facturas vencidas | Falló el envío al ERP; importación del CRM bloqueada; falló la sincronización; diferencias de cantidades del DWH |
| Dónde viven | No se guardan: endpoint que agrega conteos por módulo | `app_notifications` |
| Cómo se cierran | Solas, cuando el dato deja de cumplir la condición | Solas cuando se resuelve la causa, o la usuaria las archiva |

Así no se duplica lo que los módulos ya calculan y nada queda "abierto" para siempre.

### 2.2 Pantallas

- **`/lab/notificaciones`** (al switch, `/notificaciones`):
  - Pestaña **Tareas**: tarjetas por módulo con el conteo y un botón que lleva a la pantalla filtrada ("12 facturas
    por emitir hoy · Ver"). Vacío: "Todo al día".
  - Pestaña **Alertas**: lista con chips de estado (Sin leer, Abierta, Resuelta), filtros (módulo, gravedad, fecha),
    barra de selección (Marcar como leída, Archivar), vista rápida con el mensaje en palabras simples, qué hacer y el
    botón de la acción (Reintentar importación, Reemplazar cantidades, Ver contrato, Revisar propuesta, Revisar
    sincronización).
  - Pestaña **Preferencias** (de cada usuario): qué tipos recibe en la campana y por correo, y el resumen semanal.
- **Campana:** badge = alertas sin leer; el popover muestra las 5 últimas alertas y un resumen de tareas ("3 tareas
  para hoy"), con "Ver todo".

### 2.3 Correo

- **Resumen semanal** (lunes 08:00, zona horaria del holding), con la marca de los correos nuevos: tareas abiertas
  por módulo, alertas de la semana y variación de MRR. Activable por usuario.
- **Correo inmediato** solo para alertas graves (error), si el usuario lo activa.
- Proveedor: Resend con el `AuthMailer` y el layout de marca (mismo patrón que invitaciones).

### 2.4 Arreglos de base (API)

1. **Destinatarios:** catálogo de tipos con etiqueta, módulo, ícono y gravedad; **todos suscribibles por rol**.
   Suscripciones por defecto (ver D3). Se arregla que BigQuery y contratos no lleguen al equipo del cliente.
2. **Cierre automático:** falla del ERP al enviar bien; falla de sincronización con la siguiente corrida buena;
   propuesta de renovación al confirmar; vencimiento al renovar o dar de baja; ajuste pactado al aplicarlo.
3. **`createOrUpdate`:** al escalar un aviso vuelve a "sin leer" y suma destinatarios nuevos.
4. **Endpoints:** filtros (estado, leída, tipo, módulo, gravedad, fechas), marcar todas como leídas, archivar por
   usuario, detalle, conteo por tipo; `GET /notifications/tasks` (tareas calculadas); preferencias por usuario.
   Todo con `HoldingScopeGuard` (cierra #21: un usuario sin membresía deja de ver notificaciones del holding).
5. **Textos:** títulos y mensajes en español de negocio, sin códigos (los errores del ERP ya se traducen).
6. **Seguridad del socket:** revalidar sesión al reconectar (ya) y desconectar al quedar sin membresía.

### 2.5 Base de datos (aditivo, con OK)

| # | Cambio |
|---|---|
| N1 | `app_notification_recipients.archived_at` (archivar por usuario) |
| N2 | `user_notification_preferences` (user_id, holding_id, type, in_app, email) + `weekly_digest` por usuario y holding |
| N3 | Semilla de suscripciones por defecto por rol (D3) |

## 3. Decisiones para Domi

| # | Pregunta | Recomendación |
|---|---|---|
| D1 | `ROADMAP-OPERATIVO` dice "Notificaciones · en curso por Leon". ¿Lo tomamos nosotros completo? | Sí, como el resto de módulos, y Leon revisa lo de integraciones (ERP, CRM, DWH) |
| D2 | Tareas calculadas en vivo (no guardadas) | Sí |
| D3 | Destinatarios por defecto | Administrador: todo. Finanzas: ERP, renovaciones, pactos, DWH. Facturación y Cobranza: ERP, DWH. Ventas y Operaciones: CRM bloqueado. Super admins: fallas de sincronización. Cada usuario puede apagar en Preferencias |
| D4 | Correo | Resumen semanal los lunes 08:00 (activable) + inmediato solo para errores si el usuario lo activa |
| D5 | Archivar | Por usuario (no cambia la alerta para los demás); resolver a mano no, se resuelven solas |
| D6 | `contract_notifications` (heredada) | No se migra; se elimina con el switch |
| D7 | Alertas nuevas (desalineación de MRR, factura descuadrada, ítem sin producto) | Van con Automatizaciones (agentes de alerta, `spec-agentes-ia` F1); aquí solo se deja el canal listo |
| D8 | Ubicación | `/lab/notificaciones`; al switch, ruta propia `/notificaciones` |

## 4. Mejoras recopiladas (repos y memorias, 03-10) y cómo entran

**Reusar lo que existe (no duplicar):**
- Suscripciones por rol: ampliar `GET/PUT /settings/roles/:id/alerts` y el drawer de Roles a TODOS los tipos (no crear
  otro endpoint). Renombrar "Alertas generales" en la doc del Dashboard.
- Tareas: partir de `dashboard.service.ts getTasks` (por renovar 30/90, vencidos, por emitir, inicios del mes) y
  extenderlo; el Dashboard y el centro leen la misma función. Antes, corregir el bug de `user_holdings.selected`
  (26 de 28 usuarios sin selección) y el doble conteo de `mrr_legacy` del Dashboard.

**Correos internos que ya existen** (SendGrid a `INVOICE_ADMIN_EMAILS` / `BANCO_CENTRAL_ADMIN_EMAILS`): sincronización
de tipos de cambio (falla y éxito diario), factura con tasa de respaldo, factura no emitida por tasa faltante, resumen
de errores del scheduler. Propuesta: pasan al catálogo como alertas de super admin (campana + correo), con la misma
plantilla de marca y un solo proveedor (Resend); se escapan sus datos (hoy HTML sin escapar).

**Tipos y tareas nuevos que entran en este módulo:**
- **Novedades del sistema** (pedido de TiMining 29-07): aviso "qué cambió" por versión, más el **banner de versión
  nueva** con botón Recargar (Medios #3).
- **Cierre de mes:** aviso con las Por Emitir no emitidas del mes y acción masiva "Mover al mes siguiente"
  (auditoría S6-6); el cierre automático de período va con las reglas de reconocimiento (spec Configuración §14 B).
- **Tareas pedidas por SimpliRoute (10-07):** contratos activos sin facturas programadas; cotizaciones sin procesar
  del mes; Por Emitir de meses pasados fuera del scheduler; notas de crédito esperando emisión; consumos sin cerrar;
  inicios de servicio del mes.
- **Avisos de tipo de cambio:** factura que se emitirá en N días sin tasa; "fijo sin tasa"; "sin partner". La regla
  "tasa con más de 2 días → no emitir" es de Leon (carril de integraciones).
- **Vencimiento:** el aviso dice también el efecto en el devengo ("sigue reconociéndose como pendiente de renovar").

**Formato de todos los mensajes** (metodología de soporte, 07-09): título corto + "Qué pasó" + "Qué hacer" (+ "Qué
hacemos nosotros" cuando aplica), con gravedad (bloquea / atención / informativo) y catálogo de textos por código de
error (ERP ya traducido; mensajes de importación del CRM/DWH pendientes con Leon).

**Resumen semanal:** tareas abiertas por módulo, alertas de la semana, variación de MRR **con mayores aumentos y
pérdidas** (estilo ChartMogul, spec Revenue §326) y resumen de renovaciones ejecutadas.

**Van a Automatizaciones (agentes de alerta), no aquí:** factura descuadrada, ítem sin producto, partner sin vincular
(con reparación en un clic), desvío sin motivo, cotización duplicada (caso Pehuen), renovación retrasada en el CRM,
presupuesto (cuota de vendedor, caja proyectada), umbrales de métricas/varianza de CMRR, vigencia de cotización,
renovación fallida.

**Después:** canales Slack y WhatsApp; remitente "notificaciones" con el dominio propio del holding (Comunicaciones).

**Verificar:** campana y CORS del socket en producción; con Leon, que los avisos de validación del ERP no metan ruido.

**Diseño:** referencias HeroUI que pidió Domi (alert, badge, avatar, list-box, tag-group) — no son dependencia del
repo: se toman como referencia visual con los componentes propios.

### Decisiones adicionales

| # | Pregunta | Recomendación |
|---|---|---|
| D9 | Correos internos a admins (tipos de cambio, scheduler) | Entran al catálogo como alertas de super admin, plantilla de marca y Resend |
| D10 | Novedades del sistema + banner de versión nueva | Sí, en este módulo; las novedades las escribimos nosotros por versión (campo en la API o archivo en el repo) |
| D11 | Aviso de cierre de mes con "Mover al mes siguiente" | Sí, como tarea del último día hábil y los 3 primeros del mes siguiente |
| D12 | Tareas de SimpliRoute (contratos sin facturas, cotizaciones sin procesar, PE pasadas, NC por emitir) | Sí, todas como tareas calculadas |
| D13 | Dueño del resumen semanal | Notificaciones (canal y preferencia); el contenido de MRR lo da Métricas; cuando exista Automatizaciones, el resumen se vuelve un agente programable |

## 5. Decisiones de Domi (03-10) — mandan sobre §3 y §4

- **Aprobado** D1–D6, D8–D13 con estos ajustes:
- **D3 · fallas de sincronización (CRM, DWH, tipos de cambio):** no solo super admins: también **Administrador** y
  **Admin Técnico** del holding (necesitan saber que sus datos no se están actualizando). Super admins = Domi y Leon.
- **D7:** las alertas "inteligentes" van con los **agentes**, el último bloque (puede ser después del switch).
- **Correos internos** (tipos de cambio, scheduler): hoy solo llegan a Domi y Leon → quedan como alertas de super
  admin (campana + correo con la plantilla de marca).
- **Banner de versión nueva:** era un problema del front viejo (hard refresh tras cada despliegue). En Next+Vercel se
  resuelve con *Skew Protection* de Vercel más un aviso liviano solo si el navegador tiene una versión vieja abierta
  hace días (se compara el id de build). Prioridad baja; se evalúa al final del bloque.
- **Novedades del sistema:** van al **Centro de ayuda** (`/ayuda`, sección Novedades) con etiqueta **"Nuevo"** por dos
  semanas; no son notificaciones.
- **Canales:** Slack (y Teams) en el roadmap cercano; WhatsApp fuera (no es canal formal).
- **Tareas:** son del sistema para todos los holdings (los pedidos de SimpliRoute solo las originaron).
- **Nuevo en este bloque:**
  - **Menciones en la Actividad del Cliente 360**: comentarios con @usuario que generan una notificación "Te
    mencionaron" con enlace al cliente (toca Clientes, autorizado por Domi).
  - **Refresh de "Tareas pendientes" del Dashboard**: más visual y útil, con la misma fuente de tareas que el centro.

## 6. Plan de construcción

**Fase 1 (base):** catálogo de tipos (etiqueta, módulo, ícono, gravedad, texto Qué pasó/Qué hacer); todos
suscribibles desde Roles (`/settings/roles/:id/alerts`) con suscripciones por defecto (semilla); cierre automático de
alertas; `createOrUpdate` que reabre y suma destinatarios; endpoints con filtros, marcar todas, archivar por usuario,
detalle, conteos, preferencias por usuario y `GET /notifications/tasks` (extiende `getTasks` del Dashboard, corrige
`selected` y el doble conteo de `mrr_legacy`); `HoldingScopeGuard`; front `/lab/notificaciones` (Tareas, Alertas,
Preferencias), campana nueva y acciones directas.

**Fase 2:** resumen semanal y correo inmediato (Resend + plantilla de marca); correos internos al catálogo; aviso de
cierre de mes con "Mover al mes siguiente"; menciones en Cliente 360; refresh de Tareas pendientes del Dashboard;
Novedades en `/ayuda`; banner de versión (si aplica).

## 7. Ideas para el roadmap (no en este bloque)

- **Tareas planificadas** (Domi, 03-10): vista de tareas por fecha (hoy, esta semana, próximas) con pestañas animadas;
  referencia visual https://ui.watermelon.sh/animated-components/category/tabs. Después de la fase 2.
- Canales Slack y Teams.
- Alertas inteligentes con los agentes (último bloque): renovación abierta en el CRM con contrato por vencer (caso
  improbable), cotización duplicada, presupuesto, umbrales de métricas, factura descuadrada, partner sin vincular.

### Hecho · fase 1 en la API (03-10)

Contrato: [`contrato-api-notificaciones.md`](./contrato-api-notificaciones.md). Código: `src/modules/notifications/**` (catálogo
`notification-catalog.ts`), `src/modules/tasks/**` y `src/modules/contracts/contract-alerts.ts`.

- **Catálogo** de 16 tipos (10 actuales + `system_update` + reservados de fase 2: `user_mention`, `fx_sync_failure`, `invoice_fx_fallback`,
  `invoice_fx_missing`, `scheduler_error_summary`) con etiqueta, módulo, ícono, gravedad, acción y textos Qué pasó / Qué hacer.
- **Destinatarios por defecto** (D3 con ajustes del §5): semilla N3 `seed/007-notification-default-subscriptions.sql` y
  `create_default_roles_for_holding` (**pendiente de OK de Domi**). Los avisos de Contratos ya no van fijo a super admins: usan las
  suscripciones (Administrador y Finanzas). Roles ofrece todos los tipos con productor.
- **Cierre automático**: ERP al enviar bien; sincronización del CRM con la corrida buena; propuesta al confirmar (u omitir); vencimiento al
  renovar, dar de baja o terminar; pacto al aplicar, omitir o cancelar.
- **`createOrUpdate`** reabre como "sin leer" (y desarchiva) al subir la gravedad o cambiar el escalón, y suma destinatarios nuevos;
  **`create` sin destinatarios no inserta** (log).
- **Endpoints**: lista con filtros y paginación estándar, detalle con textos, leída/no leída, marcar todas (con filtros), archivar por
  usuario, conteos, catálogo, preferencias (`in_app`, `email`, `weekly_digest`) y `GET /notifications/tasks`; todo con
  `HoldingScopeGuard` (#21 cerrado). Socket: rechaza sin membresía activa y no emite a ex miembros.
- **Tareas** (15, una sola función con el Dashboard): por emitir hoy, bloqueadas por motivo, atrasadas, de meses pasados, vencidas, NC por
  emitir, renovaciones por confirmar, vencidos sin decisión, pactos por aplicar, consumos por informar, contratos sin facturas
  programadas, inicios del mes, cotizaciones en espera de mapeo, firmadas del mes sin contrato y excepciones de Ingresos. Consultas
  agregadas: la de contratos ~115 ms y la de cotizaciones ~30 ms en SimpliRoute (EXPLAIN ANALYZE en producción, solo lectura).
- **Dashboard**: tareas desde la función compartida; corte U14 del legacy (doble conteo verificado: +2.860 USD oct-2026 en SimpliRoute);
  `selected` ya estaba resuelto (holding del header).
- **Migraciones escritas, sin aplicar**: N1 `1790880000000-NotificationRecipientsArchivedAt`, N2 `1790890000000-UserNotificationPreferences`
  (RLS sin políticas), N3 semilla. Orden: N1 → N2 → N3 → función → API.
- **Pendiente para OK de Domi**: la función de roles por defecto y pasar el corte U14 a Clientes y Contratos (`legacyCut` por defecto).
- **Sigue**: front `/lab/notificaciones` (Tareas, Alertas, Preferencias), campana nueva y acciones directas; fase 2 (correos, resumen
  semanal, menciones, correos internos al catálogo).

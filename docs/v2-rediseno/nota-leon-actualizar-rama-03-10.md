# Nota para Leon · actualizar `leon` con `qa` (03-10-2026, actualizada 04-10)

## Pendientes de Leon (05-10)

Lista vigente; el resto de esta nota es contexto del merge.

1. **Test del front que falla por timeout** (desde antes del switch): `front-sapira/lib/api/factura-proxy.test.ts` › "propaga
   X-Factura-Company-Id desde empresaId en multipart cuando falta el header" (también falla corrido solo). Es el proxy de la API de
   facturación electrónica (SII) cuando se sube un archivo (multipart).
2. **17 assets de staging/mapeo de Odoo** en el repo que no existen ni en QA ni en prod (p. ej. `detect_invoice_changes`,
   `get_hierarchical_mapping`, `classify_invoice_before_insert`); 3 de ellos (`process_partner_staging_to_client_entities`,
   `apply_field_transformations_from_frontend`, `apply_partner_mapping_with_transformations`) llaman funciones ya borradas el 04-10
   (`apply_field_mapping_to_data`, `resolve_field_transformation`; la API las reemplaza con `odoo/services/field-transformation.service.ts`).
   Decidir: borrarlos del repo o aplicarlos (corregidos). Hoy un `postgres:assets --apply` sin `--only` los crearía.
3. **Escritores de facturas sin `sapira.writer = 'api'`**: `invoice-scheduler.service.ts` (envío al ERP), `invoices.service.ts`,
   `stripe-sync.service.ts` (además inserta líneas sin la marca; revisar `standardize_invoice_items`) y el webhook de Odoo. Envolverlos
   en `withApiWriter` y que escriban ellos los campos derivados (moneda de sistema, etc.: `refreshInvoiceSystemAmounts`). Mientras no,
   los triggers del front viejo sobre `invoices` siguen corriendo para esas escrituras y no se pueden retirar.
4. **Interruptor "Sincronización automática"** (`holding_integration_settings.auto_enabled`): hoy solo lo respeta el cron de facturas a
   Odoo. Falta en los crons de Salesforce, BigQuery (DWH) y Stripe.
5. **Edge functions `agents-run`, `agents-render-email`, `agents-approve`** (y el stub `agents-webhook`): sin uso, sin fuente en repo,
   escriben con service role. ¿Se borran? (Automatizaciones las rehará en la API.)
6. **Urgentes de seguridad de [`revision-seguridad-api.md`](./revision-seguridad-api.md) que son de integraciones**: #1 `GET
   /odoo/connections` y rutas `:id` exponen la `api_key` de Odoo de todos los clientes (falta `HoldingScopeGuard` y enmascarar); #2
   `/stripe/connections` devuelve `secret_key` (mismo arreglo); #3 `POST /odoo/webhooks` es `@Public` sin firma (cualquiera marca facturas
   como Pagadas/Enviadas o cambia montos): secreto por conexión + validar holding, con ventana coordinada para reconfigurar cada Odoo.
   (#11 y #16 son del bloque común Domi/Claude: ver abajo.)
7. **Integración, pendientes que afectan al front nuevo** (revisión de cobertura 05-10):
   - Salesforce calcula el fin del contrato sin restar 1 día.
   - El webhook de Odoo marca como **Pagada** un pago parcial o "en proceso".
   - Notas de crédito hacia Odoo como `out_refund`.
   - Al restablecer una factura, el borrador queda en Odoo.
   - El rechazo electrónico (SII) no se muestra en Sapira.
   - No hay bloqueo de envío por tipo de cambio desactualizado (ver también el caso Ironside → Ninja Hubs: aviso previo a la emisión
     si falta la tasa fija; con política spot, usar la del día de emisión).
   - Dedup del import legacy.
   - Atraso del sync de suscripciones de Stripe.
   - Pedidos L1–L11 de [`cambios-integracion-para-leon.md`](./cambios-integracion-para-leon.md).
   - 3 commits de `origin/leon` sin integrar (este merge).
8. **Probar una invitación de punta a punta** con las variables de correo nuevas de Railway, y `NOTIFICATION_JOBS_ENABLED=false` en
   **QA** (QA y prod comparten clave de Resend y la misma llave de idempotencia: el 05-10 los resúmenes semanales chocaron y unos salieron
   de QA y otros de prod).

**Agregado 05-10 (Domi): el DWH escribe consumos en `consumption_entries`.** Revisar el cambio mínimo en `bigquery.service.ts`
(`integrateSingleQuantity`, `reconcileExistingQuantity`, `replaceQuantityRecord` vía `ConsumptionService.recordFromDwh`) y decidir si
`sapira_quantity_imports` suma `consumption_entry_id` (hoy `quantity_id` queda `NULL` en filas nuevas). Detalle y orden de aplicación:
[`cambios-integracion-para-leon.md` §16](./cambios-integracion-para-leon.md). `quantities` queda de solo lectura; sus triggers se retiran
con la tabla tras el período de pruebas.

### Seguridad: lista completa para la sesión del 05-10

Fuente: [`revision-seguridad-api.md`](./revision-seguridad-api.md). Con el front nuevo como único front en producción, todos pesan más.

| # | Qué | Dueño | Arreglo |
|---|---|---|---|
| 1 | `GET /odoo/connections` sin header devuelve las conexiones (con `api_key`) de todos los holdings; rutas `:id` sin validar holding | Leon | `HoldingScopeGuard`, quitar la rama "todas", enmascarar `api_key` |
| 2 | `/stripe/connections` sin guard; devuelve `secret_key` | Leon | `HoldingScopeGuard`, no devolver la clave |
| 3 | `POST /odoo/webhooks` `@Public` sin firma | Leon | secreto por conexión + validar holding; ventana coordinada para reconfigurar cada Odoo |
| 11 | `POST /holdings/assign-to-all-holdings/:userId` solo pide sesión (`holdings.controller.ts`) | Domi/Claude | `@SuperAdminOnlyRoute` (Domi y Leon son los únicos super admin) |
| 16 | Módulos de plantilla montados y sin uso: `database` (`/database/*`, **público**: esquema completo incl. `auth` y RLS, escribe archivos en el servidor), `security` (`/security/*`: bloqueo/lista blanca de IPs, con sesión se puede bloquear la IP del front), `audit` (`/audit/*`), `devices` (`/devices/*`) (`app.module.ts`) | Domi/Claude | sacarlos de `app.module.ts` o solo super admin sin `@Public` |
| 22 | Política RLS `users_update_v2` sin `WITH CHECK` | Domi/Claude | agregar `WITH CHECK` (asset RLS) |
| — | Swagger público | Leon | protegerlo o apagarlo en prod |
| — | CORS acepta cualquier `*.vercel.app` (`cors-origins.ts`) | Leon | limitar a los dominios propios |
| — | `invoices.controller` sin `HoldingScopeGuard` | Leon | agregar guard + `@HoldingId()` |
| — | Permisos por rol en la API: solo Facturación, Presupuestos, Productos, Integraciones y Administración los exigen; Contratos, Cotizaciones, Clientes, Precios, Métricas y Dashboard solo los filtra la BFF (quien llame la API directo se los salta) | Domi/Claude | `RequirePermission` por módulo en la API |
| 23 | (resuelto) | — | — |

### Otros chicos

- `CONTRACT_JOBS_ENABLED` (jobs de contratos, encendidos por defecto) no está en `.env.example`: documentarla. Lo mismo con
  `FX_MONTH_CLOSE_ENABLED`, `NOTIFICATION_JOBS_ENABLED` y `NOTIFICATION_EMAILS_ENABLED`: **una API local conectada a prod debe tenerlas en
  `false`** (si no, corre los procesos automáticos sobre producción a la vez que Railway).

Cerrados el 04-10/05-10: variables de correo en Railway, usuarios de Sapira sin login en Supabase marcados Inactivos (prod 5, QA 3;
05-10), merge en curso.

## Actualización 04-10: switch hecho

`qa` y `main` ya traen el switch (API v0.0.106, front v0.1.65). Volvimos a simular `git merge origin/qa` sobre `origin/leon`
(tu último commit es el merge del 27-09): salen **los mismos 5 conflictos de código** de abajo (§1–§5) más los mecánicos de
snapshots/READMEs, nada nuevo. Ningún archivo de tu rama usa lo que se retiró hoy (`BillingPermissionsService`, rutas `/lab/...`).
Tus 3 commits (v0.0.40, v0.0.41 y el merge) son los que pasan a `qa` al resolver.

Lo que cambió desde el 03-10 y te conviene saber al resolver o después:

- **Front:** todos los módulos en su ruta final (`aisapira.com/clientes`, `/contratos`, `/facturacion`, `/conexiones`,
  `/administracion`…); `/lab/*` redirige. `app.aisapira.com` redirige con 308 a `aisapira.com` (dominio movido al proyecto
  `front-sapira` en Vercel) y el proyecto `sapira-ai` quedó con Deployment Protection: el front viejo ya no es accesible.
  Supabase Auth: Site URL `https://aisapira.com` y `https://aisapira.com/**` en Redirect URLs.
- **API:** los `href` de tareas, alertas, actividad del cliente, correos e integraciones salen con la ruta final (sin `/lab`).
  `BillingPermissionGuard` ahora usa `PermissionsService.assert` y se eliminó `BillingPermissionsService`. "Configuración" se
  muestra como **Administración** (mismos códigos `*_CONFIGURACION`; ver AGENTS.md).
- **Supabase:** se borraron las edge `send-invitation`, `delete-user`, `sync-exchange-rates`, `diagnose-odoo-model`,
  `diagnose-odoo-invoices`, `get-odoo-companies`, `chargebee-proxy`, `data-gateway` y `rag-*` (fuentes en
  `docs/v2-rediseno/archivo-edge-functions/`). Siguen las de Odoo que usas, `check-overdue-invoices`, `send-proforma`,
  `send-collection` y las `agents-*` (huérfanas: ¿las borramos?). `grants/030` y `grants/060` aplicados en QA y prod: 30 RPC del
  front viejo ya no tienen EXECUTE para `anon`/`authenticated` (`postgres` y `service_role` sí).
- **Variables de la API en prod (Railway):** `INVITE_LANDING_URL` (y `DOCUMENTS_LINK_BASE_URL` si la usas) =
  `https://aisapira.com`, **sin www** (`www.aisapira.com` todavía apunta a Framer). `FRONT_BASE_URL`/CORS ya aceptan
  `aisapira.com` (probado). Falta tu confirmación y la prueba de una invitación de punta a punta.
- **Vercel / front (chicos, post switch):**
  - `NEXT_PUBLIC_API_WS_URL` ya está en Production (`https://api.aisapira.com`, tipo Config); falta agregarla en el entorno
    `qa` con el valor de `API_URL` de qa y redeployar QA (sin ella, en QA la campana no se actualiza en vivo; ya no intenta
    `localhost`).
  - Borrar `NEXT_PUBLIC_LEGACY_APP_URL` y `AUTH_REDIRECT_URL` (Production y qa): el código ya no las usa.
    `NEXT_PUBLIC_AUTH_COOKIE_DOMAIN` sí se usa: no tocar.
  - `www.aisapira.com`: redirect 308 a `aisapira.com` en el proyecto `front-sapira` + CNAME `www` en GoDaddy (hoy
    `sites.framer.app`, despublicado) al valor que indique Vercel.
  - Test del front que falla por timeout desde antes del switch: `lib/api/factura-proxy.test.ts` › "propaga
    X-Factura-Company-Id desde empresaId en multipart cuando falta el header" (también falla corrido solo).
- **Del catálogo de funciones y triggers** ([`catalogo-funciones-y-triggers.md`](./catalogo-funciones-y-triggers.md), 04-10):
  - **17 assets de staging/mapeo de Odoo** (p. ej. `detect_invoice_changes`, `get_hierarchical_mapping`,
    `classify_invoice_before_insert`) están en el repo pero no existen ni en QA ni en producción, y no están en el registro de
    huérfanos: un `postgres:assets --apply` sin `--only` los crearía. Decide si se aplican o se borran del repo.
  - **Escritores de facturas sin `sapira.writer = 'api'`:** `invoice-scheduler.service.ts`, `invoices.service.ts`,
    `stripe-sync.service.ts` (también inserta líneas de factura sin la marca; revisar `standardize_invoice_items`) y el webhook de
    Odoo. Mientras no pongan la marca (`withApiWriter`), los triggers que completan `invoices` (moneda de sistema, etc.) siguen
    corriendo para ellos y no se pueden retirar.
  - Domi decidió **borrar ya las funciones sin ningún llamador** (front viejo, API, otras funciones, triggers, cron, edge): si
    alguna la usa tu rama o algo tuyo fuera del repo, avísale antes de mergear.
- **Pendientes tuyos que siguen abiertos:** respetar `auto_enabled` de `holding_integration_settings` en los crons de Salesforce,
  BigQuery y Stripe; `invoice_items.subscription_item_id` vacío desde mar-2026 (congela el devengo de suscripciones Stripe);
  `sync_user_on_login` se mantiene (la API aún no pasa Pendiente → Activo); urgentes de seguridad de
  `revision-seguridad-api.md`.

Tus commits v0.0.40 (tenancy fase 1 + corridas por holding + `holding_integration_settings`) y v0.0.41 (snapshot) no
están en `qa`. `qa` ya trae todo lo de Domi hasta **v0.0.93** (Configuración v2, usuarios e invitaciones, Notificaciones
v2 fases 1 y 2). Simulamos `git merge origin/qa` sobre `origin/leon` sin tocar nada: salen **4 conflictos de código** y
el resto es mecánico. Con Integraciones v2 se suma un quinto (§5, `holding_integration_settings`).

## Cómo actualizar

```bash
git checkout leon
git fetch origin
git merge origin/qa
```

## Conflictos de código

### 1. `src/modules/notifications/notifications.controller.ts` → quedarse con la versión de `qa`

`qa` ya tiene lo que agregaste: `@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)` a nivel de clase y `@HoldingId()` en
cada método (se hizo en Notificaciones fase 1, cierra la revisión de seguridad #21). Además trae endpoints que tu
versión no tiene: `unread`, archivar, marcar todas, conteos, preferencias, tareas, novedades del sistema
(`@SuperAdminOnlyRoute`), usuarios mencionables, `authIdOf(request)` y la ruta `:notificationId` restringida a UUID
(`NOTIFICATION_ID`) para que `/notifications/tasks` no caiga en el detalle. Tu versión es un subconjunto: **tomar la de
`qa` completa** (`git checkout --theirs` desde `leon` = la de `qa`).

### 2. `src/modules/notifications/notifications.controller.spec.ts` (agregado en las dos ramas) → `qa` + tu caso extra

Los dos specs prueban lo mismo (400 sin header, 403 con holding ajeno, 404 con notificación de otro holding, holding
validado al servicio). El de `qa` tiene además filtros, archivar, tareas, novedades y mencionables. Tomar el de `qa` y
**agregarle tu caso** "rechaza con 403 si la query trae un holding_id distinto al del header", si sigue aplicando con los
DTO de `qa` (en `qa` los DTO de notificaciones no tienen `holding_id`; si el `forbidNonWhitelisted` ya lo rechaza con
400, ajustar el esperado).

### 3. `src/modules/invoices/invoice-notification.service.ts` (resumen de errores de la corrida) → `qa` + el holding

En `qa` el correo HTML del resumen de errores se reemplazó por una **alerta del catálogo**
(`SCHEDULER_ERROR_SUMMARY_NOTIFICATION_TYPE`) creada con `notify(params.holdingId, …)`: una alerta por holding y día
(`deduplication_key: scheduler-errors:<holding>:<día>`), con "Qué pasó", recomendación y acción a la cola Por Emitir, que
se cierra sola con la siguiente corrida sin errores. Llega por la campana y, con su ventana de 15 minutos, por correo a
quien lo tenga activo. Ya no se usa SendGrid aquí; `INVOICE_ADMIN_EMAILS` queda solo como respaldo si la alerta no tiene
destinatarios.

Tu cambio (holding en el asunto para que el cliente de correo no agrupe los correos de varias corridas) se resuelve
solo con la alerta, porque cada una ya es de un holding. Tomar la versión de `qa` y, si quieres conservar la idea:

- pasar `params.holdingName` al título de la alerta solo si `holdingId === 'all'` ya no puede llegar (con tus corridas
  por holding no llega), o
- usar `holdingName` en el **asunto del correo de respaldo** a `INVOICE_ADMIN_EMAILS` (método de respaldo más abajo en el
  mismo archivo).

Revisar que tu `invoice-scheduler.service.ts` siga llamando con los parámetros que espera la versión de `qa`
(`holdingId`, `jobId`, `executionSource`, `executionEnvironment`, `startedAt`, `result`, `distinctErrors`); si agregaste
`holdingName`, dejarlo opcional.

### 4. `package.json` → versión de `qa`

`"version"` de `qa` (hoy 0.0.106; la tuya es 0.0.41). El siguiente `yarn vcp` sube desde ahí.

### 5. `holding_integration_settings`: entity (add/add) → quedarse con la versión de `domi`

Al traer Integraciones v2 (rama `domi`), `src/databases/postgresql/entities/base-tenancy/holding-integration-settings.entity.ts` choca
(agregado en las dos ramas). **Quedarse con la de `domi`**: es la tuya tal cual más `settings jsonb` (reglas de cada integración),
`updated_by uuid`, `stripe` en `HOLDING_INTEGRATIONS` y en el `@Check`, y el comentario de tabla actualizado; todo eso lo crea la migración
`1791000000000-IntegrationsV2`. Tu migración `1790400000000-CreateHoldingIntegrationSettings.ts` y la policy
`rls/holding_integration_settings_service_role.sql` están copiadas sin cambios en `domi` (no chocan). En `existing-entities.json` y
`espejo.existing.ts` la entrada es la misma que la tuya. Es la **tabla única de ajustes por integración**: no hay `integration_settings`.

## Conflictos mecánicos (no se resuelven a mano)

Snapshots y READMEs del espejo (`scripts/espejo/snapshots/**`, `src/databases/postgresql/entities/**/README.md`,
`*.prod-snapshot.ts`): tomar cualquiera de las dos versiones y **regenerar**:

```bash
npm run -s schema:snapshot -- --target production
npx jest src/databases
```

`existing-entities.json` y `espejo.existing.ts` se fusionan solos (tú agregas `holding_integration_settings`; `qa` agrega
`user_notification_preference`, `notification_email_log` y otras).

## Después del merge

- `npx jest -w 4`: `database.module.spec` debería **pasar** por primera vez en semanas (fallaba en `qa`/`domi` porque
  `holding_integration_settings` existía en la base y no en esas ramas).
- `schema:status` en QA: desaparece "solo en la base: `rls/holding_integration_settings_service_role.sql`".
- Levantar la API y confirmar que arranca (cambios de DI en invoices y notifications).

## Coordinación con Integraciones v2 (en construcción en `domi`)

- Domi y Claude están haciendo el módulo Integraciones del front nuevo
  ([`spec-integraciones-v2.md`](./spec-integraciones-v2.md)). Coincide en lo esencial con tu
  [`plan-migracion-integraciones.md`](./plan-migracion-integraciones.md): un solo componente de mapeo, patrón único
  de trabajo en curso, no portar pantallas tal cual.
- **Rutas nuevas `/integrations/*`** con `HoldingScopeGuard` + `@HoldingId()` + `RequirePermission`
  (`VIEW_INTEGRACIONES` / `EDIT_INTEGRACIONES`), que nunca devuelven claves. Las rutas viejas (`/odoo/*`,
  `/salesforce/*`, `/stripe/*`, `/bigquery/*`) no se tocan porque las usa la app actual: **tu Fase 2 de tenancy las
  cierra**. Así no hay trabajo duplicado.
- El switch "Sincronización automática" de cada integración **usa tu `holding_integration_settings`** (`auto_enabled`), y las
  reglas de cada integración van en la misma fila (`settings`), con TypeORM y tu entity. `stripe` entra en su CHECK con la
  migración `1791000000000-IntegrationsV2`. Falta que los crons de Salesforce, BigQuery y Stripe lo respeten (tu Paso 3).
- Lo que es lógica de integración (traer del ERP solo facturas que no nacieron en Sapira, notas de crédito, estados de
  pago desde el ERP, sync de vendedores por id del dueño del CRM, Kame) queda en [`cambios-integracion-para-leon.md`](./cambios-integracion-para-leon.md).

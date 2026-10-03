# Nota para Leon · actualizar `leon` con `qa` (03-10-2026)

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

`"version": "0.0.93"` (la tuya es 0.0.41). El siguiente `yarn vcp` sube desde ahí.

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

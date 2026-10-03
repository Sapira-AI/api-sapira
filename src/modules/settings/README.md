# Módulo `settings` (Configuración v2)

API del módulo Configuración del front nuevo (`/lab/configuracion`). Spec: `docs/v2-rediseno/spec-configuracion-v2.md` (manda
"Decisiones v3"). **Contrato de endpoints** (shapes, permisos y mensajes 4xx): `docs/v2-rediseno/contrato-api-configuracion.md`.
Productos (pestaña de Precios) vive en `src/modules/products` con el mismo patrón.

## Piezas

| Archivo                                                                                   | Qué hace                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings-holding.*`                                                                      | Holding 360: datos y logo (sin renombrar), resumen (`users_count`, `last_activity_at`), preferencias (`holding_settings`, con `locked`), tasas fijas por período, estado de la sincronización FX y su detalle diario/mensual (ronda 3), árbol holding → compañías |
| `settings-catalogs.*`                                                                     | Vendedores, motivos de baja y datos maestros (`item_types`, `units_of_measure`, `markets`, `segments`, `industries`; condiciones de pago salió el 03-10) con uso total y desglosado; tipos de negocio y de contacto (solo lectura)                                |
| `settings-custom-fields.*`                                                                | Definiciones de campos personalizados (D13) con conteo de valores (agrupado por entidad en la lista); tipos `text`, `number`, `select` (con `options` y `option_usage`), `boolean`, `date`                                                                        |
| `settings-tax-documents.*`                                                                | Documentos tributarios del país de la compañía con su tasa y la tasa efectiva del motor (`resolveTaxRate`), solo lectura                                                                                                                                          |
| `settings-communications.*`                                                               | Dominios y remitentes de correo del holding (SendGrid vía `EmailsService`) y correo de prueba, con holding validado                                                                                                                                               |
| `settings-companies.*`                                                                    | Compañía 360: datos, 5 cuentas contables, cuentas bancarias; controlador también de documentos y períodos                                                                                                                                                         |
| `company-legal-documents.service.ts`                                                      | Documentos legales con subida por URL firmada (bucket privado `company-files`)                                                                                                                                                                                    |
| `accounting-periods.service.ts`                                                           | Cerrar/reabrir períodos en transacción propia (replica `close_period_until`/`reopen_period_from` con el usuario de la sesión)                                                                                                                                     |
| `settings-users.service.ts`, `settings-roles.service.ts`, `settings-access.controller.ts` | Usuarios del holding, cambio de rol, catálogo de permisos, roles (D7) y alertas por rol                                                                                                                                                                           |
| `settings-admins.ts`                                                                      | Regla "el holding no queda sin nadie que edite la configuración"                                                                                                                                                                                                  |
| `permissions-catalog.ts`                                                                  | Matriz módulo × Ver/Editar, permisos especiales e internos                                                                                                                                                                                                        |
| `settings-storage.service.ts`                                                             | Storage con clave de servicio: logos (público `company-logos`) y archivos (privado `company-files`)                                                                                                                                                               |
| `countries.controller.ts`                                                                 | `GET /catalog/countries` (global, solo sesión)                                                                                                                                                                                                                    |
| `settings-db-errors.ts`                                                                   | Interceptor de todos los controladores de Configuración y de Productos: traduce errores esperables de Postgres a 4xx con `message` (nunca 500 sin mensaje)                                                                                                        |
| `src/core/utils/holding-preferences.ts`                                                   | Preferencias operativas del holding con defaults (zona horaria, escalera de recordatorios, numeración de cotizaciones) para jobs y módulos                                                                                                             |
| `src/core/utils/account-mappings.ts`                                                      | Las 5 cuentas (columnas, etiquetas, nombres por defecto en español) y el criterio único "cuentas completas" (árbol, Compañía 360 e Ingresos)                                                                                                                      |
| `fake-db.testing-spec.ts`                                                                 | Base falsa para los specs (fuera del build)                                                                                                                                                                                                                       |

## Reglas

-   Todo controlador: `SupabaseAuthGuard` → `HoldingScopeGuard` → `RequirePermissionGuard` (`src/guards/`), con `VIEW_CONFIGURACION` en la
    clase y `EDIT_CONFIGURACION` (o `CLOSE_PERIODS`) en cada escritura. `settings-controllers.spec.ts` lo hace cumplir.
-   Recursos por id: siempre `WHERE id = $1 AND holding_id = $2` (o por la compañía del holding cuando la tabla no tiene `holding_id`,
    como `company_account_mappings`) → 404 si no es del holding.
-   Borrar solo si no se usa (409 con la sugerencia de desactivar/archivar).
-   Lógica en la API: los triggers (`validate_holding_fx_period_rates`, validadores de período, `sync_contracts_company_currency`) quedan como
    invariantes. Cambiar la moneda de una compañía con contratos o facturas se bloquea (409) para que el trigger no reescriba
    `contracts.company_currency`.
-   Cambiar la moneda de consolidación **o la política de tipo de cambio** del holding con contratos → 409 (cambiarían todas las
    métricas históricas; Domi 02-10 y 03-10). El GET de preferencias trae `locked` y `locked_reason` para mostrarlas de solo lectura.
-   El holding **no se renombra** (`name` en el PATCH → 400 "El nombre del holding no se puede cambiar").
-   Cuenta bancaria con cartolas cargadas: no cambia moneda ni número (409).
-   Cierre de períodos: solo meses terminados (hasta el último día del mes anterior a hoy, hora Chile → si no, 409); la compañía se bloquea
    con `FOR NO KEY UPDATE`. El cierre protege contratos e ítems; pagos, facturas y consumos se registran o mueven en meses cerrados.
-   **Editar incluye Ver** (`PermissionsService.allows`: `EDIT_X` satisface `VIEW_X`); al crear/editar/duplicar un rol se agrega `VIEW_X`
    por cada `EDIT_X`. Duplicar copia solo códigos otorgables (`isGrantable`).
-   Fechas puras con `@IsIsoDate` (rechaza `2026-02-30` con 400). Mensajes de validación en español de negocio, sin nombres de columnas.
-   Logos: PNG, JPG o WEBP, máx. 2 MB (SVG fuera); el bucket `company-logos` lo hace cumplir con la migración `1790810000000` (sin aplicar).
-   Ninguna tabla de estas tiene triggers gateados por la costura `sapira.writer`: no se fija.

## Ronda 3 (03-10)

Contrato §8 y spec §13. Migraciones nuevas sin aplicar: M11 `1790820000000-TaxDocumentTypesTaxRate`, M12 `1790830000000-CustomFieldTypes`,
M13 `1790840000000-ClientsCountryCode` y el seed `006-tax-document-types-tax-rate.sql`; van **antes** del código. `SettingsModule` importa
`EmailsModule`. Las rutas viejas `/emails/*` no se tocan (se cierran en el bloque de seguridad).

## Ronda 4 (03-10)

Contrato §9 y spec §15. Preferencias del holding que ya funcionan (`GET/PATCH /settings/holding/preferences`): zona horaria, escalera de recordatorios de vencimiento y numeración de cotizaciones (con vista previa del próximo número).
Lectura única para todos los módulos en `src/core/utils/holding-preferences.ts` (`loadHoldingPreferences`, `holdingTimezone`,
`quoteNumberFormat`, `nextQuoteNumber`): lee la fila con `to_jsonb`, así que sin la migración M14 `1790850000000-HoldingSettingsPreferencesV4`
(sin aplicar) todo cae a los defaults de antes; solo el PATCH de preferencias necesita M14. La entity `holding-settings.entity.ts` se
actualiza con `schema:snapshot` después de aplicar en producción (como M12).

## Despliegue

M2, M3, M7, M8, M9 y el seed 004 están **aplicados en QA y producción el 02-10**. Pendientes (sin aplicar, con OK de Domi): migración
`1790810000000-CompanyLogosBucketLimits`, seed `005-finanzas-view-configuracion.sql` y la función `create_default_roles_for_holding`
(is_default, CLOSE_PERIODS, VIEW_CONFIGURACION para Finanzas, sin ADMIN_FULL_ACCESS). Detalle en el contrato §11.

## Tests

`npx jest src/modules/settings src/modules/products src/guards src/core/utils/holding-preferences.spec.ts src/databases/postgresql/configuracion-v2.spec.ts` (ronda 3: `settings-ronda3.spec.ts`; ronda 4: `settings-holding.service.spec.ts`, `settings.http.spec.ts`, `holding-preferences.spec.ts`) — HTTP con guards reales (`settings.http.spec.ts`), guarda estática de
permisos por ruta y DI (`settings-controllers.spec.ts`) y un spec por servicio.

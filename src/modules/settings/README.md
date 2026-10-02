# Módulo `settings` (Configuración v2)

API del módulo Configuración del front nuevo (`/lab/configuracion`). Spec: `docs/v2-rediseno/spec-configuracion-v2.md` (manda
"Decisiones v3"). **Contrato de endpoints** (shapes, permisos y mensajes 4xx): `docs/v2-rediseno/contrato-api-configuracion.md`.
Productos (pestaña de Precios) vive en `src/modules/products` con el mismo patrón.

## Piezas

| Archivo | Qué hace |
|---|---|
| `settings-holding.*` | Holding 360: datos y logo, preferencias (`holding_settings`), tasas fijas por período, estado de la sincronización FX, árbol holding → compañías |
| `settings-catalogs.*` | Vendedores, motivos de baja y datos maestros (`payment_terms`, `item_types`, `units_of_measure`) con uso |
| `settings-custom-fields.*` | Definiciones de campos personalizados (D13) con conteo de valores |
| `settings-companies.*` | Compañía 360: datos, 5 cuentas contables, cuentas bancarias; controlador también de documentos y períodos |
| `company-legal-documents.service.ts` | Documentos legales con subida por URL firmada (bucket privado `company-files`) |
| `accounting-periods.service.ts` | Cerrar/reabrir períodos en transacción propia (replica `close_period_until`/`reopen_period_from` con el usuario de la sesión) |
| `settings-users.service.ts`, `settings-roles.service.ts`, `settings-access.controller.ts` | Usuarios del holding, cambio de rol, catálogo de permisos, roles (D7) y alertas por rol |
| `settings-admins.ts` | Regla "el holding no queda sin nadie que edite la configuración" |
| `permissions-catalog.ts` | Matriz módulo × Ver/Editar, permisos especiales e internos |
| `settings-storage.service.ts` | Storage con clave de servicio: logos (público `company-logos`) y archivos (privado `company-files`) |
| `countries.controller.ts` | `GET /catalog/countries` (global, solo sesión) |
| `fake-db.testing-spec.ts` | Base falsa para los specs (fuera del build) |

## Reglas

- Todo controlador: `SupabaseAuthGuard` → `HoldingScopeGuard` → `RequirePermissionGuard` (`src/guards/`), con `VIEW_CONFIGURACION` en la
  clase y `EDIT_CONFIGURACION` (o `CLOSE_PERIODS`) en cada escritura. `settings-controllers.spec.ts` lo hace cumplir.
- Recursos por id: siempre `WHERE id = $1 AND holding_id = $2` (o por la compañía del holding cuando la tabla no tiene `holding_id`,
  como `company_account_mappings`) → 404 si no es del holding.
- Borrar solo si no se usa (409 con la sugerencia de desactivar/archivar).
- Lógica en la API: los triggers (`validate_holding_fx_period_rates`, validadores de período, `sync_contracts_company_currency`) quedan como
  invariantes. Cambiar la moneda de una compañía con contratos o facturas se bloquea (409) para que el trigger no reescriba
  `contracts.company_currency`.
- Cambiar la moneda de consolidación del holding (`holding_settings.system_currency`) con contratos → 409 (cambiaría todas las
  métricas históricas; decisión de Domi 02-10).
- Ninguna tabla de estas tiene triggers gateados por la costura `sapira.writer`: no se fija.

## Despliegue

Requiere las migraciones M2, M3, M7, M8, M9 y el seed M4 (ver el contrato §11 y la spec). Orden: migraciones → seed `004` → función
`create_default_roles_for_holding` → código. Sin ellas, los endpoints que leen columnas nuevas responden 500.

## Tests

`npx jest src/modules/settings src/modules/products src/guards` — HTTP con guards reales (`settings.http.spec.ts`), guarda estática de
permisos por ruta y DI (`settings-controllers.spec.ts`) y un spec por servicio.

# Spec · Configuración v2

> **v2 · 02-10-2026 · borrador para decisión de Domi.** Nada construido. Fuentes: auditoría del front actual
> (`sapira-ai`), de `api-sapira`, del front nuevo y consultas de solo lectura en producción.
>
> Reglas del bloque (Domi, 02-10):
> - No se replica la Configuración vieja tal cual: se replantea y reubica. Se resuelve **todo** lo que hoy tiene
>   el front actual (nada a medias); lo que no se migra queda explícito con su motivo.
> - No se arregla lo que solo usa el front actual, **pero no se rompe nada que use hasta el switch**: todo cambio
>   de API y base es aditivo.
> - No se modifica código de módulos cerrados (Clientes, Contratos, Cotizaciones, Facturación, Ingresos,
>   Métricas) sin pedido explícito de Domi, módulo por módulo.
> - Código y migraciones recién después del OK de esta spec; commit, push y migraciones siempre con OK explícito.

## 1. Estructura propuesta

`/lab/configuracion` con dos secciones. Productos se va a Precios.

```
Configuración
├── Holding y compañías
│   ├── Árbol: holding (raíz) → compañías emisoras
│   ├── Holding 360
│   └── Compañía 360
└── Usuarios y permisos
    ├── Usuarios
    └── Roles y permisos

Precios (módulo existente, segunda vuelta)
└── nueva pestaña Productos
```

### 1.1 Árbol del holding

- **Raíz**: nombre y logo del holding, **moneda de consolidación** (`holding_settings.system_currency`) y política
  de tipo de cambio (tasa fija por período / promedio mensual).
- **Hijos**: una fila por compañía emisora con **bandera del país**, razón social y **moneda de la compañía**
  (`companies.currency`). Chips de estado: "Cerrado hasta jul-2026", "Cuentas contables incompletas", "SII",
  "ERP vinculado".
- Clic en la raíz abre el **Holding 360**; clic en una compañía abre la **Compañía 360**. Botón "Nueva compañía".

### 1.2 Holding 360

| Pestaña | Contenido | Dato | Hoy en el front actual |
|---|---|---|---|
| Resumen | Nombre, sitio web, correo, teléfono, logo | `company_holdings` | Empresa |
| Monedas y tipo de cambio | Moneda de consolidación, política, **tasas fijas por período** (crear, editar, eliminar) y estado de la sincronización automática (Banco Central, SUNAT: última carga, solo lectura) | `holding_settings`, `holding_fx_period_rates`, `exchange_rates` | Sistema › FX y Datos Económicos |
| Catálogos | Vendedores; Motivos de baja; Condiciones de pago; Tipos de ítem; Unidades de medida (agregar, editar, activar/desactivar) | `sellers`, `churn_reasons`, `master_data` | Sistema › Vendedores, Churn y Datos Maestros |
| Correo | Dominios propios (verificación DNS) y remitentes, correo de prueba | `holding_email_sender_settings`, `email_sender_addresses` | Sistema › Correo |
| Preferencias | Días de aviso antes de una renovación automática | `holding_settings.auto_renewal_notice_days` | No existía en pantalla |

### 1.3 Compañía 360

| Pestaña | Contenido | Dato |
|---|---|---|
| Resumen | Razón social, identificador tributario, país (selector), dirección, representante, correo, teléfono, sitio, logo, moneda de la compañía | `companies` |
| Facturación | Prefijos de factura y contrato, impuesto (%), **configuración SII** (la pantalla que ya existe en `/admin/empresas-sii`, reutilizada), vínculo con el ERP (solo lectura, enlace a Integraciones) | `companies`, `sii_*` |
| Cierre de períodos | "Cerrado hasta…", Cerrar hasta (último día de mes) y Reabrir desde (día 1) con motivo obligatorio y confirmación, historial | `accounting_period_cutoff`, `accounting_period_events` |
| Cuentas contables | Las **5 cuentas** del asiento (Cuentas por cobrar, Ingresos diferidos, Ingresos por facturar, Ingresos, Diferencia de cambio): código, nombre y código del ERP | `company_account_mappings` |
| Cuentas bancarias | Banco, tipo, número, moneda, titular (las usa Conciliación) | `company_bank_accounts` |

Desde Ingresos (Asientos) y Facturación (Conciliación) se llega a la pestaña correspondiente con un enlace
(eso toca módulos cerrados: va con OK por módulo, D12).

### 1.4 Usuarios y permisos

- **Usuarios**: lista con nombre, email, rol, estado (Activo / Invitación pendiente / Desactivado), último acceso.
  Barra de selección: Cambiar rol, Reenviar invitación, Desactivar/Reactivar, Eliminar invitación. "Invitar
  usuario" (email, nombre, rol). Vista rápida con permisos efectivos.
- **Roles y permisos**: lista de roles con nº de usuarios; drawer con **matriz módulo × Ver/Editar** + permiso de
  Cierre de períodos; sección "Alertas que recibe este rol" (hoy: importación de Salesforce bloqueada, falla de
  sincronización de Salesforce, falla de envío al ERP; tabla `notification_role_subscriptions`). Alcance de
  creación/edición según D7.

### 1.5 Productos en Precios

Nueva pestaña **Productos** en `/lab/precios`: código, nombre, tipo (recurrente/único), estado (activo/archivado),
en uso (contratos, cotizaciones, precios), mapeos ERP / Salesforce / Stripe como chips de solo lectura con enlace a
Integraciones. Crear, editar, archivar/reactivar; eliminar solo si nunca se usó. El precio vive en los precios de
catálogo (sin precio ni moneda en el producto; las columnas viejas `default_price`/`default_currency` quedan quietas
hasta el switch porque el front actual las usa).

## 2. Lo que NO se migra (con motivo)

| Ítem del front actual | Motivo | Qué pasa |
|---|---|---|
| `company_holdings.manual_status_change_enabled` | Nadie lo lee | Se retira tras el switch |
| `holding_settings.currencies_in_use` | Solo lo usa el front actual; la API v2 toma las monedas del catálogo global | Se retira tras el switch |
| `financial_settings` (granularidad, política de descuentos, aprobación) | Nadie los lee; `revenue_schedule_monthly_enabled` solo lo usan triggers heredados | Se retira con los triggers heredados |
| Datos maestros: mercados, segmentos, industrias, tipos de contacto, tipos de negocio | El front nuevo usa texto libre con sugerencias (Clientes) y un catálogo fijo de tipos de negocio (Cotizaciones), ya cerrados | Se retiran tras el switch |
| Campos personalizados (16 definiciones: 4 demo en Hanka; 12 en SimpliRoute sobre ítems: Fecha de corte, Cantidad mínima, Fuente de unidad, Tipo de agregación, Fuente optimizaciones, Tipo lista de precio; 102 ítems de contrato y 64 de cotización con valores) | Los de SimpliRoute describen el modelo de cobro por consumo, que Precios v2 ya modela (ver plan SimpliRoute → modelos de precio). El front nuevo solo muestra/arrastra los valores existentes | Ver **D13** |
| Documentos legales de la compañía | 1 fila en producción, nadie los lee, sin subida real (solo URL) | Ver D13 |
| Edge function `sync-exchange-rates` + `fx_api_sync_log` | La sincronización real la hace el scheduler de la API | El estado se muestra desde el scheduler |
| Pantallas Banco Central / Perú API (sincronizar a mano, historial) | Datos globales, no del holding | Quedan solo para super admin (pantalla interna), fuera de la vista de clientes |
| `holding_integration_settings` | De Leon (corrida automática por integración) | **Se conserva**: es la tabla única de ajustes de Integraciones v2 (`auto_enabled` + `settings`, migración `1791000000000-IntegrationsV2`) |
| Onboarding `/configuracion-inicial` | Bloque Onboarding (plan §3.7) | Se diseña allí; "Nueva compañía" cubre el alta de compañías |
| Mapeo de compañías y productos con el ERP/Stripe | Bloque Integraciones | Configuración y Productos muestran el estado y enlazan |

Ya resueltos en el front nuevo dentro de su módulo: etapas de cotización (Cotizaciones › Etapas), recordatorios de
cobranza (Facturación › Recordatorios).

## 3. Decisiones tomadas por Domi (02-10)

| # | Decisión |
|---|---|
| D2 | Códigos actuales; Ingresos y Métricas = `VIEW/EDIT_REVENUE`; Precios = `EDIT_CONTRATOS`; permiso nuevo `CLOSE_PERIODS` para Administrador y Finanzas; códigos heredados fuera del selector |
| D3 | **Deshabilitar con aviso** ("No tienes permiso para … · pídeselo a un administrador"), no ocultar, para que no crean que la función no existe |
| D4 | Hacer cumplir los permisos en la API en los endpoints de escritura, con los mismos códigos que el front actual ya usa; antes, cruce rol × endpoint en producción |
| D8 | Cierre de períodos en la Compañía 360 |
| D9 | Productos pasa a Precios |
| D10 | Se resuelve todo; reubicado como en §1–§2 |
| D12 | Primero solo Configuración + API nueva + `useCan()`; los módulos cerrados se tocan después, uno por uno, con OK |

### Decisiones v3 (02-10, tarde) — mandan sobre la tabla de §4

| # | Decisión de Domi |
|---|---|
| D1 | **Sin migración.** El modelo ya está bien: `user_holdings` (pertenencia) → `users.role_id` (rol) → `roles` (por holding) → `role_permissions` → `permissions`. El guard verifica que el rol sea del holding activo. M1 descartada |
| D5/D6 | Invitación y desactivación **al final del bloque** |
| D7 | Roles por defecto **no** se editan ni se borran; los roles propios sí (crear, editar, duplicar, eliminar si no tiene usuarios) |
| D11 | Huecos documentados en `revision-seguridad-api.md` y en `cambios-integracion-para-leon.md` §13 (solo los que afectan al front nuevo). **Solo documentados: no se modifica ninguno hasta que Domi lo pida** |
| D13 | **Campos personalizados SÍ** (básico en este tipo de sistema): definiciones en el Holding 360; mostrarlos y editarlos en formularios y 360 de módulos cerrados va con OK por módulo. Documentos legales en la Compañía 360 con subida real por URL firmada de la API |
| D14 | No se corrige el front actual: al switch se eliminan `send-invitation`/`delete-user` y la ejecución pública de `invite_user_safe`. La invitación nueva vive en la API |
| D15 | SII dentro de la Compañía 360: **lo ve Leon** (o al menos con su OK); mientras, la pestaña Facturación enlaza a `/admin/empresas-sii` |
| D16 | Países: tabla global `countries` (ISO 3166-1 alfa-2, nombre es/en, semilla) + `CountrySelect` compartido sin texto libre; `companies.country_code` ahora (se sigue escribiendo `country` con el nombre). Clientes y razones sociales de clientes en la auditoría previa al switch con OK; integraciones a Leon |

Migraciones vigentes: M2 (cuentas), M3 (`products.status`), M4 (`CLOSE_PERIODS`), **M7** (`countries` + `companies.country_code`
con copia desde el nombre), **M8** (tabla de documentos legales con ruta de archivo, si `company_legal_documents` no sirve tal cual).
M5/M6 quedan para el cierre (invitación). Ninguna se aplica sin OK.

## 4. Decisiones que faltan (histórico v2)

| # | Pregunta | Recomendación |
|---|---|---|
| **D1** | **Rol por `user_holding`.** Hoy `user_holdings` no tiene rol: el rol está en `users.role_id` (uno por usuario). Para pasarlo hace falta migración | **M1**: agregar `user_holdings.role_id` y copiarlo desde `users.role_id` (rol del mismo holding). La API nueva lee y escribe `user_holdings.role_id` y, mientras convivan, también `users.role_id` (así el front actual ve los cambios). El front actual sigue escribiendo solo `users.role_id`: como sus usuarios no usan el front nuevo antes del switch, al switch se vuelve a copiar. Sin trigger nuevo |
| **D5/D6** | **Invitación y desactivación** (detalle en §6) | Llevar la invitación a la API con Supabase Auth (service role) + **Resend** (la misma cuenta y remitente `noreply@app.aisapira.com` que hoy). Hasta el switch el correo lleva al front actual (como hoy); después, a una pantalla del front nuevo para **crear contraseña** (además de Google/Microsoft). Desactivar = sin acceso al holding (`user_holdings.is_active = false`); ajustar `sync_user_on_login` para que no reactive al desactivado (función: decide Domi) |
| **D7** | Respondiste "NO" a "roles por defecto editables, no eliminables, con roles propios". ¿Cuál es el alcance? | Opciones: (a) roles por defecto fijos y **sin** roles propios; (b) por defecto fijos **con** roles propios; (c) todo editable. Necesito que elijas |
| **D11** | Huecos de seguridad (detalle en §7) | Grupo 1 y 2 se corrigen en este bloque (simples, sin romper a nadie); grupo 3 va a Leon; grupo 4 (edge function e invitación del front actual) ver D14 |
| **D13** | Campos personalizados y documentos legales | No migrar como función genérica: los campos de SimpliRoute se cubren con Precios v2 (2ª vuelta) y los demás son demo. Los valores ya guardados se siguen mostrando. Documentos legales: no migrar (1 fila) |
| **D14** | Dos huecos del front actual que hoy se pueden explotar: la edge function `send-invitation` no exige sesión ni permiso y mete texto sin escapar en un correo enviado desde nuestro dominio (sirve para phishing); `invite_user_safe` la puede ejecutar cualquiera y confía en el `auth_id` que le pasan | Aunque es del front actual, **corregirlos ya** (exigir sesión y permiso; escapar el HTML; validar el invitador con `auth.uid()` y quitar ejecución a `anon`) sin cambiar cómo se usan |
| **D15** | **SII** hoy vive en `/admin/empresas-sii` (módulo ya migrado) | Llevarlo como pestaña de la Compañía 360 reutilizando el mismo componente; `/admin/empresas-sii` redirige al árbol. Toca un módulo migrado: necesita tu OK |
| **D16** | **País y bandera.** `companies.country` es texto libre ("Mexico" y "México", "Peru" y "Perú") | Sin migración: el front traduce nombre → bandera con una tabla de países que acepta ambas grafías, y el formulario nuevo guarda el nombre canónico. Corregir las 2 filas sin tilde solo con tu OK |

## 5. API y base de datos

### Endpoints nuevos (módulo `settings`, todos con `HoldingScopeGuard` + permiso)

| Área | Endpoints |
|---|---|
| Holding | `GET/PATCH /settings/holding`, `GET/PUT /settings/holding/fx` (política, moneda), `GET/POST/PATCH/DELETE /settings/holding/fx-rates`, `GET /settings/holding/fx-sync-status` |
| Catálogos | `GET/POST/PATCH /settings/sellers`, `/settings/churn-reasons`, `/settings/master-data/:category` (solo condiciones de pago, tipos de ítem, unidades) |
| Correo | se reutiliza `/emails/*` corrigiendo el aislamiento por holding (D11, grupo 2) |
| Compañías | `GET/POST/PATCH /settings/companies`, `DELETE` solo si nunca se usó; `GET/PUT /settings/companies/:id/accounts`; `GET/POST/PATCH/DELETE /settings/companies/:id/bank-accounts`; `GET /settings/companies/:id/periods`, `POST .../periods/close`, `POST .../periods/reopen` (servicio propio sobre las mismas tablas; los triggers de bloqueo siguen igual) |
| Usuarios | `GET/POST /settings/users`, `PATCH /settings/users/:id` (rol), `POST .../resend-invitation`, `.../deactivate`, `.../reactivate`, `DELETE` (solo invitación pendiente) |
| Roles | `GET /settings/permissions`, `GET/POST/PATCH/DELETE /settings/roles` (según D7), `GET/PUT /settings/roles/:id/alerts` |
| Productos | `GET/POST/PATCH /products`, `POST /products/:id/archive|reactivate`, `DELETE` si nunca se usó |
| Permisos | `@RequirePermission('EDIT_X')` genérico: super admin pasa; acepta `ALL_PERMISSIONS`; lee el rol de `user_holdings` del holding activo. `BillingPermissionGuard` no se toca (D12) |

Asientos con 5 cuentas: el cambio en `revenue-metrics.service.ts` es del módulo Ingresos (cerrado) → con OK (D12).

### Migraciones (todas aditivas; cada una: commit → QA → prod con OK)

| # | Cambio | Motivo |
|---|---|---|
| M1 | `user_holdings.role_id` (FK `roles`) + copia desde `users.role_id` | D1 |
| M2 | `company_account_mappings`: `receivable_account_code/name`, `fx_difference_account_code/name`, `external_receivable_code`, `external_fx_difference_code` | Cuentas que hoy salen "Sin código" |
| M3 | `products.status` (`active`/`archived`, default `active`) | Archivar productos |
| M4 | Permiso `CLOSE_PERIODS` + asignación a Administrador y Finanzas en todos los holdings + `create_default_roles_for_holding` | D2 |
| M5 | `sync_user_on_login`: solo pasa Pendiente → Activo | Desactivar (D5) |
| M6 | Endurecer `invite_user_safe` (si D14 = sí) | Seguridad |

## 6. Invitación (detalle de D5/D6)

Hoy (front actual): la función `invite_user_safe` crea el usuario Pendiente en el holding; la edge function
`send-invitation` crea la cuenta en Supabase Auth (sin contraseña) y manda el correo por **Resend** desde
`Sapira <noreply@app.aisapira.com>` con un enlace a `/auth`, donde la persona entra con enlace mágico, Google o
Microsoft. Al primer ingreso, `sync_user_on_login` la pasa a Activo. Nunca crea contraseña.

Propuesta para el front nuevo:

1. La API invita: valida el permiso con la sesión (nunca con un id que venga en el body), crea/vincula la cuenta en
   Supabase Auth con service role, asigna holding y rol, y manda el correo por Resend (`RESEND_API_KEY` ya existe
   en la API) con la plantilla escapada. Registra `last_invitation_*` igual que hoy.
2. Enlace: hasta el switch, a la app actual (comportamiento de hoy). Después del switch, a `/auth/confirm` del
   front nuevo, que valida el token y lleva a **crear contraseña**; Google y Microsoft siguen funcionando. El token
   de Supabase expira (1 h por defecto); "Reenviar invitación" genera uno nuevo.
3. La edge function y `invite_user_safe` siguen funcionando para el front actual (endurecidas si D14 = sí).
4. Desactivar: `user_holdings.is_active = false` (la API ya lo bloquea). Con M5, el login no lo reactiva.
   En el front actual el bloqueo depende de sus lecturas directas: se verifica al construir.

## 7. Seguridad (detalle de D11)

| Grupo | Endpoints | Riesgo | Arreglo | Quién |
|---|---|---|---|---|
| 1 · Sin uso, cerrar ya | `POST /holdings/assign-to-all-holdings/:userId` | **Crítico**: cualquier usuario con sesión se da acceso a todos los holdings | Solo super admin | Este bloque |
| | `GET /users`, `/users/:id`, `/users/by-auth-id`, `/users/by-email`, `/holdings/user/:id`, `/holdings/:id` | Datos personales y de contacto de otros clientes | Mismo holding o super admin | Este bloque |
| | `/devices/*`, `/email/*` (módulo viejo) | Sin uso real | Solo super admin | Este bloque |
| 2 · Con uso, arreglo simple | `/emails/*` (dominios y remitentes) | Ver, crear, borrar dominios de otro holding y mandar correos de prueba desde su dominio | `HoldingScopeGuard` + filtro por holding en cada id + `EDIT_CONFIGURACION`. Ambos fronts ya mandan el holding | Este bloque (es la pestaña Correo) |
| | `/notifications/*` | Bajo (solo notificaciones propias) | `HoldingScopeGuard` por consistencia | Este bloque |
| 3 · Integraciones | `/odoo/products*`, `/odoo/companies*`, `/stripe/products*`, `/stripe/invoices|customers|subscriptions` (clave global), `/salesforce/mappings/*` | Alto: leer catálogos de otro cliente con sus credenciales, escribir mapeos | `HoldingScopeGuard` + validar dueño de la conexión | **Leon** (`cambios-integracion-para-leon.md`) |
| 4 · Front actual | edge `send-invitation`, RPC `invite_user_safe` | Phishing desde nuestro dominio; invitar suplantando a otro | D14 | Domi decide |

## 8. Hallazgos de datos (no se tocan)

- 0 de 24 compañías con cuentas contables: los asientos de todos salen sin código.
- Impuesto con dos escalas: Chile tiene compañías con `0.19` y con `19` (la API normaliza ambas).
- País como texto con y sin tilde (D16). Ninguna compañía tiene logo propio.
- Usuarios: 38; ningún usuario cliente en más de un holding; 4 invitaciones pendientes en SimpliRoute; 1 usuario
  sin rol (cuenta personal de Domi). Roles en uso: Administrador (21), Finanzas (3), Ventas (3).
- Correo: ningún holding configuró dominio propio. Cuentas bancarias: 9, todas en un holding.
- Cierre de períodos: solo SimpliRoute lo usó; hoy todas sus compañías están reabiertas.
- Las tres "SimpliRoute S.A.S" son compañías distintas (Argentina, Colombia, Uruguay) con el mismo nombre legal:
  dato correcto.

## 9. Orden de construcción (después del OK)

1. API: guard de permisos, endpoints de §5 y grupo 1–2 de seguridad; tests + build real + arranque.
2. Migraciones M1–M6 que se aprueben: commit → QA → prod, cada paso con OK.
3. Front: `/lab/configuracion` (árbol, Holding 360, Compañía 360, Usuarios y permisos), pestaña Productos en
   Precios, hook `useCan()` con "deshabilitado con aviso". Sin tocar módulos cerrados.
4. Con OK por módulo: permisos en Clientes, Cotizaciones, Contratos, Facturación, Ingresos, Métricas; 5 cuentas en
   Asientos; enlaces desde Asientos y Conciliación; SII dentro de la Compañía 360 (D15); cumplimiento de permisos
   en la API (D4) tras el cruce rol × endpoint.
5. Verificación, revisión de Domi en pantalla, documentación funcional y técnica, commit con OK.

## 10. Modelo de autorización (previsto para cerrar después las rutas de la revisión de seguridad)

> Decisión de Domi (02-10): Configuración define el modelo; **no** se aplica a rutas existentes en este bloque. El
> bloque de seguridad aparte ([`revision-seguridad-api.md`](./revision-seguridad-api.md)) lo usa para cerrarlas, con
> OK de Domi y coordinado con Leon.

Cadena de datos (sin migración, D1): `users` → `user_holdings` (pertenencia, `is_active`) → `users.role_id` → `roles`
(del holding) → `role_permissions` → `permissions`. `users.is_super_admin` salta todo.

Tres piezas, en este orden en cada controlador:

| Pieza | Qué valida | Respuesta | Estado |
|---|---|---|---|
| `SupabaseAuthGuard` (global) | Token válido | 401 | Existe |
| `HoldingScopeGuard` + `@HoldingId()` | Header `x-holding-id`; fila activa en `user_holdings`; `holding_id` de query/body igual al header | 400 / 403 | Existe; hoy en 17 de 57 controladores |
| `@RequirePermission(...codes)` | Super admin pasa; `ALL_PERMISSIONS` pasa; el rol del usuario debe ser **del holding activo** y tener el código | 403 "No tienes permiso para …" | Nuevo en Configuración |
| `@SuperAdminOnly()` | `users.is_super_admin` | 403 | Nuevo en Configuración (para operaciones de plataforma: syncs globales, envío a todos los holdings, herramientas internas) |

Reglas para usarlo después:
- Lectura = `VIEW_<MÓDULO>`, escritura = `EDIT_<MÓDULO>`; acciones especiales con código propio (`CLOSE_PERIODS`).
  Mapa de módulos: Clientes, Cotizaciones, Contratos (+ Precios), Facturación, Revenue (Ingresos y Métricas),
  Integraciones, Agentes IA (Automatizaciones), Configuración (+ Usuarios y roles), Dashboard, Reportes.
- Recursos por id: además del guard, la consulta filtra por el holding del recurso (`where holding_id = :holdingId`
  o join al dueño); si no es del holding → 404, sin revelar que existe.
- Credenciales de terceros nunca viajan en una respuesta (se enmascaran).
- Rutas `@Public` solo con secreto o firma propia (webhooks) o sin datos (salud).
- El front usa el mismo catálogo con `useCan(code)` (deshabilitado con aviso, D3); el front nunca es la única barrera.
- `BillingPermissionGuard` (Facturación) se reemplaza por `@RequirePermission` cuando Domi autorice tocar Facturación.

## 11. Construido · API (02-10, sin commit, sin aplicar)

Contrato vigente: [`contrato-api-configuracion.md`](./contrato-api-configuracion.md). Código en `src/modules/settings` (README) y
`src/modules/products`; guards `@RequirePermission` y `@SuperAdminOnly` en `src/guards/` (documentados en
[`autorizacion-y-tenancy.md`](./autorizacion-y-tenancy.md) → "Permisos por rol y super admin"). **No se aplicaron a rutas existentes**
(§10): solo a `settings`, `products` y `catalog`.

| Hecho | Detalle |
|---|---|
| Guard de permisos | Super admin pasa; `ALL_PERMISSIONS` salvo internos; rol del holding activo; 403 "No tienes permiso para … · pídeselo a un administrador" (D3) |
| Holding 360 | Datos + logo por URL firmada (bucket público `company-logos`), preferencias, tasas fijas por período (409 si se cruzan), estado de la sincronización FX, árbol con chips |
| Catálogos | Vendedores, motivos de baja, datos maestros (3 categorías) con uso; borrar solo sin uso |
| Campos personalizados | CRUD de definiciones (D13); nombre/tipo inmutables y borrado bloqueado si hay valores |
| Compañía 360 | Datos (país ISO + nombre, impuesto en %), 5 cuentas, cuentas bancarias, documentos legales (bucket privado `company-files`), cierre/reapertura con `CLOSE_PERIODS` en transacción propia |
| Usuarios y roles | Lista, cambio de rol, catálogo de permisos, roles propios (D7: los por defecto no se tocan), duplicar, alertas por rol |
| Productos | Lista con uso y mapeos, crear/editar/archivar/reactivar/eliminar sin uso (permiso `EDIT_CONTRATOS`) |
| Países | `GET /catalog/countries` (249 ISO) |
| Migraciones | M2, M3, M7, M8, M9 (TypeORM) y seed 004: **aplicadas en QA y producción el 02-10**. Función `create_default_roles_for_holding`: sin aplicar, revisión de Domi |

Decisiones tomadas al construir (para revisión):
- Cambiar la **moneda de una compañía** con contratos o facturas → 409 (el trigger `sync_contracts_company_currency` reescribiría
  `contracts.company_currency` de todos sus contratos).
- Cambiar la **moneda de consolidación** del holding con contratos → 409 (decisión de Domi 02-10: cambiaría todas las métricas históricas).
- M8 agrega columnas a `company_legal_documents` (no crea otra tabla); borrar un documento borra fila y archivo.
- M4 como **seed + función** (receta de la GUIA), no como migración.
- El cambio de rol y la edición de roles no dejan al holding sin nadie con `EDIT_CONFIGURACION`/`ALL_PERMISSIONS` (si antes había).
- `PUT /settings/roles/:id/alerts` reemplaza solo las suscripciones de ese rol; vale también para roles por defecto.
- `quotes` no tiene `company_id`: no cuenta para bloquear el borrado de una compañía (por diseño, la cotización llega solo con el cliente
  comercial). `create_default_roles_for_holding` (M4/M9) queda en revisión de Domi: no se cambia más desde este bloque.

## Pendientes finales (con OK de Domi)

| Pendiente | Módulo | Detalle |
|---|---|---|
| Ocultar productos archivados en los selectores | Contratos, Cotizaciones (cerrados) | Hoy un producto con `status = 'archived'` sigue apareciendo al agregar ítems; filtrarlo toca módulos cerrados y va con OK por módulo |

## 12. Auditoría del 02-10 (noche) · API, front, enlaces y UI

Sin acceso entre holdings; permisos correctos en los 6 controladores; las 45 rutas de la BFF calzan con la API.

**Arreglos directos (módulo nuevo, sin cambio de reglas):** conteos de uso de datos maestros (facturas antiguas,
importaciones de cantidades), fechas imposibles en tasas (500 → 400), documento legal repetido (500 → 409), cuenta
bancaria con cartolas no cambia moneda ni número, renombrar holding propaga `companies.holding_name`, duplicar rol
filtra códigos no otorgables, lock del cierre (`FOR NO KEY UPDATE`), mensajes sin nombres internos, conteo agrupado de
campos personalizados, búsqueda de productos con `%`/`_`, estados "sin aplicar" en docs; front: abrir/descargar
documentos (bloqueo de ventanas), vista rápida de usuario mientras carga, reinicio de "Cambiar rol" y bloqueos (super
admin, uno mismo, varios holdings), error de contexto ≠ "sin permiso", `SaveButton` en Duplicar y Subir logo, decimales
de tasa, validar body al editar compañía, regla de fila/ojo en listas sin 360, confirmación al cambiar moneda de
consolidación, accesibilidad del árbol, tipo de documento con Combobox, `?catalogo=` en la URL, estado SII solo para
Chile, concordancia de género, nombres de cuentas por defecto en español, permiso de lectura en la página, invalidar
opciones de formulario de Contratos y Cotizaciones; enlaces desde Configuración: Integraciones con `Link`, usuario ↔
rol, rol → usuarios, producto → contratos/cotizaciones/precios donde se usa, compañía → sus contratos y facturas,
cuenta bancaria → Conciliación, cuentas y cierre → Ingresos. Quitar la pestaña Condiciones de pago (decisión Domi).

**Requieren OK de Domi (módulos cerrados o compartidos):** Ingresos lee las 5 cuentas, exporta códigos del ERP y
enlaza "cuentas contables de la compañía" y el cierre a la Compañía 360; Facturación enlaza Conciliación y bloqueos
de la cola a Configuración y corrige "Producto sin mapeo en Odoo" → "ERP"; `Segmented` de Contratos con `disabled`;
barra de selección responsive (`DataTableBulkBar`); productos archivados fuera de los selectores (pendiente final).
SII "Volver" a la Compañía 360: Leon (D15).

**Decisiones pendientes:** lecturas de compañía y períodos para quien tiene `CLOSE_PERIODS`; Editar implica Ver;
cerrar solo meses terminados; límites del bucket de logos (2 MB, PNG/JPG/WebP); rechazar impuesto entre 0 y 1; índices
únicos (vendedor por correo, código de producto, cuenta bancaria).

**Costura `sapira.writer`:** no aplica a Configuración: los triggers de las tablas que escribe son `updated_at` o
invariantes (validación de tasas y de compañía/holding); `sync_contracts_company_currency` se neutraliza bloqueando el
cambio de moneda con contratos.

### 12.1 Hecho el 03-10 (API, sin commit, sin aplicar nada)

Contrato actualizado a v2.1 ([`contrato-api-configuracion.md`](./contrato-api-configuracion.md)); README del módulo al día.

| # | Decisión / hallazgo | Hecho |
|---|---|---|
| 1 | Quitar Condiciones de pago | `master-data` solo `item_types` y `units_of_measure` (DTO, controlador, servicio, tests). Las filas `payment_terms` siguen; Contratos no se tocó |
| 2 | Uso de Tipos de ítem y Unidades | Conteo por texto exacto en `contract_items`, `quote_items`, `subscription_items`, `invoice_items`, `invoice_items_legacy`, `quantities`, `sapira_quantity_imports` (columnas verificadas con `information_schema`); desglose `usage: { contracts, quotes, subscriptions, invoices, quantities }` |
| 3 | Fechas imposibles | `@IsIsoDate` (calendario real) en tasas y cierre/reapertura → 400 con mensaje; el interceptor cubre `22007/22008` |
| 4 | Nunca 500 sin mensaje | `settings-db-errors.ts`: interceptor en los 6 controladores de Configuración y en Productos (unicidad, FK, CHECK, NOT NULL, formato, trigger de tasas por solapamiento → 409 `Ya existe una tasa para ese par en esas fechas`, `RAISE` → 409, bloqueos → 409); documento legal repetido → 409 en el servicio |
| 5 | Cuenta bancaria con cartolas | No cambia moneda ni número (409) |
| 6 | Holding sin renombrar | `name` fuera del PATCH (400 claro si llega). Deja sin efecto el arreglo "propagar `companies.holding_name`" |
| 7 | Moneda de consolidación y política FX | 409 con contratos para cada una; GET de preferencias con `locked` y `locked_reason` |
| 8 | Finanzas entra a Configuración | `seed/005-finanzas-view-configuracion.sql` (idempotente, 7 roles Finanzas por defecto en prod) y `VIEW_CONFIGURACION` en la función; `ADMIN_FULL_ACCESS` quitado de la función (no existe en el catálogo). Sin aplicar |
| 9 | Editar incluye Ver | `PermissionsService.allows`: `EDIT_X` satisface `VIEW_X`; crear/editar/duplicar rol agrega `VIEW_X` |
| 10 | Cierre solo de meses terminados | `until_date` ≤ último día del mes anterior a hoy (hora Chile) → si no, 409 |
| 11 | Bucket de logos | Migración `1790810000000-CompanyLogosBucketLimits` (2 MB; PNG, JPG, WEBP; sin aplicar; hoy sin límites, 21 PNG ≤ 125 KB); SVG fuera del DTO y la validación |
| 12 | Resto de §12 | Duplicar rol filtra con `isGrantable`; cierre con `FOR NO KEY UPDATE`; mensajes en español de negocio; conteo agrupado de campos personalizados; `%`/`_` literales en productos; uso de productos cuenta `invoice_items_legacy_match`; nombres por defecto de cuentas en español al leer; docs con M2, M3, M7, M8, M9 y seed 004 aplicadas el 02-10 |
| 13 | Resumen del holding | `GET /settings/holding` con `users_count` (miembros activos sin super admins) y `last_activity_at` (`users.last_access` más reciente) |
| 14 | SII en la compañía | `CompanyDetail.sii_configured` |
| 15 | Ingresos (OK de Domi, módulo cerrado) | Asientos leen las 5 cuentas con `external_code` (respuesta y export); `no_account_mapping` usa el criterio único de "completas" (`src/core/utils/account-mappings.ts`) |
| + | Cierre de períodos no bloquea pagos, facturas ni consumos (agregado de Domi) | Fuera `period_closed` de la cola Por emitir, de pagos (registrar/anular, conciliar/deshacer), de consumos y de todas las operaciones de factura en Contratos (`contract-invoices.ts`, `invoice-edit`, `invoice-void`, `invoice-reorganize`, `invoice-consolidation`, chequeo de facturas en la activación). Se mantienen `contract-changes.ts` y los triggers `trg_period_guard_contracts`/`_contract_items`. No hay triggers de período en facturas ni pagos (verificado en prod 03-10) |

Pendiente para después (anotado, no hecho): índices únicos, archivos huérfanos en Storage, productos archivados en selectores, impuesto por
tipo de documento tributario. La descripción del rol Finanzas ("Control financiero completo sin configuración") quedó desactualizada.


## 13. Ronda 3 (03-10, API, sin commit, sin aplicar nada)

Contrato v3 ([`contrato-api-configuracion.md`](./contrato-api-configuracion.md) §8). Decisiones de Domi del 03-10 incluidas las
simplificaciones del mismo día (sin activación de documentos por compañía).

| # | Pedido | Hecho |
|---|---|---|
| 1 | Impuesto por documento tributario | M11 `1790820000000-TaxDocumentTypesTaxRate` (`tax_document_types.tax_rate` + CHECK 0–100; CL 33=19, 34/110/111/112=0; PE 01/03=18; MX CFDI-I=16; CO FE=0; notas nacionales y genéricos NULL) + seed 006 para entornos nuevos. `GET /settings/companies/:id/tax-documents` **solo lectura** (país o genéricos, tasa, tasa efectiva, regla, uso). Contratos: `form-options` igual que hoy + `tax_rate` por opción. Motor: `resolveTaxRate` |
| 2 | Comunicaciones | `/settings/communications/domains|senders|test-email` con holding validado e id filtrado por holding; reutiliza `EmailsService` (SendGrid). Rutas viejas intactas; nota a Leon en [`cambios-integracion-para-leon.md`](./cambios-integracion-para-leon.md) §13 |
| 3 | Detalle de tipos de cambio | `GET /settings/holding/fx-sync/history` (diario directo/inverso/cruce USD) y `/fx-sync/monthly` (`exchange_rates_monthly_avg` directo o inverso; si falta, promedio del diario) |
| 4 | Catálogos | `master-data` acepta `markets`, `segments`, `industries` (uso = `clients.market/segment/industry`, verificadas); `GET /settings/business-types` y `GET /settings/contact-types` (solo lectura) |
| 5 | Pendientes | `holdings_count` en `GET /settings/users`; `company_id` en la excepción `no_account_mapping` de Ingresos |
| 6 | Campos personalizados con más tipos | M12 `1790830000000-CustomFieldTypes` (`options jsonb`, CHECK con `select`, `boolean`, `date`; `options` solo en `select`). API: valida opciones, `option_usage`, 409 al quitar una opción en uso |
| 7 | País ISO y listas en Clientes (autorizado) | M13 `1790840000000-ClientsCountryCode` (`clients`/`client_entities.country_code` FK `countries`, backfill tolerante: espacio duro, tildes, inglés, códigos, alias). API de clientes y razones sociales lee/escribe `country_code` (y `country` en español); mercado/segmento/industria validados contra `master_data` activo (el mismo valor viejo se conserva); `GET /clients/form-options` |

### 13.1 Impuesto por documento: todos los caminos (verificación pedida por Domi)

Regla única `resolveTaxRate` (`src/modules/contracts/billing-engine.ts`): exportación 0 → Colombia 0 (lo aplica el ERP) → tasa del
documento del contrato si no es NULL y es de la misma familia de la factura → tasa de la compañía. `taxRateFor` (modificaciones) y
`taxRateForDocument` (editor/reorganización) delegan en ella; tests en `billing-engine.spec.ts` (4 casos + familia/1 %),
`contract-changes.spec.ts` (paridad y 33 → 34) y `tax-document-types.spec.ts`.

| Camino que crea o recalcula facturas | Fuente de la tasa | Estado |
|---|---|---|
| Activación de contrato (Por Emitir nuevas) | motor con el documento del contrato | ✔ usa `resolveTaxRate`; ya no bloquea `no_tax_rate` si el documento tiene tasa |
| Vista previa del alta / borrador, cotización → contrato (mismo alta) | motor con el documento elegido | ✔ |
| Modificaciones (agregar producto, renovar, precio/cantidad, frecuencia, multimoneda, reactivar, cambio de receptor) | `engineContract` + `taxRateFor` | ✔ (`tax_document_tax_rate` en el contexto) |
| Cambio de documento en Condiciones de facturación | `taxRateFor` con el documento NUEVO | ✔ re-calcula las Por Emitir desde la fecha efectiva si cambia la familia **o la tasa** (33 → 34) |
| Edición de factura (cambio de receptor) y regeneración desde el editor | `taxRateForDocument` / motor | ✔ |
| Reorganizar facturas (factura nueva del generador) | `taxRateForDocument` con el documento del contrato | ✔ |
| NC/ND de anulación y de descuento | heredan la tasa de la factura que corrigen | ✔ sin cambio (correcto según la regla) |
| Consolidar facturas, OC parcial (remanente), consumos sobre una factura, revalorización multimoneda | heredan la tasa de la(s) factura(s) de origen | ✔ sin cambio |
| Facturación v2 (`src/modules/billing`) | no crea facturas: lee/marca las de Contratos | n/a |
| Emisión al ERP (`invoice-scheduler`) | envía la tasa guardada de la factura | n/a (Odoo no cambia) |
| Odoo `invoice-processing` y Stripe sync | integraciones de Leon: crean facturas desde el ERP/Stripe con la tasa de origen | sin tocar (fuera de alcance) |

**Triggers y funciones heredadas** (las usa solo el front actual; no se tocaron): `trigger_auto_populate_invoice_tax_rate` →
`auto_populate_invoice_tax_rate` (copia `companies.tax_rate` si la factura llega sin tasa; **no-op en transacciones de la API** por la
costura `sapira.writer`), y funciones SQL que fijan `tax_rate` desde la compañía: `generate_invoices_for_contract_item`,
`generate_missing_invoices_for_contract`, `sync_invoices_for_contract_item`, `create_contract_renewal`, `approve_contract_amendment`,
`apply_contract_contraction`, `apply_quote_downsell_to_contract`, `edit_pending_invoice`, `emit_invoice_manually`,
`create_credit_note_safe`, `adjust_issued_invoice`, `invoice_reschedule_items`, `update_pending_invoices_on_override`,
`sync_invoice_items_amounts_from_quantities`, `restore_invoice_items_amounts_on_quantity_delete`, `reconcile_legacy_invoice`,
`apply_fixed_fx_to_contract`, `auto_populate_invoice_fx_to_system`. Mientras el front actual siga vivo, una factura creada por él usa la
tasa de la compañía aunque el contrato tenga un documento exento.

**Solo hacia adelante**: no se recalculó nada. Consulta de solo lectura para decidir caso a caso antes del switch (Por Emitir cuya tasa
guardada difiere de la que daría su documento con la regla nueva; corrida en producción el 03-10: **0 filas**; hoy solo 24 Por Emitir
tienen documento del catálogo, de Hanka Chile 33 y Hanka México CFDI-I):

```sql
WITH rates(country_code, code, rate) AS (VALUES
  ('CL','33',19::numeric),('CL','34',0),('CL','110',0),('CL','111',0),('CL','112',0),
  ('PE','01',18),('PE','03',18),('MX','CFDI-I',16),('CO','FE',0)),
base AS (
  SELECT h.name AS holding, t.country_code || ' ' || t.code AS documento,
    CASE WHEN i.tax_rate > 0 AND i.tax_rate <= 1 THEN i.tax_rate * 100 ELSE i.tax_rate END AS tasa_guardada,
    CASE
      WHEN t.kind = 'export_invoice' OR i.document_type = 'FACTURA_EXPORTACION' THEN 0
      WHEN COALESCE(trim(co.country_code), '') = 'CO' OR lower(co.country) = 'colombia' THEN 0
      WHEN r.rate IS NOT NULL THEN r.rate
      ELSE CASE WHEN co.tax_rate > 0 AND co.tax_rate <= 1 THEN co.tax_rate * 100 ELSE co.tax_rate END
    END AS tasa_nueva
  FROM invoices i
  JOIN contracts c ON c.id = i.contract_id AND c.deleted_at IS NULL
  JOIN tax_document_types t ON t.id = c.tax_document_type_id
  LEFT JOIN rates r ON r.country_code = t.country_code AND r.code = t.code
  LEFT JOIN companies co ON co.id = c.company_id
  JOIN company_holdings h ON h.id = i.holding_id
  WHERE i.status = 'Por Emitir' AND COALESCE(i.is_legacy, false) = false)
SELECT holding, documento, tasa_guardada, tasa_nueva, count(*) AS facturas
FROM base WHERE tasa_guardada IS DISTINCT FROM tasa_nueva
GROUP BY 1, 2, 3, 4 ORDER BY 1, 2;
```
(Tras aplicar M11 se puede reemplazar el CTE `rates` por `t.tax_rate`.)

**Arreglo de paso**: `contract-changes.service.ts` buscaba el documento nuevo con `tax_document_types.is_active` (la columna es `active`):
cambiar el documento desde Condiciones de facturación respondía 500. Corregido.

### 13.2 DTE chileno (revisión, sin implementar SII)

`src/modules/sii/**` (Leon) hoy guarda configuración, certificado y CAF por tipo (`enabled_document_types: [33, 34, 61]`) y reserva
folios; no arma el DTE. La referencia de emisión (notta.cl) pide: tipo (33, 34, 56, 61, 110, 112), RUT emisor, receptor (RUT, razón
social; en 33/34 giro, dirección y comuna), líneas (nombre ≤ 80 → ya cubierto por `description_max_chars`, cantidad, precio, `exento`
por línea, monto, descuento), totales (`monto_neto`, `monto_exento`, `iva` a 19 %, `monto_total`), referencias (NC/ND: tipo, folio,
fecha, código 1/2/3 y razón; comerciales: OC, contrato, HES), forma de pago (33/34) y, en exportación, moneda, indicador de servicio,
aduana y tipo de cambio.

**Calza**: tipo de documento por contrato (código SII en `tax_document_types.code`), tasa 19/0 por documento (33 afecta, 34 y 110/112
exentas → `monto_exento`), largo de glosa, referencias del contrato (OC/HES) y vínculo NC → factura de origen (`related_invoice_id`).
**Falta para emitir** (para cuando se haga SII, no ahora): giro y comuna del receptor (`client_entities` no los tiene separados: hay
`economic_activity` y dirección libre), marca **exento por línea** (hoy la exención es por documento; una 33 con líneas exentas mixtas no
se puede representar), `forma_pago` (derivable de `payment_terms`: contado → 1, plazo → 2), código de referencia 1/2/3 en NC/ND
(hoy hay `credit_reason` en texto), folio SII en la factura (lo reserva `sii` pero no se guarda en `invoices`), y datos de exportación
(glosa de moneda SII, indicador de servicio, aduana).

### 13.3 Pendiente (anotado)

- `POST .../domains/:id/check-status` con `EDIT_CONFIGURACION` (escribe el estado guardado; decisión 03-10).
- Entity de `custom_field_definitions` (generada desde prod): agregar `options` y el CHECK nuevo **junto con** `schema:snapshot` justo
  después de aplicar M12 en producción (confirmado 03-10, según la GUIA) (si se edita antes, `base-tenancy.entities.spec` marca deriva). Las de `clients`/`client_entities` ya
  declaran `country_code` (no las mide un snapshot).
- Orden de despliegue: M11, M12 y M13 **antes** del código (la API ya lee `tax_document_types.tax_rate`, escribe `options` y
  `country_code`). Sin las migraciones, esas rutas fallan con 500.
- Los valores de mercado/segmento/industria que hoy no están en `master_data` se siguen devolviendo; limpieza antes del switch.

## 14. Preferencias pendientes (inventario 03-10, propuesta para Domi)

**A · Preferencias simples (propuestas para este bloque):** vigencia por defecto de cotizaciones (hoy 30 días fijo,
`quotes.service.ts:67`, `cotizacion-form.ts:64`); formato del correlativo de cotización (hoy `COT-{año}-{NNNN}`,
`quote-status.ts:250`); escalera de avisos de renovación (hoy `[60,30,15,7,0]` fija en `contract-renewals.ts:106-107`) y
aviso de 90 días fijo en `ClienteContratosTab.tsx:23` que no lee `auto_renewal_notice_days`; zona horaria del holding
(hoy `America/Santiago` fija en `business-date.ts`, `client-activity.service.ts:33`, `ClienteActividadTab.tsx:38` y
crons); horizonte de ítems sin término (12 períodos, `contrato-form.ts:153`); `companies.fx_company_policy` con
`fixed_period` y pantalla en la Compañía 360 (CHECK hoy solo `monthly_avg`).

**B · Reglas de reconocimiento de ingresos (mini spec aparte, dominio de Domi, Compañía 360 › Reconocimiento de
ingresos):** granularidad diaria/mensual por compañía (`auditoria-contratos.md` M6, `spec-revenue-y-metricas.md` R9;
`financial_settings.recognition_granularity` nadie lo lee); devengo de no recurrentes (al facturar / % avance /
lineal; M12; `revenue_rules` vacía); política de variables al cierre (true-up vs al facturar; S5-17); cierre
automático N días con aviso de Por Emitir pendientes (`auditoria-contratos.md:668`); librería de reglas por producto y
política de descuentos (R9, D5: pestaña "Reglas" de Ingresos oculta).

**C · En sus módulos:** preferencias de notificaciones por usuario y resumen semanal (Notificaciones); aprobación de
agentes y configuración por cliente (Automatizaciones); metas y resumen semanal (Métricas); año fiscal y probabilidad
por etapa (Presupuestos); plantilla de glosa por holding y correlativo de proforma (Contratos/Facturación); "sin OC no
se envía" por compañía (Facturación); ventana de tardíos/backfill de consumos (Precios); vistas guardadas en servidor
(`user_view_preferences` existe); umbral de comisión de Conciliación en servidor; zona de IPC/redondeo por defecto en
pactos; aprobaciones, plantillas de contrato e intercompañía (después del switch).

## 15. Ronda 4 (03-10, API, sin commit, sin aplicar nada)

Contrato: [`contrato-api-configuracion.md`](./contrato-api-configuracion.md) §9. Migración única **M14**
`1790850000000-HoldingSettingsPreferencesV4` (aditiva, sin aplicar): columnas nuevas en `holding_settings` cuyos defaults reproducen el
comportamiento de hoy. La API lee las preferencias con `to_jsonb` (`src/core/utils/holding-preferences.ts`), así que desplegar el código
antes de M14 no rompe nada (todo cae a los defaults); solo `PATCH /settings/holding/preferences` necesita M14.

### 15.1 Construido

| # | Qué | Dónde |
|---|---|---|
| 1 | **Documento tributario solo con cambio de razón social** (Contratos, autorizado). `billing_conditions` con documento (o familia) distinto → bloqueo `tax_document_requires_party_change` (preview `can_apply: false`; aplicar 409 "El documento tributario solo cambia junto con la razón social emisora o receptora"). `change_entity` acepta `tax_document_type_id` (o `document_type` sin catálogo): lo guarda y recalcula el IVA de las Por Emitir desde la fecha efectiva con `resolveTaxRate` (`taxRateFor`); metadata `tax_document_before/after` | `contract-changes.ts` (`planBillingConditions`, `planChangeEntity`), `contract-changes.service.ts` (carga del documento también en `change_entity`), DTO |
| 2 | **Numeración de cotizaciones** (Cotizaciones, autorizado): `prefixed` (default `COT-{año}-{NNNN}`, prefijo/año/ancho configurables), `sequential` (solo correlativo) y `manual` (la usuaria lo escribe al crear; obligatorio y único, 409 `quote_number_taken`). En los automáticos un número escrito → 400. Solo cotizaciones creadas en Sapira (las del CRM conservan su número). Vista previa en preferencias y en `GET /quotes/form-options` | `quotes.service.ts` (`reserveNumber`, `formOptions`), `holding-preferences.ts` (`quoteNumberFormat`, `nextQuoteNumber`), DTO de duplicar |
| 3 | **Recordatorios de vencimiento**: escalera (`renewal_reminder_days`, default `[15,7,0]`) y frecuencia vencido (`renewal_overdue_every_days`, default 7) por holding. El job 06:15 y la tarjeta del detalle de contrato los leen (antes la tarjeta usaba siempre 30 días de aviso). `GET /clients/form-options` expone `renewal_notice_days` para el aviso del Cliente 360 | `contract-renewals.ts` (`reminderLadder`, `reminderThreshold`, `dueReminders`, `loadRenewalReminder`), `contract-renewals.service.ts`, `contracts.service.ts`, `clients.service.ts` |
| 4 | **Zona horaria del holding** (`timezone`, IANA validada con `Intl.supportedValuesOf`): el "hoy" de cada holding (`todayFor(zona)`) en jobs de contratos, cambios, activación, borradores, consumo, 360 y lista/detalle de contrato, Facturación (cola, exportación, pagos, conciliación, cobranza y su job), actividad del cliente y el año del correlativo de cotizaciones | ver §15.2 |

### 15.2 Zona horaria: lugares cambiados

- `src/modules/contracts/business-date.ts`: `todayFor(zona)` sigue siendo la utilidad única; el default `America/Santiago` queda como
  respaldo. La zona se lee con `holdingTimezone` / `loadHoldingPreferences`.
- Jobs de contratos (`contract-renewals.service.ts`: propuestas, recordatorios, pactos por vencer, lista de propuestas;
  `contract-changes.service.ts`: "hoy" del job de horizonte, que sigue en 12 fijo). Los `@Cron` siguen en `America/Santiago` (hora de disparo del servidor).
- Contratos: `contract-changes.service.ts` (preview y aplicar), `contract-activation.service.ts`, `contract-drafts.service.ts` (eventos y
  correlativo), `consumption.service.ts`, `contract-scheduled-changes.service.ts`, `contract-360.service.ts`, `contracts.service.ts` (lista,
  detalle e ítems; antes usaban la fecha UTC).
- Facturación: `billing-read.service.ts` y `billing-reconciliation.service.ts` (`today()` ahora recibe el holding), `billing-export.service.ts`,
  `billing-payments.service.ts`, `billing-collections.service.ts` (incluye el job de recordatorios de cobro).
- Clientes: `client-activity.service.ts` (`AT TIME ZONE $3`, la zona del holding).
- Cotizaciones: año del correlativo.

**No cambiados (anotado):** `accounting-periods.service.ts` (`todayInChile`, cierre de períodos por compañía), `metrics-period.ts`
(`currentMonth`), `quotes.service.ts` (`todayIso` UTC para la fecha por defecto y vigencia), `invoice-scheduler.service.ts`,
`billing.scheduler.ts`, schedulers de Banco Central, Salesforce y BigQuery (globales, no por holding) y `main.ts` (`process.env.TZ`).

### 15.3 Decisiones aplicadas y notas

- Cambio de razón social **emisora** (compañía) no existe hoy en ningún camino de un contrato activo (solo en borradores, donde el
  documento se elige libremente); el bloqueo deja el documento atado al cambio de receptora hasta que exista ese camino.
- **Horizonte de ítems sin término: fijo en 12 períodos, rodante; no configurable** (Domi 03-10). Se llegó a construir como preferencia
  (1, 3, 6 o 12, también en la activación) y se revirtió completo: sin columna en M14, sin campo en preferencias ni en form-options; la
  activación genera 12 y el job `contracts-extend-horizon` mantiene 12 por delante (`HORIZON_PERIODS_AHEAD`). Nota de esa revisión: el
  devengo (`revenue_schedule_rebuild_contract_ccy`) solo cuenta facturas emitidas, no las Por Emitir, así que el número de Por Emitir
  generadas no altera el RSM.
- Cambiar zona, escalera o numeración no tiene bloqueo con contratos: rigen hacia adelante y no recalculan nada.
- Entity `holding-settings.entity.ts`: se actualiza con `schema:snapshot` después de aplicar M14 en producción.

### 15.4 Pendientes de Configuración (no construidos)

- **Plantilla de glosa por holding** (hoy la glosa sale de la plantilla del contrato o del default del motor).
- **Correlativo y formato de proforma** por holding.
- **Vigencia por defecto de cotizaciones** (hoy 30 días fijo en `quotes.service.ts` y en el formulario del front).


## 16. Usuarios: invitar, reenviar, acceso, eliminar y recuperar contraseña (03-10, API, sin commit, sin aplicar nada)

Contrato: [`contrato-api-configuracion.md`](./contrato-api-configuracion.md) §10 (10.1–10.6). Diseño aprobado por Domi el 03-10; cambios
del mismo día: `sync_user_on_login` **no se toca** y recuperar contraseña pasa a la API.

### 16.1 Diseño

| Pieza | Dónde | Qué hace |
|---|---|---|
| `SupabaseAdminService` | `src/auth/accounts/supabase-admin.service.ts` | Clave de servicio (patrón de `settings-storage.service.ts`, 503 si falta): `generateLink` (`invite`; si `email_exists` → `magiclink`; `recovery`), `setBanned` (`ban_duration` `876000h` / `none`), `deleteUser`. `generateLink` no manda correo |
| `AuthMailer` | `src/auth/accounts/auth-mailer.ts` | Resend por HTTP (`RESEND_API_KEY`), remitente `INVITE_FROM` (default `Sapira <noreply@aisapira.com>`), `Idempotency-Key`, **nunca lanza** (`sent` / `failed`). `INVITE_TEST_ALLOWLIST` (solo QA) limita a quién se invita |
| Plantillas | `src/auth/accounts/email-templates/` (`layout.ts`, `invitation.ts`, `recovery.ts`) | Layout común de la marca (logo PNG con `alt`, violeta `#4917C6`, pie `Sapira · aisapira.com`, tablas, estilos en línea, 600 px, preheader) + texto plano. Todo valor pasa por `escapeHtml` (centralizado en `src/core/utils/escape-html.ts`; Facturación lo reexporta). Ejemplos: `SAPIRA_EMAIL_PREVIEW_DIR=<carpeta> npx jest src/auth/accounts/auth-mailer.spec.ts` |
| `SettingsUserAccessService` | `src/modules/settings/settings-user-access.service.ts` | Invitar, reenviar, acceso y eliminar invitación; audita cada acción en `user_access_events` |
| `PasswordRecoveryService` | `src/auth/accounts/password-recovery.service.ts` + `POST /auth/password-recovery` | Público, siempre 200 con el mismo mensaje, no espera el trabajo |
| Rate limit | `src/auth/accounts/actor-throttle.ts` | Invitar 20/min **por actor**: el `ThrottlerGuard` global corre antes de la sesión, así que el tracker usa el `sub` del JWT sin verificar (seguro: un `sub` inventado lo rechaza `SupabaseAuthGuard`). Recuperar: 10/min por IP real (`forwardedIpTracker`: primera IP de `X-Forwarded-For` que manda la BFF, si no la del socket; la BFF ya limita 3/min) + 1/min y 5/día por correo en el storage del throttler, en silencio |

### 16.2 Decisiones

- **Actor y holding nunca del body**: actor = `PermissionContext` de la sesión; holding = `HoldingScopeGuard`. Nombre del holding e invitador
  para el correo se leen de la base. `forbidNonWhitelisted` rechaza `invited_by` y similares (400); `holding_id` distinto → 403.
- **Invitar** crea `users` (Pendiente, rol, nombre) + `user_holdings` (activo, `selected = false` como `invite_user_safe`) en una transacción;
  después Auth. Si Auth falla se borra la fila (cascada a la membresía) y, si la cuenta de Auth la creó esta invitación, también la
  cuenta → 502. Si el correo falla, la invitación queda (201 `failed`, "usa Reenviar"). Correo existente: activo aquí / desactivado aquí /
  super admin / en otra empresa → 409 con mensaje propio (no se suma a una persona de otro holding desde aquí: soporte).
- **Reenviar** solo Pendiente que nunca entró y con acceso activo aquí; token nuevo `magiclink`; 60 s entre envíos y 5 en 24 h por persona
  (en cualquier holding), contados en `user_access_events` (cuenta intentos, también los fallidos).
- **Desactivar** (`assertKeepsConfigAdmin` con `leavingUserId`, nuevo override de `settings-admins.ts`): Auth primero (ban si era su última
  membresía activa; si falla, 502 sin tocar la base), luego `user_holdings.is_active = false, selected = false` y `status = 'Inactivo'`;
  si la base falla, se deshace el ban. **El bloqueo real es el ban de Auth**: un baneado no inicia sesión, así que `t_sync_user_on_login`
  no corre y no lo vuelve a `Activo` (por eso la función queda intacta, decisión de Domi 03-10). Con otros holdings activos solo se
  desactiva la membresía (la API ya exige membresía activa en `HoldingScopeGuard`). **Reactivar**: inverso; `status` vuelve a `Activo` si
  alguna vez entró, si no a `Pendiente`. Uno mismo → 409; super admin → 409; ya en el estado pedido → 200 sin evento.
- **Eliminar invitación** solo Pendiente sin `last_access` ni referencias. Las FK hacia `users` se leen de `pg_constraint` **en el momento**
  (40 FKs en prod el 03-10) salvo las propias de la persona (`user_holdings`, `user_view_preferences`, `app_notification_recipients`,
  `user_access_events`); un `EXISTS` por FK en una sola consulta. Ojo: `invoice_items_legacy_match.created_by` es `ON DELETE CASCADE` y no
  está en la lista propia, así que una referencia ahí bloquea (no se borra historia por cascada). En varios holdings solo se quita la
  membresía; si no, se borra `users` y después la cuenta de Auth (si Auth falla solo se registra).
- **`GET /settings/users`** agrega `ever_signed_in` e `invitation_status` (`access_active` ya existía).
- **Recuperar contraseña** (10.6): solo cuentas con `auth_id` y `status` distinto de `Inactivo`; enlace
  `${INVITE_LANDING_URL}/auth/confirm?token_hash=…&type=recovery&next=/bienvenida?modo=recuperar`. No se audita en `user_access_events`
  (no hay holding): queda en el log.
- **Migraciones** (sin aplicar): **M15** `1790860000000-UserAccessEvents` (tabla + entity `base-tenancy/user-access-event.entity.ts`, RLS sin
  policies; `actor_user_id` nullable con FK `SET NULL` para no bloquear el borrado de quien invitó) y **M16**
  `1790870000000-UserHoldingsReadOnlyForClients` (policy `user_holdings_policy_direct` a solo SELECT + REVOKE de escrituras; asset `rls/`
  actualizado y `grants/040-user-holdings-read-only.sql`). Orden: M15 antes de desplegar la API; M16 cuando Domi dé el OK (no depende del
  código). Detalle en el contrato §11.

### 16.3 Verificación de M16 (03-10, solo lectura)

- `sapira-ai/src`: `user_holdings` solo se **lee** (`UsuariosList.tsx:134`, `contratos/hooks/useUsers.ts:41`, `revenue/RevenueRulesTab.tsx:94`).
- Edge functions: `send-collection` y `send-proforma` leen; `send-invitation` lee (embed); `delete-user` usa el cliente admin (service role).
- Escriben `user_holdings` en prod solo funciones **SECURITY DEFINER** (corren como su dueño, no las afecta): `invite_user_safe`,
  `create_user_holding_association_safe`, `create_user_holding_safe`, `delete_user_complete`, `sync_user_on_login`. Ninguna función
  SECURITY INVOKER la escribe.
- **`users` no se toca en M16.** Escrituras directas del front actual sobre `users` (con la anon key y RLS `users_*_v2`):
  `configuracion/UserFormModal.tsx:114` (UPDATE `name`, `role_id` al editar), `hooks/useRolesAndPermissions.ts:192` (UPDATE `role_id`,
  `status = 'Activo'` por `auth_id` al asignar admin), `hooks/useConfiguracionInicial.ts:112` (INSERT del usuario en la configuración
  inicial); edge `send-invitation` actualiza `auth_id` y `last_invitation_*` (service role). Anotado en `revision-seguridad-api.md` #22.

### 16.4 Al switch (anotado, no hecho)

- Mover a la API "Pendiente → Activo + `last_access` en el primer ingreso" y **eliminar el trigger `t_sync_user_on_login`** (incluida la rama
  "Empresa de X" que crea un holding a quien entra sin invitación; hoy el registro libre está apagado en Supabase).
- Revocar `EXECUTE` de `invite_user_safe`, `update_user_role_safe`, `delete_current_user` (la llama `sapira-ai/src/pages/Auth.tsx:28`) y
  `delete_user_complete`; borrar las edge functions `send-invitation` y `delete-user`. **`send-proforma` y `send-collection` también usan el
  secreto de Resend** (`RESEND_API_KEY` en los secretos de Supabase): no rotarlo ni borrarlo hasta migrar esos envíos.
- `users_update_v2` y `delete_current_user` quedan como pendientes de revisión en `revision-seguridad-api.md` (#22, #23).

### 16.5 Pendientes de configuración (Domi / QA)

- **Vencimiento del enlace**: los correos dicen "El enlace vence en 24 horas"; en Supabase Auth el vencimiento del OTP por correo debe
  quedar en 86400 s (el default es 3600). Verificar en el dashboard de QA y prod antes de activar.
- Variables nuevas en la API: `INVITE_LANDING_URL` (obligatoria), `INVITE_FROM`, `EMAIL_LOGO_URL` (opcionales) e `INVITE_TEST_ALLOWLIST` (solo QA).
  `SUPABASE_SERVICE_ROLE_KEY` y `RESEND_API_KEY` ya existen. El dominio del remitente (`aisapira.com`) debe estar verificado en Resend.
- El front nuevo necesita `/auth/confirm` (verifica `token_hash` con `verifyOtp` y lleva a `next`) y `/bienvenida?modo=recuperar`.

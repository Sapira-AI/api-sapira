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
| `holding_integration_settings` | 0 filas, sin entity, sin uso | Se elimina tras el switch |
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
| Migraciones | M2, M3, M7, M8, M9 (TypeORM) y M4 (seed + función, **para revisión de Domi**). Ninguna aplicada |

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

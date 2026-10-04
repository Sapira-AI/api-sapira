# Estado de Sapira v2 y plan para el switch

> **Leer primero al abrir una sesión nueva.** Foto del avance del front nuevo (`front-sapira`, módulos en
> `app/(protected)/lab/<modulo>`) y de la API (`api-sapira`): qué está construido, qué quedó pendiente por
> decisión, qué falta construir y qué hay que hacer antes del switch. El plan general sigue en
> [`ROADMAP-V2.md`](../../ROADMAP-V2.md); el detalle de cada módulo, en sus specs y documentos de cobertura.
> **Actualizado: 2026-10-03** (Domi + Claude). Al cerrar cada bloque se actualiza este archivo, no se crea otro.

## 1. Cómo está organizado

- Todo módulo nuevo vive en el laboratorio (`/lab/<modulo>`, solo super admin, datos reales por la BFF). Los
  usuarios siguen en la app actual (`app.aisapira.com`, repo `sapira-ai`) **hasta el switch**: nadie usa el front
  nuevo antes. `api-sapira` alimenta a los dos fronts, así que un cambio de comportamiento en un endpoint
  compartido llega también al front actual cuando se despliega.
- Base de datos: solo como código en este repo (migración + entity + assets), primero QA y después producción,
  cada paso con OK de Domi ([GUIA](../../src/databases/postgresql/GUIA-CAMBIOS-DE-ESQUEMA.md)).
- Reparto: Domi decide producto, revenue/devengo, funciones y triggers. Leon ve integraciones (Odoo, SII,
  Salesforce, Stripe); lo que se toca de su código queda en
  [`cambios-integracion-para-leon.md`](./cambios-integracion-para-leon.md).

## 2. Módulos construidos en el lab

| Módulo | Estado | Qué cubre | Documento de detalle |
|---|---|---|---|
| **Clientes** (Cliente 360, Razón social 360) | Construido y revisado | Lista con KPI y vista rápida; 360 con contratos, facturas, cotizaciones, contactos, documentos, actividad (ordenada por día) y suscripciones; razones sociales: crear, traer desde ERP (nace vinculada), vincular con el partner del ERP, eliminar, asignar y desasignar cliente; acciones en lote | `front-sapira/app/(protected)/lab/clientes/README.md` · [`docs/cambios/clientes-rediseno-lab.md`](../cambios/clientes-rediseno-lab.md) |
| **Contratos** | Cerrado (admite mejoras con OK) | Lista, alta, 360, multimoneda, modificaciones por intención (13 intenciones), renovaciones, pactos (también en el alta), consumos, alertas de vencimiento, bloqueo de producto sin mapeo en el ERP, errores del ERP en lenguaje claro | [`cobertura-contratos-v2.md`](./cobertura-contratos-v2.md) · [`spec-multimoneda-contrato.md`](./spec-multimoneda-contrato.md) · [`spec-modificaciones-contrato-v2.md`](./spec-modificaciones-contrato-v2.md) |
| **Cotizaciones** | Construido; falta una revisión funcional y de UI completa | Lista, alta, 360, PDF con vista previa, etapas propias del holding con movimiento libre, edición con historial del detalle, crear contrato desde cotización, cotizaciones de Salesforce en espera de mapeo (probado con casos reales) | [`mapa-v2-cotizaciones.md`](./mapa-v2-cotizaciones.md) |
| **Facturación** | Construido y revisado | Facturas, notas de crédito, cobranza (resumen, cuentas por cobrar, proyección, pagos y ajustes), conciliación bancaria, invoices de Stripe, acciones masivas, vistas sugeridas | [`spec-facturacion-v2.md`](./spec-facturacion-v2.md) · [`cobertura-facturacion-v2.md`](./cobertura-facturacion-v2.md) · [`spec-conciliacion-v2.md`](./spec-conciliacion-v2.md) |
| **Ingresos** (ex Revenue) | Construido; Asientos sirve pero hay que afinarlo | Resumen, movimiento de saldos, reconocimiento futuro, detalle mensual con movimientos, asientos por cuenta con "Abrir por" dimensión, excepciones | [`spec-revenue-y-metricas.md`](./spec-revenue-y-metricas.md) |
| **Métricas** | Construido | KPI, movimientos de MRR, retención, cohortes, renovaciones, bajas, bookings | [`spec-revenue-y-metricas.md`](./spec-revenue-y-metricas.md) |
| **Precios** | Primera versión; falta una segunda vuelta | Modelos de precio v2 (+ pestaña Productos de Configuración) | [`spec-pricing-v2.md`](./spec-pricing-v2.md) |
| **Configuración** | Construido y en producción (03-10; api v0.0.79–83, front v0.1.55–56). Gestión de usuarios con correos propios commiteada y migrada (M15, M16). Pendientes en §3 y §4 | Árbol del holding; Holding 360 (resumen con usuarios y última actividad, monedas y tipo de cambio con tasas fijas y detalle de sincronización, catálogos en tarjetas con chips, vendedores, campos personalizados con lista/sí-no/fecha, comunicaciones con dominios y remitentes, preferencias: avisos de renovación internos, numeración de cotizaciones, zona horaria); Compañía 360 (documentos tributarios con impuesto, cierre de períodos que solo bloquea contratos e ítems, 5 cuentas contables, cuentas bancarias, documentos legales); usuarios y roles con matriz de permisos (Editar incluye Ver; roles por defecto no editables; Finanzas con acceso); Productos en Precios; país ISO en compañías y clientes; impuesto por documento tributario en toda la facturación; el documento solo cambia con la razón social; horizonte de ítems sin término fijo de 12 meses rodante. **Usuarios:** invitar, reenviar, desactivar/reactivar (bloquea la cuenta en Auth si no le quedan holdings), eliminar solo invitaciones que nunca entraron; correos propios por Resend desde `noreply@aisapira.com` con plantillas versionadas en api-sapira (invitación y recuperar contraseña); `/auth/confirm` + `/bienvenida`; pantalla sin acceso; redirección abierta del callback corregida; migraciones M15 (`user_access_events`) y M16 (cierra el hueco crítico de `user_holdings`) aplicadas; SII como pestaña de Compañía 360 (solo Chile) | [`spec-configuracion-v2.md`](./spec-configuracion-v2.md) · [`contrato-api-configuracion.md`](./contrato-api-configuracion.md) · [`revision-seguridad-api.md`](./revision-seguridad-api.md) |
| **Notificaciones** | Cerrado (03-10) | Centro con Tareas (resumen por gravedad), Alertas (filtros, archivar, vista rápida con Qué pasó / Qué hacer) y Preferencias (Mis compañías, correo con 15 min de espera, resumen semanal); campana; menciones y referencias en notas del Cliente 360; Tareas pendientes en el Dashboard | [`spec-notificaciones-v2.md`](./spec-notificaciones-v2.md) · [`contrato-api-notificaciones.md`](./contrato-api-notificaciones.md) |
| **Integraciones** | Primera versión cerrada (03-10) | Conectadas y En camino; 360 por integración: Estado (importados, con error, por revisar / actualizar, listos; nuevos vs cambios a existentes con diferencias; descartar; reglas de exclusión; errores que se repiten), Mapeos por origen (sugerencias, Sin uso, No aplica, campos, vendedores, clientes del ERP), Configuración (conexión enmascarada, cuentas de Stripe, reglas), Historial (resultados claros, reporte del ERP). Falta: claves de API de Sapira | [`spec-integraciones-v2.md`](./spec-integraciones-v2.md) · [`contrato-api-integraciones.md`](./contrato-api-integraciones.md) |
| **Centro de ayuda** (`/ayuda`) | Construido y commiteado (03-10; front v0.1.60): todos los módulos, Novedades e Integraciones | Reemplaza la vista técnica `/documentacion`. Publica Primeros pasos y Contratos; Clientes, Cotizaciones, Facturación, Ingresos y Métricas los escribe otra sesión. Hoy exige `VIEW_DOCUMENTACION`; al switch se abre a todos. Objetivo: dar de baja HelpKit y Notion | `front-sapira/docs/documentacion-funcional/` |

Convenciones de pantalla que valen para todos (referencia: lista de Contratos):

- Título con botones de ícono → barra de agentes → fila de KPI que filtran → una tarjeta con pestañas, búsqueda,
  Filtros, Columnas y Vistas → tabla.
- Las acciones de una lista van **en la barra de selección**, nunca como columna "Acciones" ni botones por fila.
- Toda lista tiene vista rápida (el ojo) con "Abrir 360".
- El "Volver" de los 360 regresa a la pantalla de origen (`VolverLink` / `useVolver`); solo cae a la lista del
  módulo si se entró directo.
- En la interfaz se dice "ERP", no "Odoo".
- Una factura se abre siempre en su vista rápida (`FacturaVistaRapidaDrawer`, de Contratos).

## 3. Lo que falta construir

En el orden conversado con Domi (actualizado 03-10):

Hecho al 03-10 (rama `domi`, migraciones aplicadas en QA y producción):

- **Usuarios e invitaciones + Centro de ayuda** (api v0.0.86 aprox., front v0.1.57/0.1.60): M15 y M16 aplicadas.
- **Notificaciones v2** (api v0.0.87–0.0.93, front v0.1.59–0.1.61): fases 1 y 2, cerrado.
- **Integraciones v2, primera versión** (api v0.0.94–, front v0.1.62–): lista + 360 por integración (ERP, CRM,
  Stripe, almacén de datos) con Estado, Mapeos, Configuración e Historial; rutas `/integrations/*` seguras; migración
  IntegrationsV2. Spec [`spec-integraciones-v2.md`](./spec-integraciones-v2.md) · contrato
  [`contrato-api-integraciones.md`](./contrato-api-integraciones.md) · lógica para Leon en
  [`cambios-integracion-para-leon.md`](./cambios-integracion-para-leon.md) §14 · nota de merge de su rama
  [`nota-leon-actualizar-rama-03-10.md`](./nota-leon-actualizar-rama-03-10.md).
- **Mi perfil y menú de usuario** (en producción): avatares, contraseña, cerrar sesiones; SII como pestaña de Compañía
  360 (Chile). Contrato [`contrato-api-mi-perfil.md`](./contrato-api-mi-perfil.md).

Lo que sigue:

1. **Configuración externa** (Domi/Leon): variables de correo de la API (`INVITE_LANDING_URL`, `INVITE_FROM`,
   `RESEND_API_KEY`; `INVITE_TEST_ALLOWLIST` solo en QA) y despliegue de la API; "Secure password change" en Supabase
   (producción y QA); Skew Protection en Vercel; prueba de invitación con alias en Hanka. `www.aisapira.com` no
   responde (TLS): se usa `aisapira.com`.
2. **Cierre de Integraciones**: claves de API de Sapira (Configuración › Desarrolladores, con revisión de Leon) y
   documentación pública de la API. Merge de la rama `leon` con `qa` según la nota.
3. **Automatizaciones** (agentes, Leon): catálogo de acciones y configuración por cliente y en lote
   ([`spec-agentes-ia.md`](./spec-agentes-ia.md)). Hoy los agentes del lab son demostración de diseño.
4. **Precios**: segunda vuelta.
5. **Reglas de reconocimiento de ingresos** (Domi, después de terminar los módulos): granularidad diaria/mensual por
   compañía, no recurrentes, variables al cierre, cierre automático ([`spec-configuracion-v2.md`](./spec-configuracion-v2.md) §14 B).
6. **Onboarding y datos históricos**: relacionar MRR histórico, crear contrato desde MRR histórico, importar
   facturas (el botón "próximamente" de Facturación es el recordatorio).
7. **Switch** (§5).

En paralelo, sin fecha en la secuencia:

- **Bloque de seguridad** (OK de Domi y Leon): [`revision-seguridad-api.md`](./revision-seguridad-api.md), urgentes
  #1, #2, #3, #11 y #16, más #22 (`users_update_v2`) y #23 (`delete_current_user`).
- **Centro de ayuda**: completar los módulos que escribe la otra sesión y, al final, el video de bienvenida.
- **Pendientes menores de Configuración** (Domi salvo indicación):
  - permisos deshabilitados con aviso en los módulos cerrados (con OK por módulo);
  - mostrar los campos personalizados en los formularios de Clientes, Contratos y Cotizaciones;
  - productos archivados en los selectores de Contratos, Cotizaciones y Precios;
  - plantilla de glosa por holding y correlativo de proforma;
  - vigencia de las cotizaciones;
  - índices únicos: vendedor por correo, código de producto, cuenta bancaria;
  - archivos huérfanos en storage;
  - mapeo de condiciones de pago del CRM (Leon);

## 4. Pendientes por decisión (no son olvidos)

| Tema | Qué se decidió o qué falta | Quién |
|---|---|---|
| Eliminar cliente con razones sociales propias | Queda bloqueado: primero se eliminan o reasignan sus razones sociales. La columna heredada `client_entities.client_id` borra en cascada; cambiarla requiere migración. Se reevalúa en la auditoría previa al switch | Domi |
| "Configurar agentes" en lote (Clientes) | Fuera hasta que exista Automatizaciones. "Duplicar" cliente y "Duplicar" cotización se retiraron | Domi |
| Cuentas contables "Cuentas por cobrar" y "Diferencia de cambio" | Salen "Sin código" en Asientos; se agregan (con migración) en Configuración | Domi |
| Asientos de Ingresos | Funciona; hay que afinarlo para que se lea más rápido | Domi |
| Línea de etapas de la cotización | Muestra "Firmada · fecha" (fecha de cierre de Salesforce) aunque esté en Enviada: por revisar como posible mejora | Domi |
| Número de cotización de Salesforce | Es el identificador de la oportunidad: correcto, definido con el cliente en su mapeo. No tocar | Cerrado |
| Enlaces de cliente en Ingresos, Métricas y tablas del Razón social 360 | No se hacen (redundantes o demasiado) | Cerrado |
| Pausa solo de facturación | Deseado a corto plazo, no ahora | Domi |
| Vistas guardadas | Hoy viven en el navegador; pasarlas a servidor es un bloque aparte | Domi |
| Envío y firma de cotizaciones | Posterior al switch | Domi |
| Conciliación: OFX e integración bancaria; Stripe México | Posterior | Domi |
| Asunto de seguridad: los endpoints de mapeos de Salesforce no validan que el usuario pertenezca al holding | Anotado para Leon, conviene corregirlo pronto | Leon |
| Sincronización de suscripciones de Stripe (SimpliRoute) | Hay invoices de Stripe sin suscripción y la suscripción más nueva cargada es del 11-09-2026: revisar si el sync está atrasado | Leon |
| Bloqueo de producto sin mapeo en el envío al ERP | Cambia lo que hace hoy el envío automático (antes mandaba un producto por defecto): validar con Leon antes de desplegar | Leon + Domi |
| Gestión de usuarios: invitaciones pendientes de SimpliRoute | Hay 4 invitaciones pendientes: hablarlo con el cliente antes del switch | Domi |
| Retiro del flujo de usuarios del front actual | Al switch: revocar EXECUTE de `invite_user_safe`, `update_user_role_safe`, `delete_current_user` y `delete_user_complete`; borrar las edge functions `send-invitation` y `delete-user` (no rotar el secreto de Resend hasta migrar `send-proforma` y `send-collection`); eliminar el trigger `sync_user_on_login` (costura) y pasar a la API "Pendiente → Activo + last_access" | Domi |
| Centro de ayuda y menú al switch | Dar `VIEW_DOCUMENTACION` a todos los roles (todos ven `/ayuda`) y retirar el enlace interino a `help.aisapira.com` del sidebar; retirar `/admin/empresas-sii` del sidebar (vive en Compañía 360 › Facturación electrónica); borrar la página vieja del reporte de integración del ERP (vive en Integraciones › ERP › Historial) | Domi |
| Datos de Configuración a revisar antes del switch | 2 compañías de Lenosoft con impuesto 0.19 (decimal); países sin calce con ISO; industrias duplicadas inglés/español en SimpliRoute; usuario con `auth_id` huérfano en Hanka y cuenta auth huérfana de Lenosoft. Solo lectura hasta decidir | Domi |

El resto de pendientes de integración está en [`cambios-integracion-para-leon.md`](./cambios-integracion-para-leon.md).

## 5. Antes del switch

1. **Terminar los módulos de la sección 3** y la Definition of Done documental de cada uno.
2. **Auditoría de datos por holding** (decisión de Domi 02-10: se hace completa antes del switch, no antes).
   Hallazgos ya vistos, sin tocar:
   - Bajas del modelo anterior cargadas como ítem de precio negativo (43 contratos en SimpliRoute, 1 en TiMining,
     1 en uPlanner): inflan diferido y por facturar **por ítem**. Los KPI de Ingresos netean por contrato y están
     bien. Convertirlas es tocar contratos de clientes: caso a caso con Domi.
   - 11 facturas en CLP de SimpliRoute con el monto en moneda del sistema mal calculado.
   - Números de cotización duplicados anteriores al índice único.
   - El Dashboard suma el MRR histórico sin el corte y lo cuenta dos veces.
   - Datos de la demo (Hanka) con cabecera de factura distinta de sus líneas.
   - 28 cotizaciones del CRM de SimpliRoute en "Enviada" que ya tienen contrato: la importación del CRM les devolvió la etapa
     (antes de las cotizaciones protegidas, 03-10). No se reparan sin OK de Domi. Para listarlas (solo lectura):
     ```sql
     SELECT q.quote_number, q.salesforce_opportunity_id, s.name AS etapa, min(c.created_at) AS contrato_desde
     FROM quotes q JOIN quote_stages s ON s.id = q.quote_stage_id
     JOIN contracts c ON c.deleted_at IS NULL AND (c.quote_id = q.id OR EXISTS (SELECT 1 FROM contract_items ci
       JOIN quote_items qi ON qi.id = ci.quote_item_id WHERE ci.contract_id = c.id AND qi.quote_id = q.id))
     WHERE q.holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6' AND q.salesforce_opportunity_id IS NOT NULL
       AND q.deleted_at IS NULL AND s.kind = 'sent'
     GROUP BY 1, 2, 3 ORDER BY 1;
     ```
3. **Rebuild completo del devengo por holding.** El devengo guardado es de fechas mezcladas (cada contrato se
   recalcula solo cuando algo lo toca) y las reglas aprobadas en v2 solo están aplicadas en los contratos
   recalculados desde entonces. Va primero en QA, con comparación antes/después por holding y mes para que Domi
   apruebe las diferencias, revisando antes cómo interactúa con los períodos cerrados. El rebuild no corrige las
   bajas con ítem negativo: eso es dato del contrato.
4. **Revisión con Leon** de lo que cambia en integraciones (documento para Leon) y de los endpoints compartidos
   que ahora bloquean: eliminar cliente con uso y desasignar razón social con contratos o facturas.
5. **Switch**: `migrated: true` en `front-sapira/lib/app-links.ts` por módulo (el `localPath` de configuración pasa
   al `/configuracion` nuevo), abrir `/ayuda` a todos los usuarios, retirar el flujo de usuarios del front actual
   (§4) y actualizar la sección "Dual-frontend" de `front-sapira/AGENTS.md`.

### Después del switch

- **Tiempo prudente de pruebas** con los usuarios ya en el front nuevo.
- **Drop y limpieza de los triggers y funciones que solo usa el front actual.** Hoy los disparadores heredados
  solo se saltan cuando escribe la API (`sapira.writer = 'api'`); cuando escribe el front actual corren completos
  con las reglas viejas. Pasado el período de pruebas se eliminan, salvo los invariantes (guard de período,
  validadores de moneda) ([`activacion-costura-triggers.md`](./activacion-costura-triggers.md),
  [`plan-coexistencia-funciones.md`](./plan-coexistencia-funciones.md)). Va como migraciones por el flujo de la
  GUIA, con OK de Domi.
- Retiro del front actual.

### Regla mientras conviven los dos fronts

**No se invierte tiempo en arreglar cosas que solo afectan al front actual** (Domi, 02-10): lo resuelto en v2 llega
con el switch y lo heredado se elimina después. El backlog del producto vivo marca qué quedó resuelto en v2:
[`ROADMAP-OPERATIVO.md`](../ROADMAP-OPERATIVO.md) › "Resuelto en v2".

## 6. Cómo verificar antes de dar algo por listo

- API: tests, build real (`tsc -p tsconfig.build.json --outDir <tmp>`) y arranque. Para el arranque no basta un
  401: hay que comprobar que el proceso que corre partió **después** del último cambio de fuentes y que una ruta
  inexistente da 404. El modo watch a veces compila sin reiniciar; en ese caso se reinicia `yarn start:dev`.
- Front: tests y chequeo de tipos. Lo que no se ve en el navegador se declara como no verificado.
- Datos: cuadrar con consultas de solo lectura en producción y reportar hallazgos sin corregirlos.
- Fallas de tests conocidas y ajenas: `lib/api/factura-proxy.test.ts` en el front (`database.module.spec` de la API pasa desde que
  `domi` trae la entity de `holding_integration_settings`, 03-10).

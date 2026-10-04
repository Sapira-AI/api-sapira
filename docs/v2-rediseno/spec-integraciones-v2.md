# Spec · Integraciones v2 (interfaz)

Estado: **aprobada por Domi el 03-10-2026** con los ajustes de §5. **Primera versión construida y cerrada el 03-10** (api v0.0.94+, front v0.1.62+); pendiente del módulo: claves de API de Sapira (A8) y documentación pública (A11). Bloque 4 de [`estado-v2-y-plan-switch.md`](./estado-v2-y-plan-switch.md).
Alcance: la interfaz de Integraciones en el front nuevo (`/lab/integraciones`) y los endpoints de lectura y configuración
que le faltan a api-sapira. La lógica de cada integración (cómo se sincroniza, qué se escribe en el ERP) la revisa Leon
al final; aquí no se cambia.

Fuentes: auditoría de la app actual (`sapira-ai/src/pages/{Integraciones,OdooIntegration,SalesforceIntegration,StripeIntegration}.tsx`),
de api-sapira (`src/modules/{odoo,salesforce,stripe,bigquery,banco-central,budgets}`) y del diseño (O2C Redesign 4b
"Fuentes de datos", landing `Sapira 08 Integraciones`). No hay artboard de producto: la guía visual es la del lab
(Configuración: `DominioCard`, `Holding360View`, `CatalogosTarjetas`, `HoldingTree`).

## 1. Qué hay hoy

| Integración | App actual | API | Front nuevo |
|---|---|---|---|
| ERP (Odoo) | Conexión (prueba falsa), mapeo de compañías, mapeo de productos con impuestos escritos a mano, importar facturas/partners por fecha, BD intermedia (revisar, clasificar, integrar), mapeo de campos con transformaciones, diagnóstico | CRUD conexiones **sin guard y devolviendo `api_key`**, `companies/map`, `products/map`, importación async, logs de envío en Mongo | Reportes › Integración Odoo (envíos de facturas) |
| CRM (Salesforce) | Conexión (2 modos), tipos de cotización, productos, cuentas→clientes, importar oportunidades (etapas fijas en código), staging, corridas, SOQL (super admin) | Conexión, validate/refresh, mapeos, staging, corridas, sync-logs, cron diario 08:30; **mapeos y staging aceptan cualquier holding** | Formulario de mapeo de producto (Cotizaciones › en espera), reintento, estado conectado |
| Pagos (Stripe) | Conexión (prueba falsa), ingesta por fecha, staging, sincronizar, mapeo de productos | CRUD conexiones **devolviendo `secret_key`**, ingesta, sync, cron horario | Pestaña Invoices de Facturación (solo lectura) |
| Almacén de datos (BigQuery) | "Próximamente" | Conexiones (credenciales en texto plano), `test`, cantidades (ingesta, imports, replace), cron horario | Alertas de consumos |
| Tipos de cambio | Configuración › Datos económicos (Banco Central, Perú) | Sync horario; lectura segura en `settings/holding/fx-sync*` | Configuración › Monedas (estado, historial, mensual) |
| SII | — | Seguro (`HoldingScopeGuard`) | `/admin/empresas-sii` |

Hallazgos que condicionan el diseño:

- **Seguridad**: las rutas de ERP, CRM, Pagos y almacén de datos no validan holding ni permiso y dos devuelven la clave
  (revisión de seguridad #1, #2, #8–#10). Las claves se guardan en texto plano (solo la contraseña del CRM va cifrada).
  `VIEW_INTEGRACIONES` / `EDIT_INTEGRACIONES` existen en los roles pero no en `PERMISSION_CODES`.
- **Sin historial** de sincronizaciones salvo CRM (corridas) y tipos de cambio; logs repartidos entre Postgres y Mongo.
- **Un producto sin mapeo al ERP bloquea el envío de la factura** ([`cambios-integracion-para-leon.md`](./cambios-integracion-para-leon.md) §8).
- **Vendedores del CRM**: el sync crea `sellers` buscando por email/nombre del Owner y, si no encuentra, inventa
  `sf_<ownerId>@salesforce.local`; `sellers` no guarda el id del CRM.
- **Presupuestos**: `budgets`/`budget_lines` ya tienen API y BFF seguras; Facturación › Cobranza ya carga el presupuesto
  de ingresos a caja. No es una integración.

## 2. Decisiones

Recomendación primero; Domi confirma o cambia.

- **D1 · Estructura.** `/lab/integraciones` = lista (Conectadas arriba con estado, última sincronización, pendientes de
  mapeo y "Sincronizar ahora"; Disponibles abajo; las que no existen no se muestran: nada de "Próximamente").
  `/lab/integraciones/[tipo]` = 360 con pestañas **Estado · Mapeos · Configuración · Historial**. Tipos: `erp`, `crm`,
  `pagos`, `datos`, `tipos-de-cambio`, `sii` (este último solo enlaza a `/admin/empresas-sii`).
- **D2 · Marca.** Dentro de Integraciones sí se nombra el sistema conectado ("ERP · Odoo") en la tarjeta y el
  encabezado del 360; en el resto de la app sigue "ERP"/"CRM"/"Pagos" (regla vigente).
- **D3 · Seguridad sin romper la app actual.** Endpoints nuevos `/integrations/*` con `HoldingScopeGuard` +
  `VIEW_INTEGRACIONES` (leer) / `EDIT_INTEGRACIONES` (cambiar), que **nunca devuelven una clave** (solo "guardada ·
  termina en 4F2A"). Las rutas viejas no se tocan hasta el switch; su cierre y el cifrado de claves quedan en el bloque de
  seguridad con Leon. Se agregan los dos códigos a `PERMISSION_CODES`.
- **D4 · Alcance de esta vuelta** (lo que el usuario de un holding hace en el día a día):
  - **ERP**: conexión (alta, editar con la clave solo de escritura, activar/pausar, eliminar), **probar conexión real**
    desde la API, mapeo de compañías, **mapeo de productos con selector de impuestos** (lista de impuestos leída del
    ERP, no IDs a mano) con filtro "Sin mapear" y cuántas facturas bloquea cada uno, historial de envíos de facturas.
  - **CRM**: estado y prueba de la conexión, reconectar, **etapas de oportunidad a importar configurables** (hoy fijas
    en el código), mapeo de productos y de tipos de cotización, **vendedores del CRM** (D7), cotizaciones detenidas con
    motivo y reintento (ya existe en Cotizaciones; aquí se ve completo), historial de corridas con error por oportunidad.
  - **Pagos**: conexión (modo prueba/real), probar conexión real, mapeo de productos, historial de sincronizaciones.
  - **Almacén de datos**: conexión y prueba, historial de cargas de consumos, consumos sin producto (enlaza a la acción
    que ya existe en Facturación).
  - **Tipos de cambio**: tarjeta con estado y última sincronización que lleva a Configuración › Monedas (ya construido);
    no se duplica.
- **D5 · Fuera de esta vuelta → bloque Onboarding y datos históricos (#8).** Importar facturas y clientes por rango de
  fechas, BD intermedia (revisar, clasificar, integrar), mapeo de campos con transformaciones, cuentas del CRM →
  clientes en lote, staging de Pagos. Son herramientas de puesta en marcha, no de operación diaria, y pesan (la pantalla
  de oportunidades de la app actual tiene ~2.400 líneas). Hasta el switch siguen en la app actual.
- **D6 · No se migra.** Probador SOQL, diagnóstico de modelos del ERP, documentación del flujo, sincronización síncrona
  del ERP, pruebas de conexión falsas, tarjetas "Próximamente". Si soporte los necesita, quedan como herramientas de
  super admin en la API.
- **D7 · Vendedores del CRM.** Columna `sellers.crm_owner_id` (revisar antes el catálogo: no existe hoy) + pestaña
  Mapeos › Vendedores del CRM: dueño del CRM ↔ vendedor de Sapira, con **fusionar** los duplicados `@salesforce.local`.
  El catálogo de vendedores sigue en Configuración › Vendedores. Que el sync busque por `crm_owner_id` es cambio de la
  integración → documento para Leon.
- **D8 · Historial unificado sin tabla nueva.** `GET /integrations/:tipo/runs` lee por adaptador lo que ya existe
  (corridas del CRM, `stripe_sync_jobs`, logs de envío al ERP en Mongo, cargas de cantidades, `fx_api_sync_log`) y
  devuelve un contrato común paginado `{ data, total, currentPage, pages, limit }`. Una tabla común solo si después hace
  falta.
- **D9 · Sincronizar ahora.** `POST /integrations/:tipo/sync` uniforme, respeta el lock de la corrida programada (409
  "Ya hay una sincronización en curso") y devuelve el id para seguir el progreso.
- **D10 · Presupuestos no van en Integraciones.** El de ingresos a caja ya vive en Facturación › Cobranza. Los demás
  tipos (facturación, contratos firmados, MRR) van con Métricas (presupuesto vs real) en una vuelta posterior.
- **D11 · Notificaciones.** Reapuntar al 360: falla del CRM → CRM › Historial; productos sin mapear del ERP → ERP ›
  Mapeos (y el texto dice "ERP"); consumos sin producto → Almacén de datos; falla de tipos de cambio → Configuración ›
  Monedas. Los enlaces de Configuración, Precios › Productos y Compañía 360 que hoy van a la app actual pasan al lab con
  `labEnabled` + `VIEW_LAB`.

## 3. Endpoints nuevos (api-sapira, módulo `integrations`)

**El contrato final vive en [`contrato-api-integraciones.md`](./contrato-api-integraciones.md)** y reemplaza la tabla que estaba aquí.
Diferencias con lo planeado (03-10, ajustes de Domi durante la construcción):

- Tipos `erp` · `crm` · `stripe` · `datos`. **Stripe va completo y con varias cuentas por holding** (`/integrations/stripe/connections`);
  se llama "Invoices y suscripciones" (no "Pagos": el cobro con pasarela es otra función) y en Stripe se dice *invoice*.
  Tipos de cambio y SII no son integraciones (A3; SII sigue en `/admin/empresas-sii`).
- Mapeos con una forma común `/integrations/:tipo/mappings/:objeto` (`companies`, `products`, `quote_types`, `owners`, `fields`) +
  sugerencias deterministas y `accept-suggestions`. El mapeo de campos es un objeto más (`fields`): verlo con VIEW, cambiarlo solo
  super admin o Admin Técnico.
- Estado de sincronización genérico (`records`) sobre las tablas intermedias, con **descartar/restaurar** y **reglas de exclusión**
  por objeto (`/rules`, `/rules/fields`); "Traer oportunidades" del CRM sin fechas = último mes.
- Reglas por tipo en `/integrations/:tipo/settings` (etapas del CRM, filtro de facturas del ERP nacidas en Sapira, `auto_sync`), todo en
  una sola tabla de ajustes por integración: `holding_integration_settings` de Leon (`auto_enabled` + `settings`).
- Reglas de exclusión con campos calculados legibles en el CRM ("Correo del dueño", "Nombre del dueño", "Cantidad de ítems", "Etapa",
  "Tipo", "Forma de pago"). Caso SimpliRoute (sin aplicar): excluir las ganadas sin ítems y las del dueño de marketing.
- Migración `1791000000000-IntegrationsV2` (sin aplicar): `sellers.crm_owner_id`, `settings`/`updated_by` y `stripe` en el CHECK de
  `holding_integration_settings`, tabla `integration_record_discards`.
- `POST /settings/sellers/merge` (Configuración) para fusionar vendedores duplicados.

### Roadmap

- **Asistente de mapeos (bloque de agentes)**: tras el primer sync, un agente propone mapeos y reglas de exclusión para revisar y aceptar
  en lote (referencia: DualEntry). Esta vuelta deja las sugerencias deterministas y el endpoint para aceptarlas.
- **Cobro con pasarela ("Pagos")**: función aparte, después del switch.
- **Bancos** (Emisso Connect, A10) y **Kame** (A9): nuevos adaptadores con la misma forma.

## 4. Riesgos

- Dos fronts: las rutas nuevas conviven con las viejas; no se cierra nada que use la app actual hasta el switch.
- Borrar o cambiar un mapeo de producto del ERP puede detener envíos: confirmación con el impacto.
- "Sincronizar ahora" contra los crons globales: depende de los locks existentes (Stripe y tipos de cambio en memoria,
  CRM por corrida); con varias réplicas, revisar con Leon.
- Vendedores: fusionar sin el cambio del sync (D7) puede volver a crear duplicados en la próxima corrida.

## 5. Ajustes de Domi al aprobar (03-10)

Prevalecen sobre §2 cuando chocan.

- **A1 · Dos momentos.** *Configurar* la integración (conexión, mapeos, ajustes; se hace una vez) y *el día a día*
  (estado, última sincronización, sincronizar ahora, revisar lo que llegó e **importar a Sapira**). El flujo real es:
  sincronización → tablas intermedias → validación → importar a Sapira. La interfaz lo muestra así, con palabras de
  usuario; lo técnico (mapeo de campos con transformaciones, objetos, consultas) va en **Avanzado**, solo super admin y
  Administrador técnico.
- **A2 · Componentes reutilizables entre integraciones**: un solo componente de **mapeo** (izquierda: lo de Sapira;
  derecha: lo del sistema; filtro "Sin mapear", contador, sugerencias, acciones en lote) y uno de **estado de
  sincronización** (referencia de diseño "CRM Sync": Sincronizados · Con error · Pendientes + tabla de registros con
  objeto, id en Sapira, id externo, estado y última sincronización; período; "Sincronizar ahora"). Cada integración los
  usa con su configuración; agregar una integración nueva (Kame, otro CRM, bancos) debe ser declarar sus objetos, no
  construir pantallas.
- **A3 · Tipos de cambio fuera de Integraciones** (viven en Configuración › Monedas). D4 pierde esa tarjeta. Integraciones
  es solo la conexión con otros sistemas.
- **A4 · Revisión de lo que llegó (tablas intermedias) entra en esta vuelta**, como parte del día a día y con el
  componente de A2 (estados Pendiente · Listo para importar · Con error · Importado; importar seleccionados o todos).
  D5 queda solo con: mapeo de campos con transformaciones (pasa a Avanzado), carga masiva inicial de cuentas del CRM y
  la importación histórica del ERP por rango largo.
- **A5 · CRM: traer oportunidades a mano.** Caso real: cierran un negocio con fecha anterior y hay que procesarlo para
  facturar ya. "Traer oportunidades" por rango de fechas (y por id) con las etapas configuradas → vista previa →
  importar. Que el equipo comercial lo haga sin soporte.
- **A6 · Almacén de datos (consumos).** Ver cuándo llegaron los datos, de qué período, cuántas filas, si cambiaron
  respecto de la carga anterior y qué quedó sin producto.
- **A7 · Reporte de integración del ERP** (Reportes › Integración Odoo, de Leon) se mueve a Integraciones › ERP ›
  Historial, simplificado, y sale del sidebar.
- **A8 · Credenciales de la API de Sapira** (que un cliente se conecte a Sapira): al final de este módulo.
- **A9 · Para Leon (lógica de integración, no interfaz)**: traer del ERP solo las facturas que no nacieron en Sapira
  (sueltas o legacy); notas de crédito; **estados de pago desde el ERP** (hoy todo queda pendiente de pago y no se puede
  conciliar; una actualización masiva sirve de una vez, pero lo correcto es la sincronización continua). Integración
  Kame (TiMining) sobre el mismo esquema de A2.
- **A10 · Roadmap**: conectar bancos de las compañías del holding (Chile) con Emisso Connect
  (https://connect.emisso.ai/docs, p. ej. BCI Pyme). Domi ya habló con ellos; se contrata después del switch. El diseño
  de A2 debe permitirlo (categoría "Bancos").
- **A11 · Roadmap: página pública de integraciones con documentación técnica por integración** (referencia Zenskar:
  https://zenskar.com/docs/20240301/third-party-integrations/CRMs-and-CPQs/salesforce). La página pública
  `/integraciones` del sitio está oculta hasta terminar este módulo; al reabrirla, cada tarjeta lleva a su documento
  técnico (qué objetos sincroniza, dirección, requisitos y pasos de conexión). Sale del mismo catálogo de A2.
- **A12 · Ajustes del 03-10 (segunda ronda).** Mapeo de campos dentro de Mapeos como una sección más ("Campos"), con
  textos de usuario; solo editar requiere super admin o Administrador técnico. La referencia "CRM Sync" aplica a la
  pestaña Estado del 360, no a la lista. Pagos con 360 completo. "Descartar" lo que no se quiere importar (filtro
  Descartados y Restaurar) y reglas simples por integración (CRM: etapas; ERP: ocultar facturas nacidas en Sapira). CRM:
  al abrir se carga solo el último mes, no importadas arriba e importadas abajo; fechas e id solo para ir más atrás.
- **A13 · Roadmap post-switch: traer campos nuevos del CRM en autoservicio** (Domi 03-10). Botón "Agregar campo" en
  Mapeos › Campos: elegir un campo del objeto en el CRM (requiere un endpoint que liste los campos disponibles, hoy no
  existe) y su destino en Sapira (campo estándar o campo personalizado de Configuración › Campos personalizados); desde
  la siguiente sincronización llega solo. Requiere que la sincronización incluya ese campo en su consulta y lo guarde en
  `custom_fields` para todos los objetos (hoy existe el mecanismo `custom_fields_bundle` en los ítems de oportunidad;
  confirmar con Leon). Hoy ya es autoservicio cambiar qué campo del CRM alimenta un dato existente. Traer un **objeto
  nuevo** del CRM sigue siendo desarrollo.
- **A14 · Roadmap: lo procesado en Integraciones en el resumen mensual del holding** para administradores (detalle en
  [`spec-notificaciones-v2.md`](./spec-notificaciones-v2.md) §7).

# Inventario: integración Odoo (paso 0 de su migración)

> Levantado el 27-09-2026 (Leon + Claude) sobre `front-sapira-vite`, `api-sapira` y el esquema de prod.
> Es el **paso 0** que exige [`plan-migracion-integraciones.md`](./plan-migracion-integraciones.md): nada se
> migra sucio. Este documento describe lo que hay hoy y qué hay que hacer antes de escribir la pantalla nueva.
>
> Las afirmaciones marcadas con ✔ están verificadas directamente contra el código o el corpus.

## En simple

El módulo Odoo del front actual es **unidireccional: Odoo → Sapira**. Trae partners y facturas de un Odoo
ajeno, los deja crudos en tablas de staging, y un segundo paso explícito —dirigido por un mapeo de campos que
el usuario configura arrastrando— los convierte en `client_entities` e `invoices_legacy`.

**El envío Sapira → Odoo no está aquí**: vive en Contratos (`auto_send_to_odoo`, el botón "Ejecutar Scheduler")
y en el cron nocturno. Decidir si la pantalla nueva lo absorbe es la primera pregunta de producto.

## El concepto central: la bandeja de staging

Es el modelo mental del módulo y lo que hay que conservar. Un registro recorre:

```
Odoo (XML-RPC) → job asíncrono → odoo_*_stg (raw_data JSONB)
      → Clasificar: compara contra la tabla final usando el mapeo → estado
      → Procesar: escribe create/update en client_entities / invoices_legacy
      → Limpiar procesados
```

Los cinco estados son lo que el usuario ve y filtra:

| Estado | Qué significa | Qué hace "Procesar" |
|---|---|---|
| `create` | No existe en Sapira (sin VAT, o no encontrado) | INSERT |
| `update` | Existe y **hay diferencias** en los campos mapeados | UPDATE |
| `processed` | Existe y es idéntico | Se salta |
| `error` | Falló el procesamiento; `error_message` visible | No procesa |
| `NULL` | Sin clasificar | Indefinido |

✔ El CHECK de las tres tablas de staging admite `create | update | processed | error`. **`pending` no existe**,
aunque cuatro funciones SQL siguen filtrando por él (ver "Funciones muertas").

**La mejor pieza del módulo** es el diff que se guarda en `integration_notes` y se pinta como "Valor en Odoo"
vs "Valor en BD" (`FieldChangesTable.tsx`). En el rediseño sube a vista de primer nivel, no a un diálogo.

## Cómo está armada la pantalla hoy

`/integraciones/odoo` no tiene pestañas de primer nivel: es una pila vertical.

- **Sin conexión** → solo el formulario de alta.
- **Con conexión** → card colapsable "Nueva Integración" (importar por rango de fechas) + sección siempre
  visible "Base de Datos Intermedia (Staging)" con tres pestañas: **Facturas**, **Clientes**, **Diagnóstico**.
- Un modal "Configuración" con cuatro pestañas: Conexión, Información, Mapeo de Compañías, Mapeo de Productos.

Siete flujos: configurar conexión · mapear compañías · mapear productos · importar a staging · clientes
(mapear → clasificar → procesar) · facturas (mapeo jerárquico → clasificar → procesar) · diagnóstico.

## Lo que hay que construir en `api-sapira`

Esto es el trabajo bloqueante. El front nuevo no puede leer Supabase, y hay **9 llamadas directas** en 3 archivos.

| # | Qué hace hoy el front | Qué falta en la API | Prioridad |
|---|---|---|---|
| 1 | `supabase.rpc('get_table_columns')` ×3, para poblar los combos de campos destino del mapeador | **No existe endpoint.** Crear uno con **allow-list de tablas** — hoy el RPC acepta cualquier tabla/esquema desde el navegador — y el filtrado de campos de sistema en el servidor | 🔴 Bloqueante |
| 2 | `supabase.from('field_mappings')` leer/borrar/insertar el mapeo de partners | El CRUD existente solo soporta `mapping_type='hierarchical'`; el de partners se guarda como `simple`. Generalizar el endpoint y el DTO (hoy tipa `mapping_config` con la forma de facturas), devolver el `id`, y hacer el reemplazo **atómico** en el servidor | 🔴 Bloqueante |
| 3 | `supabase.from('users')` para rellenar `created_by` | Innecesario: el backend ya resuelve el usuario. Se elimina | — |
| 4 | `supabase.from('odoo_connections')` en el diagnóstico | Ya existe `GET /odoo/connections` | — |
| 5 | `supabase.from('field_mappings')` para facturas | Ya existe `GET /odoo/field-mappings`; es duplicación con el servicio que el mismo componente ya usa | — |
| 6 | `supabase.rpc('cleanup_old_processed_records')` | Ya existe `DELETE /odoo-partners/clean-processed`, acotado por holding. Decidir si se conserva el criterio `days_old` | — |
| 7 | "Probar conexión" que no prueba nada | Crear `POST /odoo/connections/test` real (ver abajo) | 🟠 Alta |
| 8 | Edge function `diagnose-odoo-model` con la anon key | Decidir si el diagnóstico se migra; si sí, endpoint en la API (el cliente XML-RPC ya existe ahí) | 🟡 Decisión |

Además, la **Fase 2 de tenancy**: los controladores de Odoo reciben el holding por `@Headers` sin validar
pertenencia. Van a `HoldingScopeGuard` + `@HoldingId()` según [`holding-scope-guard.md`](../guards/holding-scope-guard.md).

## Seguridad — atender antes de migrar

1. 🔴 ✔ **API key real commiteada.** `front-sapira-vite/actualizar_conexion_odoo.sql` tiene en texto plano la
   `api_key` y el `subscription_code` de la conexión de producción de un cliente. Está trackeada en git desde el
   commit "odoo integracion" y presente en `main`, `qa` y 13 ramas remotas. **Borrar el archivo no alcanza: hay
   que rotar la clave en Odoo.**
2. 🔴 ✔ **La página no comprueba permisos.** Ningún componente del módulo usa `usePermissions` y la ruta no
   tiene guard; solo la tarjeta del índice respeta `EDIT_INTEGRACIONES`. Con la URL directa entra cualquier
   usuario autenticado. En `/lab` se corrige solo (exige super admin).
3. 🟠 ✔ **Datos de un tenant hardcodeados** en `OdooDiagnosticTool.tsx` (URL, base, usuario y `holding_id`
   reales) como *fallback* silencioso: si la consulta falla, le muestra esa conexión a cualquiera. No se migra.
4. 🟡 ✔ **`cleanup_old_processed_records` no filtra por holding.** Es `SECURITY INVOKER` y `odoo_partners_stg`
   **no tiene policy DELETE**, así que hoy RLS lo deja en cero filas para un usuario normal — la contención es
   accidental. Si al migrar alguien agrega una policy `FOR ALL`, se desarma. La función queda retirada.
5. 🟡 **La API key se devuelve al front** y se precarga en el formulario de conexión.

## Deuda a limpiar (paso 0)

### Código muerto en el front — ~1.900 líneas

✔ Cuatro componentes que no importa nadie (`FieldTransformationSelector` 304, `PaymentStateMappingDisplay` 72,
`OdooTabConfiguration` 21), un **contexto duplicado completo** (`OdooIntegrationContext.tsx`, 332 líneas, no
montado en ningún sitio y con un `useOdooIntegration` homónimo del hook real — trampa de importación), y más de
la mitad de `OdooTabInformation.tsx` (los handlers de la pantalla de sincronización anterior).

Dentro de archivos vivos: `extractOdooFields` duplicada de `extractOdooFieldsManually`, selección múltiple de
partners implementada **sin checkboxes en la UI**, `classificationResult` que se calcula y no se muestra.

### Código muerto en la API

✔ `partners.controller.ts` (`PartnersController`) **no estaba registrado en `odoo.module.ts`**: sus rutas no
existían en runtime. Era un duplicado de `odoo-partners.controller.ts`. **Eliminado el 27-09.**

✔ `savePartnerToDatabase` / `determinePartnerProcessingStatus` están duplicadas entre `odoo.service.ts` y
`odoo-partners.service.ts`, pero **las dos copias están vivas**: cada servicio llama a la suya. No es código
muerto sino duplicación real, y unificarlas es una refactorización con riesgo → se hace al tocar esos servicios
en el paso de API, no en la limpieza.

Endpoints sin consumidor en ninguno de los dos fronts: `fiscal-positions` (6), `invoice-tax-validator` (2),
`create-draft`, `validate-invoice-data`, `resolve-missing-partners`, y `POST /odoo/partners/clean-processed`
(duplicado del `DELETE /odoo-partners/clean-processed` que sí se usa). Se retiran al migrar el módulo, no antes:
borrar superficie de API viva no es necesario para la migración. Y el front llama `POST /odoo/test`, que **no
existe** en la API.

### Funciones SQL muertas — unas 20

El pipeline de partners **ya no vive en Postgres, vive en TypeScript** (`partners-processor.service.ts`). Las
funciones SQL que lo implementaban quedaron huérfanas y varias están rotas por construcción:

- `process_partner_staging_to_client_entities` y `process_partner_staging_with_transformations` filtran por
  `'pending'`, un estado que el CHECK no admite: recorren cero filas siempre. Además la primera llama
  `apply_field_mapping_to_data` con los argumentos en otro orden que la firma declarada → `42883` garantizado.
- Tres variantes de `detect_partner_changes*`, dos de ellas copia literal, ninguna con caller.
- `migrate_existing_partners_to_new_system` es un cascarón: el loop solo incrementa un contador.
- `classify_invoice_before_insert` no tiene trigger asociado y llama a una función que no tiene asset.
- `update_odoo_invoices_staging_updated_at` no la usa ningún trigger.

✔ **Solo tres funciones del dominio siguen vivas** y las necesita el front viejo hasta que migre:
`get_table_columns`, `cleanup_old_processed_records` y `reset_invoice_odoo_draft`. El resto se retira con una
migración escrita a mano, según el procedimiento de borrado del README del corpus.

### Esquema

- `odoo_object_mappings`: 0 filas en prod y cero referencias en ambos repos. Candidata a `DROP`.
- **Dos dialectos de tenancy** en el mismo dominio: el staging usa una subquery a `user_holdings`, y conexiones
  y mapeos usan `get_current_user_holding_id()`. No son equivalentes.
- `odoo_product_mappings` no tiene ninguna policy RLS.
- Conviven dos generaciones de tablas de staging; la UI usa solo las `*_stg`. El flujo de "aprobación de
  facturas" que documenta `docs/odoo-integration/FLUJO.md` ya no existe en la UI.

## Dolores de UX que el rediseño tiene que resolver

Los que más cuestan, en orden:

1. **Tres mecanismos distintos de seguimiento de procesos largos** conviviendo: polling de 5 s en un contexto
   global persistido en `localStorage` (importación), polling de 1 s local y efímero que se pierde al cambiar de
   pestaña y no limpia su intervalo (procesar facturas), y nada (procesar clientes, que es síncrono y puede
   tardar mucho). El botón **"Detener Integración" solo para el polling del navegador**: el job sigue corriendo.
2. **Clientes y Facturas son el mismo componente escrito dos veces** (1.435 y 1.222 líneas), con el
   `useDebounce`, los cinco badges de filtro y la paginación copiados. Es una sola bandeja genérica.
3. **El listado de Clientes desmonta la pantalla entera mientras carga**, así que el buscador pierde el foco en
   cada tecleo. Facturas, en cambio, no resetea la página al buscar: buscas desde la página 5 y ves vacío.
4. **Los campos mapeables se infieren de la página visible**: si un campo de Odoo solo aparece en un registro de
   la página 3, no se puede mapear. Tiene que venir del backend.
5. **Guardar el mapeo de partners borra el anterior antes de insertar el nuevo**, sin aviso previo: si el insert
   falla, se perdió la configuración.
6. **Procesar escribe en tablas de negocio con un clic**, sin previsualización ni confirmación.
7. Textos de desarrollador visibles: *"Debug: la conexión existe en la base de datos pero no se está cargando"*,
   nombres de tabla crudos (`client_entities`, `invoices_legacy`), instrucciones que citan un tab que ya no
   existe, badges en inglés, y al usuario se le pide teclear **IDs de impuesto de Odoo separados por coma**.
8. Tres monedas hardcodeadas distintas (USD, COP, CLP) y tres locales mezclados: los importes se muestran en
   dólares aunque no lo sean.
9. Guardar o borrar la conexión hace `window.location.reload()` de la página entera.

## La forma propuesta

Un **stepper de cuatro pasos** que hoy está implícito y escondido: **Conectar → Mapear → Importar → Revisar y
procesar**. Con:

- La **bandeja** como pantalla principal, genérica para partners y facturas, con tabla de verdad (orden,
  selección múltiple real, paginación con número de página), los estados renombrados a lenguaje de negocio
  (Nuevos / Con cambios / Sin cambios / Con error / Sin clasificar) y el diff promovido a vista principal.
- **Un solo patrón de trabajo largo**: job persistido, reanudable al volver, con cancelación real contra el
  backend y reintento de los que fallaron.
- Un **"Probar conexión" que pruebe de verdad**.
- El interruptor de **integración automática por holding** (`holding_integration_settings`, ya existe en la
  base) en la configuración de Odoo — que es lo que originó esta migración.

## Orden de ejecución

1. **Seguridad**: ✅ hecho el 27-09 — quitados `actualizar_conexion_odoo.sql`, `consulta_conexiones_odoo.sql` y
   los dos fallbacks hardcodeados del diagnóstico. **Pendiente de Leon: rotar la API key en Odoo**, que es lo
   único que cierra el agujero (el archivo sigue en el historial de `main`).
2. **Limpieza**: ✅ hecha el 27-09.
   - `front-sapira-vite`: **1.192 líneas** fuera. Cuatro archivos completos (`FieldTransformationSelector`,
     `PaymentStateMappingDisplay`, `OdooTabConfiguration` y el contexto duplicado `OdooIntegrationContext`) más
     el código muerto dentro de archivos vivos: `OdooTabInformation` bajó de 361 a 203 líneas. Typecheck, lint,
     tests y build en verde.
   - `api-sapira`: eliminado `partners.controller.ts` (no estaba registrado) y escrita la migración
     `1790500000000-RetiraFuncionesOdooMuertas` con **19 firmas**, más el borrado de sus assets.
   - **Doble confirmación hecha.** Además del código, se midió el uso real en producción con
     `pg_stat_statements` (ventana desde el 2025-05-06, ~17 meses, `track = top`). Las 19 firmas no aparecen.
   - ⚠️ **Cuatro funciones salieron de la lista porque sí tienen tráfico**, y por eso la primera versión de
     esta migración era peligrosa:

     | Función | Llamadas por PostgREST | Por qué se queda |
     |---|---|---|
     | `apply_field_mapping_to_data` | **46.147** (dos sobrecargas) | Alguien fuera del código auditado la invoca |
     | `get_invoice_staging_stats` | 136 | idem |
     | `get_odoo_partners_stg_debug` | 11 | idem |
     | `resolve_field_transformation` | 0 propias | **La llama `apply_field_mapping_to_data`**: retirarla habría roto una función con 46 mil llamadas |

     `pg_stat_statements` v1.10 no guarda la fecha de la última llamada, así que ese tráfico no se puede
     fechar: puede ser de dic-2025/feb-2026, cuando el pipeline vivía en SQL. Para retirarlas hace falta una
     **ventana de observación por `REVOKE`**, como se hizo con `cleanup_duplicate_partners_by_vat`.
   - Límite de la evidencia: la tabla está en su tope (4.959 de 5.000 entradas) y evicta por uso, así que la
     ausencia de una firma es evidencia fuerte, no prueba absoluta.
   - **La migración sigue sin aplicarse**: queda a tu criterio cuándo.
3. **API**: el endpoint de campos destino, el CRUD generalizado de `field_mappings`, el test de conexión, y
   `HoldingScopeGuard` en los controladores de Odoo, con tests.
4. **BFF**: route handlers en `app/api/integraciones/odoo/*` con schemas espejo y tests.
5. **UI** en `app/(protected)/lab/integraciones/odoo`, apagada en producción y solo super admin, con datos
   reales desde el día 1 ([`modulos-en-construccion.md`](../../../front-sapira/docs/reglas-desarrollo/modulos-en-construccion.md)).
6. **Switch**: mover fuera de `/lab` y marcar el módulo como migrado.

Los pasos 1 y 2 no mueven un píxel y son alrededor de la mitad del trabajo.

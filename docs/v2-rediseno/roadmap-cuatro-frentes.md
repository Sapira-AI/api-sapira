# Roadmap: cantidades variables, automatizaciones, facturación electrónica e integraciones

> Levantado el 02-10-2026 (Leon + Claude) sobre los cuatro repos. Es el plan de los cuatro frentes que
> compiten por el mismo tiempo. Tres tocan el ciclo de facturación y se pisan entre sí.
>
> **Cómo leerlo**: cada afirmación de estado lleva archivo y línea, o conteo de filas con su fuente.
> Lo marcado ✔ lo verifiqué directamente contra el código o la base; el resto viene del relevamiento.

## El patrón que se repite en los cuatro

**El código parece terminado y no lo está.** No hay TODOs, hay Swagger exhaustivo, hay documentación
abundante y varios roadmaps marcan fases con `[x]`. Pero ese `[x]` significa *escrito*, no *ejecutado*:
tres de los cuatro frentes tienen cadenas completas que nunca corrieron de punta a punta, y en dos de
ellos la razón es un bug de pocas líneas que falla en silencio.

La consecuencia para este roadmap es que **la primera etapa de cada frente no es construir, es hacer que
lo construido corra una vez**. Es barato y cambia radicalmente lo que se sabe del resto.

## Orden acordado y dependencias

```
1. Cantidades variables  ──┐
                           ├──► 3. Facturación electrónica ──► (reemplazo gradual de Odoo)
2. Automatizaciones ───────┘
4. Integraciones al front nuevo  (independiente, la más larga)
```

- **Cantidades antes que automatizaciones**: lo que se factura tiene que estar bien antes de automatizar
  el aviso y el cobro.
- **Automatizaciones antes que DTE**: el flujo de proforma define *cuándo* una factura está lista para
  emitirse; el DTE es el acto de emitirla.
- **Integraciones es independiente** y la más larga: no bloquea a ninguna, pero consume el mismo tiempo.
- **Decisión tomada (02-10)**: el DTE propio y el envío a Odoo **conviven**. Odoo es el ERP del cliente;
  Sapira emite el documento tributario. No es un reemplazo.

---

# 1. Cantidades variables (BigQuery → `quantities`)

## Qué resuelve

Los contratos con ítems variables se facturan según el consumo real del mes, que vive en el datawarehouse
del cliente. Hoy alguien carga esas cantidades a mano, mes a mes, o las importa por Excel. El canal
automático trae `sapira_base` de BigQuery, la deja en una tabla intermedia y la integra a `quantities`,
que es el override mensual de precio y cantidad por ítem de contrato.

## Estado real

**El backend está bien construido**: ingesta idempotente por `source_hash`, integración **insert-only** con
10 estados, guard de tenancy explícito en la consulta de candidatos, dedup dentro del batch, y ~45 casos de
test en `bigquery.service.spec.ts`. El README del módulo (444 líneas) es documentación de primer nivel. El
scheduler (`bigquery.scheduler.ts`, `@Cron('0 * * * *')` con ventana por `BIGQUERY_SYNC_HOUR`) corre.

**Pero el canal nunca produjo una sola fila en producción** ✔ (medido el 04-10-2026):

| | |
|---|---|
| `sapira_quantity_imports` | **0 filas** |
| `quantities` con origen DWH | **0 filas** |
| Conexiones BigQuery | **1**: SimpliRoute, proyecto `datawarehouse-a2e2` |

El staging no tiene proceso de limpieza, así que cero filas significa que **nunca se ingestó nada**. Y el
`last_sync_at = 2026-10-04` de la conexión **no dice nada del canal**: lo escribe el sync de Stripe
(`bigquery.service.ts:377`), no el de cantidades. Antes de construir cualquier cosa encima hay que averiguar
por qué la ingesta no trae filas — si el rango del mes en curso viene vacío en el DWH o si falla en silencio.

**Lo que falla es el entorno alrededor**, y son hallazgos nuevos que no estaban en ningún roadmap:

### 🔴 ✔ El RSM nunca se actualiza para lo que escribe el canal

`functions/trigger_rsm_on_quantity_change.sql:12-19`:

```sql
SELECT revenue_schedule_monthly_enabled INTO v_enabled
FROM financial_settings
WHERE holding_id = get_current_user_holding_id()
LIMIT 1;
IF NOT COALESCE(v_enabled, false) THEN RETURN NEW; END IF;
```

`get_current_user_holding_id()` depende de `auth.uid()`. La API entra con rol privilegiado y **sin JWT de
Supabase**, así que `auth.uid()` es NULL, no encuentra fila, `v_enabled` es `false` y el trigger retorna en
silencio. El canal actualiza `invoice_items` —ese trigger no tiene el gate— pero **no**
`revenue_schedule_monthly`. Rompe el cuadre de MRR reconocido contra facturado. Mismo problema en
`restore_rsm_on_quantity_delete.sql`.

Se arregla derivando el holding de `NEW.holding_id` en vez de la sesión.

**Actualización 04-10**: esto ya estaba levantado, y mejor, en `src/databases/postgresql/README.md` punto 7
(Leon, 01-10, durante el backfill de folios de Odoo). Tres correcciones a lo que yo había escrito:

1. **Son cuatro triggers, no dos.** Además de los dos de `quantities` están `trigger_rsm_on_invoice_change`
   —que la API escribe desde **cinco** servicios: scheduler de facturas, invoices, webhook de Odoo, backfill
   de folios y validador de impuestos— y `trigger_rsm_on_contract_item_change`.
2. **Hay un segundo defecto, que afecta también al front**: el flag que se lee es el del holding *del
   usuario* (y encima el que tenga `selected = true`), no el del registro que se está modificando.
3. **Está postergado a propósito**: se encontró en cierre de mes y la nota pide medir el universo afectado
   y correr un rebuild de control en QA antes de tocarlo.

Medido el 04-10 ✔: `rls_user_holding_id()` devuelve `NULL` para la API, y **cuatro clientes reales tienen
`revenue_schedule_monthly_enabled = true`** — Hanka Robotics, SimpliRoute, TiMining y uPlanner. Aplicar el
arreglo hace que cada escritura de la API empiece a reconstruir sus cronogramas de revenue, que es
justamente lo que hay que hacer, pero no sin control.

**Resuelto el 05-10 (merge de `qa`), por otro camino**: la migración `1791300000000-RetiraTriggersDevengoQuantities`
—aplicada en producción— **retiró el mecanismo completo** de triggers RSM sobre overrides de `quantities`, porque
ahora la sincronización del DWH recalcula el devengo. Las dos funciones de `quantities` ya no existen, así que mi
arreglo del gate (que nunca se aplicó a ninguna base) quedó obsoleto y sus assets se borraron.

**Sigue abierto** el mismo defecto en los otros dos triggers: `trigger_rsm_on_invoice_change` —que la API escribe
desde cinco servicios— y `trigger_rsm_on_contract_item_change`. Son el grueso del impacto, siguen con el gate por
sesión y van en el lote coordinado que pide `src/databases/postgresql/README.md` punto 7 (medir el universo y correr
un rebuild de control en QA antes de tocarlos).

### 🔴 ✔ Las notificaciones del canal no tienen destinatarios

Los cuatro tipos del canal (`bigquery_quantities_diff`, `_unmapped`, `_blocked`, `_currency_mismatch`) **no
están** en `ROLE_SUBSCRIPTION_NOTIFICATION_TYPES` (`notifications.service.ts:18-22`, que solo tiene los dos
de Salesforce y el de Odoo). Como los destinatarios salen de ahí y `listForAuthenticatedUser` hace
`innerJoin` sobre `recipients`, la notificación se crea con `recipient_count = 0` y **nadie la ve nunca**.

El efecto es más grave de lo que parece: el botón "Reemplazar con datos de BigQuery"
(`NotificacionDetalle.tsx`) es **la única salida** de los estados `conflict` y `changed_in_source`, y hoy es
inalcanzable. Esos registros quedan atascados para siempre.

**Resuelto el 05-10 (merge de `qa`), por diseño y no por parche**: el catálogo nuevo
(`notifications/notification-catalog.ts`) declara los cuatro tipos con `subscribable: true`,
`default_roles: DATA_WAREHOUSE_ROLES` y el `action_type: 'replace_quantity_record'`, y la semilla
`seed/007-notification-default-subscriptions.sql` los siembra en `notification_role_subscriptions`. Verificado en
producción el 05-10: la semilla está aplicada y hay **84 suscripciones activas en los 7 holdings**. Los
destinatarios los resuelve `resolveRecipients` desde esas filas, así que el productor ya no pasa `recipients`.
Mi parche en `bigquery.service.ts` (`recipients: { include_super_admins: true }`) se retiró: mandaba a los super
admins en vez de a los roles configurados. Su test pasó a verificar la garantía nueva — que cada tipo que emite el
canal esté en el catálogo como `subscribable` y tenga suscripción por defecto.

### 🔴 ✔ La tabla del DWH está hardcodeada — no es "falta un filtro", es una definición

El cliente de BigQuery **sí** se construye con el `project_id` y las credenciales de cada conexión
(`bigquery.service.ts:305`), pero la query de ingesta apunta a una tabla fija:

```sql
FROM `datawarehouse-a2e2.finance.sapira_base`
WHERE billing_date >= @from AND billing_date <= @to
```

Las columnas que trae no incluyen ninguna dimensión de holding, y `dataset_id` de la conexión está vacío.
Hoy no explota porque hay **una sola conexión** y su proyecto es justamente `datawarehouse-a2e2`. Con una
segunda conexión, cada holding autenticaría con sus credenciales contra el warehouse del primero.

**Hay que decidir qué es `sapira_base`** antes de tocar esto:

- **Si es el warehouse de un cliente** → la tabla tiene que venir de la conexión (`project_id` + `dataset_id`),
  no del código. Mismo problema en `sapira_stripe` (`bigquery.service.ts:333`).
- **Si es un warehouse propio de Sapira, compartido** → necesita una columna de tenant y la query, filtrarla.

No es un bug con arreglo obvio: es la pregunta de si el canal es multi-cliente o por cliente.

### Lo que no existe

Ninguna UI del canal: no hay pantalla de auditoría del staging (el endpoint `GET /bigquery/quantities/imports`
existe y **no lo llama nadie**), ni de backfill, ni de gestión de conexiones BigQuery (el CRUD existe y
tampoco lo llama nadie; en el índice de integraciones la tarjeta figura como `coming_soon`). El front nuevo
no tiene absolutamente nada de esto.

## Tablas y campos

| Tabla | Rol | Estado |
|---|---|---|
| `quantities` | Override mensual. Clave natural `(contract_item_id, period)`, CHECK de `period` a `YYYY-MM-01` | ✅ Operativa. **No tiene columna de origen**: la única marca de que vino del canal es texto en `notes` |
| `sapira_quantity_imports` | Staging. Payload del DWH + `source_hash` + los 4 IDs de mapeo + `integration_status` (10 estados) + `quantity_id` | ✅ Operativa |
| `bigquery_connections` | Credenciales por holding | ⚠️ `credentials` (service account) en **texto plano** |

**Lo que falta**: una columna de origen en `quantities` (hoy es texto libre en `notes`), y que
`holding_integration_settings` con `integration = 'bigquery'` —que ya existe— lo respete este scheduler.

## Definiciones pendientes

1. **¿El canal sigue siendo insert-only?** Hoy nunca pisa un override manual, a propósito. La alternativa es
   que pueda hacerlo bajo reglas, lo que elimina los estados `conflict` y el flujo de reemplazo manual.
2. **¿Qué pasa con `amount` tras un reemplazo?** `replaceQuantityRecord` actualiza precio y cantidad pero no
   `amount`; como el trigger del RSM hace `COALESCE(amount, …)`, un override creado a mano y luego reemplazado
   deja el RSM con el monto viejo.
3. **¿Se arregla el gate del RSM, o se espera al rediseño?** `mejoras-y-brechas.md` declara que el modelo v2
   ("Consumo en 3 capas") **mata los overrides** y pasa a eventos inmutables con corrección `VOID|REPLACE`.
   Arreglar el gate es barato y urgente; rediseñar es otra conversación.

## Plan por etapas

| # | Etapa | Entregable verificable |
|---|---|---|
| 1.0 | **Averiguar por qué la ingesta no trae filas.** Correr `POST /bigquery/quantities/ingest` con un rango que sepamos que tiene datos en el DWH y leer el resultado | Saber si el problema es el rango, los permisos o algo que falla en silencio |
| 1.1 | ✅ **Cerrado el 05-10 por el merge de `qa`**, no por mi arreglo: los triggers RSM del canal se retiraron (`1791300000000`) y los destinatarios los da el catálogo de notificaciones + `seed/007` | Verificado en prod: migración aplicada y 84 suscripciones en 7 holdings |
| 1.1b | Decidir qué es `sapira_base` (por cliente o compartida) y sacar la tabla del código si corresponde | Una segunda conexión no lee el warehouse de la primera |
| 1.2 | `amount` coherente tras el reemplazo + columna de origen en `quantities` | Un override reemplazado deja el RSM correcto |
| 1.3 | Tenancy del módulo: `HoldingScopeGuard` + `@HoldingId()` en `bigquery.controller.ts` y `bigquery-connection.controller.ts`, con sus tests | Los tres casos obligatorios en verde |
| 1.4 | Que el scheduler respete `holding_integration_settings` con `integration='bigquery'` | Apagar un holding y confirmar que no se ingesta |
| 1.5 | UI de auditoría del staging en el front nuevo: los 10 estados, `integration_reason`, reproceso | Una usuaria resuelve un `blocked` sin pedir ayuda |
| 1.6 | UI de backfill por rango y de conexiones BigQuery | Un backfill de un mes pasado desde la pantalla |

## 🅿️ Estado al 04-10-2026: frente pausado, y por qué

Leon decidió documentar lo que falta y seguir con automatizaciones. Esto es lo que queda, para retomarlo
sin volver a investigar.

### Nada quedó pendiente de aplicar

El merge de `qa` del 05-10 resolvió los dos ítems que estaban en esta lista, y ninguno por el camino que yo había
tomado:

- **Gate del RSM del canal**: sus dos funciones ya no existen. `1791300000000-RetiraTriggersDevengoQuantities`
  retiró el mecanismo (la sync del DWH recalcula el devengo) y los assets se borraron. Mi corrección nunca llegó a
  ninguna base y no hace falta.
- **Destinatarios de las notificaciones del canal**: los resuelve el catálogo (`subscribable: true` +
  `default_roles`) con `seed/007` ya aplicada en producción. Mi parche `include_super_admins` se retiró.

### Lo que bloquea, y a quién le toca

| # | Qué falta | Por qué está parado |
|---|---|---|
| 1 | **Aplicar el arreglo del RSM, completo** | Son **cuatro** triggers, no dos (README del corpus, punto 7). El de `invoices` lo escribe la API desde cinco servicios. Cambia comportamiento para **cuatro clientes reales** con RSM habilitado ✔ (Hanka Robotics, SimpliRoute, TiMining, uPlanner), y la nota pide un rebuild de control en QA antes. Se postergó por cierre de mes. **Decisión de Leon** |
| 2 | **Qué es `sapira_base`** | Define si la tabla sale de la conexión o si necesita columna de tenant. Sin eso, una segunda conexión de BigQuery lee el warehouse de la primera. **Decisión de producto** |
| 3 | **Por qué la ingesta no trae filas** | El staging está en 0 y nunca se ingestó nada. Puede ser el rango, los permisos del service account, o un fallo silencioso. Hace falta correr `ingest` con un rango que sepamos poblado y leer el resultado. **No se puede hacer desde acá**: requiere las credenciales de BigQuery |
| 4 | Suscripción por rol de las alertas del canal | Necesita su propio endpoint: la constante actual alimenta el toggle de Salesforce |
| 5 | `amount` coherente tras un reemplazo | Mecánico, sin decisión: hoy `replaceQuantityRecord` no lo toca y el RSM usa `COALESCE(amount, …)` |
| 6 | Tenancy del módulo, UI de auditoría, de backfill y de conexiones | Etapas 1.3 a 1.6, sin bloqueo conceptual |

### El orden para retomarlo

El punto 3 va primero: mientras la ingesta no traiga una fila, todo lo demás es teoría. Después el 1 y el 2,
que son decisiones. Recién entonces la UI, que es el grueso del trabajo pero el que menos riesgo tiene.

---

# 2. Automatizaciones: proforma y cobranza

## Qué resuelve

El ciclo completo de "pedir lo que falta para poder facturar, facturar, y después cobrar":

```
proforma ──► ¿requiere OC / conformidad / HES? ──► correo al cliente
                                                        │
                            ┌───────── respuesta ───────┤
                            │                           │
                      positiva: extraer                negativa: avisar
                      los datos y emitir               que no se puede facturar
                            │
                            ▼
                     vence el plazo ──► correos de cobranza escalados
```

## Estado real

### Lo único que opera en producción

`check-overdue-invoices` (edge function + cron diario a las 4:01) pasa facturas vencidas a `Vencida` y
loguea en `overdue_check_log`, que tiene **51 filas**: lleva meses corriendo. **No envía ningún correo** y
nada dispara el primer aviso de cobranza. Es el eslabón más barato de cerrar.

Además, el envío manual de proforma y de cobranza desde la UI de facturación, vía edge functions con Resend.

### Escrito pero nunca ejecutado

Los processors de NestJS (`proforma`, `collections`) con su escalada por `reminder_levels`, control
antispam y resolución de configuración cliente → holding. Y la razón es concreta:

### 🔴 ✔ La ejecución automática de agentes nunca ha funcionado

```
agents.service.ts:22     runAgent(agentId, mode, holdingId)
agents.scheduler.ts:35   runAgent(agent.id, agent.holding_id, 'execute')   ← invertido
agents.controller.ts:37  runAgent(agentId, dto.mode, holdingId)            ← correcto
```

El scheduler pasa el holding donde va el modo. Eso llega a `getAgent(agentId, 'execute')` → `WHERE
holding_id = 'execute'` → UUID inválido → excepción que el `catch` del scheduler se come. **Falla en
silencio cada minuto desde que existe.**

TypeScript no lo detectó porque `getScheduledAgentsWithRetry(): Promise<any[]>` — al ser `any`,
`agent.holding_id` es asignable al union `'preview' | 'execute'`. El arreglo son dos líneas: invertir los
argumentos y tipar el resultado de la consulta para que no se repita.

Lo corrobora el estado de la base: `ai_runs`, `ai_messages`, `client_agent_configs`,
`email_sender_addresses` y `holding_email_sender_settings` tienen **0 filas**.

### No existe

**La recepción de correos, al 100%.** Sin webhook inbound, sin IMAP, sin parsing, sin almacenamiento de
adjuntos, sin manejo de rebotes. El esquema la anticipa —`ai_messages.direction` admite `'in'`— pero no hay
ningún productor de esas filas. Es la pieza que convierte el flujo en un ciclo cerrado; sin ella los otros
tramos son correos de ida sin retorno.

### Dos implementaciones paralelas del mismo flujo

| | Edge functions | Processors NestJS |
|---|---|---|
| Proveedor | Resend | SendGrid |
| Disparo | Manual desde la UI | Cron (roto) |
| Plantillas | HTML hardcodeado en la función | Configurables en `ai_agent_configs` |
| Log | `invoice_emails` | `ai_messages` |
| Estado | **Es lo que se usa hoy** | Nunca ejecutado |

Elegir una es prerequisito de todo lo demás. El inbound hay que montarlo sobre un solo proveedor.

## Tablas y campos

### Lo que ya está, y está bien

| Tabla | Qué aporta al flujo |
|---|---|
| `billing_references` | **El documento recibido**: enum `PO \| HES \| ACCEPTANCE \| OTHER`, `reference_code`, emisor, vigencia `valid_from`/`valid_to`, `covers_multiple_invoices`, archivo adjunto |
| `reference_requests` | **La solicitud**: `reference_type`, `status` con `rejected` incluido, `requested_at`, `received_at`, archivo. Es lo más cercano al flujo objetivo |
| `invoice_reference_links` | Vincula el documento con las facturas que cubre |
| `app_notifications` | Ya es accionable (`recommendation`, `action_type`, `action_payload`, `deduplication_key`). **Es exactamente lo que se necesita para "avisar que hay un problema para facturar", y está sin usar para eso** |
| `client_contacts.contact_type` | Ruteo real: valores `'Proforma'` y `'Cobranza'` |
| `invoice_collection_settings` | Días de recordatorio antes y después, plantillas, remitente, BCC |

### El hueco, que es chico y preciso

`contracts.requires_references_for_billing` es un **booleano**: dice *si* se exigen documentos, no
**cuáles**. Falta declarar los requisitos por cliente. No es un modelo nuevo: es una tabla hija o una
columna de tipos, más su UI.

Y antes hay que **unificar tres vocabularios** para los mismos tres documentos:

| Dónde | Valores |
|---|---|
| `billing_references` (enum de Postgres) | `PO \| HES \| ACCEPTANCE \| OTHER` |
| `reference_requests`, `ai_agent_configs` | `OC \| HES \| Aceptación` |
| `quote_attachments` | `acceptance \| purchase_order \| hes \| contract \| other` |

### Lo que no bloquea nada

`requires_references_for_billing` se muestra en la UI pero **ninguna función de emisión lo consulta**: hoy
se puede emitir sin los documentos. El gate hay que construirlo.

## Definiciones pendientes

1. **¿Edge functions o processors?** No se pueden mantener las dos.
2. **¿Un solo proveedor de correo, cuál?** Hoy hay dos a medio migrar, y las tablas de remitentes por holding
   están vacías, así que cualquier correo saldría de un fallback (`onboarding@resend.dev` o `noreply@sapira.cl`).
3. **¿El gate bloquea la emisión o solo advierte?** Choca con el principio del propio spec de agentes,
   "guiar antes que bloquear".
4. **¿La extracción por IA es verdad financiera?** El benchmark que cita el spec dice que no: pasa por
   `needs_review` y la confirma una persona.
5. **Granularidad del requisito**: ¿por cliente, por razón social, por contrato, o jerarquía con override?
   El booleano de hoy vive en contrato y factura; el flujo que se busca es "según lo que exija cada cliente".
6. **¿Qué cuenta como respuesta negativa** y a quién se le notifica?

## Plan por etapas

| # | Etapa | Entregable verificable |
|---|---|---|
| 2.1 | ✅ **Hecho el 04-10**: scheduler arreglado y tipado, `HoldingScopeGuard` en el controlador, `userHoldingId` sincronizado en el front actual, y el BCC que nunca se aplicaba. [`docs/cambios/automatizaciones-scheduler-y-tenancy.md`](../cambios/automatizaciones-scheduler-y-tenancy.md) | Desplegar **no enciende nada** ✔: los 14 agentes tienen `auto_execute = false`. Estrenarlo = prender uno en preview y mirar su `ai_run` |
| 2.1b | Elegir implementación (edge functions o processors) y **un** proveedor de correo | **Decisión pendiente**. El inbound hay que montarlo sobre uno solo |
| 2.1c | `deal_validation`: implementar su processor o sacarlo de la UI | Hoy se crea, se "ejecuta" y no hace nada |
| 2.2 | Unificar el vocabulario de documentos y modelar los requisitos por cliente, con migración y UI | Declarar "este cliente exige OC y HES" y verlo en pantalla |
| 2.3 | Gate de emisión que consulta los requisitos y las referencias vigentes | Intentar emitir sin OC y recibir el bloqueo o la advertencia |
| 2.4 | Cerrar el puente vencida → primer correo de cobranza, sobre el cron que ya corre | Una factura vencida genera su primer aviso |
| 2.5 | Recepción de correo: webhook inbound, tabla de entrantes, matching respuesta→factura por token en `Reply-To`, adjuntos | Responder un correo de proforma y ver la fila `direction='in'` |
| 2.6 | Extracción de OC/HES/conformidad con `needs_review` + camino a `rejected` + notificación accionable | Una respuesta con OC adjunta deja la referencia lista para confirmar |
| 2.7 | Escalada de cobranza completa con los `reminder_levels` ya escritos | La secuencia completa sobre una factura de prueba |

---

# 3. Facturación electrónica (DTE / SII)

## Qué resuelve

Emitir documentos tributarios electrónicos ante el SII desde Sapira, sin depender del ERP del cliente.
**Hoy el DTE chileno lo emite Odoo**, y el folio lo escribe la pierna de vuelta por webhook: un incidente
de webhooks entre el 16 y el 28-09-2026 dejó 154 facturas sin folio, 96 de ellas chilenas. Ese es el
volumen que `api-factura` tendría que absorber.

## Estado real

### El motor está, y es código real

`api-factura` (NestJS + MongoDB) tiene escrita la cadena completa, y no son stubs: semilla → token SII →
timbre electrónico firmado con la llave privada del CAF en SHA1withRSA → firma XML enveloped con
`xml-crypto` → validación contra los XSD oficiales → carátula `EnvioDTE` → upload multipart a
`DTEUpload` → extracción del TrackId → consulta de estado por SOAP `getEstUp`. La reserva de folio es
atómica, con liberación en el catch.

El onboarding también: provisión idempotente desde api-sapira, perfil de certificación, carga de
certificado `.pfx` con rotación, carga de CAF con detección de colisión de rangos y explosión a folios
individuales, y un `readiness` de cinco checks. Las credenciales ya van a Key Vault y los artefactos a Blob.

### Nunca se emitió un DTE de punta a punta, y hay tres bloqueantes

**🔴 ✔ El ambiente se resuelve en dos lugares distintos.** `sii-auth.service.ts:55` pide el token con
`process.env.SII_AMBIENTE` (variable global), mientras `dte.service.ts:49` resuelve la URL de envío con
`profile?.environment` (por empresa). Una empresa configurada en producción pediría el token a **maullin**
y lo usaría contra **palena**. Falla garantizada en el primer cliente productivo.

**🔴 ✔ La UI manda a `sendDte` un payload que no entiende.** `SiiCompanyConfiguration.tsx:276` envía el
objeto `{id, validation}` que devuelve `create`, cuando el servicio lee `body.dteIds ?? body.dteId`.
Responde "Debe indicar al menos un dteId".

**🔴 ✔ Los directorios de artefactos no existen.** `createDte` escribe en `DTEs/` y `CAFs/`, y ninguno existe
en el repo ni nada los crea. Falla con ENOENT antes de persistir. Además, en Railway el filesystem es
efímero: el XML firmado se perdería en cada despliegue.

### Lo que falta para operar

- **El PDF no existe**: solo se genera el PNG del timbre PDF417. No hay representación impresa ni cedible.
- **La pantalla de emisión es un `<textarea>` con JSON crudo**, titulada "Emisión DTE (MVP)".
- **El wizard de onboarding es decorativo**: define seis pasos, renderiza solo títulos, y permite
  "completarlo" sin certificado, sin CAF y sin resolución.
- **`MntExe` no está en el DTO**: una factura exenta (DTE 34) no es representable, aunque el 34 viene en
  los tipos habilitados por defecto.
- **No hay envío del DTE al receptor**, ni acuse de recibo, ni aceptación o rechazo comercial, ni consulta
  `getEstDte`, ni detalle de los reparos del SII, ni reintentos, ni libro de ventas, ni boleta.

### Agujeros de tenancy

El BFF `/api/factura/*` usa `withAuth`, que solo valida sesión: **no comprueba que el holding del usuario
sea dueño de la compañía** que viaja en `X-Factura-Company-Id`. Del lado de api-factura, `findAll()` no
filtra por tenant y `descargarPDF`/`descargarXML` no reciben `empresaId`: el XML firmado de cualquier
contribuyente es descargable con su id. Y `X-Sapira-Access-Token` se envía pero **nadie lo lee**.

### Dos modelos de datos para lo mismo

`api-sapira` tiene `sii_configurations` (1 fila), `sii_certificates` (0) y `sii_cafs` (0): un modelo
completo y paralelo al de api-factura, con su propio Key Vault y su propio reservador de folios. Está
marcado `deprecated` en Swagger pero **sigue montado y sigue escribiendo** en `sii_configurations` durante
la provisión. Dos fuentes de verdad para ambiente, resolución y tipos de DTE.

## Definiciones pendientes

1. **¿En qué orden por país?** Odoo cubre CL, MX, PE, CO y UY; api-factura solo Chile. Ya está decidido que
   conviven, pero no si eso es permanente o por etapas.
2. **¿Qué pasa con las tablas `sii_*` de PostgreSQL?** Deprecadas, vivas y escribiéndose. Nadie decidió si
   se borran, se migran o quedan de espejo.
3. **`POST /dte/addInvoice`**: fuera de contrato con `sendDTE` y el único endpoint DTE sin `@Scopes`.
   Retirar o corregir.
4. **Firma RSA-SHA1**: el plan de custodia la marca como "spike obligatorio" para validar con el SII.
5. **Los 9 estados de `CertificationStatus`**: solo existe la transición `draft → ready`. Los otros siete no
   tienen quién los mueva ni UI que los refleje.

## Plan por etapas

| # | Etapa | Entregable verificable |
|---|---|---|
| 3.0 | **Experimento de medio día**: levantar api-factura en local con un CAF y un certificado de certificación, y tratar de emitir un DTE 33 contra maullin | Saber qué más se rompe. Vale más que seguir leyendo código |
| 3.1 | Los tres bloqueantes: ambiente por empresa en la autenticación, `{ dteId }` en la UI, y artefactos a Blob en vez de filesystem | Un DTE 33 aceptado por maullin, con TrackId y estado consultado |
| 3.2 | Tenancy: validar el holding en el BFF, `empresaId` en descargas y listados | Un usuario de otro holding no descarga el XML ajeno |
| 3.3 | `MntExe` e `IndExe` en el DTO, o quitar el 34 de los tipos por defecto | Un DTE 34 válido, o el 34 fuera del catálogo |
| 3.4 | Generación del PDF con el timbre | Descargar la representación impresa |
| 3.5 | Pantalla de emisión de verdad: formulario, selector de cliente, cálculo de IVA | Emitir sin escribir JSON |
| 3.6 | El puente que no existe: `invoices` (PostgreSQL) → `dteBody` (api-factura) | Emitir el DTE de una factura real de Sapira |
| 3.7 | Set de certificación del SII: afectos, exentos, NC, volumen, muestras impresas, declaración | Autorización del SII. **Semanas de ida y vuelta con el organismo** |
| 3.8 | Producción controlada: CAF productivos, reintentos con backoff, contingencia, cuadratura diaria, alertas de vencimiento de certificado y agotamiento de folios | Primer cliente emitiendo con Sapira |

---

# 4. Integraciones al front nuevo

Ya tiene documentación propia y no se repite acá:

- [`plan-migracion-integraciones.md`](./plan-migracion-integraciones.md) — el plan de los tres servicios.
- [`inventario-integracion-odoo.md`](./inventario-integracion-odoo.md) — el inventario de Odoo, con sus
  flujos, los nueve accesos directos a Supabase que hay que convertir en endpoints, y los dolores de UX.

**Estado al 02-10**: el paso 0 de limpieza está hecho (2.733 líneas eliminadas entre los dos repos, 18
funciones SQL muertas retiradas de QA y producción). Lo siguiente es el endpoint de campos destino con
allow-list, el CRUD generalizado de `field_mappings` y la tenancy de los controladores de Odoo.

Es el frente más largo —59 archivos y ~21.000 líneas contra ~174 endpoints— y el único que no bloquea a
los otros tres.

---

# Transversal: lo que conviene resolver una sola vez

| # | Qué | Afecta a |
|---|---|---|
| T1 | **Tenancy sin migrar**: `bigquery`, `agents` y el BFF de factura siguen tomando el holding sin validar pertenencia. Está inventariado en [`inventario-tenancy-fase-2.md`](./inventario-tenancy-fase-2.md) | 1, 2, 3 |
| T2 | **El interruptor por holding** (`holding_integration_settings`) ya admite `bigquery` y `salesforce`, pero solo lo respeta el cron de Odoo | 1, 4 |
| T3 | **Dos proveedores de correo** a medio migrar, con las tablas de remitentes vacías y fallback a dominios genéricos | 2, 3 |
| T4 | **Desincronización de ramas**: producción tiene 27 assets para reaplicar y migraciones aplicadas sin archivo en `leon` | todos |

## Los bugs cortos que desbloquean todo lo demás

Ninguno pasa de unas horas, y sin ellos las etapas siguientes no se pueden probar de punta a punta:

1. ✅ Gate del RSM del canal — **cerrado 05-10 por el merge de `qa`**: los dos triggers se retiraron. Sigue
   abierto en `trigger_rsm_on_invoice_change` y `trigger_rsm_on_contract_item_change`, que son el grueso.
2. ✅ Destinatarios en las notificaciones del canal — **cerrado 05-10 por el merge de `qa`**: el catálogo nuevo
   los declara `subscribable` con `default_roles`, y `seed/007` los siembra (verificado en prod). El toggle por
   rol ya existe en Configuración › Roles, así que la etapa 1.5 no necesita un endpoint propio.
3. ⚠️ La tabla del DWH hardcodeada **no es un bug con arreglo obvio**: es la definición de si el canal es
   por cliente o compartido (frente 1).
4. ✅ Argumentos invertidos en `agents.scheduler.ts` + tipar la consulta (frente 2) — **hecho 04-10**.
5. ✅ `email_bcc` → `bcc` en las dos edge functions (frente 2) — **hecho 04-10**.
6. ✔ Ambiente por empresa en `sii-auth.service.ts` (frente 3).
7. ✔ `{ dteId }` en la llamada a `sendDte` (frente 3).
8. ✔ Artefactos del DTE a Blob en vez de al filesystem (frente 3).

## Qué hace falta decidir antes de estimar

Además de las definiciones por frente, dos transversales:

- **Quién trabaja en qué, y cuántos frentes en paralelo.** Cuatro frentes simultáneos con dos personas y
  tres que se pisan en facturación es receta para bloqueos mutuos.
- **Cuál es el criterio de "listo"** en cada uno: ¿un cliente piloto operando, o cobertura funcional
  completa? Cambia el alcance de las últimas etapas de los frentes 2 y 3.

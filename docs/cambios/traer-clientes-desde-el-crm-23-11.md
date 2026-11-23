# Traer un cliente antiguo desde el CRM (soporte 23-11, SimpliRoute)

**Pedido (Carelis, 23-11):** buscar e importar un cliente antiguo (cuenta) desde el CRM para crearle el contrato. Caso real: SIDAPT,
cuenta `0015w00002mURaYAAW`, cliente desde 2022. Plan aprobado por Domi el 23-11 con tres decisiones: la razón social sin cliente con
el mismo identificador se asigna también en la sincronización diaria; los nombres de los campos de la cuenta se leen del CRM; la BFF
usa dos carpetas ya cubiertas por permisos.

**Estado:** construido en `domi` (API y front) y subido al remoto el 23-11, sin deploy. Sin cambios de esquema.

## Por qué no se podía

- La sincronización del CRM solo trae oportunidades ganadas con cierre en los últimos 30 días (`DAILY_SYNC_WINDOW_DAYS`) y la cuenta
  llega con ellas. Una cuenta sin oportunidad reciente nunca llega.
- "¿No aparece una oportunidad?" (`POST /integrations/crm/opportunities/fetch`) busca oportunidades, no cuentas.
- El formulario de cliente no tenía el id de la cuenta: un cliente creado a mano quedaba sin vínculo y una oportunidad posterior lo
  habría duplicado (o habría fallado por el índice único).
- En SIDAPT la razón social ya estaba en Sapira (llegó del ERP, `client_entities` `000edbf8…`, 76299358-9, sin cliente) y la cuenta
  no trae identificador tributario en el CRM (el campo `RUT__c`, rotulado "DNI", está vacío).

## Qué se reutiliza y qué es nuevo

Reutilizado tal cual (versión anterior, `SalesforceSyncCompleteService`): leer la cuenta (`fetchAccount`), tabla intermedia
(`upsertAccounts`), clasificar (`classifyAccountStaging`), crear o actualizar cliente, contacto, razón social y vínculo con el ERP
(`processAccountStaging` → `syncAccountFromData`), resolución de la razón social por identificador (`resolveClientEntityPreview`) y
la importación de oportunidades (`SalesforceSyncRunService.createRun('retry_full')`).

No se reutiliza `buildAccountsImportQuery` ni `POST /salesforce/staging/accounts/import` (pantalla del alfabeto de la versión
anterior): solo filtra por letra o rango, escribe directo en la tabla intermedia, no pagina y no escapa lo que recibe. Sigue ahí
para el front anterior; el nuevo no lo usa.

Nuevo:

| Pieza | Dónde | Qué hace |
|---|---|---|
| `CrmAccountsService` | `src/modules/integrations/adapters/crm-accounts.ts` | Búsqueda en vivo, vista previa e importación de cuentas; deja la importación en el historial |
| `findClientIdForAccount` | `salesforce-sync-complete.service.ts` | Cliente de una cuenta, en un solo lugar: vínculo de la integración → `clients.salesforce_account_id` → número de cliente. Reemplaza tres copias (clasificar, importar cuenta, cliente de una oportunidad) |
| `linkOrphanClientEntity` | ídem | Asigna una razón social **sin ningún cliente** a un cliente (principal si no tiene otra). Nunca reasigna |
| `importAccountsFromCrm`, `mapAccount`, `accountFieldSources` | ídem | Importar cuentas ya leídas por el camino de siempre; mapear una cuenta sin escribir; campos de la cuenta que usan los mapeos |
| `toSalesforceId18` | `src/modules/salesforce/utils/salesforce-id.ts` | Id del CRM de 15 caracteres → 18 (la forma que devuelve el CRM y la que se guarda) |
| "ID en el CRM" validado | `clients.service.ts` | `salesforce_account_id` en `POST`/`PATCH /clients`: formato, 18 caracteres y único en el holding |

## Reglas

1. **Nunca duplica el cliente.** Una cuenta es de un cliente si lo dice el vínculo de la integración (`salesforce_object_mappings`), el
   "ID en el CRM" del cliente o su número de cliente, en ese orden. Importar dos veces la misma cuenta deja un solo cliente
   (`status: 'linked'` la segunda vez).
2. **Razón social por identificador tributario.** Sin ninguna con ese identificador → se crea. Una sola y sin cliente → **se asigna**
   (decisión de Domi 23-11; antes se actualizaba y quedaba sin cliente). Con cliente, o repetida → no se toca: nunca se reasigna. La
   asignación vale para todo el camino compartido: importación de cuentas, de oportunidades y sincronización diaria.
3. **Cuenta sin identificador tributario.** Si el cliente ya tiene razón social, se conserva. Si no, elige quien importa: una razón
   social existente sin cliente (se sugieren las de nombre parecido), una nueva con el nombre de la cuenta, o ninguna. Con
   sugerencias no hay opción por defecto.
4. **Oportunidades ganadas: opcionales por cuenta.** Se traen con `retry_full`, igual que "¿No aparece una oportunidad?". Si ya hay
   una importación de oportunidades en curso, el cliente igual se trae y se avisa.
5. **Campos informativos de la cuenta.** Estado, MRR y fecha de activación (`Status__c`, `last_mrr__c`, `Fecha_de_activacion__c` en el
   CRM de SimpliRoute, leídos el 23-11) se piden solo si existen en el CRM del holding (`FieldDefinition`, 10 minutos en memoria). Un
   CRM sin ellos no falla: las columnas vienen en `null`. El identificador y el país salen de los mapeos de campos del holding.
6. **Historial.** Cada importación queda como corrida `crm_accounts` "Importación de clientes" (trabajo `salesforce-accounts-import:…`
   en Mongo y una línea por cuenta en la bitácora, etapa `account`). Sin tablas nuevas.
7. **Permisos.** `EDIT_INTEGRACIONES` o `EDIT_CLIENTES` (se trae desde Integraciones y desde Clientes). Todo por `x-holding-id`.
8. **"ID en el CRM" del cliente.** Opcional; 15 o 18 letras y números; se guarda en 18; único en el holding contra el campo y contra el
   vínculo de la integración (400 con `errors[{ field: 'salesforce_account_id' }]` y el nombre del cliente que lo usa). Cambiarlo o
   quitarlo borra el vínculo de la cuenta anterior con ese cliente.

## Impacto (conteos en producción, solo lectura, 23-11)

- **Quién más usa lo que cambia.** `findClientIdForAccount` y la asignación de la razón social sin cliente están en el camino que
  también usan la sincronización diaria, `records/import` de cuentas y oportunidades, `retry_full`, `process_final` y las rutas
  `/salesforce/staging/*` del front anterior. `clients.service.create/update` lo usan solo `POST /clients` y `PATCH /clients/:id`
  (los dos fronts).
- **Clientes.** Solo SimpliRoute tiene CRM activo: 1.778 clientes, 1.766 con id de cuenta, todos de 18 caracteres (la validación nueva
  no rechaza ninguno existente) y ninguno repetido. 259 tienen id y no tienen vínculo de la integración: los 259 se reconocen hoy por
  su número de cliente (igual al id de la cuenta), así que el resolver nuevo llega al mismo cliente por un paso antes. 0 clientes con
  vínculo y sin id, 0 con vínculo e id distintos.
- **Razones sociales.** Sin cliente en holdings con CRM activo: 43 (32 con identificador, 30 con identificador único en su holding).
  Esas 30 se asignarán solas el día que llegue del CRM una cuenta con su mismo identificador. Hoy ningún cliente del CRM sin razón
  social tiene una huérfana con su identificador (0 de 406): el cambio no altera nada ya importado.
- **Datos.** No se migra nada ni se escribió en producción. SIDAPT se trae desde la pantalla después del deploy.
- **Tests.** API: `crm-accounts.spec.ts` (22), `salesforce-sync-complete.service.spec.ts` (6 nuevos), `clients.service.spec.ts` (4),
  `salesforce-id.spec.ts` (3), `integrations.http.spec.ts` (permisos, holding y validación), `integrations.service.spec.ts`,
  `adapters.spec.ts` (historial), `integrations.module.spec.ts` (cableado). Suite completa: 262 archivos, 4.047 tests. Prueba en vivo
  de la búsqueda y la vista previa contra el CRM real con la conexión de QA (solo lectura): nombre, id, letra, `#`, período por
  oportunidad ganada y por activación; SIDAPT aparece con estado Cliente, MRR, activación 2022-12-01 y 6 oportunidades ganadas.
- **Docs.** `contrato-api-integraciones.md` §6.6, esta nota, `cambios-integracion-para-leon.md`, `src/modules/salesforce/README.md`,
  y en el front: ayuda (Clientes e Integraciones), novedades, README de `conexiones` y `clientes`, `api-backend-contracts.md`.

## Pendiente

- **PR, QA y deploy** (Domi hace los PR, la API primero). En QA: traer SIDAPT desde Clientes y desde Integraciones › CRM. QA no tiene
  la razón social de SIDAPT (sus datos son anteriores): para probar "elegir una razón social sin cliente" hay que crearla en QA o
  probarlo en producción con el caso real.
- **Vínculos de la integración que apuntan a un cliente eliminado:** 2 en producción. `findClientIdForAccount` devuelve ese id (igual
  que antes). Si una de esas cuentas se importa, falla al actualizar el cliente. Corregir: comprobar que el cliente existe y, si no,
  reemplazar el vínculo.
- **Estado de la conexión en QA:** la conexión del CRM de SimpliRoute en QA se usó el 23-11 para leer los campos de la cuenta y probar
  la búsqueda (renovó su token; `last_sync_at` quedó en esa fecha).

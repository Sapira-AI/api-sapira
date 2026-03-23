[Nest] 20589 - 23/03/2026, 6:23:42 LOG [AppLoggerService] Incoming POST /stripe/sync
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncController] ═══════════════════════════════════════════════════════════════
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncController] 🚀 INICIO: Solicitud de sincronización de Stripe desde frontend
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncController] ═══════════════════════════════════════════════════════════════
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncController] 📋 Parámetros recibidos:
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncController] - Holding ID: 5652e95e-bb99-48f5-aa1c-13c8c2638fc6
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncController] - Batch Size: 100
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncController] - Timestamp: 2026-03-23T09:23:42.521Z
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncService]
┌─────────────────────────────────────────────────────────────┐
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncService] │ STRIPE SYNC SERVICE - syncAll() │
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncService] └─────────────────────────────────────────────────────────────┘
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncService] 📝 Creando job de sincronización...
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncService] - Holding ID: 5652e95e-bb99-48f5-aa1c-13c8c2638fc6
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncService] - Batch Size: 100
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncService] ✅ Job creado con ID: 7c44b510-41e3-48e3-ab64-c3a0cb6b55df
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncService] 🚀 Iniciando ejecución asíncrona del job...

[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncService]
╔═════════════════════════════════════════════════════════════╗
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncService] ║ EJECUTANDO JOB DE SINCRONIZACIÓN ║
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncService] ╚═════════════════════════════════════════════════════════════╝
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncService] 🆔 Job ID: 7c44b510-41e3-48e3-ab64-c3a0cb6b55df
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncService] 🏢 Holding ID: 5652e95e-bb99-48f5-aa1c-13c8c2638fc6
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncService] 📦 Batch Size: 100
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncService] ⏰ Inicio: 2026-03-23T09:23:42.711Z

[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncService]
┌─────────────────────────────────────────────────────────────┐
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncService] │ FASE 0: VALIDACIÓN DE CLIENTES CONTRA BIGQUERY │
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncService] └─────────────────────────────────────────────────────────────┘
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncController] ✅ Job de sincronización creado exitosamente
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncController] - Job ID: 7c44b510-41e3-48e3-ab64-c3a0cb6b55df
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [StripeSyncController] ═══════════════════════════════════════════════════════════════

[Nest] 20589 - 23/03/2026, 6:23:42 LOG [AppLoggerService] POST /stripe/sync completed with status 201
[Nest] 20589 - 23/03/2026, 6:23:42 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:23:43 LOG [StripeSyncService] Validando 360 clientes...
[Nest] 20589 - 23/03/2026, 6:23:43 LOG [PostgreSQLDatabaseProvider] 🟢 Nueva conexión PostgreSQL establecida
[Nest] 20589 - 23/03/2026, 6:23:43 LOG [PostgreSQLDatabaseProvider] [object Object]
[Nest] 20589 - 23/03/2026, 6:23:43 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:23:43 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:23:43 DEBUG [StripeSyncService] Progress: {"invoices":{"total":0,"processed":0},"customers":{"total":0,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:23:43 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:23:43 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 200
[Nest] 20589 - 23/03/2026, 6:23:44 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:23:44 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:23:44 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:23:44 DEBUG [StripeSyncService] Progress: {"invoices":{"total":0,"processed":0},"customers":{"total":0,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:23:44 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:23:44 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:23:46 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:23:46 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:23:46 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:23:46 DEBUG [StripeSyncService] Progress: {"invoices":{"total":0,"processed":0},"customers":{"total":0,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:23:46 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:23:46 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:23:49 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:23:49 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:23:49 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:23:49 DEBUG [StripeSyncService] Progress: {"invoices":{"total":0,"processed":0},"customers":{"total":0,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:23:49 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:23:49 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:23:51 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:23:51 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:23:51 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:23:51 DEBUG [StripeSyncService] Progress: {"invoices":{"total":0,"processed":0},"customers":{"total":0,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:23:51 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:23:51 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:23:53 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:23:53 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:23:53 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:23:53 DEBUG [StripeSyncService] Progress: {"invoices":{"total":0,"processed":0},"customers":{"total":0,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:23:53 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:23:53 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:23:55 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:23:55 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:23:55 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:23:55 DEBUG [StripeSyncService] Progress: {"invoices":{"total":0,"processed":0},"customers":{"total":0,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:23:55 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:23:55 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:23:56 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:23:56 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:23:56 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:23:56 DEBUG [StripeSyncService] Progress: {"invoices":{"total":0,"processed":0},"customers":{"total":0,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:23:56 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:23:56 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:23:58 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:23:58 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:23:58 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:23:58 DEBUG [StripeSyncService] Progress: {"invoices":{"total":0,"processed":0},"customers":{"total":0,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:23:58 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:23:58 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:00 DEBUG [AgentsScheduler] Checking for scheduled agents to execute...
[Nest] 20589 - 23/03/2026, 6:24:00 DEBUG [AgentsScheduler] No scheduled agents found
[Nest] 20589 - 23/03/2026, 6:24:00 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:00 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:00 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:00 DEBUG [StripeSyncService] Progress: {"invoices":{"total":0,"processed":0},"customers":{"total":0,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:00 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:00 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:02 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:02 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:02 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:02 DEBUG [StripeSyncService] Progress: {"invoices":{"total":0,"processed":0},"customers":{"total":0,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:02 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:02 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:04 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:04 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:04 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:04 DEBUG [StripeSyncService] Progress: {"invoices":{"total":0,"processed":0},"customers":{"total":0,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:04 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:04 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:06 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:06 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:06 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:06 DEBUG [StripeSyncService] Progress: {"invoices":{"total":0,"processed":0},"customers":{"total":0,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:06 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:06 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:07 LOG [StripeSyncService]
✅ Validación completada:
[Nest] 20589 - 23/03/2026, 6:24:07 LOG [StripeSyncService] - Total validados: 360
[Nest] 20589 - 23/03/2026, 6:24:07 LOG [StripeSyncService] - Marcados como inválidos: 8
[Nest] 20589 - 23/03/2026, 6:24:07 LOG [StripeSyncService] - Válidos: 352

[Nest] 20589 - 23/03/2026, 6:24:07 LOG [StripeSyncService] ┌─────────────────────────────────────────────────────────────┐
[Nest] 20589 - 23/03/2026, 6:24:07 LOG [StripeSyncService] │ CONTANDO REGISTROS PARA SINCRONIZAR │
[Nest] 20589 - 23/03/2026, 6:24:07 LOG [StripeSyncService] └─────────────────────────────────────────────────────────────┘
[Nest] 20589 - 23/03/2026, 6:24:07 LOG [StripeSyncService] 📊 Clientes a sincronizar: 352
[Nest] 20589 - 23/03/2026, 6:24:07 LOG [StripeSyncService] 📊 Suscripciones a sincronizar: 0
[Nest] 20589 - 23/03/2026, 6:24:07 LOG [StripeSyncService] 📊 Facturas a sincronizar: 253
[Nest] 20589 - 23/03/2026, 6:24:07 LOG [StripeSyncService]
╔═════════════════════════════════════════════════════════════╗
[Nest] 20589 - 23/03/2026, 6:24:07 LOG [StripeSyncService] ║ FASE 1: SINCRONIZACIÓN DE CLIENTES ║
[Nest] 20589 - 23/03/2026, 6:24:07 LOG [StripeSyncService] ╚═════════════════════════════════════════════════════════════╝
[Nest] 20589 - 23/03/2026, 6:24:07 LOG [StripeSyncService] 📊 Total a sincronizar: 352
[Nest] 20589 - 23/03/2026, 6:24:07 LOG [StripeSyncService] 🔍 Iniciando syncCustomers con holdingId: 5652e95e-bb99-48f5-aa1c-13c8c2638fc6, batchSize: 100, total esperado: 352
[Nest] 20589 - 23/03/2026, 6:24:07 DEBUG [StripeSyncService] 🔎 Buscando clientes - offset: 0, chunkSize: 100
[Nest] 20589 - 23/03/2026, 6:24:07 DEBUG [StripeSyncService] 📝 Query SQL: SELECT "c"."id" AS "c_id", "c"."holding_id" AS "c_holding_id", "c"."stripe_id" AS "c_stripe_id", "c"."raw_data" AS "c_raw_data", "c"."sync_batch_id" AS "c_sync_batch_id", "c"."processing_status" AS "c_processing_status", "c"."integration_batch_id" AS "c_integration_batch_id", "c"."last_integrated_at" AS "c_last_integrated_at", "c"."integration_notes" AS "c_integration_notes", "c"."error_message" AS "c_error_message", "c"."created_at" AS "c_created_at", "c"."updated_at" AS "c_updated_at", "c"."connection_id" AS "c_connection_id" FROM "stripe_customers_stg" "c" WHERE "c"."holding_id" = $1 AND "c"."processing_status" IN ('to_create', 'to_update', 'error') ORDER BY "c"."created_at" ASC LIMIT 100 OFFSET 0
[Nest] 20589 - 23/03/2026, 6:24:07 DEBUG [StripeSyncService] 📝 Parámetros: {"holdingId":"5652e95e-bb99-48f5-aa1c-13c8c2638fc6"}
[Nest] 20589 - 23/03/2026, 6:24:07 LOG [StripeSyncService] 📊 Clientes encontrados en este chunk: 100
[Nest] 20589 - 23/03/2026, 6:24:07 LOG [StripeSyncService] ✅ Procesando chunk de 100 clientes (offset: 0)...
[Nest] 20589 - 23/03/2026, 6:24:07 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_DXQablIV11FKMO
[Nest] 20589 - 23/03/2026, 6:24:07 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_DXQablIV11FKMO
[Nest] 20589 - 23/03/2026, 6:24:07 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:07 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002DlEUFAA3
[Nest] 20589 - 23/03/2026, 6:24:07 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 3254028f-c2e7-4088-95f3-795e7801760b
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] 📤 Resultado para cus_DXQablIV11FKMO: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_Q6RqC10PxLnrDS
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_Q6RqC10PxLnrDS
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000MKP7FYAX
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 1006eefe-8911-42f3-8493-02690641fdbd
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] 📤 Resultado para cus_Q6RqC10PxLnrDS: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_J9y2koJTpVM7Vp
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_J9y2koJTpVM7Vp
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002SPld0AAD
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 4aa582b6-d389-46c1-9e29-f628f557c6cf
[Nest] 20589 - 23/03/2026, 6:24:08 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] 📤 Resultado para cus_J9y2koJTpVM7Vp: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_Ta29JRzr3uIG7u
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_Ta29JRzr3uIG7u
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:08 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 200
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000hKsyBYAS
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ ✅ Client encontrado: 53587eaf-e7df-452c-aa04-b3f72a48f196
[Nest] 20589 - 23/03/2026, 6:24:08 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] Relación client_entity_clients ya existe para client_entity_id: 7e4eabd9-9ad5-4cff-bf9c-396e57ded3e3, client_id: 53587eaf-e7df-452c-aa04-b3f72a48f196
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] 📤 Resultado para cus_Ta29JRzr3uIG7u: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_L6n2Say8c6st0K
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_L6n2Say8c6st0K
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002f8KVqAAM
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] │ ✅ Client encontrado: 483465f9-0a4f-4962-9618-cbf8762e0fce
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] Creando relación en client_entity_clients: client_entity_id=a867e8e8-60a6-43aa-94bf-ff9a1b54c17f, client_id=483465f9-0a4f-4962-9618-cbf8762e0fce
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] Relación client_entity_clients creada exitosamente
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] 📤 Resultado para cus_L6n2Say8c6st0K: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_RPaeQmHl3qF86P
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_RPaeQmHl3qF86P
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000KwVJuYAN
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity d3369e38-b6d1-43ed-b7f6-24074eb81839
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] 📤 Resultado para cus_RPaeQmHl3qF86P: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_MKnG1VA8gJiBUv
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_MKnG1VA8gJiBUv
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000UFJaYYAX
[Nest] 20589 - 23/03/2026, 6:24:09 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity b67b47cd-6e88-4608-94c7-29f2f6646912
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] 📤 Resultado para cus_MKnG1VA8gJiBUv: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_Pm5KgSzdY99nk4
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_Pm5KgSzdY99nk4
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO000008Ne1lYAC
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] │ ✅ Client encontrado: b56f0c9b-9eac-45da-88e5-cbb94ae64d64
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] Creando relación en client_entity_clients: client_entity_id=65625c63-02ef-4ca2-8fc1-26361da616f3, client_id=b56f0c9b-9eac-45da-88e5-cbb94ae64d64
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] Relación client_entity_clients creada exitosamente
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] 📤 Resultado para cus_Pm5KgSzdY99nk4: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_PbZi04VehtnfHi
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_PbZi04VehtnfHi
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO0000075D5WYAU
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:10 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 46bb9e03-9914-4c2f-b947-f9fb9bd8a5dd
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] 📤 Resultado para cus_PbZi04VehtnfHi: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_PLsHRtygGEsKJ4
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_PLsHRtygGEsKJ4
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:10 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO000005RcpVYAS
[Nest] 20589 - 23/03/2026, 6:24:10 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 5c02ce92-1856-43da-8cac-8de83833a7fe
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] 📤 Resultado para cus_PLsHRtygGEsKJ4: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_TXRVO1VyASCCx6
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_TXRVO1VyASCCx6
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000hClQiYAK
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ ✅ Client encontrado: 29003dda-9f58-48d7-b15a-ec09da05e31b
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] Relación client_entity_clients ya existe para client_entity_id: fb9c1d08-35e4-4a19-817b-e6db30cbfcce, client_id: 29003dda-9f58-48d7-b15a-ec09da05e31b
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] 📤 Resultado para cus_TXRVO1VyASCCx6: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_IEwwgj1XQ2PlLb
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_IEwwgj1XQ2PlLb
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000jUw0DYAS
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ ✅ Client encontrado: 61acc686-587c-46ca-ad40-e6a6ee410886
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] Relación client_entity_clients ya existe para client_entity_id: 2fa234f4-c8a7-4617-a21a-823e03e78967, client_id: 61acc686-587c-46ca-ad40-e6a6ee410886
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] 📤 Resultado para cus_IEwwgj1XQ2PlLb: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_LSu5j9d7fHJg3o
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_LSu5j9d7fHJg3o
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002h4MSJAA2
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:11 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 2eb55ca2-729b-482d-b41a-498d355238e0
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] 📤 Resultado para cus_LSu5j9d7fHJg3o: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_ScU1Z5rtyq0Xkq
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_ScU1Z5rtyq0Xkq
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000jOLPfYAO
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] │ ✅ Client encontrado: fb8f322e-8677-4634-90df-2cd16bf6969f
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] Relación client_entity_clients ya existe para client_entity_id: 2d987ec0-47db-405a-9e45-4e643602b90c, client_id: fb8f322e-8677-4634-90df-2cd16bf6969f
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] 📤 Resultado para cus_ScU1Z5rtyq0Xkq: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_M9K94HGWA9JOUe
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_M9K94HGWA9JOUe
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002o2gJqAAI
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 530b51be-e361-413e-981e-83815ed2d209
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] 📤 Resultado para cus_M9K94HGWA9JOUe: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:12 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_NQz4YqPdn1oxtt
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_NQz4YqPdn1oxtt
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002pZIxWAAW
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:12 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:12 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 30de3078-8058-4dc2-8b83-af10916819ef
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] 📤 Resultado para cus_NQz4YqPdn1oxtt: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_LspizZrLfYiFAk
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_LspizZrLfYiFAk
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002jC511AAC
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] │ ✅ Client encontrado: 495aca71-1db6-4c78-9b80-9cc3c897df8c
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] Creando relación en client_entity_clients: client_entity_id=4f836a31-8411-4acb-87ac-cd20e961bd86, client_id=495aca71-1db6-4c78-9b80-9cc3c897df8c
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] Relación client_entity_clients creada exitosamente
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] 📤 Resultado para cus_LspizZrLfYiFAk: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_TNwTCbj7hHxdzU
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_TNwTCbj7hHxdzU
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000eSLX7YAO
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] │ ✅ Client encontrado: 60dd7297-0c8f-458a-a427-dc4fa9da1964
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] Relación client_entity_clients ya existe para client_entity_id: 055bd9e7-0c8b-490b-8a64-31a66960d96a, client_id: 60dd7297-0c8f-458a-a427-dc4fa9da1964
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] 📤 Resultado para cus_TNwTCbj7hHxdzU: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_Q6XvtpUmbUjU7b
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_Q6XvtpUmbUjU7b
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000ANBHzYAP
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:13 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity afc55ea9-d65d-486c-a62a-6b7b0246a7a2
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] 📤 Resultado para cus_Q6XvtpUmbUjU7b: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_GIESuaxLoNpRC1
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_GIESuaxLoNpRC1
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002Tv8auAAB
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 42672c42-96c5-4873-bb28-59196eca308c
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] 📤 Resultado para cus_GIESuaxLoNpRC1: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_SBYSnXXe1VB7v8
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_SBYSnXXe1VB7v8
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000SREGTYA5
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity f8edf289-c864-491c-b77e-f62eb399a072
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] 📤 Resultado para cus_SBYSnXXe1VB7v8: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:14 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_TYbXElXttW238x
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_TYbXElXttW238x
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000h2HATYA2
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] │ ✅ Client encontrado: fb483a2d-3f31-45d0-8238-46a7d1eac46b
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:14 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:14 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] Relación client_entity_clients ya existe para client_entity_id: 32cd6656-63ef-4b91-bfca-9345636d27dc, client_id: fb483a2d-3f31-45d0-8238-46a7d1eac46b
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] 📤 Resultado para cus_TYbXElXttW238x: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_FxzSrAH6XGp9I1
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_FxzSrAH6XGp9I1
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000BXPHSYA5
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity ba369a6b-1c61-442c-8c5d-cf52e78ed284
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] 📤 Resultado para cus_FxzSrAH6XGp9I1: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_AIaiLbMMeYUkrR
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_AIaiLbMMeYUkrR
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002MMex1AAD
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 0cf8eecc-6d49-4b15-b503-4963dd4f5835
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] 📤 Resultado para cus_AIaiLbMMeYUkrR: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_SdVsFXh3NUVgJg
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_SdVsFXh3NUVgJg
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000Vikq7YAB
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 60f6655a-8017-454a-9f5a-bd0eb88741a0
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:15 DEBUG [StripeSyncService] 📤 Resultado para cus_SdVsFXh3NUVgJg: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_Oq1jbyUiUIdlgp
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_Oq1jbyUiUIdlgp
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000KmxvBYAR
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 9e7efafd-ed56-48a4-97db-c65b396f8c63
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] 📤 Resultado para cus_Oq1jbyUiUIdlgp: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_M0t9WqqMOy8I2G
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_M0t9WqqMOy8I2G
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002jvCxFAAU
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] │ ✅ Client encontrado: 642a86fc-01b2-400e-8bdb-9e55bfc141fe
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] Relación client_entity_clients ya existe para client_entity_id: c01d74b1-5616-497f-89c8-c8f92293924e, client_id: 642a86fc-01b2-400e-8bdb-9e55bfc141fe
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] 📤 Resultado para cus_M0t9WqqMOy8I2G: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_TSipoRIJnCaMvg
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_TSipoRIJnCaMvg
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000fIyF5YAK
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:16 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] │ ✅ Client encontrado: 77d05dd9-f7f5-48b3-8f23-412905b4119d
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:16 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] Relación client_entity_clients ya existe para client_entity_id: 0398dd19-be91-4a3e-a5a9-5cbbf29ff81d, client_id: 77d05dd9-f7f5-48b3-8f23-412905b4119d
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] 📤 Resultado para cus_TSipoRIJnCaMvg: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_RiZLTwSi8pxpA9
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_RiZLTwSi8pxpA9
[Nest] 20589 - 23/03/2026, 6:24:16 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000NgyFXYAZ
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] │ ✅ Client encontrado: 262796df-400d-44af-b7b7-e70109108d13
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] Creando relación en client_entity_clients: client_entity_id=5756e1c8-093d-4eb6-a875-d134a18e78ab, client_id=262796df-400d-44af-b7b7-e70109108d13
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] Relación client_entity_clients creada exitosamente
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] 📤 Resultado para cus_RiZLTwSi8pxpA9: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_OC11mXMzdIUpHR
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_OC11mXMzdIUpHR
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002rgRSwAAM
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity eb64516c-fb8d-4eb9-bac6-bc92037690d2
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] 📤 Resultado para cus_OC11mXMzdIUpHR: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_PGxIoVTQ7rWmOK
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_PGxIoVTQ7rWmOK
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO000004zKypYAE
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 8b32fc70-3886-46b5-8040-32e1622d9fa9
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:17 DEBUG [StripeSyncService] 📤 Resultado para cus_PGxIoVTQ7rWmOK: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_MbMaPetUZHNO77
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_MbMaPetUZHNO77
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000VUnENYA1
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] │ ✅ Client encontrado: 0b09f8c2-fdb4-48f0-ba49-c4218ccc0d0c
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] Relación client_entity_clients ya existe para client_entity_id: 7c1d23ed-0a09-4fbe-96d9-2a63df9fa688, client_id: 0b09f8c2-fdb4-48f0-ba49-c4218ccc0d0c
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] 📤 Resultado para cus_MbMaPetUZHNO77: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_JZXxCnI9PD7PQR
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_JZXxCnI9PD7PQR
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002cBIk4AAG
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 5ef1559c-b643-434b-a25a-2ad6a7ccbf4e
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] 📤 Resultado para cus_JZXxCnI9PD7PQR: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_NhY2CLmcfy6xGi
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_NhY2CLmcfy6xGi
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002qee8iAAA
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:18 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity e960958d-66fe-4932-8c31-644f98376a51
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:18 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] 📤 Resultado para cus_NhY2CLmcfy6xGi: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_JInCfqHrsFg37h
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_JInCfqHrsFg37h
[Nest] 20589 - 23/03/2026, 6:24:18 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000lBMcIYAW
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ ✅ Client encontrado: a5a40c79-062a-406a-b6e4-b463cf0b5cfa
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] Relación client_entity_clients ya existe para client_entity_id: 7ab149d8-bdaa-4a95-b616-8a04d4ebc973, client_id: a5a40c79-062a-406a-b6e4-b463cf0b5cfa
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] 📤 Resultado para cus_JInCfqHrsFg37h: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_TsMvKlVY5QeAY9
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_TsMvKlVY5QeAY9
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000l9kerYAA
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ ✅ Client encontrado: 7bc79ade-9a4d-4c51-92f4-96214d0b61a5
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] Relación client_entity_clients ya existe para client_entity_id: ebbe4bd3-3f71-4bba-a317-7de4430b5e1e, client_id: 7bc79ade-9a4d-4c51-92f4-96214d0b61a5
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] 📤 Resultado para cus_TsMvKlVY5QeAY9: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_TvK2zSYFmX6mct
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_TvK2zSYFmX6mct
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000l9fQfYAI
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ ✅ Client encontrado: 6cdf6aa6-2b41-4797-b3ae-1e8f9e6a7c22
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] Relación client_entity_clients ya existe para client_entity_id: d1b29141-2d11-44e1-b9ed-13779bbf1977, client_id: 6cdf6aa6-2b41-4797-b3ae-1e8f9e6a7c22
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] 📤 Resultado para cus_TvK2zSYFmX6mct: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_QEdAcIg2l2UxTy
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_QEdAcIg2l2UxTy
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000BSHlyYAH
[Nest] 20589 - 23/03/2026, 6:24:19 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity af96d11d-eabe-4524-a684-619b8abb71b2
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] 📤 Resultado para cus_QEdAcIg2l2UxTy: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_S70fX3fuM2b1zx
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_S70fX3fuM2b1zx
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000AiXnKYAV
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] │ ✅ Client encontrado: 44838f56-e74a-4cb5-b01f-8e13a6100216
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] Creando relación en client_entity_clients: client_entity_id=d1d54781-4c09-422f-b393-ff50cda994a0, client_id=44838f56-e74a-4cb5-b01f-8e13a6100216
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] Relación client_entity_clients creada exitosamente
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] 📤 Resultado para cus_S70fX3fuM2b1zx: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_MOIG6blCfXKhma
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_MOIG6blCfXKhma
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002lrbWDAAY
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:20 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity d73dee73-5be3-4f8a-b9c2-4795ee38c9b0
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] 📤 Resultado para cus_MOIG6blCfXKhma: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:20 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_Q6KjZZ3j4a1XHk
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_Q6KjZZ3j4a1XHk
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000AiXnKYAV
[Nest] 20589 - 23/03/2026, 6:24:20 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] │ ✅ Client encontrado: 44838f56-e74a-4cb5-b01f-8e13a6100216
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] Creando relación en client_entity_clients: client_entity_id=487a4506-2de1-42d2-ae5c-fef9707320c5, client_id=44838f56-e74a-4cb5-b01f-8e13a6100216
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] Relación client_entity_clients creada exitosamente
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] 📤 Resultado para cus_Q6KjZZ3j4a1XHk: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_MbML7MA6O36kCo
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_MbML7MA6O36kCo
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002mSq44AAC
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] │ ✅ Client encontrado: 181a0ce4-e406-4a85-bfec-e1a41e509e78
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] Creando relación en client_entity_clients: client_entity_id=cb41c55e-8029-404b-b0b9-d84aa6878c82, client_id=181a0ce4-e406-4a85-bfec-e1a41e509e78
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] Relación client_entity_clients creada exitosamente
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] 📤 Resultado para cus_MbML7MA6O36kCo: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_K1SuVvgYalpQRw
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_K1SuVvgYalpQRw
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002YAfPmAAL
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 3e3ebb6d-e8cf-4577-882f-413c70d11228
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:21 DEBUG [StripeSyncService] 📤 Resultado para cus_K1SuVvgYalpQRw: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_S6a7ISc47TAwu9
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_S6a7ISc47TAwu9
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000QlsRGYAZ
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity e689e1ca-d99f-4b36-a5b6-624b792992f4
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] 📤 Resultado para cus_S6a7ISc47TAwu9: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_RGUiTYXocXIAxs
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_RGUiTYXocXIAxs
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000KdHokYAF
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 088b7a58-04c7-4356-8194-26d848f4a17e
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] 📤 Resultado para cus_RGUiTYXocXIAxs: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_NhUc1S1BTwZwxM
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_NhUc1S1BTwZwxM
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002qZTLFAA4
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:22 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 6aeeb617-b90b-45f3-b9a5-0b47eaa25022
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:22 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] 📤 Resultado para cus_NhUc1S1BTwZwxM: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_TKxAUHAebIkPPF
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_TKxAUHAebIkPPF
[Nest] 20589 - 23/03/2026, 6:24:22 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000drnqxYAA
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ ✅ Client encontrado: 25a956df-e80b-46cc-ae60-fa8605468322
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] Relación client_entity_clients ya existe para client_entity_id: 6bbed1bf-7754-4470-8fbf-a15fe7f1c792, client_id: 25a956df-e80b-46cc-ae60-fa8605468322
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] 📤 Resultado para cus_TKxAUHAebIkPPF: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_OZmglsh2fDnBJL
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_OZmglsh2fDnBJL
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002scuJIAAY
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 61d816f3-d266-409e-803b-32848c31feed
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] 📤 Resultado para cus_OZmglsh2fDnBJL: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_TXsTXTOH6nforO
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_TXsTXTOH6nforO
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000ghjmUYAQ
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ ✅ Client encontrado: 4e66bd32-1897-4244-a291-d3649a903f2f
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] Relación client_entity_clients ya existe para client_entity_id: 413741cc-6ec2-4761-96b5-a70a5516322d, client_id: 4e66bd32-1897-4244-a291-d3649a903f2f
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] 📤 Resultado para cus_TXsTXTOH6nforO: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_LpMBPGlHRjWZp9
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_LpMBPGlHRjWZp9
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000mR1xLYAS
[Nest] 20589 - 23/03/2026, 6:24:23 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ ✅ Client encontrado: eba50d74-86f8-48b9-b22d-16701edd933d
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] Relación client_entity_clients ya existe para client_entity_id: a8f1807c-d9f7-4b1d-baf8-c78faa1c26f3, client_id: eba50d74-86f8-48b9-b22d-16701edd933d
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] 📤 Resultado para cus_LpMBPGlHRjWZp9: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_ST8LwIYhNFNktP
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_ST8LwIYhNFNktP
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000Tr3vAYAR
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 48c0a9b8-e427-4bac-bee4-63260c2d2c17
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] 📤 Resultado para cus_ST8LwIYhNFNktP: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_R9oxep1tJ4KZoq
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_R9oxep1tJ4KZoq
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000JCcWQYA1
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 8caaf99c-5d50-4a81-83f5-ae493b1caa68
[Nest] 20589 - 23/03/2026, 6:24:24 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] 📤 Resultado para cus_R9oxep1tJ4KZoq: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_JmPAC5NFqCv6yR
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_JmPAC5NFqCv6yR
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:24 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002VeVtHAAV
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:24 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity a55c473b-102e-4838-9571-187574d90150
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] 📤 Resultado para cus_JmPAC5NFqCv6yR: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_NqAmJVXEmvadzs
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_NqAmJVXEmvadzs
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002qZ7HbAAK
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 589b870a-9054-4d54-af9b-435bf14c9919
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] 📤 Resultado para cus_NqAmJVXEmvadzs: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_QomY15QdN0JtJa
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_QomY15QdN0JtJa
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000G3BozYAF
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 14477b13-f6c9-462d-bade-78362dbfbb3b
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] 📤 Resultado para cus_QomY15QdN0JtJa: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_NoxQxYUK4gsEcO
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_NoxQxYUK4gsEcO
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002qZ5zeAAC
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:25 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 09e25196-c400-4138-9df3-291e73314273
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] 📤 Resultado para cus_NoxQxYUK4gsEcO: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_LLMsWBqODwb0Q0
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_LLMsWBqODwb0Q0
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002hJY7CAAW
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity cac9b0d4-a187-4ea1-9e70-31085bb99db7
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] 📤 Resultado para cus_LLMsWBqODwb0Q0: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_ThrObFAuqQODeW
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_ThrObFAuqQODeW
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000istkwYAA
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ ✅ Client encontrado: 115ac39c-1426-47e6-985f-7323da9ebbb8
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] Relación client_entity_clients ya existe para client_entity_id: 2c289957-9276-462a-a85a-c8ef6db037c2, client_id: 115ac39c-1426-47e6-985f-7323da9ebbb8
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] 📤 Resultado para cus_ThrObFAuqQODeW: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_Np4jltFxxcP3zw
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_Np4jltFxxcP3zw
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:26 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002qYlvtAAC
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:26 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity dd0cf938-03cb-4797-8ae6-8120f7fd871c
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:26 DEBUG [StripeSyncService] 📤 Resultado para cus_Np4jltFxxcP3zw: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_IUuPDux3XoKfAL
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_IUuPDux3XoKfAL
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002MgjeVAAR
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 8ed4b327-8d70-4c50-bde4-bd94687bdec8
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] 📤 Resultado para cus_IUuPDux3XoKfAL: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_GuFgqWjQ5ybgkD
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_GuFgqWjQ5ybgkD
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002DlEZDAA3
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] │ ✅ Client encontrado: f0ceb25a-ccb9-4d95-9878-3ff9852f03bd
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] Creando relación en client_entity_clients: client_entity_id=e927b65c-fbfc-45d1-8e8e-549794041224, client_id=f0ceb25a-ccb9-4d95-9878-3ff9852f03bd
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] Relación client_entity_clients creada exitosamente
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] 📤 Resultado para cus_GuFgqWjQ5ybgkD: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_SDPs8AyPmsQCMT
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_SDPs8AyPmsQCMT
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000S9WoYYAV
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:27 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity df1e4c0c-8c47-437a-aa2f-be519163d4f3
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] 📤 Resultado para cus_SDPs8AyPmsQCMT: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_MAo03l5tnD6WcL
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_MAo03l5tnD6WcL
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002h4lb2AAA
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 7555abeb-24ee-41e2-8d58-b05e6fd6c18a
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] 📤 Resultado para cus_MAo03l5tnD6WcL: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_QEEEg0scMRuKK1
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_QEEEg0scMRuKK1
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000BJoveYAD
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 82042322-9f27-4418-a8f0-60809b752acf
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] 📤 Resultado para cus_QEEEg0scMRuKK1: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_PuKiMGeyEV6RbT
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_PuKiMGeyEV6RbT
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000B7ZkHYAV
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 2afcfb9c-2dd2-4435-9515-922841e868d6
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:28 DEBUG [StripeSyncService] 📤 Resultado para cus_PuKiMGeyEV6RbT: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_QwcuDtCbSF6NSk
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_QwcuDtCbSF6NSk
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000CKabVYAT
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity cba8bd6f-a7ed-4478-8d6a-3d5814d29860
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] 📤 Resultado para cus_QwcuDtCbSF6NSk: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_ThTHBHVxov8mOt
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_ThTHBHVxov8mOt
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000iiiAdYAI
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] │ ✅ Client encontrado: 94937767-03fc-4abf-82e5-2be99da7a07b
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] Relación client_entity_clients ya existe para client_entity_id: e00336ee-d824-4dc6-8581-937403017038, client_id: 94937767-03fc-4abf-82e5-2be99da7a07b
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] 📤 Resultado para cus_ThTHBHVxov8mOt: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_KRxsg9CDalymeo
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_KRxsg9CDalymeo
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000X9b77YAB
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:29 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 61658423-4cb3-4474-a676-5252ea0d3046
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:29 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] 📤 Resultado para cus_KRxsg9CDalymeo: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_MGkcwIo5o4tLKg
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_MGkcwIo5o4tLKg
[Nest] 20589 - 23/03/2026, 6:24:29 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002kLfsuAAC
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 3fe2ab0c-2142-4882-9f89-f7905e5e1d5d
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] 📤 Resultado para cus_MGkcwIo5o4tLKg: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_U6GJcgL6ZywDHt
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_U6GJcgL6ZywDHt
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000mxJlZYAU
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] │ ✅ Client encontrado: f19b3de9-d015-4104-8ad0-ec240ef6bd51
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] Creando relación en client_entity_clients: client_entity_id=7b3b3fc9-0366-48ee-8a44-fb4c1828c82c, client_id=f19b3de9-d015-4104-8ad0-ec240ef6bd51
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] Relación client_entity_clients creada exitosamente
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] 📤 Resultado para cus_U6GJcgL6ZywDHt: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_NYud8OuzIX3eT7
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_NYud8OuzIX3eT7
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002pgadIAAQ
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 1da7b1b1-b6ac-466b-bac7-7a5207c9cd13
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] 📤 Resultado para cus_NYud8OuzIX3eT7: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_OyWhKzcJPAOuwD
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_OyWhKzcJPAOuwD
[Nest] 20589 - 23/03/2026, 6:24:30 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO000002ee8vYAA
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity b822d5ee-c77e-4b7e-88ef-572ec0983107
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] 📤 Resultado para cus_OyWhKzcJPAOuwD: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_Hrj7Dtrd3NoOcV
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_Hrj7Dtrd3NoOcV
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002T6NeLAAV
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] │ ✅ Client encontrado: ac6fadaf-56b0-4118-987c-c8b13e627461
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] Creando relación en client_entity_clients: client_entity_id=8b9904d1-1291-4050-b3fe-e77e9f82984b, client_id=ac6fadaf-56b0-4118-987c-c8b13e627461
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] Relación client_entity_clients creada exitosamente
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] 📤 Resultado para cus_Hrj7Dtrd3NoOcV: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_NqEGc7xSJrI85N
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_NqEGc7xSJrI85N
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002h4LPIAA2
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:31 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 1c7e3806-f5b0-49f1-9c4d-eed915908687
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:31 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] 📤 Resultado para cus_NqEGc7xSJrI85N: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_MY3ZITp7LgxhCJ
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_MY3ZITp7LgxhCJ
[Nest] 20589 - 23/03/2026, 6:24:31 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002mNXfJAAW
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 9115dc83-9fd7-4152-bcb2-47d3f713fb9b
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] 📤 Resultado para cus_MY3ZITp7LgxhCJ: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_LkEQZw1mTA0KkH
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_LkEQZw1mTA0KkH
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002iTUhnAAG
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity c2b9c2ff-77c7-40d6-8eb5-8d87f7adc412
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] 📤 Resultado para cus_LkEQZw1mTA0KkH: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_SPH63hRnSalHOE
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_SPH63hRnSalHOE
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000TgXVAYA3
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 5057c1e2-32b7-4900-af01-7fe0ef50dc57
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] 📤 Resultado para cus_SPH63hRnSalHOE: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_NeuIOE13yOT8vU
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_NeuIOE13yOT8vU
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002eQ5EOAA0
[Nest] 20589 - 23/03/2026, 6:24:32 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 62c9ca8d-7e74-4eed-af07-8e305f55c3dd
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] 📤 Resultado para cus_NeuIOE13yOT8vU: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_QOtCcfIviuwNpM
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_QOtCcfIviuwNpM
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000CRFP4YAP
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 96283f9b-8fa0-44a4-ad68-c90d7d017fac
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] 📤 Resultado para cus_QOtCcfIviuwNpM: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_PVFfIjoPCo1BHP
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_PVFfIjoPCo1BHP
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO000006IceTYAS
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:33 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity b99547ca-e2d1-44e7-99d1-efd4df445b6f
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] 📤 Resultado para cus_PVFfIjoPCo1BHP: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:33 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_KXGIjf1HbrK2k8
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_KXGIjf1HbrK2k8
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002bdYv7AAE
[Nest] 20589 - 23/03/2026, 6:24:33 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] │ ✅ Client encontrado: 41c33061-a6d9-4c1b-9aa7-41cd100ad960
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] Creando relación en client_entity_clients: client_entity_id=992d7aa7-e71c-4a42-b6c3-b33c18c7bc75, client_id=41c33061-a6d9-4c1b-9aa7-41cd100ad960
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] Relación client_entity_clients creada exitosamente
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] 📤 Resultado para cus_KXGIjf1HbrK2k8: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_PGXopebenpEFiU
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_PGXopebenpEFiU
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO000004xqQ6YAI
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 11746b61-60dd-4bec-ae73-e397554ec255
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] 📤 Resultado para cus_PGXopebenpEFiU: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_HRZNQ7GUx15GfU
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_HRZNQ7GUx15GfU
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002T6RHZAA3
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 167119aa-c887-4671-a5ab-580d5e1d4211
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] 📤 Resultado para cus_HRZNQ7GUx15GfU: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_Pf9K2sIgArX3bM
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_Pf9K2sIgArX3bM
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000OgkyLYAR
[Nest] 20589 - 23/03/2026, 6:24:34 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 26818ec6-1f67-4d19-9176-0234129e3145
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] 📤 Resultado para cus_Pf9K2sIgArX3bM: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_KRMco4HuoXGpwa
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_KRMco4HuoXGpwa
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002aw7akAAA
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 71c71129-5d19-447f-b62e-01b082fa0233
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] 📤 Resultado para cus_KRMco4HuoXGpwa: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_DVcXvRoDr69LeD
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_DVcXvRoDr69LeD
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002Fm8GNAAZ
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 790919a8-78b4-47db-b7aa-531bf2d1610b
[Nest] 20589 - 23/03/2026, 6:24:35 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] 📤 Resultado para cus_DVcXvRoDr69LeD: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_JsnuVz7Lxg9zXP
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_JsnuVz7Lxg9zXP
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:35 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000ItzbdYAB
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:35 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 5ab3ca4f-4169-464e-ad36-08660272eb3b
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] 📤 Resultado para cus_JsnuVz7Lxg9zXP: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_OvBYCdRUxgTo6h
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_OvBYCdRUxgTo6h
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO000006EKZjYAO
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] │ ✅ Client encontrado: 1d0266b8-747a-4cf3-ba4a-4c20dfe6d029
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] Creando relación en client_entity_clients: client_entity_id=59ecc04b-b1b4-46ef-8a3d-dc3b18e565a9, client_id=1d0266b8-747a-4cf3-ba4a-4c20dfe6d029
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] Relación client_entity_clients creada exitosamente
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] 📤 Resultado para cus_OvBYCdRUxgTo6h: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_T3wHbyknOMWmI0
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_T3wHbyknOMWmI0
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000ZykYXYAZ
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] │ ✅ Client encontrado: d6787c1e-98a4-40cf-9a7d-65556c60dcaa
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] Relación client_entity_clients ya existe para client_entity_id: 3f5291a9-aa6a-4bf0-b9a4-5e31a39618cd, client_id: d6787c1e-98a4-40cf-9a7d-65556c60dcaa
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] 📤 Resultado para cus_T3wHbyknOMWmI0: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_KtgUggM50d7Lmk
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_KtgUggM50d7Lmk
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002dCr1pAAC
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:36 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 0bfe88eb-f7ca-4ff6-b04f-cf1f0a93cb93
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] 📤 Resultado para cus_KtgUggM50d7Lmk: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_I7gg2yw0sQGJH5
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_I7gg2yw0sQGJH5
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002T6RN1AAN
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] │ ✅ Client encontrado: 725183dd-abf2-4124-beb3-c54ecd40455e
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] Creando relación en client_entity_clients: client_entity_id=da9b7f7e-43a4-41bc-a3d1-98e6b7175395, client_id=725183dd-abf2-4124-beb3-c54ecd40455e
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] Relación client_entity_clients creada exitosamente
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] 📤 Resultado para cus_I7gg2yw0sQGJH5: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_MuOLZUiIYRFXEA
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_MuOLZUiIYRFXEA
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000m3vNwYAI
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:37 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 8509189f-fd50-4cae-9cfa-9b720ae13ad0
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] 📤 Resultado para cus_MuOLZUiIYRFXEA: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:37 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_DNJgHCwHtyjtmT
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_DNJgHCwHtyjtmT
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002Tv8aXAAR
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:37 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 0d82e589-c9b8-44f4-9a76-8cca5c3c921c
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] 📤 Resultado para cus_DNJgHCwHtyjtmT: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_JZ1uw4xjkUrwFV
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_JZ1uw4xjkUrwFV
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002UyZ0QAAV
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 453d9f64-f384-4392-820f-7326d957566d
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] 📤 Resultado para cus_JZ1uw4xjkUrwFV: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_JVF9BTBSMutdoG
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_JVF9BTBSMutdoG
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000m5AcsYAE
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] │ ✅ Client encontrado: edab7189-ae0b-4503-8095-86d1f29debdc
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] Relación client_entity_clients ya existe para client_entity_id: 8eb197f0-3489-44c7-ba5f-1621eae66c4d, client_id: edab7189-ae0b-4503-8095-86d1f29debdc
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] 📤 Resultado para cus_JVF9BTBSMutdoG: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_HJGVb8tdqPSOey
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_HJGVb8tdqPSOey
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002DlEbNAAV
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:38 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 69a1405e-6b51-43f1-ac1b-3a4b8e8e802e
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] 📤 Resultado para cus_HJGVb8tdqPSOey: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_LKKoBJQPWjRShZ
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_LKKoBJQPWjRShZ
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002SY2HSAA1
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 49b704f1-85e7-4da4-b7a9-5aa545aa9283
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] 📤 Resultado para cus_LKKoBJQPWjRShZ: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_HOpXR2YP7ISvWs
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_HOpXR2YP7ISvWs
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO000004odVMYAY
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity e809a4c6-cc49-4636-8587-54079c5d869d
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] 📤 Resultado para cus_HOpXR2YP7ISvWs: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:39 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_FuaYm1DM4XZoOK
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_FuaYm1DM4XZoOK
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002Tv8b9AAB
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":0},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:39 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ ✅ Client encontrado: c2cae125-2126-4828-866b-3dd574b5a228
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] Relación client_entity_clients ya existe para client_entity_id: 93d1ee90-cf97-459e-b8b3-8ad2cf3f5a04, client_id: c2cae125-2126-4828-866b-3dd574b5a228
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:39 DEBUG [StripeSyncService] 📤 Resultado para cus_FuaYm1DM4XZoOK: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_HqyPRZ9f6rzZfn
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_HqyPRZ9f6rzZfn
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002T6RGgAAN
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 4aa0991d-1aca-435d-bb53-372e03b339fc
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] 📤 Resultado para cus_HqyPRZ9f6rzZfn: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] 🔎 Buscando clientes - offset: 100, chunkSize: 100
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] 📝 Query SQL: SELECT "c"."id" AS "c_id", "c"."holding_id" AS "c_holding_id", "c"."stripe_id" AS "c_stripe_id", "c"."raw_data" AS "c_raw_data", "c"."sync_batch_id" AS "c_sync_batch_id", "c"."processing_status" AS "c_processing_status", "c"."integration_batch_id" AS "c_integration_batch_id", "c"."last_integrated_at" AS "c_last_integrated_at", "c"."integration_notes" AS "c_integration_notes", "c"."error_message" AS "c_error_message", "c"."created_at" AS "c_created_at", "c"."updated_at" AS "c_updated_at", "c"."connection_id" AS "c_connection_id" FROM "stripe_customers_stg" "c" WHERE "c"."holding_id" = $1 AND "c"."processing_status" IN ('to_create', 'to_update', 'error') ORDER BY "c"."created_at" ASC LIMIT 100 OFFSET 100
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] 📝 Parámetros: {"holdingId":"5652e95e-bb99-48f5-aa1c-13c8c2638fc6"}
[Nest] 20589 - 23/03/2026, 6:24:40 LOG [StripeSyncService] 📊 Clientes encontrados en este chunk: 100
[Nest] 20589 - 23/03/2026, 6:24:40 LOG [StripeSyncService] ✅ Procesando chunk de 100 clientes (offset: 100)...
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_Qk0ah1HrKPXKZl
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_Qk0ah1HrKPXKZl
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000FZCFRYA5
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 58748b80-ed20-447f-8f56-486b661cc0ea
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] 📤 Resultado para cus_Qk0ah1HrKPXKZl: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_HzgxYBemE4pBW2
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_HzgxYBemE4pBW2
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002T6RHlAAN
[Nest] 20589 - 23/03/2026, 6:24:40 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ ✅ Client encontrado: 8ee7816c-fdb3-442b-8224-a6d10d23337c
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] Relación client_entity_clients ya existe para client_entity_id: cd2d128b-881c-4b99-a689-1e4722b96794, client_id: 8ee7816c-fdb3-442b-8224-a6d10d23337c
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] 📤 Resultado para cus_HzgxYBemE4pBW2: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_HAtyJrybhA6ckG
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_HAtyJrybhA6ckG
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002DlEaVAAV
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity c0114eb9-3424-4fd1-bf13-aff391f59ed1
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] 📤 Resultado para cus_HAtyJrybhA6ckG: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_I3vRUllMHQukxr
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_I3vRUllMHQukxr
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002T6RIqAAN
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 82a131a6-9a34-42bf-bff8-403885c89533
[Nest] 20589 - 23/03/2026, 6:24:41 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] 📤 Resultado para cus_I3vRUllMHQukxr: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_Q6NaJ9u22mNjZM
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_Q6NaJ9u22mNjZM
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"current":"Chunk 1","processed":100},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:41 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 200
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000Ay47pYAB
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:41 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 634cd128-66ec-4ac6-b472-a46878d32f92
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] 📤 Resultado para cus_Q6NaJ9u22mNjZM: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_LKKsISAT1pUvo2
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_LKKsISAT1pUvo2
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000MucQzYAJ
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity dc208a0a-5791-4114-a94e-efb12b04f32a
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] 📤 Resultado para cus_LKKsISAT1pUvo2: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_NWJ7xFcyVLt6GN
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_NWJ7xFcyVLt6GN
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002phfPHAAY
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 6d0d58a8-6a1c-4703-a4d6-b89e5f4ce8e0
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] 📤 Resultado para cus_NWJ7xFcyVLt6GN: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_J1wVqfM5lx0zWG
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_J1wVqfM5lx0zWG
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002QbYpwAAF
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:42 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 41742109-f59a-475c-84ea-f48570212370
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] 📤 Resultado para cus_J1wVqfM5lx0zWG: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_RFiwWlWmCqMakF
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_RFiwWlWmCqMakF
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000K5yWHYAZ
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 94e4088f-8e6d-4052-858f-01f7743c8cfc
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] 📤 Resultado para cus_RFiwWlWmCqMakF: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_EYhwjWDpHMCs5V
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_EYhwjWDpHMCs5V
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002T6RKJAA3
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 56671dab-2115-450e-b470-1ac97e82b0b6
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] 📤 Resultado para cus_EYhwjWDpHMCs5V: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_RAbG3JD2coPT9f
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_RAbG3JD2coPT9f
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:43 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000K5EYHYA3
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"current":"Chunk 1","processed":100},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:43 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity cafa9dae-c93a-439f-86b8-ce2086fcc1cb
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:43 DEBUG [StripeSyncService] 📤 Resultado para cus_RAbG3JD2coPT9f: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_OTBQTxzqrvyx5P
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_OTBQTxzqrvyx5P
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002sN4JeAAK
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] │ ✅ Client encontrado: 617f83aa-e08e-48f4-b0d1-544dff1680b3
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] Creando relación en client_entity_clients: client_entity_id=fe9165ce-7ac4-4f95-9482-e5ba84480c64, client_id=617f83aa-e08e-48f4-b0d1-544dff1680b3
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] Relación client_entity_clients creada exitosamente
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] 📤 Resultado para cus_OTBQTxzqrvyx5P: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_Q3g4LINfOhdPDO
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_Q3g4LINfOhdPDO
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000BhFn3YAF
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity a377f895-dc37-431c-912b-3e0a71f49696
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] 📤 Resultado para cus_Q3g4LINfOhdPDO: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_OCB3FGsHV6LO8b
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_OCB3FGsHV6LO8b
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002scf7zAAA
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity eabbde10-cbd7-4459-9c3b-6af40585c40f
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:44 DEBUG [StripeSyncService] 📤 Resultado para cus_OCB3FGsHV6LO8b: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_JzuYyTHFGtZwEr
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_JzuYyTHFGtZwEr
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002Y90nyAAB
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 2750119e-29de-4f0b-9f36-0e10649ed4f6
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] 📤 Resultado para cus_JzuYyTHFGtZwEr: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_Nk5gAj6Tf6Suoh
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_Nk5gAj6Tf6Suoh
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002ZgbiuAAB
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity c9a0e155-0f18-43a3-a3e1-2fb8674bc642
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] 📤 Resultado para cus_Nk5gAj6Tf6Suoh: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_QjGW2HL6Stl4LS
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_QjGW2HL6Stl4LS
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000FM0onYAD
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:45 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 1e6b9d06-7b37-4543-97a7-21f02d044be5
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"current":"Chunk 1","processed":100},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:45 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] 📤 Resultado para cus_QjGW2HL6Stl4LS: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_J2kUYIPjkxfJcI
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_J2kUYIPjkxfJcI
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002QDTywAAH
[Nest] 20589 - 23/03/2026, 6:24:45 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 4d793a4e-5c51-4029-b442-87b034ebf030
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] 📤 Resultado para cus_J2kUYIPjkxfJcI: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_ONqC8VnQXlotDv
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_ONqC8VnQXlotDv
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002sLMdIAAW
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity a9329f61-d02b-4e40-be58-fbe933c7c8e1
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] 📤 Resultado para cus_ONqC8VnQXlotDv: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_QvC8o0XihPFAeu
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_QvC8o0XihPFAeu
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000H3nk3YAB
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 617321b6-5ca1-4dab-ad1a-01a840b9d561
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] 📤 Resultado para cus_QvC8o0XihPFAeu: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_QZBLPY7egfyUnG
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_QZBLPY7egfyUnG
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000FFjAmYAL
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:46 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 41ad0f76-5abe-4bc3-bd78-009872d83ae3
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] 📤 Resultado para cus_QZBLPY7egfyUnG: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_Qu36LATPZFd26w
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_Qu36LATPZFd26w
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002fpbS2AAI
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity d46b3a0d-4101-491c-8361-0d7eed8f771d
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] 📤 Resultado para cus_Qu36LATPZFd26w: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_MGpVvyVww2W4Ua
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_MGpVvyVww2W4Ua
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002lXrnhAAC
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 073e6a4e-ee01-4b14-ba6e-1cbec76c0153
[Nest] 20589 - 23/03/2026, 6:24:47 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] 📤 Resultado para cus_MGpVvyVww2W4Ua: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_LFR4fyMiKX6Mvo
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_LFR4fyMiKX6Mvo
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"current":"Chunk 1","processed":100},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:47 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002fYuveAAC
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:47 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 46041da9-56b0-4742-9467-d4f3db73d8c5
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] 📤 Resultado para cus_LFR4fyMiKX6Mvo: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_HnUyWnkrJRMzmt
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_HnUyWnkrJRMzmt
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002T6RHRAA3
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 9dcc4edd-4f3c-4cbd-a773-6c720ad2ab66
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] 📤 Resultado para cus_HnUyWnkrJRMzmt: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_O5Z5kA8PAt53SJ
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_O5Z5kA8PAt53SJ
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002rKv8NAAS
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 0dad8af0-a1bf-44cf-b464-db0c9fdc109d
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] 📤 Resultado para cus_O5Z5kA8PAt53SJ: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_QUA5NP7edMMyfc
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_QUA5NP7edMMyfc
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000D9qslYAB
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:48 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 02f18cf8-e027-407a-9212-7075a5c9a98f
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] 📤 Resultado para cus_QUA5NP7edMMyfc: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_QUu9kC8t4OI9yF
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_QUu9kC8t4OI9yF
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000D9ngOYAR
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 66ca370d-123d-4e04-9f62-1f7c073352b4
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] 📤 Resultado para cus_QUu9kC8t4OI9yF: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_RbZ2T1LviWaqnh
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_RbZ2T1LviWaqnh
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000MQxNzYAL
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 33d81a0c-a97c-4efe-9f81-694cdf4f9091
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] 📤 Resultado para cus_RbZ2T1LviWaqnh: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:49 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_MwLjFHb8qyyxD3
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_MwLjFHb8qyyxD3
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002nzYcFAAU
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"current":"Chunk 1","processed":100},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:49 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity a91817af-fc62-4c6b-acb0-6038df5e5366
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:49 DEBUG [StripeSyncService] 📤 Resultado para cus_MwLjFHb8qyyxD3: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_ODlcACVQI4a0Z7
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_ODlcACVQI4a0Z7
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002rgWSXAA2
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 7c0aacfc-1bfa-4b9a-af80-1af1e70fcbb1
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] 📤 Resultado para cus_ODlcACVQI4a0Z7: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_I3K288dSrGoYe5
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_I3K288dSrGoYe5
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002cchFyAAI
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity fac67121-2884-4ff5-81e2-b923106588ad
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] 📤 Resultado para cus_I3K288dSrGoYe5: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_HbBeOyRIOfUa0s
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_HbBeOyRIOfUa0s
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002Tv8brAAB
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 9ec79877-5a0c-4123-84e0-9d0fe51fe96d
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] 📤 Resultado para cus_HbBeOyRIOfUa0s: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_RZxsXxLptjuPpL
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_RZxsXxLptjuPpL
[Nest] 20589 - 23/03/2026, 6:24:50 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000MQtlqYAD
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 0d4bd7c2-7e84-48ed-8865-38c0cf71e5a4
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] 📤 Resultado para cus_RZxsXxLptjuPpL: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_RFn15EzttLEukh
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_RFn15EzttLEukh
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000JiNdtYAF
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 470e74f0-e411-4740-aeb8-0c8b54d30bb5
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] 📤 Resultado para cus_RFn15EzttLEukh: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_NgTYvAacNTnSJx
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_NgTYvAacNTnSJx
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002qBPw2AAG
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:51 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 161a35f5-b02e-4bd7-8719-f9681193ae9e
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"current":"Chunk 1","processed":100},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:51 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] 📤 Resultado para cus_NgTYvAacNTnSJx: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_K4mCut4O952ltx
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_K4mCut4O952ltx
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002YUQTPAA5
[Nest] 20589 - 23/03/2026, 6:24:51 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 8f8eab22-f26b-40e2-9fd7-670e2265c173
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] 📤 Resultado para cus_K4mCut4O952ltx: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_Plk6HAF0304pW6
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_Plk6HAF0304pW6
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO000008ApO3YAK
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 4384474d-b17a-4ac5-b412-91fd15e9b336
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] 📤 Resultado para cus_Plk6HAF0304pW6: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_PMCH8XUhp0Km6b
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_PMCH8XUhp0Km6b
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO000005U4WLYA0
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity c7c516ca-2710-4da1-8640-283a06a0d88c
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] 📤 Resultado para cus_PMCH8XUhp0Km6b: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_NEFqeJ7P58YWhS
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_NEFqeJ7P58YWhS
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002sc0rlAAA
[Nest] 20589 - 23/03/2026, 6:24:52 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity c04cf892-14e0-48c2-a140-e74f61da9274
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] 📤 Resultado para cus_NEFqeJ7P58YWhS: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_O5Fr0HexSDj4QT
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_O5Fr0HexSDj4QT
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002rJEbKAAW
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 0c4ed861-7246-4824-bb6c-bacf076b11f0
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] 📤 Resultado para cus_O5Fr0HexSDj4QT: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_OPhfG2yXMknYEr
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_OPhfG2yXMknYEr
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002sLoeRAAS
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity ee2d154a-ae99-4922-a250-1c28859dbf3b
[Nest] 20589 - 23/03/2026, 6:24:53 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] 📤 Resultado para cus_OPhfG2yXMknYEr: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_OvuveN4gZARaAh
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_OvuveN4gZARaAh
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"current":"Chunk 1","processed":100},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:53 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO000002pivYYAQ
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:53 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 4c0e379a-db30-4799-a088-82ae16bcd4f3
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] 📤 Resultado para cus_OvuveN4gZARaAh: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_PaXZiYkOcaSBlh
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_PaXZiYkOcaSBlh
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO000008tYVuYAM
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 984e2a1e-12c1-442a-acf1-882088640de4
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] 📤 Resultado para cus_PaXZiYkOcaSBlh: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_Q6KrySMysdvruj
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_Q6KrySMysdvruj
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000ALvK6YAL
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 432c790c-9522-488a-9a9a-2df06a032ec0
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] 📤 Resultado para cus_Q6KrySMysdvruj: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_Na3O3wknh1lKDi
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_Na3O3wknh1lKDi
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002qnFIAAA2
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:54 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 416bbd48-cd84-4961-afe3-5b1d4077dde6
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] 📤 Resultado para cus_Na3O3wknh1lKDi: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_Ie3rTffvjktQYO
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_Ie3rTffvjktQYO
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002OjKtmAAF
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 10b018d8-3504-4c90-b810-f7c7905b5141
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] 📤 Resultado para cus_Ie3rTffvjktQYO: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_OY1w8Vl9iQIZU2
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_OY1w8Vl9iQIZU2
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002sdPXSAA2
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ ✅ Client encontrado: bc191797-d30b-41cc-9ca4-21121968a391
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] Relación client_entity_clients ya existe para client_entity_id: 01e927e6-5865-4d59-9039-94722523ab00, client_id: bc191797-d30b-41cc-9ca4-21121968a391
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] 📤 Resultado para cus_OY1w8Vl9iQIZU2: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_N4A8WBhveBrouq
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_N4A8WBhveBrouq
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:55 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002eLJncAAG
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"current":"Chunk 1","processed":100},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:55 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity e55114f4-f675-4c70-b4c6-1bf1643ece29
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:55 DEBUG [StripeSyncService] 📤 Resultado para cus_N4A8WBhveBrouq: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_KoSzVXb6nMIhl4
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_KoSzVXb6nMIhl4
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO000003x5mjYAA
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity a5b5363a-7654-4b01-84e3-a0353d25fc6a
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] 📤 Resultado para cus_KoSzVXb6nMIhl4: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_RA7uAq9FJyx03i
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_RA7uAq9FJyx03i
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000JIBdIYAX
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity fee88c3b-a339-467b-b73f-7b47970989ac
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] 📤 Resultado para cus_RA7uAq9FJyx03i: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_HkYcti4vcoUNdV
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_HkYcti4vcoUNdV
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000HphXTYAZ
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 64edd4f5-7910-40bc-af48-06c0e3298ada
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] 📤 Resultado para cus_HkYcti4vcoUNdV: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_KLlUJUrBjxEoPn
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_KLlUJUrBjxEoPn
[Nest] 20589 - 23/03/2026, 6:24:56 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002aKLQSAA4
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 0778a9ae-16b9-40a4-b851-026af88cc71c
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] 📤 Resultado para cus_KLlUJUrBjxEoPn: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_RXOYeECYakFCaM
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_RXOYeECYakFCaM
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000LzkRdYAJ
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 1db0e846-d295-4c08-ae1a-513ddeea3193
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] 📤 Resultado para cus_RXOYeECYakFCaM: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_QLlB070ovrxTSf
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_QLlB070ovrxTSf
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000JL6IoYAL
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:57 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] │ ✅ Client encontrado: b3e19764-a925-47d0-8b45-722048c6fb28
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] Creando relación en client_entity_clients: client_entity_id=76fd74b6-3530-42c7-a157-d1d228b73af9, client_id=b3e19764-a925-47d0-8b45-722048c6fb28
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"current":"Chunk 1","processed":100},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:57 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] Relación client_entity_clients creada exitosamente
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] 📤 Resultado para cus_QLlB070ovrxTSf: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_HXXKQHiY1dvnwI
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_HXXKQHiY1dvnwI
[Nest] 20589 - 23/03/2026, 6:24:57 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002Tv8bmAAB
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 3e5b1e2d-4c2b-463c-9eeb-28162f1f8cb9
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] 📤 Resultado para cus_HXXKQHiY1dvnwI: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_RNDycdqxRn9xwr
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_RNDycdqxRn9xwr
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000J7txhYAB
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity a6864e40-77af-4c50-b82b-ff21ffebb5f7
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] 📤 Resultado para cus_RNDycdqxRn9xwr: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_LcGEB63M1xAXvP
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_LcGEB63M1xAXvP
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002i1RUGAA2
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity d06e80ac-8ddb-4c89-8dd6-a108336be6d5
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] 📤 Resultado para cus_LcGEB63M1xAXvP: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_MB5my4bZd9tu0i
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_MB5my4bZd9tu0i
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002l3j2XAAQ
[Nest] 20589 - 23/03/2026, 6:24:58 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 60dc52f3-d0b0-4e3b-8ad5-91994ce116be
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] 📤 Resultado para cus_MB5my4bZd9tu0i: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_MVPveSNA5V4rEu
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_MVPveSNA5V4rEu
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002n4KtQAAU
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity a30999b1-246f-483e-94c7-576782521d56
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] 📤 Resultado para cus_MVPveSNA5V4rEu: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_GLbMsilFYb6lH1
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_GLbMsilFYb6lH1
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002fAATWAA4
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:24:59 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 7aa170c9-6d60-4483-9da3-a0a6f8352035
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] 📤 Resultado para cus_GLbMsilFYb6lH1: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_NjjXLenPQrM9RZ
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_NjjXLenPQrM9RZ
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"current":"Chunk 1","processed":100},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:24:59 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002qYZkrAAG
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:24:59 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [AgentsScheduler] Checking for scheduled agents to execute...
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 4a77e147-1777-4e6f-91b2-3ba27f337b13
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [AgentsScheduler] No scheduled agents found
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] 📤 Resultado para cus_NjjXLenPQrM9RZ: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_Q3dCcF5DbocVx3
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_Q3dCcF5DbocVx3
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000EFXi3YAH
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity c333cb0d-3840-41b4-9f32-c63f55948bdf
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] 📤 Resultado para cus_Q3dCcF5DbocVx3: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_FzWSLEFd6ZxtXd
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_FzWSLEFd6ZxtXd
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000A3FmMYAV
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 8c216817-143c-4f32-aa13-dc43ff99978c
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] 📤 Resultado para cus_FzWSLEFd6ZxtXd: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_RJLtwhf3bQEdrQ
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_RJLtwhf3bQEdrQ
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000KUY2NYAX
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:00 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 585d6606-6d21-40fc-8031-34b7f7f252e2
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] 📤 Resultado para cus_RJLtwhf3bQEdrQ: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_MIcTha2AVwoc2G
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_MIcTha2AVwoc2G
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002lZi7cAAC
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 6d23cb81-5cb7-4746-b617-7bbb245c41ca
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] 📤 Resultado para cus_MIcTha2AVwoc2G: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_HoP4sTBI9uYXOc
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_HoP4sTBI9uYXOc
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000IzxSFYAZ
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 26efd38c-37d1-4b74-8c8f-76d1fbac5008
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] 📤 Resultado para cus_HoP4sTBI9uYXOc: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:01 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_LFq0MjDCdhdvZ8
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_LFq0MjDCdhdvZ8
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002fqMQHAA2
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"current":"Chunk 1","processed":100},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:01 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 2a27d4b2-2ac5-423f-b1a8-335f9a76c1dc
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:01 DEBUG [StripeSyncService] 📤 Resultado para cus_LFq0MjDCdhdvZ8: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_OYUOXsSy95skbh
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_OYUOXsSy95skbh
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002scNLVAA2
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 1b3363a7-2863-481e-91c3-481a0be1d6a5
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] 📤 Resultado para cus_OYUOXsSy95skbh: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_Ldy1zhXAYHyg2O
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_Ldy1zhXAYHyg2O
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002o21XOAAY
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 779f4467-9ece-480c-a28d-6af0797d3799
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] 📤 Resultado para cus_Ldy1zhXAYHyg2O: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_QcRip408AvwX4I
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_QcRip408AvwX4I
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000EN3mnYAD
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 2a8197a7-08d0-443d-8efb-87f3c4973b65
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] 📤 Resultado para cus_QcRip408AvwX4I: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_L1uAtYlNjGxJwf
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_L1uAtYlNjGxJwf
[Nest] 20589 - 23/03/2026, 6:25:02 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002d9xUxAAI
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity e1433fa4-9e7e-4d94-b154-34931687e30b
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] 📤 Resultado para cus_L1uAtYlNjGxJwf: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_I9f7rCE9GKOlms
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_I9f7rCE9GKOlms
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002qGkl8AAC
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity d74391e5-6537-4ca4-be51-33b105196ba4
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] 📤 Resultado para cus_I9f7rCE9GKOlms: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_HlgJkRG8V1JfkZ
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_HlgJkRG8V1JfkZ
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002Rw7CSAAZ
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:03 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 51e98ed4-4466-4e3a-8f0e-d91fced7402c
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"current":"Chunk 1","processed":100},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:03 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] 📤 Resultado para cus_HlgJkRG8V1JfkZ: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_IBedNEKixrt3cX
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_IBedNEKixrt3cX
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002rdjMuAAI
[Nest] 20589 - 23/03/2026, 6:25:03 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity ebe50569-1489-49c5-8725-3f04350273ec
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] 📤 Resultado para cus_IBedNEKixrt3cX: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_PqXVGMhQFLzDnU
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_PqXVGMhQFLzDnU
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO000008jV1RYAU
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 49cf2580-24a4-455d-9769-15f38fbd5701
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] 📤 Resultado para cus_PqXVGMhQFLzDnU: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_PhB33uzjLsDCiF
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_PhB33uzjLsDCiF
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO000007oLN0YAM
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ ✅ Client encontrado: e28dd001-4b35-4352-9ad7-32a688043a92
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] Relación client_entity_clients ya existe para client_entity_id: ac4028d1-916e-48ed-97d4-6fda9209855b, client_id: e28dd001-4b35-4352-9ad7-32a688043a92
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] 📤 Resultado para cus_PhB33uzjLsDCiF: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_LZilOfYV27mG3v
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_LZilOfYV27mG3v
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002hnxolAAA
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:04 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 0570484d-a40c-4d00-818b-6779460447f8
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] 📤 Resultado para cus_LZilOfYV27mG3v: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_RLlEvEs8kH4FjZ
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_RLlEvEs8kH4FjZ
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000Lc04aYAB
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity ea6d90c4-a38a-41fe-a4f2-f3df26b7976b
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] 📤 Resultado para cus_RLlEvEs8kH4FjZ: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_OqIulN4PYpS0kr
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_OqIulN4PYpS0kr
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO000002OL5SYAW
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 049bade5-f8b1-47b7-bef0-a11fdd67f86b
[Nest] 20589 - 23/03/2026, 6:25:05 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] 📤 Resultado para cus_OqIulN4PYpS0kr: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_OS4Okezw2fVqHZ
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_OS4Okezw2fVqHZ
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"current":"Chunk 1","processed":100},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:05 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002sN6ZpAAK
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:05 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 5d467fc4-f7f2-476a-a18d-7b55afbb9105
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] 📤 Resultado para cus_OS4Okezw2fVqHZ: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_NYtH4qzB4DiUeR
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_NYtH4qzB4DiUeR
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002pgPzFAAU
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 0af8849c-bb1c-497b-a23f-fed826eeff6a
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] 📤 Resultado para cus_NYtH4qzB4DiUeR: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_PqCQeURgYnzqg0
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_PqCQeURgYnzqg0
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000HJz64YAD
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity ee91f36b-013d-49b3-b64c-435046057716
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] 📤 Resultado para cus_PqCQeURgYnzqg0: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_MroevaXX458qkq
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_MroevaXX458qkq
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002nYGwtAAG
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:06 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity d690e9f6-2ef4-4f69-88b0-f5fc03a0c36b
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] 📤 Resultado para cus_MroevaXX458qkq: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_OvDZpfgKNUzwNo
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_OvDZpfgKNUzwNo
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO000008dounYAA
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 7f0e1e91-accb-41b6-a5d3-f9a3d923b362
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] 📤 Resultado para cus_OvDZpfgKNUzwNo: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_J921xVJNylj1z4
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_J921xVJNylj1z4
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002Ou0wNAAR
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] │ ✅ Client encontrado: bb7a561e-38d6-4d65-a971-71c4574cee3a
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] Creando relación en client_entity_clients: client_entity_id=139b48ea-e976-428c-8dfd-8af1d56f6faa, client_id=bb7a561e-38d6-4d65-a971-71c4574cee3a
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] Relación client_entity_clients creada exitosamente
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] 📤 Resultado para cus_J921xVJNylj1z4: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:25:07 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_JXljpz0A1MJH4z
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_JXljpz0A1MJH4z
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002UDlMNAA1
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"current":"Chunk 1","processed":100},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:07 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:07 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 59e15f07-b10b-449d-b37a-a576c36731ed
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] 📤 Resultado para cus_JXljpz0A1MJH4z: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_Rqwp6PKf21Sotk
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_Rqwp6PKf21Sotk
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000OTJPeYAP
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity c2971429-4f9f-4dc6-90bc-2cfe9ac412d2
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] 📤 Resultado para cus_Rqwp6PKf21Sotk: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_EHSfa3d4dlqAmK
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_EHSfa3d4dlqAmK
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002rJ7meAAC
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] │ ✅ Client encontrado: 857078cb-9169-4905-a393-e7166b5544fe
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] Creando relación en client_entity_clients: client_entity_id=e8b27147-827d-43f0-a8f5-63181cb28135, client_id=857078cb-9169-4905-a393-e7166b5544fe
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] Relación client_entity_clients creada exitosamente
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] 📤 Resultado para cus_EHSfa3d4dlqAmK: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_H0jrEH2iX5dRT7
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_H0jrEH2iX5dRT7
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000OFuyjYAD
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:08 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 0a481777-ef29-4e8f-905c-c23ecc61700b
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] 📤 Resultado para cus_H0jrEH2iX5dRT7: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_OXvjs619BpQcbe
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_OXvjs619BpQcbe
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002scYacAAE
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 02ed9fd3-a09f-47d8-9750-cd8d992c3c93
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] 📤 Resultado para cus_OXvjs619BpQcbe: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_Rj1KI5LI76FuQ8
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_Rj1KI5LI76FuQ8
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000NfYV9YAN
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 1a61b6d3-6434-41d0-b349-d36dc8970555
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] 📤 Resultado para cus_Rj1KI5LI76FuQ8: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_MiubU3wZwKaUj7
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_MiubU3wZwKaUj7
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:09 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002mldDSAAY
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"current":"Chunk 1","processed":100},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:09 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 1e436c58-299f-4d62-973d-c5124cd29f69
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:09 DEBUG [StripeSyncService] 📤 Resultado para cus_MiubU3wZwKaUj7: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_LIKnd3pbkASkxQ
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_LIKnd3pbkASkxQ
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002gB7TpAAK
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity c24e0321-68fb-4de4-b584-47b055ff6f23
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] 📤 Resultado para cus_LIKnd3pbkASkxQ: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_QFjAJofUZeWnUu
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_QFjAJofUZeWnUu
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000NaRu5YAF
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 69f9fb6e-60c0-416c-8a7c-598e9fd547ea
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] 📤 Resultado para cus_QFjAJofUZeWnUu: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_RhwUHzdbOv4gKV
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_RhwUHzdbOv4gKV
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000NXbEsYAL
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 2ee5063e-0e9c-455b-977d-5f0d38fdf287
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] 📤 Resultado para cus_RhwUHzdbOv4gKV: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_Mo7OJp4tqayvZF
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_Mo7OJp4tqayvZF
[Nest] 20589 - 23/03/2026, 6:25:10 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 0015w00002nNKkNAAW
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity 7034b2ef-5b7f-4ebe-9cff-dbe3ea937a4a
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] 📤 Resultado para cus_Mo7OJp4tqayvZF: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_RgQeRnCMlxcp54
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_RgQeRnCMlxcp54
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000NOnqNYAT
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity cb327bb1-7aa5-40fb-858f-7b01eaf56dd2
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] 📤 Resultado para cus_RgQeRnCMlxcp54: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_Rix7g5yTlZu0dU
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_Rix7g5yTlZu0dU
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000NO4RuYAL
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:11 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ ⚠️ Client NO encontrado - client_entity quedará sin relación
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ 🔄 Actualizando client_entity f0552189-0903-4c4d-b7c1-3a460b69839b
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"current":"Chunk 1","processed":100},"currentPhase":"customers","subscriptions":{"total":0,"processed":0},"overallProgress":0}
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:11 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ ⏭️ Sin client_id - omitiendo relación
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] └─── ✅ Completado: action=update

[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] 📤 Resultado para cus_Rix7g5yTlZu0dU: {"success":true,"action":"update"}
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] 🔄 Procesando cliente: cus_Pze71o2GzeAq1i
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService]
┌─── Procesando cliente: cus_Pze71o2GzeAq1i
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ PASO 1: Consultando BigQuery...
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ ✅ BigQuery: salesforce_account_id = 001RO00000KlfdiYAB
[Nest] 20589 - 23/03/2026, 6:25:11 DEBUG [StripeSyncService] │ PASO 2: Buscando client por salesforce_account_id...
[Nest] 20589 - 23/03/2026, 6:25:12 DEBUG [StripeSyncService] │ ✅ Client encontrado: 179f5184-ed87-4c70-9e7d-71de83200fd1
[Nest] 20589 - 23/03/2026, 6:25:12 DEBUG [StripeSyncService] │ PASO 3: Buscando client_entity existente...
[Nest] 20589 - 23/03/2026, 6:25:12 DEBUG [StripeSyncService] │ ℹ️ Sin cambios en client_entity
[Nest] 20589 - 23/03/2026, 6:25:12 DEBUG [StripeSyncService] │ PASO 4: Gestionando relación client_entity_clients...
[Nest] 20589 - 23/03/2026, 6:25:12 DEBUG [StripeSyncService] Creando relación en client_entity_clients: client_entity_id=126d8687-1d35-46b6-990a-dc69868794f2, client_id=179f5184-ed87-4c70-9e7d-71de83200fd1
[Nest] 20589 - 23/03/2026, 6:25:12 DEBUG [StripeSyncService] Relación client_entity_clients creada exitosamente
[Nest] 20589 - 23/03/2026, 6:25:12 DEBUG [StripeSyncService] │ ✅ Relación creada/verificada
[Nest] 20589 - 23/03/2026, 6:25:12 DEBUG [StripeSyncService] └─── ✅ Completado: action=no_change

[Nest] 20589 - 23/03/2026, 6:25:12 DEBUG [StripeSyncService] 📤 Resultado para cus_Pze71o2GzeAq1i: {"success":true,"action":"no_change"}
[Nest] 20589 - 23/03/2026, 6:25:12 DEBUG [StripeSyncService] 🔎 Buscando clientes - offset: 200, chunkSize: 100
[Nest] 20589 - 23/03/2026, 6:25:12 DEBUG [StripeSyncService] 📝 Query SQL: SELECT "c"."id" AS "c_id", "c"."holding_id" AS "c_holding_id", "c"."stripe_id" AS "c_stripe_id", "c"."raw_data" AS "c_raw_data", "c"."sync_batch_id" AS "c_sync_batch_id", "c"."processing_status" AS "c_processing_status", "c"."integration_batch_id" AS "c_integration_batch_id", "c"."last_integrated_at" AS "c_last_integrated_at", "c"."integration_notes" AS "c_integration_notes", "c"."error_message" AS "c_error_message", "c"."created_at" AS "c_created_at", "c"."updated_at" AS "c_updated_at", "c"."connection_id" AS "c_connection_id" FROM "stripe_customers_stg" "c" WHERE "c"."holding_id" = $1 AND "c"."processing_status" IN ('to_create', 'to_update', 'error') ORDER BY "c"."created_at" ASC LIMIT 100 OFFSET 200
[Nest] 20589 - 23/03/2026, 6:25:12 DEBUG [StripeSyncService] 📝 Parámetros: {"holdingId":"5652e95e-bb99-48f5-aa1c-13c8c2638fc6"}
[Nest] 20589 - 23/03/2026, 6:25:12 LOG [StripeSyncService] 📊 Clientes encontrados en este chunk: 0
[Nest] 20589 - 23/03/2026, 6:25:12 WARN [StripeSyncService] ⚠️ No se encontraron clientes en offset 200. Deteniendo sincronización.
[Nest] 20589 - 23/03/2026, 6:25:12 LOG [StripeSyncService] Sincronización de clientes completada. Total procesado: 200
[Nest] 20589 - 23/03/2026, 6:25:12 LOG [StripeSyncService]
✅ Fase 1 completada en 64.64s
[Nest] 20589 - 23/03/2026, 6:25:12 LOG [StripeSyncService] - Creados: 0
[Nest] 20589 - 23/03/2026, 6:25:12 LOG [StripeSyncService] - Actualizados: 159
[Nest] 20589 - 23/03/2026, 6:25:12 LOG [StripeSyncService] - Omitidos: 41
[Nest] 20589 - 23/03/2026, 6:25:12 LOG [StripeSyncService] - Errores: 0
[Nest] 20589 - 23/03/2026, 6:25:12 LOG [StripeSyncService]
╔═════════════════════════════════════════════════════════════╗
[Nest] 20589 - 23/03/2026, 6:25:12 LOG [StripeSyncService] ║ FASE 2: SINCRONIZACIÓN DE SUSCRIPCIONES ║
[Nest] 20589 - 23/03/2026, 6:25:12 LOG [StripeSyncService] ╚═════════════════════════════════════════════════════════════╝
[Nest] 20589 - 23/03/2026, 6:25:12 LOG [StripeSyncService] 📊 Total a sincronizar: 0
[Nest] 20589 - 23/03/2026, 6:25:12 LOG [StripeSyncService] 🔍 Iniciando syncSubscriptions con holdingId: 5652e95e-bb99-48f5-aa1c-13c8c2638fc6, batchSize: 100, total esperado: 0
[Nest] 20589 - 23/03/2026, 6:25:12 DEBUG [StripeSyncService] 🔎 Buscando suscripciones - offset: 0, chunkSize: 100
[Nest] 20589 - 23/03/2026, 6:25:12 DEBUG [StripeSyncService] 📝 Query SQL: SELECT "s"."id" AS "s_id", "s"."holding_id" AS "s_holding_id", "s"."stripe_id" AS "s_stripe_id", "s"."raw_data" AS "s_raw_data", "s"."sync_batch_id" AS "s_sync_batch_id", "s"."processing_status" AS "s_processing_status", "s"."integration_batch_id" AS "s_integration_batch_id", "s"."last_integrated_at" AS "s_last_integrated_at", "s"."integration_notes" AS "s_integration_notes", "s"."error_message" AS "s_error_message", "s"."created_at" AS "s_created_at", "s"."updated_at" AS "s_updated_at", "s"."connection_id" AS "s_connection_id" FROM "stripe_subscriptions_stg" "s" WHERE "s"."holding_id" = $1 AND "s"."processing_status" IN ('to_create', 'to_update', 'error') AND ("s"."integration_notes" IS NULL OR "s"."integration_notes" != 'Cliente no valido') ORDER BY "s"."created_at" ASC LIMIT 100 OFFSET 0
[Nest] 20589 - 23/03/2026, 6:25:12 DEBUG [StripeSyncService] 📝 Parámetros: {"holdingId":"5652e95e-bb99-48f5-aa1c-13c8c2638fc6"}
[Nest] 20589 - 23/03/2026, 6:25:12 LOG [StripeSyncService] 📊 Suscripciones encontradas en este chunk: 0
[Nest] 20589 - 23/03/2026, 6:25:12 WARN [StripeSyncService] ⚠️ No se encontraron suscripciones en offset 0. Deteniendo sincronización.
[Nest] 20589 - 23/03/2026, 6:25:12 LOG [StripeSyncService] Sincronización de suscripciones completada. Total procesado: 0
[Nest] 20589 - 23/03/2026, 6:25:12 LOG [StripeSyncService]
✅ Fase 2 completada en 0.07s
[Nest] 20589 - 23/03/2026, 6:25:12 LOG [StripeSyncService]
╔═════════════════════════════════════════════════════════════╗
[Nest] 20589 - 23/03/2026, 6:25:12 LOG [StripeSyncService] ║ FASE 3: SINCRONIZACIÓN DE FACTURAS ║
[Nest] 20589 - 23/03/2026, 6:25:12 LOG [StripeSyncService] ╚═════════════════════════════════════════════════════════════╝
[Nest] 20589 - 23/03/2026, 6:25:12 LOG [StripeSyncService] 📊 Total a sincronizar: 253
[Nest] 20589 - 23/03/2026, 6:25:12 LOG [StripeSyncService] Procesando chunk de 100 facturas (offset: 0)...
[Nest] 20589 - 23/03/2026, 6:25:12 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1MywBAL1E3PvKzNpskqISg9y
[Nest] 20589 - 23/03/2026, 6:25:12 DEBUG [StripeSyncService] Suscripción encontrada: 6e3a1781-309e-44f3-942c-e229ca67e9a1
[Nest] 20589 - 23/03/2026, 6:25:13 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QuNYAL1E3PvKzNpj9iDFTNm
[Nest] 20589 - 23/03/2026, 6:25:13 DEBUG [StripeSyncService] Suscripción encontrada: a5e6b335-6b04-4da1-8eb1-18e6154eca1e
[Nest] 20589 - 23/03/2026, 6:25:13 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:13 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1NVPxyL1E3PvKzNpzzTrz2JC
[Nest] 20589 - 23/03/2026, 6:25:13 DEBUG [StripeSyncService] Suscripción encontrada: db32d898-1b84-48be-a269-6e83cef891c3
[Nest] 20589 - 23/03/2026, 6:25:13 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:13 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:13 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:25:13 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:13 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 200
[Nest] 20589 - 23/03/2026, 6:25:14 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QBP9zL1E3PvKzNpVz4qUyLE
[Nest] 20589 - 23/03/2026, 6:25:14 DEBUG [StripeSyncService] Suscripción encontrada: 3e9e41f4-b483-4871-a13c-48b3518d0fc7
[Nest] 20589 - 23/03/2026, 6:25:14 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QBMoUL1E3PvKzNpUSPMV4GO
[Nest] 20589 - 23/03/2026, 6:25:14 DEBUG [StripeSyncService] Suscripción encontrada: 89526a7f-9a61-4438-852d-af7f775ec554
[Nest] 20589 - 23/03/2026, 6:25:15 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1MyHYKL1E3PvKzNpO58NOPDd
[Nest] 20589 - 23/03/2026, 6:25:15 DEBUG [StripeSyncService] Suscripción encontrada: a58d7627-cef9-4e13-9ed5-6ccf78159ebf
[Nest] 20589 - 23/03/2026, 6:25:15 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QtpQYL1E3PvKzNpBDzsftcg
[Nest] 20589 - 23/03/2026, 6:25:15 DEBUG [StripeSyncService] Suscripción encontrada: 851f93bd-b25a-4254-a16d-10d2693a1307
[Nest] 20589 - 23/03/2026, 6:25:15 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:15 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:15 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:15 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:25:15 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:15 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:25:15 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1LY5X7L1E3PvKzNpZosxPMgC
[Nest] 20589 - 23/03/2026, 6:25:16 DEBUG [StripeSyncService] Suscripción encontrada: 1ec9bad4-fa92-4db6-a823-3c04164c05fe
[Nest] 20589 - 23/03/2026, 6:25:16 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_DcjpljZp2fLIil
[Nest] 20589 - 23/03/2026, 6:25:16 DEBUG [StripeSyncService] Suscripción encontrada: 0aba9430-c64f-415a-9be7-397eb1587ffa
[Nest] 20589 - 23/03/2026, 6:25:16 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QtbFNL1E3PvKzNp3wy0yEtZ
[Nest] 20589 - 23/03/2026, 6:25:16 DEBUG [StripeSyncService] Suscripción encontrada: ea65bacd-89c1-499c-aeb0-227e1efc2223
[Nest] 20589 - 23/03/2026, 6:25:17 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QiLBvL1E3PvKzNpTFPOAD7J
[Nest] 20589 - 23/03/2026, 6:25:17 DEBUG [StripeSyncService] Suscripción encontrada: 017db488-7d43-41fa-82d3-eeecea5d0428
[Nest] 20589 - 23/03/2026, 6:25:17 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:17 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QX5lEL1E3PvKzNpq85fUx1U
[Nest] 20589 - 23/03/2026, 6:25:17 DEBUG [StripeSyncService] Suscripción encontrada: 2f87dfd3-93fd-460a-ae64-b54a56eeb88a
[Nest] 20589 - 23/03/2026, 6:25:17 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:17 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:17 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:25:17 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:17 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:25:18 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QiImhL1E3PvKzNpEGbD1cFl
[Nest] 20589 - 23/03/2026, 6:25:18 DEBUG [StripeSyncService] Suscripción encontrada: f1f5d63e-13b2-451e-8633-1c115880ce2a
[Nest] 20589 - 23/03/2026, 6:25:18 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QAjuNL1E3PvKzNpJ5yqKHCf
[Nest] 20589 - 23/03/2026, 6:25:18 DEBUG [StripeSyncService] Suscripción encontrada: 30356781-280b-41a2-9610-37809e0b33c7
[Nest] 20589 - 23/03/2026, 6:25:19 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1OZNSbL1E3PvKzNpjaDUWUbI
[Nest] 20589 - 23/03/2026, 6:25:19 DEBUG [StripeSyncService] Suscripción encontrada: a83b9d94-25ee-4d9e-94bd-deabba462f11
[Nest] 20589 - 23/03/2026, 6:25:19 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QWnRvL1E3PvKzNpJfWRUMZX
[Nest] 20589 - 23/03/2026, 6:25:19 DEBUG [StripeSyncService] Suscripción encontrada: f1ddbb9a-3c4b-4e4a-862b-a14fc3d2c3e5
[Nest] 20589 - 23/03/2026, 6:25:19 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:19 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:19 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:19 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:25:19 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:19 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:25:19 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QWeaxL1E3PvKzNpshDkI0mN
[Nest] 20589 - 23/03/2026, 6:25:20 DEBUG [StripeSyncService] Suscripción encontrada: 62d585a1-9148-407f-a9c2-697ca62585d0
[Nest] 20589 - 23/03/2026, 6:25:20 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1OZB7YL1E3PvKzNp76jbCYLd
[Nest] 20589 - 23/03/2026, 6:25:20 DEBUG [StripeSyncService] Suscripción encontrada: b86284d5-0c83-4e97-9b95-ae816b3a2e28
[Nest] 20589 - 23/03/2026, 6:25:20 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1NfOYsL1E3PvKzNpCEpxVij7
[Nest] 20589 - 23/03/2026, 6:25:20 DEBUG [StripeSyncService] Suscripción encontrada: 75458dd2-f283-43a4-bcf8-2eb4b5f03bae
[Nest] 20589 - 23/03/2026, 6:25:21 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1OZBt7L1E3PvKzNp6jNRKxQg
[Nest] 20589 - 23/03/2026, 6:25:21 DEBUG [StripeSyncService] Suscripción encontrada: a1f3c1a7-356a-408a-8939-f04c1eb688b4
[Nest] 20589 - 23/03/2026, 6:25:21 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:21 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QhGCNL1E3PvKzNpJuEp9hzv
[Nest] 20589 - 23/03/2026, 6:25:21 DEBUG [StripeSyncService] Suscripción encontrada: 27e96142-db51-47a9-8d94-ace492c11c83
[Nest] 20589 - 23/03/2026, 6:25:21 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:21 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:21 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:25:21 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:21 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:25:22 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1PReLKL1E3PvKzNpJacprnIV
[Nest] 20589 - 23/03/2026, 6:25:22 DEBUG [StripeSyncService] Suscripción encontrada: 0f7e6df4-a2b9-4645-a68f-f635fdc3dfc8
[Nest] 20589 - 23/03/2026, 6:25:22 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1MlZ0oL1E3PvKzNp2U9THYmF
[Nest] 20589 - 23/03/2026, 6:25:22 DEBUG [StripeSyncService] Suscripción encontrada: 08aafd1c-ef36-4ca4-a091-9a36a00be911
[Nest] 20589 - 23/03/2026, 6:25:23 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1PGKvkL1E3PvKzNpuPGjguTY
[Nest] 20589 - 23/03/2026, 6:25:23 DEBUG [StripeSyncService] Suscripción encontrada: 0577bf69-6301-42f4-962f-1d7277d08ee1
[Nest] 20589 - 23/03/2026, 6:25:23 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1Qh9cDL1E3PvKzNpwuqgpNQ0
[Nest] 20589 - 23/03/2026, 6:25:23 DEBUG [StripeSyncService] Suscripción encontrada: 034b491c-b85e-401c-bce3-02ce51fb3427
[Nest] 20589 - 23/03/2026, 6:25:23 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:23 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:23 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:23 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:25:23 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:23 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:25:23 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QsC6uL1E3PvKzNp7CCHx0tj
[Nest] 20589 - 23/03/2026, 6:25:24 DEBUG [StripeSyncService] Suscripción encontrada: bbd3c58e-1a2b-4725-9503-e6b3644cf381
[Nest] 20589 - 23/03/2026, 6:25:24 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1PG8GSL1E3PvKzNpmfATCx7k
[Nest] 20589 - 23/03/2026, 6:25:24 DEBUG [StripeSyncService] Suscripción encontrada: 5c8c8e3d-0edb-4229-80a9-f91e0912441b
[Nest] 20589 - 23/03/2026, 6:25:25 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QKlCuL1E3PvKzNp5uN7ukft
[Nest] 20589 - 23/03/2026, 6:25:25 DEBUG [StripeSyncService] Suscripción encontrada: adf498db-5b40-4b56-9955-16ff83902bf4
[Nest] 20589 - 23/03/2026, 6:25:25 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1PnOQVL1E3PvKzNpfPXNq8Q8
[Nest] 20589 - 23/03/2026, 6:25:25 DEBUG [StripeSyncService] Suscripción encontrada: 1b85b08f-6071-48b3-bce3-009d68759997
[Nest] 20589 - 23/03/2026, 6:25:25 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:25 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:25 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:25 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:25:25 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:25 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:25:26 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1OC2G6L1E3PvKzNpAt00c1J0
[Nest] 20589 - 23/03/2026, 6:25:26 DEBUG [StripeSyncService] Suscripción encontrada: 6cf4af89-8d59-4025-8f39-3682f10208e9
[Nest] 20589 - 23/03/2026, 6:25:26 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1NpumvL1E3PvKzNpsuzC4kgG
[Nest] 20589 - 23/03/2026, 6:25:26 DEBUG [StripeSyncService] Suscripción encontrada: ee42986f-da28-4f63-8407-4dd4e4121800
[Nest] 20589 - 23/03/2026, 6:25:26 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1PRF9dL1E3PvKzNpedSe9QU5
[Nest] 20589 - 23/03/2026, 6:25:26 DEBUG [StripeSyncService] Suscripción encontrada: 8dacf329-7b4e-4fa3-9b4d-cd6f1b2d7d53
[Nest] 20589 - 23/03/2026, 6:25:27 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1NprvNL1E3PvKzNpVbQVxVwP
[Nest] 20589 - 23/03/2026, 6:25:27 DEBUG [StripeSyncService] Suscripción encontrada: f4fc1f83-f16d-4615-8e5c-f63fbc6e621f
[Nest] 20589 - 23/03/2026, 6:25:27 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QKegML1E3PvKzNpwpRdsmEk
[Nest] 20589 - 23/03/2026, 6:25:27 DEBUG [StripeSyncService] Suscripción encontrada: fb3c6d1c-ee1f-4357-8077-1f7d3e920449
[Nest] 20589 - 23/03/2026, 6:25:28 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QVOKWL1E3PvKzNpYNvr1TZJ
[Nest] 20589 - 23/03/2026, 6:25:28 DEBUG [StripeSyncService] Suscripción encontrada: 77776120-9ceb-4db8-87a3-4903c87085ee
[Nest] 20589 - 23/03/2026, 6:25:28 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1LKt11L1E3PvKzNpANGFuWtb
[Nest] 20589 - 23/03/2026, 6:25:28 DEBUG [StripeSyncService] Suscripción encontrada: ef8fa3a7-cd4a-4bcc-a256-c0e8f7def324
[Nest] 20589 - 23/03/2026, 6:25:29 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QrlVEL1E3PvKzNpjLQ2u9lX
[Nest] 20589 - 23/03/2026, 6:25:29 DEBUG [StripeSyncService] Suscripción encontrada: 0100ad12-0689-44d9-9637-0feac7bc9d5d
[Nest] 20589 - 23/03/2026, 6:25:29 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1NT8MEL1E3PvKzNpcyEu6Sc6
[Nest] 20589 - 23/03/2026, 6:25:29 DEBUG [StripeSyncService] Suscripción encontrada: eaec10ef-7289-4b0c-814d-96e46da86346
[Nest] 20589 - 23/03/2026, 6:25:29 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1PQrR2L1E3PvKzNpAmFCR7R5
[Nest] 20589 - 23/03/2026, 6:25:30 DEBUG [StripeSyncService] Suscripción encontrada: b2a3f267-a60e-48e5-a0c6-1870d30931b5
[Nest] 20589 - 23/03/2026, 6:25:30 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QrfoFL1E3PvKzNpK2Z78Xtf
[Nest] 20589 - 23/03/2026, 6:25:30 DEBUG [StripeSyncService] Suscripción encontrada: a387de43-c305-4614-9dcd-618fd9a6aabe
[Nest] 20589 - 23/03/2026, 6:25:30 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QKJpmL1E3PvKzNpocrmkdAL
[Nest] 20589 - 23/03/2026, 6:25:30 DEBUG [StripeSyncService] Suscripción encontrada: 9ff97f23-c978-4017-a041-81d869af57a5
[Nest] 20589 - 23/03/2026, 6:25:31 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1N6u5SL1E3PvKzNpU16rTfmq
[Nest] 20589 - 23/03/2026, 6:25:31 DEBUG [StripeSyncService] Suscripción encontrada: 339bbb4b-47ba-47d6-8a13-2eb5ce3e0897
[Nest] 20589 - 23/03/2026, 6:25:33 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1Q8n6iL1E3PvKzNpcu1RdDrj
[Nest] 20589 - 23/03/2026, 6:25:33 DEBUG [StripeSyncService] Suscripción encontrada: ae65002a-0196-41f9-94df-64a5abbb778d
[Nest] 20589 - 23/03/2026, 6:25:33 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1PQY2PL1E3PvKzNpnHxPO5G9
[Nest] 20589 - 23/03/2026, 6:25:33 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:33 DEBUG [StripeSyncService] Suscripción encontrada: 6d39b7ee-7010-45f9-9eb5-9d17b3a71611
[Nest] 20589 - 23/03/2026, 6:25:33 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:33 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:33 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:25:33 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:33 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:25:34 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QrLlvL1E3PvKzNpbtTEICid
[Nest] 20589 - 23/03/2026, 6:25:34 DEBUG [StripeSyncService] Suscripción encontrada: 3ed91aad-13d1-4b58-9fe7-39aafe6454a4
[Nest] 20589 - 23/03/2026, 6:25:34 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1Qr8VwL1E3PvKzNp01Gn3k1r
[Nest] 20589 - 23/03/2026, 6:25:34 DEBUG [StripeSyncService] Suscripción encontrada: 6cc30c45-af49-476c-b026-cb70fde7d0e6
[Nest] 20589 - 23/03/2026, 6:25:34 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:34 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:34 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:34 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:25:34 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:34 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:25:34 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1MCUa3L1E3PvKzNpHIYHsGvj
[Nest] 20589 - 23/03/2026, 6:25:34 DEBUG [StripeSyncService] Suscripción encontrada: 4c373f86-0292-41a3-84f3-97dd65624012
[Nest] 20589 - 23/03/2026, 6:25:35 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1LgbaoL1E3PvKzNppQIdaPEs
[Nest] 20589 - 23/03/2026, 6:25:35 DEBUG [StripeSyncService] Suscripción encontrada: b65b5f96-c4bc-414e-8ec7-2e91ede441b8
[Nest] 20589 - 23/03/2026, 6:25:35 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QfpSpL1E3PvKzNpTRKSXLTX
[Nest] 20589 - 23/03/2026, 6:25:35 DEBUG [StripeSyncService] Suscripción encontrada: 3d83dadb-c1c9-4848-807c-2764485dfaeb
[Nest] 20589 - 23/03/2026, 6:25:36 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QUUstL1E3PvKzNppwpORjHU
[Nest] 20589 - 23/03/2026, 6:25:36 DEBUG [StripeSyncService] Suscripción encontrada: 63eb7b21-39f4-42a1-87a6-7d7325c071bd
[Nest] 20589 - 23/03/2026, 6:25:36 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_Hcckccc8je5xqB
[Nest] 20589 - 23/03/2026, 6:25:36 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:36 DEBUG [StripeSyncService] Suscripción encontrada: 88ae8c65-3088-4569-86ce-b5780399b44c
[Nest] 20589 - 23/03/2026, 6:25:36 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:36 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:36 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:25:36 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:36 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:25:37 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1N6EECL1E3PvKzNpev1EqgnP
[Nest] 20589 - 23/03/2026, 6:25:37 DEBUG [StripeSyncService] Suscripción encontrada: 1f0b3a5e-154c-461f-bc69-b5b160abee0b
[Nest] 20589 - 23/03/2026, 6:25:37 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QqxHaL1E3PvKzNpLG1FG6uN
[Nest] 20589 - 23/03/2026, 6:25:37 DEBUG [StripeSyncService] Suscripción encontrada: 4b5b5828-1590-45cb-bfe2-c695285fae0a
[Nest] 20589 - 23/03/2026, 6:25:38 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1OzKfRL1E3PvKzNpR6n0TAeH
[Nest] 20589 - 23/03/2026, 6:25:38 DEBUG [StripeSyncService] Suscripción encontrada: ff95c36d-d648-4db3-9b53-1cbb80a5d5f1
[Nest] 20589 - 23/03/2026, 6:25:38 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QxUApL1E3PvKzNpH7iQxmP7
[Nest] 20589 - 23/03/2026, 6:25:38 DEBUG [StripeSyncService] Suscripción encontrada: f208818d-7031-405d-a860-5d1cda25b3c3
[Nest] 20589 - 23/03/2026, 6:25:38 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:38 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:38 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:38 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:25:38 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:38 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:25:38 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QQ6OHL1E3PvKzNpWCrGLk1v
[Nest] 20589 - 23/03/2026, 6:25:38 DEBUG [StripeSyncService] Suscripción encontrada: 2da68860-9c6d-45cb-9421-4e00a89daac4
[Nest] 20589 - 23/03/2026, 6:25:39 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_HjBmeHvLNjfhQV
[Nest] 20589 - 23/03/2026, 6:25:39 DEBUG [StripeSyncService] Suscripción encontrada: 8f399d91-76e8-4f95-b21c-ac0aeb3c4df4
[Nest] 20589 - 23/03/2026, 6:25:39 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QPxWeL1E3PvKzNpBJ2wOJFz
[Nest] 20589 - 23/03/2026, 6:25:39 DEBUG [StripeSyncService] Suscripción encontrada: 45f15683-0c3e-4e5e-b65a-986f4d8625a5
[Nest] 20589 - 23/03/2026, 6:25:40 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1NjscvL1E3PvKzNpDIpQSAWj
[Nest] 20589 - 23/03/2026, 6:25:40 DEBUG [StripeSyncService] Suscripción encontrada: 1860ca81-d39a-4c03-8e76-46e102c30831
[Nest] 20589 - 23/03/2026, 6:25:40 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QamgaL1E3PvKzNpfibkbWR3
[Nest] 20589 - 23/03/2026, 6:25:40 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:40 DEBUG [StripeSyncService] Suscripción encontrada: 7fd7b237-93c4-4ea1-91ce-dbb5755c00d2
[Nest] 20589 - 23/03/2026, 6:25:40 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:40 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:40 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:25:40 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:40 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:25:41 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1R7ObeL1E3PvKzNphpRkRdEo
[Nest] 20589 - 23/03/2026, 6:25:41 DEBUG [StripeSyncService] Suscripción encontrada: 162ae8e8-7252-4940-ba40-e9710dfe48c0
[Nest] 20589 - 23/03/2026, 6:25:41 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QxEy5L1E3PvKzNpWex2NFuv
[Nest] 20589 - 23/03/2026, 6:25:41 DEBUG [StripeSyncService] Suscripción encontrada: 758b5440-e593-4be4-ad1c-f4f705282e0b
[Nest] 20589 - 23/03/2026, 6:25:42 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1Oz24xL1E3PvKzNpd2XO4Unt
[Nest] 20589 - 23/03/2026, 6:25:42 DEBUG [StripeSyncService] Suscripción encontrada: 761532e7-7122-4546-82fc-7e551ef23a80
[Nest] 20589 - 23/03/2026, 6:25:42 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1PsPdFL1E3PvKzNpLZDPyyeY
[Nest] 20589 - 23/03/2026, 6:25:42 DEBUG [StripeSyncService] Suscripción encontrada: e71b56d8-cf29-4c15-9429-e475941d1b3b
[Nest] 20589 - 23/03/2026, 6:25:42 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:42 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:42 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:42 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:25:42 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:42 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:25:42 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1MqFb9L1E3PvKzNp7K7hakSv
[Nest] 20589 - 23/03/2026, 6:25:43 DEBUG [StripeSyncService] Suscripción encontrada: 4b4ee6eb-d7b5-4d8b-b816-df50d5fcf041
[Nest] 20589 - 23/03/2026, 6:25:43 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1NYHeEL1E3PvKzNpsNAdgTQI
[Nest] 20589 - 23/03/2026, 6:25:43 DEBUG [StripeSyncService] Suscripción encontrada: ee1d2658-8e66-4d6d-a0b1-9458191e8e7f
[Nest] 20589 - 23/03/2026, 6:25:43 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1PgvyNL1E3PvKzNpmlJxse0v
[Nest] 20589 - 23/03/2026, 6:25:43 DEBUG [StripeSyncService] Suscripción encontrada: a3cc5bb6-8d7d-4b64-a2e3-c8d1fad945b8
[Nest] 20589 - 23/03/2026, 6:25:44 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1NuhuJL1E3PvKzNpL6sKSvHn
[Nest] 20589 - 23/03/2026, 6:25:44 DEBUG [StripeSyncService] Suscripción encontrada: 0c955493-2e72-4ff6-b7c2-c1730f1420f1
[Nest] 20589 - 23/03/2026, 6:25:44 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QPSe9L1E3PvKzNpoqgHFEWn
[Nest] 20589 - 23/03/2026, 6:25:44 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:44 DEBUG [StripeSyncService] Suscripción encontrada: 88fa6ce6-b873-4b1d-8819-62064671010e
[Nest] 20589 - 23/03/2026, 6:25:44 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:44 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:44 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:25:44 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:44 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:25:45 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1O55QiL1E3PvKzNpWLNc7SuC
[Nest] 20589 - 23/03/2026, 6:25:45 DEBUG [StripeSyncService] Suscripción encontrada: c809be9b-7429-404c-8c04-2f50cf762084
[Nest] 20589 - 23/03/2026, 6:25:46 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1Qw83gL1E3PvKzNpZSbWjVUj
[Nest] 20589 - 23/03/2026, 6:25:46 DEBUG [StripeSyncService] Suscripción encontrada: ce5424f6-79ac-44c4-9021-72d6e31bf8c6
[Nest] 20589 - 23/03/2026, 6:25:46 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1R6EZ3L1E3PvKzNpfH6Rlmpx
[Nest] 20589 - 23/03/2026, 6:25:46 DEBUG [StripeSyncService] Suscripción encontrada: 683bd76a-d791-4cb4-b487-dc6b4653c90b
[Nest] 20589 - 23/03/2026, 6:25:46 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1RHSswL1E3PvKzNpSishi4tu
[Nest] 20589 - 23/03/2026, 6:25:46 DEBUG [StripeSyncService] Suscripción encontrada: 36b973ef-b29b-4295-a099-4c0f09166ed9
[Nest] 20589 - 23/03/2026, 6:25:47 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1R6DDHL1E3PvKzNpOUXPeZ72
[Nest] 20589 - 23/03/2026, 6:25:47 DEBUG [StripeSyncService] Suscripción encontrada: 00cc0fec-fbb4-40a6-87b3-066929f370cc
[Nest] 20589 - 23/03/2026, 6:25:47 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:47 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1Qw2GIL1E3PvKzNplFnZeAoz
[Nest] 20589 - 23/03/2026, 6:25:47 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:47 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:47 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:25:47 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:47 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:25:47 DEBUG [StripeSyncService] Suscripción encontrada: c51eeb13-37f0-49d2-8402-08abf18db091
[Nest] 20589 - 23/03/2026, 6:25:48 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1N0PFdL1E3PvKzNpyfK01Rfk
[Nest] 20589 - 23/03/2026, 6:25:48 DEBUG [StripeSyncService] Suscripción encontrada: a9158305-4dbf-47a4-a8a3-046f5c52535f
[Nest] 20589 - 23/03/2026, 6:25:48 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_HtSPqeNxrBZmTK
[Nest] 20589 - 23/03/2026, 6:25:48 DEBUG [StripeSyncService] Suscripción encontrada: 53ea2d00-645d-4a85-a750-700d3c343e32
[Nest] 20589 - 23/03/2026, 6:25:49 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1Q2WvcL1E3PvKzNpJQCYj548
[Nest] 20589 - 23/03/2026, 6:25:49 DEBUG [StripeSyncService] Suscripción encontrada: c713427a-af09-4c6f-bae4-d680b4dbe935
[Nest] 20589 - 23/03/2026, 6:25:49 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1RHGiIL1E3PvKzNpujf8oUmf
[Nest] 20589 - 23/03/2026, 6:25:49 DEBUG [StripeSyncService] Suscripción encontrada: 226b9064-6190-4113-861b-b42f1965edc8
[Nest] 20589 - 23/03/2026, 6:25:49 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:49 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:49 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:49 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:25:49 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:49 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:25:50 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1NMJvnL1E3PvKzNpdYEH7y4u
[Nest] 20589 - 23/03/2026, 6:25:50 DEBUG [StripeSyncService] Suscripción encontrada: 4069af25-c642-444e-b422-14ce20c33a85
[Nest] 20589 - 23/03/2026, 6:25:50 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1RH40oL1E3PvKzNp39X7ll4y
[Nest] 20589 - 23/03/2026, 6:25:50 DEBUG [StripeSyncService] Suscripción encontrada: 1c4f922c-c261-499f-850a-701d8a7be67d
[Nest] 20589 - 23/03/2026, 6:25:50 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1OFcHRL1E3PvKzNprOBuH46e
[Nest] 20589 - 23/03/2026, 6:25:50 DEBUG [StripeSyncService] Suscripción encontrada: 2eec9cd6-effb-4707-9af9-f3ac40665d51
[Nest] 20589 - 23/03/2026, 6:25:51 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1PfW9KL1E3PvKzNpTbh6bZI1
[Nest] 20589 - 23/03/2026, 6:25:51 DEBUG [StripeSyncService] Suscripción encontrada: 30acce8e-3e04-4f94-9096-279d3486049a
[Nest] 20589 - 23/03/2026, 6:25:51 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:51 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1MoaLqL1E3PvKzNpwlDo0Hii
[Nest] 20589 - 23/03/2026, 6:25:51 DEBUG [StripeSyncService] Suscripción encontrada: abf58295-eb2c-401d-985a-5075f2014698
[Nest] 20589 - 23/03/2026, 6:25:51 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:51 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:51 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:25:51 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:51 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:25:52 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1OFOoNL1E3PvKzNpxx5fkDfp
[Nest] 20589 - 23/03/2026, 6:25:52 DEBUG [StripeSyncService] Suscripción encontrada: b19aea28-6325-4ca2-babe-704f5a378040
[Nest] 20589 - 23/03/2026, 6:25:52 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1ObTRhL1E3PvKzNpu6Uzbxub
[Nest] 20589 - 23/03/2026, 6:25:52 DEBUG [StripeSyncService] Suscripción encontrada: 3476f5d9-2389-4467-aa29-b7d93231d517
[Nest] 20589 - 23/03/2026, 6:25:53 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1Omh65L1E3PvKzNpEJgFiC4Y
[Nest] 20589 - 23/03/2026, 6:25:53 DEBUG [StripeSyncService] Suscripción encontrada: 01f402a0-ec23-44dd-b073-1c7a32f4e9ed
[Nest] 20589 - 23/03/2026, 6:25:53 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1OQAdLL1E3PvKzNp8yGCnSAj
[Nest] 20589 - 23/03/2026, 6:25:53 DEBUG [StripeSyncService] Suscripción encontrada: 4cb133f1-02f9-494e-90d9-732316bf01be
[Nest] 20589 - 23/03/2026, 6:25:53 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:53 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:53 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:53 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:25:53 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:53 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:25:54 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1LkUORL1E3PvKzNpR1hvmrIz
[Nest] 20589 - 23/03/2026, 6:25:54 DEBUG [StripeSyncService] Suscripción encontrada: 41415349-1be1-43f7-b906-5e9c240eca05
[Nest] 20589 - 23/03/2026, 6:25:54 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QjiQQL1E3PvKzNpsN7Dz8FT
[Nest] 20589 - 23/03/2026, 6:25:54 DEBUG [StripeSyncService] Suscripción encontrada: 64d2e89c-bd87-4fa1-babf-032db2c638b2
[Nest] 20589 - 23/03/2026, 6:25:54 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_B3xTVKYtClHV81
[Nest] 20589 - 23/03/2026, 6:25:54 DEBUG [StripeSyncService] Suscripción encontrada: 2005bacf-9c36-4b4e-b703-6815f86d4d04
[Nest] 20589 - 23/03/2026, 6:25:55 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QNKPSL1E3PvKzNpaxQlEEUf
[Nest] 20589 - 23/03/2026, 6:25:55 DEBUG [StripeSyncService] Suscripción encontrada: 17c7ef4c-9f68-4fd4-a332-abcecb403ea4
[Nest] 20589 - 23/03/2026, 6:25:55 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:55 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1Mz3QVL1E3PvKzNpsTWQowkI
[Nest] 20589 - 23/03/2026, 6:25:55 DEBUG [StripeSyncService] Suscripción encontrada: 1bfebce9-4eaa-43ba-addc-8742329b62f8
[Nest] 20589 - 23/03/2026, 6:25:55 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:55 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:55 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":0},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:25:55 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:55 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:25:56 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_HgRQkI13SNrD2S
[Nest] 20589 - 23/03/2026, 6:25:56 DEBUG [StripeSyncService] Suscripción encontrada: ad8e9e4d-1cd5-430c-bb71-763ca458ebcf
[Nest] 20589 - 23/03/2026, 6:25:56 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QueajL1E3PvKzNprjRmdWOA
[Nest] 20589 - 23/03/2026, 6:25:56 DEBUG [StripeSyncService] Suscripción encontrada: e19a0376-494b-4e2d-aed1-a6c338c555d9
[Nest] 20589 - 23/03/2026, 6:25:57 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:57 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:57 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:57 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"current":"Chunk 1","processed":100},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:25:57 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:57 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 200
[Nest] 20589 - 23/03/2026, 6:25:58 LOG [StripeSyncService] Procesando chunk de 53 facturas (offset: 100)...
[Nest] 20589 - 23/03/2026, 6:25:58 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1RlAt8L1E3PvKzNpLB6VP5Bi
[Nest] 20589 - 23/03/2026, 6:25:58 DEBUG [StripeSyncService] Suscripción encontrada: fc76c58b-61a3-4657-b9bc-852c07b612ef
[Nest] 20589 - 23/03/2026, 6:25:58 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1NfOYsL1E3PvKzNpCEpxVij7
[Nest] 20589 - 23/03/2026, 6:25:58 DEBUG [StripeSyncService] Suscripción encontrada: 75458dd2-f283-43a4-bcf8-2eb4b5f03bae
[Nest] 20589 - 23/03/2026, 6:25:59 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1OZBt7L1E3PvKzNp6jNRKxQg
[Nest] 20589 - 23/03/2026, 6:25:59 DEBUG [StripeSyncService] Suscripción encontrada: a1f3c1a7-356a-408a-8939-f04c1eb688b4
[Nest] 20589 - 23/03/2026, 6:25:59 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QhGCNL1E3PvKzNpJuEp9hzv
[Nest] 20589 - 23/03/2026, 6:25:59 DEBUG [StripeSyncService] Suscripción encontrada: 27e96142-db51-47a9-8d94-ace492c11c83
[Nest] 20589 - 23/03/2026, 6:25:59 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:25:59 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:25:59 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:25:59 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"current":"Chunk 1","processed":100},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:25:59 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:25:59 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:26:00 DEBUG [AgentsScheduler] Checking for scheduled agents to execute...
[Nest] 20589 - 23/03/2026, 6:26:00 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1PReLKL1E3PvKzNpJacprnIV
[Nest] 20589 - 23/03/2026, 6:26:00 DEBUG [AgentsScheduler] No scheduled agents found
[Nest] 20589 - 23/03/2026, 6:26:00 DEBUG [StripeSyncService] Suscripción encontrada: 0f7e6df4-a2b9-4645-a68f-f635fdc3dfc8
[Nest] 20589 - 23/03/2026, 6:26:00 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1MONzDL1E3PvKzNpfqeuulAn
[Nest] 20589 - 23/03/2026, 6:26:00 DEBUG [StripeSyncService] Suscripción encontrada: 070d0f93-e088-4820-8169-e8a719fb8409
[Nest] 20589 - 23/03/2026, 6:26:00 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1MlZ0oL1E3PvKzNp2U9THYmF
[Nest] 20589 - 23/03/2026, 6:26:01 DEBUG [StripeSyncService] Suscripción encontrada: 08aafd1c-ef36-4ca4-a091-9a36a00be911
[Nest] 20589 - 23/03/2026, 6:26:01 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1PGKvkL1E3PvKzNpuPGjguTY
[Nest] 20589 - 23/03/2026, 6:26:01 DEBUG [StripeSyncService] Suscripción encontrada: 0577bf69-6301-42f4-962f-1d7277d08ee1
[Nest] 20589 - 23/03/2026, 6:26:01 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:26:01 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:26:01 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:26:01 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"current":"Chunk 1","processed":100},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:26:01 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:26:01 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:26:01 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1RkaGxL1E3PvKzNpm2PlybC3
[Nest] 20589 - 23/03/2026, 6:26:01 DEBUG [StripeSyncService] Suscripción encontrada: e359e506-e9b1-4b21-b5cb-eb08195ee7ff
[Nest] 20589 - 23/03/2026, 6:26:02 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1RqyGbL1E3PvKzNplCuSYziQ
[Nest] 20589 - 23/03/2026, 6:26:02 DEBUG [StripeSyncService] Suscripción encontrada: 0fd396f6-9764-484e-8762-283c5fc797c0
[Nest] 20589 - 23/03/2026, 6:26:02 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QKlCuL1E3PvKzNp5uN7ukft
[Nest] 20589 - 23/03/2026, 6:26:02 DEBUG [StripeSyncService] Suscripción encontrada: adf498db-5b40-4b56-9955-16ff83902bf4
[Nest] 20589 - 23/03/2026, 6:26:03 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1ROMy0L1E3PvKzNpcEl9cALX
[Nest] 20589 - 23/03/2026, 6:26:03 DEBUG [StripeSyncService] Suscripción encontrada: 913ff881-3d19-4388-91a1-27a7f1aa31fe
[Nest] 20589 - 23/03/2026, 6:26:03 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1NpumvL1E3PvKzNpsuzC4kgG
[Nest] 20589 - 23/03/2026, 6:26:03 DEBUG [StripeSyncService] Suscripción encontrada: ee42986f-da28-4f63-8407-4dd4e4121800
[Nest] 20589 - 23/03/2026, 6:26:03 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:26:03 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:26:03 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:26:03 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"current":"Chunk 1","processed":100},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:26:03 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:26:03 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:26:04 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1PRF9dL1E3PvKzNpedSe9QU5
[Nest] 20589 - 23/03/2026, 6:26:04 DEBUG [StripeSyncService] Suscripción encontrada: 8dacf329-7b4e-4fa3-9b4d-cd6f1b2d7d53
[Nest] 20589 - 23/03/2026, 6:26:04 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1RkNirL1E3PvKzNp0QdzpVnK
[Nest] 20589 - 23/03/2026, 6:26:04 DEBUG [StripeSyncService] Suscripción encontrada: fcdb4f11-7380-4cc1-8488-eec7c08de05c
[Nest] 20589 - 23/03/2026, 6:26:04 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QVOKWL1E3PvKzNpYNvr1TZJ
[Nest] 20589 - 23/03/2026, 6:26:05 DEBUG [StripeSyncService] Suscripción encontrada: 77776120-9ceb-4db8-87a3-4903c87085ee
[Nest] 20589 - 23/03/2026, 6:26:05 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1LKt11L1E3PvKzNpANGFuWtb
[Nest] 20589 - 23/03/2026, 6:26:05 DEBUG [StripeSyncService] Suscripción encontrada: ef8fa3a7-cd4a-4bcc-a256-c0e8f7def324
[Nest] 20589 - 23/03/2026, 6:26:05 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:26:05 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:26:05 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:26:05 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"current":"Chunk 1","processed":100},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:26:05 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:26:05 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:26:05 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QrlVEL1E3PvKzNpjLQ2u9lX
[Nest] 20589 - 23/03/2026, 6:26:06 DEBUG [StripeSyncService] Suscripción encontrada: 0100ad12-0689-44d9-9637-0feac7bc9d5d
[Nest] 20589 - 23/03/2026, 6:26:06 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1NT8MEL1E3PvKzNpcyEu6Sc6
[Nest] 20589 - 23/03/2026, 6:26:06 DEBUG [StripeSyncService] Suscripción encontrada: eaec10ef-7289-4b0c-814d-96e46da86346
[Nest] 20589 - 23/03/2026, 6:26:06 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1RNwxoL1E3PvKzNp8tNv8B0N
[Nest] 20589 - 23/03/2026, 6:26:06 DEBUG [StripeSyncService] Suscripción encontrada: 1910ccc9-9482-4013-8eb4-44f63dfcb08a
[Nest] 20589 - 23/03/2026, 6:26:07 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1PQrR2L1E3PvKzNpAmFCR7R5
[Nest] 20589 - 23/03/2026, 6:26:07 DEBUG [StripeSyncService] Suscripción encontrada: b2a3f267-a60e-48e5-a0c6-1870d30931b5
[Nest] 20589 - 23/03/2026, 6:26:07 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:26:07 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QrfoFL1E3PvKzNpK2Z78Xtf
[Nest] 20589 - 23/03/2026, 6:26:07 DEBUG [StripeSyncService] Suscripción encontrada: a387de43-c305-4614-9dcd-618fd9a6aabe
[Nest] 20589 - 23/03/2026, 6:26:07 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:26:07 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:26:07 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"current":"Chunk 1","processed":100},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:26:07 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:26:07 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:26:08 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1N6u5SL1E3PvKzNpU16rTfmq
[Nest] 20589 - 23/03/2026, 6:26:08 DEBUG [StripeSyncService] Suscripción encontrada: 339bbb4b-47ba-47d6-8a13-2eb5ce3e0897
[Nest] 20589 - 23/03/2026, 6:26:08 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1RCmj7L1E3PvKzNpxrv3vuj8
[Nest] 20589 - 23/03/2026, 6:26:08 DEBUG [StripeSyncService] Suscripción encontrada: 09a3d5a4-0bdc-44f7-8b7c-62e647a1a71f
[Nest] 20589 - 23/03/2026, 6:26:09 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1PQY2PL1E3PvKzNpnHxPO5G9
[Nest] 20589 - 23/03/2026, 6:26:09 DEBUG [StripeSyncService] Suscripción encontrada: 6d39b7ee-7010-45f9-9eb5-9d17b3a71611
[Nest] 20589 - 23/03/2026, 6:26:09 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QrLlvL1E3PvKzNpbtTEICid
[Nest] 20589 - 23/03/2026, 6:26:09 DEBUG [StripeSyncService] Suscripción encontrada: 3ed91aad-13d1-4b58-9fe7-39aafe6454a4
[Nest] 20589 - 23/03/2026, 6:26:09 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:26:09 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:26:09 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:26:09 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"current":"Chunk 1","processed":100},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:26:09 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:26:09 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:26:09 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1RusD9L1E3PvKzNpKKNF298M
[Nest] 20589 - 23/03/2026, 6:26:09 DEBUG [StripeSyncService] Suscripción encontrada: 0f1322dd-cdc0-49e0-bb11-3c22439f393a
[Nest] 20589 - 23/03/2026, 6:26:10 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1RCU7zL1E3PvKzNpiZ2BjTC8
[Nest] 20589 - 23/03/2026, 6:26:10 DEBUG [StripeSyncService] Suscripción encontrada: 46e73638-3be3-49f0-928d-c42eb8e9134b
[Nest] 20589 - 23/03/2026, 6:26:10 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1LgbaoL1E3PvKzNppQIdaPEs
[Nest] 20589 - 23/03/2026, 6:26:10 DEBUG [StripeSyncService] Suscripción encontrada: b65b5f96-c4bc-414e-8ec7-2e91ede441b8
[Nest] 20589 - 23/03/2026, 6:26:11 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1RCOe2L1E3PvKzNpcShhiB8Q
[Nest] 20589 - 23/03/2026, 6:26:11 DEBUG [StripeSyncService] Suscripción encontrada: 7c797b94-ac77-4656-90fa-e2c4df09b02a
[Nest] 20589 - 23/03/2026, 6:26:11 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:26:11 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1RCN00L1E3PvKzNpHVjlBKjg
[Nest] 20589 - 23/03/2026, 6:26:11 DEBUG [StripeSyncService] Suscripción encontrada: 2a545f73-a9c1-4bcd-bd25-00dbabde5132
[Nest] 20589 - 23/03/2026, 6:26:11 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:26:11 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:26:11 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"current":"Chunk 1","processed":100},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:26:11 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:26:11 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:26:12 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QUUstL1E3PvKzNppwpORjHU
[Nest] 20589 - 23/03/2026, 6:26:12 DEBUG [StripeSyncService] Suscripción encontrada: 63eb7b21-39f4-42a1-87a6-7d7325c071bd
[Nest] 20589 - 23/03/2026, 6:26:12 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1N6EECL1E3PvKzNpev1EqgnP
[Nest] 20589 - 23/03/2026, 6:26:12 DEBUG [StripeSyncService] Suscripción encontrada: 1f0b3a5e-154c-461f-bc69-b5b160abee0b
[Nest] 20589 - 23/03/2026, 6:26:13 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1R16GJL1E3PvKzNpZlgxxM1Z
[Nest] 20589 - 23/03/2026, 6:26:13 DEBUG [StripeSyncService] Suscripción encontrada: 66918c7b-dc27-47cb-9463-6f576866977f
[Nest] 20589 - 23/03/2026, 6:26:13 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1RjAfeL1E3PvKzNpoYQn14op
[Nest] 20589 - 23/03/2026, 6:26:13 DEBUG [StripeSyncService] Suscripción encontrada: b1613c7d-7c5a-4314-b247-23d7b8e82cb3
[Nest] 20589 - 23/03/2026, 6:26:13 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:26:13 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:26:13 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:26:13 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"current":"Chunk 1","processed":100},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:26:13 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:26:13 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:26:13 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1Nod8wL1E3PvKzNpQGdefZJB
[Nest] 20589 - 23/03/2026, 6:26:13 DEBUG [StripeSyncService] Suscripción encontrada: 1c54740e-78de-4152-9fd5-d076c4c00c59
[Nest] 20589 - 23/03/2026, 6:26:14 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1RYC5aL1E3PvKzNp4OJqXYDV
[Nest] 20589 - 23/03/2026, 6:26:14 DEBUG [StripeSyncService] Suscripción encontrada: 2ca8674f-275b-43bf-a282-9cf7d5c626d6
[Nest] 20589 - 23/03/2026, 6:26:14 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1QJILHL1E3PvKzNpaZcjHGv8
[Nest] 20589 - 23/03/2026, 6:26:14 DEBUG [StripeSyncService] Suscripción encontrada: 1db69ecf-6d4f-4120-93cc-a3bd5b402661
[Nest] 20589 - 23/03/2026, 6:26:15 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_Jp0weQFEDF9Pt6
[Nest] 20589 - 23/03/2026, 6:26:15 DEBUG [StripeSyncService] Suscripción encontrada: 842964f9-d833-4c6f-88f6-d3c273d84f27
[Nest] 20589 - 23/03/2026, 6:26:15 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1N5sf4L1E3PvKzNpnfXnkXBu
[Nest] 20589 - 23/03/2026, 6:26:15 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:26:15 DEBUG [StripeSyncService] Suscripción encontrada: 7c418451-0020-481b-a86a-eb178f09afba
[Nest] 20589 - 23/03/2026, 6:26:15 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:26:15 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:26:15 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"current":"Chunk 1","processed":100},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:26:15 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:26:15 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:26:16 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1Px973L1E3PvKzNpT3KR82cF
[Nest] 20589 - 23/03/2026, 6:26:16 DEBUG [StripeSyncService] Suscripción encontrada: 3887def2-6f79-4b5b-8876-cf9aac54838c
[Nest] 20589 - 23/03/2026, 6:26:16 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1N5rJiL1E3PvKzNpBGl2Xaeu
[Nest] 20589 - 23/03/2026, 6:26:16 DEBUG [StripeSyncService] Suscripción encontrada: 807a7e77-da92-4dc1-a251-b986e0654eb3
[Nest] 20589 - 23/03/2026, 6:26:17 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1RiyNRL1E3PvKzNp1s1otyRV
[Nest] 20589 - 23/03/2026, 6:26:17 DEBUG [StripeSyncService] Suscripción encontrada: 5506e041-9872-4496-ad41-97ab44956c0f
[Nest] 20589 - 23/03/2026, 6:26:17 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1NoFOqL1E3PvKzNpyt4zwUgo
[Nest] 20589 - 23/03/2026, 6:26:17 DEBUG [StripeSyncService] Suscripción encontrada: 7c739f82-7104-4590-b0eb-6ef7a7dd08cc
[Nest] 20589 - 23/03/2026, 6:26:17 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:26:17 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:26:17 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:26:17 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"current":"Chunk 1","processed":100},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:26:17 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:26:17 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:26:17 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1M20DmL1E3PvKzNpP9NViRGz
[Nest] 20589 - 23/03/2026, 6:26:17 DEBUG [StripeSyncService] Suscripción encontrada: 7f52d7d2-9d41-475b-804b-1b6ee3749454
[Nest] 20589 - 23/03/2026, 6:26:18 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1Q7kC0L1E3PvKzNpbp8uJhw7
[Nest] 20589 - 23/03/2026, 6:26:18 DEBUG [StripeSyncService] Suscripción encontrada: 7ee3a5de-471b-4d12-abcc-71c5c7aa427c
[Nest] 20589 - 23/03/2026, 6:26:18 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1N5WcvL1E3PvKzNpJc6wx8Ot
[Nest] 20589 - 23/03/2026, 6:26:18 DEBUG [StripeSyncService] Suscripción encontrada: 6ed3e5b5-700a-4454-9158-2b2273fad04b
[Nest] 20589 - 23/03/2026, 6:26:19 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1OWKTWL1E3PvKzNpIC9lGAkB
[Nest] 20589 - 23/03/2026, 6:26:19 DEBUG [StripeSyncService] Suscripción encontrada: fb140ae5-f48b-4a4d-9e23-8de5c05b7bf1
[Nest] 20589 - 23/03/2026, 6:26:19 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_HbrOCg1iJ0l9f7
[Nest] 20589 - 23/03/2026, 6:26:19 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:26:19 DEBUG [StripeSyncService] Suscripción encontrada: 3893225a-26c1-4701-8a93-6907a818a7d2
[Nest] 20589 - 23/03/2026, 6:26:19 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:26:19 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:26:19 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"current":"Chunk 1","processed":100},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:26:19 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:26:19 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:26:20 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1Os3UcL1E3PvKzNpsVwy8zud
[Nest] 20589 - 23/03/2026, 6:26:20 DEBUG [StripeSyncService] Suscripción encontrada: 36038ebc-89a1-4044-bce7-8e8d0ff84562
[Nest] 20589 - 23/03/2026, 6:26:20 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1N5IjQL1E3PvKzNpraUKossz
[Nest] 20589 - 23/03/2026, 6:26:20 DEBUG [StripeSyncService] Suscripción encontrada: 4075b100-c973-424c-9f25-89d8912781f4
[Nest] 20589 - 23/03/2026, 6:26:21 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1P1DBbL1E3PvKzNpSUCWvCGW
[Nest] 20589 - 23/03/2026, 6:26:21 DEBUG [StripeSyncService] Suscripción encontrada: ae44edb5-d91a-4bb2-901b-f95639547f90
[Nest] 20589 - 23/03/2026, 6:26:21 DEBUG [StripeSyncService] Buscando suscripción con external_id: sub_1RgWPEL1E3PvKzNp84WxNuaH
[Nest] 20589 - 23/03/2026, 6:26:21 DEBUG [StripeSyncService] Suscripción encontrada: b0e46b16-a404-4e5a-99f5-cd51d3224985
[Nest] 20589 - 23/03/2026, 6:26:21 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:26:21 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:26:21 DEBUG [StripeSyncService] Status: running
[Nest] 20589 - 23/03/2026, 6:26:21 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"current":"Chunk 1","processed":100},"customers":{"total":352,"processed":352},"currentPhase":"invoices","subscriptions":{"total":0,"processed":0},"overallProgress":66}
[Nest] 20589 - 23/03/2026, 6:26:21 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:26:21 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 304
[Nest] 20589 - 23/03/2026, 6:26:21 LOG [StripeSyncService] Sincronización de facturas completada. Total procesado: 153
[Nest] 20589 - 23/03/2026, 6:26:21 LOG [StripeSyncService]
✅ Fase 3 completada en 69.31s
[Nest] 20589 - 23/03/2026, 6:26:22 LOG [StripeSyncService]
╔═════════════════════════════════════════════════════════════╗
[Nest] 20589 - 23/03/2026, 6:26:22 LOG [StripeSyncService] ║ ✅ SINCRONIZACIÓN COMPLETADA EXITOSAMENTE ║
[Nest] 20589 - 23/03/2026, 6:26:22 LOG [StripeSyncService] ╚═════════════════════════════════════════════════════════════╝
[Nest] 20589 - 23/03/2026, 6:26:22 LOG [StripeSyncService] ⏱️ Tiempo total: 159.35s
[Nest] 20589 - 23/03/2026, 6:26:22 LOG [StripeSyncService] 📊 Resumen de estadísticas:
[Nest] 20589 - 23/03/2026, 6:26:22 LOG [StripeSyncService] Clientes: 0 creados, 159 actualizados, 0 errores
[Nest] 20589 - 23/03/2026, 6:26:22 LOG [StripeSyncService] Suscripciones: 0 creadas, 0 actualizadas
[Nest] 20589 - 23/03/2026, 6:26:22 LOG [StripeSyncService] Facturas: 0 creadas, 153 actualizadas
[Nest] 20589 - 23/03/2026, 6:26:22 LOG [StripeSyncService] 🏁 Finalizando job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df

[Nest] 20589 - 23/03/2026, 6:26:23 LOG [AppLoggerService] Incoming GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status
[Nest] 20589 - 23/03/2026, 6:26:23 DEBUG [StripeSyncService] 📊 getJobStatus para job 7c44b510-41e3-48e3-ab64-c3a0cb6b55df:
[Nest] 20589 - 23/03/2026, 6:26:23 DEBUG [StripeSyncService] Status: completed
[Nest] 20589 - 23/03/2026, 6:26:23 DEBUG [StripeSyncService] Progress: {"invoices":{"total":253,"processed":253},"customers":{"total":352,"processed":352},"currentPhase":"completed","subscriptions":{"total":0,"processed":0},"overallProgress":100}
[Nest] 20589 - 23/03/2026, 6:26:23 DEBUG [StripeSyncService] Progress type: object
[Nest] 20589 - 23/03/2026, 6:26:23 LOG [AppLoggerService] GET /stripe/sync/7c44b510-41e3-48e3-ab64-c3a0cb6b55df/status completed with status 200
[Nest] 20589 - 23/03/2026, 6:26:51 DEBUG [PostgreSQLDatabaseProvider] 🗑️ Conexión removida del pool
[Nest] 20589 - 23/03/2026, 6:26:51 DEBUG [PostgreSQLDatabaseProvider] [object Object]

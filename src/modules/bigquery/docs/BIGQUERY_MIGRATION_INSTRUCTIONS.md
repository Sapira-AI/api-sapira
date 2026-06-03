# Instrucciones de Migración de BigQuery

## ✅ Migración Completada

Las credenciales de BigQuery ahora se almacenan en la base de datos en la tabla `bigquery_connections` en lugar del archivo `.env`.

## Pasos para completar la migración

### 1. Obtener un user_id válido

**IMPORTANTE**: Necesitas un `user_id` de la tabla `auth.users` (Supabase Auth), **NO** de `public.users`.

Ejecuta en Supabase SQL Editor:

```sql
SELECT
    uh.user_id,
    u.email,
    uh.created_at
FROM user_holdings uh
JOIN auth.users u ON u.id = uh.user_id
WHERE uh.holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6'
ORDER BY uh.created_at ASC
LIMIT 5;
```

Si no retorna resultados, usa esta alternativa para obtener cualquier usuario de `auth.users`:

```sql
SELECT
    id as user_id,
    email,
    created_at
FROM auth.users
ORDER BY created_at ASC
LIMIT 5;
```

**Copia uno de los `user_id` retornados** - lo necesitarás en el siguiente paso.

### 2. Ejecutar el script de migración

Abre el archivo `api-sapira-ai/migrate-bigquery-simpliroute.sql` y:

1. **Reemplaza** `'REEMPLAZAR_CON_USER_ID_VALIDO'` con el `user_id` que obtuviste
2. **Ejecuta** el script completo en Supabase SQL Editor

El script:

-   Verifica que no exista ya una conexión
-   Inserta las credenciales de SimpliRoute en `bigquery_connections`
-   Verifica la inserción

### 3. Verificar la inserción

El script ya incluye esta verificación, pero puedes ejecutar manualmente:

```sql
SELECT * FROM bigquery_connections
WHERE holding_id = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6';
```

Deberías ver un registro con:

-   `name`: "BigQuery Production"
-   `project_id`: "datawarehouse-a2e2"
-   `is_active`: true

### 4. Reiniciar la API

```bash
# Detener la API actual
# Iniciar nuevamente
yarn start:dev
```

### 5. Verificar logs

Busca en los logs mensajes como:

```
✓ Cliente BigQuery inicializado para holding 5652e95e-bb99-48f5-aa1c-13c8c2638fc6, proyecto: datawarehouse-a2e2
```

Esto confirma que está usando credenciales de la BD.

### 6. Probar sincronización

Opción A - Manual (desde la API):

```bash
# Llamar al endpoint de sincronización
POST /bigquery/sync-stripe-customers
Header: x-holding-id: 5652e95e-bb99-48f5-aa1c-13c8c2638fc6
```

Opción B - Esperar al scheduler:

-   El scheduler ejecuta automáticamente según `BIGQUERY_SYNC_HOUR`
-   Solo sincronizará holdings con conexiones activas en `bigquery_connections`

### 7. Actualizar .env (DESPUÉS de verificar)

Una vez confirmado que todo funciona correctamente, puedes actualizar tu `.env`:

**ANTES:**

```bash
# Bigquery
BIGQUERY_CREDENTIALS='{"type":"service_account",...}'
BIGQUERY_SYNC_ENABLED=true
BIGQUERY_SYNC_HOUR=3
```

**DESPUÉS:**

```bash
# Bigquery - Las credenciales ahora están en la tabla bigquery_connections
# BIGQUERY_CREDENTIALS ya no es necesario (comentado o removido)
BIGQUERY_SYNC_ENABLED=true
BIGQUERY_SYNC_HOUR=3
```

## Verificación de datos duplicados (Opcional)

Si quieres verificar que no hay datos duplicados entre holdings:

```bash
# Usar el archivo de queries
api-sapira-ai/check-bigquery-duplicates.sql
```

Ejecuta las queries 1-3 para:

1. Ver registros por holding
2. Detectar duplicados
3. Ver todos los holdings con datos BigQuery

Si encuentras duplicados, ejecuta la query 4 (descomentada) para limpiar.

## Beneficios de la nueva arquitectura

✅ **Por holding**: Cada holding puede tener sus propias credenciales de BigQuery
✅ **Seguridad**: Credenciales en BD con RLS policies
✅ **Sin duplicados**: Solo sincroniza holdings configurados
✅ **Auditoría**: Campo `last_sync_at` rastrea sincronizaciones
✅ **CRUD completo**: API endpoints para gestionar conexiones

## Endpoints disponibles

```
GET    /bigquery-connections              - Listar conexiones del holding
POST   /bigquery-connections              - Crear nueva conexión
GET    /bigquery-connections/:id          - Obtener una conexión
PUT    /bigquery-connections/:id          - Actualizar conexión
DELETE /bigquery-connections/:id          - Eliminar conexión
POST   /bigquery-connections/:id/test     - Probar conexión
```

Todos requieren header `x-holding-id` (enviado automáticamente por el frontend).

## Troubleshooting

### Error: "No hay conexión de BigQuery configurada para el holding"

-   Verifica que el registro existe en `bigquery_connections`
-   Verifica que `is_active = true`
-   Verifica que el `holding_id` es correcto

### El scheduler no sincroniza

-   Verifica `BIGQUERY_SYNC_ENABLED=true` en `.env`
-   Verifica que existe conexión activa en `bigquery_connections`
-   Revisa los logs del scheduler

### Credenciales inválidas

-   Usa el endpoint `POST /bigquery-connections/:id/test` para probar
-   Verifica que el JSON de credentials es válido
-   Verifica permisos en Google Cloud Platform

# Módulo Salesforce

Módulo de integración con Salesforce para NestJS que reemplaza las edge functions de Supabase.

## Características

-   ✅ Autenticación OAuth2 con Salesforce (password grant)
-   ✅ Auto-refresh de tokens transparente
-   ✅ Ejecución de queries SOQL
-   ✅ Sincronización de oportunidades
-   ✅ Cache local de datos
-   ✅ Manejo robusto de errores
-   ✅ Documentación Swagger completa

## Endpoints

### Autenticación

**POST** `/salesforce/auth`

-   Conecta a Salesforce usando credenciales OAuth2
-   Headers: `Authorization`, `X-Holding-Id`
-   Body: `SalesforceCredentialsDto`

### Gestión de Conexión

**GET** `/salesforce/connection`

-   Obtiene la conexión activa del holding
-   Headers: `Authorization`, `X-Holding-Id`

**DELETE** `/salesforce/connection`

-   Desactiva la conexión del holding
-   Headers: `Authorization`, `X-Holding-Id`

**POST** `/salesforce/connection/refresh`

-   Renueva manualmente el token de acceso
-   Headers: `Authorization`, `X-Holding-Id`

### Queries

**POST** `/salesforce/query`

-   Ejecuta una consulta SOQL
-   Headers: `Authorization`, `X-Holding-Id`
-   Body: `{ query: string }`

### Sincronización

**POST** `/salesforce/sync`

-   Sincroniza oportunidades para el holding
-   Headers: `Authorization`, `X-Holding-Id`
-   Body: `{ dateFrom?, dateTo?, syncType? }`

**POST** `/salesforce/sync/all`

-   Sincroniza todos los holdings activos
-   Headers: `Authorization`

### Testing

**POST** `/salesforce/test`

-   Prueba conexión con SOAP API
-   Headers: `Authorization`, `X-Holding-Id`

**POST** `/salesforce/preview`

-   Preview de sincronización
-   Headers: `Authorization`, `X-Holding-Id`
-   Body: `{ syncType? }`

## Tablas de Base de Datos

El módulo utiliza las siguientes tablas de Supabase (sin modificar):

-   `salesforce_connections` - Credenciales y tokens por holding
-   `salesforce_opportunities_cache` - Cache de oportunidades

## Servicios

### SalesforceAuthService

Maneja la autenticación OAuth2 con Salesforce.

### SalesforceTokenService

Gestiona el refresh automático de tokens.

### SalesforceQueryService

Ejecuta queries SOQL con auto-refresh.

### SalesforceSyncService

Sincroniza oportunidades al cache local.

### SalesforceSoapService

Maneja pruebas de conexión usando SOAP API.

### SalesforceService

Servicio principal que orquesta todos los demás.

## Uso desde Frontend

El frontend debe enviar el header `X-Holding-Id` automáticamente (ya implementado en `NestJSApiClient`).

```typescript
// Ejemplo de uso desde el frontend
const response = await api.post('/salesforce/auth', credentials);
const connection = await api.get('/salesforce/connection');
const queryResult = await api.post('/salesforce/query', { query: 'SELECT Id FROM Account' });
```

## Migración desde Edge Functions

Este módulo reemplaza las siguientes edge functions:

-   `salesforce-auth` → `POST /salesforce/auth`
-   `salesforce-refresh-token` → `POST /salesforce/connection/refresh`
-   `salesforce-query` → `POST /salesforce/query`
-   `salesforce-daily-sync` → `POST /salesforce/sync` y `POST /salesforce/sync/all`
-   `salesforce-test-connection` → `POST /salesforce/test` (ahora usa SOAP API real)
-   `salesforce-dry-run` → `POST /salesforce/preview`

## Notas

-   Los errores de linting relacionados con formato se pueden corregir ejecutando Prettier manualmente
-   El módulo está listo para uso pero el frontend aún no ha sido actualizado
-   Las edge functions originales siguen funcionando durante la transición

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

## Métodos de Autenticación

### Opción 1: Username-Password Flow (Original)

**POST** `/salesforce/auth`

Requiere:
- Client ID
- Client Secret
- Username
- Password
- Security Token

**Ventajas:**
- ✅ Ya implementado y probado
- ✅ Incluye refresh token

**Desventajas:**
- ⚠️ Menos seguro (expone password)
- ⚠️ No recomendado por Salesforce

### Opción 2: Client Credentials Flow (Nuevo)

**POST** `/salesforce/auth/client-credentials`

Requiere:
- Client ID
- Client Secret

**Ventajas:**
- ✅ Más seguro (no expone password)
- ✅ Recomendado por Salesforce
- ✅ Más simple (menos datos)

**Limitaciones:**
- ⚠️ Requiere API v56.0+ (Winter '23)
- ⚠️ Cliente debe configurar "Client Credentials Flow" en Connected App
- ⚠️ NO retorna refresh token (re-autentica automáticamente al expirar)

### Configuración Requerida en Salesforce (Client Credentials)

Para usar Client Credentials Flow, el cliente debe seguir estos pasos completos:

---

#### PASO 1: Crear Integration User (Recomendado)

**¿Por qué?** Client Credentials Flow necesita un usuario de Salesforce que ejecute las operaciones. Es mejor crear uno específico para la integración.

1. En Salesforce, ir a **Setup** (⚙️ arriba derecha)
2. En Quick Find, buscar **"Users"**
3. Click en **"Users"** → **"New User"**
4. Completar el formulario:
   ```
   First Name: Integration
   Last Name: Sapira
   Email: integration.sapira@[dominio-cliente].com
   Username: integration.sapira@[dominio-cliente].com.production
   Alias: intsap
   Nickname: intsapira
   
   User License: Salesforce Integration (o Salesforce si no tienen Integration)
   Profile: System Administrator (o crear perfil personalizado)
   
   ✅ Active (marcar checkbox)
   ```
5. Click **"Save"**
6. **IMPORTANTE:** Salesforce enviará email de activación. El cliente debe:
   - Abrir el email
   - Click en el link de verificación
   - Establecer una contraseña (aunque no se usará para la integración)

---

#### PASO 2: Verificar Permisos del Usuario

El usuario creado debe tener estos permisos en su **Profile**:

1. Setup → **Profiles** → Buscar el perfil asignado (ej: System Administrator)
2. Verificar que tenga:
   ```
   ✅ API Enabled
   ✅ Modify All Data (o permisos específicos en objetos)
   ✅ View All Data
   ```
3. Si usan perfil personalizado, asegurar permisos en:
   - **Opportunities** (Read, Create, Edit, Delete)
   - **Accounts** (Read, Create, Edit, Delete)
   - **Contacts** (Read, Create, Edit, Delete)
   - Cualquier otro objeto que Sapira necesite

---

#### PASO 3: Habilitar Client Credentials Flow en Connected App

1. Setup → Quick Find: **"App Manager"**
2. Buscar el **Connected App** (el que tiene el Client ID que están usando)
3. Click en **▼** (dropdown) → **"Edit"**
4. Scroll hasta **"OAuth Settings"**
5. Verificar que esté marcado:
   ```
   ✅ Enable OAuth Settings
   ```
6. **NUEVO:** Marcar el checkbox:
   ```
   ✅ Enable Client Credentials Flow
   ```
7. En **"Run As"**: 
   - Click en el campo de búsqueda
   - Buscar: `Integration Sapira` (el usuario creado en Paso 1)
   - Seleccionarlo
8. Verificar que en **"Selected OAuth Scopes"** estén:
   ```
   ✅ Access and manage your data (api)
   ✅ Perform requests on your behalf at any time (refresh_token, offline_access)
   ✅ Full access (full)
   ```
9. Click **"Save"**

---

#### PASO 4: Esperar Propagación

⏱️ **Salesforce tarda 5-10 minutos** en propagar los cambios del Connected App.

Mientras tanto, el cliente puede:
- ✅ Tomar un café ☕
- ✅ Verificar que el usuario Integration Sapira esté activo
- ✅ Copiar el Client ID y Client Secret del Connected App

---

#### PASO 5: Probar la Conexión

Después de 10 minutos, probar en Swagger o con cURL:

**Swagger:**
```
POST /salesforce/auth/client-credentials

Headers:
- Authorization: Bearer [jwt-token]
- X-Holding-Id: [holding-uuid]

Body:
{
  "clientId": "3MVG9nSH73I5aFNg...",
  "clientSecret": "C8162F7068EDE3CA...",
  "loginUrl": "https://login.salesforce.com"
}
```

**Respuesta Exitosa:**
```json
{
  "success": true,
  "message": "Successfully connected to Salesforce using Client Credentials",
  "instanceUrl": "https://[cliente].my.salesforce.com",
  "authMethod": "client_credentials"
}
```

---

#### ❌ Errores Comunes y Soluciones

**Error 1: "no client credentials user enabled"**
```json
{
  "error": "invalid_grant",
  "error_description": "no client credentials user enabled"
}
```
**Solución:**
- ✅ Verificar que marcaste "Enable Client Credentials Flow" en el Connected App
- ✅ Verificar que seleccionaste un usuario en "Run As"
- ✅ Esperar 10 minutos para propagación

**Error 2: "invalid_client_id"**
```json
{
  "error": "invalid_client_id"
}
```
**Solución:**
- ✅ Verificar que el Client ID sea correcto (copiar/pegar desde Connected App)

**Error 3: "invalid_client"**
```json
{
  "error": "invalid_client"
}
```
**Solución:**
- ✅ Verificar que el Client Secret sea correcto
- ✅ Regenerar Client Secret si es necesario (Setup → App Manager → Connected App → Manage Consumer Details)

---

#### 📋 Checklist Final

Antes de probar, verificar:
- [ ] Usuario Integration Sapira creado y activo
- [ ] Usuario tiene perfil con API Enabled
- [ ] Connected App tiene "Enable Client Credentials Flow" marcado
- [ ] Connected App tiene "Run As" configurado con Integration Sapira
- [ ] Han pasado al menos 10 minutos desde guardar cambios
- [ ] Client ID y Client Secret son correctos

## Endpoints

### Autenticación

**POST** `/salesforce/auth`

-   Conecta a Salesforce usando Username-Password Flow
-   Headers: `Authorization`, `X-Holding-Id`
-   Body: `SalesforceCredentialsDto`
-   El `user_id` se extrae automáticamente del JWT para auditoría

**POST** `/salesforce/auth/client-credentials`

-   Conecta a Salesforce usando Client Credentials Flow
-   Headers: `Authorization`, `X-Holding-Id`
-   Body: `SalesforceClientCredentialsDto`
-   El `user_id` se extrae automáticamente del JWT para auditoría

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

# Módulo BigQuery

Módulo para integración con Google BigQuery, permitiendo ejecutar consultas SQL y explorar datasets y tablas.

## Características

-   ✅ Ejecución de consultas SQL personalizadas
-   ✅ Listado de datasets disponibles
-   ✅ Listado de tablas por dataset
-   ✅ Autenticación mediante Service Account
-   ✅ Manejo de errores y logging
-   ✅ Documentación Swagger completa
-   ✅ Sincronización automática de clientes Stripe desde BigQuery
-   ✅ Scheduler automático diario configurable

## Estructura del Módulo

```
bigquery/
├── dtos/
│   ├── query.dto.ts                      # DTO para consultas SQL
│   └── sync-stripe-customers.dto.ts     # DTO para sincronización
├── interfaces/
│   ├── bigquery-result.interface.ts     # Interfaces de respuesta
│   └── project-info.interface.ts        # Info del proyecto
├── bigquery.controller.ts               # Controlador con endpoints
├── bigquery.service.ts                  # Servicio con lógica de BigQuery
├── bigquery.scheduler.ts                # Scheduler automático diario
├── bigquery.module.ts                   # Definición del módulo
├── bigquery.provider.ts                 # Providers
└── README.md                            # Documentación
```

## Configuración

### 1. Variables de Entorno

Agrega las credenciales de BigQuery en el archivo `.env`:

```bash
# Credenciales de BigQuery (requerido)
BIGQUERY_CREDENTIALS='{"type":"service_account","project_id":"tu-proyecto","private_key_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"...@....iam.gserviceaccount.com","client_id":"...","auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token","auth_provider_x509_cert_url":"https://www.googleapis.com/oauth2/v1/certs","client_x509_cert_url":"...","universe_domain":"googleapis.com"}'

# Scheduler automático (opcional)
BIGQUERY_SYNC_ENABLED=true    # Habilitar/deshabilitar sincronización automática
BIGQUERY_SYNC_HOUR=3          # Hora del día para ejecutar (0-23), por defecto 3 AM
```

**Importante**: 
- El valor de `BIGQUERY_CREDENTIALS` debe ser el JSON completo de las credenciales en una sola línea.
- El scheduler se ejecuta diariamente a la hora configurada en `BIGQUERY_SYNC_HOUR`.
- Puedes deshabilitar el scheduler con `BIGQUERY_SYNC_ENABLED=false`.

### 2. Instalación de Dependencias

```bash
yarn add @google-cloud/bigquery
```

## API Endpoints

### 1. Ejecutar Consulta SQL

**POST** `/bigquery/query`

Ejecuta una consulta SQL personalizada en BigQuery.

**Request Body:**

```json
{
	"query": "SELECT * FROM `datawarehouse-a2e2.dataset.table` LIMIT 10",
	"params": {}
}
```

**Response:**

```json
{
  "rows": [...],
  "totalRows": 10,
  "schema": [...]
}
```

### 2. Listar Datasets

**GET** `/bigquery/datasets`

Obtiene la lista de todos los datasets disponibles en el proyecto.

**Response:**

```json
["dataset1", "dataset2", "dataset3"]
```

### 3. Listar Tablas de un Dataset

**GET** `/bigquery/datasets/:datasetId/tables`

Obtiene la lista de tablas disponibles en un dataset específico.

**Response:**

```json
["table1", "table2", "table3"]
```

## Ejemplos de Uso

### Consulta Simple

```typescript
POST /bigquery/query
{
  "query": "SELECT COUNT(*) as total FROM `datawarehouse-a2e2.mi_dataset.mi_tabla`"
}
```

### Consulta con Filtros

```typescript
POST /bigquery/query
{
  "query": "SELECT * FROM `datawarehouse-a2e2.ventas.transacciones` WHERE fecha >= '2024-01-01' LIMIT 100"
}
```

### Explorar Estructura

```typescript
// 1. Obtener datasets
GET /bigquery/datasets

// 2. Obtener tablas de un dataset
GET /bigquery/datasets/ventas/tables

// 3. Consultar una tabla específica
POST /bigquery/query
{
  "query": "SELECT * FROM `datawarehouse-a2e2.ventas.transacciones` LIMIT 5"
}
```

## Seguridad

-   ✅ Todos los endpoints requieren autenticación mediante `SupabaseAuthGuard`
-   ✅ Las credenciales se almacenan de forma segura en variables de entorno
-   ✅ Los errores no exponen información sensible

## Notas Importantes

1. **Costos**: BigQuery cobra por la cantidad de datos procesados. Ten cuidado con consultas que escanean grandes volúmenes de datos.

2. **Límites**: Considera agregar límites (`LIMIT`) a tus consultas para evitar resultados muy grandes.

3. **Location**: El servicio está configurado para usar la región `US`. Si tus datos están en otra región, ajusta el parámetro `location` en el servicio.

4. **Formato de Credenciales**: Las credenciales deben estar en formato JSON válido y escapadas correctamente en el archivo `.env`.

## Troubleshooting

### Error: "BigQuery no está configurado"

Verifica que la variable `BIGQUERY_CREDENTIALS` esté correctamente configurada en el archivo `.env`.

### Error al parsear credenciales

Asegúrate de que el JSON esté correctamente escapado, especialmente las nuevas líneas (`\n`) en la clave privada.

### Error de permisos

Verifica que la cuenta de servicio tenga los permisos necesarios:

-   `BigQuery Data Viewer` (para leer datos)
-   `BigQuery Job User` (para ejecutar consultas)

## Scheduler Automático

El módulo incluye un scheduler que sincroniza automáticamente los datos de clientes Stripe desde BigQuery a PostgreSQL.

### Funcionamiento

-   **Frecuencia**: Diaria, a la hora configurada (3 AM por defecto)
-   **Alcance**: Sincroniza todos los holdings registrados en `company_holdings`
-   **Tabla destino**: `stripe_customers_bigquery`
-   **Tabla origen**: `datawarehouse-a2e2.finance.sapira_stripe` en BigQuery

### Configuración

```bash
BIGQUERY_SYNC_ENABLED=true  # Habilitar/deshabilitar
BIGQUERY_SYNC_HOUR=3        # Hora de ejecución (0-23)
```

### Logs

El scheduler genera logs detallados:

```
🚀 Iniciando sincronización automática de BigQuery...
┌─────────────────────────────────────────────────────────────┐
│  Sincronizando holding: Mi Empresa                          │
│  Holding ID: 5652e95e-bb99-48f5-aa1c-13c8c2638fc6           │
└─────────────────────────────────────────────────────────────┘
✓ Holding Mi Empresa sincronizado exitosamente
   - Procesados: 150
   - Insertados: 50
   - Actualizados: 100

═══════════════════════════════════════════════════════════
  RESUMEN DE SINCRONIZACIÓN
═══════════════════════════════════════════════════════════
  Holdings procesados: 3
  Registros procesados: 450
  Registros insertados: 150
  Registros actualizados: 300
  Errores: 0
═══════════════════════════════════════════════════════════
```

### Sincronización Manual

También puedes ejecutar la sincronización manualmente:

```bash
POST /bigquery/sync-stripe-customers
{
  "holdingId": "5652e95e-bb99-48f5-aa1c-13c8c2638fc6"
}
```

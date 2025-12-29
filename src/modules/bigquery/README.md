# Módulo BigQuery

Módulo para integración con Google BigQuery, permitiendo ejecutar consultas SQL y explorar datasets y tablas.

## Características

-   ✅ Ejecución de consultas SQL personalizadas
-   ✅ Listado de datasets disponibles
-   ✅ Listado de tablas por dataset
-   ✅ Autenticación mediante Service Account
-   ✅ Manejo de errores y logging
-   ✅ Documentación Swagger completa

## Estructura del Módulo

```
bigquery/
├── dtos/
│   └── query.dto.ts              # DTO para consultas SQL
├── interfaces/
│   └── bigquery-result.interface.ts  # Interfaces de respuesta
├── bigquery.controller.ts        # Controlador con endpoints
├── bigquery.service.ts           # Servicio con lógica de BigQuery
├── bigquery.module.ts            # Definición del módulo
├── bigquery.provider.ts          # Providers (vacío por ahora)
└── README.md                     # Documentación
```

## Configuración

### 1. Variables de Entorno

Agrega las credenciales de BigQuery en el archivo `.env`:

```bash
BIGQUERY_CREDENTIALS='{"type":"service_account","project_id":"tu-proyecto","private_key_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"...@....iam.gserviceaccount.com","client_id":"...","auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token","auth_provider_x509_cert_url":"https://www.googleapis.com/oauth2/v1/certs","client_x509_cert_url":"...","universe_domain":"googleapis.com"}'
```

**Importante**: El valor debe ser el JSON completo de las credenciales en una sola línea.

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

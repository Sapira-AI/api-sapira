# Módulo Odoo

Este módulo implementa la sincronización de datos desde Odoo ERP hacia la aplicación NestJS.

## Funcionalidades

### 1. Sincronización de Facturas

-   **Endpoint**: `POST /odoo/sync-invoices`
-   **Descripción**: Sincroniza facturas y líneas de factura desde Odoo
-   **Características**:
    -   Filtros por fecha (date_from, date_to)
    -   Paginación (limit, offset)
    -   Modo estimación (estimate_only)
    -   Sincronización por lotes
    -   Sincronización automática de partners relacionados

### 2. Sincronización de Partners

-   **Endpoint**: `POST /odoo/sync-partners`
-   **Descripción**: Sincroniza partners (clientes/proveedores) desde Odoo
-   **Características**:
    -   Filtros por fecha
    -   Paginación
    -   Sincronización independiente

### 3. Emisión de facturas a Odoo

-   `auto_invoice = true` crea el draft, publica la factura y ejecuta el paso adicional de emisión electrónica según país.
-   Países con wizard `account.move.send` + `action_send_and_print`: `Colombia`, `México` y `Uruguay`.
-   `Chile` no requiere wizard adicional; se considera emitida con `action_post`.
-   Para facturas de exportación de `México`, SAPIRA intenta enviar el impuesto de venta `0%` de la compañía en vez de dejar la línea sin impuestos.

## Estructura del Módulo

```
src/modules/odoo/
├── dtos/
│   └── odoo.dto.ts              # DTOs para validación de entrada
├── interfaces/
│   └── odoo.interface.ts        # Interfaces TypeScript
├── schemas/
│   └── odoo.schema.ts           # Esquemas de MongoDB
├── helpers/
│   ├── xml-rpc-client.helper.ts # Cliente XML-RPC personalizado
│   └── filter.helper.ts         # Utilidades de filtrado
├── odoo.controller.ts           # Controlador REST
├── odoo.service.ts              # Lógica de negocio
├── odoo.provider.ts             # Provider para dependencias
├── odoo.module.ts               # Módulo NestJS
└── README.md                    # Documentación
```

## Configuración

### Conexiones de Odoo Configuradas

#### Producción (Aisapira)

-   **Connection ID**: `aisapira_prod` o `default`
-   **URL**: https://devops-simpliroute-simpli-odoo.odoo.com
-   **Base de datos**: devops-simpliroute-simpli-odoo-main-3154763
-   **Usuario**: domi@aisapira.com
-   **API Key**: f6cd0ff4a0d3954d229ac4dbbb0fc8fa4e54c477
-   **Código de suscripción**: M21090130113681

#### Desarrollo/Testing

-   **Connection ID**: `dev` o `test`
-   **URL**: http://localhost:8069
-   **Base de datos**: test_db
-   **Usuario**: admin
-   **API Key**: admin

### Información Adicional de Odoo

-   **Documentación API**: https://www.odoo.com/documentation/18.0/es_419/developer/reference/extract_api.html#invoices
-   **Cuenta Odoo**: domi@aisapira.com
-   **Clave**: SAPIsimpli2025..

## Uso

### Ejemplo de Sincronización de Facturas (Producción)

```typescript
const syncData = {
	connectionId: 'aisapira_prod', // o "default"
	limit: 100,
	offset: 0,
	date_from: '2024-01-01',
	date_to: '2024-12-31',
	estimate_only: false,
	sync_session_id: 'session_123',
};

const result = await odooService.syncInvoices(syncData);
```

### Ejemplo de Estimación

```typescript
const estimateData = {
	connectionId: 'aisapira_prod',
	estimate_only: true,
	date_from: '2024-01-01',
	date_to: '2024-12-31',
};

const estimate = await odooService.syncInvoices(estimateData);
```

### Ejemplo de Llamada HTTP

```bash
# Sincronización de facturas
curl -X POST http://localhost:3000/odoo/sync-invoices \
  -H "Content-Type: application/json" \
  -d '{
    "connectionId": "aisapira_prod",
    "limit": 50,
    "offset": 0,
    "date_from": "2024-01-01",
    "date_to": "2024-12-31",
    "estimate_only": false
  }'

# Solo estimación
curl -X POST http://localhost:3000/odoo/sync-invoices \
  -H "Content-Type: application/json" \
  -d '{
    "connectionId": "aisapira_prod",
    "estimate_only": true,
    "date_from": "2024-01-01",
    "date_to": "2024-12-31"
  }'
```

## Flujo de Sincronización

1. **Autenticación**: Se autentica con Odoo usando XML-RPC
2. **Búsqueda**: Se buscan registros según filtros
3. **Extracción**: Se obtienen datos completos de los registros
4. **Procesamiento**: Se procesan y filtran los datos
5. **Almacenamiento**: Se guardan en tablas staging
6. **Sincronización de Partners**: Se sincronizan partners relacionados automáticamente

## Características Técnicas

-   **Protocolo**: XML-RPC para comunicación con Odoo
-   **Base de Datos**: MongoDB para almacenamiento staging
-   **Validación**: Class-validator para DTOs
-   **Documentación**: Swagger/OpenAPI
-   **Autenticación**: Azure AD (configurable)
-   **Filtrado**: Exclusión automática de campos innecesarios

## TODOs

-   [ ] Implementar conexión real a base de datos para configuraciones
-   [ ] Implementar guardado real en tablas staging
-   [ ] Agregar manejo de errores más robusto
-   [ ] Implementar retry logic para fallos de conexión
-   [ ] Agregar métricas y logging detallado
-   [ ] Implementar sincronización incremental
-   [ ] Agregar tests unitarios e integración

## Notas de Implementación

Este módulo está basado en la función Deno original y ha sido adaptado para NestJS siguiendo las mejores prácticas del framework. La implementación incluye:

-   Inyección de dependencias
-   Validación de DTOs
-   Manejo de errores estructurado
-   Documentación automática con Swagger
-   Estructura modular y escalable

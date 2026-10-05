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

### 3. Resolver partner por tax ID

-   **Endpoint**: `POST /odoo-partners/resolve-partner-by-tax-id`
-   **Headers**: `Authorization: Bearer <token>`, `X-Holding-Id: <holding-id>`
-   **Body**: `{ "taxId": "76.517.784-7", "legalName": "Razón Social SpA" }`
-   **Comportamiento**:
    -   Asocia automáticamente `odoo_partner_id` cuando Odoo devuelve una coincidencia única por VAT.
    -   Si la entidad legal ya tiene `odoo_partner_id`, consulta ese partner para devolver sus datos actuales.
    -   Para VATs normales, asigna el partner sólo si Odoo devuelve una coincidencia única por VAT.
    -   Para VATs genéricos de exportación, exige `legalName` y asigna sólo si VAT más razón social devuelven una única coincidencia.
    -   Nunca crea partners; ante cero o múltiples candidatos devuelve `not_found` o `ambiguous` sin modificar datos.
    -   La edición manual de una razón social normaliza el tax ID antes de invocar este endpoint; por ello se eliminan espacios y puntos, conservando guiones, barras y letras.
    -   La respuesta incluye `partnerData` (`legal_name`, `legal_address`, `email`, `phone`) para que la interfaz solicite confirmación explícita antes de actualizar esos campos en Sapira.

### 4. Resolver partners faltantes por RUT

-   **Endpoint**: `POST /odoo-partners/resolve-missing-partners`
-   **Headers**: `Authorization: Bearer <token>`, `X-Holding-Id: <holding-id>`
-   **Body**: `{ "dryRun": true, "sampleSize": 20 }`
-   **Comportamiento**:
    -   El modo por defecto es `dryRun`: reporta entidades evaluadas, asociaciones posibles, no resueltas y ejemplos, sin escribir datos.
    -   Con `dryRun: false`, asigna o actualiza `odoo_partner_id` solo cuando Odoo devuelve una coincidencia única distinta al valor actual.
    -   Las entidades cuyo `odoo_partner_id` ya coincide se informan como `unchanged` y no se escriben.
    -   Para RUTs genéricos, requiere coincidencia adicional de razón social.

### 5. Emisión de facturas a Odoo

-   `auto_invoice = true` crea el draft, publica la factura y ejecuta el paso adicional de emisión electrónica según país.
-   Países con wizard `account.move.send` + `action_send_and_print`: `Colombia`, `México` y `Uruguay`.
-   `Chile` no requiere wizard adicional; se considera emitida con `action_post`.
-   Para facturas de exportación de `México`, SAPIRA intenta enviar el impuesto de venta `0%` de la compañía en vez de dejar la línea sin impuestos.

### 6. Diagnóstico de la pierna de vuelta (Odoo → Sapira)

`GET /odoo/webhooks/diagnostico` (requiere `x-holding-id`). El aviso de Odoo es la **única** fuente
del folio (`invoice_number`) y del avance a `Enviada`/`Pagada`: el scheduler escribe
`odoo_invoice_id` y `status = 'Emitida'`, pero nunca el folio. El reporte cruza los avisos recibidos
(`odoo_webhook_logs`), las actualizaciones aplicadas (`odoo_invoice_update_logs`) y las facturas sin
folio (`invoices`), y resuelve en `veredicto` si hay que revisar Odoo (`sin_avisos`) o la API
(`avisos_sin_efecto`). Devuelve además los `odoo_invoice_ids` del hueco, listos para un backfill.

Contrato, cómo leer el veredicto, qué **no** puede decir y los pendientes que dejó a la vista:
[`docs/cambios/diagnostico-pierna-de-vuelta-odoo.md`](../../../docs/cambios/diagnostico-pierna-de-vuelta-odoo.md).

### 7. Backfill de folios desde Odoo

`POST /odoo/webhooks/backfill` (requiere `x-holding-id`). Cuando el aviso de vuelta no llegó, recupera
los datos preguntándole a Odoo por `odoo_invoice_id`, con la misma regla de estado que el webhook
(`helpers/odoo-invoice-status.helper.ts`: solo `paid` → `Pagada`). **Corre en seco mientras no se
mande `aplicar: true`**, y omite toda factura cuyo `x_sapira_invoice_id` en Odoo falte o no coincida
con el id de Sapira.

El alcance se elige con `campos`, y el default —`['folio','estado']`— es el único seguro de correr
solo: `montos` y `fecha` obligan a reconstruir `revenue_schedule_monthly` a mano, porque
`trg_rsm_on_invoice_change` sale en seco con la conexión de la API. Con `estados` se separan las
facturas que sí se emitieron (`Emitida`) de las que nunca (`Por Emitir`, cuyo cambio de estado sí
afecta revenue).

Procedimiento, guardas y motivos de omisión:
[`docs/cambios/backfill-folios-odoo.md`](../../../docs/cambios/backfill-folios-odoo.md).

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

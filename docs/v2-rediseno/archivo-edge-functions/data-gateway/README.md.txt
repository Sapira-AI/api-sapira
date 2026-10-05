# data-gateway (Supabase Edge Function)

## Objetivo
Proveer un "gateway" seguro para que el asistente (y otras pantallas) puedan consultar datos de negocio **solo lectura**, sin permitir SQL arbitrario.

## Principios de seguridad
- Se usa el JWT del usuario (Authorization: Bearer ...) para que aplique RLS.
- Se fuerza multi-tenant con `holding_id`:
  - Se obtiene con `rpc('get_current_user_holding_id')`.
  - En cada recurso permitido, se agrega `.eq('holding_id', holdingId)`.
- No se permiten tablas arbitrarias: existe una whitelist fija de `resource`.
- Límite de filas: default 25, máximo 50.

## Request
`POST /functions/v1/data-gateway`

Body:
- `resource`: 'clients' | 'contracts' | 'invoices' | 'client_contacts' | 'revenue_schedule_monthly'
- `action`: 'list' | 'get' | 'search'
- `filters` (opcional): depende del recurso (validado server-side)
- `limit` (opcional): default 25, max 50

## Response
- `success: boolean`
- `data: any[] | any | null`
- `meta`: información de paginado/limit

## Extensión
Para agregar un recurso nuevo:
1) Añadirlo a la whitelist en `index.ts`.
2) Definir campos permitidos y filtros permitidos.
3) Implementar el bloque `switch(resource)`.

## Integración
- `rag-chat` puede invocarlo internamente (opcional) para construir contexto y widgets.
- UI puede llamarlo directamente (solo lectura) si se necesita.

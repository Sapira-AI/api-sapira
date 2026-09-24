# Autorización y holding (tenancy): la única forma

> Regla aprobada por Domi el 24-09-2026. Leon pidió que la definiéramos nosotros y quedara **una sola forma**, documentada
> también para IA (`CLAUDE.md` de api-sapira y `AGENTS.md` de front-sapira). Cierra la decisión #2 de
> [`matriz-scope-migracion-front.md`](./matriz-scope-migracion-front.md) y la decisión de arranque pendiente de la Fase 1
> de `ROADMAP-V2.md`.

## En simple

Cada usuario tiene un holding asignado y eso filtra todo lo que ve y puede hacer. Un cliente usa un solo holding; solo los
super admin (hoy Domi y Leon) cambian de holding con el selector.

En cada consulta pasan dos cosas: **¿quién eres?** (sesión de Supabase Auth, ya resuelto) y **¿sobre qué holding operas?**
Esta regla fija la segunda:

1. El front nuevo manda el holding activo en **cada** consulta, en el header `x-holding-id`, desde **una sola pieza**.
2. En la API, **un solo portero** (`HoldingScopeGuard`) revisa que el usuario pertenezca a ese holding.
3. Cada endpoint filtra por ese holding, sin excepciones.

**Por qué la API y no la base**: la API se conecta a Postgres con un rol privilegiado, así que las políticas RLS **no filtran
nada de lo que pasa por la API**. Si un endpoint no filtra, nadie lo hace. RLS y las funciones de tenant de la base
(`get_user_holding_id`, `rls_user_holding_id`, variantes `_safe/_robust/_direct`) siguen existiendo **solo para el front viejo**,
que lee Supabase directo; no se tocan mientras ese front exista.

## Cómo estaba (inventario 24-09)

| Forma | Dónde | Problema |
|---|---|---|
| Holding "seleccionado" en la base (`user_holdings.selected`) | Dashboard, `sii.service.ts` | El request no dice sobre qué holding opera; cambiar de holding en una pestaña cambia todas |
| `HoldingAccessGuard` (header) | 2 controladores de Salesforce | Si falta el header **deja pasar**; no mira `is_active` |
| `ClientsHoldingScopeGuard` | 3 controladores de Clientes (lab) | Correcto en lo esencial, pero local y acepta el holding por header, query o body |
| Solo sesión; el holding llega como un dato más, sin validar pertenencia | ~35 controladores (invoices, odoo, stripe, bigquery, agents, copilot, holdings…) | Cualquier usuario con sesión podría operar sobre otro holding (§1 de `auditoria-contratos.md`) |

## La regla

### Front nuevo (`front-sapira`)
- `lib/api/client.ts` agrega `x-holding-id` con el holding activo (`stores/holding-store.ts`) a toda llamada a `/api/*`.
  **Ningún hook lo agrega a mano** ni manda `holding_id` en query o body.
- Las queries que dependen del holding incluyen el holding en su `queryKey` y esperan a que exista (`enabled`).
- La BFF lee el header (`resolveHoldingId`) y lo reenvía a api-sapira con `holdingHeaders(holdingId)`. No agrega
  `holding_id` a queries ni bodies.

### API (`api-sapira`)
```ts
@Controller('clients')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)
export class ClientsController {
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @HoldingId() holdingId: string) {
    return this.clients.findOne(id, holdingId); // WHERE id = $1 AND holding_id = $2 → 404 si no es del holding
  }
}
```
- `HoldingScopeGuard` (`src/guards/holding-scope.guard.ts`): exige `x-holding-id` con UUID (400 si falta), valida fila
  **activa** en `user_holdings` (403 si no) y deja `request.holdingId`. Si una query o body todavía trae `holding_id`
  distinto al del header, responde 403 (protección mientras se migran los DTO viejos).
- `@HoldingId()` (`src/decorators/holding-id.decorator.ts`) entrega el holding ya validado.
- **Ningún DTO nuevo recibe `holding_id`**. El holding sale solo del guard.
- Rutas por id: buscan por `id` **y** `holding_id`; si no es del holding → **404** (no se confirma que exista). Tablas sin
  `holding_id` se acotan por su padre (ej. `contract_items` → `contracts`).
- Endpoints que no son de un holding (`/users/me`, listar o seleccionar holdings, catálogos globales) no usan el guard.
  Webhooks y crons usan su propio secreto y toman el holding **del registro** que procesan.
- **Super admin**: accede porque tiene fila en `user_holdings` (hoy 6 de 7 holdings), sin bypass especial.
- **SQL (funciones, triggers, RSM) usado desde la API**: el holding sale del registro, nunca de la sesión (`auth.uid()`,
  `rls_user_holding_id()`); sin sesión esas funciones fallan o usan el holding equivocado (U9 de la auditoría).
- **Tests obligatorios** por controlador: "sin header → 400", "holding ajeno → 403", "registro de otro holding → 404".

### Adopción: opt-in, sin romper nada
- El guard **no es global**: se aplica con `@UseGuards` en cada controlador que se migra. Lo existente sigue igual.
- **Nosotros (Domi + Claude)**: Clientes (lab) y Dashboard ahora; todo lo nuevo nace así.
- **Leon (pendiente)**: los ~35 controladores previos y los 2 de Salesforce, cuando los revise, con esta misma regla.
  `HoldingAccessGuard` queda deprecado (no usar en código nuevo).
- `user_holdings.selected` queda solo como "holding con el que abre la app" (default del selector); ningún endpoint lo usa
  para decidir qué datos devuelve.

### Próximas capas (mismo portero)
- **Roles y permisos**: funcionan en el front viejo (RLS + tablas de permisos). En la API se suman con el módulo
  Usuarios/roles como decorador `@RequirePermission('...')` resuelto por holding.
- **API pública para clientes y MCP**: API keys emitidas desde el front nuevo, amarradas a un holding y con permisos
  acotados. El mismo guard resuelve el holding desde la key en vez del header.

### Supabase: grants del Data API (aviso del 30-10-2026)
Desde el 30-10 las tablas nuevas de `public` no quedan expuestas automáticamente al Data API (supabase-js/PostgREST). No
afecta tablas existentes ni a la API (no usa el Data API). Regla: una tabla nueva **solo** recibe grants si el front viejo
la lee, en la misma migración o en `grants/`; **nunca a `anon`**. Lo que solo usa la API queda cerrado.

## Limpieza de la base (dos niveles)
- **Ahora**: la regla aplica a la API y al front nuevo. En la base solo se retira lo que el front viejo no usa
  (`inventario-rpc-front-viejo.md` tiene la lista de "no borrar"), con doble confirmación.
- **Después**: las funciones de tenant del front viejo se retiran cuando su módulo migra al front nuevo.

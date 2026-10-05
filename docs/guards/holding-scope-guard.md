# HoldingScopeGuard

Única forma de acotar un endpoint por holding. La regla completa y su porqué están en
[`docs/v2-rediseno/autorizacion-y-tenancy.md`](../v2-rediseno/autorizacion-y-tenancy.md); este documento es la
referencia técnica del guard.

Sustituye a [`HoldingAccessGuard`](./holding-access-guard.md), que queda deprecado.

## Por qué existe

La API se conecta a Postgres con un rol privilegiado: **las policies RLS no filtran nada de lo que pasa por la API**.
Si un endpoint no acota por holding, no lo acota nadie. El guard resuelve la mitad de autorización ("¿sobre qué holding
opera este request?"); filtrar cada consulta por ese holding sigue siendo responsabilidad del servicio.

## Cómo se usa

```ts
@ApiTags('Configuración SII')
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true, description: 'Holding activo (validado contra user_holdings)' })
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)
@Controller('sii')
export class SiiController {
	@Get('companies')
	companies(@HoldingId() holdingId: string) {
		return this.sii.eligibleCompanies(holdingId);
	}
}
```

`GuardsModule` es `@Global()` y exporta `HoldingScopeGuard` y `UserHoldingsService`: **no hay que importar nada** en el
módulo del controlador.

## Qué hace, en orden

| Condición | Respuesta |
|---|---|
| No hay sesión (`request.user.sub` / `.id`) | 403 `Usuario sin sesión` |
| Falta `x-holding-id`, o no es un UUID | 400 `Falta el holding activo (header x-holding-id)` |
| La query o el body traen un `holding_id` distinto al del header | 403 `El holding de la petición no coincide con el holding activo` |
| El usuario no tiene fila **activa** en `user_holdings` para ese holding | 403 `No tienes acceso a este holding` |
| Todo bien | Deja el holding en `request.holdingId` y `@HoldingId()` lo entrega |

La comparación con `holding_id` en query/body es la red de seguridad mientras el front viejo siga mandándolo. Ignora
cadenas vacías y valores que no sean string, así que `null`/`undefined` son inofensivos.

`@HoldingId()` lanza `InternalServerErrorException` si el guard no corrió: usarlo sin el guard es un error de
programación, no una condición de runtime.

## Reglas que acompañan al guard

- **Ningún DTO nuevo recibe `holding_id`.** Excepción temporal y documentada: si el front viejo ya lo manda a ese
  endpoint, se deja como campo opcional `deprecated` y el servicio lo ignora. Hoy: `GET /clients` y los 3 DTOs del
  copiloto. No se puede simplemente borrar el campo, porque `forbidNonWhitelisted: true` (`main.ts`) hace que un campo
  desconocido devuelva 400.
- **Rutas por id**: `WHERE id = $1 AND holding_id = $2` → **404** si no es del holding (no se confirma que exista).
  Tablas sin `holding_id` se acotan por su padre.
- **No** se usa `user_holdings.selected` para decidir qué datos devolver: ese campo es solo el holding con el que abre
  la app.
- **Super admin** accede porque tiene fila en `user_holdings`, sin bypass especial.

### Cuándo NO va el guard

- Endpoints que no son de un holding: `/users/me`, listar o seleccionar holdings, catálogos globales.
- Recurso por id pedido sin header (enlaces guardados que abre también la app actual, p. ej.
  `GET /client-documents/:id/download`): el holding sale **del registro** y el servicio valida pertenencia con
  `UserHoldingsService.isActiveMember` (404 si no). Es la única forma permitida de omitir el header.
- Webhooks y crons: usan su propio secreto y toman el holding del registro que procesan.

### Guard por método, no por clase

La forma normal es aplicarlo al controlador. Se aplica al método solo cuando el controlador mezcla endpoints migrados
con otros que el front viejo todavía llama sin header. Hoy hay un caso: `GET /invoices/scheduler/report`, porque
`send`, `status`, `jobs` y `debug` del mismo controlador siguen sin migrar. Va documentado en el JSDoc del método.

## Tests

Los tres casos son obligatorios por controlador: **sin header → 400, holding ajeno → 403, registro de otro holding →
404**. El patrón, en `src/modules/sii/sii.controller.spec.ts`:

```ts
const moduleRef = await Test.createTestingModule({
	controllers: [SiiController],
	providers: [
		{ provide: SiiService, useValue: sii },
		HoldingScopeGuard,
		{ provide: UserHoldingsService, useValue: { isActiveMember: jest.fn(async (_authId, holdingId) => holdingId === HOLDING) } },
	],
})
	.overrideGuard(SupabaseAuthGuard)
	.useValue({ canActivate: (context) => ((context.switchToHttp().getRequest().user = { sub: 'auth-1' }), true) })
	.compile();
```

`SupabaseAuthGuard` se sobreescribe —autenticar es problema suyo, probado aparte— y `HoldingScopeGuard` corre de
verdad contra un `UserHoldingsService` mockeado. Los specs viven en `src/` con sufijo `.spec.ts`, donde el
`moduleNameMapper` del `jest.config.js` principal resuelve el alias `@/`.

El comportamiento del guard en sí está cubierto una sola vez en `src/guards/holding-scope.guard.spec.ts`, y el 404 de
cada recurso en el spec de su servicio.

## Ojo con el `SupabaseAuthGuard` repetido

`SupabaseAuthGuard` ya está registrado como `APP_GUARD` global en `app.module.ts` y **no hace short-circuit**:
repetirlo en `@UseGuards` ejecuta un `supabase.auth.getUser()` extra por request. Hoy se repite por consistencia con
el ejemplo canónico; sacarlo es un cambio de una sola vez sobre todos los controladores migrados, pendiente en el
backlog.

# Cambio: comuna de la razón social y datos del emisor SII

> **Rama:** `leon` · 13-10-2026 · Leon + Claude
> **Repo front (par):** `front-sapira` — Compañía 360 › Facturación electrónica (Datos del emisor) y la edición de
> la razón social en Clientes. Detalle técnico del front: `front-sapira/docs/integracion-sii/README.md`.

## 👉 Leon: qué necesitamos de ti

1. **Correr la migración en QA y producción antes de desplegar este código** (ver
   [Orden de despliegue](#orden-de-despliegue)). Si se despliega primero, TypeORM pide `client_entities.commune`
   en cada lectura de la tabla y rompe Clientes.
2. Después de aplicarla en producción, `yarn schema:snapshot --target production` (solo debería cambiar el
   snapshot de `client_entities`).

## Por qué

El DTE chileno lleva el domicilio en campos separados: `DirOrigen`/`DirRecep` (calle y número, hasta 70
caracteres), `CmnaOrigen`/`CmnaRecep` (comuna, hasta 20) y `CiudadOrigen` (hasta 20). Además exige el giro del
emisor (`GiroEmis`, hasta 80) y de 1 a 4 códigos de actividad económica (`Acteco`).

- **Emisor (compañía):** giro, comuna y ciudad ya vivían en `sii_configurations`, pero solo se pedían al activar.
  `activity_codes` se creaba con `['0']`, que no es un código válido, y no había cómo cambiarlo.
- **Receptor (razón social):** la comuna iba escrita dentro de `legal_address` y no existía un campo propio.

## Migración: `client_entities.commune` — ⏳ escrita, sin aplicar

`src/databases/postgresql/migrations/1791900000000-AddClientEntityCommune.ts`.

- **Qué:** `client_entities.commune text NULL` + comentario. Sin CHECK: el largo (20) lo valida la API
  (`CreateClientEntityDto` / `UpdateClientEntityDto`), y las razones sociales de otros países no la usan.
- **Datos existentes:** quedan en `NULL`. El relleno desde `legal_address` se decide aparte.
- **Código:** columna en la entity `ClientEntity`, `commune` en ambos DTO, en la lista blanca
  `ClientDirectoryService.ENTITY_FIELDS`, en el alta (`insertClientEntity`, columna opcional) y en el detalle
  `GET /client-entities/:id`.

### Orden de despliegue

1. `yarn schema:status --target qa` → `migration:run --target qa` → verificar la columna.
2. Lo mismo en producción.
3. Recién entonces desplegar este código, y refrescar el snapshot.

## Emisor SII: api-factura es la fuente de verdad

Decisión de Leon (13-10-2026): los datos del emisor (giro, actividades económicas, dirección, comuna y ciudad) viven en
api-factura. Sapira los lee de allá (`GET /empresas/actual`, por la BFF `GET /api/factura/emisor`) y los escribe con
la provisión.

- `POST /sii/companies/:companyId/factura-integration` (`IntegrateFacturaDto`) activa la compañía o, ya activa, edita
  su emisor. Provisiona en api-factura (`POST /empresas/provision`, idempotente) con giro, comuna, ciudad, dirección
  (`address`, o la legal de la compañía si no viene) y actividades (`activity_codes` → `actividadesEconomicas`). Sin
  `environment` conserva el guardado.
- **Postgres solo guarda el vínculo:** `sii_configurations.environment` e `is_enabled`. Las columnas
  `business_activity`, `commune`, `city`, `region` y `activity_codes` quedan como **legado**: ya no se escriben ni se
  leen. Borrarlas es otra decisión (una migración con `DROP COLUMN` requiere autorización).
- Giro, comuna y ciudad son obligatorios en cada llamada: ya no se toman de Postgres.
- Validaciones (`DTE_v10.xsd`): `business_activity` 80, `commune` y `city` 20, `address` 70 (y la dirección final,
  sea propia o la legal, tampoco puede pasar de 70), `activity_codes` de 1 a 4 enteros de hasta 6 dígitos.
- El GET y el PATCH de `/sii/companies/:companyId` siguen deprecados (leen y escriben las columnas de legado).

## Errores de api-factura

`FacturaClientService.provisionEmpresa` traduce los errores de api-factura (`facturaHttpError`): los de datos (400,
409, 422) conservan su estado y mensaje; el resto (401/403 entre servicios, 5xx, sin respuesta) es 502 con el
mensaje de api-factura. Antes llegaban como 500 "Request failed with status code 403", sin decir por qué. No se
reenvía un 403 porque el front lo muestra como "No tienes permiso", y no es un permiso del usuario.

El 403 que destapó esto venía de api-factura: desde v1.0.3 su `ScopesGuard` exigía `X-Factura-Company-Id` también en
`POST /empresas/provision`, y también su interceptor global `EmpresaTenancyInterceptor`. Se corrigió en los dos con
`@SinEmpresa()` (ver `api-factura/AUTH_IMPLEMENTATION.md`).

## Tests

- `src/modules/sii/dtos/sii.dto.spec.ts`: largos y códigos de actividad económica.
- `src/modules/sii/sii.service.spec.ts`: editar provisiona y solo guarda el vínculo (conserva el ambiente); envía las
  actividades solo si vienen; activar crea el vínculo sin datos del emisor; dirección propia y tope de 70; giro,
  comuna y ciudad obligatorios.
- `src/modules/factura/factura-client.service.spec.ts`: 403 entre servicios → 502 con el mensaje; 409 y 400 conservan
  su estado; sin respuesta → 502.
- `src/modules/clients/dtos/client-directory.dto.spec.ts`: `commune` hasta 20 en crear y editar.
- `src/modules/clients/client-directory.service.spec.ts` y `client-entity-create-delete.spec.ts`: lista blanca e
  INSERT con la comuna.

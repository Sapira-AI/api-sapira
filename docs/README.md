# Documentacion y testing de `api-sapira`

Esta guia define donde documentar cambios backend y como mantener la base de pruebas unitarias con Jest.

## Mapa de esta carpeta

| Carpeta | Qué contiene | Se actualiza |
|---|---|---|
| *(raíz del repo)* [`ROADMAP-V2.md`](../ROADMAP-V2.md) | El plan v2 completo: fases, carriles, reglas — único índice del plan | Tachando avance |
| [`ROADMAP-OPERATIVO.md`](./ROADMAP-OPERATIVO.md) | Backlog de fixes y funcionalidades del producto vivo — **copia espejo** de `sapira-ai/docs/ROADMAP-OPERATIVO.md` (doble anotación: todo cambio se replica en ambos) | Con cada fix |
| [`v2-rediseno/`](./v2-rediseno/) | Todo el material del rediseño: specs, estudios, matriz de scope de migración e inventario rpc | Por spec o sesión de planificación |
| [`cambios/`](./cambios/) | Documentación funcional de cambios puntuales de backend | Con cada cambio (regla de abajo) |
| [`guards/`](./guards/) | Referencia técnica de guards transversales | Al tocar el guard |
| [`archivo/`](./archivo/) | Bitácoras de sesiones terminadas, por semestre, con índice | Solo se agrega, nunca se edita |

La documentación canónica del esquema **no está acá**: vive en `src/databases/postgresql/`
(GUIA, README del corpus, REGISTRO-DB-COMO-CODIGO).

## Cuando la documentacion es obligatoria

Actualiza documentacion cuando un cambio backend modifique alguno de estos puntos:

- comportamiento funcional;
- flujos o reglas de negocio;
- contratos de entrada o salida;
- integraciones externas;
- payloads, validaciones o errores esperados;
- configuracion relevante para operacion o soporte.

No hace falta crear documentacion nueva para cambios cosmeticos, renombres internos o refactors sin impacto funcional visible.

## Donde documentar

- Si el modulo ya tiene documentacion propia, reutiliza la ubicacion mas cercana. Ejemplo: `src/modules/stripe/docs/`.
- Si no existe una carpeta de docs del modulo o el cambio es transversal, documenta en `api-sapira-ai/docs/`.
- **Cambios de esquema de base de datos**: su documentacion canonica es `src/databases/postgresql/`. El procedimiento esta en `GUIA-CAMBIOS-DE-ESQUEMA.md` y el estado del corpus en `README.md`. No dupliques nada de eso aca.
- Para documentacion nueva dentro de `api-sapira-ai/docs/`, usa carpetas y archivos en minusculas con `_` cuando corresponda.

## Regla de tests unitarios

Toda funcionalidad nueva o modificada en backend debe incluir tests unitarios nuevos o actualizados.

### Convencion sugerida

- Ubica las specs dentro de `src/`.
- Usa sufijo `.spec.ts`.
- Idealmente deja la spec cerca del modulo afectado.
- Prioriza pruebas sobre `service`, `provider`, helpers y logica de negocio.
- En `controller`, cubre comportamiento propio y mockea dependencias externas.

## Comandos disponibles

Desde `api-sapira-ai/`:

- `yarn test`
- `yarn test:cov`
- `yarn test:e2e`

## Nota sobre Jest

El proyecto ya cuenta con `jest`, `ts-jest`, `@types/jest` y `@nestjs/testing` en `package.json`, por lo que la base para pruebas unitarias ya existe y debe reutilizarse antes de agregar nuevas dependencias.

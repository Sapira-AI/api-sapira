# Documentacion y testing de `api-sapira-ai`

Esta guia define donde documentar cambios backend y como mantener la base de pruebas unitarias con Jest.

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

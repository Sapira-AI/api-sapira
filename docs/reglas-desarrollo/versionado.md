# Versionado

La versión de `api-sapira` (`version` en `package.json`) la sube **GitHub Actions** al mezclar un PR a `qa`. Nadie la sube a mano. Es el mismo mecanismo que `front-sapira` (`front-sapira/docs/reglas-desarrollo/versionado.md`).

## Por qué

Antes, cada commit subía la versión con `yarn vcp` en su propia rama (`leon`, `domi`). Dos ramas que partían de la misma versión cambiaban la misma línea a valores distintos, así que **cada merge chocaba en `package.json`** y además quedaban números repetidos. Ninguna consulta "en línea" de la última versión lo evita: mientras dos ramas editen esa línea antes de mezclarse, Git ve un conflicto. La solución es que un solo actor asigne la versión, en un solo lugar.

## Cómo funciona

```
leon / domi ──PR──▶ qa ──(Action: vX.Y.Z+1, tag)──▶ qa ──PR──▶ main
```

1. Se trabaja y commitea en la rama propia con `git commit` normal. **No se toca `version`.**
2. Al mezclar un PR a `qa`, `.github/workflows/version.yml` corre `scripts/ci/version-bump.js` sobre la punta de `qa`, commitea `vX.Y.Z - <título del PR> (#N)` como `github-actions[bot]`, crea el tag `vX.Y.Z` y empuja ambos a `qa`.
3. `main` recibe la versión al mezclar `qa`: nunca la edita, así que tampoco choca.
4. Al traer `qa` a la rama propia, la línea de versión cambió de un solo lado: merge limpio.

Dos PRs mezclados seguidos se versionan en fila (`concurrency`), cada uno sobre el bump anterior. Si alguien empuja a `qa` mientras corre, el job rebasa y reintenta hasta 3 veces.

El commit toma el **título del PR** tal cual: un título descriptivo ("Tasa fija en modificaciones") deja el historial de `qa` como changelog; uno como "Domi" no dice nada.

## Elegir patch, minor o major

Se elige con una **etiqueta en el PR a `qa`, puesta antes de mezclarlo**:

| Etiqueta del PR | Dígito que sube | Ejemplo             | Cuándo                                                     |
| --------------- | --------------- | ------------------- | ---------------------------------------------------------- |
| _(ninguna)_     | tercero (patch) | `0.0.131 → 0.0.132` | lo normal: correcciones y mejoras                          |
| `version:minor` | segundo (minor) | `0.0.131 → 0.1.0`   | un hito o un bloque funcional relevante                    |
| `version:major` | primero (major) | `0.0.131 → 1.0.0`   | salida a producción 1.0 o un cambio incompatible de la API |

-   Al subir un dígito, los de su derecha vuelven a 0. Si el PR tiene las dos etiquetas, gana `version:major`.
-   Se pone en el PR, panel derecho **Labels**, o con `gh pr edit <N> --add-label version:minor`.
-   La etiqueta se lee **en el momento del merge**: ponerla después no cambia nada (ya se subió patch). Si se olvidó, va en el próximo PR.
-   Las etiquetas se crean una vez por repo: **Issues → Labels → New label** (`version:minor`, `version:major`), o `gh label create version:minor`.

## Qué no cubre

-   **Push directo a `qa`** (sin PR): no dispara el bump. La versión sube con el próximo PR mezclado.
-   **Release notes:** ya no se generan acá (el `--notes` de `yarn vcp`); se resuelven fuera de este repo.
-   **Protección de rama:** si `qa` exige PR para empujar, el `GITHUB_TOKEN` del workflow no puede escribir. Hay que permitirle el bypass a GitHub Actions en la regla de `qa`, o usar un token de GitHub App en el `checkout`.

## Archivos

| Archivo                                                                | Rol                                                                                                              |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [`.github/workflows/version.yml`](../../.github/workflows/version.yml) | dispara el bump al mezclar a `qa`, commitea, etiqueta y empuja                                                   |
| [`scripts/ci/version-bump.js`](../../scripts/ci/version-bump.js)       | calcula la versión y el mensaje; solo reemplaza el valor de `version`, sin reformatear el JSON                   |
| `scripts/ci/version-bump.spec.ts`                                      | specs (Jest) de etiquetas, bump, formato y salida para Actions; `jest.config.js` incluye `scripts/ci` en `roots` |

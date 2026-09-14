# api-sapira — Reglas obligatorias

Convenciones de stack, estructura de módulo y estilo: `AGENTS.md`.
Referencia completa del esquema: `src/databases/postgresql/README.md`.

## Esquema de base de datos

`api-sapira` es el **schema-as-code de todo el esquema `public`** de la base Supabase compartida.
El DDL no se escribe en `front-sapira-vite/supabase/migrations/`.

**La entity define la tabla; todo lo que TypeORM no puede declarar es un asset.**

| Objeto | Dónde vive | Cómo se aplica |
|---|---|---|
| Tablas, columnas, PK, FK, UNIQUE, CHECK, índices simples y parciales | entity `*.entity.ts` | `migration:generate` → **revisar** → `migration:run` |
| Enums y extensiones | `src/databases/postgresql/types/` | `yarn postgres:assets` |
| Índices `gin`/`ivfflat` o con orden explícito (`DESC`, `NULLS`) | `special-index/` | idem |
| Funciones, triggers, policies RLS, permisos, semillas | `functions/`, `triggers/`, `rls/`, `grants/`, `seed/` | idem |

## Reglas duras

- **Nunca actives `synchronize`, `dropSchema` ni `migrationsRun`.** TypeORM es ORM y detector de
  deriva, no gestor de esquema. Su único uso sobre el esquema es `yarn schema:log`, que solo lee.
- **Toda migración generada se revisa antes de commitear.** `migration:generate` emite `DROP` sobre
  todo lo que existe en la base y no encuentra en una entity: columnas, índices y constraints.
  **Ninguna migración con `DROP COLUMN` se aplica sin autorización explícita.** Los `DROP INDEX`
  legítimos son solo los de `special-index/`; cualquier otro significa que falta declarar el índice
  en la entity, y `entities/indices-declarados.spec.ts` lo detecta antes.
- **Nunca edites un asset `.sql` ya aplicado.** Su SHA-256 queda en `sapira_sql_asset_history` y el
  runner falla. Las correcciones van en un asset nuevo.
- **Todo comando contra la base lleva `--target` y se verifica contra la conexión real.** El target
  sale de `NODE_ENV` y es independiente de `SUPABASE_DATABASE_URL`; `connection-target.ts` aborta si
  no coinciden. Un project ref desconocido se declara en `SUPABASE_PROJECT_ENVIRONMENTS`.
- **La fuente de verdad de hoy es producción.** Ni `supabase/schema.sql`, ni las migraciones del
  front, ni los `.espejo.ts` lo son: son fotos con fecha. Verifica contra la base antes de escribir SQL.

## Eliminar una tabla, función, trigger o policy

Procedimiento completo: `src/databases/postgresql/README.md` → **Eliminar una tabla, una función u
otro objeto**. Lo que no se puede improvisar:

- **Borrar el archivo del repo NO borra nada de la base.** El runner solo aplica; nunca deduce
  borrados.
- **Borrar la entity NO borra la tabla.** TypeORM solo ve las tablas que tienen entity: la deja
  huérfana en producción, con sus datos, y `schema:log` no vuelve a mencionarla nunca.
- Por eso todo borrado son **dos acciones**: una migración con los `DROP` (para las bases que ya
  existen) **y** borrar los archivos (para que un bootstrap desde cero no los recree).
- El `DROP` va en una **migración escrita a mano** (`migration:create`), no en un asset: un asset
  describe el estado de un objeto, un borrado es una transición.
- Antes de borrar, **demuestra que está sin uso** (código de ambos repos, otras funciones, triggers,
  `cron.job`, datos) y **exporta lo que quieras conservar**.

# api-sapira — Reglas obligatorias

Convenciones de stack, estructura de módulo y estilo: `AGENTS.md`.
**Procedimiento para cambiar el esquema: `src/databases/postgresql/GUIA-CAMBIOS-DE-ESQUEMA.md`.**
Referencia del corpus y su estado: `src/databases/postgresql/README.md`.

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

## Migración o asset: la regla

**Migraciones para tablas y para eliminar o renombrar cualquier objeto. Assets para crear y
actualizar todo lo que no es tabla.**

| Cambio | Va en |
|---|---|
| Crear o alterar una tabla (columnas, PK, FK, UNIQUE, CHECK, índice btree) o activar su RLS | entity + **migración** |
| Crear o modificar una función, trigger, policy o grant | **asset**: se edita el mismo archivo |
| Crear un enum, extensión, special-index o seed | **asset** |
| Modificar un enum, extensión, special-index o seed **ya aplicado** | **migración** |
| **Eliminar o renombrar** cualquier objeto (tabla, función, trigger, policy, índice, tipo) | **migración** escrita a mano + borrar o renombrar el archivo |
| Cambiar parámetros o tipo de retorno de una función | **migración** que borra la firma vieja + asset con la nueva |
| Corregir o transformar datos existentes | **migración** |

- Una migración no crea ni redefine funciones, triggers, policies ni grants (salvo en su `down()`).
- Un asset no contiene transiciones: nada de `ALTER TABLE`, `RENAME`, ni `UPDATE`/`DELETE` de datos.
  El único `DROP` permitido es `DROP … IF EXISTS` seguido del `CREATE` del mismo objeto.
- Detalle por carpeta: GUIA → **Crear, modificar y eliminar, por carpeta**.
- **Toda tabla de `public` tiene entity viva; no hay espejos** (`database.module.spec.ts` lo exige).
  Una tabla nueva nace como entity + migración, nunca como `.espejo.ts`.
- **74 entities son generadas** (cabecera "PROMOVIDA desde espejo"). Se editan para cambiar su tabla,
  pero no se corre `scripts/espejo/generate-espejo.py` sin antes refrescar los snapshots desde prod:
  regenerar con snapshots viejos revierte el cambio en silencio.

## Reglas duras

- **Nunca actives `synchronize`, `dropSchema` ni `migrationsRun`.** TypeORM es ORM y detector de
  deriva, no gestor de esquema. Su único uso sobre el esquema es `yarn schema:log`, que solo lee.
- **Toda migración generada se revisa antes de commitear.** `migration:generate` emite `DROP` sobre
  todo lo que existe en la base y no encuentra en una entity: columnas, índices y constraints.
  **Ninguna migración con `DROP COLUMN` se aplica sin autorización explícita.** Los `DROP INDEX`
  legítimos son solo los de `special-index/`; cualquier otro significa que falta declarar el índice
  en la entity, y `entities/indices-declarados.spec.ts` lo detecta antes.
- **Un archivo por objeto, con su definición vigente.** En `functions/`, `triggers/`, `rls/` y
  `grants/` se edita el mismo archivo: el runner detecta el checksum nuevo y **re-aplica**. En
  `types/`, `special-index/` y `seed/` falla a propósito —ahí el archivo cambiaría y la base no— y el
  cambio va en una migración. **Nunca dupliques un asset como `<objeto>_<motivo>.sql`**: quién gana lo
  decide el orden alfabético, que no es el cronológico.
- **Todo comando contra la base lleva `--target` y se verifica contra la conexión real.** El target
  sale de `NODE_ENV` y es independiente de `SUPABASE_DATABASE_URL`; `connection-target.ts` aborta si
  no coinciden. Producción y QA están declaradas en `connection-target.ts`; cualquier otro project ref se declara en `SUPABASE_PROJECT_ENVIRONMENTS`.
- **Sincronizar a una base empieza y termina con `yarn schema:status --target <entorno>`** (solo
  lectura), primero en QA y después en producción, con la conexión por `DOTENV_CONFIG_PATH=.env.<qa|prod>.db`.
  Migraciones antes que assets. `--apply` va con `--only` mientras `schema:status` muestre
  `SIN CONTRAPARTE` ajenos a tu cambio. `--baseline` solo registra lo verificado idéntico a la base;
  nunca se registra a mano una fila del historial. Procedimiento: GUIA → **Sincronizar cambios a QA y producción**.
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

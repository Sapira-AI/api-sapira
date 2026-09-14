# Guía: cómo cambiar el esquema de la base

Para quien va a tocar una tabla, una función, un trigger o una policy de `public`.

`api-sapira` es el **schema-as-code de todo el esquema `public`** de la base Supabase compartida.
El DDL no se escribe en `front-sapira-vite/supabase/migrations/`.

> **La regla de corte, en una línea: si TypeORM lo puede declarar, lo declara la entity; si no, es un asset.**

Referencia del corpus y su estado: [`README.md`](./README.md).
Estado de la alineación entity↔producción: [`entities/REGISTRO-ALINEACION.md`](./entities/REGISTRO-ALINEACION.md).

---

## 🧭 ¿Dónde va mi cambio?

| Lo que quiero cambiar | Dónde se declara | Cómo se aplica |
|---|---|---|
| Tabla, columna, PK, FK, UNIQUE, CHECK | `entities/<dominio>/<tabla>.entity.ts` | `migration:generate` → **revisar** → `migration:run` |
| Índice btree sobre columnas simples, **incluidos los parciales** | la entity, con `@Index(...)` / `@Index({ where })` | idem |
| Índice `gin`, `ivfflat`, con orden explícito (`DESC`, `NULLS`) o con expresión | `special-index/` | `yarn postgres:assets` |
| Comentario de tabla o de columna | la entity, con `comment:` | `migration:generate` |
| Activar RLS en una tabla | **a mano en la migración** (TypeORM no lo modela) | `migration:run` |
| Enum de Postgres, extensión | `types/` | `yarn postgres:assets` |
| Función | `functions/` | idem |
| Trigger | `triggers/` | idem |
| Policy RLS | `rls/` | idem |
| `GRANT` por rol | `grants/` | idem |
| Datos semilla idempotentes | `seed/` | idem |
| **Borrar** cualquier cosa | migración escrita a mano **y** borrar los archivos | ver [🗑️ Borrar algo](#️-borrar-algo) |

**Cómo sé si TypeORM puede declarar un índice**: mira su definición en producción. Si dice
`USING btree (col_a, col_b)` —con o sin `WHERE`— la entity lo declara. Si dice `USING gin`,
`USING ivfflat`, o trae `DESC`, `NULLS FIRST/LAST` o una expresión como `COALESCE(...)`, es un asset.
Hay una guarda que lo verifica por vos: `entities/indices-declarados.spec.ts`.

---

## 📝 Recetas

### Agregar una columna

1. Agrega la propiedad a la entity, con su `type`, `nullable`, `default` y `comment` reales.
2. `yarn migration:generate src/databases/postgresql/migrations/AgregaXAY`
3. **Abre la migración y recórtala** hasta dejar solo tu cambio → [🔍 Cómo se revisa](#-cómo-se-revisa-una-migración-generada).
4. `yarn migration:run --target qa`, verificar, y después producción.

### Crear una tabla nueva

> 🔴 **La tabla la define su entity**, no un asset: **no existe fase `tables/`**. El resto de las
> piezas sí son assets, y el orden de fases del manifest resuelve las dependencias solo.

| # | Dónde | Qué va |
|---|---|---|
| 1 | `entities/<dominio>/<tabla>.entity.ts` | Columnas, PK, FKs, UNIQUE, CHECK e índices declarables, **con sus nombres reales de constraint** (`primaryKeyConstraintName`, `foreignKeyConstraintName`, el nombre en `@Unique`/`@Check`/`@Index`) |
| 2 | la migración | Generada, recortada, **más el `ALTER TABLE … ENABLE ROW LEVEL SECURITY` escrito a mano** |
| 3 | `types/` | Solo si la tabla usa un enum o una extensión nuevos |
| 4 | `special-index/` | Solo los índices que la entity no puede declarar |
| 5 | `functions/` | Solo si hace falta una función nueva. **Revisa primero si ya existe**: `set_updated_at()` cubre el caso típico |
| 6 | `triggers/<nombre>.sql` | `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` |
| 7 | `rls/<nombre_policy>.sql` | Una policy por archivo. Nombre de archivo = nombre de policy |
| 8 | el módulo que la use | `TypeOrmModule.forFeature([...])` |

> ⚠️ **`ENABLE ROW LEVEL SECURITY` es tuyo.** Los 389 archivos de `rls/` se obtuvieron por ingeniería
> inversa desde producción, donde RLS ya estaba activo: **ninguno lo activa**, solo declaran policies.
> En una tabla nueva eso deja RLS apagado y **las policies quedan inertes** — la tabla es legible por
> cualquiera con el `GRANT`, que en esta base es `ALL PRIVILEGES` para `anon`. Va en la migración.

**Ejemplo completo de referencia**, hecho por este camino:
`entities/facturacion/sapira-quantity-import.entity.ts` +
`migrations/1788949477104-CreateSapiraQuantityImports.ts` (53 líneas, recortadas de las 1882 que
generó TypeORM) + `special-index/sapira_quantity_imports_source_key.sql` (índice con `COALESCE`) +
`triggers/sapira_quantity_imports_set_updated_at.sql` + las 2 policies en `rls/`.

### Una función, un trigger o una policy

Un archivo `.sql` por objeto, en su carpeta, y `yarn postgres:assets --apply --only <ruta>`.

- **Funciones**: `CREATE OR REPLACE FUNCTION`. El archivo declara la función completa, no solo el cuerpo.
- **Triggers**: `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`, para que sea re-ejecutable.
- **Policies**: `DROP POLICY IF EXISTS` + `CREATE POLICY`, una por archivo, nombre de archivo = nombre de policy.
- **Enums**: guarda `DO $$ … pg_type … END $$`, porque `CREATE TYPE` no admite `IF NOT EXISTS`.

> `--only` no es opcional mientras el runner no tenga historial en esa base: un `--apply` sin filtro
> intentaría aplicar **los 885 assets**, incluidos triggers y policies que ya existen, y fallaría.

### Promover un espejo

Un `.espejo.ts` es una tabla que existe en producción y todavía no tiene entity viva. El
procedimiento está en [`README.md` → Promover un espejo](./README.md#promover-un-espejo). Lo único
que no se puede improvisar: **no promuevas uno que importe otro `.espejo.ts`** sin promover, porque
lo cargaría en runtime salteándose el propio control.

---

## 🔍 Cómo se revisa una migración generada

**Esta es la sección que importa.** `migration:generate` no genera *tu* cambio: genera **toda la
deriva pendiente entre las entities y la base**. Para `sapira_quantity_imports` produjo 1882 líneas
de las que sirvieron 45.

### El procedimiento

1. Genera la migración.
2. **Borra todo lo que no sea tu cambio.** Lo que queda tiene que caber en tu cabeza.
3. Agrega a mano lo que TypeORM no modela (RLS, y las FKs hacia tablas que solo tienen espejo).
4. Recién ahí, commitea.

### Qué vas a ver que NO es tu cambio

Hoy la deriva conocida son **104 sentencias**, todas clasificadas y ninguna de ellas un cambio real.
Si aparecen en tu migración, **bórralas**:

| Vas a ver | Cuántas | Qué es |
|---|---:|---|
| `DROP INDEX` sobre un índice que está en `special-index/` | 41 | TypeORM no puede declararlos, así que no los reconoce |
| `DROP CONSTRAINT` + `ADD CONSTRAINT` con el **mismo nombre y la misma definición** | 28 | Churn de TypeORM al alterar otra cosa de esa tabla. Netean a cero |
| `DROP DEFAULT` + `SET DEFAULT gen_random_uuid()` sobre una columna FK | 14 | Las 7 columnas FK con ese default, anomalía de producción. Netean a cero |
| `DROP INDEX` + `CREATE INDEX` con la misma definición | 10 | Idem: TypeORM recrea los índices de las columnas que altera |
| `SET DEFAULT ('now'::text)::date` | 4 | Producción guarda `CURRENT_DATE`; TypeORM normaliza el texto. Son equivalentes |
| `SET DEFAULT ARRAY[]::…` | 3 | Misma normalización |
| `processing_status` en las tablas `odoo_*_stg` | 4 | No es deriva: es la migración `AlignStagingProcessingStatusDefault`, escrita y esperando autorización |

### Lo que nunca se aplica sin autorización explícita

> 🔴 **`DROP COLUMN`.** Un `DROP INDEX` de más se recrea; un `DROP COLUMN` pierde datos. Hoy la deriva
> tiene **cero**, y esa es la línea base: si tu migración generada trae uno y no lo pusiste vos, es
> una columna que existe en producción y ninguna entity declara. Se declara, no se borra.

Lo mismo para `DROP TABLE` y para cualquier `DROP CONSTRAINT` que **no** venga con su `ADD` gemelo:
ese es un constraint real de producción que se perdería.

### Cómo verifico que quedó bien

```bash
TYPEORM_LOAD_MIRROR_ENTITIES=true yarn schema:log   # solo lee, no aplica nada
```

Debe emitir las 104 conocidas más nada. Si emite algo nuevo que no es tu cambio, la entity y la base
discreparon: el arreglo es **corregir la entity o escribir el asset**, nunca dejar que TypeORM aplique.

---

## 🗑️ Borrar algo

> 🔴 Dos trampas que cuestan caro:
> - **Borrar el archivo del repo NO borra nada de la base.** El runner solo *aplica*; nunca deduce que algo desapareció.
> - **Borrar la entity NO borra la tabla.** TypeORM solo ve las tablas que tienen entity: la deja huérfana en producción, con sus datos, y `schema:log` no vuelve a mencionarla jamás.

Por eso todo borrado son **dos acciones, y ninguna sustituye a la otra**: una **migración** con los
`DROP` (para las bases que ya existen) **y** borrar los **archivos** (para que un bootstrap desde cero
no los recree).

El `DROP` va en una migración **escrita a mano** (`migration:create`), no en un asset: un asset
describe *el estado* de un objeto, un borrado es *una transición*, y viviría en el corpus para siempre
reaplicándose en entornos donde ese objeto nunca existió.

Procedimiento completo, con los pasos de evidencia de no-uso:
[`README.md` → Eliminar una tabla, una función u otro objeto](./README.md#eliminar-una-tabla-una-función-u-otro-objeto).

---

## 🚑 Me equivoqué

El arreglo depende de **por qué mecanismo** se aplicó el cambio.

### Fue una migración ya aplicada

Escribe una **migración correctiva nueva**. No edites la migración vieja: en las bases donde ya corrió
quedó registrada en `sapira_typeorm_migrations` y no se volverá a ejecutar, así que editarla solo
cambia lo que verá un entorno nuevo — y ahí sí, divergirían.

`yarn migration:revert` existe, pero revierte **la última** migración y solo si su `down()` es honesto.
Revisa el `down()` antes de confiar en él.

### Fue un asset ya aplicado

> 🔴 **Nunca edites un asset aplicado.** Su SHA-256 quedó en `public.sapira_sql_asset_history`; si el
> contenido cambia, el runner **falla** en la siguiente corrida. Es a propósito: evita reaplicar SQL
> mutable sin que nadie lo note.

La corrección va en un **asset nuevo**. Para funciones, triggers y policies eso es natural, porque son
`CREATE OR REPLACE` / `DROP … IF EXISTS` + `CREATE`: el asset nuevo pisa al viejo.

**No borres la fila del historial.** Es el registro de lo que corrió; falsearlo deja la base y el
corpus contando historias distintas.

### Apliqué algo al entorno equivocado

Difícil, pero no imposible: `connection-target.ts` resuelve el project ref de Supabase desde la cadena
de conexión y aborta si no corresponde al `--target` declarado. Si aun así pasó, trátalo como un
incidente de producción: mide el daño con `fetch-catalog.ts` antes de tocar nada más.

---

## 🔬 TypeORM: migraciones sí, `synchronize` jamás

TypeORM acá es **ORM y detector de deriva**, nunca gestor de esquema.

| | `migration:generate` | `synchronize: true` |
|---|---|---|
| Qué hace | escribe un archivo | aplica contra la base |
| Cuándo lo ves | antes de aplicar, en el diff del PR | nunca |
| Qué borra | lo que vos dejes en el archivo | todo lo que no esté en una entity |

`synchronize` está en **`false` en todos los entornos, sin excepción**, y `database.module.spec.ts`
verifica que nadie lo ponga en `true` en ningún archivo de `src/`.

La diferencia no es teórica: `synchronize` borraría los 41 índices de `special-index/` y todo lo que
las entities no declaren, sin preguntar. Es exactamente el ruido que la sección de revisión te enseña
a borrar a mano — pero aplicado a ciegas.

---

## 🚫 Lo que nunca se hace

| Nunca | Porque |
|---|---|
| `synchronize`, `dropSchema` o `migrationsRun` en `true` | Aplica DDL sin que nadie lo revise |
| Commitear una migración generada sin recortarla | Arrastra toda la deriva pendiente del resto del esquema |
| Aplicar un `DROP COLUMN` que no pusiste vos | Es una columna real de producción que ninguna entity declara |
| Editar un asset `.sql` ya aplicado | Su checksum está registrado: el runner falla |
| Borrar una fila de `sapira_sql_asset_history` | Falsea el registro de lo que corrió |
| Escribir DDL de `public` en `front-sapira-vite/supabase/migrations/` | Ahí ya no vive el esquema |
| Dejar la URL de producción fija en tu `.env` | Cualquier comando que abra conexión —incluido levantar la app— habla con prod |
| Confiar en el `supabase/schema.sql` del front, en sus migraciones o en un `.espejo.ts` como fuente de verdad | Son fotos con fecha, y el dump del front es de otro proyecto Supabase. La fuente es la base |

---

## 🤝 Frontera con `front-sapira-vite`

| Sigue siendo del front | Ya no lo es |
|---|---|
| Edge Functions | **Todo el DDL de `public`** |
| Storage | Tablas, columnas, constraints, índices |
| `auth.*` | Funciones, triggers, policies, permisos |

Las 465 migraciones de `front-sapira-vite/supabase/migrations/` son **archivo histórico congelado**.
No son fuente de verdad: 302 de ellas tocan `CREATE OR REPLACE FUNCTION`, así que saber qué hace una
función hoy exige encontrar la última de N. Para eso está el corpus de `functions/`, capturado desde
producción.

> **El front llama 64 funciones de `public` directamente con `supabase.rpc()`**, salteándose el
> backend. Antes de borrar o cambiar la firma de una función, **busca también en `front-sapira-vite`**:
> es el canal donde más fácil se pierde el rastro, porque el nombre viaja como string.

---

## 🧪 Guardas automáticas

Corren con `yarn test`, todas offline y sin conexión a ninguna base:

| Guarda | Qué impide |
|---|---|
| `database.module.spec.ts` | `synchronize`/`dropSchema`/`migrationsRun` en `true`; que un espejo se promueva sin decisión explícita; que una tabla quede con espejo y entity a la vez; que el barrel `espejo.existing.ts` se desincronice del disco |
| `entities/indices-declarados.spec.ts` | Que un índice de producción quede sin declarar, ni en la entity ni en `special-index/`. Eran 161 |
| `assets-runner.spec.ts` | Assets de `functions/` que no declaran la función o no cierran su dollar-quote; `types/` no re-ejecutable; `special-index/` con índices que sí eran declarables; fases del manifest desalineadas de `ASSET_DIRECTORIES`; **una migración que crea una tabla sin activar RLS** |
| `typeorm-options.spec.ts` | Que el `--target` se desacople de la conexión real |
| `entities/integraciones/odoo/odoo-stg-processing-status.spec.ts` | Que un default declarado no sea uno de los valores que admite su propio CHECK |

Si una de estas se pone roja, no la ajustes para que pase: describe una invariante que costó
encontrar. Cada una nació de un problema real que está documentado en su propio comentario.

---

## 🗺️ Deudas conocidas

Están en [`README.md` → Deudas conocidas del corpus](./README.md#deudas-conocidas-del-corpus), con su
evidencia. Las que más te pueden afectar al tocar algo:

- **26 assets apuntan a objetos que ya no existen en producción** (7 funciones, 13 triggers, 6 policies).
- **7 tablas sin RLS con `GRANT` completo a `anon`** — sin ninguna capa de contención.
- **4 tablas con RLS activo y cero policies**: hoy solo las ve el service role.
- **Anomalías de FK heredadas de producción** (FKs duplicadas con `ON DELETE` divergente,
  `SET NULL` sobre columna `NOT NULL`). Se replican tal cual; corregirlas es decisión de negocio.
- **2 vistas sin asset ni entity**: `invoices_with_net_amounts`, `invoice_items_consolidated`.

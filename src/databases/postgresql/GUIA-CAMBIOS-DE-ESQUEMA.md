# Guía: cómo cambiar el esquema de la base

Para quien va a tocar una tabla, una función, un trigger o una policy de `public`.

`api-sapira` es el **schema-as-code de todo el esquema `public`** de la base Supabase compartida.
El DDL no se escribe en `front-sapira-vite/supabase/migrations/`.

> **La regla de corte, en una línea: si TypeORM lo puede declarar, lo declara la entity; si no, es un asset.**
>
> **Y cómo llega a la base: migraciones para tablas y para eliminar o renombrar cualquier objeto;
> assets para crear y actualizar todo lo que no es tabla.** Detalle en
> [🔁 Crear, modificar y eliminar, por carpeta](#-crear-modificar-y-eliminar-por-carpeta).

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

## 🔁 Crear, modificar y eliminar, por carpeta

### ¿Para qué está `migrations/` si ya están las carpetas de assets y las entities?

Hay **dos mecanismos que cambian la base**, y cada carpeta usa uno o los dos:

| Mecanismo | Qué es | Qué sabe hacer | Qué no sabe hacer |
|---|---|---|---|
| **Asset** (`yarn postgres:assets`) | Un archivo que describe **cómo debe quedar** un objeto. Se puede correr N veces | Crear un objeto, y en `functions/`, `triggers/`, `rls/` y `grants/` también redefinirlo (editando el mismo archivo) | **Borrar** (quitar el archivo no toca la base), renombrar, ni cambiar algo en `types/`, `special-index/` o `seed/` |
| **Migración** (`migrations/`, `yarn migration:run`) | Un **paso** que lleva la base de un estado a otro. Corre **una sola vez** por base y queda en `sapira_typeorm_migrations` | Todo lo anterior: crear y alterar tablas, borrar cualquier objeto, renombrar, transformar datos | Nada: por eso se revisa a mano antes de aplicarla |

**Una entity no cambia la base.** Es la *declaración* de la tabla: la usa el ORM en runtime y la usa
`migration:generate` para escribir la migración. `synchronize` está apagado, así que editar una entity
sin su migración deja la base igual. Por eso las tablas usan las dos carpetas: la entity dice cómo es,
la migración la lleva a cada base.

Y `migrations/` recibe también los cambios de las carpetas de assets que un asset no puede expresar:
**todo borrado**, todo **renombre**, y todo cambio en `types/`, `special-index/` y `seed/`.

### La tabla

`apply` = `yarn postgres:assets --apply --only <ruta>`. `migración` = `migration:create` (escrita a mano)
o `migration:generate` (desde entities) → revisar → `migration:run`. Cómo llevar cualquiera de los dos a
QA y producción: [🔄 Sincronizar cambios](#-sincronizar-cambios-a-qa-y-producción).

| Carpeta | Crear | Modificar | Eliminar |
|---|---|---|---|
| **`entities/`**<br>tablas, columnas, PK, FK, UNIQUE, CHECK, índices btree | Entity nueva → `migration:generate` → **recortar** lo que no sea tuyo → agregar a mano `ENABLE ROW LEVEL SECURITY` → `migration:run` | Editar la entity → `migration:generate` → recortar → `migration:run`. Si la migración ya se aplicó en alguna base, **no se edita**: se escribe otra | **Columna**: quitarla de la entity → `migration:generate` (emite el `DROP COLUMN`; requiere autorización explícita). **Tabla**: `migration:create` con `DROP TABLE` sin `CASCADE` + borrar la entity, su export en `espejo.existing.ts` y su entrada en `module-map.json`. `generate` no sirve: sin entity la tabla sale de su radar |
| **`types/`**<br>enums, extensiones | Archivo nuevo: enum con guarda `DO $$ … pg_type … $$`, extensión con `IF NOT EXISTS` → `apply` | **No se edita el archivo** una vez aplicado: la guarda hace que no cambie nada y el runner lo rechaza (`BLOQUEADO`). Migración: `ALTER TYPE … ADD VALUE IF NOT EXISTS` / `RENAME VALUE`, `ALTER EXTENSION … UPDATE` | Migración con `DROP TYPE` / `DROP EXTENSION` (sin `CASCADE`: primero las columnas que lo usan) + borrar el archivo |
| **`functions/`** | Archivo `<nombre>.sql` con la función **completa** (`CREATE OR REPLACE FUNCTION`, no solo el cuerpo) → `apply` | **Editar el mismo archivo** → `apply` lo re-ejecuta (`REAPLICAR`). ⚠️ Si cambian los **parámetros** o el **tipo de retorno**, `CREATE OR REPLACE` crea otra sobrecarga o falla: migración con `DROP FUNCTION` de la firma vieja, después `apply` | Migración con `DROP FUNCTION IF EXISTS <nombre>(<tipos>)` + borrar el archivo. Antes buscar el nombre en `front-sapira-vite`: 64 funciones se llaman por `supabase.rpc()` |
| **`triggers/`** | Archivo `<nombre_trigger>.sql`: `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` → `apply`. La función que invoca tiene que existir antes | **Editar el mismo archivo** → `apply`. ⚠️ **Renombrar**: el trigger viejo queda vivo; migración con su `DROP TRIGGER` + archivo nuevo + borrar el viejo | Migración con `DROP TRIGGER IF EXISTS <nombre> ON <tabla>` + borrar el archivo |
| **`rls/`**<br>policies | Archivo `<nombre_policy>.sql`: `DROP POLICY IF EXISTS` + `CREATE POLICY` → `apply`. Activar RLS en la tabla **no** va acá: va en la migración de la tabla | **Editar el mismo archivo** → `apply`. ⚠️ **Renombrar**: igual que triggers, la policy vieja queda activa (y las policies permisivas se suman) | Migración con `DROP POLICY IF EXISTS <nombre> ON <tabla>` + borrar el archivo. No dejes la tabla deny-all sin querer |
| **`special-index/`**<br>gin, ivfflat, orden explícito, expresiones | Archivo `<nombre_indice>.sql` con `CREATE INDEX IF NOT EXISTS` → `apply`. Solo índices que la entity **no** puede declarar (hay guarda) | **No se edita el archivo**: `IF NOT EXISTS` no redefine un índice existente (`BLOQUEADO`). Índice con **nombre nuevo** en archivo nuevo + migración que borra el viejo + borrar el archivo viejo | Migración con `DROP INDEX IF EXISTS <nombre>` + borrar el archivo |
| **`grants/`**<br>permisos por rol | Archivo `NNN-<descripcion>.sql` con `GRANT` / `REVOKE` → `apply` | **Editar el mismo archivo** → `apply` (`REAPLICAR`). ⚠️ **Borrar una línea `GRANT` no revoca nada**: reemplazala por el `REVOKE` explícito | Igual: **quitar un permiso es un `REVOKE`** en el asset, no borrar el archivo. Borrar el archivo solo evita que un entorno nuevo lo reciba. `schema:status` no puede verificar esta carpeta: aplicá con `--only` a conciencia |
| **`seed/`**<br>datos semilla | Archivo `NNN-<descripcion>.sql` con `INSERT … ON CONFLICT DO NOTHING` → `apply`. Si otro asset lo necesita (p. ej. una función que filtra por el permiso), el seed va primero | **No se edita un seed aplicado**: `ON CONFLICT DO NOTHING` no actualiza filas (`BLOQUEADO`). **Agregar** filas: seed nuevo con número siguiente. **Corregir** filas existentes: migración con `UPDATE` | Migración con `DELETE` (revisando FKs, p. ej. `role_permissions` → `permissions`) + borrar el archivo |
| **`migrations/`** | `migration:generate` (cambios de entities) o `migration:create` (borrados, renombres, datos, lo que TypeORM no modela) → revisar → `migration:run` | **Nunca** se edita una migración ya aplicada en alguna base: no vuelve a correr ahí y las bases divergen. Se escribe una migración correctiva nueva | No se borran. `migration:revert` deshace **solo la última**, y solo si su `down()` es honesto; si no es reversible, `down()` lanza un error |

### Las tres reglas que explican toda la tabla

1. **Borrar un archivo no borra nada en la base.** El runner solo aplica lo que encuentra. Por eso todo
   borrado son dos acciones: la migración (para las bases que existen) **y** borrar el archivo (para que
   un entorno nuevo no lo recree). Ver [🗑️ Borrar algo](#️-borrar-algo).
2. **Editar el archivo sirve solo donde re-ejecutarlo lo redefine**: `functions/`, `triggers/`, `rls/` y
   `grants/`. En `types/`, `special-index/` y `seed/` el SQL es "crear si no existe", así que editar el
   archivo no cambiaría la base, y el runner lo rechaza para que el historial no mienta.
3. **Renombrar es crear uno nuevo y eliminar el viejo.** El runner ve un archivo nuevo y no sabe que el
   anterior existía con otro nombre: el objeto viejo queda vivo hasta que una migración lo borra.

---

## 📝 Recetas

### Agregar una columna

1. Agrega la propiedad a la entity, con su `type`, `nullable`, `default` y `comment` reales.
2. `yarn migration:generate src/databases/postgresql/migrations/AgregaXAY`
3. **Abre la migración y recórtala** hasta dejar solo tu cambio → [🔍 Cómo se revisa](#-cómo-se-revisa-una-migración-generada).
4. Llevarla a QA y después a producción → [🔄 Sincronizar cambios](#-sincronizar-cambios-a-qa-y-producción).

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

> ⚠️ **`ENABLE ROW LEVEL SECURITY` es tuyo.** Los 387 archivos de `rls/` se obtuvieron por ingeniería
> inversa desde producción, donde RLS ya estaba activo: **ninguno lo activa**, solo declaran policies.
> En una tabla nueva eso deja RLS apagado y **las policies quedan inertes** — la tabla es legible por
> cualquiera con el `GRANT`, que en esta base es `ALL PRIVILEGES` para `anon`. Va en la migración.

**Ejemplo completo de referencia**, hecho por este camino:
`entities/facturacion/sapira-quantity-import.entity.ts` +
`migrations/1788949477104-CreateSapiraQuantityImports.ts` (53 líneas, recortadas de las 1882 que
generó TypeORM) + `special-index/sapira_quantity_imports_source_key.sql` (índice con `COALESCE`) +
`triggers/sapira_quantity_imports_set_updated_at.sql` + las 2 policies en `rls/`.

### Agregar un permiso al catálogo

Los permisos viven en `public.permissions` y se asignan por rol en `public.role_permissions`.

1. **Seed idempotente** en `seed/<NNN>-<descripcion>.sql`:
   - `INSERT INTO public.permissions (code, description) … ON CONFLICT (code) DO NOTHING`
   - Backfill de `role_permissions` para holdings existentes (roles que ya tenían permisos equivalentes).
2. **Constante en los fronts** si el permiso controla un ítem de navegación (`lib/sapira-permissions.ts` en Next, `permission` en `navigation-config.ts` en Vite).
3. **Holdings nuevos**: edita `functions/create_default_roles_for_holding.sql` **en su lugar**, agregando el permiso a los roles que correspondan. El runner re-aplica un asset de `functions/` que cambió (ver abajo): no crees un archivo nuevo.
4. Aplica **primero el seed y después la función**, con `--only`, en QA y después en producción — ver [🔄 Sincronizar cambios](#-sincronizar-cambios-a-qa-y-producción).

Ejemplo de referencia: `seed/002-view-documentacion-permission.sql` + el cambio de `VIEW_DOCUMENTACION` dentro de `functions/create_default_roles_for_holding.sql`.

> ⚠️ El seed no basta por sí solo: la función filtra `WHERE code IN (…)` contra `permissions`, así que si el permiso no existe todavía, no asigna nada. Aplica el seed **antes** que la función.

### Una función, un trigger o una policy

Un archivo `.sql` por objeto, en su carpeta, y `yarn postgres:assets --apply --only <ruta>`.

- **Funciones**: `CREATE OR REPLACE FUNCTION`. El archivo declara la función completa, no solo el cuerpo.
- **Triggers**: `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`, para que sea re-ejecutable.
- **Policies**: `DROP POLICY IF EXISTS` + `CREATE POLICY`, una por archivo, nombre de archivo = nombre de policy.
- **Enums**: guarda `DO $$ … pg_type … END $$`, porque `CREATE TYPE` no admite `IF NOT EXISTS`.

Para llevarlo a una base, ver [🔄 Sincronizar cambios a QA y producción](#-sincronizar-cambios-a-qa-y-producción).

### Promover un espejo

**Al 2026-09-16 no quedan espejos: toda tabla de `public` tiene entity viva.** Si reaparece un
`.espejo.ts` (una tabla creada en producción por fuera de entity + migración), `database.module.spec.ts`
falla y el procedimiento está en [`README.md` → Promover un espejo](./README.md#promover-un-espejo).
Lo único que no se puede improvisar: **no promuevas uno que importe otro `.espejo.ts`** sin promover,
porque lo cargaría en runtime salteándose el propio control.

> ⚠️ **74 entities son generadas** (cabecera "PROMOVIDA desde espejo"). Editarlas para cambiar su
> tabla está bien; lo que no se hace es correr `generate-espejo.py` antes de refrescar los snapshots
> desde prod, porque revierte el cambio en silencio.

---

## 🔄 Sincronizar cambios a QA y producción

Para quien tiene un cambio de esquema en el repo y tiene que llevarlo a las bases. **El procedimiento
es el mismo en los dos entornos, y siempre va primero QA.** Si en QA algo falla, en prod también.

### 1. Las conexiones (una vez por máquina)

Los scripts de esquema no leen el `.env` de la app: cada entorno tiene su **archivo de conexión** de
una línea en `api-sapira/`, que se carga con `DOTENV_CONFIG_PATH`.

| Archivo | Contenido | Quién lo tiene |
|---|---|---|
| `.env.qa.db` | `SUPABASE_DATABASE_URL=postgresql://postgres.obvwrhvyuimjoejqmuqf:<password>@aws-1-sa-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true` | quien sincronice cambios |
| `.env.prod.db` | `SUPABASE_DATABASE_URL=postgresql://postgres.hklompkypzqtglprfobu:<password>@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true` | solo quien aplique en producción |

- **Las URLs se le piden a Leon.** No están en el repo ni en ningún gestor compartido.
- **Nunca se commitean.** `.gitignore` excluye todo `.env*` salvo `.env.example`; verificalo con `git check-ignore -v .env.prod.db`.
- **Se corre desde `api-sapira/`.** `DOTENV_CONFIG_PATH` es relativo al directorio actual, y si el
  archivo no existe dotenv no avisa: el script falla después con `SUPABASE_DATABASE_URL o DATABASE_URL debe estar configurada`.

| Por qué un archivo de conexión y no un `.env.qa` | |
|---|---|
| Duplicar el `.env` copia ~40 secretos (`ENCRYPTION_KEY`, `STRIPE_SECRET_KEY`, `SUPABASE_JWT_SECRET`…) que estos comandos no usan | si se filtra, comprometés una base, no el stack |
| `DOTENV_CONFIG_PATH` **reemplaza** a `.env`, no lo mezcla | por eso una variable alcanza |
| No sirve para levantar la app: el `ConfigModule` de Nest no lee esa variable | no pretende hacerlo |

**`--target` no cambia a qué base te conectás.** Declara a cuál *creés* apuntar, y todo script que
conecta aborta si no coincide con el project ref real de la URL. Producción y QA están declaradas en
`connection-target.ts`. Otro proyecto (una base de desarrollo propia) necesita una segunda línea en su
archivo de conexión, porque el runner no adivina el rol de un ref desconocido:
`SUPABASE_PROJECT_ENVIRONMENTS={"<ref>":"development"}`.

| Entorno | `DOTENV_CONFIG_PATH` | `--target` | Para **escribir** además hace falta |
|---|---|---|---|
| QA | `.env.qa.db` | `qa` | — |
| Producción | `.env.prod.db` | `production` | `--allow-production --confirm-target production` |

### 2. El procedimiento

Ejemplo en QA. Para producción, cambiá el archivo y el target, y agregá las dos confirmaciones a los
comandos que escriben (`migration:run`, `postgres:assets --apply`, `--baseline`).

```bash
cd api-sapira

# ① ¿Qué le falta a la base? Solo lectura: corre en una transacción READ ONLY.
DOTENV_CONFIG_PATH=.env.qa.db yarn schema:status --target qa

# ② Migraciones primero: un asset puede depender de una tabla o columna que crea una migración.
DOTENV_CONFIG_PATH=.env.qa.db yarn migration:show --target qa      # solo lectura: lista las pendientes
DOTENV_CONFIG_PATH=.env.qa.db yarn migration:run  --target qa

# ③ Assets: ver qué haría, y aplicar lo tuyo.
DOTENV_CONFIG_PATH=.env.qa.db yarn postgres:assets --dry-run --target qa
DOTENV_CONFIG_PATH=.env.qa.db yarn postgres:assets --apply --only rls/mi_policy.sql --only functions/mi_funcion.sql --target qa

# ④ Confirmar que quedó al día.
DOTENV_CONFIG_PATH=.env.qa.db yarn schema:status --target qa
```

Las rutas de `--only` son relativas a `src/databases/postgresql/`, como las imprime `schema:status`.
Si un asset depende de otro (un seed antes que la función que lo usa, una función antes que su
trigger), ponelos en ese orden o en corridas separadas: cada asset se aplica en su propia transacción,
y si falla se revierte sin quedar registrado.

> 🔴 **`--apply` va con `--only` mientras `schema:status` muestre pendientes que no son tuyos.**
> Los 23 assets huérfanos ya se eliminaron del corpus (2026-09-21), pero la regla sigue: sin filtro
> solo cuando la línea base esté registrada y todo lo que quede pendiente sea tu cambio.

### 3. Cómo leer `schema:status`

Cada asset cae en una de estas acciones. Se listan en este orden, primero lo que exige una decisión;
`APLICADO` y `LINEA BASE` solo se cuentan (`--todo` los lista).

| Acción | Qué significa | Qué hacer |
|---|---|---|
| `DERIVA` | Registrado, pero la base tiene otra definición: alguien lo cambió por fuera del runner | Decidir quién tiene razón. Si la base: corregir el archivo (queda `REAPLICAR`, y aplicarlo no cambia nada). Si el archivo: re-aplicarlo |
| `BLOQUEADO` | Registrado, el archivo cambió, y es de `types/`, `special-index/` o `seed/` | Revertir el archivo y escribir una migración: `apply` falla a propósito |
| `NO CONVERGE` | Sin registrar, la base difiere, y es de una fase donde aplicar no cambia la base | Migración. No registrar con `--only`: el historial mentiría |
| `SIN CONTRAPARTE` | La base no tiene ese objeto, o el archivo tiene un nombre que el generador no produce | Revisar si debe existir antes de aplicarlo: `apply` lo crearía |
| `PENDIENTE` | Sin registrar y la base tiene otra definición | Si es tu cambio, aplicarlo. Si no, es deriva previa: averiguar antes de pisar la base |
| `REAPLICAR` | Registrado y el archivo cambió, en una fase que converge | `apply` lo re-ejecuta |
| `NO VERIFICABLE` | `grants/` o `seed/`: la comparación no puede probar nada | Aplicar a conciencia con `--only` |
| `LINEA BASE` | Sin registrar, pero la base ya coincide con el archivo | `--baseline` lo registra sin ejecutar ([paso 4](#4-línea-base)) |
| `APLICADO` | Registrado y al día | Nada |

Además lista las **migraciones pendientes** por nombre, las ejecutadas que no tienen archivo en el
repo, y los objetos **solo en la base**: existen ahí y no tienen asset (típicamente algo creado a mano
en esa base, o que una migración pendiente va a eliminar).

**Cómo verifica.** Captura el catálogo de la base, genera cada asset como lo haría
`generate-assets.ts`, y lo compara con el archivo **ignorando comentarios de línea completa, espacios
y comillas en identificadores simples**. Así un asset escrito a mano con cabecera explicativa, o un
`CREATE TRIGGER` partido en líneas, cuenta como igual a la definición de `pg_get_*def`.

### 4. Línea base

`--baseline` registra en el historial, **sin ejecutarlos**, los assets que `schema:status` marca como
`LINEA BASE`. Existe porque las dos bases ya tenían el esquema antes de que existiera el runner: sin
esto, nadie puede saber qué está realmente pendiente y todo `--apply` depende de `--only`.

```bash
DOTENV_CONFIG_PATH=.env.qa.db yarn postgres:assets --baseline --target qa
DOTENV_CONFIG_PATH=.env.qa.db yarn schema:status --target qa

DOTENV_CONFIG_PATH=.env.prod.db yarn postgres:assets --baseline \
  --target production --allow-production --confirm-target production
```

Lo que garantiza:

- **Solo registra lo verificado igual a la base en ese momento.** La verificación y el registro corren
  sobre la misma conexión, uno detrás del otro.
- **Nunca registra `grants/` ni `seed/`**, aunque coincidan.
- **Nunca toca una fila existente** (`ON CONFLICT DO NOTHING`). Un asset registrado que cambió lo
  resuelve `apply`.
- Las filas quedan con `modo = 'baseline'`; si después se re-aplican, pasan a `modo = 'apply'`.

Se usa **una vez por base** y cuando `schema:status` muestre `LINEA BASE` después de un cambio hecho
por fuera del runner que decidiste conservar. Corré siempre `schema:status` después: si alguien cambió
la base entre la verificación y el registro, aparece como `DERIVA`.

### 5. Errores frecuentes

| Mensaje | Causa | Arreglo |
|---|---|---|
| `--target qa no coincide con la conexión: SUPABASE_DATABASE_URL apunta al proyecto Supabase "hklompkypzqtglprfobu" (production)` | Falta `DOTENV_CONFIG_PATH`, o apunta al archivo de otro entorno: se usó otra URL | Revisar el prefijo del comando. **No** cambies el `--target` para que pase |
| `El proyecto Supabase "<ref>" no está declarado` | La URL es de un proyecto que no es prod ni QA | Revisar la URL; si es una base propia, declararla con `SUPABASE_PROJECT_ENVIRONMENTS` |
| `SUPABASE_DATABASE_URL o DATABASE_URL debe estar configurada` | `DOTENV_CONFIG_PATH` apunta a un archivo que no existe (dotenv no avisa) | Correr desde `api-sapira/` y revisar el nombre del archivo |
| `… en production requiere --allow-production y --confirm-target production` | Un comando que escribe en prod sin las dos confirmaciones | Agregarlas, **después** de haber hecho lo mismo en QA |
| `Argumento no reconocido: --allow-prod` | Bandera mal escrita | Las banderas se escriben completas; nunca se ignoran |
| `--only no coincide con ningún asset descubierto` | Ruta mal escrita o absoluta | Relativa a `src/databases/postgresql/`, como la imprime `schema:status` |
| `El checksum de types/… cambió después de aplicarse, y la fase … no se puede re-aplicar` | Se editó un asset ya aplicado de `types/`, `special-index/` o `seed/` | Revertir el archivo; el cambio va en una migración |
| Error de Postgres al aplicar (`relation … does not exist`, `function … does not exist`) | Falta una dependencia: migración pendiente, o un asset que va antes | Aplicar la dependencia primero. El asset que falló se revirtió y no quedó registrado |

### 6. Estado de las bases

Medido con `schema:status` el **2026-09-16**. Se desactualiza con cada cambio: la fuente es el
comando, no esta tabla.

| | QA (`obvwrhvyuimjoejqmuqf`) | Producción (`hklompkypzqtglprfobu`) |
|---|---|---|
| Migraciones pendientes | 5 (nunca corrió ninguna) | 0 |
| Historial de assets | No existe | 7 filas |
| `LINEA BASE` | 831 | 851 |
| `PENDIENTE` | 19 funciones con otra definición | 3: `apply_quote_downsell_to_contract` y `prevent_end_date_update_when_active` (**prod tiene código más nuevo que el repo**), `create_default_roles_for_holding` (el repo agrega `VIEW_DOCUMENTACION`) |
| `SIN CONTRAPARTE` | 32 | 23 (los huérfanos de [Deudas conocidas](#️-deudas-conocidas)) |
| Solo en la base | 15 (legacy que las migraciones pendientes eliminan en parte, y policies de salesforce) | 0 |
| `NO CONVERGE` | `types/000-extensions.sql` (sus extensiones difieren de prod) | — |

**Puesta al día de QA: el orden importa.** No sigas el procedimiento genérico a ciegas la primera vez:

1. `postgres:assets --apply --only rls/generic_export_vats_select_active.sql --only rls/indicadores_economicos_select.sql --target qa`.
   Crea la tabla de historial, que `HabilitaRlsEnTablasSinContencion` necesita que exista (en prod ya
   existía cuando corrió), y aplica las dos policies en el mismo orden que en prod, para que esas
   tablas no queden deny-all entre medio.
2. `migration:run --target qa`. Antes, confirmar que `integration_logs` no tiene dependientes:
   `DropIntegrationLogs` la borra sin `CASCADE`.
3. `postgres:assets --baseline --target qa` y `schema:status`.
4. Aplicar lo pendiente por lotes con `--only`, decidiendo los `SIN CONTRAPARTE` y lo que quede solo en QA.

**Conexión.** Las dos bases van por el pooler en el puerto 6543 (transaction mode). Se verificó que
el patrón del runner —transacción explícita, SQL multi-sentencia en un solo `query()` y query
parametrizada— corre igual ahí que en session mode, y que ningún asset usa `CREATE INDEX CONCURRENTLY`
ni `ALTER TYPE … ADD VALUE`, que romperían dentro del `BEGIN/COMMIT`.

> ⚠️ **Si la base de destino está vacía, los assets no alcanzan.** Un seed que inserta en
> `public.permissions` falla si la tabla no existe. Levantar el esquema desde cero en una base nueva
> no está probado todavía; el camino confiable es un clon o restore de producción.

### 7. Pendientes conocidos

Los 9 pendientes para que la base sea código de punta a punta —con su estado, cómo se cierra cada uno
y cómo se verifica— viven en un solo lugar:
**[`REGISTRO-DB-COMO-CODIGO.md`](./REGISTRO-DB-COMO-CODIGO.md)**. Se marca ahí, en el mismo commit que
resuelve el punto.

Los tres que más afectan una sincronización hoy:

- **3 funciones con deriva real en prod** (punto 1): en dos, la base tiene código que el repo no tiene,
  así que aplicar el archivo borraría un arreglo hecho en prod.
- **La línea base de prod no está registrada** (punto 2): por eso `--apply` sigue necesitando `--only`.
- ~~**23 assets huérfanos** (punto 4)~~ — ✅ eliminados del corpus el 2026-09-21.

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

Hoy la deriva conocida son **94 sentencias**, todas clasificadas y ninguna de ellas un cambio real.
Si aparecen en tu migración, **bórralas**:

| Vas a ver | Cuántas | Qué es |
|---|---:|---|
| `DROP INDEX` sobre un índice que está en `special-index/` | 41 | TypeORM no puede declararlos, así que no los reconoce |
| `DROP CONSTRAINT` + `ADD CONSTRAINT` con el **mismo nombre y la misma definición** | 28 | Churn de TypeORM al alterar otra cosa de esa tabla. Netean a cero |
| `DROP DEFAULT` + `SET DEFAULT gen_random_uuid()` sobre una columna FK | 14 | Las 7 columnas FK con ese default, anomalía de producción. Netean a cero |
| `DROP INDEX` + `CREATE INDEX` con la misma definición | 4 | Idem: TypeORM recrea los índices de las columnas que altera |
| `SET DEFAULT ('now'::text)::date` | 4 | Producción guarda `CURRENT_DATE`; TypeORM normaliza el texto. Son equivalentes |
| `SET DEFAULT ARRAY[]::…` | 3 | Misma normalización |

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

Debe emitir las 94 conocidas más nada. Si emite algo nuevo que no es tu cambio, la entity y la base
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

**Edita el mismo archivo.** En `functions/`, `triggers/`, `rls/` y `grants/` el runner detecta que el
checksum cambió y **re-aplica** el asset, registrando el checksum nuevo. Lo reporta como `REAPLICADO`.

Funciona porque en esas cuatro fases re-aplicar converge: son `CREATE OR REPLACE` y
`DROP … IF EXISTS` + `CREATE`, así que correr el archivo otra vez deja el objeto como el archivo lo
describe. **El corpus es el estado deseado; el historial lo lleva git.**

> 🔴 **En `types/`, `special-index/` y `seed/` NO.** Ahí el runner falla a propósito, porque el
> archivo cambiaría y la base no: `CREATE TYPE` va con guarda `DO … pg_type`, `CREATE INDEX` con
> `IF NOT EXISTS` y los seeds con `ON CONFLICT DO NOTHING` — ninguno redefine algo que ya existe.
> Un cambio ahí es una **transición** y va en una migración.

> 🚫 **No crees `<objeto>_<motivo>.sql` para versionar un cambio.** Además de inflar el corpus, el
> archivo que queda vivo lo decide el **orden alfabético, que no es el cronológico**: un arreglo
> posterior llamado `…_arreglo.sql` se aplicaría antes que un `…_view_documentacion.sql` anterior y
> quedaría pisado por él. Es el mismo problema que hace inservibles las 465 migraciones del front.

**No borres la fila del historial.** Es el registro de lo que corrió; falsearlo deja la base y el
corpus contando historias distintas.

### Apliqué algo al entorno equivocado

Difícil, pero no imposible: `connection-target.ts` resuelve el project ref de Supabase desde la cadena
de conexión y aborta si no corresponde al `--target` declarado. Si aun así pasó, trátalo como un
incidente de producción: mide el daño con `yarn schema:status --target <entorno>` (solo lectura)
antes de tocar nada más. Lo que aplicaste aparece como registrado con `modo = 'apply'` y un
`applied_at` reciente en `sapira_sql_asset_history`.

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
| Duplicar un asset como `<objeto>_<motivo>.sql` para cambiarlo | El corpus deja de describir el estado deseado, y quién gana lo decide el orden alfabético |
| Editar un asset aplicado de `types/`, `special-index/` o `seed/` | El archivo cambia y la base no: el runner falla a propósito |
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
| `database.module.spec.ts` | `synchronize`/`dropSchema`/`migrationsRun` en `true`; **una tabla de producción sin entity viva** (o un espejo inerte); que un espejo se promueva sin decisión explícita; que una tabla quede con espejo y entity a la vez; que el barrel `espejo.existing.ts` se desincronice del disco; **un script que conecta sin verificar el `--target`**; que `schema:status` pueda escribir; que `migration:show` vuelva a usar `showMigrations()`, que crea la tabla |
| `entities/indices-declarados.spec.ts` | Que un índice de producción quede sin declarar, ni en la entity ni en `special-index/`. Eran 161 |
| `assets-runner.spec.ts` | Assets de `functions/` que no declaran la función o no cierran su dollar-quote; `types/` no re-ejecutable; `special-index/` con índices que sí eran declarables; fases del manifest desalineadas de `ASSET_DIRECTORIES`; **una migración que crea una tabla sin activar RLS**; **una policy sobre una tabla que es deny-all por diseño**; que `--baseline` ejecute SQL, pise una fila existente, registre `grants/`/`seed/` o corra en prod sin confirmar |
| `schema-status.spec.ts` | Que la verificación confunda una diferencia real con una de formato; que una acción de `schema:status` se clasifique mal; que una migración declare un `name` distinto de su clase; que `fetch-catalog`, `generate-assets` y la comparación dejen de encajar |
| `run-migrations.spec.ts` | `migration:run`/`revert` en prod sin las dos confirmaciones; una bandera mal escrita ignorada en silencio |
| `connection-target.spec.ts` | Que el `--target` se desacople de la conexión real, en prod y en QA |
| `entities/integraciones/odoo/odoo-stg-processing-status.spec.ts` | Que un default declarado no sea uno de los valores que admite su propio CHECK |

Si una de estas se pone roja, no la ajustes para que pase: describe una invariante que costó
encontrar. Cada una nació de un problema real que está documentado en su propio comentario.

---

## 🗺️ Deudas conocidas

Lo que falta para que la base sea código, con estado por punto:
[`REGISTRO-DB-COMO-CODIGO.md`](./REGISTRO-DB-COMO-CODIGO.md). Las deudas del corpus, con su evidencia,
están en [`README.md` → Deudas conocidas del corpus](./README.md#deudas-conocidas-del-corpus). Las que
más te pueden afectar al tocar algo:

- **23 assets apuntan a objetos que no existen en producción** (7 funciones, 12 triggers, 4
  policies; `schema:status` los lista como `SIN CONTRAPARTE`). Dos de esas funciones —`set_invoice_processing_status` y
  `classify_invoice_line_before_insert`— llegaron a usarse como premisa en el comentario de una
  migración que resultó estar equivocada. **Verifica contra la base, no contra el corpus.**
- **Las 131 tablas tienen RLS** desde el 2026-09-14. Cuatro están deny-all a propósito
  (`claude_skills`, `sii_*`) y hay una guarda que impide que alguien les escriba una policy.
- **`cleanup_duplicate_partners_by_vat` está en ventana de observación**: se le revocó el `EXECUTE`
  a PUBLIC y se elimina si nadie reclama.
- **Anomalías de FK heredadas de producción** (FKs duplicadas con `ON DELETE` divergente,
  `SET NULL` sobre columna `NOT NULL`). Se replican tal cual; corregirlas es decisión de negocio.
- **2 vistas sin asset ni entity**: `invoices_with_net_amounts`, `invoice_items_consolidated`.

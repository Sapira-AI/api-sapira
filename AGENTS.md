# Sapira API Guide

## Reglas base

- Responde y documenta en espanol.
- Limita los cambios a lo solicitado y no elimines codigo existente sin instruccion explicita.
- Reutiliza modulos, servicios, providers y patrones existentes antes de crear nuevos.
- Revisa `package.json` antes de proponer dependencias, scripts o comandos.

## Stack

- NestJS + TypeScript.
- Yarn 4 definido por el proyecto.
- Arquitectura modular con controllers, services y providers.

## Convenciones

- Mantiene la estructura usual de modulo: `dtos`, `interfaces`, `schemas`, `helpers`, `controller`, `module`, `provider`, `service`.
- Crea controladores y providers siguiendo los modulos ya existentes.
- Evita refactors o simplificaciones no pedidas.
- No hagas commits ni cambios destructivos de git sin instruccion explicita.
- Toda funcionalidad nueva o modificada —la haga Claude, Cursor o una persona— cierra la tarea con tres verificaciones: documentación funcional, documentación técnica y tests unitarios. Detalle abajo, en **Documentación y tests obligatorios**.
- `ROADMAP-V2.md` (raíz) es el único índice del plan v2: un documento de planificación nuevo se linkea desde ahí o no existe. El backlog operativo de fixes vive en copia espejo doble: `docs/ROADMAP-OPERATIVO.md` y `sapira-ai/docs/ROADMAP-OPERATIVO.md` — todo cambio se replica en ambos (convención en el propio archivo).
- Prioriza documentar en la ubicación más cercana del módulo afectado: `src/modules/<modulo>/docs/` si ya existe, o `docs/` para documentación transversal.
- Usa Jest para pruebas unitarias y manten las specs dentro de `src/` con sufijo `.spec.ts`, idealmente cerca del modulo afectado.

## Documentación y tests obligatorios

Toda funcionalidad nueva o modificada cierra con estas tres verificaciones. La versión legible y
ampliada está en `docs/README.md`.

**1. Documentación funcional.** Obligatoria cuando el cambio toca comportamiento funcional, flujos o
reglas de negocio, contratos de entrada/salida, integraciones externas, payloads, validaciones,
errores esperados o configuración relevante para operación y soporte. Va en la ubicación más cercana:
`src/modules/<modulo>/docs/` si el módulo ya tiene carpeta propia, o `docs/cambios/` para cambios
puntuales y `docs/` para lo transversal. No hace falta para renombres internos ni refactors sin
impacto funcional visible.

**2. Documentación técnica.** Se actualiza la fuente canónica que corresponda, sin crear taxonomías
nuevas ni duplicar:

| Qué cambió | Dónde se documenta |
|---|---|
| Esquema de la base: tablas, entities, funciones, triggers, policies, grants, seeds, cron | `src/databases/postgresql/` (GUIA, README del corpus, REGISTRO-DB-COMO-CODIGO). **No se duplica en `docs/`** |
| Guards transversales, autorización y tenancy | `docs/guards/` y `docs/v2-rediseno/autorizacion-y-tenancy.md` |
| Arquitectura o diseño técnico de un módulo | `src/modules/<modulo>/docs/` |
| Decisiones técnicas transversales del rediseño | `docs/v2-rediseno/` (linkeado desde `ROADMAP-V2.md`) |

**3. Tests unitarios.** Toda funcionalidad nueva o modificada incluye specs nuevas o actualizadas en
Jest, dentro de `src/`, con sufijo `.spec.ts` y cerca del módulo afectado. Prioriza `service`,
`provider`, helpers y lógica de negocio; en `controller`, cubre su comportamiento propio y mockea
dependencias externas. Para un controlador con `HoldingScopeGuard`, los tres casos son obligatorios:
sin header → 400, holding ajeno → 403, registro de otro holding → 404.

No cierres una tarea funcional sin verificar los tres puntos. Si alguno no aplica, deja la
justificación explícita en la entrega; no lo omitas en silencio.

## Base de datos y esquema

- **Procedimiento completo: `src/databases/postgresql/GUIA-CAMBIOS-DE-ESQUEMA.md`** — dónde va cada
  cambio, las recetas y cómo se revisa una migración generada.
- **Pendientes para que la base sea código: `src/databases/postgresql/REGISTRO-DB-COMO-CODIGO.md`**
  (9 puntos con estado). Si resolvés uno, márcalo ahí en el mismo commit.
- `api-sapira` es el schema-as-code de todo el esquema `public`. El DDL no va en
  `front-sapira-vite/supabase/migrations/`.
- **La entity define la tabla**; lo que TypeORM no puede declarar (enums, extensiones, índices
  gin/ivfflat o con orden explícito, funciones, triggers, policies, permisos, semillas) es un asset
  en `src/databases/postgresql/`, aplicado con `yarn postgres:assets`.

### Migración o asset: la regla

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
- **Los jobs de pg_cron son assets** (`cron/`), y **nunca llevan un secreto en el comando**: si llaman
  una edge function, van por `public.cron_invoke_edge_function`, que lee la URL y la clave de Vault.
  Hay una prueba que falla si aparece un token en el corpus o en los snapshots.
- **Las 74 entities promovidas (cabecera "PROMOVIDA desde espejo") ya NO se regeneran**: son la
  fuente de verdad de su tabla y se editan como cualquier entity. El generador solo refresca el
  snapshot de prod contra el que su spec las mide. Si ese spec queda en rojo, el repo y prod
  difieren: se aplica el cambio y DESPUÉS se corre `yarn schema:snapshot --target production`.
- **El CLI exige lo que antes era solo regla escrita**: `--apply` sin `--only` aborta (o `--all` a
  conciencia), no se aplica un asset con cambios sin commitear (o `--allow-dirty`), y `--target` es
  obligatorio: ya no se infiere de `NODE_ENV`.

### Reglas
- Nunca actives `synchronize`, `dropSchema` ni `migrationsRun`. `yarn schema:log` es el único uso de
  TypeORM sobre el esquema y solo lee.
- Toda migración generada se revisa antes de commitear: TypeORM emite `DROP` sobre lo que no modela.
- Todo índice de producción va declarado: `@Index` en la entity si es btree sobre columnas simples
  (los parciales también, con `@Index({ where })`), o `special-index/` si no. Lo verifica
  `entities/indices-declarados.spec.ts`.
- Un archivo por objeto, con su definición vigente. En `functions/`, `triggers/`, `rls/` y `grants/`
  se edita en su lugar y el runner re-aplica; en `types/`, `special-index/` y `seed/` un cambio va en
  una migración. Nunca dupliques un asset como `<objeto>_<motivo>.sql`.
- **Para eliminar algo**: borrar el archivo del repo no borra nada de la base, y borrar la entity no
  borra la tabla. Son dos acciones: una migración escrita a mano con los `DROP` y borrar los
  archivos. Procedimiento: `src/databases/postgresql/README.md`.
- **Sincronizar con QA o producción** empieza y termina con `yarn schema:status --target <entorno>`
  (solo lectura), primero QA y después prod, con la conexión por
  `DOTENV_CONFIG_PATH=.env.<qa|prod>.db` (las URLs se le piden a Leon; nunca se commitean).
  Migraciones antes que assets. Procedimiento: GUIA → **Sincronizar cambios a QA y producción**.
- 🔴 **`--apply` SIEMPRE lleva un `--only <ruta>` por cada asset que tocaste. Nunca corras
  `postgres:assets --apply` sin filtro**, en ningún entorno. Sin filtro aplica todo lo que no esté
  registrado en el historial. (Los 23 assets huérfanos ya se eliminaron — punto 4 del
  `REGISTRO-DB-COMO-CODIGO.md`, cerrado el 21-09 — pero la regla sigue mientras la línea base de
  cada entorno no esté registrada: punto 2 del mismo registro.)

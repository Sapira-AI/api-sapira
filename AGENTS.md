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
- Toda funcionalidad nueva o modificada debe actualizar su documentación funcional en la misma tarea.
- Prioriza documentar en la ubicación más cercana del módulo afectado: `src/modules/<modulo>/docs/` si ya existe, o `docs/` para documentación transversal.
- Toda funcionalidad nueva o modificada en backend debe incluir tests unitarios nuevos o actualizados.
- Usa Jest para pruebas unitarias y manten las specs dentro de `src/` con sufijo `.spec.ts`, idealmente cerca del modulo afectado.

## Base de datos y esquema

- **Procedimiento completo: `src/databases/postgresql/GUIA-CAMBIOS-DE-ESQUEMA.md`** — dónde va cada
  cambio, las recetas y cómo se revisa una migración generada.
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
- **74 entities son generadas** (cabecera "PROMOVIDA desde espejo"). Se editan para cambiar su tabla,
  pero no se corre `scripts/espejo/generate-espejo.py` sin antes refrescar los snapshots desde prod:
  regenerar con snapshots viejos revierte el cambio en silencio.

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
  Migraciones antes que assets. `--apply` va con `--only` mientras `schema:status` muestre
  `SIN CONTRAPARTE` ajenos al cambio. Procedimiento: GUIA → **Sincronizar cambios a QA y producción**.

# Rediseño v2 — guía de trabajo

Guía canónica del plan de rediseño incremental acordado entre Domi y Leon (2026-08-18), para el trabajo en este repo (entities por módulo, entidades nuevas, funciones/triggers).

- `00-plan-y-metodo.md` — plan de 7 pasos, reglas de trabajo (incluida la sincronización reglas cursor ↔ claude) y estado.
- `04-spec-modelo-dominio-v2/00-tablas-por-modulo.md` — las 128 tablas de prod con veredicto por módulo: define las subcarpetas de `src/databases/postgresql/entities/` (paso 1), lo nuevo (paso 2) y la limpieza (paso 4).

El análisis completo que respalda este plan (5 benchmarks de competidores + censo de producción + síntesis de mejoras) vive en `sapira-ai/docs/v2-rediseno/`. Ante cambios del plan, actualizar AMBOS repos (política de comunicación entre IAs).

# Rediseño v1.2 — guía de trabajo en api-sapira

Copia de la guía del rediseño para el trabajo en este repo (carril B: entities espejo por módulo, entidades nuevas, funciones/triggers). La documentación **canónica y completa** del rediseño (benchmarks, censo, decisiones, spec por secciones, glosario) vive en `front-sapira/docs/v2-rediseno/`. Ante cambios del plan, actualizar allá primero y sincronizar esta copia.

- `00-plan-y-metodo.md` — plan de 7 pasos, 3 carriles, objetivos v1.2, reglas (incl. sincronización reglas cursor ↔ claude) y estado.
- `04-spec-modelo-dominio-v2/00-tablas-por-modulo.md` — las 128 tablas de prod con veredicto por módulo: define las subcarpetas de `src/databases/postgresql/entities/` (paso 1), lo nuevo (paso 2) y la limpieza (paso 4).

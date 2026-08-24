# Módulo 13 · Emisión fiscal nativa (SII) — 3 tablas de prod (2026-08-22)

> Convención y reglas: `../README.md`. Rarezas verificadas: `../NOTAS-ESPEJO.md`. Veredictos de producto: `docs/v2-rediseno/04-spec-modelo-dominio-v2/00-tablas-por-modulo.md` (no aplican en este paso).
> Origen de TODO lo que está en esta carpeta: lectura en vivo de prod `hklompkypzqtglprfobu` vía MCP de Supabase el 2026-08-22 — `list_tables verbose` + `execute_sql` de solo lectura sobre `pg_catalog` (`scripts/espejo/snapshots/sii.{pgmeta,catalog}.json`); metadata real de las entities existentes en `sii.existing.json` (`scripts/espejo/extract-existing-metadata.ts`). Generado con `scripts/espejo/generate-espejo.py`.

## A · Tablas que YA tenían entity en el repo (3) — no se tocaron ni se duplicaron

Estas entities están **prendidas en producción** exactamente como estaban (`database.module.ts` las carga por el glob `src/**/*.entity.ts` y sus módulos las registran en `forFeature`). "Estado vs prod" = diff entre lo que la entity declara hoy (metadata TypeORM real) y la DB en vivo; es el insumo para completarlas en el paso 3 con Leon.

| Tabla (filas) | Entity existente (archivo · clase) | Estado vs prod | Columnas que faltan en la entity | Columnas que sobran | Diferencias en columnas existentes | Constraints / índices / FKs que la entity no declara |
|---|---|---|---|---|---|---|
| `sii_configurations` (0) | `src/modules/sii/entities/sii.entity.ts` · `SiiConfiguration` | ⚠️ difiere de prod | — | — | `enabled_document_types`: default `'[33,34,61]'` vs DB `'[33, 34, 61]'::jsonb`<br>`created_at`: tipo `timestamp` vs DB `timestamp with time zone`<br>`updated_at`: tipo `timestamp` vs DB `timestamp with time zone` | nombre de PK `sii_configurations_pkey` |
| `sii_certificates` (0) | `src/modules/sii/entities/sii.entity.ts` · `SiiCertificate` | ⚠️ difiere de prod | — | — | `created_at`: tipo `timestamp` vs DB `timestamp with time zone` | nombre de PK `sii_certificates_pkey`<br>FK `sii_certificates_configuration_id_fkey` → sii_configurations ON DELETE CASCADE |
| `sii_cafs` (0) | `src/modules/sii/entities/sii.entity.ts` · `SiiCaf` | ⚠️ difiere de prod | — | — | `created_at`: tipo `timestamp` vs DB `timestamp with time zone` | nombre de PK `sii_cafs_pkey`<br>FK `sii_cafs_configuration_id_fkey` → sii_configurations ON DELETE CASCADE |

## B · Tablas SIN entity → espejos creados (0), APAGADOS

Ninguna: todas las tablas de este módulo ya tienen entity en el repo; este módulo solo documenta el diff (sección A). No hay espejos, snapshot ni spec.

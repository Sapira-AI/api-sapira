/**
 * fetch-catalog.ts — captura el catálogo completo del esquema `public` desde una
 * base viva y lo escribe en el formato que consume `scripts/espejo/build-snapshots.py`.
 *
 * Reemplaza la captura manual por MCP y agrega lo que a esa captura le faltaba:
 *
 *  - `format_type(atttypid, atttypmod)`: la única fuente del tipo exacto. Sin él,
 *    `numeric` queda sin precisión y `vector` sin dimensión (information_schema no
 *    expone atttypmod para tipos definidos por el usuario).
 *  - `notnull`, `default`, `comment` y `attnum` por columna, desde pg_catalog.
 *  - Extensiones con su schema real, permisos por rol (GRANT), definición de todas
 *    las funciones, y la versión del servidor.
 *
 * Todo corre dentro de una transacción READ ONLY: el motor rechaza cualquier
 * escritura, así que la garantía no depende de que las consultas estén bien escritas.
 *
 * Uso:
 *   SUPABASE_DATABASE_URL=... npx ts-node -r tsconfig-paths/register \
 *     scripts/schema-as-code/fetch-catalog.ts --target production
 */
import * as fs from 'fs';
import * as path from 'path';

import 'dotenv/config';
import { Client } from 'pg';

import type { SqlExecutor } from '@/databases/postgresql/assets-runner';
import { assertConnectionMatchesTarget } from '@/databases/postgresql/connection-target';

import type { Catalog } from './generate-assets';

const RAW_DIR = path.resolve(__dirname, '../espejo/snapshots/raw');

interface Row {
	[column: string]: unknown;
}

const QUERIES = {
	// `reltuples` vale -1 mientras la tabla no haya pasado por ANALYZE (PG 14+), así que en ese
	// caso se cuenta de verdad: son tablas sin estadísticas, típicamente chicas o vacías.
	tables: `
		SELECT cl.relname AS "table", cl.relrowsecurity AS rls, cl.relforcerowsecurity AS rls_forced,
		       obj_description(cl.oid) AS comment,
		       CASE WHEN cl.reltuples < 0
		            THEN (SELECT n FROM query_to_xml(format('SELECT count(*) AS n FROM public.%I', cl.relname), false, true, '')
		                  AS x, XMLTABLE('//row' PASSING x COLUMNS n bigint PATH 'n'))
		            ELSE cl.reltuples::bigint
		       END AS rows
		FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
		WHERE n.nspname = 'public' AND cl.relkind = 'r'
		ORDER BY cl.relname`,

	// information_schema da los campos que ya consumía el pipeline; pg_attribute
	// aporta el tipo exacto, la nulabilidad real y el comentario.
	columns: `
		SELECT c.table_name AS "table", c.column_name AS "column", c.ordinal_position::int AS attnum,
		       c.data_type AS data_type, c.udt_name AS udt,
		       format_type(a.atttypid, a.atttypmod) AS type,
		       c.character_maximum_length::int AS char_len,
		       c.numeric_precision::int AS num_prec, c.numeric_scale::int AS num_scale,
		       a.attnotnull AS notnull, pg_get_expr(ad.adbin, ad.adrelid) AS "default",
		       c.is_identity AS identity, c.is_generated AS generated, c.generation_expression AS gen_expr,
		       col_description(a.attrelid, a.attnum) AS comment
		FROM information_schema.columns c
		JOIN pg_class cl ON cl.relname = c.table_name
		JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = c.table_schema
		JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attname = c.column_name
		LEFT JOIN pg_attrdef ad ON ad.adrelid = cl.oid AND ad.adnum = a.attnum
		WHERE c.table_schema = 'public' AND cl.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
		ORDER BY c.table_name, c.ordinal_position`,

	constraints: `
		SELECT cl.relname AS "table", con.conname AS name, con.contype::text AS type,
		       pg_get_constraintdef(con.oid) AS def,
		       con.condeferrable AS deferrable, con.condeferred AS deferred,
		       NULLIF(con.confdeltype::text, '') AS ondelete, NULLIF(con.confupdtype::text, '') AS onupdate
		FROM pg_constraint con
		JOIN pg_class cl ON cl.oid = con.conrelid
		JOIN pg_namespace n ON n.oid = cl.relnamespace
		WHERE n.nspname = 'public' AND cl.relkind = 'r'
		ORDER BY cl.relname, con.conname`,

	indexes: `
		SELECT cl.relname AS "table", i.relname AS name, pg_get_indexdef(x.indexrelid) AS def,
		       x.indisunique AS "unique", x.indisprimary AS "primary"
		FROM pg_index x
		JOIN pg_class cl ON cl.oid = x.indrelid
		JOIN pg_class i ON i.oid = x.indexrelid
		JOIN pg_namespace n ON n.oid = cl.relnamespace
		WHERE n.nspname = 'public' AND cl.relkind = 'r'
		ORDER BY cl.relname, i.relname`,

	triggers: `
		SELECT cl.relname AS "table", t.tgname AS name, pg_get_triggerdef(t.oid) AS def
		FROM pg_trigger t
		JOIN pg_class cl ON cl.oid = t.tgrelid
		JOIN pg_namespace n ON n.oid = cl.relnamespace
		WHERE n.nspname = 'public' AND NOT t.tgisinternal
		ORDER BY cl.relname, t.tgname`,

	policies: `
		SELECT tablename AS "table", policyname AS name, permissive, roles::text[] AS roles,
		       cmd, qual, with_check
		FROM pg_policies WHERE schemaname = 'public'
		ORDER BY tablename, policyname`,

	foreignKeys: `
		SELECT con.conname AS name, src.relname AS source_table, tgt.relname AS target_table,
		       -- attname es de tipo "name": sin el cast a text el driver devuelve el literal
		       -- {a,b} como string en vez de un array, y el generador del espejo lo recorre
		       -- carácter por carácter.
		       (SELECT array_agg(a.attname::text ORDER BY k.ord)
		          FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
		          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS source_columns,
		       (SELECT array_agg(a.attname::text ORDER BY k.ord)
		          FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
		          JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS target_columns
		FROM pg_constraint con
		JOIN pg_class src ON src.oid = con.conrelid
		JOIN pg_class tgt ON tgt.oid = con.confrelid
		JOIN pg_namespace n ON n.oid = src.relnamespace
		WHERE con.contype = 'f' AND n.nspname = 'public'
		ORDER BY con.conname`,

	enums: `
		SELECT t.typname AS name, e.enumlabel AS label
		FROM pg_type t
		JOIN pg_enum e ON e.enumtypid = t.oid
		JOIN pg_namespace n ON n.oid = t.typnamespace
		WHERE n.nspname = 'public'
		ORDER BY t.typname, e.enumsortorder`,

	extensions: `
		SELECT e.extname AS name, e.extversion AS version, n.nspname AS schema
		FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
		ORDER BY e.extname`,

	grants: `
		SELECT table_name AS "table", grantee, privilege_type AS privilege
		FROM information_schema.role_table_grants
		WHERE table_schema = 'public'
		ORDER BY table_name, grantee, privilege_type`,

	// `extension` distingue las funciones propias de las que instaló una extensión
	// (pg_trgm y vector viven en public): sin eso el conteo de cobertura miente.
	// `pg_get_functiondef` NO incluye el COMMENT ON: sin capturarlo aparte, los 140 comentarios de
	// funciones de prod no existen en el repo y se pierden en un entorno reconstruido.
	// `identity_args` es la firma mínima que `COMMENT ON FUNCTION` necesita para desambiguar sobrecargas.
	functions: `
		SELECT p.proname AS name, pg_get_functiondef(p.oid) AS def, e.extname AS extension,
		       obj_description(p.oid, 'pg_proc') AS comment,
		       pg_get_function_identity_arguments(p.oid) AS identity_args
		FROM pg_proc p
		JOIN pg_namespace n ON n.oid = p.pronamespace
		LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e' AND d.classid = 'pg_proc'::regclass
		LEFT JOIN pg_extension e ON e.oid = d.refobjid
		WHERE n.nspname = 'public' AND p.prokind = 'f'
		ORDER BY p.proname, p.oid`,

	// Secuencias SUELTAS: las que no pertenecen a una columna `serial`/`identity` (esas llegan con
	// su tabla, por entity + migración). Hoy es una sola, `invoice_number_seq`, y sin esto ningún
	// archivo del repo la describe.
	sequences: `
		SELECT cl.relname AS name, s.seqstart AS start, s.seqincrement AS increment,
		       s.seqmin AS minvalue, s.seqmax AS maxvalue, s.seqcache AS cache, s.seqcycle AS cycle
		FROM pg_sequence s
		JOIN pg_class cl ON cl.oid = s.seqrelid
		JOIN pg_namespace n ON n.oid = cl.relnamespace
		WHERE n.nspname = 'public'
		  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = cl.oid AND d.deptype = 'a')
		ORDER BY cl.relname`,

	// Objetos de `public` que ninguna fase del corpus modela. Se capturan para que
	// `schema:status` los liste en FUERA DEL CORPUS en vez de que pasen inadvertidos.
	otherRoutines: `
		SELECT p.proname AS name, p.prokind::text AS kind
		FROM pg_proc p
		JOIN pg_namespace n ON n.oid = p.pronamespace
		LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e' AND d.classid = 'pg_proc'::regclass
		WHERE n.nspname = 'public' AND p.prokind <> 'f' AND d.objid IS NULL
		ORDER BY p.proname`,

	otherTypes: `
		SELECT t.typname AS name, t.typtype::text AS kind
		FROM pg_type t
		JOIN pg_namespace n ON n.oid = t.typnamespace
		LEFT JOIN pg_class cl ON cl.oid = t.typrelid
		WHERE n.nspname = 'public' AND t.typtype IN ('c', 'd', 'r')
		  AND (cl.oid IS NULL OR cl.relkind NOT IN ('r', 'v', 'm', 'p'))
		ORDER BY t.typname`,

	// Las vistas no las modela TypeORM ni tienen fase propia todavía: se capturan
	// para que la brecha quede medida y no supuesta.
	views: `
		SELECT cl.relname AS name, cl.relkind::text AS kind, pg_get_viewdef(cl.oid, true) AS def
		FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
		WHERE n.nspname = 'public' AND cl.relkind IN ('v', 'm')
		ORDER BY cl.relname`,

	// Una tabla particionada rompería el modelo de assets: hay que saberlo antes.
	partitioned: `
		SELECT cl.relname AS "table"
		FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
		WHERE n.nspname = 'public' AND cl.relkind = 'p'
		ORDER BY cl.relname`,

	server: `SELECT version() AS version, current_setting('server_version_num') AS version_num`,
} as const;

/**
 * Consultas que dependen de algo que puede no existir en la base.
 *
 * Van aparte porque todo corre dentro de UNA transacción READ ONLY: un `cron.job` inexistente
 * aborta la transacción y se lleva puesto el resto de la captura, así que `schema:status` moriría
 * entero en cualquier base sin pg_cron. Con el pre-chequeo, ahí la lista queda vacía y nada más.
 */
const QUERIES_OPCIONALES = {
	cron: {
		existe: `SELECT to_regclass('cron.job') AS objeto`,
		sql: `
			SELECT jobname AS name, schedule, command, active, username, database
			FROM cron.job
			ORDER BY jobname`,
	},
} as const;

type QueryName = keyof typeof QUERIES | keyof typeof QUERIES_OPCIONALES;

/**
 * Corre las consultas del catálogo. No abre transacción: quien llama decide, y
 * `schema:status` necesita meterlas en la misma transacción READ ONLY que el resto.
 */
async function consultarCatalogo(executor: SqlExecutor, log: (mensaje: string) => void = () => undefined): Promise<Record<QueryName, Row[]>> {
	const result = {} as Record<QueryName, Row[]>;
	for (const [name, sql] of Object.entries(QUERIES) as [QueryName, string][]) {
		const { rows } = await executor.query(sql);
		result[name] = rows;
		log(`  ${name}: ${rows.length} filas`);
	}

	for (const [name, consulta] of Object.entries(QUERIES_OPCIONALES)) {
		const existe = await executor.query(consulta.existe);
		const rows = existe.rows[0]?.objeto ? (await executor.query(consulta.sql)).rows : [];
		result[name as QueryName] = rows;
		log(`  ${name}: ${rows.length} filas${existe.rows[0]?.objeto ? '' : ' (no existe en esta base)'}`);
	}

	return result;
}

/** Consultas del catálogo dentro de una transacción READ ONLY: el motor rechaza cualquier escritura. */
async function capturarDatos(executor: SqlExecutor, log?: (mensaje: string) => void): Promise<Record<QueryName, Row[]>> {
	await executor.query('BEGIN TRANSACTION READ ONLY');
	try {
		return await consultarCatalogo(executor, log);
	} finally {
		await executor.query('ROLLBACK');
	}
}

/** Catálogo de una base viva, en memoria, en el formato que consumen los emisores de `generate-assets`. */
async function capturarCatalogo(executor: SqlExecutor): Promise<Catalog> {
	return buildCatalog(await capturarDatos(executor)) as Catalog;
}

/** Agrupa filas por su columna `table`, quitando esa columna del resultado. */
function groupByTable(rows: Row[], omit: string[] = []): Record<string, Row[]> {
	const grouped: Record<string, Row[]> = {};
	const descartar = ['table', ...omit];
	for (const row of rows) {
		const table = String(row.table);
		const clean = Object.fromEntries(Object.entries(row).filter(([key]) => !descartar.includes(key)));
		(grouped[table] ??= []).push(clean);
	}
	return grouped;
}

function buildCatalog(data: Record<QueryName, Row[]>): unknown {
	const columns = groupByTable(data.columns);
	const constraints = groupByTable(data.constraints);
	const indexes = groupByTable(data.indexes);
	const triggers = groupByTable(data.triggers);
	const policies = groupByTable(data.policies);

	const tables: Record<string, unknown> = {};
	for (const row of data.tables) {
		const name = String(row.table);
		tables[name] = {
			comment: row.comment,
			rls: row.rls,
			rls_forced: row.rls_forced,
			columns: columns[name] ?? [],
			constraints: constraints[name] ?? [],
			indexes: indexes[name] ?? [],
			triggers: triggers[name] ?? [],
			policies: policies[name] ?? [],
		};
	}

	const enums: Record<string, string[]> = {};
	for (const row of data.enums) (enums[String(row.name)] ??= []).push(String(row.label));

	const grants: Record<string, Row[]> = groupByTable(data.grants);

	return {
		tables,
		enums,
		extensions: data.extensions,
		grants,
		functions: data.functions,
		cron: (data.cron ?? []).map((job) => ({ ...job, command: redactarSecretos(String(job.command)) })),
		sequences: data.sequences,
		views: data.views,
		otherRoutines: data.otherRoutines,
		otherTypes: data.otherTypes,
		partitioned: data.partitioned.map((row) => row.table),
		server: data.server[0],
	};
}

/** Reproduce el formato de `list_tables` del MCP, que es lo que alimenta los `*.pgmeta.json`. */
function buildListTables(data: Record<QueryName, Row[]>): unknown {
	const columns = groupByTable(data.columns);
	const primaryKeys: Record<string, string[]> = {};
	for (const row of data.constraints) {
		if (row.type !== 'p') continue;
		const cols = /PRIMARY KEY \(([^)]*)\)/.exec(String(row.def))?.[1] ?? '';
		primaryKeys[String(row.table)] = cols.split(',').map((column) => column.trim().replace(/^"|"$/g, ''));
	}

	const foreignKeys: Record<string, Row[]> = {};
	for (const row of data.foreignKeys) {
		const entry = {
			name: row.name,
			source_table: `public.${row.source_table}`,
			source_columns: row.source_columns,
			target_table: `public.${row.target_table}`,
			target_columns: row.target_columns,
		};
		// list_tables adjunta la FK tanto al origen como al destino.
		(foreignKeys[String(row.source_table)] ??= []).push(entry);
		if (row.source_table !== row.target_table) (foreignKeys[String(row.target_table)] ??= []).push(entry);
	}

	return {
		tables: data.tables.map((row) => {
			const name = String(row.table);
			return {
				name: `public.${name}`,
				rls_enabled: row.rls,
				rows: Number(row.rows),
				columns: (columns[name] ?? []).map((column) => ({
					name: column.column,
					data_type: column.data_type,
					format: column.udt,
					type: column.type,
					options: [...(column.notnull ? [] : ['nullable']), 'updatable'],
					...(column.default === null ? {} : { default_value: column.default }),
					...(column.comment === null ? {} : { comment: column.comment }),
				})),
				primary_keys: primaryKeys[name] ?? [],
				foreign_key_constraints: foreignKeys[name] ?? [],
			};
		}),
	};
}

/**
 * Enmascara secretos antes de que el catálogo llegue a disco.
 *
 * `scripts/espejo/snapshots/raw/catalog.json` está commiteado, así que un `cron.job.command` con la
 * service role key adentro —como estaban `check-overdue-invoices-daily` y `salesforce-daily-sync`
 * hasta el 2026-09-22— quedaría en el repo para siempre. La redacción va acá, en la captura, y no
 * en el emisor: un secreto nunca debería existir en memoria más allá de lo necesario, y menos
 * llegar a un archivo versionado.
 *
 * Un comando redactado no coincide con su asset, así que `schema:status` lo marca y el secreto se
 * ve; que es exactamente lo que se quiere que pase.
 */
function redactarSecretos(comando: string): string {
	return comando
		.replace(/Bearer\s+[A-Za-z0-9._-]{20,}/g, 'Bearer <REDACTADO>')
		.replace(/eyJ[A-Za-z0-9._-]{30,}/g, '<JWT-REDACTADO>');
}

function writeJson(file: string, value: unknown): void {
	fs.writeFileSync(file, `${JSON.stringify(value, null, '\t')}\n`, { encoding: 'utf8' });
	console.log(`  escrito ${path.relative(process.cwd(), file)} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
}

async function main(): Promise<void> {
	const target = process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : undefined;
	if (!target) throw new Error('Falta --target <entorno>. Debe coincidir con la base de SUPABASE_DATABASE_URL.');

	const connectionString = process.env.SUPABASE_DATABASE_URL ?? process.env.DATABASE_URL;
	if (!connectionString) throw new Error('SUPABASE_DATABASE_URL o DATABASE_URL debe estar configurada.');

	const resolved = assertConnectionMatchesTarget(connectionString, target);
	console.log(`Capturando ${resolved.projectRef ? `proyecto ${resolved.projectRef}` : 'base local'} (${resolved.environment})`);

	const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
	await client.connect();
	try {
		const data = await capturarDatos(client, console.log);

		fs.mkdirSync(RAW_DIR, { recursive: true });
		writeJson(path.join(RAW_DIR, 'catalog.json'), buildCatalog(data));
		writeJson(path.join(RAW_DIR, 'list-tables.json'), buildListTables(data));

		if (data.partitioned.length > 0) {
			console.warn(`⚠️  Hay ${data.partitioned.length} tablas particionadas: ${data.partitioned.map((r) => r.table).join(', ')}`);
		}
		console.log(`\nPostgres ${String(data.server[0]?.version_num)} · ${data.tables.length} tablas · ${data.functions.length} funciones`);
	} finally {
		await client.end();
	}
}

if (require.main === module) {
	main().catch((error: Error) => {
		console.error(`Error capturando el catálogo: ${error.message}`);
		process.exitCode = 1;
	});
}

export { buildCatalog, buildListTables, capturarCatalogo, capturarDatos, consultarCatalogo, groupByTable, QUERIES };

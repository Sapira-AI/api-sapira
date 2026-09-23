/**
 * generate-assets.ts — emite los assets SQL que TypeORM no puede declarar, a partir
 * del catálogo capturado por `fetch-catalog.ts`.
 *
 * Genera: `types/` (extensiones + enums), `special-index/` (índices con orden
 * explícito o método no btree), `grants/` (permisos por rol), y completa
 * `functions/`, `triggers/` y `rls/` con los objetos de prod que aún no tienen asset.
 *
 * Reglas:
 *  - Las definiciones se emiten **verbatim** desde `pg_get_functiondef`,
 *    `pg_get_triggerdef` y `pg_get_indexdef`. Reformatearlas es la forma más fácil
 *    de introducir una diferencia semántica invisible.
 *  - Nunca sobreescribe un asset existente: el corpus actual fue curado a mano y su
 *    checksum puede estar registrado. Los que difieren de prod se reportan.
 *  - Determinista: mismo catálogo ⇒ mismos bytes. Sin fechas ni versiones en el SQL.
 *
 * Uso:
 *   npx ts-node -r tsconfig-paths/register scripts/schema-as-code/generate-assets.ts [--write]
 */
import * as fs from 'fs';
import * as path from 'path';

const CATALOG = path.resolve(__dirname, '../espejo/snapshots/raw/catalog.json');
const ASSETS = path.resolve(__dirname, '../../src/databases/postgresql');

/** Roles de Supabase a los que se otorgan permisos. `postgres` es el dueño y los tiene por serlo. */
const GRANT_ROLES = ['anon', 'authenticated', 'service_role'] as const;

export interface Catalog {
	tables: Record<string, TableEntry>;
	enums: Record<string, string[]>;
	extensions: { name: string; version: string; schema: string }[];
	grants: Record<string, { grantee: string; privilege: string }[]>;
	functions: { name: string; def: string; extension: string | null; comment?: string | null; identity_args?: string }[];
	/** Secuencias sueltas (sin columna dueña): las de `serial`/`identity` vienen con su tabla. */
	sequences?: { name: string; start: string; increment: string; minvalue: string; maxvalue: string; cache: string; cycle: boolean }[];
	/** Objetos de `public` que ninguna fase modela; los reporta `schema:status` en FUERA DEL CORPUS. */
	views?: { name: string; kind: string; def: string }[];
	otherRoutines?: { name: string; kind: string }[];
	otherTypes?: { name: string; kind: string }[];
	/** Permisos reales, agrupados por firma; `grants/` no es verificable, así que esto es el reporte. */
	aclSignatures?: { tipo: string; firma: string; objetos: number; ejemplos: string[] }[];
	defaultAcls?: { rol: string; esquema: string; tipo: string; concede: string }[];
	/** Jobs de pg_cron. Vacío si la base no tiene la extensión. */
	cron?: { name: string; schedule: string; command: string; active: boolean; username: string; database: string }[];
}

interface TableEntry {
	rls: boolean;
	rls_forced: boolean;
	indexes: { name: string; def: string; unique: boolean; primary: boolean }[];
	triggers: { name: string; def: string }[];
	policies: { name: string; permissive: string; roles: string[]; cmd: string; qual: string | null; with_check: string | null }[];
}

/**
 * Un índice no es declarable con `@Index` si usa un método distinto de btree o si
 * fija el orden de las columnas. Los parciales SÍ lo son (`@Index({ where })`).
 */
function esDeclarable(def: string): boolean {
	const cuerpo = def.includes('USING') ? def.slice(def.indexOf('USING')) : def;
	if (/USING (?!btree)/.test(cuerpo)) return false;
	return !/ DESC|\bNULLS (FIRST|LAST)\b/.test(cuerpo);
}

function idempotente(indexDef: string): string {
	return indexDef.replace(/^CREATE (UNIQUE )?INDEX /, (_match, unique: string | undefined) => `CREATE ${unique ?? ''}INDEX IF NOT EXISTS `);
}

function comillas(nombre: string): string {
	return `"${nombre.replace(/"/g, '""')}"`;
}

/** Nombre de archivo seguro: los nombres de policy llevan espacios y a veces `/`. */
function nombreArchivo(nombre: string): string {
	return nombre.replace(/[/\\]/g, '-');
}

function emitirTypes(catalog: Catalog): Map<string, string> {
	const salida = new Map<string, string>();

	const extensiones = catalog.extensions
		.filter((extension) => !['plpgsql', 'pg_cron', 'supabase_vault'].includes(extension.name))
		.map((extension) => `CREATE EXTENSION IF NOT EXISTS ${comillas(extension.name)} WITH SCHEMA ${comillas(extension.schema)};`);

	salida.set(
		'types/000-extensions.sql',
		[
			'-- Extensiones del esquema public, con el schema real que tienen en producción.',
			'-- `pg_trgm` y `vector` viven en public; `pgcrypto` y `uuid-ossp` en extensions.',
			'-- Se omiten plpgsql (siempre presente), pg_cron y supabase_vault (los gestiona Supabase).',
			'',
			...extensiones,
			'',
		].join('\n')
	);

	for (const [nombre, labels] of Object.entries(catalog.enums).sort(([a], [b]) => a.localeCompare(b))) {
		const valores = labels.map((label) => `'${label.replace(/'/g, "''")}'`).join(', ');
		salida.set(
			`types/010-enum-${nombre}.sql`,
			[
				`-- Enum public.${nombre}. CREATE TYPE no admite IF NOT EXISTS, así que la`,
				'-- idempotencia va por guarda sobre pg_type. El orden de los labels es semántico',
				'-- (comparaciones y ORDER BY) y no se puede alterar después de crearlo.',
				'',
				'DO $$',
				'BEGIN',
				'\tIF NOT EXISTS (',
				'\t\tSELECT 1 FROM pg_type t',
				'\t\tJOIN pg_namespace n ON n.oid = t.typnamespace',
				`\t\tWHERE t.typname = '${nombre}' AND n.nspname = 'public'`,
				'\t) THEN',
				`\t\tCREATE TYPE "public".${comillas(nombre)} AS ENUM (${valores});`,
				'\tEND IF;',
				'END $$;',
				'',
			].join('\n')
		);
	}

	return salida;
}

/**
 * Secuencias sueltas. Van en `types/` —fase no re-aplicable— porque `CREATE SEQUENCE IF NOT EXISTS`
 * no redefine una que ya existe: cambiar el paso o el máximo es una transición y va en migración.
 *
 * No se emite el valor actual (`last_value`): eso es dato, no estado del esquema.
 */
function emitirSequences(catalog: Catalog): Map<string, string> {
	const salida = new Map<string, string>();
	for (const secuencia of [...(catalog.sequences ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
		salida.set(
			`types/020-sequence-${nombreArchivo(secuencia.name)}.sql`,
			[
				`-- Secuencia public.${secuencia.name}, sin columna dueña (no viene de un serial/identity),`,
				'-- así que ninguna entity la declara. El valor actual es dato y no se versiona.',
				'',
				`CREATE SEQUENCE IF NOT EXISTS "public".${comillas(secuencia.name)}`,
				`\tINCREMENT BY ${secuencia.increment}`,
				`\tMINVALUE ${secuencia.minvalue}`,
				`\tMAXVALUE ${secuencia.maxvalue}`,
				`\tSTART WITH ${secuencia.start}`,
				`\tCACHE ${secuencia.cache}`,
				`\t${secuencia.cycle ? 'CYCLE' : 'NO CYCLE'};`,
				'',
			].join('\n')
		);
	}
	return salida;
}

/**
 * Jobs de pg_cron. `cron.schedule` actualiza el job si ya existe uno con ese nombre, así que el
 * asset converge al re-aplicarlo (verificado en QA el 2026-09-22).
 *
 * Dos cosas que no son cosméticas:
 *  - **El rol importa**: la clave del upsert es `(jobname, username)`. Aplicado con otro rol, se
 *    crea un segundo job con el mismo nombre y los dos corren. Por eso el rol esperado va en la
 *    cabecera: los assets se aplican con `postgres`.
 *  - `cron.schedule` no puede dejar un job pausado, así que `active = false` se expresa aparte con
 *    `cron.alter_job`. Se emite solo en ese caso, para que el ida y vuelta sea exacto.
 */
function emitirCron(catalog: Catalog): Map<string, string> {
	const salida = new Map<string, string>();
	for (const job of [...(catalog.cron ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
		const lineas = [
			`-- Job pg_cron ${job.name} (${job.schedule}). Se aplica con el rol ${job.username}:`,
			'-- cron.schedule hace upsert por (jobname, username), así que otro rol crearía un job paralelo.',
			'',
			`SELECT cron.schedule('${job.name.replace(/'/g, "''")}', '${job.schedule.replace(/'/g, "''")}', $cron$${job.command.trim()}$cron$);`,
		];
		if (!job.active) {
			lineas.push('', '-- El job está pausado en la base; cron.schedule no puede expresarlo.');
			lineas.push(`SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = '${job.name.replace(/'/g, "''")}'), active := false);`);
		}
		salida.set(`cron/${nombreArchivo(job.name)}.sql`, `${lineas.join('\n')}\n`);
	}
	return salida;
}

function emitirSpecialIndex(catalog: Catalog): Map<string, string> {
	const salida = new Map<string, string>();
	for (const [tabla, entry] of Object.entries(catalog.tables).sort(([a], [b]) => a.localeCompare(b))) {
		for (const index of entry.indexes.filter((i) => !i.primary && !esDeclarable(i.def))) {
			salida.set(
				`special-index/${nombreArchivo(index.name)}.sql`,
				[
					`-- Índice de public.${tabla} que TypeORM no puede declarar con @Index`,
					'-- (método no btree, u orden explícito de columnas). Definición verbatim de prod.',
					'',
					`${idempotente(index.def)};`,
					'',
				].join('\n')
			);
		}
	}
	return salida;
}

function emitirGrants(catalog: Catalog): Map<string, string> {
	const roles = GRANT_ROLES.join(', ');
	const firmas = new Set(
		Object.values(catalog.grants).map((filas) =>
			JSON.stringify([...new Set(filas.map((f) => `${f.grantee}:${f.privilege}`))].sort((a, b) => a.localeCompare(b)))
		)
	);

	const contenido = [
		'-- Permisos por rol. En producción las 132 tablas comparten una única firma:',
		'-- ALL PRIVILEGES para anon, authenticated, postgres y service_role, así que la',
		`-- contención real la hace RLS, no el GRANT. (Firmas distintas medidas: ${firmas.size}.)`,
		'--',
		'-- GRANT y RLS son capas independientes: sin el GRANT la policy nunca se evalúa y el',
		'-- error es `permission denied`, no "0 filas". Sin este asset, un entorno levantado',
		'-- desde cero tendría tablas correctas e inaccesibles para el front.',
		'',
		`GRANT ALL ON ALL TABLES IN SCHEMA "public" TO ${roles};`,
		`GRANT ALL ON ALL SEQUENCES IN SCHEMA "public" TO ${roles};`,
		`GRANT USAGE ON SCHEMA "public" TO ${roles};`,
		'',
		'-- Para que las tablas creadas después hereden los mismos permisos.',
		`ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT ALL ON TABLES TO ${roles};`,
		`ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT ALL ON SEQUENCES TO ${roles};`,
		'',
	].join('\n');

	return new Map([['grants/000-table-privileges.sql', contenido]]);
}

function emitirFunciones(catalog: Catalog): Map<string, string> {
	const porNombre = new Map<string, Catalog['functions']>();
	for (const funcion of catalog.functions) {
		if (funcion.extension) continue; // la instaló una extensión, no es nuestra
		porNombre.set(funcion.name, [...(porNombre.get(funcion.name) ?? []), funcion]);
	}

	const salida = new Map<string, string>();
	for (const [nombre, funciones] of [...porNombre].sort(([a], [b]) => a.localeCompare(b))) {
		// Las sobrecargas comparten nombre: todas van al mismo asset, en orden estable, separadas
		// por `;` — sin él, el runner no puede aplicar un archivo con más de una definición
		// (pg_get_functiondef no lo emite y dos CREATE seguidos son un error de sintaxis).
		const ordenadas = [...funciones].sort((a, b) => a.def.localeCompare(b.def));
		const cuerpo = ordenadas.map((funcion) => funcion.def.trimEnd()).join(';\n\n');

		// Los COMMENT ON van todos al final, después de las definiciones, y no intercalados: así un
		// archivo con cabecera escrita a mano se actualiza agregando líneas al final, sin reescribirlo.
		const comentarios = ordenadas
			.filter((funcion) => funcion.comment)
			.map((funcion) => `COMMENT ON FUNCTION public.${comillas(nombre)}(${funcion.identity_args ?? ''}) IS ${ts_sql(funcion.comment)};`);

		salida.set(`functions/${nombreArchivo(nombre)}.sql`, comentarios.length > 0 ? `${cuerpo};\n\n${comentarios.join('\n')}\n` : `${cuerpo}\n`);
	}
	return salida;
}

/** Literal SQL de un texto: comilla simple duplicada, saltos de línea tal cual. */
function ts_sql(valor: string | null | undefined): string {
	return `'${(valor ?? '').replace(/'/g, "''")}'`;
}

function emitirTriggers(catalog: Catalog): Map<string, string> {
	const salida = new Map<string, string>();
	for (const [tabla, entry] of Object.entries(catalog.tables).sort(([a], [b]) => a.localeCompare(b))) {
		for (const trigger of [...entry.triggers].sort((a, b) => a.name.localeCompare(b.name))) {
			salida.set(
				`triggers/${nombreArchivo(trigger.name)}.sql`,
				[`DROP TRIGGER IF EXISTS ${comillas(trigger.name)} ON "public".${comillas(tabla)};`, '', `${trigger.def};`, ''].join('\n')
			);
		}
	}
	return salida;
}

function emitirPolicies(catalog: Catalog): Map<string, string> {
	const usados = new Map<string, string>();
	const salida = new Map<string, string>();

	for (const [tabla, entry] of Object.entries(catalog.tables).sort(([a], [b]) => a.localeCompare(b))) {
		for (const policy of [...entry.policies].sort((a, b) => a.name.localeCompare(b.name))) {
			// Un nombre de policy se repite en dos tablas: se desambigua con la tabla.
			const base = nombreArchivo(policy.name);
			const clave = usados.has(base) && usados.get(base) !== tabla ? `${base} (${tabla})` : base;
			usados.set(base, tabla);

			const lineas = [
				`DROP POLICY IF EXISTS ${comillas(policy.name)} ON "public".${comillas(tabla)};`,
				'',
				`CREATE POLICY ${comillas(policy.name)}`,
				`ON "public".${comillas(tabla)}`,
				`AS ${policy.permissive.toUpperCase()}`,
				`FOR ${policy.cmd}`,
				`TO ${policy.roles.join(', ')}`,
			];
			if (policy.qual !== null) lineas.push(`USING (${policy.qual})`);
			if (policy.with_check !== null) lineas.push(`WITH CHECK (${policy.with_check})`);

			salida.set(`rls/${clave}.sql`, `${lineas.join('\n')};\n`);
		}
	}
	return salida;
}

/** Emisores en orden de fase. `emitirCorpus` y `main()` comparten esta lista para no divergir. */
const EMISORES: [string, (catalog: Catalog) => Map<string, string>][] = [
	['types', emitirTypes],
	// Misma fase `types/`; la etiqueta solo separa el conteo que imprime main().
	['types (secuencias)', emitirSequences],
	['special-index', emitirSpecialIndex],
	['grants', emitirGrants],
	['functions', emitirFunciones],
	['triggers', emitirTriggers],
	['rls', emitirPolicies],
	['cron', emitirCron],
];

/**
 * Todo lo que el generador produce desde un catálogo, indexado por ruta relativa del asset.
 *
 * Es la referencia contra la que `schema:status` y `postgres:assets --baseline` comparan
 * los archivos del repo: si un archivo es idéntico a lo que la base viva genera, el objeto
 * existe en esa base tal como lo describe el archivo.
 */
function emitirCorpus(catalog: Catalog): Map<string, string> {
	return new Map(EMISORES.flatMap(([, emisor]) => [...emisor(catalog)]));
}

function main(): void {
	const escribir = process.argv.includes('--write');
	// Realinea con producción los assets que quedaron desfasados. Solo es seguro
	// mientras ningún checksum esté registrado: después, una corrección va en un asset nuevo.
	const reescribir = process.argv.includes('--overwrite-stale');
	const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8')) as Catalog;

	const fases: [string, Map<string, string>][] = EMISORES.map(([fase, emisor]) => [fase, emisor(catalog)]);

	const difieren: string[] = [];
	for (const [fase, archivos] of fases) {
		let creados = 0;
		let actualizados = 0;
		let intactos = 0;
		for (const [relativo, contenido] of [...archivos].sort(([a], [b]) => a.localeCompare(b))) {
			const destino = path.join(ASSETS, relativo);
			if (fs.existsSync(destino)) {
				if (fs.readFileSync(destino, 'utf8').trim() === contenido.trim()) {
					intactos += 1;
					continue;
				}
				difieren.push(relativo);
				if (!reescribir) {
					intactos += 1;
					continue;
				}
				actualizados += 1;
				if (escribir) fs.writeFileSync(destino, contenido, { encoding: 'utf8' });
				continue;
			}
			creados += 1;
			if (escribir) {
				fs.mkdirSync(path.dirname(destino), { recursive: true });
				fs.writeFileSync(destino, contenido, { encoding: 'utf8' });
			}
		}
		const verbo = escribir ? 'creados' : 'por crear';
		const alineados = reescribir ? `, ${actualizados} ${escribir ? 'actualizados' : 'por actualizar'}` : '';
		console.log(`  ${fase.padEnd(14)} ${String(creados).padStart(4)} ${verbo}${alineados}, ${intactos} sin cambios`);
	}

	if (difieren.length > 0 && !reescribir) {
		console.log(`\n⚠️  ${difieren.length} assets existentes difieren de producción (no se tocaron; usa --overwrite-stale):`);
		for (const relativo of difieren.slice(0, 15)) console.log(`     ${relativo}`);
		if (difieren.length > 15) console.log(`     … y ${difieren.length - 15} más`);
	}
	if (!escribir) console.log('\n(simulación: usa --write para escribir)');
}

if (require.main === module) main();

export {
	emitirCorpus,
	emitirCron,
	emitirFunciones,
	emitirGrants,
	emitirPolicies,
	emitirSequences,
	emitirSpecialIndex,
	emitirTriggers,
	emitirTypes,
	esDeclarable,
	idempotente,
};

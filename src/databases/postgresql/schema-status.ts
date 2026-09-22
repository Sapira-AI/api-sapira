/**
 * Estado de una base respecto del repo: qué migraciones faltan, en qué estado está cada asset
 * SQL, y si la base coincide con lo que describe cada archivo.
 *
 * Es la lógica de `yarn schema:status` y de la verificación que usa `postgres:assets --baseline`.
 * Todo acá es puro o de solo lectura: el I/O contra la base lo hace el script, dentro de una
 * transacción READ ONLY.
 *
 * La verificación compara cada archivo con el contenido que `generate-assets.ts` emite desde el
 * catálogo de la base viva. Si son idénticos, el objeto existe en esa base tal como lo describe
 * el archivo; es la misma comparación que ya usaba `generate-assets` contra el snapshot de prod.
 */
import * as fs from 'fs';
import * as path from 'path';

import { REAPPLICABLE_DIRECTORIES, SqlAsset, SqlExecutor, UNVERIFIABLE_DIRECTORIES } from './assets-runner';

/** Resultado de comparar un archivo con lo que genera la base. */
export type Verificacion =
	/** El archivo es idéntico a lo que genera la base. */
	| 'igual'
	/** El objeto existe en la base con otra definición. */
	| 'distinto'
	/**
	 * La base no genera nada con esa ruta: el objeto no existe ahí, o el archivo tiene un nombre
	 * que el generador no produce (asset escrito a mano con otro nombre).
	 */
	| 'sin-contraparte'
	/** Fase que la comparación no puede probar (`grants/`, `seed/`). */
	| 'no-verificable';

export interface ComparacionCorpus {
	porAsset: Map<string, Verificacion>;
	/** Objetos que existen en la base y no tienen archivo en el repo. */
	soloEnBase: string[];
}

export function compararConCorpusGenerado(assets: SqlAsset[], generado: ReadonlyMap<string, string>): ComparacionCorpus {
	const porAsset = new Map<string, Verificacion>();
	for (const asset of assets) {
		const fase = asset.path.split('/')[0];
		if (esNoVerificable(fase)) porAsset.set(asset.path, 'no-verificable');
		else if (!generado.has(asset.path)) porAsset.set(asset.path, 'sin-contraparte');
		else porAsset.set(asset.path, normalizarSql(generado.get(asset.path)) === normalizarSql(asset.sql) ? 'igual' : 'distinto');
	}

	const soloEnBase = [...generado.keys()]
		.filter((ruta) => !porAsset.has(ruta) && !esNoVerificable(ruta.split('/')[0]))
		.sort((a, b) => a.localeCompare(b));

	return { porAsset, soloEnBase };
}

/**
 * Forma canónica para comparar un archivo con lo que genera la base.
 *
 * Más laxa que la de `generate-assets` (que decide si reescribir un archivo y necesita bytes
 * exactos), porque acá la pregunta es otra: ¿el objeto de la base es el que describe el archivo?
 * Un asset escrito a mano con un comentario de cabecera, o con el `CREATE TRIGGER` partido en
 * líneas, describe el mismo objeto que la versión de `pg_get_triggerdef`; con igualdad exacta
 * quedaría marcado como DERIVA para siempre.
 *
 * Lo que ignora:
 *  - líneas que son solo comentario (`-- …`) y líneas vacías;
 *  - la cantidad de espacios y saltos de línea;
 *  - las comillas en identificadores simples en minúscula (`"public"."tabla"` ≡ `public.tabla`),
 *    que en Postgres no cambian el nombre.
 *
 * Dentro de un literal de texto esos tres cambios sí serían una diferencia real; se acepta ese
 * falso "igual" porque exige que dos definiciones difieran SOLO en eso.
 */
export function normalizarSql(sql: string): string {
	return sql
		.split('\n')
		.filter((linea) => linea.trim() !== '' && !/^\s*--/.test(linea))
		.join(' ')
		.replace(/"([a-z_][a-z0-9_]*)"/g, '$1')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Rutas que `--baseline` puede registrar: verificadas idénticas a la base. */
export function assetsVerificados(comparacion: ComparacionCorpus): Set<string> {
	return new Set([...comparacion.porAsset].filter(([, verificacion]) => verificacion === 'igual').map(([ruta]) => ruta));
}

/**
 * Qué corresponde hacer con cada asset.
 *
 * - `APLICADO`: registrado con el checksum vigente, y la base coincide (o no se puede verificar;
 *   un objeto registrado que se borró por fuera con un nombre no generable no se detecta).
 * - `DERIVA`: registrado con el checksum vigente, pero la base tiene otra definición. Alguien cambió
 *   el objeto por fuera del runner. `apply` lo omitiría: hay que decidir quién tiene razón.
 * - `REAPLICAR`: registrado, el archivo cambió, y su fase converge. `apply` lo re-ejecuta.
 * - `BLOQUEADO`: registrado, el archivo cambió, y su fase NO converge. `apply` falla: va en migración.
 * - `LINEA BASE`: sin registrar, pero la base ya coincide. `--baseline` lo registra sin ejecutar.
 * - `PENDIENTE`: sin registrar y la base tiene otra definición. `apply` la reemplaza por la del archivo.
 * - `NO CONVERGE`: como PENDIENTE, pero en una fase donde aplicar no cambia la base (enum con
 *   guarda, `CREATE INDEX IF NOT EXISTS`). Registrarlo haría mentir al historial: va en migración.
 * - `SIN CONTRAPARTE`: sin registrar y la base no tiene ese objeto (o el archivo tiene otro nombre).
 *   `apply` lo crearía: revisar antes si el objeto debe existir.
 * - `NO VERIFICABLE`: sin registrar, en `grants/` o `seed/`. Se aplica a conciencia con `--only`.
 */
export type AccionAsset =
	| 'APLICADO'
	| 'DERIVA'
	| 'REAPLICAR'
	| 'BLOQUEADO'
	| 'LINEA BASE'
	| 'PENDIENTE'
	| 'NO CONVERGE'
	| 'SIN CONTRAPARTE'
	| 'NO VERIFICABLE';

/** Orden en que se reportan: primero lo que exige una decisión. */
export const ACCIONES: readonly AccionAsset[] = [
	'DERIVA',
	'BLOQUEADO',
	'NO CONVERGE',
	'SIN CONTRAPARTE',
	'PENDIENTE',
	'REAPLICAR',
	'NO VERIFICABLE',
	'LINEA BASE',
	'APLICADO',
];

export interface EstadoAsset {
	path: string;
	accion: AccionAsset;
}

export function clasificarAssets(assets: SqlAsset[], historial: ReadonlyMap<string, string> | null, comparacion: ComparacionCorpus): EstadoAsset[] {
	return assets.map((asset) => ({ path: asset.path, accion: clasificar(asset, historial?.get(asset.path), comparacion.porAsset.get(asset.path)) }));
}

function clasificar(asset: SqlAsset, checksumRegistrado: string | undefined, verificacion: Verificacion | undefined): AccionAsset {
	const fase = asset.path.split('/')[0];

	if (checksumRegistrado !== undefined) {
		if (checksumRegistrado !== asset.checksum) {
			return (REAPPLICABLE_DIRECTORIES as readonly string[]).includes(fase) ? 'REAPLICAR' : 'BLOQUEADO';
		}
		// Solo `distinto` prueba deriva. `sin-contraparte` en un asset registrado casi siempre es un
		// nombre que el generador no produce (p. ej. un índice btree declarable escrito como asset),
		// no un objeto borrado: marcarlo DERIVA sería un falso positivo permanente.
		return verificacion === 'distinto' ? 'DERIVA' : 'APLICADO';
	}

	switch (verificacion) {
		case 'igual':
			return 'LINEA BASE';
		case 'distinto':
			return (REAPPLICABLE_DIRECTORIES as readonly string[]).includes(fase) ? 'PENDIENTE' : 'NO CONVERGE';
		case 'sin-contraparte':
			return 'SIN CONTRAPARTE';
		default:
			return 'NO VERIFICABLE';
	}
}

export function contarPorAccion(estados: EstadoAsset[]): Map<AccionAsset, number> {
	const conteo = new Map<AccionAsset, number>(ACCIONES.map((accion) => [accion, 0]));
	for (const estado of estados) conteo.set(estado.accion, conteo.get(estado.accion) + 1);
	return conteo;
}

function esNoVerificable(fase: string): boolean {
	return (UNVERIFIABLE_DIRECTORIES as readonly string[]).includes(fase);
}

// ── Objetos que ninguna fase del corpus modela ─────────────────────────────────

export interface ObjetoNoModelado {
	tipo: string;
	nombre: string;
}

/**
 * Objetos de `public` que existen en la base y **ninguna fase del corpus puede describir**.
 *
 * `soloEnBase` no alcanza: se deriva de lo que los emisores producen, así que una vista, una
 * secuencia suelta o un procedimiento son invisibles para él —no hay contra qué compararlos—.
 * Esto los nombra explícitamente, que es la diferencia entre "el repo describe todo el esquema" y
 * "el repo describe lo que sabe describir".
 *
 * Una secuencia deja de figurar acá en cuanto el emisor la produce: se compara contra `generado`,
 * no contra una lista fija.
 */
export function objetosNoModelados(
	catalogo: {
		views?: { name: string; kind: string }[];
		sequences?: { name: string }[];
		otherRoutines?: { name: string; kind: string }[];
		otherTypes?: { name: string; kind: string }[];
	},
	generado: ReadonlyMap<string, string>
): ObjetoNoModelado[] {
	const emitido = new Set(generado.keys());
	const fuera: ObjetoNoModelado[] = [];

	for (const vista of catalogo.views ?? []) {
		fuera.push({ tipo: vista.kind === 'm' ? 'vista materializada' : 'vista', nombre: vista.name });
	}
	for (const secuencia of catalogo.sequences ?? []) {
		if (![...emitido].some((ruta) => ruta.endsWith(`sequence-${secuencia.name}.sql`))) {
			fuera.push({ tipo: 'secuencia', nombre: secuencia.name });
		}
	}
	for (const rutina of catalogo.otherRoutines ?? []) {
		fuera.push({ tipo: rutina.kind === 'p' ? 'procedimiento' : 'agregado o función de ventana', nombre: rutina.name });
	}
	for (const tipo of catalogo.otherTypes ?? []) {
		fuera.push({ tipo: tipo.kind === 'd' ? 'dominio' : tipo.kind === 'r' ? 'rango' : 'tipo compuesto', nombre: tipo.name });
	}

	return fuera.sort((a, b) => a.tipo.localeCompare(b.tipo) || a.nombre.localeCompare(b.nombre));
}

// ── Migraciones ────────────────────────────────────────────────────────────────

export const MIGRATIONS_TABLE = 'public.sapira_typeorm_migrations';

export interface EstadoMigraciones {
	/** `false` si la base nunca corrió migraciones (la tabla no existe). */
	tablaExiste: boolean;
	/** Declaradas en el repo y sin ejecutar, en orden de ejecución. */
	pendientes: string[];
	/** Ejecutadas en la base y sin archivo en el repo: alguien borró o renombró una migración. */
	sinArchivo: string[];
}

/**
 * Nombres de las migraciones del repo, como los resuelve TypeORM (`migration.name ?? constructor.name`),
 * ordenados por su timestamp final, que es el orden en que TypeORM las ejecuta.
 */
export function leerMigracionesDeclaradas(directorio: string): string[] {
	const nombres = fs
		.readdirSync(directorio)
		.filter((archivo) => /\.(ts|js)$/.test(archivo) && !/\.(spec|d)\.ts$/.test(archivo))
		.flatMap((archivo) => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const modulo = require(path.join(directorio, archivo)) as Record<string, unknown>;
			return Object.values(modulo)
				.filter((exportado): exportado is new () => { name?: string } => typeof exportado === 'function')
				.map((Clase) => new Clase().name ?? Clase.name);
		});

	return nombres.sort((a, b) => timestampDe(a) - timestampDe(b));
}

export function calcularMigracionesPendientes(declaradas: string[], ejecutadas: string[] | null): EstadoMigraciones {
	if (ejecutadas === null) return { tablaExiste: false, pendientes: [...declaradas], sinArchivo: [] };

	const hechas = new Set(ejecutadas);
	const enRepo = new Set(declaradas);
	return {
		tablaExiste: true,
		pendientes: declaradas.filter((nombre) => !hechas.has(nombre)),
		sinArchivo: ejecutadas.filter((nombre) => !enRepo.has(nombre)),
	};
}

/** Migraciones ejecutadas en la base, o `null` si la tabla no existe. Solo lectura. */
export async function leerMigracionesEjecutadas(executor: SqlExecutor): Promise<string[] | null> {
	const existe = await executor.query('SELECT to_regclass($1) AS tabla', [MIGRATIONS_TABLE]);
	if (!existe.rows[0]?.tabla) return null;

	const { rows } = await executor.query(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY timestamp, id`);
	return rows.map((row) => String(row.name));
}

function timestampDe(nombre: string): number {
	return Number(/(\d{13})$/.exec(nombre)?.[1] ?? Number.MAX_SAFE_INTEGER);
}

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Fases del corpus, en orden de aplicación. Debe coincidir con `directories` de
 * `assets.manifest.json`: un test lo verifica, porque el manifest tapaba esta
 * constante y la divergencia pasó inadvertida.
 *
 * No hay fase `tables`: las tablas las define su entity TypeORM y se crean con
 * migraciones revisadas, no con assets.
 */
export const ASSET_DIRECTORIES = ['types', 'functions', 'special-index', 'triggers', 'rls', 'grants', 'seed'] as const;
export const HISTORY_TABLE = 'public.sapira_sql_asset_history';

/**
 * Fases donde **re-aplicar un asset modificado hace que la base coincida con el archivo**.
 *
 * Es el criterio exacto, no una preferencia: `functions/` usa `CREATE OR REPLACE`, `triggers/` y
 * `rls/` usan `DROP … IF EXISTS` + `CREATE`, y `grants/` son sentencias absolutas. En las cuatro,
 * correr el archivo de nuevo deja el objeto tal como lo describe el archivo.
 *
 * Sin esto, cambiar una función obligaba a crear un archivo nuevo —`<objeto>_<motivo>.sql`— y
 * dejar el viejo para siempre. Eso rompe dos cosas: el corpus deja de describir el estado deseado
 * (para saber qué hace una función hay que saber cuál de N archivos ganó, que es exactamente el
 * problema de las 465 migraciones del front), y **el que gana lo decide el orden alfabético, que no
 * es el cronológico**: un arreglo posterior llamado `…_arreglo.sql` se aplicaría ANTES que un
 * `…_view_documentacion.sql` anterior, y quedaría pisado por él.
 *
 * El historial sigue registrando el checksum vigente, así que un asset sin cambios se sigue
 * omitiendo. Lo que cambia es que un asset modificado se re-aplica en vez de hacer fallar la corrida.
 */
export const REAPPLICABLE_DIRECTORIES = ['functions', 'triggers', 'rls', 'grants'] as const;

/** Por qué las otras tres fases NO se pueden re-aplicar: el archivo cambiaría y la base no. */
const MOTIVO_NO_REAPLICABLE: Record<string, string> = {
	types: 'los enums llevan guarda `DO … pg_type` y las extensiones `IF NOT EXISTS`, así que no modifican un tipo que ya existe',
	'special-index': '`CREATE INDEX IF NOT EXISTS` no redefine un índice existente: lo saltea',
	seed: '`ON CONFLICT DO NOTHING` no actualiza ni borra filas ya insertadas',
};

export type AssetMode = 'plan' | 'dry-run' | 'apply';

export interface SqlAsset {
	path: string;
	sql: string;
	checksum: string;
}

export interface AssetManifest {
	version: 1;
	directories?: string[];
	order?: string[];
}

export interface SqlQueryResult<Row = Record<string, unknown>> {
	rows: Row[];
}

export interface SqlExecutor {
	query(query: string, values?: unknown[]): Promise<SqlQueryResult>;
}

export interface AssetRunnerOptions {
	assetsRoot: string;
	mode: AssetMode;
	target: string;
	allowProduction?: boolean;
	confirmTarget?: string;
	/**
	 * Si se define, limita la corrida a los assets cuyo path relativo coincida
	 * (exacto) con alguno de estos valores. Útil para aplicar un asset puntual
	 * sin tocar el manifest. Un path que no exista lanza error.
	 */
	only?: string[];
}

export interface AssetRunResult {
	assets: SqlAsset[];
	applied: string[];
	skipped: string[];
	pending: string[];
	/** Assets que ya estaban aplicados, cambiaron, y se volvieron a aplicar (solo fases re-aplicables). */
	reapplied: string[];
}

interface HistoryRow {
	asset_path: string;
	checksum: string;
}

const MANIFEST_FILE = 'assets.manifest.json';

export function checksumSql(sql: string): string {
	return crypto.createHash('sha256').update(sql).digest('hex');
}

export function assertTargetAllowed(options: Pick<AssetRunnerOptions, 'mode' | 'target' | 'allowProduction' | 'confirmTarget'>): void {
	if (options.mode !== 'apply' || options.target !== 'production') return;

	if (!options.allowProduction || options.confirmTarget !== 'production') {
		throw new Error('Aplicar assets en production requiere --allow-production y --confirm-target production.');
	}
}

export function discoverSqlAssets(assetsRoot: string): SqlAsset[] {
	const manifest = readManifest(assetsRoot);
	const directories = manifest.directories ?? [...ASSET_DIRECTORIES];
	const files = directories.flatMap((directory, directoryIndex) =>
		listSqlFiles(path.join(assetsRoot, directory)).map((absolutePath) => ({
			absolutePath,
			relativePath: toPosixPath(path.relative(assetsRoot, absolutePath)),
			directoryIndex,
		}))
	);
	const order = new Map((manifest.order ?? []).map((assetPath, index) => [assetPath, index]));

	files.sort((left, right) => {
		const leftOrder = order.get(left.relativePath);
		const rightOrder = order.get(right.relativePath);
		if (leftOrder !== undefined || rightOrder !== undefined) {
			if (leftOrder === undefined) return 1;
			if (rightOrder === undefined) return -1;
			return leftOrder - rightOrder;
		}

		return left.directoryIndex - right.directoryIndex || left.relativePath.localeCompare(right.relativePath);
	});

	return files.map(({ absolutePath, relativePath }) => {
		const sql = fs.readFileSync(absolutePath, 'utf8');
		return { path: relativePath, sql, checksum: checksumSql(sql) };
	});
}

export function filterAssetsByOnly(assets: SqlAsset[], only?: string[]): SqlAsset[] {
	if (!only || only.length === 0) return assets;

	const requested = only.map((value) => toPosixPath(value));
	const available = new Set(assets.map((asset) => asset.path));
	const missing = requested.filter((value) => !available.has(value));
	if (missing.length > 0) {
		throw new Error(`--only no coincide con ningún asset descubierto: ${missing.join(', ')}`);
	}

	const requestedSet = new Set(requested);
	return assets.filter((asset) => requestedSet.has(asset.path));
}

export async function runSqlAssets(executor: SqlExecutor | undefined, options: AssetRunnerOptions): Promise<AssetRunResult> {
	assertTargetAllowed(options);
	const assets = filterAssetsByOnly(discoverSqlAssets(options.assetsRoot), options.only);
	const result: AssetRunResult = { assets, applied: [], skipped: [], pending: [], reapplied: [] };

	if (options.mode === 'plan') {
		result.pending = assets.map((asset) => asset.path);
		return result;
	}

	if (!executor) throw new Error('Se requiere una conexión PostgreSQL para dry-run o apply.');
	if (options.mode === 'apply') await ensureHistoryTable(executor);
	const historyAvailable = options.mode === 'apply' || (await historyTableExists(executor));

	for (const asset of assets) {
		if (!historyAvailable) {
			result.pending.push(asset.path);
			continue;
		}

		const history = await readHistory(executor, asset.path);
		if (history) {
			if (history.checksum === asset.checksum) {
				result.skipped.push(asset.path);
				continue;
			}

			// El asset cambió después de aplicarse. Si su fase converge al re-aplicarlo, se
			// re-aplica; si no, el archivo cambiaría y la base no, y registrar el checksum nuevo
			// sería que el historial mienta.
			const fase = asset.path.split('/')[0];
			if (!(REAPPLICABLE_DIRECTORIES as readonly string[]).includes(fase)) {
				throw new Error(
					`El checksum de ${asset.path} cambió después de aplicarse, y la fase \`${fase}\` no se puede re-aplicar: ` +
						`${MOTIVO_NO_REAPLICABLE[fase] ?? 'la fase no es idempotente'}. ` +
						`Ese cambio es una transición, no un estado: va en una migración.`
				);
			}

			if (options.mode === 'dry-run') {
				result.pending.push(asset.path);
				continue;
			}

			await applyAsset(executor, asset, options.target);
			result.reapplied.push(asset.path);
			continue;
		}

		if (options.mode === 'dry-run') {
			result.pending.push(asset.path);
			continue;
		}

		await applyAsset(executor, asset, options.target);
		result.applied.push(asset.path);
	}

	return result;
}

async function ensureHistoryTable(executor: SqlExecutor): Promise<void> {
	await executor.query(`
		CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
			asset_path text PRIMARY KEY,
			checksum char(64) NOT NULL,
			target text NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT now()
		)
	`);
}

async function historyTableExists(executor: SqlExecutor): Promise<boolean> {
	const result = await executor.query(`SELECT to_regclass($1) AS history_table`, [HISTORY_TABLE]);
	return Boolean(result.rows[0]?.history_table);
}

async function readHistory(executor: SqlExecutor, assetPath: string): Promise<HistoryRow | undefined> {
	const result = await executor.query(`SELECT asset_path, checksum FROM ${HISTORY_TABLE} WHERE asset_path = $1`, [assetPath]);
	const row = result.rows[0];
	if (typeof row?.asset_path !== 'string' || typeof row.checksum !== 'string') return undefined;
	return { asset_path: row.asset_path, checksum: row.checksum };
}

async function applyAsset(executor: SqlExecutor, asset: SqlAsset, target: string): Promise<void> {
	await executor.query('BEGIN');
	try {
		await executor.query(asset.sql);
		// UPSERT y no INSERT: un asset re-aplicado tiene que dejar registrado su checksum NUEVO,
		// para que la siguiente corrida lo omita en vez de volver a aplicarlo.
		await executor.query(
			`INSERT INTO ${HISTORY_TABLE} (asset_path, checksum, target) VALUES ($1, $2, $3)
			 ON CONFLICT (asset_path) DO UPDATE SET checksum = EXCLUDED.checksum, target = EXCLUDED.target, applied_at = now()`,
			[asset.path, asset.checksum, target]
		);
		await executor.query('COMMIT');
	} catch (error) {
		await executor.query('ROLLBACK');
		throw error;
	}
}

function readManifest(assetsRoot: string): AssetManifest {
	const manifestPath = path.join(assetsRoot, MANIFEST_FILE);
	if (!fs.existsSync(manifestPath)) return { version: 1 };

	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as AssetManifest;
	if (manifest.version !== 1) throw new Error(`${MANIFEST_FILE} debe declarar "version": 1.`);
	if (manifest.directories?.some((directory) => directory.includes('..') || path.isAbsolute(directory))) {
		throw new Error(`${MANIFEST_FILE} contiene un directorio no permitido.`);
	}
	if (manifest.order?.some((assetPath) => assetPath.includes('..') || path.isAbsolute(assetPath) || !assetPath.endsWith('.sql'))) {
		throw new Error(`${MANIFEST_FILE} contiene una ruta de asset no permitida.`);
	}

	return manifest;
}

function listSqlFiles(directory: string): string[] {
	if (!fs.existsSync(directory)) return [];

	return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) return listSqlFiles(entryPath);
		return entry.isFile() && entry.name.endsWith('.sql') ? [entryPath] : [];
	});
}

function toPosixPath(filePath: string): string {
	return filePath.split(path.sep).join('/');
}

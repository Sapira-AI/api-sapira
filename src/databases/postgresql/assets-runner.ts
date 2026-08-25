import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const ASSET_DIRECTORIES = ['functions', 'special-index', 'triggers', 'rls'] as const;
export const HISTORY_TABLE = 'public.sapira_sql_asset_history';

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
}

export interface AssetRunResult {
	assets: SqlAsset[];
	applied: string[];
	skipped: string[];
	pending: string[];
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

export async function runSqlAssets(executor: SqlExecutor | undefined, options: AssetRunnerOptions): Promise<AssetRunResult> {
	assertTargetAllowed(options);
	const assets = discoverSqlAssets(options.assetsRoot);
	const result: AssetRunResult = { assets, applied: [], skipped: [], pending: [] };

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
			if (history.checksum !== asset.checksum) {
				throw new Error(`El checksum de ${asset.path} cambió después de aplicarse. Crea un nuevo asset en vez de editarlo.`);
			}
			result.skipped.push(asset.path);
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
		await executor.query(`INSERT INTO ${HISTORY_TABLE} (asset_path, checksum, target) VALUES ($1, $2, $3)`, [asset.path, asset.checksum, target]);
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

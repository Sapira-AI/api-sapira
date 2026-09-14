import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	assertTargetAllowed,
	ASSET_DIRECTORIES,
	checksumSql,
	discoverSqlAssets,
	filterAssetsByOnly,
	runSqlAssets,
	SqlExecutor,
} from './assets-runner';

class InMemoryExecutor implements SqlExecutor {
	readonly queries: string[] = [];
	private readonly history = new Map<string, string>();

	async query(query: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
		this.queries.push(query);
		if (query.includes('SELECT asset_path, checksum')) {
			const checksum = this.history.get(values?.[0] as string);
			return { rows: checksum ? [{ asset_path: values?.[0], checksum }] : [] };
		}
		if (query.includes('INSERT INTO public.sapira_sql_asset_history')) {
			this.history.set(values?.[0] as string, values?.[1] as string);
		}
		return { rows: [] };
	}
}

describe('PostgreSQL SQL assets runner', () => {
	let assetsRoot: string;

	beforeEach(() => {
		assetsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sapira-assets-'));
		for (const directory of ['functions', 'special-index', 'triggers', 'rls']) {
			fs.mkdirSync(path.join(assetsRoot, directory), { recursive: true });
		}
		fs.writeFileSync(path.join(assetsRoot, 'functions', 'a.sql'), 'SELECT 1;\n');
		fs.writeFileSync(path.join(assetsRoot, 'functions', 'z.sql'), 'SELECT 2;\n');
		fs.writeFileSync(path.join(assetsRoot, 'special-index', 'index.sql'), 'CREATE INDEX IF NOT EXISTS sample_index ON sample (id);\n');
		fs.writeFileSync(path.join(assetsRoot, 'triggers', 'trigger.sql'), 'SELECT 3;\n');
		fs.writeFileSync(path.join(assetsRoot, 'rls', 'policy.sql'), 'SELECT 4;\n');
		fs.writeFileSync(
			path.join(assetsRoot, 'assets.manifest.json'),
			JSON.stringify({ version: 1, directories: ['functions', 'special-index', 'triggers', 'rls'], order: ['functions/z.sql'] })
		);
	});

	afterEach(() => fs.rmSync(assetsRoot, { recursive: true, force: true }));

	it('uses manifest priority then deterministic directory ordering', () => {
		expect(discoverSqlAssets(assetsRoot).map((asset) => asset.path)).toEqual([
			'functions/z.sql',
			'functions/a.sql',
			'special-index/index.sql',
			'triggers/trigger.sql',
			'rls/policy.sql',
		]);
	});

	it('generates stable SHA-256 checksums', () => {
		expect(checksumSql('SELECT 1;\n')).toBe('b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd');
		expect(checksumSql('SELECT 1;\n')).toBe(checksumSql('SELECT 1;\n'));
	});

	it('records applied assets and skips them idempotently', async () => {
		const executor = new InMemoryExecutor();
		const options = { assetsRoot, mode: 'apply' as const, target: 'development' };

		const firstRun = await runSqlAssets(executor, options);
		const secondRun = await runSqlAssets(executor, options);

		expect(firstRun.applied).toHaveLength(5);
		expect(secondRun.skipped).toEqual(firstRun.applied);
		expect(executor.queries.filter((query) => query === 'SELECT 1;\n')).toHaveLength(1);
	});

	it('filtra por --only y valida paths inexistentes', () => {
		const assets = discoverSqlAssets(assetsRoot);

		expect(filterAssetsByOnly(assets, ['functions/a.sql']).map((asset) => asset.path)).toEqual(['functions/a.sql']);
		expect(filterAssetsByOnly(assets, undefined)).toEqual(assets);
		expect(() => filterAssetsByOnly(assets, ['no/existe.sql'])).toThrow(/no coincide/);
	});

	it('aplica solo el asset indicado en --only', async () => {
		const executor = new InMemoryExecutor();
		const options = { assetsRoot, mode: 'apply' as const, target: 'development', only: ['functions/a.sql'] };

		const run = await runSqlAssets(executor, options);

		expect(run.applied).toEqual(['functions/a.sql']);
		expect(executor.queries.filter((query) => query === 'SELECT 2;\n')).toHaveLength(0);
	});

	it('requires explicit production confirmation before applying', () => {
		expect(() => assertTargetAllowed({ mode: 'apply', target: 'production' })).toThrow(/allow-production/);
		expect(() => assertTargetAllowed({ mode: 'apply', target: 'production', allowProduction: true, confirmTarget: 'production' })).not.toThrow();
		expect(() => assertTargetAllowed({ mode: 'dry-run', target: 'production' })).not.toThrow();
	});
});

/**
 * Guardas sobre el corpus real de assets (no sobre un directorio temporal).
 *
 * Existen porque el runner pasó a ser el único mecanismo de DDL de api-sapira: un asset mal
 * formado ya no es una molestia, es un despliegue roto. Ambas guardas cubren un problema que
 * ya ocurrió de verdad en este repo.
 */
describe('Corpus de assets SQL', () => {
	const assetsRoot = __dirname;

	const listSql = (directory: string): string[] => {
		const absolute = path.join(assetsRoot, directory);
		if (!fs.existsSync(absolute)) return [];
		return fs
			.readdirSync(absolute)
			.filter((name) => name.endsWith('.sql'))
			.map((name) => path.join(directory, name));
	};

	const read = (relativePath: string): string => fs.readFileSync(path.join(assetsRoot, relativePath), 'utf8');

	/** Quita comentarios para que un `-- … DESC …` de cabecera no dispare falsos positivos. */
	const sinComentarios = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

	it('todo asset de functions/ declara la función, no solo su cuerpo', () => {
		// El generador capturó `prosrc` en vez de `pg_get_functiondef` en 9 archivos, que quedaron
		// como cuerpos plpgsql sueltos. Un `--apply` sin `--only` fallaba con error de sintaxis.
		const sinDeclaracion = listSql('functions').filter((file) => !/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i.test(read(file)));

		expect(sinDeclaracion).toEqual([]);
	});

	it('todo asset de functions/ cierra su delimitador dollar-quote', () => {
		const desbalanceados = listSql('functions').filter((file) => {
			const sql = read(file);
			const delimiter = /AS\s+(\$[a-z_]*\$)/i.exec(sql)?.[1];
			if (!delimiter) return true;
			return (sql.split(delimiter).length - 1) % 2 !== 0;
		});

		expect(desbalanceados).toEqual([]);
	});

	it('toda tabla nueva activa RLS en su propio asset', () => {
		// Los archivos de rls/ solo declaran policies y NO activan RLS (se generaron desde prod,
		// donde ya estaba activo). Sin el ALTER en el asset de la tabla, una tabla nueva nace con
		// RLS apagado y sus policies quedan inertes.
		const sinRls = listSql('tables')
			.filter((file) => /CREATE\s+TABLE/i.test(read(file)))
			.filter((file) => !/ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(read(file)));

		expect(sinRls).toEqual([]);
	});

	it('el manifest declara las mismas fases que ASSET_DIRECTORIES', () => {
		// El manifest sobreescribe la constante, así que una divergencia entre ambos
		// es invisible en runtime: `tables` y `seed` faltaron en la constante durante meses.
		const manifest = JSON.parse(read('assets.manifest.json')) as { directories: string[] };

		expect(manifest.directories).toEqual([...ASSET_DIRECTORIES]);
	});

	it('ningún directorio con .sql queda fuera del manifest', () => {
		const conSql = fs
			.readdirSync(assetsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && listSql(entry.name).length > 0)
			.map((entry) => entry.name);

		expect(conSql.filter((directory) => !ASSET_DIRECTORIES.includes(directory as never))).toEqual([]);
	});

	it('todo asset de types/ es re-ejecutable', () => {
		// `CREATE TYPE` no admite IF NOT EXISTS: un enum se crea dentro de un bloque DO
		// que consulta pg_type. Las extensiones sí aceptan IF NOT EXISTS.
		const noIdempotentes = listSql('types').filter((file) => {
			const sql = read(file);
			if (/CREATE\s+TYPE/i.test(sql) && !/FROM\s+pg_type/i.test(sql)) return true;
			return /CREATE\s+EXTENSION\s+(?!IF\s+NOT\s+EXISTS)/i.test(sql);
		});

		expect(noIdempotentes).toEqual([]);
	});

	it('todo asset de special-index/ crea el índice de forma idempotente', () => {
		const noIdempotentes = listSql('special-index').filter((file) => /CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/i.test(read(file)));

		expect(noIdempotentes).toEqual([]);
	});

	it('los índices declarables con @Index no se duplican en special-index/', () => {
		// special-index/ existe solo para lo que TypeORM no puede expresar: método no btree,
		// orden explícito de columnas, o una expresión en lugar de una lista de columnas.
		// Un índice simple acá sería una segunda fuente de verdad frente a la entity.
		const declarables = listSql('special-index').filter((file) => {
			const definicion = sinComentarios(read(file));
			const cuerpo = definicion.includes('USING') ? definicion.slice(definicion.indexOf('USING')) : definicion;
			if (/USING\s+(?!btree)/i.test(cuerpo)) return false;
			if (/\sDESC|\bNULLS\s+(FIRST|LAST)\b/i.test(cuerpo)) return false;

			// Lo que va entre los paréntesis del índice: si no es una lista simple de
			// identificadores, es una expresión y `@Index` no puede representarla.
			const columnas = /\(([\s\S]*)\)\s*;?\s*$/.exec(definicion.trim())?.[1] ?? '';
			return /^[\s"'\w,]*$/.test(columnas);
		});

		expect(declarables).toEqual([]);
	});

	it('todo CREATE TYPE y CREATE EXTENSION vive en types/', () => {
		const fueraDeFase = ASSET_DIRECTORIES.filter((directory) => directory !== 'types')
			.flatMap((directory) => listSql(directory))
			.filter((file) => /CREATE\s+(TYPE|EXTENSION)/i.test(read(file)));

		expect(fueraDeFase).toEqual([]);
	});
});

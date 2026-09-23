import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	assertTargetAllowed,
	ASSET_DIRECTORIES,
	checksumSql,
	discoverSqlAssets,
	filterAssetsByOnly,
	HISTORY_TABLE,
	runSqlAssets,
	SqlExecutor,
} from './assets-runner';

class InMemoryExecutor implements SqlExecutor {
	readonly queries: string[] = [];
	readonly history = new Map<string, { checksum: string; modo: string }>();
	private historyTableCreated = false;

	/** Simula una base que ya tiene historial (p. ej. prod, con filas previas al baseline). */
	registrar(assetPath: string, checksum: string, modo = 'apply'): void {
		this.historyTableCreated = true;
		this.history.set(assetPath, { checksum, modo });
	}

	async query(query: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
		this.queries.push(query);
		if (query.includes(`CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE}`)) {
			this.historyTableCreated = true;
		}
		// Sin esto, `historyTableExists` daba siempre false y un dry-run reportaba TODO como
		// pendiente, incluso lo ya aplicado: el fake no podía distinguir base nueva de base con
		// historial.
		if (query.includes('to_regclass')) {
			return { rows: [{ history_table: this.historyTableCreated ? HISTORY_TABLE : null }] };
		}
		if (query.includes('SELECT asset_path, checksum')) {
			return { rows: [...this.history].map(([asset_path, fila]) => ({ asset_path, checksum: fila.checksum })) };
		}
		if (query.includes(`INSERT INTO ${HISTORY_TABLE}`)) {
			const [assetPath, checksum, , modo] = values as string[];
			// `ON CONFLICT DO NOTHING` (baseline) no pisa; `DO UPDATE` (apply) sí.
			if (!(query.includes('DO NOTHING') && this.history.has(assetPath))) this.history.set(assetPath, { checksum, modo });
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

	it('re-aplica un asset modificado si su fase converge', async () => {
		// El caso que resuelve: cambiar una función obligaba a crear `<objeto>_<motivo>.sql` y dejar
		// el viejo para siempre. Además de inflar el corpus, el que quedaba vivo lo decidía el orden
		// alfabético, que no es el cronológico.
		const executor = new InMemoryExecutor();
		const options = { assetsRoot, mode: 'apply' as const, target: 'development' };

		await runSqlAssets(executor, options);
		fs.writeFileSync(path.join(assetsRoot, 'functions', 'a.sql'), 'SELECT 1 AS cambiada;\n');
		const segunda = await runSqlAssets(executor, options);

		expect(segunda.reapplied).toEqual(['functions/a.sql']);
		expect(segunda.skipped).not.toContain('functions/a.sql');
		expect(executor.queries).toContain('SELECT 1 AS cambiada;\n');

		// El historial se actualiza al checksum nuevo: la tercera corrida ya lo omite.
		const tercera = await runSqlAssets(executor, options);
		expect(tercera.reapplied).toEqual([]);
		expect(tercera.skipped).toContain('functions/a.sql');
	});

	it('rechaza el cambio de un asset cuya fase NO converge', async () => {
		// `CREATE INDEX IF NOT EXISTS` no redefine un índice existente: lo saltea. Re-aplicarlo
		// dejaría el archivo cambiado y la base igual, y registrar el checksum nuevo sería que el
		// historial mienta. Ese cambio es una transición y va en una migración.
		const executor = new InMemoryExecutor();
		const options = { assetsRoot, mode: 'apply' as const, target: 'development' };

		await runSqlAssets(executor, options);
		fs.writeFileSync(path.join(assetsRoot, 'special-index', 'index.sql'), 'CREATE INDEX IF NOT EXISTS sample_index ON sample (otra);\n');

		await expect(runSqlAssets(executor, options)).rejects.toThrow(/special-index.*no se puede re-aplicar.*migración/s);
	});

	it('un dry-run reporta como pendiente el asset modificado, sin aplicarlo', async () => {
		const executor = new InMemoryExecutor();

		await runSqlAssets(executor, { assetsRoot, mode: 'apply' as const, target: 'development' });
		fs.writeFileSync(path.join(assetsRoot, 'functions', 'a.sql'), 'SELECT 1 AS otra;\n');
		const seco = await runSqlAssets(executor, { assetsRoot, mode: 'dry-run' as const, target: 'development' });

		expect(seco.pending).toEqual(['functions/a.sql']);
		expect(seco.reapplied).toEqual([]);
		expect(executor.queries).not.toContain('SELECT 1 AS otra;\n');
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

	it('deja la tabla de historial con la columna modo y RLS activado', async () => {
		// Sin RLS, en un entorno nuevo la tabla nace abierta a `anon` por los default privileges.
		const executor = new InMemoryExecutor();
		await runSqlAssets(executor, { assetsRoot, mode: 'apply' as const, target: 'development' });

		expect(executor.queries.some((query) => /ADD COLUMN IF NOT EXISTS modo text NOT NULL DEFAULT 'apply'/.test(query))).toBe(true);
		expect(executor.queries.some((query) => query.includes(`ALTER TABLE ${HISTORY_TABLE} ENABLE ROW LEVEL SECURITY`))).toBe(true);
		expect([...executor.history.values()].every((fila) => fila.modo === 'apply')).toBe(true);
	});

	describe('modo baseline', () => {
		const baseline = (extra: Record<string, unknown> = {}) => ({ assetsRoot, mode: 'baseline' as const, target: 'qa', ...extra });

		it('registra sin ejecutar solo los assets verificados', async () => {
			const executor = new InMemoryExecutor();
			const run = await runSqlAssets(executor, baseline({ verified: new Set(['functions/a.sql', 'rls/policy.sql']) }));

			expect(run.baselined).toEqual(['functions/a.sql', 'rls/policy.sql']);
			expect(run.pending).toEqual(['functions/z.sql', 'special-index/index.sql', 'triggers/trigger.sql']);
			// Ni una línea del SQL de los assets llegó a la base.
			expect(executor.queries).not.toContain('SELECT 1;\n');
			expect(executor.queries).not.toContain('SELECT 4;\n');
			expect(executor.history.get('functions/a.sql')).toEqual({ checksum: checksumSql('SELECT 1;\n'), modo: 'baseline' });

			// El apply siguiente omite lo registrado y ejecuta solo el resto.
			const apply = await runSqlAssets(executor, { assetsRoot, mode: 'apply' as const, target: 'qa' });
			expect(apply.skipped).toEqual(['functions/a.sql', 'rls/policy.sql']);
			expect(apply.applied).toEqual(['functions/z.sql', 'special-index/index.sql', 'triggers/trigger.sql']);
		});

		it('no toca una fila ya registrada, aunque su checksum difiera del archivo', async () => {
			// Un asset registrado que cambió lo resuelve apply (re-aplica o falla según la fase).
			// Si baseline lo pisara, el cambio del archivo quedaría registrado sin haberse ejecutado.
			const executor = new InMemoryExecutor();
			executor.registrar('functions/a.sql', 'checksum-de-otra-version');

			const run = await runSqlAssets(executor, baseline({ verified: new Set(['functions/a.sql']) }));

			expect(run.skipped).toEqual(['functions/a.sql']);
			expect(run.baselined).toEqual([]);
			expect(executor.history.get('functions/a.sql')).toEqual({ checksum: 'checksum-de-otra-version', modo: 'apply' });
		});

		it('nunca registra grants ni seed, aunque vengan como verificados', async () => {
			// Que `grants/000` coincida con lo generado no prueba nada: el emisor escribe sentencias fijas.
			fs.mkdirSync(path.join(assetsRoot, 'grants'));
			fs.mkdirSync(path.join(assetsRoot, 'seed'));
			fs.writeFileSync(path.join(assetsRoot, 'grants', '000.sql'), 'SELECT 5;\n');
			fs.writeFileSync(path.join(assetsRoot, 'seed', '001.sql'), 'SELECT 6;\n');
			fs.writeFileSync(
				path.join(assetsRoot, 'assets.manifest.json'),
				JSON.stringify({ version: 1, directories: ['functions', 'grants', 'seed'] })
			);

			const executor = new InMemoryExecutor();
			const run = await runSqlAssets(executor, baseline({ verified: new Set(['functions/a.sql', 'grants/000.sql', 'seed/001.sql']) }));

			expect(run.baselined).toEqual(['functions/a.sql']);
			expect(run.pending).toEqual(expect.arrayContaining(['grants/000.sql', 'seed/001.sql']));
		});

		it('exige la verificación contra la base, y no escribe nada sin ella', async () => {
			const executor = new InMemoryExecutor();

			await expect(runSqlAssets(executor, baseline())).rejects.toThrow(/requiere la verificación/);
			expect(executor.queries).toEqual([]);
		});

		it('en producción exige las dos confirmaciones', async () => {
			// No ejecuta DDL, pero un baseline equivocado hace que un asset nunca aplicado se omita para siempre.
			expect(() => assertTargetAllowed({ mode: 'baseline', target: 'production' })).toThrow(/línea base.*allow-production/);
			expect(() =>
				assertTargetAllowed({ mode: 'baseline', target: 'production', allowProduction: true, confirmTarget: 'production' })
			).not.toThrow();
			await expect(runSqlAssets(new InMemoryExecutor(), baseline({ target: 'production', verified: new Set() }))).rejects.toThrow(
				/allow-production/
			);
		});

		it('respeta --only', async () => {
			const executor = new InMemoryExecutor();
			const run = await runSqlAssets(
				executor,
				baseline({ only: ['rls/policy.sql'], verified: new Set(['functions/a.sql', 'rls/policy.sql']) })
			);

			expect(run.baselined).toEqual(['rls/policy.sql']);
			expect(executor.history.has('functions/a.sql')).toBe(false);
		});

		it('una fila de línea base que después se re-aplica pasa a modo apply', async () => {
			const executor = new InMemoryExecutor();
			await runSqlAssets(executor, baseline({ verified: new Set(['functions/a.sql']) }));
			fs.writeFileSync(path.join(assetsRoot, 'functions', 'a.sql'), 'SELECT 1 AS nueva;\n');

			const apply = await runSqlAssets(executor, { assetsRoot, mode: 'apply' as const, target: 'qa', only: ['functions/a.sql'] });

			expect(apply.reapplied).toEqual(['functions/a.sql']);
			expect(executor.history.get('functions/a.sql')).toEqual({ checksum: checksumSql('SELECT 1 AS nueva;\n'), modo: 'apply' });
		});
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

	it('toda migración que crea una tabla activa RLS', () => {
		// Los 389 archivos de rls/ solo declaran policies y NO activan RLS: se generaron desde
		// producción, donde ya estaba activo. Una tabla nueva nace entonces con RLS apagado y sus
		// policies inertes, sobre una base donde el GRANT es ALL PRIVILEGES para anon.
		//
		// `ENABLE ROW LEVEL SECURITY` es propiedad de tabla y TypeORM no la modela, así que
		// `migration:generate` nunca la emite: hay que escribirla a mano en la migración. Esta
		// guarda existe porque es justo el paso que se olvida.
		//
		// Antes esto miraba el directorio `tables/`, que dejó de existir cuando las tablas pasaron
		// a definirse por entity: la guarda pasaba sin verificar nada.
		// Solo se mira el `up()`: un `down()` que restaura una tabla borrada tiene que devolverla al
		// estado que tenía, y si esa tabla no tenía RLS, exigírselo sería restaurarla mal.
		const cuerpoDelUp = (source: string): string => {
			const desde = source.indexOf('async up(');
			if (desde < 0) return '';
			const hasta = source.indexOf('async down(', desde);
			return source.slice(desde, hasta < 0 ? undefined : hasta);
		};

		const migrationsDir = path.join(assetsRoot, 'migrations');
		const sinRls = fs
			.readdirSync(migrationsDir)
			.filter((file) => file.endsWith('.ts'))
			.map((file) => path.join('migrations', file))
			.map((file) => ({ file, up: cuerpoDelUp(read(file)) }))
			.filter(({ up }) => /CREATE\s+TABLE/i.test(sinComentarios(up)))
			.filter(({ up }) => !/ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(up))
			.map(({ file }) => file);

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

	it('todo asset de cron/ programa un job con nombre literal y ninguno lo elimina', () => {
		// `cron.schedule` hace upsert por (jobname, username): un asset describe el estado de un job.
		// Un `cron.unschedule` sería una transición y va en migración, como cualquier borrado.
		for (const file of listSql('cron')) {
			const sql = read(file);
			expect({ file, programa: /SELECT\s+cron\.schedule\('[^']+',\s*'[^']+'/i.test(sql) }).toEqual({ file, programa: true });
			expect({ file, elimina: /cron\.unschedule/i.test(sql) }).toEqual({ file, elimina: false });
		}
	});

	it('ningún asset ni snapshot lleva un secreto', () => {
		// Dos jobs de pg_cron tenían la service role key escrita en su comando. Al modelarlos como
		// assets, capturar sin redactar habría commiteado la clave —y `snapshots/raw/catalog.json`
		// está versionado—. Esta guarda vale para cualquier secreto futuro, no solo para esos dos.
		const patrones = [/Bearer\s+[A-Za-z0-9._-]{20,}/, /eyJ[A-Za-z0-9._-]{30,}/, /\bsb_secret_[A-Za-z0-9._-]{10,}/];
		const tieneSecreto = (contenido: string): boolean => patrones.some((patron) => patron.test(contenido));

		const assetsConSecreto = ASSET_DIRECTORIES.flatMap((directory) => listSql(directory)).filter((file) => tieneSecreto(read(file)));
		const snapshotsConSecreto = ['catalog.json', 'list-tables.json']
			.map((nombre) => path.join(assetsRoot, '..', '..', '..', 'scripts', 'espejo', 'snapshots', 'raw', nombre))
			.filter((file) => fs.existsSync(file) && tieneSecreto(fs.readFileSync(file, 'utf8')));

		expect([...assetsConSecreto, ...snapshotsConSecreto]).toEqual([]);
	});

	it('las tablas deny-all por diseño no reciben policies', () => {
		// Estas cuatro tienen RLS activo y CERO policies en producción, y eso es correcto, no un
		// descuido: para anon y authenticated son deny-all, que es el estado más cerrado posible.
		// Verificado el 2026-09-14: ninguna tiene consumidor `supabase-js`; `claude_skills` no tiene
		// consumidor en absoluto; y las tres de SII las usa `modules/sii/sii.service.ts` con
		// repositorios TypeORM, es decir con un rol que tiene BYPASSRLS. `sii_certificates` guarda
		// `key_vault_secret_name` y `thumbprint`: metadata de credenciales tributarias.
		//
		// La guarda existe porque el linter de Supabase reporta "RLS enabled, no policy" como
		// hallazgo, y la reacción natural es escribir una policy — que acá sería AMPLIAR acceso que
		// nadie pidió, sobre tablas de secretos.
		//
		// Si algún día aparece un consumidor `supabase-js`, se quita la tabla de esta lista y la
		// policy es `tenant_isolation_select_<tabla>`; para `sii_certificates` y `sii_cafs`, que no
		// tienen holding_id, va vía `EXISTS` sobre `sii_configurations.holding_id`, con
		// `get_current_user_holding_id()` y no con la versión pesada `get_user_holding_id()`.
		const TABLAS_DENY_ALL_POR_DISENO = ['claude_skills', 'sii_cafs', 'sii_certificates', 'sii_configurations'];

		const ofensores = listSql('rls').filter((file) => {
			const contenido = sinComentarios(read(file));
			return TABLAS_DENY_ALL_POR_DISENO.some((tabla) => new RegExp(`\\b${tabla}\\b`).test(contenido));
		});

		expect(ofensores).toEqual([]);
	});
});

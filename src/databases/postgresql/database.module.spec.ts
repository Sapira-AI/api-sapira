import * as fs from 'fs';
import * as path from 'path';

/**
 * Guard del carril B: los espejos permanecen inertes hasta su promoción y
 * synchronize solo se permite mediante la configuración explícita centralizada.
 */
describe('Guard: entidades espejo y configuración TypeORM', () => {
	const srcDir = path.join(__dirname, '..', '..');
	const entitiesDir = path.join(__dirname, 'entities');
	// Espejos promovidos: dejan de ser inertes y los carga el glob de database.module.ts.
	// Se promueve por lotes y solo cuando el espejo no depende de otro espejo sin promover:
	// una entity activa que importe un `.espejo.ts` lo cargaría en runtime saltándose este control.
	// Lote 1 (2026-09-14): los seis que desbloquean FKs de entities ya alineadas.
	const promotedMirrorEntities = new Set(
		[
			['base-tenancy', 'permission.entity.ts'],
			['base-tenancy', 'role.entity.ts'],
			['contratos', 'churn-reason.entity.ts'],
			['contratos', 'contract-item.entity.ts'],
			['contratos', 'workflow-step.entity.ts'],
			['legacy', 'invoices-legacy.entity.ts'],
			['suscripciones', 'subscription.entity.ts'],
			// Lote 2 (2026-09-14): los cuatro que dependían de un espejo del lote 1.
			['facturacion', 'quantity.entity.ts'],
			['legacy', 'invoice-items-legacy.entity.ts'],
			['legacy', 'invoice-items-legacy-match.entity.ts'],
			['suscripciones', 'subscription-item.entity.ts'],
		].map(([dir, file]) => path.join(entitiesDir, dir, file))
	);

	const listTypeScriptFiles = (dir: string): string[] =>
		fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) return listTypeScriptFiles(fullPath);
			return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [fullPath] : [];
		});

	it('database.module.ts delega la sincronización a la configuración protegida', () => {
		const source = fs.readFileSync(path.join(__dirname, 'database.module.ts'), 'utf8');
		expect(source).toContain('createPostgreSqlOptions');
	});

	it('ningún archivo de src habilita synchronize, dropSchema ni migrationsRun de forma literal', () => {
		const offenders = listTypeScriptFiles(srcDir).filter((file) =>
			/\b(synchronize|dropSchema|migrationsRun)\s*:\s*true\b/.test(fs.readFileSync(file, 'utf8'))
		);
		expect(offenders).toEqual([]);
	});

	const leerJson = <T>(...segmentos: string[]): T => JSON.parse(fs.readFileSync(path.join(srcDir, '..', ...segmentos), 'utf8')) as T;

	it('solo carga en runtime los espejos promovidos explícitamente', () => {
		// Antes bastaba con "ningún `.entity.ts` dentro de un subdirectorio de entities/": todo lo
		// que vivía ahí era espejo. Desde que las entities del repo se reubicaron por dominio
		// (`src/modules/<mod>/entities/` → `entities/<dominio>/`) esa señal posicional dejó de
		// discriminar y reportaría 45 archivos legítimos.
		//
		// La población de espejos la define el registro que escribe el generador: si una tabla
		// figura en `generated-entities.json`, su archivo es un espejo. Que exista como
		// `.entity.ts` en vez de `.espejo.ts` significa que fue PROMOVIDO, y eso tiene que ser
		// una decisión escrita a mano acá arriba.
		//
		// Se indexa por TABLA, no por nombre de archivo: renombrar un `.espejo.ts` a mano sin
		// correr el generador no saca a esa tabla del registro, así que el renombrado igual queda
		// reportado. Por eso la señal no es circular.
		const registro = leerJson<Record<string, { class: string; module: string; file: string }>>('scripts', 'espejo', 'generated-entities.json');
		const promovidosEnDisco = Object.values(registro)
			.map((entrada) => path.join(entitiesDir, ...entrada.module.split('/'), entrada.file.replace(/\.espejo\.ts$/, '.entity.ts')))
			.filter((file) => fs.existsSync(file));

		expect(promovidosEnDisco.filter((file) => !promotedMirrorEntities.has(file))).toEqual([]);
		// Y a la inversa, para que la lista no se pudra con rutas de espejos que ya no existen.
		expect([...promotedMirrorEntities].filter((file) => !promovidosEnDisco.includes(file))).toEqual([]);
	});

	it('toda entity de un subdirectorio está inventariada: espejo promovido o entity del repo', () => {
		// Recupera la propiedad fail-closed que el test de arriba perdió al acotarse a la
		// población del registro. Un `.entity.ts` en un subdirectorio solo puede ser dos cosas
		// legítimas: un espejo promovido (la lista de arriba) o una entity del repo reubicada por
		// dominio (el inventario que `generate-espejo.py` deriva del disco). Cualquier otra cosa
		// es una entity que se coló sin decisión.
		//
		// Límite conocido: como ese inventario deriva del disco, el test es débilmente circular —
		// un archivo nuevo más una regeneración lo bendicen. Es aceptable porque el test de arriba,
		// que es el que guarda la promoción de espejos, no lo es, y porque la regeneración deja un
		// diff visible en `existing-entities.json` dentro del PR.
		const inventario = leerJson<Record<string, { class: string; file: string }>>('scripts', 'espejo', 'existing-entities.json');
		const reubicadas = new Set(
			Object.entries(inventario)
				.filter(([tabla]) => !tabla.startsWith('_'))
				.map(([, entrada]) => path.join(srcDir, '..', entrada.file))
		);
		const offenders = fs
			.readdirSync(entitiesDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.flatMap((dir) => listTypeScriptFiles(path.join(entitiesDir, dir.name)))
			.filter((file) => file.endsWith('.entity.ts'))
			.filter((file) => !promotedMirrorEntities.has(file) && !reubicadas.has(file));
		expect(offenders).toEqual([]);
	});

	it('ninguna tabla queda con espejo y entity a la vez', () => {
		// `generate-espejo.py` reescribe `<tabla>.espejo.ts` sin mirar si esa tabla ya fue
		// promovida. Cuando pasó con `permissions`, quedaron dos clases mapeando la misma tabla:
		// la promovida que carga runtime y el espejo que exportaba el barrel del módulo.
		const duplicadas = fs
			.readdirSync(entitiesDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.flatMap((dir) => listTypeScriptFiles(path.join(entitiesDir, dir.name)))
			.filter((file) => file.endsWith('.espejo.ts'))
			.filter((file) => fs.existsSync(file.replace(/\.espejo\.ts$/, '.entity.ts')));
		expect(duplicadas).toEqual([]);
	});

	it('espejo.existing.ts reexporta exactamente las entities que existen en disco', () => {
		// El barrel se generaba desde `existing-entities.json`, un inventario con fecha: resucitaba
		// entities borradas (`integration_logs`) y perdía las nuevas (`AuthUser`), y los 14 specs
		// del espejo fallaban con "Entity metadata for ... was not found".
		const barrel = fs.readFileSync(path.join(entitiesDir, 'espejo.existing.ts'), 'utf8');
		const exportadas = new Set(
			[...barrel.matchAll(/export \{ ([^}]+) \} from/g)].flatMap((match) => match[1].split(',').map((clase) => clase.trim()))
		);
		const enDisco = new Set(
			listTypeScriptFiles(srcDir)
				.filter((file) => file.endsWith('.entity.ts'))
				.flatMap((file) => {
					const source = fs.readFileSync(file, 'utf8');
					return source.includes('@Entity(') ? [...source.matchAll(/export class (\w+)/g)].map((match) => match[1]) : [];
				})
		);
		expect([...enDisco].filter((clase) => !exportadas.has(clase))).toEqual([]);
		expect([...exportadas].filter((clase) => !enDisco.has(clase))).toEqual([]);
	});

	it('package.json no expone scripts de sincronización de esquema', () => {
		// `schema:sync` construía un DataSource con SUPABASE_DATABASE_URL y llamaba
		// dataSource.synchronize(): decidía por NODE_ENV, no por la base real, así que
		// con un .env de producción sincronizaba prod pasando todas las guardas.
		const packageJson = JSON.parse(fs.readFileSync(path.join(srcDir, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> };

		expect(Object.keys(packageJson.scripts).filter((script) => script.startsWith('schema:sync'))).toEqual([]);
		expect(packageJson.scripts['schema:log']).toBeDefined();
		expect(packageJson.scripts['schema:status']).toBeDefined();
		expect(packageJson.scripts['postgres:assets']).toBeDefined();
	});

	it('todo script que conecta a la base verifica que la conexión corresponda al target declarado', () => {
		// `target` sale de DATABASE_TARGET ?? NODE_ENV ?? 'development' y es
		// independiente de SUPABASE_DATABASE_URL: sin esta verificación las guardas
		// de producción no protegen nada. `schema-log.ts` queda fuera: no recibe
		// target, solo informa a qué base se conectó.
		const scripts = [
			'apply-postgresql-assets.ts',
			'run-migrations.ts',
			'schema-status.ts',
			'schema-as-code/fetch-catalog.ts',
			'schema-as-code/audit-usage.ts',
			'schema-as-code/verify-policies.ts',
		];
		for (const script of scripts) {
			const source = fs.readFileSync(path.join(srcDir, '..', 'scripts', script), 'utf8');
			expect({ script, verifica: source.includes('assertConnectionMatchesTarget(') }).toEqual({ script, verifica: true });
		}
	});

	it('schema:status es de solo lectura', () => {
		// Es el comando que se corre ANTES de decidir nada, contra prod incluida: no puede escribir.
		const source = fs.readFileSync(path.join(srcDir, '..', 'scripts', 'schema-status.ts'), 'utf8');

		expect(source).toContain('BEGIN TRANSACTION READ ONLY');
		expect(source).not.toMatch(/runSqlAssets|ensureHistoryTable|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bALTER\b|\bCREATE\b/);
	});

	it('migration:show no usa showMigrations() de TypeORM, que crea la tabla de migraciones', () => {
		const source = fs.readFileSync(path.join(srcDir, '..', 'scripts', 'run-migrations.ts'), 'utf8');
		expect(source).not.toMatch(/\.showMigrations\(/);
	});
});

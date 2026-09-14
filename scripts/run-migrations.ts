/**
 * run-migrations.ts — ejecuta migraciones TypeORM verificando antes que la base
 * corresponda al `--target` declarado.
 *
 * El CLI de TypeORM no tiene forma de interponer esa verificación, y sin ella
 * `migration:run` decide contra qué base actúa por la variable de entorno: el mismo
 * agujero que ya se cerró en `postgres:assets`.
 *
 * Uso:
 *   yarn migration:show   --target production
 *   yarn migration:run    --target qa
 *   yarn migration:revert --target qa
 */
import { assertConnectionMatchesTarget } from '../src/databases/postgresql/connection-target';
import dataSource from '../src/databases/postgresql/data-source';

type Accion = 'run' | 'revert' | 'show';

function parseArgs(args: string[]): { accion: Accion; target: string } {
	const accion = args[0] as Accion;
	if (!['run', 'revert', 'show'].includes(accion)) {
		throw new Error('Primer argumento debe ser run, revert o show.');
	}

	const indice = args.indexOf('--target');
	const target = indice >= 0 ? args[indice + 1] : undefined;
	if (!target) throw new Error('Falta --target <entorno>. Debe coincidir con la base de SUPABASE_DATABASE_URL.');

	return { accion, target };
}

async function main(): Promise<void> {
	const { accion, target } = parseArgs(process.argv.slice(2));

	const connectionString = process.env.SUPABASE_DATABASE_URL ?? process.env.DATABASE_URL;
	if (!connectionString) throw new Error('SUPABASE_DATABASE_URL o DATABASE_URL debe estar configurada.');

	const resolved = assertConnectionMatchesTarget(connectionString, target);
	console.log(`Conexión verificada: ${resolved.projectRef ? `proyecto ${resolved.projectRef}` : 'base local'} (${resolved.environment})`);

	// Aplicar o revertir en producción exige la misma confirmación doble que los assets.
	if (resolved.environment === 'production' && accion !== 'show') {
		const autorizado = process.argv.includes('--allow-production') && process.argv[process.argv.indexOf('--confirm-target') + 1] === 'production';
		if (!autorizado) {
			throw new Error(`${accion} en producción requiere --allow-production y --confirm-target production.`);
		}
	}

	await dataSource.initialize();
	try {
		if (accion === 'show') {
			const pendientes = await dataSource.showMigrations();
			console.log(pendientes ? 'Hay migraciones pendientes.' : 'Sin migraciones pendientes.');
			return;
		}

		const resultado = accion === 'run' ? await dataSource.runMigrations({ transaction: 'each' }) : [await dataSource.undoLastMigration()];
		console.log(accion === 'run' ? `Aplicadas ${resultado.length} migraciones.` : 'Revertida la última migración.');
	} finally {
		if (dataSource.isInitialized) await dataSource.destroy();
	}
}

if (require.main === module) {
	main().catch((error: Error) => {
		console.error(`Error ejecutando migraciones: ${error.message}`);
		process.exitCode = 1;
	});
}

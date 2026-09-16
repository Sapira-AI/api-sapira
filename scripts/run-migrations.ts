/**
 * run-migrations.ts — ejecuta migraciones TypeORM verificando antes que la base
 * corresponda al `--target` declarado.
 *
 * El CLI de TypeORM no tiene forma de interponer esa verificación, y sin ella
 * `migration:run` decide contra qué base actúa por la variable de entorno: el mismo
 * agujero que ya se cerró en `postgres:assets`.
 *
 * `show` es de solo lectura y lista los nombres pendientes. No usa `showMigrations()` de
 * TypeORM porque ese método CREA la tabla de migraciones si no existe (y con el logging
 * apagado tampoco dice cuáles faltan).
 *
 * Uso:
 *   yarn migration:show   --target production
 *   yarn migration:run    --target qa
 *   yarn migration:revert --target qa
 *   yarn migration:run    --target production --allow-production --confirm-target production
 */
import * as path from 'path';

import 'dotenv/config';
import { Client } from 'pg';

import { assertConnectionMatchesTarget, ResolvedEnvironment } from '../src/databases/postgresql/connection-target';
import { calcularMigracionesPendientes, leerMigracionesDeclaradas, leerMigracionesEjecutadas } from '../src/databases/postgresql/schema-status';

type Accion = 'run' | 'revert' | 'show';

export interface MigrationArguments {
	accion: Accion;
	target: string;
	allowProduction: boolean;
	confirmTarget?: string;
}

const MIGRATIONS_DIR = path.resolve(__dirname, '../src/databases/postgresql/migrations');

export function parseMigrationArgs(args: string[]): MigrationArguments {
	const accion = args[0] as Accion;
	if (!['run', 'revert', 'show'].includes(accion)) {
		throw new Error('Primer argumento debe ser run, revert o show.');
	}

	let target: string | undefined;
	let allowProduction = false;
	let confirmTarget: string | undefined;
	for (let index = 1; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === '--target') target = args[++index];
		else if (argument === '--confirm-target') confirmTarget = args[++index];
		else if (argument === '--allow-production') allowProduction = true;
		// Una bandera mal escrita (`--allow-prod`) no puede ignorarse en silencio.
		else throw new Error(`Argumento no reconocido: ${argument}`);
	}

	if (!target) throw new Error('Falta --target <entorno>. Debe coincidir con la base de SUPABASE_DATABASE_URL.');

	return { accion, target, allowProduction, confirmTarget };
}

/** Aplicar o revertir en producción exige la misma confirmación doble que los assets. `show` no escribe. */
export function assertMigrationAllowed(arguments_: MigrationArguments, environment: ResolvedEnvironment): void {
	if (environment !== 'production' || arguments_.accion === 'show') return;

	if (!arguments_.allowProduction || arguments_.confirmTarget !== 'production') {
		throw new Error(`${arguments_.accion} en producción requiere --allow-production y --confirm-target production.`);
	}
}

async function main(): Promise<void> {
	const arguments_ = parseMigrationArgs(process.argv.slice(2));

	const connectionString = process.env.SUPABASE_DATABASE_URL ?? process.env.DATABASE_URL;
	if (!connectionString) throw new Error('SUPABASE_DATABASE_URL o DATABASE_URL debe estar configurada.');

	const resolved = assertConnectionMatchesTarget(connectionString, arguments_.target);
	console.log(`Conexión verificada: ${resolved.projectRef ? `proyecto ${resolved.projectRef}` : 'base local'} (${resolved.environment})`);
	assertMigrationAllowed(arguments_, resolved.environment);

	if (arguments_.accion === 'show') {
		await mostrarPendientes(connectionString);
		return;
	}

	// Import diferido: `data-source.ts` construye el DataSource al importarse y falla sin URL,
	// lo que impediría importar este módulo desde una prueba.
	const { default: dataSource } = await import('../src/databases/postgresql/data-source');
	await dataSource.initialize();
	try {
		const resultado =
			arguments_.accion === 'run' ? await dataSource.runMigrations({ transaction: 'each' }) : [await dataSource.undoLastMigration()];
		console.log(arguments_.accion === 'run' ? `Aplicadas ${resultado.length} migraciones.` : 'Revertida la última migración.');
	} finally {
		if (dataSource.isInitialized) await dataSource.destroy();
	}
}

async function mostrarPendientes(connectionString: string): Promise<void> {
	const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
	await client.connect();
	try {
		await client.query('BEGIN TRANSACTION READ ONLY');
		const ejecutadas = await leerMigracionesEjecutadas(client);
		await client.query('ROLLBACK');

		const estado = calcularMigracionesPendientes(leerMigracionesDeclaradas(MIGRATIONS_DIR), ejecutadas);
		if (!estado.tablaExiste) console.log('La base nunca corrió migraciones (no existe sapira_typeorm_migrations).');
		console.log(
			estado.pendientes.length === 0 ? 'Sin migraciones pendientes.' : `Pendientes (${estado.pendientes.length}), en orden de ejecución:`
		);
		for (const nombre of estado.pendientes) console.log(`  ${nombre}`);
		if (estado.sinArchivo.length > 0) {
			console.log(`⚠️  Ejecutadas en la base y sin archivo en el repo (${estado.sinArchivo.length}):`);
			for (const nombre of estado.sinArchivo) console.log(`  ${nombre}`);
		}
	} finally {
		await client.end();
	}
}

if (require.main === module) {
	main().catch((error: Error) => {
		console.error(`Error ejecutando migraciones: ${error.message}`);
		process.exitCode = 1;
	});
}

/**
 * schema-status.ts — qué le falta a una base para estar al día con el repo. Solo lectura.
 *
 * Reporta, para el `--target` indicado:
 *  - migraciones TypeORM pendientes (por nombre);
 *  - el estado de cada asset SQL: registrado o no, y si la base coincide con el archivo;
 *  - objetos que existen en la base y no tienen asset.
 *
 * Es el primer y el último paso de toda sincronización (ver GUIA-CAMBIOS-DE-ESQUEMA.md →
 * "Sincronizar cambios a QA y producción"). Todo corre dentro de una transacción READ ONLY:
 * el motor rechaza cualquier escritura, así que la garantía no depende de las consultas.
 *
 * Uso:
 *   DOTENV_CONFIG_PATH=.env.qa.db yarn schema:status --target qa
 *   DOTENV_CONFIG_PATH=.env.qa.db yarn schema:status --target qa --todo   # lista también APLICADO y LINEA BASE
 */
import * as path from 'path';

import 'dotenv/config';
import { Client } from 'pg';

import { discoverSqlAssets, readAllHistory } from '../src/databases/postgresql/assets-runner';
import { assertConnectionMatchesTarget } from '../src/databases/postgresql/connection-target';
import {
	AccionAsset,
	ACCIONES,
	calcularMigracionesPendientes,
	clasificarAssets,
	compararConCorpusGenerado,
	contarPorAccion,
	leerMigracionesDeclaradas,
	leerMigracionesEjecutadas,
	objetosNoModelados,
} from '../src/databases/postgresql/schema-status';

import { buildCatalog, consultarCatalogo } from './schema-as-code/fetch-catalog';
import { Catalog, emitirCorpus } from './schema-as-code/generate-assets';

const ASSETS_ROOT = path.resolve(__dirname, '../src/databases/postgresql');
const MIGRATIONS_DIR = path.join(ASSETS_ROOT, 'migrations');

/** Acciones que por defecto solo se cuentan: son el estado sano y serían ~850 líneas. */
const SOLO_CONTADAS: readonly AccionAsset[] = ['APLICADO', 'LINEA BASE'];

const QUE_HACER: Record<AccionAsset, string> = {
	DERIVA: 'la base cambió por fuera del runner: decidir si se corrige el archivo o la base',
	BLOQUEADO: 'archivo modificado en una fase que no converge: el cambio va en una migración',
	'NO CONVERGE': 'aplicarlo no cambia la base: el cambio va en una migración',
	'SIN CONTRAPARTE': 'la base no tiene el objeto: apply lo crearía; revisar si debe existir',
	PENDIENTE: 'la base tiene otra definición: apply la reemplaza por la del archivo',
	REAPLICAR: 'archivo modificado: apply lo re-ejecuta',
	'NO VERIFICABLE': 'grants/seed: aplicar a conciencia con --only',
	'LINEA BASE': 'la base ya coincide: postgres:assets --baseline lo registra sin ejecutar',
	APLICADO: 'al día',
};

function parseArgs(args: string[]): { target: string; todo: boolean } {
	let target: string | undefined;
	let todo = false;
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] === '--target') target = args[++index];
		else if (args[index] === '--todo') todo = true;
		else throw new Error(`Argumento no reconocido: ${args[index]}`);
	}
	if (!target) throw new Error('Falta --target <entorno>. Debe coincidir con la base de SUPABASE_DATABASE_URL.');
	return { target, todo };
}

async function main(): Promise<void> {
	const { target, todo } = parseArgs(process.argv.slice(2));

	const connectionString = process.env.SUPABASE_DATABASE_URL ?? process.env.DATABASE_URL;
	if (!connectionString) throw new Error('SUPABASE_DATABASE_URL o DATABASE_URL debe estar configurada.');

	const resolved = assertConnectionMatchesTarget(connectionString, target);
	console.log(`Conexión verificada: ${resolved.projectRef ? `proyecto ${resolved.projectRef}` : 'base local'} (${resolved.environment})`);

	const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
	await client.connect();
	let ejecutadas: string[] | null;
	let historial: Map<string, string> | null;
	let catalogo: Catalog;
	try {
		await client.query('BEGIN TRANSACTION READ ONLY');
		try {
			ejecutadas = await leerMigracionesEjecutadas(client);
			historial = await readAllHistory(client);
			catalogo = buildCatalog(await consultarCatalogo(client)) as Catalog;
		} finally {
			await client.query('ROLLBACK');
		}
	} finally {
		await client.end();
	}

	// ── Migraciones ──
	const migraciones = calcularMigracionesPendientes(leerMigracionesDeclaradas(MIGRATIONS_DIR), ejecutadas);
	console.log('\n## Migraciones');
	if (!migraciones.tablaExiste) console.log('La base nunca corrió migraciones (no existe sapira_typeorm_migrations).');
	console.log(migraciones.pendientes.length === 0 ? 'Sin pendientes.' : `Pendientes (${migraciones.pendientes.length}), en orden:`);
	for (const nombre of migraciones.pendientes) console.log(`  ${nombre}`);
	if (migraciones.sinArchivo.length > 0) {
		console.log(`⚠️  Ejecutadas y sin archivo en el repo (${migraciones.sinArchivo.length}):`);
		for (const nombre of migraciones.sinArchivo) console.log(`  ${nombre}`);
	}

	// ── Assets ──
	const assets = discoverSqlAssets(ASSETS_ROOT);
	const generado = emitirCorpus(catalogo);
	const comparacion = compararConCorpusGenerado(assets, generado);
	const estados = clasificarAssets(assets, historial, comparacion);
	const conteo = contarPorAccion(estados);

	console.log('\n## Assets');
	if (!historial) console.log('La base no tiene historial de assets (no existe sapira_sql_asset_history).');
	if (migraciones.pendientes.length > 0) {
		console.log('⚠️  Hay migraciones pendientes: el estado de los assets puede cambiar después de correrlas.');
	}
	for (const accion of ACCIONES) {
		const deEsta = estados.filter((estado) => estado.accion === accion);
		if (deEsta.length === 0) continue;
		console.log(`\n### ${accion} (${deEsta.length}) — ${QUE_HACER[accion]}`);
		if (SOLO_CONTADAS.includes(accion) && !todo) continue;
		for (const estado of deEsta) console.log(`  ${estado.path}`);
	}

	if (comparacion.soloEnBase.length > 0) {
		console.log(`\n### SOLO EN LA BASE (${comparacion.soloEnBase.length}) — el objeto existe en la base y no tiene asset en el repo`);
		for (const ruta of comparacion.soloEnBase) console.log(`  ${ruta}`);
	}

	// Lo que ninguna fase del corpus sabe describir: sin esto, una vista o un procedimiento nuevo
	// no aparece en ningún lado, porque `SOLO EN LA BASE` se deriva de lo que los emisores producen.
	const noModelados = objetosNoModelados(catalogo, generado);
	if (noModelados.length > 0) {
		console.log(`\n### FUERA DEL CORPUS (${noModelados.length}) — ninguna fase del repo puede describir estos objetos`);
		for (const objeto of noModelados) console.log(`  ${objeto.tipo}: ${objeto.nombre}`);
	}

	console.log(
		`\nResumen: migraciones pendientes ${migraciones.pendientes.length} · ` +
			ACCIONES.filter((accion) => conteo.get(accion) > 0)
				.map((accion) => `${accion} ${conteo.get(accion)}`)
				.join(' · ') +
			` · solo en la base ${comparacion.soloEnBase.length}`
	);
}

if (require.main === module) {
	main().catch((error: Error) => {
		console.error(`Error calculando el estado del esquema: ${error.message}`);
		process.exitCode = 1;
	});
}

export { parseArgs };

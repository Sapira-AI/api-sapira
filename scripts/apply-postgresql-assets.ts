import { execFileSync } from 'child_process';
import * as path from 'path';

import 'dotenv/config';
import { Client } from 'pg';

import { assertAssetsCommiteados, assertFiltroExplicito, rutasModificadas } from '@/databases/postgresql/apply-guards';
import {
	assertTargetAllowed,
	AssetMode,
	AssetRunnerOptions,
	discoverSqlAssets,
	filterAssetsByOnly,
	runSqlAssets,
} from '@/databases/postgresql/assets-runner';
import { assertConnectionMatchesTarget } from '@/databases/postgresql/connection-target';
import { assetsVerificados, compararConCorpusGenerado } from '@/databases/postgresql/schema-status';

import { capturarCatalogo } from './schema-as-code/fetch-catalog';
import { emitirCorpus } from './schema-as-code/generate-assets';

const MODOS: readonly AssetMode[] = ['plan', 'dry-run', 'apply', 'baseline'];

interface CliArguments {
	mode: AssetMode;
	target: string;
	allowProduction: boolean;
	confirmTarget?: string;
	only?: string[];
	all: boolean;
	allowDirty: boolean;
}

function parseArguments(args: string[]): CliArguments {
	let mode: AssetMode = 'plan';
	// Sin default: `DATABASE_TARGET ?? NODE_ENV ?? 'development'` era el último lugar donde el target
	// se INFERÍA. Para dry-run/apply/baseline lo cachaba `assertConnectionMatchesTarget`, pero en
	// `--plan` etiquetaba la corrida en silencio con un entorno que nadie declaró.
	let target: string | undefined;
	let allowProduction = false;
	let confirmTarget: string | undefined;
	let all = false;
	let allowDirty = false;
	const only: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === '--plan') mode = 'plan';
		else if (argument === '--dry-run') mode = 'dry-run';
		else if (argument === '--apply') mode = 'apply';
		else if (argument === '--baseline') mode = 'baseline';
		else if (argument === '--allow-production') allowProduction = true;
		else if (argument === '--all') all = true;
		else if (argument === '--allow-dirty') allowDirty = true;
		else if (argument === '--mode') {
			const value = args[++index] as AssetMode;
			if (!MODOS.includes(value)) throw new Error(`--mode debe ser ${MODOS.join(', ')}.`);
			mode = value;
		} else if (argument === '--target') {
			target = requireValue(argument, args[++index]);
		} else if (argument === '--confirm-target') {
			confirmTarget = requireValue(argument, args[++index]);
		} else if (argument === '--only') {
			only.push(requireValue(argument, args[++index]));
		} else {
			throw new Error(`Argumento no reconocido: ${argument}`);
		}
	}

	if (!target) throw new Error('Falta --target <entorno>. Debe coincidir con la base de SUPABASE_DATABASE_URL.');

	return { mode, target, allowProduction, confirmTarget, only: only.length > 0 ? only : undefined, all, allowDirty };
}

/** Assets seleccionados con cambios sin commitear. El I/O de git vive acá, no en las guardas. */
function assertSeleccionCommiteada(arguments_: CliArguments, options: AssetRunnerOptions): void {
	if (arguments_.allowDirty) return;

	const raizRepo = path.resolve(__dirname, '..');
	let porcelain: string;
	try {
		porcelain = execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], {
			cwd: raizRepo,
			encoding: 'utf8',
		});
	} catch (error) {
		// Falla cerrado: si no se puede saber qué está sin commitear, no se aplica.
		throw new Error(
			`No se pudo verificar el estado de git (${(error as Error).message}). ` +
				'Corré el comando dentro del repo, o pasá --allow-dirty si sabés lo que estás haciendo.'
		);
	}

	const seleccionados = filterAssetsByOnly(discoverSqlAssets(options.assetsRoot), options.only);
	assertAssetsCommiteados(rutasModificadas(porcelain), path.relative(raizRepo, options.assetsRoot), seleccionados);
}

async function main(): Promise<void> {
	const arguments_ = parseArguments(process.argv.slice(2));
	const options: AssetRunnerOptions = {
		assetsRoot: path.resolve(__dirname, '../src/databases/postgresql'),
		mode: arguments_.mode,
		target: arguments_.target,
		allowProduction: arguments_.allowProduction,
		confirmTarget: arguments_.confirmTarget,
		only: arguments_.only,
	};
	// Antes de conectar: las dos guardas que no dependen de la base.
	assertFiltroExplicito({ mode: arguments_.mode, only: arguments_.only, all: arguments_.all });
	assertTargetAllowed(options);
	// `baseline` también: registra el checksum del archivo en disco, así que sin commitear el
	// historial guardaría un checksum que no existe en ninguna rama.
	if (options.mode === 'apply' || options.mode === 'baseline') assertSeleccionCommiteada(arguments_, options);

	if (options.mode === 'plan') {
		printResult(await runSqlAssets(undefined, options), options);
		return;
	}

	const connectionString = process.env.SUPABASE_DATABASE_URL ?? process.env.DATABASE_URL;
	if (!connectionString) throw new Error('SUPABASE_DATABASE_URL o DATABASE_URL debe estar configurada para dry-run, apply o baseline.');

	// El target es una etiqueta escrita a mano; esto verifica que corresponda a la
	// base real antes de abrir la conexión.
	const resolved = assertConnectionMatchesTarget(connectionString, options.target);
	console.log(`Conexión verificada: ${resolved.projectRef ? `proyecto ${resolved.projectRef}` : 'base local'} (${resolved.environment})`);

	const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
	await client.connect();
	try {
		if (options.mode === 'baseline') {
			// La verificación y el registro van sobre la misma conexión, uno detrás del otro. La
			// captura corre en su propia transacción READ ONLY; el registro, en otra.
			console.log('Capturando el catálogo de la base para verificar los assets…');
			const comparacion = compararConCorpusGenerado(discoverSqlAssets(options.assetsRoot), emitirCorpus(await capturarCatalogo(client)));
			options.verified = assetsVerificados(comparacion);
			console.log(`Verificados idénticos a la base: ${options.verified.size}`);
		}
		printResult(await runSqlAssets(client, options), options);
	} finally {
		await client.end();
	}
}

function printResult(result: Awaited<ReturnType<typeof runSqlAssets>>, options: AssetRunnerOptions): void {
	console.log(`Modo: ${options.mode}; target: ${options.target}; assets descubiertos: ${result.assets.length}`);
	const conteo = new Map<string, number>();
	for (const asset of result.assets) {
		// REAPLICADO: ya estaba en el historial, su contenido cambió y su fase converge al
		// re-aplicarlo. Se distingue de APLICADO porque es el caso que conviene mirar en un diff.
		const status = result.reapplied.includes(asset.path)
			? 'REAPLICADO'
			: result.applied.includes(asset.path)
				? 'APLICADO'
				: result.baselined.includes(asset.path)
					? 'LINEA BASE'
					: result.skipped.includes(asset.path)
						? 'OMITIDO'
						: 'PENDIENTE';
		conteo.set(status, (conteo.get(status) ?? 0) + 1);
		console.log(`${status} ${asset.path} ${asset.checksum}`);
	}
	console.log(`\nResumen: ${[...conteo].map(([status, n]) => `${status} ${n}`).join(' · ')}`);
}

function requireValue(flag: string, value: string | undefined): string {
	if (!value) throw new Error(`${flag} requiere un valor.`);
	return value;
}

if (require.main === module) {
	main().catch((error: Error) => {
		console.error(`Error ejecutando assets PostgreSQL: ${error.message}`);
		process.exitCode = 1;
	});
}

export { parseArguments };

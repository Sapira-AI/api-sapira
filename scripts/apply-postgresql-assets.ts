import * as path from 'path';

import 'dotenv/config';
import { Client } from 'pg';

import { assertTargetAllowed, AssetMode, AssetRunnerOptions, discoverSqlAssets, runSqlAssets } from '@/databases/postgresql/assets-runner';
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
}

function parseArguments(args: string[], environment: NodeJS.ProcessEnv): CliArguments {
	let mode: AssetMode = 'plan';
	let target = environment.DATABASE_TARGET ?? environment.NODE_ENV ?? 'development';
	let allowProduction = false;
	let confirmTarget: string | undefined;
	const only: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === '--plan') mode = 'plan';
		else if (argument === '--dry-run') mode = 'dry-run';
		else if (argument === '--apply') mode = 'apply';
		else if (argument === '--baseline') mode = 'baseline';
		else if (argument === '--allow-production') allowProduction = true;
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

	return { mode, target, allowProduction, confirmTarget, only: only.length > 0 ? only : undefined };
}

async function main(): Promise<void> {
	const arguments_ = parseArguments(process.argv.slice(2), process.env);
	const options: AssetRunnerOptions = {
		assetsRoot: path.resolve(__dirname, '../src/databases/postgresql'),
		mode: arguments_.mode,
		target: arguments_.target,
		allowProduction: arguments_.allowProduction,
		confirmTarget: arguments_.confirmTarget,
		only: arguments_.only,
	};
	assertTargetAllowed(options);

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

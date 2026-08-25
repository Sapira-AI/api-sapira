import * as path from 'path';

import { Client } from 'pg';

import { assertTargetAllowed, AssetMode, AssetRunnerOptions, runSqlAssets } from '@/databases/postgresql/assets-runner';

interface CliArguments {
	mode: AssetMode;
	target: string;
	allowProduction: boolean;
	confirmTarget?: string;
}

function parseArguments(args: string[], environment: NodeJS.ProcessEnv): CliArguments {
	let mode: AssetMode = 'plan';
	let target = environment.DATABASE_TARGET ?? environment.NODE_ENV ?? 'development';
	let allowProduction = false;
	let confirmTarget: string | undefined;

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === '--plan') mode = 'plan';
		else if (argument === '--dry-run') mode = 'dry-run';
		else if (argument === '--apply') mode = 'apply';
		else if (argument === '--allow-production') allowProduction = true;
		else if (argument === '--mode') {
			const value = args[++index];
			if (value !== 'plan' && value !== 'dry-run' && value !== 'apply') throw new Error('--mode debe ser plan, dry-run o apply.');
			mode = value;
		} else if (argument === '--target') {
			target = requireValue(argument, args[++index]);
		} else if (argument === '--confirm-target') {
			confirmTarget = requireValue(argument, args[++index]);
		} else {
			throw new Error(`Argumento no reconocido: ${argument}`);
		}
	}

	return { mode, target, allowProduction, confirmTarget };
}

async function main(): Promise<void> {
	const arguments_ = parseArguments(process.argv.slice(2), process.env);
	const options: AssetRunnerOptions = {
		assetsRoot: path.resolve(__dirname, '../src/databases/postgresql'),
		mode: arguments_.mode,
		target: arguments_.target,
		allowProduction: arguments_.allowProduction,
		confirmTarget: arguments_.confirmTarget,
	};
	assertTargetAllowed(options);

	if (options.mode === 'plan') {
		printResult(await runSqlAssets(undefined, options), options);
		return;
	}

	const connectionString = process.env.SUPABASE_DATABASE_URL ?? process.env.DATABASE_URL;
	if (!connectionString) throw new Error('SUPABASE_DATABASE_URL o DATABASE_URL debe estar configurada para dry-run o apply.');

	const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
	await client.connect();
	try {
		printResult(await runSqlAssets(client, options), options);
	} finally {
		await client.end();
	}
}

function printResult(result: Awaited<ReturnType<typeof runSqlAssets>>, options: AssetRunnerOptions): void {
	console.log(`Modo: ${options.mode}; target: ${options.target}; assets descubiertos: ${result.assets.length}`);
	for (const asset of result.assets) {
		const status = result.applied.includes(asset.path) ? 'APLICADO' : result.skipped.includes(asset.path) ? 'OMITIDO' : 'PENDIENTE';
		console.log(`${status} ${asset.path} ${asset.checksum}`);
	}
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

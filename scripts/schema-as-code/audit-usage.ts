/**
 * audit-usage.ts — audita si una tabla o función del esquema `public` está en uso.
 *
 * Reúne en un solo informe las señales que hay que cruzar antes de borrar algo, con
 * su nivel de confianza. Ninguna señal por separado alcanza: la de más peso
 * (`pg_stat_user_tables.seq_scan + idx_scan = 0`) prueba que una tabla **nunca se
 * leyó**, pero para funciones no hay equivalente si `track_functions` está apagado.
 *
 * Uso:
 *   yarn schema:audit --target production --table integration_logs
 *   yarn schema:audit --target production --function cleanup_old_processed_records
 *   yarn schema:audit --target production --unused-tables      # barrido completo
 */
import { execFileSync } from 'child_process';
import * as path from 'path';

import 'dotenv/config';
import { Client } from 'pg';

import { assertConnectionMatchesTarget } from '@/databases/postgresql/connection-target';

const REPOS = [path.resolve(__dirname, '../../src'), path.resolve(__dirname, '../../../front-sapira-vite/src')];

/** Cuenta referencias al nombre en el código de ambos repos, ignorando el corpus SQL. */
function referenciasEnCodigo(nombre: string): number {
	let total = 0;
	for (const repo of REPOS) {
		try {
			const salida = execFileSync('grep', ['-rl', '--include=*.ts', '--include=*.tsx', nombre, repo], { encoding: 'utf8' });
			total += salida.split('\n').filter((linea) => linea && !linea.includes('/databases/postgresql/')).length;
		} catch {
			// grep sale 1 cuando no hay coincidencias
		}
	}
	return total;
}

async function auditarTabla(client: Client, tabla: string): Promise<void> {
	const { rows } = await client.query(
		`SELECT n_live_tup AS filas, seq_scan, idx_scan, n_tup_ins AS insertados, n_tup_upd AS actualizados, n_tup_del AS borrados,
		        pg_size_pretty(pg_total_relation_size(relid)) AS tamano
		 FROM pg_stat_user_tables WHERE schemaname = 'public' AND relname = $1`,
		[tabla]
	);
	if (rows.length === 0) return console.log(`  La tabla "${tabla}" no existe en public.`);

	const t = rows[0];
	const lecturas = Number(t.seq_scan) + Number(t.idx_scan ?? 0);
	console.log(`  filas: ${t.filas} · tamaño: ${t.tamano}`);
	console.log(`  escrituras: ${t.insertados} ins / ${t.actualizados} upd / ${t.borrados} del`);
	console.log(`  LECTURAS: ${lecturas} (seq ${t.seq_scan} + idx ${t.idx_scan ?? 0}) ${lecturas === 0 ? '← nunca se leyó' : ''}`);

	const { rows: deps } = await client.query(
		`SELECT 'FK entrante' AS tipo, con.conname AS nombre FROM pg_constraint con
		   JOIN pg_class cl ON cl.oid = con.confrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
		   WHERE con.contype = 'f' AND n.nspname = 'public' AND cl.relname = $1
		 UNION ALL
		 SELECT 'función', p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
		   WHERE n.nspname = 'public' AND p.prokind = 'f' AND pg_get_functiondef(p.oid) ~* ('\\m' || $1 || '\\M')
		 UNION ALL
		 SELECT 'vista', cl.relname FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
		   WHERE n.nspname = 'public' AND cl.relkind IN ('v','m') AND pg_get_viewdef(cl.oid) ~* ('\\m' || $1 || '\\M')`,
		[tabla]
	);
	console.log(`  dependencias en la base: ${deps.length === 0 ? 'ninguna' : deps.map((d) => `${d.tipo}:${d.nombre}`).join(', ')}`);
	console.log(`  referencias en código: ${referenciasEnCodigo(tabla)} archivos`);
}

async function auditarFuncion(client: Client, funcion: string): Promise<void> {
	const { rows: existe } = await client.query(
		`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
		 WHERE n.nspname = 'public' AND p.proname = $1`,
		[funcion]
	);
	if (existe[0].n === 0) return console.log(`  La función "${funcion}" no existe en public.`);

	const { rows: stats } = await client.query(`SELECT calls FROM pg_stat_user_functions WHERE schemaname = 'public' AND funcname = $1`, [funcion]);
	const track = (await client.query(`SELECT current_setting('track_functions') AS v`)).rows[0].v;
	console.log(`  llamadas registradas: ${stats.length > 0 ? stats[0].calls : track === 'none' ? 'sin dato (track_functions=none)' : '0'}`);

	const { rows: deps } = await client.query(
		`SELECT 'otra función' AS tipo, p.proname AS nombre FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
		   WHERE n.nspname='public' AND p.prokind='f' AND p.proname <> $1 AND pg_get_functiondef(p.oid) ~* ('\\m' || $1 || '\\M')
		 UNION ALL
		 SELECT 'trigger', t.tgname FROM pg_trigger t WHERE NOT t.tgisinternal AND pg_get_triggerdef(t.oid) ~* ('\\m' || $1 || '\\M')
		 UNION ALL
		 SELECT 'policy', policyname FROM pg_policies
		   WHERE schemaname='public' AND (coalesce(qual,'') || coalesce(with_check,'')) ~* ('\\m' || $1 || '\\M')
		 UNION ALL
		 SELECT 'cron', 'job ' || jobid::text FROM cron.job WHERE command ~* ('\\m' || $1 || '\\M')`,
		[funcion]
	);
	console.log(`  dependencias en la base: ${deps.length === 0 ? 'ninguna' : deps.map((d) => `${d.tipo}:${d.nombre}`).join(', ')}`);
	console.log(`  referencias en código: ${referenciasEnCodigo(funcion)} archivos`);

	// Una función que referencia columnas inexistentes no puede ejecutarse: eso zanja la duda.
	const { rows: escribe } = await client.query(
		`SELECT DISTINCT regexp_replace(m[1], '^public\\.', '') AS tabla
		 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
		      LATERAL regexp_matches(pg_get_functiondef(p.oid), 'INSERT INTO\\s+([a-z_.]+)', 'gi') AS m
		 WHERE n.nspname='public' AND p.proname = $1`,
		[funcion]
	);
	console.log(`  deja rastro escribiendo en: ${escribe.length === 0 ? 'nada (no auditable por datos)' : escribe.map((e) => e.tabla).join(', ')}`);
}

async function tablasSinLecturas(client: Client): Promise<void> {
	const { rows } = await client.query(
		`SELECT relname AS tabla, n_live_tup AS filas, seq_scan + coalesce(idx_scan, 0) AS lecturas,
		        n_tup_ins AS insertados, pg_size_pretty(pg_total_relation_size(relid)) AS tamano
		 FROM pg_stat_user_tables WHERE schemaname = 'public'
		 ORDER BY lecturas, n_live_tup DESC LIMIT 25`
	);
	console.log('  tabla                                        filas  lecturas  tamaño');
	for (const r of rows) {
		console.log(`  ${String(r.tabla).padEnd(44)} ${String(r.filas).padStart(6)} ${String(r.lecturas).padStart(9)}  ${r.tamano}`);
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const valor = (bandera: string): string | undefined => (args.includes(bandera) ? args[args.indexOf(bandera) + 1] : undefined);

	const target = valor('--target');
	if (!target) throw new Error('Falta --target <entorno>.');

	const connectionString = process.env.SUPABASE_DATABASE_URL ?? process.env.DATABASE_URL;
	if (!connectionString) throw new Error('SUPABASE_DATABASE_URL o DATABASE_URL debe estar configurada.');
	const resolved = assertConnectionMatchesTarget(connectionString, target);

	const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
	await client.connect();
	try {
		await client.query('BEGIN TRANSACTION READ ONLY');
		const reset = await client.query(`SELECT stats_reset::date AS desde FROM pg_stat_database WHERE datname = current_database()`);
		console.log(
			`Auditando ${resolved.projectRef ?? 'base local'} (${resolved.environment}) · contadores acumulados desde ${reset.rows[0].desde}\n`
		);

		const tabla = valor('--table');
		const funcion = valor('--function');
		if (tabla) {
			console.log(`=== TABLA ${tabla} ===`);
			await auditarTabla(client, tabla);
		} else if (funcion) {
			console.log(`=== FUNCIÓN ${funcion} ===`);
			await auditarFuncion(client, funcion);
		} else if (args.includes('--unused-tables')) {
			console.log('=== tablas con menos lecturas ===');
			await tablasSinLecturas(client);
		} else {
			throw new Error('Indica --table <nombre>, --function <nombre> o --unused-tables.');
		}
		await client.query('ROLLBACK');
	} finally {
		await client.end();
	}
}

if (require.main === module) {
	main().catch((error: Error) => {
		console.error(`Error auditando: ${error.message}`);
		process.exitCode = 1;
	});
}

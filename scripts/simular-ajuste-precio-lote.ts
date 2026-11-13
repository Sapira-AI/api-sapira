/**
 * Simulación en SOLO LECTURA del ajuste de precio en lote (Domi 13-11): corre la vista previa de `ContractBulkChangesService` sobre los
 * contratos Activos del holding. Todas las consultas pasan por una conexión en `START TRANSACTION READ ONLY` (un INSERT fallaría) y
 * termina en ROLLBACK.
 *
 *   DOTENV_CONFIG_PATH=.env.prod.db npx ts-node -r tsconfig-paths/register scripts/simular-ajuste-precio-lote.ts \
 *     --holding <uuid> --porcentaje 5 --mes 2026-12 --out /ruta/resultado.json
 */
import { writeFileSync } from 'fs';

import 'dotenv/config';
import { DataSource } from 'typeorm';

import { ContractBulkChangesService } from '@/modules/contracts/contract-bulk-changes.service';
import { ContractChangesService } from '@/modules/contracts/contract-changes.service';
import { ContractScheduledChangesService } from '@/modules/contracts/contract-scheduled-changes.service';

type Row = Record<string, unknown>;

const arg = (name: string) => {
	const index = process.argv.indexOf(`--${name}`);

	return index > -1 ? process.argv[index + 1] : undefined;
};

async function main() {
	const holdingId = arg('holding');
	const out = arg('out');

	if (!holdingId) throw new Error('Falta --holding');
	const url = new URL(process.env.SUPABASE_DATABASE_URL ?? '');

	url.search = '';
	const dataSource = new DataSource({ type: 'postgres', url: url.toString(), ssl: { rejectUnauthorized: false } });

	await dataSource.initialize();
	const runner = dataSource.createQueryRunner();

	await runner.connect();
	await runner.query('START TRANSACTION READ ONLY');
	try {
		const readOnly = { query: (sql: string, params?: unknown[]) => runner.query(sql, params) } as unknown as DataSource;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const changes = new (ContractChangesService as any)(readOnly, null, null, null, null) as ContractChangesService;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const scheduled = new (ContractScheduledChangesService as any)(readOnly, null, changes) as ContractScheduledChangesService;
		const bulk = new ContractBulkChangesService(readOnly, changes, scheduled);
		const ids = (
			(await runner.query(`SELECT id FROM contracts WHERE holding_id = $1 AND deleted_at IS NULL AND status = 'Activo' ORDER BY id`, [
				holdingId,
			])) as Row[]
		).map((row) => String(row.id));
		const data: Row[] = [];

		for (let index = 0; index < ids.length; index += 100) {
			const page = await bulk.previewScheduledChange(
				{
					ids: ids.slice(index, index + 100),
					change: {
						trigger: 'on_date',
						effective_date: `${arg('mes') ?? '2026-12'}-01`,
						kind: 'percent_uplift',
						value: Number(arg('porcentaje') ?? 5),
					},
				},
				holdingId
			);

			data.push(...(page.data as unknown as Row[]));
		}
		const ok = data.filter((row) => row.can_save);
		const tally = (values: string[]) =>
			Object.entries(values.reduce<Record<string, number>>((acc, value) => ({ ...acc, [value]: (acc[value] ?? 0) + 1 }), {})).sort(
				(a, b) => b[1] - a[1]
			);
		const generic = (text: string) =>
			text
				.replace(/"[^"]*"/g, '"…"')
				.replace(/[\d.,/-]+/g, '#')
				.slice(0, 130);

		console.log(
			JSON.stringify(
				{
					contratos_activos: data.length,
					se_guardaria: ok.length,
					desde_el_mes: ok.filter((row) => row.applies === 'on_date').length,
					al_renovarse: ok.filter((row) => row.applies === 'on_renewal').length,
					con_bloqueo_hoy: ok.filter((row) => (row.blockers as string[]).length).length,
					con_items_excluidos: ok.filter((row) => Number(row.items_excluded) > 0).length,
					omitidos: tally(data.filter((row) => !row.can_save).map((row) => generic(String(row.skip_reason)))),
					bloqueos: tally(ok.flatMap((row) => (row.blockers as string[]).map(generic))),
					avisos: tally(ok.flatMap((row) => (row.warnings as string[]).map(generic))).slice(0, 8),
					fecha_efectiva: tally(ok.map((row) => `${row.applies} ${String(row.effective_date).slice(0, 7)}`))
						.sort()
						.slice(0, 14),
					mrr_por_moneda: Object.fromEntries(
						[...new Set(ok.map((row) => String(row.currency)))].map((currency) => {
							const rows = ok.filter((row) => row.currency === currency);
							const sum = (key: string) => Math.round(rows.reduce((total, row) => total + Number(row[key] ?? 0), 0));

							return [currency, { contratos: rows.length, antes: sum('mrr_before'), despues: sum('mrr_after') }];
						})
					),
				},
				null,
				1
			)
		);
		if (out) writeFileSync(out, JSON.stringify(data, null, 1));
	} finally {
		await runner.query('ROLLBACK');
		await runner.release();
		await dataSource.destroy();
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});

/**
 * Simulación en SOLO LECTURA de la renovación automática (Domi 13-11): para cada contrato con ítems `auto_renew` que vencen hasta
 * `--hasta` calcula el plan del cambio `renewal` (mismo motor que el job `contracts-auto-renewal`) y reporta si se podría aplicar,
 * sus bloqueos y el resultado. No escribe: todo corre dentro de `START TRANSACTION READ ONLY` y termina en ROLLBACK.
 *
 *   DOTENV_CONFIG_PATH=.env.prod.db npx ts-node -r tsconfig-paths/register scripts/simular-renovacion-automatica.ts \
 *     --holding <uuid> --hasta 2027-01-31 --out /ruta/resultado.json
 */
import { writeFileSync } from 'fs';

import 'dotenv/config';
import { DataSource } from 'typeorm';

import { planChange } from '@/modules/contracts/contract-changes';
import { ContractChangesService } from '@/modules/contracts/contract-changes.service';
import type { ContractChangeRequestDto } from '@/modules/contracts/dtos/contract-changes.dto';

type Row = Record<string, unknown>;

const arg = (name: string) => {
	const index = process.argv.indexOf(`--${name}`);

	return index > -1 ? process.argv[index + 1] : undefined;
};

async function main() {
	const holdingId = arg('holding');
	const until = arg('hasta') ?? '2027-01-31';
	const today = arg('hoy') ?? new Date().toISOString().slice(0, 10);
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
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const service = new (ContractChangesService as any)(dataSource, null, null, null, null) as ContractChangesService;
		const rows = (await runner.query(
			`SELECT ci.id, ci.contract_id, c.contract_number, c.status, ci.end_date::text AS end_date, COALESCE(ci.auto_renew_term_months, 12) AS term, ci.auto_renew_term_months AS art
			FROM contract_items ci JOIN contracts c ON c.id = ci.contract_id AND c.holding_id = ci.holding_id
			WHERE c.holding_id = $1 AND c.deleted_at IS NULL AND c.status = 'Activo'
				AND ci.is_recurring = true AND ci.auto_renew = true AND ci.renewed_by_item_id IS NULL AND ci.churn_date IS NULL
				AND COALESCE(ci.categoria, '') NOT IN ('CHURN', 'DOWNSELL')
				AND NOT (ci.related_item_id IS NOT NULL AND COALESCE(ci.categoria, '') = 'UPSELL')
				AND ci.end_date IS NOT NULL AND ci.end_date >= $2::date AND ci.end_date <= $3::date
			ORDER BY ci.end_date, ci.contract_id`,
			[holdingId, today, until]
		)) as Row[];
		const byContract = new Map<string, Row[]>();

		for (const row of rows) byContract.set(String(row.contract_id), [...(byContract.get(String(row.contract_id)) ?? []), row]);
		const results: Row[] = [];

		for (const [contractId, items] of byContract) {
			const request = {
				effective_date: today,
				origin: { type: 'manual' },
				reason: 'Renovación automática',
				change: {
					type: 'renewal',
					items: items.map((item) => ({ item_id: String(item.id), ...(item.term ? { term_months: Number(item.term) } : {}) })),
				},
			} as ContractChangeRequestDto;
			const base = {
				contract_number: items[0].contract_number,
				end_date: items[0].end_date,
				items: items.length,
				terms: items.map((item) => Number(item.term)),
				without_auto_term: items.filter((item) => item.art === null).length,
			};

			try {
				const ctx = await service.loadContext(runner, contractId, holdingId, request, today);
				const plan = planChange(ctx, request);
				const inserted = plan.ops.filter((op) => op.kind === 'insert_item');
				const group = ctx.items.filter((item) => !item.renewed_by_item_id && !item.churn_date);

				results.push({
					...base,
					can_apply: plan.preview.can_apply,
					blockers: plan.preview.blockers.map((blocker) => `${blocker.code}: ${blocker.message}`),
					warnings: plan.preview.warnings.map((warning) => warning.code),
					warning_messages: plan.preview.warnings.map((warning) => `${warning.code}: ${warning.message}`),
					billing: [
						...new Set(
							ctx.items
								.filter((item) => !item.renewed_by_item_id && !item.churn_date)
								.map((item) => `${item.billing_frequency}/${item.term_months}m`)
						),
					],
					live_items_before: group.length,
					items_created: inserted.length,
					items_marked_renewed: plan.ops.filter((op) => op.kind === 'update_item' && 'renewed_by_key' in (op as { set: Row }).set).length,
					pacts_applied: plan.ops.filter((op) => op.kind === 'update_scheduled_change').length,
					mrr_before: plan.preview.contract.before.mrr,
					end_after: plan.preview.contract.after.end_date,
					invoices_created: plan.preview.invoices.created.length,
					invoices_updated: plan.preview.invoices.updated.length,
				});
			} catch (error) {
				const response = (error as { getResponse?: () => unknown }).getResponse?.();

				results.push({ ...base, can_apply: false, error: response ? JSON.stringify(response).slice(0, 400) : String(error).slice(0, 400) });
			}
		}
		const ok = results.filter((row) => row.can_apply === true);
		const tally = (values: string[]) =>
			Object.entries(values.reduce<Record<string, number>>((acc, value) => ({ ...acc, [value]: (acc[value] ?? 0) + 1 }), {})).sort(
				(a, b) => b[1] - a[1]
			);

		console.log(
			JSON.stringify(
				{
					holding: holdingId,
					hoy: today,
					hasta: until,
					contratos: results.length,
					se_renovarian: ok.length,
					no_se_renovarian: results.length - ok.length,
					bloqueos: tally(results.flatMap((row) => ((row.blockers as string[]) ?? []).map((text) => text.split(':')[0]))),
					errores: tally(results.filter((row) => row.error).map((row) => String(row.error).slice(0, 160))),
					avisos: tally(ok.flatMap((row) => row.warnings as string[])),
					facturas_nuevas: ok.reduce((sum, row) => sum + Number(row.invoices_created), 0),
					items_nuevos: ok.reduce((sum, row) => sum + Number(row.items_created), 0),
					por_mes_de_fin: tally(results.map((row) => `${String(row.end_date).slice(0, 7)} ${row.can_apply ? 'ok' : 'no'}`)).sort(),
				},
				null,
				1
			)
		);
		if (out) writeFileSync(out, JSON.stringify(results, null, 1));
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

import type { AppNotification } from '@/databases/postgresql/entities/automatizaciones-ia/app-notification.entity';

import { reconcileContractAlerts, staleContractAlertIds } from './contract-alerts';

const HOLDING = 'holding-1';
const CONTRACT = 'contract-1';

const notification = (id: string, key: string, payload: Record<string, unknown> = {}) =>
	({ id, deduplication_key: key, action_payload: payload }) as unknown as AppNotification;

describe('cierre automático de alertas de Contratos (Notificaciones v2)', () => {
	const build = (rows: { pending?: string[]; openProposals?: string[]; pacts?: Array<Record<string, unknown>> }) => {
		const db = {
			query: jest.fn(async (sql: string) => {
				if (sql.includes('SELECT DISTINCT ci.end_date')) return (rows.pending ?? []).map((end_date) => ({ end_date }));
				if (sql.includes('FROM contract_lifecycle_events')) return (rows.openProposals ?? []).map((id) => ({ id }));
				if (sql.includes('FROM contract_scheduled_changes')) return rows.pacts ?? [];
				return [];
			}),
		};

		return db;
	};
	const notifier = (open: Record<string, AppNotification[]>) => ({
		listOpen: jest.fn(async (_holding: string, type: string): Promise<AppNotification[]> => open[type] ?? []),
		resolveOpen: jest.fn(async (_holding: string, criteria: { ids?: string[] }) => criteria.ids?.length ?? 0),
	});

	it('vencimiento: se cierra solo el fin que ya no tiene ítems sin decisión', async () => {
		const db = build({ pending: ['2027-01-31'] });
		const ids = await staleContractAlertIds(
			db,
			notifier({
				contract_renewal_reminder: [
					notification('r-dec', `contracts:renewal-reminder:${CONTRACT}:2026-12-31`),
					notification('r-open', `contracts:renewal-reminder:${CONTRACT}:2027-01-31`),
				],
			}),
			HOLDING,
			CONTRACT
		);

		expect(ids).toEqual(['r-dec']);
	});

	it('propuesta: se cierra al dejar de estar abierta (confirmada u omitida)', async () => {
		const db = build({ openProposals: ['event-open'] });
		const ids = await staleContractAlertIds(
			db,
			notifier({
				contract_renewal_proposed: [
					notification('p-open', 'contracts:renewal-proposal:event-open', { event_id: 'event-open' }),
					notification('p-done', 'contracts:renewal-proposal:event-done', { event_id: 'event-done' }),
				],
			}),
			HOLDING,
			CONTRACT
		);

		expect(ids).toEqual(['p-done']);
	});

	it('pacto: se cierra al aplicarlo, omitirlo o cancelarlo, o si su próxima fecha avanzó', async () => {
		const db = build({
			pacts: [
				{ id: 'pact-applied', status: 'applied', due_date: '2026-12-01' },
				{ id: 'pact-moved', status: 'scheduled', due_date: '2027-12-01' },
				{ id: 'pact-due', status: 'scheduled', due_date: '2026-12-01' },
			],
		});
		const pact = (id: string) => notification(`n-${id}`, `contracts:scheduled-change-due:${id}:2026-12-01`, { scheduled_change_id: id });
		const ids = await staleContractAlertIds(
			db,
			notifier({ contract_scheduled_change_due: [pact('pact-applied'), pact('pact-moved'), pact('pact-due'), pact('pact-gone')] }),
			HOLDING,
			CONTRACT
		);

		expect(ids).toEqual(['n-pact-applied', 'n-pact-moved', 'n-pact-gone']);
	});

	it('reconcile cierra las vencidas de una vez; sin alertas no consulta la base; nunca lanza', async () => {
		const db = build({});
		const quiet = notifier({});

		await expect(reconcileContractAlerts(db, quiet, HOLDING, CONTRACT)).resolves.toBe(0);
		expect(db.query).not.toHaveBeenCalled();
		expect(quiet.resolveOpen).not.toHaveBeenCalled();

		const some = notifier({ contract_renewal_reminder: [notification('r-1', `contracts:renewal-reminder:${CONTRACT}:2026-12-31`)] });

		await expect(reconcileContractAlerts(db, some, HOLDING, CONTRACT)).resolves.toBe(1);
		expect(some.resolveOpen).toHaveBeenCalledWith(HOLDING, { ids: ['r-1'] });

		const errors: string[] = [];
		const broken = { listOpen: jest.fn().mockRejectedValue(new Error('caída')), resolveOpen: jest.fn() };

		await expect(reconcileContractAlerts(db, broken, HOLDING, CONTRACT, (message) => errors.push(message))).resolves.toBe(0);
		expect(errors[0]).toContain('caída');
	});
});

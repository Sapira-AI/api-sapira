// `InvoiceConsolidationRulesService` arrastra la consolidación y el scheduler de facturas (uuid ESM): se simula como en los otros specs.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { BadRequestException, ConflictException } from '@nestjs/common';

import { issueDayOf, planRuleGroups, type RuleInvoice, type RuleUnified, validateRuleInput } from './invoice-consolidation-rules';
import { InvoiceConsolidationRulesService } from './invoice-consolidation-rules.service';

const inv = (overrides: Partial<RuleInvoice> = {}): RuleInvoice => ({
	id: 'i-a',
	contract_id: 'c-a',
	contract_number: 'CTR-A',
	company_id: 'co-1',
	invoice_currency: 'CLP',
	document_type: 'FACTURA',
	export_type: 0,
	invoice_series: null,
	month: '2026-10',
	issue_date: '2026-10-01',
	total: 100,
	consolidated_into_invoice_id: null,
	...overrides,
});
const unified = (overrides: Partial<RuleUnified> = {}): RuleUnified => ({
	id: 'u-1',
	invoice_number: null,
	status: 'Por Emitir',
	issue_date: '2026-10-01',
	total: 200,
	currency: 'CLP',
	sent_to_erp: false,
	...overrides,
});

describe('unificación recurrente (spec-unificacion-recurrente.md)', () => {
	describe('planRuleGroups', () => {
		it('por mes y documento: une 2+ contratos, deja solo el de un contrato y separa otra moneda; también meses pasados', () => {
			const groups = planRuleGroups(
				[
					inv({ id: 'sep-a', month: '2026-09', issue_date: '2026-09-01' }),
					inv({ id: 'sep-b', contract_id: 'c-b', month: '2026-09', issue_date: '2026-09-15' }),
					inv({ id: 'oct-a' }),
					inv({ id: 'oct-b-usd', contract_id: 'c-b', invoice_currency: 'USD' }),
				],
				new Map()
			);

			expect(groups.map((group) => [group.month, group.action, group.to_consolidate])).toEqual([
				['2026-09', 'unify', ['sep-a', 'sep-b']],
				['2026-10', 'single', []],
				['2026-10', 'single', []],
			]);
		});

		it('ya unificado sin sueltas: nada; con una factura nueva: re-unificar si sigue Por Emitir sin ERP, si ya salió queda bloqueado', () => {
			const origins = [
				inv({ id: 'o-a', consolidated_into_invoice_id: 'u-1' }),
				inv({ id: 'o-b', contract_id: 'c-b', consolidated_into_invoice_id: 'u-1' }),
			];
			const nueva = inv({ id: 'n-c', contract_id: 'c-c' });

			expect(planRuleGroups(origins, new Map([['u-1', unified()]]))[0].action).toBe('unified');
			expect(planRuleGroups([...origins, nueva], new Map([['u-1', unified()]]))[0]).toMatchObject({
				action: 'reunify',
				to_consolidate: ['o-a', 'o-b', 'n-c'],
			});
			const sent = planRuleGroups([...origins, nueva], new Map([['u-1', unified({ sent_to_erp: true })]]))[0];

			expect(sent.action).toBe('blocked');
			expect(sent.blockers.map((blocker) => blocker.code)).toEqual(['unified_already_sent']);
		});
	});

	it('issueDayOf: día de la próxima Por Emitir; sin próximas, el de la última', () => {
		expect(issueDayOf(['2026-09-15', '2026-10-20', '2026-11-20'], '2026-10-05')).toBe(20);
		expect(issueDayOf(['2026-08-10', '2026-09-10'], '2026-10-05')).toBe(10);
		expect(issueDayOf([], '2026-10-05')).toBeNull();
	});

	it('validateRuleInput: 2+ contratos activos de la razón social y el principal dentro de la lista', () => {
		const active = new Set(['c-a', 'c-b']);

		expect(validateRuleInput({ contract_ids: ['c-a', 'c-b'], main_contract_id: 'c-a' }, active)).toEqual([]);
		expect(validateRuleInput({ contract_ids: ['c-a'], main_contract_id: 'c-a' }, active).map((error) => error.field)).toEqual(['contract_ids']);
		expect(validateRuleInput({ contract_ids: ['c-a', 'c-x'], main_contract_id: 'c-b' }, active).map((error) => error.field)).toEqual([
			'contract_ids',
			'main_contract_id',
		]);
	});

	describe('InvoiceConsolidationRulesService', () => {
		const RULE = {
			id: 'rule-1',
			holding_id: 'h-1',
			client_entity_id: 'e-1',
			main_contract_id: 'c-a',
			contract_ids: ['c-a', 'c-b'],
			status: 'active',
			created_by: 'user-1',
			updated_by: null,
			created_by_name: 'Domi',
			created_at: '2026-10-05',
			updated_at: '2026-10-05',
		};
		const build = (
			options: { rule?: Record<string, unknown> | null; invoices?: Record<string, unknown>[]; unified?: Record<string, unknown>[] } = {}
		) => {
			const query = jest.fn(async (sql: string, ..._params: unknown[]) => {
				if (sql.includes('FROM users WHERE auth_id')) return [{ id: 'user-1' }];
				if (sql.includes('FROM client_entities WHERE id')) return [{ '?column?': 1 }];
				if (sql.includes('holding_settings')) return [{ timezone: 'America/Santiago' }];
				if (sql.includes('FROM invoice_consolidation_rules r')) return options.rule === null ? [] : [options.rule ?? RULE];
				if (sql.includes('FROM contracts c') && sql.includes('pending_dates'))
					return [
						{
							id: 'c-a',
							contract_number: 'CTR-A',
							client_id: 'cl-1',
							client_name: 'Ironside',
							company_id: 'co-1',
							pending_dates: ['2026-10-20'],
						},
						{
							id: 'c-b',
							contract_number: 'CTR-B',
							client_id: 'cl-2',
							client_name: 'Ninja Hubs',
							company_id: 'co-1',
							pending_dates: ['2026-10-05'],
						},
						{ id: 'c-c', contract_number: 'CTR-C', client_id: 'cl-2', client_name: 'Ninja Hubs', company_id: 'co-1', pending_dates: [] },
					];
				if (sql.includes('FROM invoices i JOIN contracts c'))
					return (
						options.invoices ?? [
							{
								id: 'i-a',
								contract_id: 'c-a',
								contract_number: 'CTR-A',
								company_id: 'co-1',
								invoice_currency: 'CLP',
								document_type: 'FACTURA',
								export_type: 0,
								month: '2026-10',
								issue_date: '2026-10-20',
								total: 100,
							},
							{
								id: 'i-b',
								contract_id: 'c-b',
								contract_number: 'CTR-B',
								company_id: 'co-1',
								invoice_currency: 'CLP',
								document_type: 'FACTURA',
								export_type: 0,
								month: '2026-10',
								issue_date: '2026-10-05',
								total: 50,
							},
						]
					);
				if (sql.includes('FROM invoices u WHERE')) return options.unified ?? [];
				if (sql.includes('contract_lifecycle_events e JOIN invoices u')) return [{ id: 'u-9' }];
				if (sql.includes('SELECT DISTINCT holding_id FROM invoice_consolidation_rules')) return [{ holding_id: 'h-1' }];

				return [];
			});
			const consolidation = {
				preview: jest.fn().mockResolvedValue({ blockers: [], warnings: [], header: { issue_date: '2026-10-20' } }),
				applyInvoices: jest.fn().mockResolvedValue({ applied: true }),
				undoInvoice: jest.fn().mockResolvedValue({ undone: true }),
			};
			const runner = {
				connect: jest.fn(),
				startTransaction: jest.fn(),
				commitTransaction: jest.fn(),
				rollbackTransaction: jest.fn(),
				release: jest.fn(),
				query,
			};
			const service = new InvoiceConsolidationRulesService({ query, createQueryRunner: () => runner } as never, consolidation as never);

			return { service, query, consolidation };
		};
		const AT = new Date('2026-10-05T15:00:00Z');

		it('guardar exige confirmar la fecha de emisión y valida los contratos', async () => {
			const { service } = build({ rule: null });

			await expect(
				service.save('e-1', { contract_ids: ['c-a', 'c-b'], main_contract_id: 'c-a', confirm_issue_date: false }, 'h-1', 'auth', AT)
			).rejects.toBeInstanceOf(BadRequestException);
			await expect(
				service.save('e-1', { contract_ids: ['c-a', 'c-x'], main_contract_id: 'c-a', confirm_issue_date: true }, 'h-1', 'auth', AT)
			).rejects.toBeInstanceOf(BadRequestException);
		});

		it('guardar crea la regla y une ya, con el principal, la regla y su origen en la consolidación', async () => {
			const { service, query, consolidation } = build();
			const result = await service.save(
				'e-1',
				{ contract_ids: ['c-a', 'c-b'], main_contract_id: 'c-a', confirm_issue_date: true },
				'h-1',
				'auth',
				AT
			);
			const insert = (query.mock.calls as unknown as Array<[string, unknown[]]>).find(([sql]) =>
				sql.includes('INSERT INTO invoice_consolidation_rules')
			)!;

			expect(insert[0]).toContain('ON CONFLICT (holding_id, client_entity_id)');
			expect(insert[1]).toEqual(['h-1', 'e-1', 'c-a', ['c-a', 'c-b'], 'user-1']);
			expect(consolidation.applyInvoices).toHaveBeenCalledWith(
				['i-a', 'i-b'],
				'h-1',
				'user-1',
				{ main_contract_id: 'c-a', rule_id: 'rule-1', source: 'razon_social_360' },
				AT
			);
			expect(result.result).toEqual({ unified: 1, blocked: 0 });
			// Contrato activo fuera de la regla: aviso (no se suma solo).
			expect(result.new_contract_ids).toEqual(['c-c']);
			expect(result.contracts.find((contract) => contract.id === 'c-a')).toMatchObject({ in_rule: true, issue_day: 20 });
		});

		it('un grupo bloqueado por la consolidación no frena al resto ni rompe la respuesta', async () => {
			const { service, consolidation } = build();

			consolidation.applyInvoices.mockRejectedValueOnce(new ConflictException({ code: 'blocked' }));
			const result = await service.save(
				'e-1',
				{ contract_ids: ['c-a', 'c-b'], main_contract_id: 'c-a', confirm_issue_date: true },
				'h-1',
				'auth',
				AT
			);

			expect(result.result).toEqual({ unified: 0, blocked: 1 });
		});

		it('re-unifica: deshace la unificada que sigue Por Emitir y la vuelve a armar con la factura nueva', async () => {
			const { service, consolidation } = build({
				invoices: [
					{
						id: 'o-a',
						contract_id: 'c-a',
						company_id: 'co-1',
						invoice_currency: 'CLP',
						document_type: 'FACTURA',
						export_type: 0,
						month: '2026-10',
						consolidated_into_invoice_id: 'u-1',
					},
					{
						id: 'o-b',
						contract_id: 'c-b',
						company_id: 'co-1',
						invoice_currency: 'CLP',
						document_type: 'FACTURA',
						export_type: 0,
						month: '2026-10',
						consolidated_into_invoice_id: 'u-1',
					},
					{
						id: 'n-b',
						contract_id: 'c-b',
						company_id: 'co-1',
						invoice_currency: 'CLP',
						document_type: 'FACTURA',
						export_type: 0,
						month: '2026-10',
					},
				],
				unified: [{ id: 'u-1', status: 'Por Emitir', sent_to_erp: false }],
			});

			const results = await service.runAll(AT);

			expect(results).toEqual([{ holding_id: 'h-1', success: true, events: 1 }]);
			expect(consolidation.undoInvoice).toHaveBeenCalledWith('u-1', expect.any(String), 'h-1', 'user-1', AT, 'consolidation_rule_job');
			expect(consolidation.applyInvoices).toHaveBeenCalledWith(
				['o-a', 'o-b', 'n-b'],
				'h-1',
				'user-1',
				expect.objectContaining({ rule_id: 'rule-1' }),
				AT
			);
		});

		it('vista: estado por mes desde las facturas (pendiente con la fecha del principal) y pausar con deshacer', async () => {
			const { service, consolidation, query } = build();
			const view = await service.view('e-1', 'h-1', AT);

			expect(view.months).toEqual([expect.objectContaining({ month: '2026-10', state: 'pending', issue_date: '2026-10-20' })]);
			expect(consolidation.preview).toHaveBeenCalledWith({ invoice_ids: ['i-a', 'i-b'] }, 'h-1', 'c-a');
			expect(view.summary).toEqual({ unified: 0, pending: 1, blocked: 0, single: 0 });
			const paused = await service.pause('e-1', { undo_pending: true }, 'h-1', 'auth', AT);

			expect((query.mock.calls as unknown as Array<[string]>).some(([sql]) => sql.includes("SET status = 'paused'"))).toBe(true);
			expect(consolidation.undoInvoice).toHaveBeenCalledWith('u-9', expect.any(String), 'h-1', 'user-1', AT, 'razon_social_360');
			expect(paused.result).toEqual({ undone: 1, kept: 0 });
		});
	});
});

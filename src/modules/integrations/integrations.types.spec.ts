import {
	buildMappingView,
	errorsSummary,
	filterRuns,
	IntegrationRun,
	lastMonthRange,
	MappingRow,
	nextDailyAtInZone,
	normalizeText,
	parseRunId,
	ruleConditionSql,
	runStatusOf,
	secretInfo,
	stagingStatus,
	suggestRef,
} from './integrations.types';

describe('Integraciones · helpers puros', () => {
	it('equivalencia de estados de las tablas intermedias (contrato §4)', () => {
		expect(['create', 'update', 'to_create', 'to_update'].map(stagingStatus)).toEqual(['ready', 'ready', 'ready', 'ready']);
		expect(['processed', 'no_change', 'integrated'].map(stagingStatus)).toEqual(['imported', 'imported', 'imported']);
		expect(['error', 'invalid', 'unmapped', 'changed_in_source'].map(stagingStatus)).toEqual(['error', 'error', 'error', 'error']);
		expect([null, 'pending', 'otro'].map(stagingStatus)).toEqual(['pending', 'pending', 'pending']);
	});

	it('las claves nunca salen completas: solo si hay y los últimos 4', () => {
		expect(secretInfo('sk_live_1234567890ABCD')).toEqual({ has_secret: true, secret_last4: 'ABCD' });
		expect(secretInfo('corta')).toEqual({ has_secret: true, secret_last4: null });
		expect(secretInfo(null)).toEqual({ has_secret: false, secret_last4: null });
	});

	it('reglas de exclusión → SQL parametrizado (todas las condiciones)', () => {
		const params: unknown[] = ['holding', 'crm'];
		const sql = ruleConditionSql(
			'r',
			{
				conditions: [
					{ field: 'raw_data.Owner.Name', operator: 'is', value: 'Tech touch' },
					{ field: 'raw_data.Forma_de_pago__c', operator: 'contains', value: '50%_' },
					{ field: 'error_message', operator: 'empty' },
				],
			},
			params
		);

		expect(sql).toBe(
			"((r.rule_row #>> $3::text[]) = $4) AND ((r.rule_row #>> $5::text[]) ILIKE $6) AND (COALESCE((r.rule_row #>> $7::text[]), '') = '')"
		);
		expect(params.slice(2)).toEqual([
			['raw_data', 'Owner', 'Name'],
			'Tech touch',
			['raw_data', 'Forma_de_pago__c'],
			'%50\\%\\_%',
			['error_message'],
		]);
	});

	it('sugerencias deterministas: código primero, después nombre normalizado', () => {
		const candidates = [
			{ id: '1', label: 'Licencia Anual', meta: { code: 'LIC-01' } },
			{ id: '2', label: 'Implementación', meta: { code: null } },
		];

		expect(suggestRef({ label: 'otra cosa', code: 'lic 01' }, candidates)?.id).toBe('1');
		expect(suggestRef({ label: 'IMPLEMENTACION' }, candidates)?.id).toBe('2');
		expect(suggestRef({ label: 'Soporte' }, candidates)).toBeNull();
		expect(normalizeText('  Ñandú-Ágil ')).toBe('nandu agil');
	});

	it('vista de mapeo: conteos sobre todo y filtros por estado y búsqueda', () => {
		const row = (key: string, status: MappingRow['status']): MappingRow => ({
			key,
			sapira: { id: key, label: `Producto ${key}`, meta: {} },
			external: null,
			status,
			suggestion: null,
			usage: null,
			meta: null,
		});
		const view = buildMappingView(
			{ object: 'products', object_label: 'Productos', anchor: 'sapira', external_available: true, external_error: null },
			[row('a', 'mapped'), row('b', 'unmapped'), row('c', 'suggested')],
			{
				status: 'unmapped',
			}
		);

		expect(view.counts).toEqual({ total: 3, mapped: 1, unmapped: 1, suggested: 1 });
		expect(view.data.map((item) => item.key)).toEqual(['b']);
	});

	it('estado de corrida y filtros del historial', () => {
		expect(runStatusOf({ running: true, ok: 0, errors: 0 })).toBe('running');
		expect(runStatusOf({ ok: 3, errors: 1 })).toBe('partial');
		expect(runStatusOf({ ok: 0, errors: 2 })).toBe('failed');
		expect(runStatusOf({ ok: 4, errors: 0 })).toBe('completed');
		const run = (id: string, started: string, status: IntegrationRun['status']) =>
			({ id, started_at: started, status, kind: 'k', trigger: 'manual' }) as IntegrationRun;

		expect(
			filterRuns([run('a', '2026-10-01T10:00:00Z', 'failed'), run('b', '2026-10-03T10:00:00Z', 'completed')], { from: '2026-10-02' }).map(
				(r) => r.id
			)
		).toEqual(['b']);
		expect(
			errorsSummary([
				{ status: 'error', message: 'X' },
				{ status: 'error', message: 'X' },
				{ status: 'ok', message: null },
			])
		).toEqual([{ message: 'X', count: 2 }]);
	});

	it('ids de corrida con dos puntos dentro', () => {
		expect(parseRunId('crm-job:salesforce-daily-sync:production:2026-10-03')).toEqual({
			source: 'crm-job',
			raw: 'salesforce-daily-sync:production:2026-10-03',
		});
		expect(parseRunId('sin-origen')).toBeNull();
	});

	it('próxima corrida del CRM a las 08:30 de Santiago y rango por defecto del último mes', () => {
		const next = nextDailyAtInZone(8, 30, 'America/Santiago', new Date('2026-10-03T15:00:00Z'));

		expect(next.toISOString()).toBe('2026-10-04T11:30:00.000Z');
		expect(lastMonthRange(new Date('2026-10-03T12:00:00Z'))).toEqual({ from: '2026-09-03', to: '2026-10-03' });
	});
});

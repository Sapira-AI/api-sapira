import {
	applyNotApplicable,
	buildMappingView,
	currentErrorRecurrence,
	errorRecurrence,
	errorsSummary,
	filterRuns,
	IntegrationRun,
	isInterruptedJob,
	lastMonthRange,
	MappingRow,
	nextDailyAtInZone,
	normalizeErrorMessage,
	normalizeText,
	parseRunId,
	ruleConditionSql,
	runErrorDeltas,
	RunOccurrence,
	runStatusOf,
	runTotals,
	secretInfo,
	stagingStatus,
	suggestRef,
	withRecurrence,
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

		expect(view.counts).toEqual({ total: 3, mapped: 1, unmapped: 1, suggested: 1, unused: 0, not_applicable: 0 });
		expect(view.data.map((item) => item.key)).toEqual(['b']);
	});

	it('No aplica: marca filas no mapeadas, las saca de los conteos y solo se ven con status=not_applicable; Sin uso cuenta aparte', () => {
		const row = (key: string, status: MappingRow['status']): MappingRow => ({
			key,
			sapira: { id: key, label: `Cliente ${key}`, meta: {} },
			external: null,
			status,
			suggestion: status === 'suggested' ? { id: 'x', label: 'X', meta: {} } : null,
			usage: null,
			meta: null,
		});
		const base = { object: 'customers', object_label: 'Clientes', anchor: 'sapira' as const, external_available: true, external_error: null };
		const rows = applyNotApplicable([row('a', 'mapped'), row('b', 'unmapped'), row('c', 'suggested'), row('d', 'unused')], ['a', 'b', 'c']);

		expect(rows.map((item) => item.status)).toEqual(['mapped', 'not_applicable', 'not_applicable', 'unused']);
		expect(rows[2].suggestion).toBeNull();
		const view = buildMappingView(base, rows, {});

		expect(view.counts).toEqual({ total: 2, mapped: 1, unmapped: 0, suggested: 0, unused: 1, not_applicable: 2 });
		expect(view.data.map((item) => item.key)).toEqual(['a', 'd']);
		expect(buildMappingView(base, rows, { status: 'not_applicable' }).data.map((item) => item.key)).toEqual(['b', 'c']);
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

describe('estado de corridas (ajuste de Domi 03-10)', () => {
	it('lo sin cambios cuenta como correcto: 0 bien · 1 error · 33 sin cambios = Con errores, no Falló', () => {
		const totals = runTotals({ total: 34, ok: 0, errors: 1 });

		expect(totals).toEqual({ total: 34, ok: 0, unchanged: 33, errors: 1, skipped: 33 });
		expect(runStatusOf({ ok: 0, unchanged: 33, errors: 1 })).toBe('partial');
	});

	it('todo sin cambios y sin errores = Correcta', () => {
		expect(runStatusOf({ ok: 0, unchanged: 12, errors: 0 })).toBe('completed');
		expect(runStatusOf({ ok: 0, errors: 0 })).toBe('completed');
	});

	it('Falló solo si la corrida no pudo ejecutarse sin procesar nada, o si todos los procesados fallaron', () => {
		expect(runStatusOf({ failed: true, ok: 0, unchanged: 0, errors: 0 })).toBe('failed');
		expect(runStatusOf({ ok: 0, unchanged: 0, errors: 5 })).toBe('failed');
		// La corrida se cortó después de procesar registros: Con errores.
		expect(runStatusOf({ failed: true, ok: 3, unchanged: 0, errors: 0 })).toBe('partial');
		expect(runStatusOf({ failed: true, ok: 0, unchanged: 4, errors: 1 })).toBe('partial');
	});

	it('en curso y cancelada mandan sobre los conteos', () => {
		expect(runStatusOf({ running: true, ok: 0, errors: 3 })).toBe('running');
		expect(runStatusOf({ cancelled: true, ok: 0, errors: 3 })).toBe('cancelled');
	});

	it('filtro de corridas con varios estados (failed,partial)', () => {
		const run = (id: string, status: IntegrationRun['status']) => ({ id, status, started_at: '2026-10-01T00:00:00Z' }) as IntegrationRun;
		const runs = [run('a', 'failed'), run('b', 'partial'), run('c', 'completed')];

		expect(filterRuns(runs, { status: ['failed', 'partial'] }).map((item) => item.id)).toEqual(['a', 'b']);
		expect(filterRuns(runs, { status: 'completed' }).map((item) => item.id)).toEqual(['c']);
	});

	describe('errores que se repiten', () => {
		const MSG =
			'Productos Salesforce sin mapping activo: Bundle TMS-ADA (01tRO00000N9nnTYAR). Cree el mapping manual antes de integrar la cotización.';
		const day = (d: string) => `2026-${d}T11:35:00.000Z`;
		const daily = (d: string, status: RunOccurrence['status'] = 'error', message: string | null = MSG): RunOccurrence => ({
			run_id: `crm-job:${d}`,
			kind: 'crm_daily',
			at: day(d),
			object: 'opportunity',
			record_key: '006G',
			status,
			message,
		});
		const run = (id: string, status: IntegrationRun['status'], started: string): IntegrationRun => ({
			id,
			tipo: 'crm',
			kind: 'crm_daily',
			kind_label: 'Sincronización diaria',
			trigger: 'automatic',
			status,
			started_at: started,
			finished_at: null,
			duration_ms: null,
			totals: { total: 0, ok: 0, unchanged: 0, errors: 0, skipped: 0 },
			error: null,
			metrics: {},
		});
		const history = ['09-26', '09-27', '09-28', '09-30', '10-01', '10-02'].map((d) => daily(d));

		it('normaliza: sin ids, fechas, números, mayúsculas, tildes ni espacios de más', () => {
			expect(normalizeErrorMessage('  Producto  01tRO00000N9nnTYAR sin   mapping el 2026-09-26T11:00:00Z (fila 12)')).toBe(
				'producto # sin mapping el # (fila #)'
			);
			expect(normalizeErrorMessage('Cliente cus_9s8d7f6g5h4 inválido')).toBe(normalizeErrorMessage('cliente cus_ZZ11aa22bb33 INVALIDO'));
			expect(normalizeErrorMessage('Factura 550e8400-e29b-41d4-a716-446655440000')).toBe('factura #');
		});

		it('caso Maderas Gavilán: 6 corridas diarias seguidas con el mismo error (26-sep → 02-oct)', () => {
			expect(errorRecurrence(history, { object: 'opportunity', record_key: '006G', message: MSG }, day('10-02'))).toEqual({
				first_seen_at: day('09-26'),
				runs_count: 6,
				consecutive: true,
			});
			// Primera vez: sin repetición. Otro registro u otro mensaje: tampoco.
			expect(errorRecurrence(history, { object: 'opportunity', record_key: '006G', message: MSG }, day('09-26'))).toBeNull();
			expect(errorRecurrence(history, { object: 'opportunity', record_key: '006X', message: MSG }, day('10-02'))).toBeNull();
			expect(errorRecurrence(history, { object: 'opportunity', record_key: '006G', message: 'Otro error' }, day('10-02'))).toBeNull();
		});

		it('consecutive = false si una corrida intermedia lo procesó bien o con otro error', () => {
			const broken = [...history, daily('09-29', 'ok', 'Cotización actualizada')];

			expect(errorRecurrence(broken, { object: 'opportunity', record_key: '006G', message: MSG }, day('10-02'))).toEqual(
				expect.objectContaining({ runs_count: 6, consecutive: false })
			);
			// Registros: después de un proceso correcto el error ya no es el actual.
			expect(
				currentErrorRecurrence([...history, daily('10-03', 'ok', null)], { object: 'opportunity', record_key: '006G', message: null })
			).toBeNull();
			expect(currentErrorRecurrence(history, { object: 'opportunity', record_key: '006G', message: 'texto de la tabla intermedia' })).toEqual(
				expect.objectContaining({ runs_count: 6 })
			);
		});

		it('detalle: recurrence por error y agregada por motivo; la corrida misma cuenta aunque no venga en el historial', () => {
			const detail = withRecurrence(
				{
					...run('crm-job:10-02', 'partial', day('10-02')),
					records: [
						{
							object: 'opportunity',
							record_key: '006G',
							label: 'Maderas Gavilán-',
							sapira_id: null,
							external_id: '006G',
							status: 'error',
							message: MSG,
						},
						{
							object: 'opportunity',
							record_key: '006N',
							label: 'Nueva',
							sapira_id: null,
							external_id: '006N',
							status: 'error',
							message: MSG,
						},
						{ object: 'opportunity', record_key: '006K', label: 'Ok', sapira_id: null, external_id: '006K', status: 'ok', message: null },
					],
					errors_summary: errorsSummary([
						{ status: 'error', message: MSG },
						{ status: 'error', message: MSG },
					]),
				},
				history.filter((item) => item.run_id !== 'crm-job:10-02')
			);

			expect(detail.records.map((record) => record.recurrence)).toEqual([
				{ first_seen_at: day('09-26'), runs_count: 6, consecutive: true },
				null,
				null,
			]);
			expect(detail.errors_summary).toEqual([
				{ message: MSG, count: 2, recurrence: { first_seen_at: day('09-26'), runs_count: 6, consecutive: true, recurring_records: 1 } },
			]);
		});

		it('lista: nuevo vs. repetido contra la vez anterior que se procesó el registro (caso Gavilán: el 29-09 no lo tocó)', () => {
			const withErrors = (id: string, d: string, errors: number) => ({
				...run(id, errors ? 'partial' : 'completed', day(d)),
				totals: { total: 30, ok: 0, unchanged: 30 - errors, errors, skipped: 30 - errors },
			});
			const runs = [
				withErrors('crm-job:09-28', '09-28', 1),
				withErrors('crm-job:09-29', '09-29', 0),
				withErrors('crm-job:09-30', '09-30', 2),
				{ ...withErrors('crm-run:r', '10-01', 0), kind: 'crm_retry' },
				withErrors('crm-job:10-02', '10-02', 2),
			];
			const history = [
				daily('09-28'),
				daily('09-30'),
				{ ...daily('09-30'), record_key: '006N' },
				// Un reintento que procesó bien la otra oportunidad corta su cadena.
				{ ...daily('10-01', 'ok', null), run_id: 'crm-run:r', kind: 'crm_retry', record_key: '006N' },
				daily('10-02'),
				{ ...daily('10-02'), record_key: '006N' },
			];
			const deltas = runErrorDeltas(runs, history);

			expect(deltas.get('crm-job:09-28')).toEqual({ errors_new: 1, errors_recurring: 0, errors_recurring_since: null });
			expect(deltas.get('crm-job:09-29')).toEqual({ errors_new: 0, errors_recurring: 0, errors_recurring_since: null });
			expect(deltas.get('crm-job:09-30')).toEqual({ errors_new: 1, errors_recurring: 1, errors_recurring_since: day('09-28') });
			expect(deltas.get('crm-job:10-02')).toEqual({ errors_new: 1, errors_recurring: 1, errors_recurring_since: day('09-28') });
			// totals.errors manda: errores sin detalle por registro cuentan como nuevos.
			expect(runErrorDeltas([withErrors('crm-job:x', '10-03', 3)], []).get('crm-job:x')).toEqual({
				errors_new: 3,
				errors_recurring: 0,
				errors_recurring_since: null,
			});
		});
	});

	it('corrida interrumpida: en curso pero vencida o de este entorno iniciada antes del arranque del proceso', () => {
		const processStartedAt = new Date('2026-10-03T23:21:00Z');
		const now = Date.parse('2026-10-03T23:30:00Z');
		const options = { leaseMs: 3 * 3_600_000, environment: 'development', processStartedAt, now };

		// Caso real: job de desarrollo iniciado 23:19, la API local se reinició 23:21.
		expect(isInterruptedJob({ startedAt: '2026-10-03T23:19:00Z', environment: 'development' }, options)).toBe(true);
		expect(isInterruptedJob({ startedAt: '2026-10-03T23:22:00Z', environment: 'development' }, options)).toBe(false);
		// Otro entorno (producción vista desde local): solo el lease.
		expect(isInterruptedJob({ startedAt: '2026-10-03T23:19:00Z', environment: 'production' }, options)).toBe(false);
		expect(isInterruptedJob({ startedAt: '2026-10-03T19:00:00Z', environment: 'production' }, options)).toBe(true);
		expect(isInterruptedJob({ startedAt: null }, options)).toBe(true);
		expect(runStatusOf({ running: true, interrupted: true, ok: 0, errors: 0 })).toBe('interrupted');
		expect(runStatusOf({ running: true, ok: 0, errors: 0 })).toBe('running');
	});
});

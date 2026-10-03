import {
	holdingTimezone,
	isValidTimezone,
	loadHoldingPreferences,
	nextQuoteNumber,
	normalizeReminderDays,
	preferencesFromRow,
	quoteNumberFormat,
} from './holding-preferences';

const db = (settings: unknown, next = 1) => {
	const query = jest.fn(async (sql: string) => {
		if (sql.includes('to_jsonb(hs)')) return settings === undefined ? [] : [{ settings }];
		if (sql.includes('regexp_match')) return [{ next }];

		return [];
	});

	return { query };
};

describe('holding-preferences (Configuración ronda 4)', () => {
	it('sin fila o sin M14 aplicada: defaults = comportamiento anterior', async () => {
		await expect(loadHoldingPreferences(db(undefined), 'h-1')).resolves.toEqual({
			timezone: 'America/Santiago',
			auto_renewal_notice_days: 30,
			renewal_reminder_days: [15, 7, 0],
			renewal_overdue_every_days: 7,
			quote_numbering: { mode: 'prefixed', prefix: 'COT', include_year: true, width: 4 },
		});
		// Fila vieja (sin las columnas nuevas): solo trae lo que existía.
		await expect(loadHoldingPreferences(db({ auto_renewal_notice_days: 45 }), 'h-1')).resolves.toMatchObject({
			auto_renewal_notice_days: 45,
			timezone: 'America/Santiago',
		});
		await expect(holdingTimezone(db({ timezone: 'America/Lima' }), 'h-1')).resolves.toBe('America/Lima');
		await expect(holdingTimezone(db({ timezone: 'America/Lima' }), null)).resolves.toBe('America/Santiago');
	});

	it('valores guardados inválidos caen al default; la escalera se ordena de mayor a menor sin repetidos', () => {
		expect(preferencesFromRow({ timezone: 'Mars/Base', quote_number_prefix: 'C-T', quote_number_width: 0 })).toMatchObject({
			timezone: 'America/Santiago',
			quote_numbering: { prefix: 'COT', width: 4 },
		});
		// El horizonte de ítems sin término no es preferencia (fijo en 12 por sistema, Domi 03-10).
		expect(preferencesFromRow({ indefinite_horizon_periods: 6 })).not.toHaveProperty('indefinite_horizon_periods');
		expect(normalizeReminderDays([0, 30, 30, 7])).toEqual([30, 7, 0]);
		expect(normalizeReminderDays('{90,0,15}')).toEqual([90, 15, 0]);
		expect(normalizeReminderDays([200])).toEqual([15, 7, 0]);
		expect(isValidTimezone('America/Mexico_City')).toBe(true);
		expect(isValidTimezone('UTC')).toBe(true);
		expect(isValidTimezone('America/Gotham')).toBe(false);
	});

	it('formato del correlativo: COT-{año}-{NNNN} (default), sin año, solo correlativo; manual sin formato', () => {
		const prefixed = quoteNumberFormat({ mode: 'prefixed', prefix: 'COT', include_year: true, width: 4 }, 2026)!;

		expect(prefixed.format(7)).toBe('COT-2026-0007');
		expect(prefixed.lockKey).toBe('COT:2026');
		expect(new RegExp(prefixed.pattern).exec('COT-2026-0012')?.[1]).toBe('0012');
		expect(new RegExp(prefixed.pattern).test('COT-2025-0012')).toBe(false);
		const noYear = quoteNumberFormat({ mode: 'prefixed', prefix: 'PROP', include_year: false, width: 5 }, 2026)!;

		expect(noYear.format(42)).toBe('PROP-00042');
		const sequential = quoteNumberFormat({ mode: 'sequential', prefix: 'COT', include_year: true, width: 3 }, 2026)!;

		expect(sequential.format(7)).toBe('007');
		expect(sequential.format(12345)).toBe('12345');
		expect(new RegExp(sequential.pattern).test('COT-2026-0001')).toBe(false);
		expect(quoteNumberFormat({ mode: 'manual', prefix: 'COT', include_year: true, width: 4 }, 2026)).toBeNull();
	});

	it('próximo número: mayor del formato + 1, con lock opcional; null en manual', async () => {
		const conn = db(undefined, 13);

		await expect(nextQuoteNumber(conn, 'h-1', { mode: 'prefixed', prefix: 'COT', include_year: true, width: 4 }, 2026, true)).resolves.toBe(
			'COT-2026-0013'
		);
		expect(conn.query.mock.calls[0]).toEqual(['SELECT pg_advisory_xact_lock(hashtext($1))', ['quotes:h-1:COT:2026']]);
		await expect(nextQuoteNumber(conn, 'h-1', { mode: 'manual', prefix: 'COT', include_year: true, width: 4 }, 2026)).resolves.toBeNull();
	});
});

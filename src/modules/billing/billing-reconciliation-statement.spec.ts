import {
	assignFingerprints,
	excelSerialToDate,
	fingerprintOf,
	parseAmount,
	parseCurrency,
	parseDate,
	parseStatement,
	type StatementMapping,
	validateMapping,
} from './billing-reconciliation-statement';

const ACCOUNT = { id: 'acc-1', currency: 'CLP' };

/** CSV simple → encabezados + filas (como las manda el navegador). */
const csv = (source: string, separator = ';') => {
	const [head, ...lines] = source.trim().split('\n');

	return { headers: head.split(separator), rows: lines.map((line) => line.split(separator)) };
};

const mapping = (overrides: Partial<StatementMapping> = {}): StatementMapping => ({
	date_column: 'Fecha',
	description_column: 'Glosa',
	amount_column: 'Monto',
	date_format: 'auto',
	decimal_separator: ',',
	thousands_separator: '.',
	amount_sign_convention: 'credit_positive',
	...overrides,
});

describe('Cartola: celdas', () => {
	it('fechas: formatos explícitos, auto (año primero, día primero, mes imposible), años de 2 dígitos, hora y seriales de Excel', () => {
		expect(parseDate('2026-09-30')).toBe('2026-09-30');
		expect(parseDate('30/09/2026')).toBe('2026-09-30');
		expect(parseDate('05/09/2026')).toBe('2026-09-05');
		expect(parseDate('09/30/2026')).toBe('2026-09-30');
		expect(parseDate('09/05/2026', 'MM/DD/YYYY')).toBe('2026-09-05');
		expect(parseDate('05-09-26', 'DD-MM-YYYY')).toBe('2026-09-05');
		expect(parseDate('01.10.99')).toBe('1999-10-01');
		expect(parseDate('30/09/2026 14:22')).toBe('2026-09-30');
		expect(parseDate('2026-09-30T10:00:00Z')).toBe('2026-09-30');
		expect(parseDate(46295)).toBe(excelSerialToDate(46295));
		expect(excelSerialToDate(45931)).toBe('2025-10-01');
		expect(parseDate('45931')).toBe('2025-10-01');
		expect(parseDate('31/02/2026')).toBeNull();
		expect(parseDate('ayer')).toBeNull();
		expect(parseDate('')).toBeNull();
	});

	it('montos: separadores, símbolos, signo adelante o atrás, paréntesis y vacío', () => {
		expect(parseAmount('1.234.567', ',', '.')).toBe(1234567);
		expect(parseAmount('1.234,56', ',', '.')).toBe(1234.56);
		expect(parseAmount('1,234.56', '.', ',')).toBe(1234.56);
		expect(parseAmount('1 234,56', ',', ' ')).toBe(1234.56);
		expect(parseAmount('1234.56', '.', 'none')).toBe(1234.56);
		expect(parseAmount('$ 1.000', ',', '.')).toBe(1000);
		expect(parseAmount('-$1.000', ',', '.')).toBe(-1000);
		expect(parseAmount('1.000-', ',', '.')).toBe(-1000);
		expect(parseAmount('(1.500)', ',', '.')).toBe(-1500);
		expect(parseAmount('USD (25.50)', '.', ',')).toBe(-25.5);
		expect(parseAmount(1500)).toBe(1500);
		expect(parseAmount('')).toBeNull();
		expect(parseAmount('n/a')).toBeNull();
	});

	it('moneda: ISO en mayúsculas, US$ → USD, ilegible → null', () => {
		expect(parseCurrency('clp')).toBe('CLP');
		expect(parseCurrency('US$')).toBe('USD');
		expect(parseCurrency('$')).toBeNull();
	});
});

describe('Cartola: mapeo y líneas', () => {
	it('valida columnas inexistentes y monto sin columna', () => {
		expect(validateMapping(['Fecha', 'Glosa'], mapping()).map((blocker) => blocker.code)).toEqual(['mapping_column_missing']);
		expect(validateMapping(['Fecha', 'Glosa'], mapping({ amount_column: null })).map((blocker) => blocker.code)).toEqual([
			'mapping_amount_missing',
		]);
	});

	it('columna de monto con signo (abono > 0, cargo < 0); convención credit_negative invierte', () => {
		const { headers, rows } = csv(`Fecha;Glosa;Monto
30/09/2026;TRANSF DE ACME SPA;1.500.000
30/09/2026;COMISION MANTENCION;-12.500`);
		const lines = parseStatement(headers, rows, mapping(), ACCOUNT);

		expect(lines.map((line) => line.amount)).toEqual([1500000, -12500]);
		expect(parseStatement(headers, rows, mapping({ amount_sign_convention: 'credit_negative' }), ACCOUNT).map((line) => line.amount)).toEqual([
			-1500000, 12500,
		]);
	});

	it('columnas de cargo y abono, referencia, saldo, filas vacías y skip_rows', () => {
		const { headers, rows } = csv(`Fecha;Descripción;Cargos;Abonos;Documento;Saldo
SALDO INICIAL;;;;;
01/10/2026;Transferencia de Globex Ltda;;250.000;F-1234;1.250.000
02/10/2026;Pago proveedor;80.000;;;1.170.000
;;;;;`);
		const lines = parseStatement(
			headers,
			rows,
			mapping({
				description_column: 'Descripción',
				amount_column: null,
				debit_column: 'Cargos',
				credit_column: 'Abonos',
				reference_column: 'Documento',
				balance_column: 'Saldo',
				skip_rows: 1,
			}),
			ACCOUNT
		);

		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatchObject({
			row: 2,
			date: '2026-10-01',
			amount: 250000,
			reference: 'F-1234',
			balance: 1250000,
			currency: 'CLP',
			counterparty_name: 'GLOBEX',
			errors: [],
		});
		expect(lines[0].raw).toMatchObject({ Fecha: '01/10/2026', Abonos: '250.000' });
		expect(lines[1].amount).toBe(-80000);
		expect(lines.every((line) => /^[0-9a-f]{64}$/.test(line.fingerprint ?? ''))).toBe(true);
	});

	it('RUT del pagador: columna o glosa con DV válido (mod 11), normalizado; DV inválido no se toma', () => {
		const { headers, rows } = csv(`Fecha;Glosa;Monto;Rut
01/10/2026;TRANSF 76.086.428-5 ACME SPA;100;
01/10/2026;TRANSF 76.086.428-4 ACME SPA;100;
01/10/2026;ABONO;100;12.345.678-5
01/10/2026;TEF RUT 761234560 DATOS;100;`);
		const lines = parseStatement(headers, rows, mapping({ tax_id_column: 'Rut' }), ACCOUNT);

		expect(lines.map((line) => line.counterparty_tax_id)).toEqual(['760864285', null, '123456785', '761234560']);
		expect(lines[0].counterparty_name).toBe('ACME');
	});

	it('moneda: columna, por defecto o de la cuenta; distinta de la cuenta → account_currency_mismatch; fecha/monto ilegibles → error sin huella', () => {
		const { headers, rows } = csv(`Fecha;Glosa;Monto;Moneda
01/10/2026;A;100;USD
01/10/2026;B;100;
xx;C;100;CLP
01/10/2026;D;;CLP
01/10/2026;E;100;$$`);
		const lines = parseStatement(headers, rows, mapping({ currency_column: 'Moneda' }), ACCOUNT);

		expect(lines.map((line) => line.errors.map((error) => error.code))).toEqual([
			['account_currency_mismatch'],
			[],
			['date_unreadable'],
			['amount_unreadable'],
			['currency_unreadable'],
		]);
		expect(lines[1].currency).toBe('CLP');
		expect(lines.filter((line) => line.fingerprint).map((line) => line.description)).toEqual(['B']);
		expect(
			parseStatement(
				headers.slice(0, 3),
				rows.map((row) => row.slice(0, 3)),
				mapping({ default_currency: 'usd' }),
				{ id: 'x', currency: null }
			)[0].currency
		).toBe('USD');
	});
});

describe('Cartola: huella por línea', () => {
	const line = { date: '2026-10-01', amount: 1000, description: 'Transf. de ACME', reference: null, balance: null };

	it('dos líneas idénticas del mismo archivo quedan distintas (#0, #1); un archivo solapado repite las mismas huellas', () => {
		const base = { row: 1, currency: 'CLP', counterparty_name: null, counterparty_tax_id: null, raw: {}, fingerprint: null, errors: [] };
		const first = assignFingerprints('acc-1', [
			{ ...base, ...line },
			{ ...base, ...line, row: 2 },
		]);
		const overlap = assignFingerprints('acc-1', [
			{ ...base, ...line },
			{ ...base, ...line, row: 2 },
			{ ...base, ...line, row: 3, amount: 2000 },
		]);

		expect(first[0].fingerprint).not.toBe(first[1].fingerprint);
		expect(overlap.slice(0, 2).map((entry) => entry.fingerprint)).toEqual(first.map((entry) => entry.fingerprint));
		expect(new Set(overlap.map((entry) => entry.fingerprint)).size).toBe(3);
	});

	it('la glosa se normaliza (acentos, puntuación, mayúsculas) y cambia con cuenta, monto, referencia o saldo', () => {
		const a = fingerprintOf('acc-1', line, 0);

		expect(fingerprintOf('acc-1', { ...line, description: 'TRANSF DE ÁCME' }, 0)).toBe(a);
		expect(fingerprintOf('acc-2', line, 0)).not.toBe(a);
		expect(fingerprintOf('acc-1', { ...line, amount: 1000.01 }, 0)).not.toBe(a);
		expect(fingerprintOf('acc-1', { ...line, reference: 'F-1' }, 0)).not.toBe(a);
		expect(fingerprintOf('acc-1', { ...line, balance: 5000 }, 0)).not.toBe(a);
		expect(fingerprintOf('acc-1', line, 1)).not.toBe(a);
	});
});

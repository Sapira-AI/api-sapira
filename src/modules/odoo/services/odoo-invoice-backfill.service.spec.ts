import { OdooInvoiceBackfillService } from './odoo-invoice-backfill.service';

/**
 * Pruebas del backfill. Esto escribe sobre facturas ya emitidas en cierre de mes, así que lo que más
 * se prueba son las guardas: que en seco no escriba nada, y que no toque una factura cuyo amarre
 * (`x_sapira_invoice_id`) falte o apunte a otra.
 */
const HOLDING = '11111111-1111-4111-8111-111111111111';
const FACTURA = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6';

/** Candidata tal como la devuelve PostgreSQL: los `numeric` llegan como string. */
const candidata = (extra: Record<string, unknown> = {}) => ({
	id: FACTURA,
	odoo_invoice_id: 199014,
	invoice_number: null,
	status: 'Emitida',
	vat: '190000.00',
	total_invoice_currency: '1190000.00',
	amount_invoice_currency: '1000000.00',
	issue_date: '2026-09-22',
	sent_to_odoo_at: new Date('2026-09-22T11:00:00.000Z'),
	...extra,
});

/** Lo que Odoo devuelve en `read`: los campos vacíos vienen como `false`. */
const enOdoo = (extra: Record<string, unknown> = {}) => ({
	id: 199014,
	name: 'F101-00004388',
	state: 'posted',
	payment_state: 'not_paid',
	amount_tax: 190000,
	amount_total: 1190000,
	amount_untaxed: 1000000,
	invoice_date: '2026-09-22',
	x_sapira_invoice_id: FACTURA,
	...extra,
});

function crearServicio(opciones: { candidatas?: any[]; odoo?: any[] } = {}) {
	const logsGuardados: any[] = [];
	const update = jest.fn().mockResolvedValue({ affected: 1 });

	function ModeloLog(this: any, datos: any) {
		logsGuardados.push(datos);
		this.save = jest.fn().mockResolvedValue(datos);
	}

	const consultas: { sql: string; params: any[] }[] = [];
	const dataSource = {
		query: jest.fn(async (sql: string, params: any[] = []) => {
			consultas.push({ sql, params });
			return opciones.candidatas ?? [];
		}),
		getRepository: jest.fn(() => ({ update })),
	};

	const odooInvoicesService = { readInvoicesForSync: jest.fn().mockResolvedValue(opciones.odoo ?? []) };

	const service = new OdooInvoiceBackfillService({ model: jest.fn(() => ModeloLog as any) } as any, dataSource as any, odooInvoicesService as any);

	return { service, update, logsGuardados, consultas, odooInvoicesService };
}

describe('OdooInvoiceBackfillService.backfillFolios', () => {
	it('sin candidatas no le pregunta nada a Odoo', async () => {
		const { service, odooInvoicesService, update } = crearServicio({ candidatas: [] });

		const resultado = await service.backfillFolios(HOLDING, { aplicar: true });

		expect(resultado.candidatas).toBe(0);
		expect(odooInvoicesService.readInvoicesForSync).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});

	it('en seco reporta lo que escribiría y no escribe nada', async () => {
		const { service, update, logsGuardados } = crearServicio({ candidatas: [candidata()], odoo: [enOdoo()] });

		const resultado = await service.backfillFolios(HOLDING, {});

		expect(resultado.aplicado).toBe(false);
		expect(resultado.actualizadas).toBe(0);
		expect(resultado.con_cambios).toBe(1);
		expect(resultado.facturas[0]).toEqual({
			id: FACTURA,
			odoo_invoice_id: 199014,
			aplicado: false,
			// Los montos y la fecha ya coincidían: lo único que cambia es el folio y el estado.
			cambios: [
				{ campo: 'invoice_number', antes: undefined, despues: 'F101-00004388' },
				{ campo: 'status', antes: 'Emitida', despues: 'Enviada' },
			],
		});
		expect(update).not.toHaveBeenCalled();
		expect(logsGuardados).toHaveLength(0);
	});

	it('con aplicar escribe solo folio y estado, y deja el rastro en Mongo', async () => {
		const { service, update, logsGuardados } = crearServicio({
			candidatas: [candidata({ vat: '0.00', total_invoice_currency: null, issue_date: '2026-09-01' })],
			odoo: [enOdoo()],
		});

		const resultado = await service.backfillFolios(HOLDING, { aplicar: true });

		expect(resultado.actualizadas).toBe(1);
		expect(resultado.campos).toEqual(['folio', 'estado']);
		// Los montos y la fecha NO se tocan aunque difieran: ese alcance obliga a reconstruir RSM.
		expect(update).toHaveBeenCalledWith(FACTURA, { invoice_number: 'F101-00004388', status: 'Enviada' });
		expect(logsGuardados[0]).toMatchObject({
			sapira_invoice_id: FACTURA,
			odoo_invoice_id: 199014,
			holding_id: HOLDING,
			was_updated: true,
			skip_reason: 'backfill',
		});
		expect(logsGuardados[0].fields_changed).toEqual(['invoice_number', 'status']);
	});

	it('el default es folio y estado: ni montos ni fecha, aunque difieran', async () => {
		const { service, update } = crearServicio({
			candidatas: [candidata({ vat: '7283.99', total_invoice_currency: '3963651.04', issue_date: '2025-09-16' })],
			odoo: [enOdoo({ amount_tax: 751710, amount_total: 4708078, invoice_date: '2026-09-17' })],
		});

		const resultado = await service.backfillFolios(HOLDING, { aplicar: true });

		expect(update).toHaveBeenCalledWith(FACTURA, { invoice_number: 'F101-00004388', status: 'Enviada' });
		expect(resultado.facturas[0].cambios.map((cambio) => cambio.campo)).toEqual(['invoice_number', 'status']);
	});

	it('con campos explícitos escribe montos y fecha', async () => {
		const { service, update } = crearServicio({
			candidatas: [candidata({ vat: '0.00', total_invoice_currency: null, issue_date: '2026-09-01' })],
			odoo: [enOdoo()],
		});

		const resultado = await service.backfillFolios(HOLDING, { aplicar: true, campos: ['montos', 'fecha'] });

		expect(resultado.campos).toEqual(['montos', 'fecha']);
		// Sin `folio` ni `estado` en `campos`, esos dos no se tocan.
		expect(update).toHaveBeenCalledWith(FACTURA, {
			vat: 190000,
			total_invoice_currency: 1190000,
			amount_invoice_currency: 1000000,
			issue_date: '2026-09-22',
		});
	});

	it('con campos solo folio no toca el estado', async () => {
		const { service, update } = crearServicio({ candidatas: [candidata()], odoo: [enOdoo()] });

		await service.backfillFolios(HOLDING, { aplicar: true, campos: ['folio'] });

		expect(update).toHaveBeenCalledWith(FACTURA, { invoice_number: 'F101-00004388' });
	});

	it('acota por estado para separar las Emitida de las Por Emitir', async () => {
		const { service, consultas } = crearServicio({ candidatas: [] });

		await service.backfillFolios(HOLDING, { estados: ['Emitida'] });

		expect(consultas[0].params[3]).toEqual(['Emitida']);
	});

	it('`in_payment` queda en Enviada, no en Pagada', async () => {
		const { service, update } = crearServicio({ candidatas: [candidata()], odoo: [enOdoo({ payment_state: 'in_payment' })] });

		await service.backfillFolios(HOLDING, { aplicar: true });

		expect(update).toHaveBeenCalledWith(FACTURA, expect.objectContaining({ status: 'Enviada' }));
	});

	it('`paid` sí pasa a Pagada', async () => {
		const { service, update } = crearServicio({ candidatas: [candidata()], odoo: [enOdoo({ payment_state: 'paid' })] });

		await service.backfillFolios(HOLDING, { aplicar: true });

		expect(update).toHaveBeenCalledWith(FACTURA, expect.objectContaining({ status: 'Pagada' }));
	});

	describe('guardas', () => {
		it('omite la factura cuyo x_sapira_invoice_id en Odoo apunta a otra', async () => {
			const { service, update } = crearServicio({
				candidatas: [candidata()],
				odoo: [enOdoo({ x_sapira_invoice_id: '99999999-9999-4999-8999-999999999999' })],
			});

			const resultado = await service.backfillFolios(HOLDING, { aplicar: true });

			expect(resultado.omitidas).toEqual([{ id: FACTURA, odoo_invoice_id: 199014, motivo: 'x_sapira_invoice_id_no_coincide' }]);
			expect(update).not.toHaveBeenCalled();
		});

		it('omite la factura sin x_sapira_invoice_id en Odoo', async () => {
			const { service, update } = crearServicio({ candidatas: [candidata()], odoo: [enOdoo({ x_sapira_invoice_id: false })] });

			const resultado = await service.backfillFolios(HOLDING, { aplicar: true });

			expect(resultado.omitidas[0].motivo).toBe('sin_x_sapira_invoice_id_en_odoo');
			expect(update).not.toHaveBeenCalled();
		});

		it('omite la que sigue en borrador en Odoo', async () => {
			const { service, update } = crearServicio({ candidatas: [candidata()], odoo: [enOdoo({ state: 'draft' })] });

			const resultado = await service.backfillFolios(HOLDING, { aplicar: true });

			expect(resultado.omitidas[0].motivo).toBe('no_publicada_en_odoo');
			expect(update).not.toHaveBeenCalled();
		});

		it('omite la publicada a la que Odoo no le asignó folio', async () => {
			const { service, update } = crearServicio({ candidatas: [candidata()], odoo: [enOdoo({ name: false })] });

			const resultado = await service.backfillFolios(HOLDING, { aplicar: true });

			expect(resultado.omitidas[0].motivo).toBe('sin_folio_en_odoo');
			expect(update).not.toHaveBeenCalled();
		});

		it('omite el id que Odoo no devolvió', async () => {
			const { service } = crearServicio({ candidatas: [candidata(), candidata({ id: 'otra', odoo_invoice_id: 199077 })], odoo: [enOdoo()] });

			const resultado = await service.backfillFolios(HOLDING, { aplicar: true });

			expect(resultado.leidas_de_odoo).toBe(1);
			expect(resultado.omitidas).toEqual([{ id: 'otra', odoo_invoice_id: 199077, motivo: 'no_existe_en_odoo' }]);
		});
	});

	it('no cuenta como cambio un numeric que PostgreSQL devuelve como string con decimales', async () => {
		const { service, update } = crearServicio({
			candidatas: [candidata({ invoice_number: 'F101-00004388', status: 'Enviada', vat: '190000.0000' })],
			odoo: [enOdoo()],
		});
		// Con `campos: ['montos']` el `vat` es lo único comparable, y '190000.0000' === 190000.

		const resultado = await service.backfillFolios(HOLDING, { aplicar: true, campos: ['folio', 'estado', 'montos'] });

		expect(resultado.sin_cambios).toBe(1);
		expect(resultado.con_cambios).toBe(0);
		expect(update).not.toHaveBeenCalled();
	});

	it('no cuenta como cambio una issue_date que llega como Date con hora', async () => {
		const { service, update } = crearServicio({
			candidatas: [candidata({ invoice_number: 'F101-00004388', status: 'Enviada', issue_date: new Date('2026-09-22T00:00:00.000Z') })],
			odoo: [enOdoo()],
		});

		await service.backfillFolios(HOLDING, { aplicar: true, campos: ['folio', 'estado', 'fecha'] });

		expect(update).not.toHaveBeenCalled();
	});

	it('acota por holding, ventana y lista de ids de Odoo', async () => {
		const { service, consultas } = crearServicio({ candidatas: [] });

		await service.backfillFolios(HOLDING, { dias: 30, odooInvoiceIds: [199014, 199077] });

		expect(consultas[0].params[0]).toBe(HOLDING);
		expect(consultas[0].params[1]).toBeInstanceOf(Date);
		expect(consultas[0].params[2]).toEqual([199014, 199077]);
		expect(consultas[0].params[3]).toBeNull();
		expect(consultas[0].params[4]).toBe(1000);
	});

	it('sin ventana ni ids barre toda la historia del holding', async () => {
		const { service, consultas } = crearServicio({ candidatas: [] });

		await service.backfillFolios(HOLDING, {});

		expect(consultas[0].params[1]).toBeNull();
		expect(consultas[0].params[2]).toBeNull();
	});

	it('avisa cuando se alcanzó el tope por corrida', async () => {
		const candidatas = Array.from({ length: 1000 }, (_, indice) => candidata({ id: `factura-${indice}`, odoo_invoice_id: 200000 + indice }));
		const { service } = crearServicio({ candidatas, odoo: [] });

		const resultado = await service.backfillFolios(HOLDING, {});

		expect(resultado.tope_alcanzado).toBe(true);
		expect(resultado.omitidas).toHaveLength(1000);
	});
});

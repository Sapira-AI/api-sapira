import { OdooWebhookService } from './odoo-webhook.service';

/**
 * Pruebas del reporte de la pierna de vuelta (`getReturnLegDiagnostics`). Lo que importa es el
 * `veredicto`: es el que decide si se revisa Odoo o la API, así que cada rama del árbol tiene su
 * caso, y el que motivó el reporte —avisos cortados el 15-09 con facturas sin folio desde el 16— es
 * uno de ellos.
 */
const HOLDING = '11111111-1111-4111-8111-111111111111';

/** Modela el encadenado de mongoose (`countDocuments().exec()`, `findOne().sort().lean().exec()`). */
const encadenado = (valor: unknown) => ({
	exec: jest.fn().mockResolvedValue(valor),
	sort: jest.fn().mockReturnThis(),
	lean: jest.fn().mockReturnThis(),
});

function crearServicio(opciones: {
	avisos?: { total?: number; enVentana?: number; ultimo?: any; porDia?: any[] };
	updates?: { total?: number; enVentana?: number; ultima?: any; porDia?: any[] };
	filasHueco?: any[];
	filasIds?: any[];
	ultimaConAviso?: any;
	primeraSinAviso?: any;
}) {
	const avisos = opciones.avisos ?? {};
	const updates = opciones.updates ?? {};

	const webhookLogModel = {
		countDocuments: jest.fn((filtro: any) => encadenado(filtro?.createdAt ? (avisos.enVentana ?? 0) : (avisos.total ?? 0))),
		findOne: jest.fn(() => encadenado(avisos.ultimo ?? null)),
		aggregate: jest.fn(() => encadenado(avisos.porDia ?? [])),
	};

	const invoiceUpdateLogModel = {
		countDocuments: jest.fn((filtro: any) => encadenado(filtro?.createdAt ? (updates.enVentana ?? 0) : (updates.total ?? 0))),
		findOne: jest.fn(() => encadenado(updates.ultima ?? null)),
		aggregate: jest.fn(() => encadenado(updates.porDia ?? [])),
	};

	const connection = {
		model: jest.fn((nombre: string) => (nombre === 'OdooWebhookLog' ? webhookLogModel : invoiceUpdateLogModel)),
	};

	const consultas: { sql: string; params: any[] }[] = [];
	const dataSource = {
		query: jest.fn(async (sql: string, params: any[] = []) => {
			consultas.push({ sql, params });

			if (sql.includes('GROUP BY')) return opciones.filasHueco ?? [];
			if (sql.includes('LIMIT $3')) return opciones.filasIds ?? [];
			if (sql.includes("i.status IN ('Enviada', 'Pagada')")) return opciones.ultimaConAviso ? [opciones.ultimaConAviso] : [];
			return opciones.primeraSinAviso ? [opciones.primeraSinAviso] : [];
		}),
	};

	const service = new OdooWebhookService(connection as any, dataSource as any);

	return { service, webhookLogModel, invoiceUpdateLogModel, dataSource, consultas };
}

describe('OdooWebhookService.getReturnLegDiagnostics', () => {
	it('sin facturas sin folio el veredicto es ok, aunque no haya avisos en la ventana', async () => {
		const { service } = crearServicio({ avisos: { total: 10, enVentana: 0 }, filasHueco: [] });

		const reporte = await service.getReturnLegDiagnostics({ holdingId: HOLDING });

		expect(reporte.veredicto).toBe('ok');
		expect(reporte.facturas_sin_folio.total).toBe(0);
	});

	it('con facturas sin folio y ningún aviso en la ventana el veredicto es sin_avisos', async () => {
		const { service } = crearServicio({
			avisos: { total: 4312, enVentana: 0, ultimo: { createdAt: '2026-09-15T14:37:02.000Z', event_type: 'write', model: 'account.move' } },
			filasHueco: [{ dia: '2026-09-16', pais: 'Chile', status: 'Emitida', cantidad: 96 }],
		});

		const reporte = await service.getReturnLegDiagnostics({ holdingId: HOLDING });

		expect(reporte.veredicto).toBe('sin_avisos');
		expect(reporte.avisos_recibidos.total_historico).toBe(4312);
		expect(reporte.avisos_recibidos.ultimo_en).toEqual(new Date('2026-09-15T14:37:02.000Z'));
	});

	it('con avisos que llegan pero ninguna actualización aplicada el veredicto es avisos_sin_efecto', async () => {
		const { service } = crearServicio({
			avisos: { total: 20, enVentana: 20 },
			updates: { total: 100, enVentana: 0 },
			filasHueco: [{ dia: '2026-09-16', pais: 'Perú', status: 'Emitida', cantidad: 9 }],
		});

		const reporte = await service.getReturnLegDiagnostics({ holdingId: HOLDING });

		expect(reporte.veredicto).toBe('avisos_sin_efecto');
	});

	it('con avisos y actualizaciones pero igual con hueco el veredicto es hueco_parcial', async () => {
		const { service } = crearServicio({
			avisos: { total: 20, enVentana: 20 },
			updates: { total: 100, enVentana: 18 },
			filasHueco: [{ dia: '2026-09-16', pais: 'Chile', status: 'Emitida', cantidad: 2 }],
		});

		const reporte = await service.getReturnLegDiagnostics({ holdingId: HOLDING });

		expect(reporte.veredicto).toBe('hueco_parcial');
	});

	it('suma el hueco por día y país, y devuelve los ids de Odoo para el backfill', async () => {
		const { service } = crearServicio({
			filasHueco: [
				{ dia: '2026-09-16', pais: 'Chile', status: 'Emitida', cantidad: 96 },
				{ dia: '2026-09-16', pais: 'México', status: 'Emitida', cantidad: 40 },
				{ dia: '2026-09-22', pais: 'Perú', status: 'Vencida', cantidad: 9 },
			],
			filasIds: [{ odoo_invoice_id: '198706' }, { odoo_invoice_id: 198707 }],
		});

		const reporte = await service.getReturnLegDiagnostics({ holdingId: HOLDING });

		expect(reporte.facturas_sin_folio.total).toBe(145);
		expect(reporte.facturas_sin_folio.odoo_invoice_ids).toEqual([198706, 198707]);
		expect(reporte.facturas_sin_folio.lista_truncada).toBe(false);
		expect(reporte.facturas_sin_folio.por_dia_y_pais[2]).toEqual({ dia: '2026-09-22', pais: 'Perú', status: 'Vencida', cantidad: 9 });
	});

	it('marca la lista truncada cuando hay más ids que el límite', async () => {
		const filasIds = Array.from({ length: 501 }, (_, indice) => ({ odoo_invoice_id: 100000 + indice }));
		const { service } = crearServicio({ filasHueco: [{ dia: '2026-09-16', pais: 'Chile', status: 'Emitida', cantidad: 501 }], filasIds });

		const reporte = await service.getReturnLegDiagnostics({ holdingId: HOLDING });

		expect(reporte.facturas_sin_folio.odoo_invoice_ids).toHaveLength(500);
		expect(reporte.facturas_sin_folio.lista_truncada).toBe(true);
	});

	it('publica las claves del último payload pero nunca sus valores', async () => {
		const { service } = crearServicio({
			avisos: {
				total: 1,
				enVentana: 1,
				ultimo: {
					createdAt: '2026-09-15T14:37:02.000Z',
					event_type: 'write',
					model: 'account.move',
					odoo_id: 198707,
					payload: { id: 198707, name: 'F101-00004388', state: 'posted', x_sapira_invoice_id: 'abc', partner_vat: '76.123.456-7' },
				},
			},
		});

		const reporte = await service.getReturnLegDiagnostics({ holdingId: HOLDING });

		expect(reporte.avisos_recibidos.ultimo_aviso).toEqual({
			recibido_en: new Date('2026-09-15T14:37:02.000Z'),
			event_type: 'write',
			model: 'account.move',
			odoo_id: 198707,
			trae_x_sapira_invoice_id: true,
			claves_payload: ['id', 'name', 'partner_vat', 'state', 'x_sapira_invoice_id'],
		});
		expect(JSON.stringify(reporte)).not.toContain('76.123.456-7');
	});

	it('detecta el payload que el webhook no sabe leer: sin x_sapira_invoice_id en la raíz', async () => {
		const { service } = crearServicio({
			avisos: {
				total: 1,
				enVentana: 1,
				// La forma que documenta el ejemplo de Swagger: el registro va dentro de `values`, no en
				// la raíz, así que `extractInvoiceFields` lee undefined y el webhook sale en silencio.
				ultimo: {
					createdAt: '2026-09-20T11:00:00.000Z',
					event_type: 'write',
					model: 'account.move',
					payload: { model: 'account.move', record_id: 199014, values: { name: 'F101-00004388', state: 'posted' } },
				},
			},
			updates: { total: 100, enVentana: 0 },
			filasHueco: [{ dia: '2026-09-20', pais: 'Perú', status: 'Emitida', cantidad: 1 }],
		});

		const reporte = await service.getReturnLegDiagnostics({ holdingId: HOLDING });

		expect(reporte.avisos_recibidos.ultimo_aviso?.trae_x_sapira_invoice_id).toBe(false);
		expect(reporte.avisos_recibidos.ultimo_aviso?.claves_payload).toEqual(['model', 'record_id', 'values']);
		expect(reporte.veredicto).toBe('avisos_sin_efecto');
	});

	it('acota las consultas de PostgreSQL al holding y la ventana pedida', async () => {
		const { service, consultas } = crearServicio({});

		const reporte = await service.getReturnLegDiagnostics({ dias: 7, holdingId: HOLDING });

		expect(reporte.dias).toBe(7);
		expect(reporte.holding_id).toBe(HOLDING);
		expect(reporte.desde.getTime()).toBe(reporte.generado_en.getTime() - 7 * 24 * 60 * 60 * 1000);
		for (const consulta of consultas) {
			expect(consulta.params).toContain(HOLDING);
		}
	});

	it('acota la ventana a 365 días y nunca baja de 1', async () => {
		const { service } = crearServicio({});

		expect((await service.getReturnLegDiagnostics({ dias: 5000 })).dias).toBe(365);
		expect((await service.getReturnLegDiagnostics({ dias: 0 })).dias).toBe(30);
		expect((await service.getReturnLegDiagnostics({ dias: -4 })).dias).toBe(1);
		expect((await service.getReturnLegDiagnostics({})).dias).toBe(30);
	});

	it('sin holding no filtra por holding, para poder mirar todas las bases a la vez', async () => {
		const { service, consultas } = crearServicio({});

		const reporte = await service.getReturnLegDiagnostics({});

		expect(reporte.holding_id).toBeUndefined();
		expect(consultas.every((consulta) => consulta.params.includes(null))).toBe(true);
	});

	it('calcula las horas sin avisos contra el último recibido', async () => {
		const ahora = new Date('2026-10-01T18:00:00.000Z');
		jest.useFakeTimers().setSystemTime(ahora);

		const { service } = crearServicio({ avisos: { total: 1, enVentana: 0, ultimo: { createdAt: '2026-09-15T14:00:00.000Z' } } });

		const reporte = await service.getReturnLegDiagnostics({});

		expect(reporte.avisos_recibidos.horas_sin_avisos).toBe(388);

		jest.useRealTimers();
	});

	it('ubica los dos bordes del corte', async () => {
		const { service } = crearServicio({
			ultimaConAviso: {
				id: 'factura-ok',
				invoice_number: 'F101-00004300',
				odoo_invoice_id: 198500,
				status: 'Enviada',
				sent_to_odoo_at: '2026-09-15T11:00:00.000Z',
			},
			primeraSinAviso: {
				id: 'factura-sin-folio',
				invoice_number: null,
				odoo_invoice_id: '198706',
				status: 'Emitida',
				sent_to_odoo_at: '2026-09-16T11:00:14.000Z',
			},
		});

		const reporte = await service.getReturnLegDiagnostics({});

		expect(reporte.corte.ultima_con_aviso?.invoice_number).toBe('F101-00004300');
		expect(reporte.corte.primera_sin_aviso).toEqual({
			id: 'factura-sin-folio',
			invoice_number: undefined,
			odoo_invoice_id: 198706,
			status: 'Emitida',
			sent_to_odoo_at: new Date('2026-09-16T11:00:14.000Z'),
		});
	});

	it('busca la primera sin aviso después de la última que sí lo recibió', async () => {
		const ultima = {
			id: 'factura-ok',
			invoice_number: 'F101-00004300',
			odoo_invoice_id: 198500,
			status: 'Enviada',
			sent_to_odoo_at: '2026-09-15T11:00:00.000Z',
		};
		const { service, consultas } = crearServicio({ ultimaConAviso: ultima, primeraSinAviso: null });

		await service.getReturnLegDiagnostics({});

		const corte = consultas.find((consulta) => consulta.sql.includes('timestamptz'));
		expect(corte?.params).toContain(ultima.sent_to_odoo_at);
	});
});

describe('OdooWebhookService.saveWebhookLog', () => {
	it('guarda el aviso con status received; markAsProcessed/markAsError existen pero no tienen caller', async () => {
		const documentos: any[] = [];
		const guardar = jest.fn().mockResolvedValue({ _id: 'log-1' });

		// `saveWebhookLog` usa el modelo como constructor, así que el fake es una función.
		function ModeloFake(this: any, datos: any) {
			documentos.push(datos);
			this.save = guardar;
		}

		const service = new OdooWebhookService({ model: jest.fn(() => ModeloFake as any) } as any, { query: jest.fn() } as any);

		await service.saveWebhookLog({ event_type: 'write', model: 'account.move', payload: { id: 198707 } });

		expect(documentos[0]).toMatchObject({ event_type: 'write', model: 'account.move', status: 'received' });
		expect(guardar).toHaveBeenCalled();
	});
});

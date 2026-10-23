import { KameApiError } from './kame-client.service';
import { KameExportService } from './kame-export.service';
import { KAME_MAX_ATTEMPTS } from './kame.types';

const XML = `<DTE><Documento><Encabezado>
	<IdDoc><TipoDTE>33</TipoDTE><Folio>5</Folio><FchEmis>2026-10-19</FchEmis><FmaPago>1</FmaPago></IdDoc>
	<Receptor><RUTRecep>76987654-5</RUTRecep><RznSocRecep>CLIENTE SPA</RznSocRecep><GiroRecep>SERVICIOS</GiroRecep><DirRecep>CALLE 1</DirRecep><CmnaRecep>PROVIDENCIA</CmnaRecep></Receptor>
	<Totales><MntNeto>1000</MntNeto><IVA>190</IVA><MntTotal>1190</MntTotal></Totales>
</Encabezado><Detalle><NmbItem>Servicio</NmbItem><QtyItem>1</QtyItem><PrcItem>1000</PrcItem><MontoItem>1000</MontoItem></Detalle></Documento></DTE>`;

type Row = Record<string, unknown>;

function setup(options: { row?: Row; settings?: Row | null; connection?: Row | null; closed?: boolean; postings?: Row[] } = {}) {
	const row = {
		id: 'exp-1',
		holding_id: 'h-1',
		company_id: 'c-1',
		environment: 'pruebas',
		object: 'invoice',
		invoice_id: 'inv-1',
		period: null,
		status: 'pending',
		attempts: 0,
		...options.row,
	};
	const updates: unknown[][] = [];
	const query = jest.fn(async (sql: string, params: unknown[] = []) => {
		if (sql.startsWith('UPDATE erp_exports SET status = $2')) {
			updates.push(params);

			return [];
		}
		if (sql.includes('FROM invoices i LEFT JOIN contracts c'))
			return [{ id: 'inv-1', dte_id: 'dte-1', dte_tipo: 33, dte_folio: 5, company_id: 'c-1', contract_number: 'CTR-2026-81' }];
		if (sql.includes('FROM invoices i LEFT JOIN clients cl'))
			return [{ id: 'inv-1', contract_id: 'ctr-1', invoice_number: '5', client_name: 'Cliente' }];

		return [];
	});
	const manager = {
		query: jest.fn(async (sql: string) => (sql.startsWith('SELECT e.id') ? [row] : [])),
	};
	const dataSource = { query, transaction: jest.fn(async (work: (m: typeof manager) => unknown) => work(manager)) };
	const connections = {
		findSettings: jest.fn(async () =>
			options.settings === undefined ? { company_id: 'c-1', active_environment: 'pruebas', enabled: true, dry_run: false } : options.settings
		),
		findConnection: jest.fn(async () =>
			options.connection === undefined
				? { id: 'conn-1', user_email: 'conta@empresa.cl', kame_company_rut: '10491356-3', business_unit: 'CASA MATRIZ', branch: null }
				: options.connection
		),
		credentialOf: jest.fn(() => ({ key: 'conn-1', clientId: 'id', clientSecret: 'secret' })),
		assertCompany: jest.fn(),
	};
	const client = {
		write: jest.fn(async () => ({ ok: true, id: '1183781', folio: '5', error: null, raw: { Estado: 'Ok', Id: 1183781 } })),
		getSale: jest.fn(async () => null),
	};
	const factura = { documentoDte: jest.fn(async () => ({ contenido: Buffer.from(XML), contentType: 'application/xml', fileName: 'DTE.xml' })) };
	const revenue = {
		journal: jest.fn(async () => ({
			currency: 'CLP',
			months: [
				{
					period: '2026-09',
					closed: options.closed ?? true,
					postings: options.postings ?? [
						{ account: 'receivable', debit: 1190, credit: 0, name: 'Clientes', external_code: '1.01.05.01' },
						{ account: 'deferred', debit: 0, credit: 1190, name: 'Diferidos', external_code: '2.01.07.01' },
					],
				},
			],
		})),
	};
	const notifications = { createOrUpdate: jest.fn() };
	const service = new KameExportService(
		dataSource as never,
		connections as never,
		client as never,
		factura as never,
		revenue as never,
		notifications as never
	);
	const last = () => {
		const params = updates[updates.length - 1];

		return {
			status: params[1],
			last_error: params[2],
			payload: params[3] ? JSON.parse(String(params[3])) : null,
			external_id: params[5],
			sent: params[7],
			attempts: params[8],
			stop: params[9],
			next: params[10],
		};
	};

	return { service, client, factura, notifications, query, manager, last, updates, revenue };
}

describe('KameExportService', () => {
	const original = process.env.KAME_ALLOWED_RUTS;

	beforeEach(() => {
		// Fuera de producción el resguardo falla cerrado sin lista: las pruebas declaran las empresas permitidas.
		process.env.KAME_ALLOWED_RUTS = '10491356-3,77307689-8';
	});

	afterEach(() => {
		if (original === undefined) delete process.env.KAME_ALLOWED_RUTS;
		else process.env.KAME_ALLOWED_RUTS = original;
	});

	it('envía la factura a Kame desde el XML emitido y la marca enviada con el id de Kame', async () => {
		const ctx = setup();

		await expect(ctx.service.process()).resolves.toMatchObject({ processed: 1, sent: 1 });

		expect(ctx.factura.documentoDte).toHaveBeenCalledWith('c-1', 'dte-1', 'xml');
		expect(ctx.client.write).toHaveBeenCalledWith(
			{ key: 'conn-1', clientId: 'id', clientSecret: 'secret' },
			'/Documento/addVenta',
			expect.objectContaining({
				Folio: '5',
				Documento: 'Factura Electrónica',
				Usuario: 'conta@empresa.cl',
				Comentario: 'Contrato CTR-2026-81 · Sapira',
			})
		);
		expect(ctx.last()).toMatchObject({ status: 'sent', external_id: '1183781', sent: true, attempts: 1 });
		// Antes de enviar, la fila quedó tomada (`sending`) para que otro proceso no la envíe dos veces.
		expect(ctx.manager.query.mock.calls.some(([sql]) => String(sql).includes('FOR UPDATE OF e SKIP LOCKED'))).toBe(true);
	});

	it('en simulación arma el cuerpo y lo guarda sin llamar a Kame', async () => {
		const ctx = setup({ settings: { company_id: 'c-1', active_environment: 'pruebas', enabled: true, dry_run: true } });

		await expect(ctx.service.process()).resolves.toMatchObject({ simulated: 1, sent: 0 });

		expect(ctx.client.write).not.toHaveBeenCalled();
		expect(ctx.last()).toMatchObject({ status: 'simulated', payload: expect.objectContaining({ Folio: '5', total: 1190 }) });
	});

	it('antes de crear una venta consulta getVenta (también en un reintento manual): si Kame ya la tiene, no la crea de nuevo', async () => {
		const ctx = setup({ row: { attempts: 0, status: 'error' } });
		ctx.client.getSale.mockResolvedValue({ IdVenta: 42 } as never);

		await ctx.service.process();

		expect(ctx.client.getSale).toHaveBeenCalledWith(expect.anything(), 'Factura Electrónica', 5);
		expect(ctx.client.write).not.toHaveBeenCalled();
		expect(ctx.last()).toMatchObject({ status: 'sent', external_id: '42' });
	});

	it('un rechazo queda en error con espera; al agotar los intentos se avisa y no se reintenta solo', async () => {
		const ctx = setup();
		ctx.client.write.mockRejectedValue(new KameApiError('El IVA no cuadra', 400, false));

		await ctx.service.process();
		expect(ctx.last()).toMatchObject({ status: 'error', last_error: 'El IVA no cuadra', attempts: 1, stop: false });
		expect((ctx.last().next as Date).getTime()).toBeGreaterThan(Date.now() + 59 * 60_000);
		expect(ctx.notifications.createOrUpdate).not.toHaveBeenCalled();

		const final = setup({ row: { attempts: KAME_MAX_ATTEMPTS - 1, status: 'error' } });
		final.client.write.mockRejectedValue(new KameApiError('El IVA no cuadra', 400, false));
		await final.service.process();

		expect(final.last()).toMatchObject({ status: 'error', stop: true });
		expect(final.notifications.createOrUpdate).toHaveBeenCalledWith(
			'h-1',
			expect.objectContaining({ type: 'invoice_odoo_failure', resource_id: 'inv-1', deduplication_key: 'invoice-kame-failure:inv-1:pruebas' })
		);
	});

	it('fuera de producción no envía a una empresa de Kame que no sea la de pruebas', async () => {
		process.env.KAME_ALLOWED_RUTS = '10491356-3';
		const ctx = setup({ connection: { id: 'conn-1', user_email: 'x@y.cl', kame_company_rut: '77307689-8', business_unit: null, branch: null } });

		await ctx.service.process();

		expect(ctx.client.write).not.toHaveBeenCalled();
		expect(ctx.last()).toMatchObject({ status: 'error', last_error: 'Este entorno solo puede enviar a la empresa de pruebas de Kame' });
	});

	it('asientos: el comprobante del mes cerrado va a addComprobante; un mes reabierto se omite', async () => {
		const ctx = setup({ row: { object: 'journal', invoice_id: null, period: '2026-09-01' } });

		await ctx.service.process();
		expect(ctx.revenue.journal).toHaveBeenCalledWith('h-1', { companyId: 'c-1', from: '2026-09', to: '2026-09' });
		expect(ctx.client.write).toHaveBeenCalledWith(
			expect.anything(),
			'/Contabilidad/addComprobante',
			expect.objectContaining({ tipoComprobante: 'TRASPASO', fecha: '2026-09-30', comentario: 'Devengo de ingresos 2026-09 · Sapira' })
		);

		const reopened = setup({ row: { object: 'journal', invoice_id: null, period: '2026-09-01' }, closed: false });
		await reopened.service.process();
		expect(reopened.client.write).not.toHaveBeenCalled();
		expect(reopened.last()).toMatchObject({ status: 'skipped' });
	});

	it('la vista previa de una compañía que no lleva pesos dice por qué, sin error 500', async () => {
		const ctx = setup();
		ctx.revenue.journal.mockResolvedValueOnce({ currency: 'USD', months: [] } as never);

		await expect(ctx.service.previewJournal('h-1', 'c-1', '2026-09')).resolves.toEqual({
			period: '2026-09',
			closed: false,
			ok: false,
			error: 'Los asientos de la compañía están en USD y Kame lleva pesos',
			total: 0,
			body: null,
		});
	});

	it('un mes sin códigos de cuenta no se envía y dice qué falta', async () => {
		const ctx = setup({
			row: { object: 'journal', invoice_id: null, period: '2026-09-01' },
			postings: [{ account: 'revenue', debit: 0, credit: 100, name: 'Ingresos', external_code: null }],
		});

		await ctx.service.process();

		expect(ctx.client.write).not.toHaveBeenCalled();
		expect(ctx.last()).toMatchObject({ status: 'error', last_error: 'Faltan los códigos del ERP de estas cuentas: Ingresos' });
	});

	it('recupera filas trabadas en «Enviando»: la factura vuelve a la cola; NC y asientos quedan con error para revisar en Kame', async () => {
		const ctx = setup();

		await ctx.service.recoverStuck('h-1');
		const [sql, params] = ctx.query.mock.calls[0];

		expect(String(sql)).toContain(`e.status = 'sending' AND e.updated_at < now() - ($1::int * interval '1 minute')`);
		expect(String(sql)).toContain(`WHEN e.object = 'invoice' AND COALESCE(i.dte_tipo, 0) <> 61 THEN 'pending' ELSE 'error'`);
		expect(String(sql)).toContain(`ELSE 'infinity'::timestamptz`);
		expect(params).toEqual([30, 'h-1']);
	});

	it('encolar: solo DTE válidos ante el SII desde invoices_from, sin Odoo, y meses cerrados desde journal_from', async () => {
		const ctx = setup();

		await ctx.service.enqueue('h-1');
		const [invoiceSql, journalSql] = ctx.query.mock.calls.map(([sql]) => String(sql));

		expect(invoiceSql).toContain(`i.dte_status IN ('aceptado', 'reparos')`);
		expect(invoiceSql).toContain('i.issue_date >= s.invoices_from');
		expect(invoiceSql).toContain('co.odoo_integration_id IS NULL');
		expect(invoiceSql).toContain('s.enabled AND s.send_invoices');
		expect(invoiceSql).toContain(`ON CONFLICT (system, environment, invoice_id) WHERE object = 'invoice' DO NOTHING`);
		expect(journalSql).toContain('generate_series(s.journal_from');
		expect(journalSql).toContain('s.enabled AND s.send_journal');
		expect(ctx.query.mock.calls[1][1]).toEqual(['h-1']);
	});
});

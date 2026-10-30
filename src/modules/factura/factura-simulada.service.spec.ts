import { NotFoundException } from '@nestjs/common';

import { dteAmounts, type DteReceptor, mapInvoiceToDteBody } from '@/modules/contracts/invoice-dte';
import { documentRequest, parseIssuedDte } from '@/modules/kame/kame-mapper';

import { assertDteSimulationAllowed, dteSimulado, esDteSimulado } from './dte-simulado';
import { FacturaSimuladaService, xmlSimulado } from './factura-simulada.service';

const COMPANY = '1bdded45-cda6-4148-a425-fa0086e27ce8';
const EMISOR = { tax_id: '77307689-8', legal_name: 'SAPIRA SPA', legal_address: 'Av. Apoquindo 4501' };
const PROD_URL = 'postgresql://postgres.hklompkypzqtglprfobu:x@aws-0-sa-east-1.pooler.supabase.com:6543/postgres';
const QA_URL = 'postgresql://postgres.obvwrhvyuimjoejqmuqf:x@aws-1-sa-east-1.pooler.supabase.com:6543/postgres';

const receptor = (): DteReceptor => ({
	tax_id: '76.120.605-2',
	legal_name: 'Comercializadora de Tecnologias Lenosoft Limitada',
	economic_activity: 'CONSULTORÍA INFORMÁTICA',
	legal_address: 'Costanera 408',
	commune: 'San Bernardo',
	email: 'contacto@lenosoft.cl',
});

/** Cuerpo DTE real: el mismo que `ContractInvoiceDteService` enviaría a api-factura. */
const cuerpo = (tipo: 33 | 34 | 56 | 61, references: Parameters<typeof mapInvoiceToDteBody>[0]['references'] = []) =>
	mapInvoiceToDteBody({
		tipo,
		issue_date: '2026-10-29',
		due_date: tipo === 33 ? '2026-11-28' : null,
		receptor: receptor(),
		amounts: dteAmounts(
			[
				{ id: 'a', description: 'Plataforma de facturación', quantity: 20, unit_of_measure: 'UF', subtotal_invoice_currency: 790123.45 },
				{ id: 'b', description: 'Soporte', quantity: 1, unit_of_measure: null, subtotal_invoice_currency: 15000 },
			],
			19,
			tipo === 34
		),
		references,
	});

/** Repositorio en memoria con lo que usa el servicio (findOne, maximum, insert, update). */
function memoria() {
	const filas: any[] = [];
	const coincide = (fila: any, where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => fila[key] === value);

	return {
		filas,
		repo: {
			findOne: jest.fn(async ({ where }) => filas.find((fila) => coincide(fila, where)) ?? null),
			maximum: jest.fn(async (_columna: string, where: Record<string, unknown>) => {
				const folios = filas.filter((fila) => coincide(fila, where)).map((fila) => fila.folio);

				return folios.length ? Math.max(...folios) : null;
			}),
			insert: jest.fn(async (fila) => {
				if (filas.some((otra) => otra.company_id === fila.company_id && otra.tipo === fila.tipo && otra.folio === fila.folio)) {
					throw Object.assign(new Error('duplicate key value violates unique constraint'), {
						code: '23505',
						constraint: 'dte_simulations_company_tipo_folio_key',
					});
				}
				filas.push({ track_id: null, ...fila });
			}),
			update: jest.fn(async ({ id }, patch) =>
				Object.assign(
					filas.find((fila) => fila.id === id),
					patch
				)
			),
		},
	};
}

const build = () => {
	const db = memoria();
	const companies = { findOne: jest.fn().mockResolvedValue(EMISOR) };

	return { ...db, service: new FacturaSimuladaService(db.repo as any, companies as any) };
};

describe('dte-simulado', () => {
	it('se prende solo con DTE_SIMULATED=true y reconoce los ids sim_', () => {
		expect(dteSimulado('true')).toBe(true);
		expect(dteSimulado(' TRUE ')).toBe(true);
		expect(dteSimulado('false')).toBe(false);
		expect(dteSimulado(undefined)).toBe(false);
		expect(esDteSimulado('sim_123')).toBe(true);
		expect(esDteSimulado('6716f0c2a1')).toBe(false);
		expect(esDteSimulado(null)).toBe(false);
	});

	it('nunca contra producción: la API no arranca con la base de producción o con NODE_ENV=production sin base identificable', () => {
		expect(() => assertDteSimulationAllowed({ DTE_SIMULATED: 'true', SUPABASE_DATABASE_URL: PROD_URL })).toThrow(/base de producción/);
		expect(() => assertDteSimulationAllowed({ DTE_SIMULATED: 'true', NODE_ENV: 'production' })).toThrow(/NODE_ENV=production/);
		expect(() => assertDteSimulationAllowed({ DTE_SIMULATED: 'true', SUPABASE_DATABASE_URL: QA_URL, NODE_ENV: 'production' })).not.toThrow();
		expect(() => assertDteSimulationAllowed({ DTE_SIMULATED: 'true', NODE_ENV: 'development' })).not.toThrow();
		// Apagada no exige nada: producción corre igual que siempre.
		expect(() => assertDteSimulationAllowed({ SUPABASE_DATABASE_URL: PROD_URL, NODE_ENV: 'production' })).not.toThrow();
	});
});

describe('FacturaSimuladaService', () => {
	it('folio correlativo por compañía y tipo; idempotente por referencia externa', async () => {
		const { service } = build();

		const primera = await service.crearDte(COMPANY, cuerpo(33), 'invoice-1');
		const segunda = await service.crearDte(COMPANY, cuerpo(33), 'invoice-2');
		const exenta = await service.crearDte(COMPANY, cuerpo(34), 'invoice-3');
		const repetida = await service.crearDte(COMPANY, cuerpo(33), 'invoice-1');

		expect(primera).toMatchObject({ folio: 1, tipoDte: 33, ambiente: 'certificacion', existente: false });
		expect(primera.id).toMatch(/^sim_/);
		expect(segunda.folio).toBe(2);
		expect(exenta).toMatchObject({ folio: 1, tipoDte: 34 });
		expect(repetida).toEqual({ ...primera, existente: true });
	});

	it('reemitir un rechazado archiva la referencia y da otro folio', async () => {
		const { service, filas } = build();
		const original = await service.crearDte(COMPANY, cuerpo(33), 'invoice-1');

		const reemitida = await service.crearDte(COMPANY, cuerpo(33), 'invoice-1', { reemitirRechazado: true });

		expect(reemitida).toMatchObject({ folio: 2, existente: false });
		expect(filas.find((fila) => fila.id === original.id).external_ref).toBe(`invoice-1:rechazado:${original.id}`);
	});

	it('un choque de folio en paralelo se reintenta con el siguiente', async () => {
		const { service, repo, filas } = build();
		filas.push({ id: 'sim_otro', company_id: COMPANY, tipo: 33, folio: 1, external_ref: 'invoice-0' });
		repo.maximum.mockResolvedValueOnce(null); // lee antes de que la otra emisión inserte

		await expect(service.crearDte(COMPANY, cuerpo(33), 'invoice-1')).resolves.toMatchObject({ folio: 2 });
		expect(repo.insert).toHaveBeenCalledTimes(2);
	});

	it('enviar da un TrackId SIM y el estado es siempre aceptado', async () => {
		const { service } = build();
		const { id } = await service.crearDte(COMPANY, cuerpo(33), 'invoice-1');

		await expect(service.enviarDte(COMPANY, id)).resolves.toEqual({ trackId: 'SIM-1' });
		await expect(service.estadoDte(COMPANY, id)).resolves.toEqual({
			resultado: 'aceptado',
			estado: 'SIM',
			glosaEstado: 'Emisión simulada (QA): no se envió al SII',
			trackId: 'SIM-1',
		});
		await expect(service.enviarReceptor(COMPANY, id, 'dte@cliente.cl')).resolves.toEqual({ para: 'dte@cliente.cl' });
	});

	it('un documento de otra compañía (o inexistente) es 404', async () => {
		const { service } = build();
		const { id } = await service.crearDte(COMPANY, cuerpo(33), 'invoice-1');

		await expect(service.estadoDte('otra-compania', id)).rejects.toBeInstanceOf(NotFoundException);
		await expect(service.enviarDte(COMPANY, 'sim_nada')).rejects.toBeInstanceOf(NotFoundException);
	});

	it('el PDF es el borrador de api-factura con el cuerpo guardado', async () => {
		const { service } = build();
		const body = cuerpo(33);
		const { id } = await service.crearDte(COMPANY, body, 'invoice-1');
		const borrador = jest.fn().mockResolvedValue({ contenido: Buffer.from('%PDF'), contentType: 'application/pdf', fileName: 'Borrador.pdf' });

		await expect(service.documentoDte(COMPANY, id, 'pdf', borrador)).resolves.toMatchObject({ fileName: 'DTE-33-1-SIMULADO.pdf' });
		expect(borrador).toHaveBeenCalledWith(body);
	});

	describe('el XML simulado lo registra Kame (parseIssuedDte + validación de montos)', () => {
		const contexto = { usuario: 'contabilidad@empresa.cl', unidadNegocio: 'CASA MATRIZ', sucursal: null, comentario: 'Sapira' };
		const referenciaNc = [
			{ document_type_code: '33', document_number: '1', reference_date: '2026-10-29', reference_code: 1, reason: 'Anula factura' },
		];

		it.each([
			['factura 33', 33, []],
			['factura exenta 34', 34, []],
			['nota de crédito 61', 61, referenciaNc],
			['nota de débito 56', 56, referenciaNc],
		] as const)('%s', async (_nombre, tipo, references) => {
			const { service } = build();
			const body = cuerpo(tipo, [...references]);
			const { id, folio } = await service.crearDte(COMPANY, body, `invoice-${tipo}`);

			const xml = await service.documentoDte(COMPANY, id, 'xml', jest.fn());
			const dte = parseIssuedDte(xml.contenido);
			const totales = (body.Encabezado as any).Totales;

			expect(xml).toMatchObject({ contentType: 'application/xml', fileName: `DTE-${tipo}-${folio}-SIMULADO.xml` });
			expect(dte).toMatchObject({ tipo, folio, total: totales.MntTotal, receptor: { rut: '76120605-2' } });
			expect(dte.lineas).toHaveLength(2);
			// Lo que Kame recibiría: cuadra neto + exento + IVA = total y las líneas suman los montos.
			expect(() => documentRequest(dte, contexto)).not.toThrow();
		});
	});

	it('el XML lleva el emisor de la compañía y avisa que no tiene valor tributario', () => {
		const xml = xmlSimulado({ tipo: 33, folio: 7, body: cuerpo(33) }, EMISOR as any);

		expect(xml).toContain('<RUTEmisor>77307689-8</RUTEmisor>');
		expect(xml).toContain('<Folio>7</Folio>');
		expect(xml).toContain('SIMULADO');
		expect(xml).toContain('<Documento ID="SIM-F7T33">');
	});
});

import { randomUUID } from 'crypto';

import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { XMLBuilder } from 'fast-xml-parser';
import { Repository } from 'typeorm';

import { Company } from '@/databases/postgresql/entities/base-tenancy/companies.entity';
import { DteSimulation } from '@/databases/postgresql/entities/facturacion/dte-simulation.entity';

import { assertDteSimulationAllowed, DTE_SIMULADO_PREFIJO } from './dte-simulado';

import type { DteCreado, DteDocumento, DteEstado } from './factura-client.service';

/** Documentos de exportación: su nodo es `Exportaciones`, no `Documento` (formato SII). */
const TIPOS_EXPORTACION = new Set([110, 111, 112]);
/** Choques al reservar un folio en paralelo: se reintenta con el siguiente. */
const INTENTOS_FOLIO = 5;

/**
 * Emisión **simulada** de DTE (`DTE_SIMULATED=true`, solo QA): responde lo mismo que api-factura sin timbrar, sin gastar folios ni
 * pasar por el SII. Guarda cada documento en `dte_simulations` con folio correlativo por compañía y tipo, lo da por aceptado y devuelve
 * su XML armado con el mismo cuerpo que se habría enviado, así Kame lo registra como a uno real. Lo usa `FacturaClientService` cuando
 * la simulación está prendida; la API no arranca con ella contra la base de producción (`assertDteSimulationAllowed`).
 */
@Injectable()
export class FacturaSimuladaService implements OnModuleInit {
	private readonly logger = new Logger(FacturaSimuladaService.name);

	constructor(
		@InjectRepository(DteSimulation) private readonly simulations: Repository<DteSimulation>,
		@InjectRepository(Company) private readonly companies: Repository<Company>
	) {}

	onModuleInit() {
		assertDteSimulationAllowed();
	}

	/** Como `POST /dte/createDte`: idempotente por `externalRef`; `reemitirRechazado` archiva el anterior y da otro folio. */
	async crearDte(
		companyId: string,
		body: Record<string, unknown>,
		externalRef: string,
		options: { reemitirRechazado?: boolean } = {}
	): Promise<DteCreado> {
		const tipo = Number(idDocOf(body).TipoDTE);
		const existente = await this.simulations.findOne({ where: { company_id: companyId, external_ref: externalRef } });

		if (existente && !options.reemitirRechazado) return creado(existente, true);
		if (existente) await this.simulations.update({ id: existente.id }, { external_ref: `${externalRef}:rechazado:${existente.id}` });

		for (let intento = 1; ; intento++) {
			const folio = ((await this.simulations.maximum('folio', { company_id: companyId, tipo })) ?? 0) + 1;
			const simulation = { id: `${DTE_SIMULADO_PREFIJO}${randomUUID()}`, company_id: companyId, tipo, folio, external_ref: externalRef, body };

			try {
				await this.simulations.insert(simulation);
				this.logger.log(`DTE simulado ${tipo} N° ${folio} (compañía ${companyId}, ref ${externalRef}): no se envió a api-factura`);

				return creado(simulation, false);
			} catch (error) {
				// Otra emisión tomó el mismo folio: se reintenta con el siguiente.
				if (!esChoqueDeFolio(error) || intento >= INTENTOS_FOLIO) throw error;
			}
		}
	}

	/** Como `POST /dte/sendDte`: no sale nada al SII; el TrackId simulado es `SIM-<folio>`. */
	async enviarDte(companyId: string, dteId: string): Promise<{ trackId: string }> {
		const simulation = await this.find(companyId, dteId);
		const trackId = `SIM-${simulation.folio}`;

		await this.simulations.update({ id: simulation.id }, { track_id: trackId });

		return { trackId };
	}

	/** Un documento simulado siempre queda aceptado: es lo que habilita su registro en Kame. */
	async estadoDte(companyId: string, dteId: string): Promise<DteEstado> {
		const simulation = await this.find(companyId, dteId);

		return {
			resultado: 'aceptado',
			estado: 'SIM',
			glosaEstado: 'Emisión simulada (QA): no se envió al SII',
			trackId: simulation.track_id ?? `SIM-${simulation.folio}`,
		};
	}

	/** No se manda correo al receptor desde un entorno de pruebas. */
	async enviarReceptor(companyId: string, dteId: string, para: string): Promise<{ para: string }> {
		await this.find(companyId, dteId);
		this.logger.log(`DTE simulado ${dteId}: envío al receptor (${para}) omitido`);

		return { para };
	}

	/** XML del documento simulado (formato SII, como el que entrega api-factura) o su PDF en borrador, sin valor tributario. */
	async documentoDte(
		companyId: string,
		dteId: string,
		formato: 'pdf' | 'xml',
		borradorPdf: (body: Record<string, unknown>) => Promise<DteDocumento>
	): Promise<DteDocumento> {
		const simulation = await this.find(companyId, dteId);
		const nombre = `DTE-${simulation.tipo}-${simulation.folio}-SIMULADO`;

		if (formato === 'pdf') return { ...(await borradorPdf(simulation.body)), fileName: `${nombre}.pdf` };

		const company = await this.companies.findOne({ where: { id: companyId } });

		return { contenido: Buffer.from(xmlSimulado(simulation, company), 'latin1'), contentType: 'application/xml', fileName: `${nombre}.xml` };
	}

	private async find(companyId: string, dteId: string): Promise<DteSimulation> {
		const simulation = await this.simulations.findOne({ where: { id: dteId, company_id: companyId } });

		if (!simulation) throw new NotFoundException('Documento simulado no encontrado');

		return simulation;
	}
}

const idDocOf = (body: Record<string, unknown>) => ((body.Encabezado as Record<string, unknown> | undefined)?.IdDoc ?? {}) as Record<string, unknown>;

const creado = (simulation: Pick<DteSimulation, 'id' | 'folio' | 'tipo'>, existente: boolean): DteCreado => ({
	id: simulation.id,
	folio: simulation.folio,
	tipoDte: simulation.tipo,
	ambiente: 'certificacion',
	existente,
});

const esChoqueDeFolio = (error: unknown) =>
	(error as { code?: string })?.code === '23505' &&
	String((error as { constraint?: string; message?: string })?.constraint ?? (error as Error)?.message).includes('folio');

/**
 * `EnvioDTE` con el documento simulado: el cuerpo enviado (Encabezado, Detalle, Referencia) más el folio y el emisor de la compañía.
 * Sin firma ni TED: no tiene valor tributario, pero es lo que leen `parseIssuedDte` (Kame) y quien lo descargue.
 */
export function xmlSimulado(
	simulation: Pick<DteSimulation, 'tipo' | 'folio' | 'body'>,
	company: Pick<Company, 'tax_id' | 'legal_name' | 'legal_address'> | null
): string {
	const { Encabezado = {}, ...resto } = simulation.body as { Encabezado?: Record<string, unknown> } & Record<string, unknown>;
	const { IdDoc = {}, ...encabezado } = Encabezado as { IdDoc?: Record<string, unknown> } & Record<string, unknown>;
	const { TipoDTE, ...idDoc } = IdDoc as Record<string, unknown>;
	const nodo = TIPOS_EXPORTACION.has(simulation.tipo) ? 'Exportaciones' : 'Documento';
	const emisor = {
		RUTEmisor: company?.tax_id ?? '',
		RznSoc: company?.legal_name ?? '',
		DirOrigen: company?.legal_address ?? '',
	};
	const documento = {
		'@_ID': `SIM-F${simulation.folio}T${simulation.tipo}`,
		Encabezado: { IdDoc: { TipoDTE: TipoDTE ?? simulation.tipo, Folio: simulation.folio, ...idDoc }, Emisor: emisor, ...encabezado },
		...resto,
	};
	const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: true, suppressEmptyNode: true });

	return `<?xml version="1.0" encoding="ISO-8859-1"?>\n<!-- Documento SIMULADO (DTE_SIMULATED, QA): sin firma ni timbre, sin valor tributario -->\n${builder.build(
		{
			EnvioDTE: {
				'@_xmlns': 'http://www.sii.cl/SiiDte',
				'@_version': '1.0',
				SetDTE: { '@_ID': 'SetDoc', DTE: { '@_version': '1.0', [nodo]: documento } },
			},
		}
	)}`;
}

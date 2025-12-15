import { randomUUID } from 'crypto';

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Company } from './entities/companies.entity';
import { OdooInvoiceLinesStg } from './entities/odoo-invoice-lines-stg.entity';
import { OdooInvoicesStg } from './entities/odoo-invoices-stg.entity';
import { OdooPartnersStg } from './entities/odoo-partners-stg.entity';
import { Product } from './entities/products.entity';
import { XmlRpcClientHelper } from './helpers/xml-rpc-client.helper';
import {
	CompaniesResult,
	EstimateResult,
	OdooCompany,
	OdooConnection,
	OdooInvoice,
	OdooInvoiceLine,
	OdooPartner,
	OdooProduct,
	OdooTax,
	ProductsResult,
	SapiraCompany,
	SapiraProduct,
	SyncResult,
} from './interfaces/odoo.interface';
import { GetCompaniesDTO, GetProductsDTO, SyncInvoicesDTO } from './odoo.dto';
import { OdooProvider } from './odoo.provider';

@Injectable()
export class OdooService {
	constructor(
		private readonly odooProvider: OdooProvider,
		@InjectRepository(OdooInvoicesStg)
		private readonly invoicesStgRepository: Repository<OdooInvoicesStg>,
		@InjectRepository(OdooInvoiceLinesStg)
		private readonly invoiceLinesStgRepository: Repository<OdooInvoiceLinesStg>,
		@InjectRepository(OdooPartnersStg)
		private readonly partnersStgRepository: Repository<OdooPartnersStg>,
		@InjectRepository(Company)
		private readonly companiesRepository: Repository<Company>,
		@InjectRepository(Product)
		private readonly productsRepository: Repository<Product>
	) {}
	async syncInvoices(syncData: SyncInvoicesDTO): Promise<SyncResult | EstimateResult> {
		const { connection_id, limit = 60, offset = 0, date_from, date_to, estimate_only = false, sync_session_id } = syncData;

		// Generar UUID válido para sync_session_id si no se proporciona o no es un UUID válido
		const validSyncSessionId = sync_session_id && this.isValidUUID(sync_session_id) ? sync_session_id : randomUUID();

		if (!connection_id) {
			throw new Error('connection_id es requerido');
		}

		// Obtener configuración de conexión
		const connection = await this.getOdooConnection(connection_id);

		// Crear clientes XML-RPC
		const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
		const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

		// Autenticación
		console.log('Intentando autenticación con Odoo...');
		console.log('URL:', connection.url);
		console.log('Database:', connection.database_name);
		console.log('Username:', connection.username);

		let uid: number;
		try {
			uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);
			console.log('Respuesta de autenticación:', uid);

			if (!uid) {
				throw new Error('Error de autenticación con Odoo - UID no recibido');
			}

			console.log('Autenticación exitosa, UID:', uid);
		} catch (authError) {
			console.error('Error durante autenticación:', authError);
			throw new Error(`Error de autenticación con Odoo: ${authError.message}`);
		}

		if (estimate_only) {
			return await this.estimateInvoices(objectClient, connection, uid, date_from, date_to);
		}

		return await this.performInvoiceSync(objectClient, connection, uid, limit, offset, date_from, date_to, validSyncSessionId);
	}

	private async estimateInvoices(
		objectClient: XmlRpcClientHelper,
		connection: OdooConnection,
		uid: number,
		date_from?: string,
		date_to?: string
	): Promise<EstimateResult> {
		// Consulta 1: Contar líneas de factura
		const linesSearchDomain = [
			['move_id.state', '=', 'posted'],
			['move_id.move_type', 'in', ['out_invoice']],
			['display_type', '=', 'product'],
			['move_id.payment_state', '!=', 'reversed'],
		];

		if (date_from) {
			linesSearchDomain.push(['move_id.invoice_date', '>=', date_from]);
		}
		if (date_to) {
			linesSearchDomain.push(['move_id.invoice_date', '<=', date_to]);
		}

		const totalLines = await objectClient.methodCall('execute_kw', [
			connection.database_name,
			uid,
			connection.api_key,
			'account.move.line',
			'search_count',
			[linesSearchDomain],
		]);

		// Consulta 2: Contar facturas únicas
		const invoicesSearchDomain = [
			['state', '=', 'posted'],
			['move_type', 'in', ['out_invoice']],
			['payment_state', '!=', 'reversed'],
		];

		if (date_from) {
			invoicesSearchDomain.push(['invoice_date', '>=', date_from]);
		}
		if (date_to) {
			invoicesSearchDomain.push(['invoice_date', '<=', date_to]);
		}

		const totalInvoices = await objectClient.methodCall('execute_kw', [
			connection.database_name,
			uid,
			connection.api_key,
			'account.move',
			'search_count',
			[invoicesSearchDomain],
		]);

		// Consulta 3: Encontrar facturas sin líneas de producto
		let invoicesWithoutProductLines = 0;
		let invoicesWithoutProductLinesNames: string[] = [];

		if (totalInvoices > 0) {
			// Buscar facturas que NO tienen ninguna línea con display_type = 'product'
			// Usamos NOT EXISTS para encontrar facturas sin líneas de producto
			const invoicesWithoutProductLinesSearchDomain = [
				['state', '=', 'posted'],
				['move_type', 'in', ['out_invoice']],
				['payment_state', '!=', 'reversed'],
				'!',
				['line_ids.display_type', '=', 'product'], // NOT EXISTS: facturas que NO tienen líneas de producto
			];

			if (date_from) {
				invoicesWithoutProductLinesSearchDomain.push(['invoice_date', '>=', date_from]);
			}
			if (date_to) {
				invoicesWithoutProductLinesSearchDomain.push(['invoice_date', '<=', date_to]);
			}

			invoicesWithoutProductLines = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.move',
				'search_count',
				[invoicesWithoutProductLinesSearchDomain],
			]);

			// Si hay facturas sin líneas de producto, obtener TODOS los display_name
			if (invoicesWithoutProductLines > 0) {
				// Obtener TODOS los IDs de facturas sin líneas de producto
				const allInvoicesWithoutProductLinesIds = await objectClient.methodCall('execute_kw', [
					connection.database_name,
					uid,
					connection.api_key,
					'account.move',
					'search',
					[invoicesWithoutProductLinesSearchDomain],
					{ order: 'id desc' }, // Sin límite para obtener todos
				]);

				// Luego obtener TODOS sus nombres
				if (Array.isArray(allInvoicesWithoutProductLinesIds) && allInvoicesWithoutProductLinesIds.length > 0) {
					const invoicesData = await objectClient.methodCall('execute_kw', [
						connection.database_name,
						uid,
						connection.api_key,
						'account.move',
						'read',
						[allInvoicesWithoutProductLinesIds],
						{ fields: ['display_name'] },
					]);

					if (Array.isArray(invoicesData)) {
						invoicesWithoutProductLinesNames = invoicesData.map((invoice: any) => invoice.display_name || 'Sin nombre');
					}
				}
			}
		}

		return {
			success: true,
			total_lines: totalLines,
			total_invoices: totalInvoices,
			lines_per_invoice: totalInvoices > 0 ? Math.round((totalLines / totalInvoices) * 100) / 100 : 0,
			total_invoices_without_product_lines: invoicesWithoutProductLines,
			invoices_without_product_lines_names: invoicesWithoutProductLinesNames,
			message: `Conteo: ${totalLines} líneas de ${totalInvoices} facturas encontradas`,
		};
	}

	private async performInvoiceSync(
		objectClient: XmlRpcClientHelper,
		connection: OdooConnection,
		uid: number,
		limit: number,
		offset: number,
		date_from?: string,
		date_to?: string,
		syncSessionId?: string
	): Promise<SyncResult> {
		const batchId = this.generateBatchId();

		// Filtros para líneas de factura
		const linesSearchDomain = [
			['move_id.state', '=', 'posted'],
			['move_id.move_type', 'in', ['out_invoice']],
			['display_type', '=', 'product'],
			['move_id.payment_state', '!=', 'reversed'],
		];

		if (date_from) {
			linesSearchDomain.push(['move_id.invoice_date', '>=', date_from]);
		}
		if (date_to) {
			linesSearchDomain.push(['move_id.invoice_date', '<=', date_to]);
		}

		// Buscar líneas de factura con límites directos
		const lineIds = await objectClient.methodCall('execute_kw', [
			connection.database_name,
			uid,
			connection.api_key,
			'account.move.line',
			'search',
			[linesSearchDomain],
			{
				limit: limit,
				offset: offset,
				order: 'move_id desc',
			},
		]);

		if (!Array.isArray(lineIds) || lineIds.length === 0) {
			return {
				success: true,
				message: 'No se encontraron líneas de factura para sincronizar',
				invoices_synced: 0,
				lines_synced: 0,
				partners_synced: 0,
				total_processed: 0,
				batch_id: batchId,
				errors: 0,
				stats: {
					saved_invoices: 0,
					saved_lines: 0,
					saved_partners: 0,
					errors: 0,
				},
			};
		}

		// Obtener datos de las líneas para extraer los move_ids únicos
		const linesData = await objectClient.methodCall('execute_kw', [
			connection.database_name,
			uid,
			connection.api_key,
			'account.move.line',
			'read',
			[lineIds],
			{ fields: ['id', 'move_id'] },
		]);

		if (!Array.isArray(linesData)) {
			throw new Error(`La lectura de líneas devolvió un tipo inválido: ${typeof linesData}`);
		}

		// Extraer IDs únicos de facturas
		const invoiceIds = [...new Set(linesData.map((line: any) => line.move_id[0]))];

		if (invoiceIds.length === 0) {
			return {
				success: true,
				message: 'No se encontraron facturas para sincronizar',
				invoices_synced: 0,
				lines_synced: 0,
				partners_synced: 0,
				total_processed: 0,
				batch_id: batchId,
				errors: 0,
				stats: {
					saved_invoices: 0,
					saved_lines: 0,
					saved_partners: 0,
					errors: 0,
				},
			};
		}

		// Obtener facturas completas
		const invoices = await this.getInvoicesData(objectClient, connection, uid, invoiceIds);

		// Procesar facturas y líneas
		const { savedInvoices, savedLines, errors } = await this.processInvoicesAndLines(
			invoices,
			linesData,
			objectClient,
			connection,
			uid,
			batchId,
			syncSessionId
		);

		// Sincronizar partners del lote actual
		const savedPartners = await this.syncPartnersFromCurrentBatch(invoices, connection, uid, objectClient, syncSessionId);

		return {
			success: true,
			message: `Sincronización completada: ${savedInvoices} facturas, ${savedLines} líneas y ${savedPartners} partners guardados`,
			invoices_synced: savedInvoices,
			lines_synced: savedLines,
			partners_synced: savedPartners,
			errors: errors,
			batch_id: batchId,
			total_processed: lineIds.length,
			stats: {
				saved_invoices: savedInvoices,
				saved_lines: savedLines,
				saved_partners: savedPartners,
				errors: errors,
			},
		};
	}

	private async getInvoicesData(
		objectClient: XmlRpcClientHelper,
		connection: OdooConnection,
		uid: number,
		invoiceIds: number[]
	): Promise<OdooInvoice[]> {
		return await objectClient.methodCall('execute_kw', [
			connection.database_name,
			uid,
			connection.api_key,
			'account.move',
			'read',
			[invoiceIds],
			{
				fields: [
					'id',
					'name',
					'display_name',
					'move_type',
					'state',
					'partner_id',
					'commercial_partner_id',
					'invoice_date',
					'invoice_date_due',
					'date',
					'amount_untaxed',
					'amount_tax',
					'amount_total',
					'amount_residual',
					'currency_id',
					'company_currency_id',
					'invoice_origin',
					'ref',
					'narration',
					'payment_reference',
					'invoice_line_ids',
					'line_ids',
					'journal_id',
					'company_id',
					'create_date',
					'write_date',
					'create_uid',
					'write_uid',
					'invoice_user_id',
					'user_id',
					'team_id',
					'invoice_payment_term_id',
					'fiscal_position_id',
					'payment_state',
					'invoice_payments_widget',
				],
			},
		]);
	}

	private async processInvoicesAndLines(
		invoices: OdooInvoice[],
		linesData: any[],
		objectClient: XmlRpcClientHelper,
		connection: OdooConnection,
		uid: number,
		batchId: string,
		syncSessionId?: string
	): Promise<{ savedInvoices: number; savedLines: number; errors: number; batchId: string; syncSessionId?: string }> {
		let savedInvoices = 0;
		let savedLines = 0;
		let errors = 0;

		for (const invoice of invoices) {
			try {
				// Guardar factura en base de datos
				const savedInvoice = await this.saveInvoiceToDatabase(invoice, batchId, connection.holding_id, syncSessionId);

				savedInvoices++;

				// Procesar líneas de la factura
				const invoiceLines = linesData.filter((line: any) => line.move_id[0] === invoice.id);

				if (invoiceLines.length > 0) {
					const lineIds = invoiceLines.map((line: any) => line.id);
					const lines = await this.getInvoiceLinesData(objectClient, connection, uid, lineIds);

					for (const line of lines) {
						try {
							// Guardar línea en base de datos
							await this.saveLineToDatabase(line, savedInvoice.id, batchId, connection.holding_id, syncSessionId);
							savedLines++;
						} catch (lineErr) {
							errors++;
						}
					}
				}
			} catch (invoiceErr) {
				console.error(`Error procesando factura ${invoice.name}:`, invoiceErr);
				errors++;
			}
		}

		return { savedInvoices, savedLines, errors, batchId, syncSessionId };
	}

	private async getInvoiceLinesData(
		objectClient: XmlRpcClientHelper,
		connection: OdooConnection,
		uid: number,
		lineIds: number[]
	): Promise<OdooInvoiceLine[]> {
		return await objectClient.methodCall('execute_kw', [
			connection.database_name,
			uid,
			connection.api_key,
			'account.move.line',
			'read',
			[lineIds],
			{
				fields: [
					'id',
					'move_id',
					'name',
					'display_name',
					'sequence',
					'product_id',
					'product_uom_id',
					'quantity',
					'price_unit',
					'price_subtotal',
					'price_total',
					'discount',
					'tax_base_amount',
					'account_id',
					'tax_ids',
					'tax_line_id',
					'partner_id',
					'currency_id',
					'create_date',
					'write_date',
					'display_type',
				],
			},
		]);
	}

	private async syncPartnersFromCurrentBatch(
		invoices: OdooInvoice[],
		connection: OdooConnection,
		uid: number,
		objectClient: XmlRpcClientHelper,
		syncSessionId?: string
	): Promise<number> {
		try {
			const batchId = randomUUID();

			console.log(syncSessionId);
			console.log(batchId);

			// Extraer IDs únicos de partners
			const partnerIds = new Set<number>();

			for (const invoice of invoices) {
				if (invoice.partner_id && Array.isArray(invoice.partner_id) && invoice.partner_id.length > 0) {
					partnerIds.add(invoice.partner_id[0]);
				}
				if (invoice.commercial_partner_id && Array.isArray(invoice.commercial_partner_id) && invoice.commercial_partner_id.length > 0) {
					partnerIds.add(invoice.commercial_partner_id[0]);
				}
			}

			const uniquePartnerIds = Array.from(partnerIds);

			console.log(`Partners únicos extraídos de facturas: ${uniquePartnerIds.length}`);
			console.log(`IDs de partners: ${uniquePartnerIds.slice(0, 10).join(', ')}${uniquePartnerIds.length > 10 ? '...' : ''}`);

			if (uniquePartnerIds.length === 0) {
				console.log('No hay partners para sincronizar en este lote');
				return 0;
			}

			// Obtener partners de Odoo
			const partners = await this.getPartnersData(objectClient, connection, uid, uniquePartnerIds);
			console.log(`Partners obtenidos de Odoo: ${partners?.length || 0}`);

			if (!Array.isArray(partners) || partners.length === 0) {
				console.log('No se obtuvieron datos de partners de Odoo');
				return 0;
			}

			let savedCount = 0;
			let updatedCount = 0;
			let errorCount = 0;

			for (const partner of partners) {
				try {
					// Verificar si ya existe antes de guardar
					const existingPartner = await this.partnersStgRepository.findOne({
						where: {
							odoo_id: partner.id,
							holding_id: connection.holding_id,
						},
					});

					// Guardar partner en base de datos
					await this.savePartnerToDatabase(partner, batchId, connection.holding_id);

					if (existingPartner) {
						updatedCount++;
					} else {
						savedCount++;
					}
				} catch (partnerProcessError) {
					console.error(`Error al procesar partner ${partner.id}:`, partnerProcessError);
					errorCount++;
				}
			}

			console.log(`Partners procesados: ${savedCount} nuevos, ${updatedCount} actualizados, ${errorCount} errores`);
			return savedCount + updatedCount; // Total procesados exitosamente
		} catch (error) {
			console.error('Error en syncPartnersFromCurrentBatch:', error);
			return 0;
		}
	}

	private async getPartnersData(
		objectClient: XmlRpcClientHelper,
		connection: OdooConnection,
		uid: number,
		partnerIds: number[]
	): Promise<OdooPartner[]> {
		return await objectClient.methodCall('execute_kw', [
			connection.database_name,
			uid,
			connection.api_key,
			'res.partner',
			'read',
			[partnerIds],
			{
				fields: [
					'id',
					'name',
					'display_name',
					'ref',
					'active',
					'email',
					'phone',
					'mobile',
					'website',
					'email_normalized',
					'phone_sanitized',
					'street',
					'street2',
					'city',
					'zip',
					'state_id',
					'country_id',
					'contact_address_complete',
					'vat',
					'commercial_partner_id',
					'is_company',
					'company_type',
					'category_id',
					'industry_id',
					'function',
					'title',
					'create_date',
					'write_date',
					'create_uid',
					'write_uid',
					'l10n_cl_activity_description',
				],
			},
		]);
	}

	private generateBatchId(): string {
		return randomUUID();
	}

	private isValidUUID(uuid: string): boolean {
		const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
		return uuidRegex.test(uuid);
	}

	private async getOdooConnection(connectionId: string): Promise<OdooConnection> {
		// Por ahora usar configuración hardcodeada, pero en el futuro se puede obtener desde base de datos
		// basado en el connectionId

		// Configuración de producción para Aisapira
		if (connectionId === 'aisapira_prod' || connectionId === 'default') {
			return {
				id: connectionId,
				url: 'https://devops-simpliroute-simpli-odoo.odoo.com',
				database_name: 'devops-simpliroute-simpli-odoo-main-3154763',
				username: 'domi@aisapira.com',
				api_key: 'f6cd0ff4a0d3954d229ac4dbbb0fc8fa4e54c477',
				holding_id: '05583c6e-9364-4672-a610-0744324e44b4', // UUID válido para Aisapira
			};
		}

		// Configuración de desarrollo/testing (si se necesita)
		if (connectionId === 'dev' || connectionId === 'test') {
			return {
				id: connectionId,
				url: 'https://devops-simpliroute-simpli-odoo.odoo.com',
				database_name: 'devops-simpliroute-simpli-odoo-main-3154763',
				username: 'domi@aisapira.com',
				api_key: 'f6cd0ff4a0d3954d229ac4dbbb0fc8fa4e54c477',
				holding_id: '05583c6e-9364-4672-a610-0744324e44b4', // UUID válido para Aisapira
			};
		}

		// Si no se encuentra la configuración, usar la de producción por defecto
		console.warn(`Configuración no encontrada para connectionId: ${connectionId}, usando configuración por defecto`);
		return {
			id: connectionId,
			url: 'https://devops-simpliroute-simpli-odoo.odoo.com',
			database_name: 'devops-simpliroute-simpli-odoo-main-3154763',
			username: 'domi@aisapira.com',
			api_key: 'f6cd0ff4a0d3954d229ac4dbbb0fc8fa4e54c477',
			holding_id: '05583c6e-9364-4672-a610-0744324e44b4', // UUID válido para Aisapira
		};
	}

	/**
	 * Guarda una factura en la tabla de staging
	 */
	private async saveInvoiceToDatabase(invoice: OdooInvoice, batchId: string, holdingId: string, syncSessionId?: string): Promise<OdooInvoicesStg> {
		// Verificar si ya existe la factura
		const existingInvoice = await this.invoicesStgRepository.findOne({
			where: {
				odoo_id: invoice.id,
				holding_id: holdingId,
			},
		});

		if (existingInvoice) {
			// Actualizar factura existente
			existingInvoice.raw_data = invoice;
			existingInvoice.sync_batch_id = batchId;
			existingInvoice.batch_id = batchId;
			existingInvoice.sync_session_id = syncSessionId;
			existingInvoice.processing_status = 'pending';
			existingInvoice.updated_at = new Date();

			return await this.invoicesStgRepository.save(existingInvoice);
		} else {
			// Crear nueva factura
			const invoiceStg = new OdooInvoicesStg();
			invoiceStg.odoo_id = invoice.id;
			invoiceStg.holding_id = holdingId;
			invoiceStg.raw_data = invoice;
			invoiceStg.sync_batch_id = batchId;
			invoiceStg.batch_id = batchId;
			invoiceStg.sync_session_id = syncSessionId;
			invoiceStg.processing_status = 'pending';

			return await this.invoicesStgRepository.save(invoiceStg);
		}
	}

	/**
	 * Guarda una línea de factura en la tabla de staging
	 */
	private async saveLineToDatabase(
		line: OdooInvoiceLine,
		invoiceStagingId: string,
		batchId: string,
		holdingId: string,
		syncSessionId?: string
	): Promise<OdooInvoiceLinesStg> {
		// Verificar si ya existe la línea
		const existingLine = await this.invoiceLinesStgRepository.findOne({
			where: {
				odoo_line_id: line.id,
				holding_id: holdingId,
			},
		});

		if (existingLine) {
			// Actualizar línea existente
			existingLine.odoo_invoice_id = line.move_id[0];
			existingLine.invoice_staging_id = invoiceStagingId;
			existingLine.raw_data = line;
			existingLine.batch_id = batchId;
			existingLine.sync_session_id = syncSessionId;
			existingLine.processing_status = 'pending';
			existingLine.updated_at = new Date();

			return await this.invoiceLinesStgRepository.save(existingLine);
		} else {
			// Crear nueva línea
			const lineStg = new OdooInvoiceLinesStg();
			lineStg.odoo_line_id = line.id;
			lineStg.odoo_invoice_id = line.move_id[0];
			lineStg.invoice_staging_id = invoiceStagingId;
			lineStg.holding_id = holdingId;
			lineStg.raw_data = line;
			lineStg.batch_id = batchId;
			lineStg.sync_session_id = syncSessionId;
			lineStg.processing_status = 'pending';

			return await this.invoiceLinesStgRepository.save(lineStg);
		}
	}

	/**
	 * Guarda un partner en la tabla de staging
	 */
	private async savePartnerToDatabase(partner: OdooPartner, batchId: string, holdingId: string): Promise<OdooPartnersStg> {
		// Verificar si el partner ya existe para evitar duplicados
		const existingPartner = await this.partnersStgRepository.findOne({
			where: {
				odoo_id: partner.id,
				holding_id: holdingId,
			},
		});

		if (existingPartner) {
			// Actualizar el partner existente
			console.log(`Actualizando partner existente: ${partner.id} (${partner.name})`);
			existingPartner.raw_data = partner;
			existingPartner.sync_batch_id = batchId;
			existingPartner.updated_at = new Date();
			return await this.partnersStgRepository.save(existingPartner);
		}

		// Crear nuevo partner
		console.log(`Creando nuevo partner: ${partner.id} (${partner.name})`);
		const partnerStg = new OdooPartnersStg();
		partnerStg.odoo_id = partner.id;
		partnerStg.holding_id = holdingId;
		partnerStg.raw_data = partner;
		partnerStg.sync_batch_id = batchId;
		partnerStg.processing_status = 'processed';

		const savedPartner = await this.partnersStgRepository.save(partnerStg);
		console.log(`Partner guardado exitosamente: ${partner.id}`);
		return savedPartner;
	}

	/**
	 * Obtiene las compañías desde Odoo
	 */
	async getCompanies(getCompaniesData: GetCompaniesDTO): Promise<CompaniesResult> {
		const { connection_id } = getCompaniesData;

		if (!connection_id) {
			throw new Error('connection_id es requerido');
		}

		try {
			// Obtener configuración de conexión
			const connection = await this.getOdooConnection(connection_id);

			console.log(`🏢 Obteniendo companies de Odoo para conexión: ${connection.url}`);

			// Crear clientes XML-RPC
			const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

			// Autenticar
			console.log('🔐 Autenticando con Odoo...');
			const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);

			if (!uid) {
				throw new Error('Falló la autenticación con Odoo');
			}

			console.log(`✅ Autenticado exitosamente. UID: ${uid}`);

			// Obtener companies de Odoo (res.company)
			console.log('🏢 Obteniendo companies de Odoo...');

			// Buscar todas las companies
			const companyIds = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'res.company',
				'search',
				[[]], // Sin filtros, obtener todas las companies
			]);

			console.log(`📋 Encontradas ${companyIds.length} companies en Odoo`);

			// Obtener detalles de las companies
			const companies: OdooCompany[] = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'res.company',
				'read',
				[companyIds],
				{
					fields: [
						'id',
						'name',
						'display_name',
						'vat',
						'country_id',
						'currency_id',
						'email',
						'phone',
						'website',
						'street',
						'city',
						'state_id',
						'zip',
						'partner_id',
					],
				},
			]);

			console.log(`✅ Obtenidos detalles de ${companies.length} companies`);

			// Obtener companies existentes en Sapira para mostrar mapeos actuales
			const sapiraCompanies: SapiraCompany[] = await this.getSapiraCompanies(connection.holding_id);

			// Formatear las companies de Odoo
			const formattedOdooCompanies = companies.map((company) => ({
				id: company.id,
				name: company.name,
				display_name: company.display_name,
				vat: company.vat,
				country: Array.isArray(company.country_id) ? company.country_id[1] : null,
				currency: Array.isArray(company.currency_id) ? company.currency_id[1] : null,
				email: company.email,
				phone: company.phone,
				website: company.website,
				address: [company.street, company.city, company.zip].filter(Boolean).join(', '),
				state: Array.isArray(company.state_id) ? company.state_id[1] : null,
				partner_id: company.partner_id,
			}));

			return {
				success: true,
				message: `Se obtuvieron ${companies.length} compañías de Odoo exitosamente`,
				odoo_companies: formattedOdooCompanies,
				sapira_companies: sapiraCompanies,
				connection_info: {
					id: connection.id,
					server_url: connection.url,
					database_name: connection.database_name,
					holding_id: connection.holding_id,
				},
			};
		} catch (error) {
			console.error('❌ Error en getCompanies:', error);
			throw new Error(`Error obteniendo compañías de Odoo: ${error.message}`);
		}
	}

	/**
	 * Obtiene las compañías de Sapira para un holding específico
	 */
	private async getSapiraCompanies(holdingId: string): Promise<SapiraCompany[]> {
		try {
			console.log(`🏢 Obteniendo companies de Sapira para holding: ${holdingId}`);

			// Consultar companies de Sapira usando TypeORM
			const sapiraCompanies = await this.companiesRepository.find({
				where: { holding_id: holdingId },
				select: ['id', 'holding_name', 'legal_name', 'odoo_integration_id', 'holding_id'],
			});

			console.log(`✅ Encontradas ${sapiraCompanies.length} companies de Sapira`);

			// Mapear a la interfaz SapiraCompany
			return sapiraCompanies.map((company) => ({
				id: company.id,
				holding_name: company.holding_name,
				legal_name: company.legal_name || '',
				odoo_integration_id: company.odoo_integration_id || null,
				holding_id: company.holding_id,
			}));
		} catch (error) {
			console.error('❌ Error obteniendo companies de Sapira:', error);
			return [];
		}
	}

	/**
	 * Obtiene los productos desde Odoo
	 */
	async getProducts(getProductsData: GetProductsDTO): Promise<ProductsResult> {
		const { connection_id } = getProductsData;

		if (!connection_id) {
			throw new Error('connection_id es requerido');
		}

		try {
			// Obtener configuración de conexión
			const connection = await this.getOdooConnection(connection_id);

			console.log(`🛍️ Obteniendo productos de Odoo para conexión: ${connection.url}`);

			// Crear clientes XML-RPC
			const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

			// Autenticar
			console.log('🔐 Autenticando con Odoo...');
			const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);

			if (!uid) {
				throw new Error('Falló la autenticación con Odoo');
			}

			console.log(`✅ Autenticado exitosamente. UID: ${uid}`);

			// Obtener productos de Odoo (product.template)
			console.log('🛍️ Obteniendo productos de Odoo...');

			// Buscar productos con límite para evitar sobrecarga
			const productIds = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'product.template',
				'search',
				[[]], // Sin filtros para evitar el TypeError
				{
					limit: 100, // Limitar a 100 productos
					offset: 0,
				},
			]);

			console.log(`📋 Encontrados ${productIds.length} productos en Odoo`);

			// Obtener detalles de los productos
			const products: OdooProduct[] = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'product.template',
				'read',
				[productIds],
				{
					fields: [
						'id',
						'name',
						'display_name',
						'default_code',
						'barcode',
						'list_price',
						'standard_price',
						'uom_id',
						'uom_po_id',
						'categ_id',
						'type',
						'sale_ok',
						'purchase_ok',
						'active',
						'taxes_id',
						'supplier_taxes_id',
						'description',
						'description_sale',
						'description_purchase',
					],
				},
			]);

			console.log(`✅ Obtenidos detalles de ${products.length} productos`);

			// Filtrar solo productos activos en el lado del cliente
			const activeProducts = products.filter((product) => product.active === true);
			console.log(`🔍 Filtrados ${activeProducts.length} productos activos de ${products.length} totales`);

			// Obtener todos los tax IDs únicos de los productos
			const allTaxIds = new Set<number>();
			activeProducts.forEach((product) => {
				// Normalizar taxes_id
				const taxIds = Array.isArray(product.taxes_id) ? product.taxes_id : [];
				taxIds.forEach((taxId) => {
					if (typeof taxId === 'number') {
						allTaxIds.add(taxId);
					}
				});

				// Normalizar supplier_taxes_id
				const supplierTaxIds = Array.isArray(product.supplier_taxes_id) ? product.supplier_taxes_id : [];
				supplierTaxIds.forEach((taxId) => {
					if (typeof taxId === 'number') {
						allTaxIds.add(taxId);
					}
				});
			});

			console.log(`🏷️ Obteniendo detalles de ${allTaxIds.size} taxes únicos...`);

			// Obtener detalles de todos los taxes
			const taxDetails = await this.getTaxDetails(Array.from(allTaxIds), objectClient, connection, uid);
			console.log(`🔍 TaxDetails Map size: ${taxDetails.size}`);

			// Obtener productos existentes en Sapira para mostrar mapeos actuales
			const sapiraProducts: SapiraProduct[] = await this.getSapiraProducts(connection.holding_id);

			// Formatear los productos de Odoo (solo los activos)
			const formattedOdooProducts = activeProducts.map((product) => ({
				id: product.id,
				name: product.name,
				display_name: product.display_name,
				product_code: typeof product.default_code === 'string' ? product.default_code : null,
				barcode: typeof product.barcode === 'string' ? product.barcode : null,
				list_price: product.list_price,
				standard_price: product.standard_price,
				unit_of_measure: Array.isArray(product.uom_id) ? product.uom_id[1] : null,
				purchase_unit: Array.isArray(product.uom_po_id) ? product.uom_po_id[1] : null,
				category: Array.isArray(product.categ_id) ? product.categ_id[1] : null,
				product_type: product.type,
				can_be_sold: product.sale_ok,
				can_be_purchased: product.purchase_ok,
				is_active: product.active,
				tax_ids: Array.isArray(product.taxes_id) ? product.taxes_id.filter((id) => typeof id === 'number') : [],
				supplier_tax_ids: Array.isArray(product.supplier_taxes_id) ? product.supplier_taxes_id.filter((id) => typeof id === 'number') : [],
				tax_details: Array.isArray(product.taxes_id)
					? product.taxes_id
							.filter((id) => typeof id === 'number')
							.map((taxId) => taxDetails.get(taxId))
							.filter(Boolean)
					: [],
				supplier_tax_details: Array.isArray(product.supplier_taxes_id)
					? product.supplier_taxes_id
							.filter((id) => typeof id === 'number')
							.map((taxId) => taxDetails.get(taxId))
							.filter(Boolean)
					: [],
				description: typeof product.description === 'string' ? product.description : null,
				sales_description: typeof product.description_sale === 'string' ? product.description_sale : null,
				purchase_description: typeof product.description_purchase === 'string' ? product.description_purchase : null,
			}));

			return {
				success: true,
				message: `Se obtuvieron ${activeProducts.length} productos activos de Odoo exitosamente`,
				odoo_products: formattedOdooProducts,
				sapira_products: sapiraProducts,
				connection_info: {
					id: connection.id,
					server_url: connection.url,
					database_name: connection.database_name,
					holding_id: connection.holding_id,
				},
			};
		} catch (error) {
			console.error('❌ Error en getProducts:', error);
			throw new Error(`Error obteniendo productos de Odoo: ${error.message}`);
		}
	}

	/**
	 * Obtiene los productos de Sapira para un holding específico
	 */
	private async getSapiraProducts(holdingId: string): Promise<SapiraProduct[]> {
		try {
			console.log(`🛍️ Obteniendo productos de Sapira para holding: ${holdingId}`);

			// Consultar productos de Sapira usando TypeORM (solo campos existentes)
			const sapiraProducts = await this.productsRepository.find({
				where: { holding_id: holdingId },
				select: [
					'id',
					'holding_id',
					'product_code',
					'name',
					'is_recurring',
					'default_currency',
					'default_price',
					'created_at',
					'salesforce_product_id',
				],
			});

			console.log(`✅ Encontrados ${sapiraProducts.length} productos de Sapira`);

			// Mapear a la interfaz SapiraProduct
			return sapiraProducts.map((product) => ({
				id: product.id,
				holding_id: product.holding_id || null,
				product_code: product.product_code || null,
				name: product.name || null,
				is_recurring: product.is_recurring || null,
				default_currency: product.default_currency || null,
				default_price: product.default_price || null,
				created_at: product.created_at,
				salesforce_product_id: product.salesforce_product_id || null,
				odoo_product_id: null, // Campo no existe en la tabla actual
				odoo_tax_id: null, // Campo no existe en la tabla actual
			}));
		} catch (error) {
			console.error('❌ Error obteniendo productos de Sapira:', error);
			return [];
		}
	}

	/**
	 * Obtiene los detalles completos de los taxes desde Odoo
	 */
	private async getTaxDetails(taxIds: number[], objectClient: any, connection: OdooConnection, uid: number): Promise<Map<number, any>> {
		const taxDetailsMap = new Map();

		if (taxIds.length === 0) {
			return taxDetailsMap;
		}

		try {
			console.log(`🏷️ Consultando detalles de ${taxIds.length} taxes en Odoo...`);

			// Obtener detalles de los taxes
			const taxes: OdooTax[] = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.tax',
				'read',
				[taxIds],
				{
					fields: ['id', 'name', 'description', 'amount', 'amount_type', 'type_tax_use', 'active'],
				},
			]);

			console.log(`✅ Obtenidos detalles de ${taxes.length} taxes`);

			// Formatear y mapear los taxes
			taxes.forEach((tax) => {
				const formattedTax = {
					id: tax.id,
					name: tax.name,
					description: typeof tax.description === 'string' ? tax.description : null,
					amount: tax.amount,
					amount_type: tax.amount_type,
					tax_use: tax.type_tax_use,
					is_active: tax.active,
				};
				taxDetailsMap.set(tax.id, formattedTax);
			});

			return taxDetailsMap;
		} catch (error) {
			console.error('❌ Error obteniendo detalles de taxes:', error);
			return taxDetailsMap;
		}
	}
}

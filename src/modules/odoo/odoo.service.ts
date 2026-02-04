import { randomUUID } from 'crypto';

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';
import { IntegrationLog } from '@/databases/postgresql/entities/integration-log.entity';

import {
	CountRecordsDTO,
	GetCompaniesDTO,
	GetCompaniesResponseDTO,
	GetProductsDTO,
	JobStatusResponseDTO,
	StartAsyncJobDTO,
	SyncInvoicesDTO,
} from './dtos/odoo.dto';
import { Company } from './entities/companies.entity';
import { OdooConnection } from './entities/odoo-connection.entity';
import { OdooInvoiceLinesStg } from './entities/odoo-invoice-lines-stg.entity';
import { OdooInvoicesStg } from './entities/odoo-invoices-stg.entity';
import { OdooPartnersStg } from './entities/odoo-partners-stg.entity';
import { Product } from './entities/products.entity';
import { XmlRpcClientHelper } from './helpers/xml-rpc-client.helper';
import {
	EstimateResult,
	OdooCompany,
	OdooConnectionConfig,
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
import { InvoiceProcessingService } from './invoice-processing.service';
import { OdooProvider } from './odoo.provider';

@Injectable()
export class OdooService {
	constructor(
		private readonly odooProvider: OdooProvider,
		private readonly invoiceProcessingService: InvoiceProcessingService,
		@InjectRepository(OdooConnection)
		private readonly odooConnectionRepository: Repository<OdooConnection>,
		@InjectRepository(OdooInvoicesStg)
		private readonly invoicesStgRepository: Repository<OdooInvoicesStg>,
		@InjectRepository(OdooInvoiceLinesStg)
		private readonly invoiceLinesStgRepository: Repository<OdooInvoiceLinesStg>,
		@InjectRepository(OdooPartnersStg)
		private readonly partnersStgRepository: Repository<OdooPartnersStg>,
		@InjectRepository(Company)
		private readonly companiesRepository: Repository<Company>,
		@InjectRepository(Product)
		private readonly productsRepository: Repository<Product>,
		@InjectRepository(IntegrationLog)
		private readonly integrationLogRepository: Repository<IntegrationLog>,
		@InjectRepository(ClientEntity)
		private readonly clientEntitiesRepository: Repository<ClientEntity>
	) {}

	/**
	 * Obtiene las compañías desde Odoo
	 */
	async getCompanies(getCompaniesData: GetCompaniesDTO): Promise<GetCompaniesResponseDTO> {
		const { connection_id, holding_id } = getCompaniesData;

		if (!connection_id) {
			throw new Error('connection_id es requerido');
		}

		if (!holding_id) {
			throw new Error('holding_id es requerido');
		}

		try {
			// Obtener configuración de conexión
			const connection = await this.getOdooConnection(connection_id);

			// Crear clientes XML-RPC
			const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

			// Autenticar
			const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);

			if (!uid) {
				throw new Error('Falló la autenticación con Odoo');
			}

			// Buscar todas las companies
			const companyIds = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'res.company',
				'search',
				[[]], // Sin filtros, obtener todas las companies
			]);

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
						'account_sale_tax_id',
						'account_purchase_tax_id',
						'account_fiscal_country_id',
						'tax_calculation_rounding_method',
						'tax_exigibility',
					],
				},
			]);

			// Obtener companies existentes en Sapira para mostrar mapeos actuales
			const sapiraCompanies: SapiraCompany[] = await this.getSapiraCompanies(holding_id);

			// Obtener detalles de impuestos para las companies que tienen configurados
			const taxDetails = await this.getTaxDetailsForCompanies(companies, objectClient, connection, uid);

			// Formatear las companies de Odoo
			const formattedOdooCompanies = companies.map((company) => {
				const saleTaxDetail = taxDetails.get(
					company.account_sale_tax_id
						? Array.isArray(company.account_sale_tax_id)
							? company.account_sale_tax_id[0]
							: company.account_sale_tax_id
						: null
				);
				const purchaseTaxDetail = taxDetails.get(
					company.account_purchase_tax_id
						? Array.isArray(company.account_purchase_tax_id)
							? company.account_purchase_tax_id[0]
							: company.account_purchase_tax_id
						: null
				);

				return {
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
					default_sale_tax_id: Array.isArray(company.account_sale_tax_id) ? company.account_sale_tax_id[0] : company.account_sale_tax_id,
					default_sale_tax_name: Array.isArray(company.account_sale_tax_id) ? company.account_sale_tax_id[1] : null,
					default_sale_tax_percentage: saleTaxDetail?.amount || null,
					default_sale_tax_type: saleTaxDetail?.amount_type || null,
					default_purchase_tax_id: Array.isArray(company.account_purchase_tax_id)
						? company.account_purchase_tax_id[0]
						: company.account_purchase_tax_id,
					default_purchase_tax_name: Array.isArray(company.account_purchase_tax_id) ? company.account_purchase_tax_id[1] : null,
					default_purchase_tax_percentage: purchaseTaxDetail?.amount || null,
					default_purchase_tax_type: purchaseTaxDetail?.amount_type || null,
					fiscal_country_id: Array.isArray(company.account_fiscal_country_id)
						? company.account_fiscal_country_id[0]
						: company.account_fiscal_country_id,
					fiscal_country_name: Array.isArray(company.account_fiscal_country_id) ? company.account_fiscal_country_id[1] : null,
					tax_calculation_rounding: company.tax_calculation_rounding_method,
					use_cash_basis: company.tax_exigibility,
				};
			});

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
	 * Obtiene detalles de impuestos para las companies
	 */
	private async getTaxDetailsForCompanies(
		companies: OdooCompany[],
		objectClient: any,
		connection: OdooConnectionConfig,
		uid: number
	): Promise<Map<number, any>> {
		// Recopilar todos los IDs de impuestos únicos de las companies
		const taxIds = new Set<number>();

		companies.forEach((company) => {
			// Agregar impuesto de venta si existe
			if (company.account_sale_tax_id) {
				const saleId = Array.isArray(company.account_sale_tax_id) ? company.account_sale_tax_id[0] : company.account_sale_tax_id;
				if (typeof saleId === 'number') {
					taxIds.add(saleId);
				}
			}

			// Agregar impuesto de compra si existe
			if (company.account_purchase_tax_id) {
				const purchaseId = Array.isArray(company.account_purchase_tax_id)
					? company.account_purchase_tax_id[0]
					: company.account_purchase_tax_id;
				if (typeof purchaseId === 'number') {
					taxIds.add(purchaseId);
				}
			}
		});

		// Si no hay impuestos, retornar mapa vacío
		if (taxIds.size === 0) {
			return new Map();
		}

		try {
			// Consultar detalles de todos los impuestos
			const taxes = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.tax',
				'read',
				[Array.from(taxIds)],
				{
					fields: ['id', 'name', 'amount', 'amount_type', 'type_tax_use', 'active', 'description', 'invoice_label'],
				},
			]);

			// Crear mapa de ID -> detalles del impuesto
			const taxDetailsMap = new Map();
			taxes.forEach((tax: any) => {
				taxDetailsMap.set(tax.id, tax);
			});

			return taxDetailsMap;
		} catch (error) {
			console.error('❌ Error obteniendo detalles de impuestos:', error);
			// Retornar mapa vacío en caso de error para no fallar toda la consulta
			return new Map();
		}
	}

	/**
	 * Obtiene las compañías de Sapira para un holding específico
	 */
	private async getSapiraCompanies(holdingId: string): Promise<SapiraCompany[]> {
		try {
			// Consultar companies de Sapira usando TypeORM
			const sapiraCompanies = await this.companiesRepository.find({
				where: { holding_id: holdingId },
				select: ['id', 'holding_name', 'legal_name', 'odoo_integration_id', 'holding_id'],
			});

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
	 * Mapea compañías de Sapira con compañías de Odoo
	 * Maneja correctamente los duplicados reasignando el odoo_integration_id
	 */
	async mapCompanies(mapData: {
		holding_id: string;
		mappings: Array<{ sapira_company_id: string; odoo_company_id: number | null; tax_rate?: number | null }>;
	}): Promise<{
		success: boolean;
		message: string;
		updated_count: number;
		cleared_count: number;
	}> {
		const { holding_id, mappings } = mapData;

		try {
			let updatedCount = 0;
			let clearedCount = 0;

			// Procesar cada mapeo en una transacción
			await this.companiesRepository.manager.transaction(async (transactionalEntityManager) => {
				// Primero, limpiar todos los odoo_integration_id que se van a reasignar
				// para evitar conflictos de constraint único
				const odooIdsToReassign = mappings.filter((m) => m.odoo_company_id !== null).map((m) => m.odoo_company_id);

				if (odooIdsToReassign.length > 0) {
					// Limpiar compañías que tienen estos odoo_integration_id pero no están en el mapeo actual
					const companiesToClear = await transactionalEntityManager.find(Company, {
						where: {
							holding_id: holding_id,
							odoo_integration_id: In(odooIdsToReassign),
						},
					});

					for (const company of companiesToClear) {
						// Solo limpiar si no está en el mapeo actual
						const isInCurrentMapping = mappings.some(
							(m) => m.sapira_company_id === company.id && m.odoo_company_id === company.odoo_integration_id
						);

						if (!isInCurrentMapping) {
							await transactionalEntityManager.update(
								Company,
								{ id: company.id },
								{
									odoo_integration_id: null,
									tax_rate: null,
								}
							);
							clearedCount++;
						}
					}
				}

				// Ahora aplicar los nuevos mapeos
				for (const mapping of mappings) {
					const updateData: Partial<Company> = {};

					if (mapping.odoo_company_id === null) {
						// Limpiar mapeo
						updateData.odoo_integration_id = null;
						updateData.tax_rate = null;
						clearedCount++;
					} else {
						// Asignar nuevo mapeo
						updateData.odoo_integration_id = mapping.odoo_company_id;

						// Actualizar tax_rate si se proporciona
						if (mapping.tax_rate !== undefined && mapping.tax_rate !== null) {
							updateData.tax_rate = mapping.tax_rate;
						}
						updatedCount++;
					}

					await transactionalEntityManager.update(
						Company,
						{
							id: mapping.sapira_company_id,
							holding_id: holding_id,
						},
						updateData
					);
				}
			});

			return {
				success: true,
				message: `Mapeos actualizados correctamente. ${updatedCount} compañías mapeadas, ${clearedCount} compañías limpiadas.`,
				updated_count: updatedCount,
				cleared_count: clearedCount,
			};
		} catch (error) {
			console.error('❌ Error mapeando compañías:', error);
			throw new Error(`Error al mapear compañías: ${error.message}`);
		}
	}

	async countRecords(countData: CountRecordsDTO): Promise<EstimateResult> {
		const { connection_id, date_from, date_to } = countData;

		if (!connection_id) {
			throw new Error('connection_id es requerido');
		}

		// Obtener configuración de conexión
		const connection = await this.getOdooConnection(connection_id);

		// Crear clientes XML-RPC
		const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
		const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

		// Autenticación
		let uid: number;
		try {
			uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);

			if (!uid) {
				throw new Error('Error de autenticación con Odoo - UID no recibido');
			}
		} catch (authError) {
			throw new Error(`Error de autenticación con Odoo: ${authError.message}`);
		}

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

		// Consulta 3: Contar partners únicos en las facturas
		let totalPartners = 0;
		if (totalInvoices > 0) {
			// Obtener todos los IDs de facturas que cumplen los criterios
			const invoiceIds = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.move',
				'search',
				[invoicesSearchDomain],
			]);

			if (Array.isArray(invoiceIds) && invoiceIds.length > 0) {
				// Obtener los partner_ids únicos de estas facturas
				const invoicesData = await objectClient.methodCall('execute_kw', [
					connection.database_name,
					uid,
					connection.api_key,
					'account.move',
					'read',
					[invoiceIds],
					{ fields: ['partner_id'] },
				]);

				if (Array.isArray(invoicesData)) {
					// Extraer partner_ids únicos
					const uniquePartnerIds = new Set();
					invoicesData.forEach((invoice: any) => {
						if (invoice.partner_id && Array.isArray(invoice.partner_id) && invoice.partner_id.length > 0) {
							uniquePartnerIds.add(invoice.partner_id[0]); // partner_id es [id, name]
						}
					});
					totalPartners = uniquePartnerIds.size;
				}
			}
		}

		// Consulta 4: Encontrar facturas sin líneas de producto
		let invoicesWithoutProductLines = 0;
		let invoicesWithoutProductLinesNames: string[] = [];

		if (totalInvoices > 0) {
			// Buscar facturas que NO tienen ninguna línea con display_type = 'product'
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
			total_partners: totalPartners,
			total_invoices_without_product_lines: invoicesWithoutProductLines,
			invoices_without_product_lines_names: invoicesWithoutProductLinesNames,
			message: `Conteo: ${totalLines} líneas de ${totalInvoices} facturas de ${totalPartners} partners encontradas`,
		};
	}

	/**
	 * @description Sincronizacion de facturas antigua desde Odoo
	 * @param syncData Datos de sincronización
	 * @returns Resultado de la sincronización
	 */
	async syncInvoices(syncData: SyncInvoicesDTO): Promise<SyncResult | EstimateResult> {
		const { connection_id, limit = 60, offset = 0, date_from, date_to, sync_session_id } = syncData;

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

		let uid: number;
		try {
			uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);

			if (!uid) {
				throw new Error('Error de autenticación con Odoo - UID no recibido');
			}
		} catch (authError) {
			console.error('Error durante autenticación:', authError);
			throw new Error(`Error de autenticación con Odoo: ${authError.message}`);
		}

		return await this.performInvoiceSync(objectClient, connection, uid, limit, offset, date_from, date_to, validSyncSessionId);
	}

	private async performInvoiceSync(
		objectClient: XmlRpcClientHelper,
		connection: OdooConnectionConfig,
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
		const {
			saved_invoices: savedInvoices,
			saved_lines: savedLines,
			errors,
		} = await this.processInvoicesWithLines(invoices, linesData, objectClient, connection, uid, batchId, syncSessionId);

		// Sincronizar partners del lote actual
		const { partners_synced: savedPartners } = await this.syncPartnersFromCurrentBatch(invoices, connection, uid, objectClient);

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
		connection: OdooConnectionConfig,
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

	private async processInvoicesWithLines(
		invoices: OdooInvoice[],
		linesData: any[],
		objectClient: XmlRpcClientHelper,
		connection: OdooConnectionConfig,
		uid: number,
		batchId: string,
		syncSessionId?: string
	): Promise<{ saved_invoices: number; saved_lines: number; saved_partners: number; errors: number }> {
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

		return { saved_invoices: savedInvoices, saved_lines: savedLines, saved_partners: 0, errors: errors };
	}

	private async getInvoiceLinesData(
		objectClient: XmlRpcClientHelper,
		connection: OdooConnectionConfig,
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
		connection: OdooConnectionConfig,
		uid: number,
		objectClient: XmlRpcClientHelper
	): Promise<{ partners_synced: number }> {
		try {
			const batchId = randomUUID();

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

			if (uniquePartnerIds.length === 0) {
				return { partners_synced: 0 };
			}

			// Obtener partners de Odoo
			const partners = await this.getPartnersData(objectClient, connection, uid, uniquePartnerIds);

			if (!Array.isArray(partners) || partners.length === 0) {
				return { partners_synced: 0 };
			}

			let savedCount = 0;
			let updatedCount = 0;

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
				}
			}

			return { partners_synced: savedCount + updatedCount };
		} catch (error) {
			console.error('Error en syncPartnersFromCurrentBatch:', error);
			return { partners_synced: 0 };
		}
	}

	private async getPartnersData(
		objectClient: XmlRpcClientHelper,
		connection: OdooConnectionConfig,
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

	private async getOdooConnection(connectionId: string): Promise<OdooConnectionConfig> {
		try {
			let dbConnection: OdooConnection | null = null;

			if (this.isValidUUID(connectionId)) {
				dbConnection = await this.odooConnectionRepository.findOne({
					where: { id: connectionId, is_active: true },
				});
			} else {
				dbConnection = await this.odooConnectionRepository.findOne({
					where: { name: connectionId, is_active: true },
				});
			}

			if (dbConnection) {
				return {
					id: dbConnection.id,
					url: dbConnection.url,
					database_name: dbConnection.database_name,
					username: dbConnection.username || '',
					api_key: dbConnection.api_key,
					holding_id: dbConnection.holding_id,
				};
			}

			throw new Error(`Conexión Odoo no encontrada o inactiva para connectionId: ${connectionId}`);
		} catch (error) {
			console.error('Error obteniendo conexión Odoo desde BD:', error);
			throw new Error(`No se pudo obtener la conexión Odoo para connectionId: ${connectionId}. ${error.message}`);
		}
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
			existingInvoice.raw_data = invoice;
			existingInvoice.sync_batch_id = batchId;
			existingInvoice.batch_id = batchId;
			existingInvoice.sync_session_id = syncSessionId;
			existingInvoice.processing_status = 'processed';
			existingInvoice.updated_at = new Date();
			return await this.invoicesStgRepository.save(existingInvoice);
		} else {
			const invoiceStg = new OdooInvoicesStg();
			invoiceStg.odoo_id = invoice.id;
			invoiceStg.holding_id = holdingId;
			invoiceStg.raw_data = invoice;
			invoiceStg.sync_batch_id = batchId;
			invoiceStg.batch_id = batchId;
			invoiceStg.sync_session_id = syncSessionId;
			invoiceStg.processing_status = 'processed';
			return await this.invoicesStgRepository.save(invoiceStg);
		}
	}

	/**
	 * Guarda una línea de factura en la tabla de staging
	 */
	private async saveLineToDatabase(
		line: OdooInvoiceLine,
		invoiceStagingId: string | null,
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
			// Actualizar línea existente solo si no estamos en modo async separado
			if (invoiceStagingId) {
				existingLine.invoice_staging_id = invoiceStagingId;
			}
			existingLine.odoo_invoice_id = line.move_id[0];
			existingLine.raw_data = line;
			existingLine.batch_id = batchId;
			existingLine.sync_session_id = syncSessionId;
			existingLine.processing_status = 'processed';
			existingLine.updated_at = new Date();

			return await this.invoiceLinesStgRepository.save(existingLine);
		} else {
			// Crear nueva línea solo si tenemos invoice_staging_id válido
			if (!invoiceStagingId) {
				throw new Error(`No se puede crear línea ${line.id} sin invoice_staging_id válido en modo async separado`);
			}

			const lineStg = new OdooInvoiceLinesStg();
			lineStg.odoo_line_id = line.id;
			lineStg.odoo_invoice_id = line.move_id[0];
			lineStg.invoice_staging_id = invoiceStagingId;
			lineStg.holding_id = holdingId;
			lineStg.raw_data = line;
			lineStg.batch_id = batchId;
			lineStg.sync_session_id = syncSessionId;
			lineStg.processing_status = 'processed';

			return await this.invoiceLinesStgRepository.save(lineStg);
		}
	}

	/**
	 * Guarda un partner en la tabla de staging
	 */
	private async savePartnerToDatabase(partner: OdooPartner, batchId: string, holdingId: string): Promise<OdooPartnersStg> {
		// 1. Verificar si el partner ya existe en staging
		const existingPartnerStg = await this.partnersStgRepository.findOne({
			where: {
				odoo_id: partner.id,
				holding_id: holdingId,
			},
		});

		// 2. Determinar el processing_status verificando client_entities
		const processingStatus = await this.determinePartnerProcessingStatus(partner, holdingId);

		if (existingPartnerStg) {
			existingPartnerStg.raw_data = partner;
			existingPartnerStg.sync_batch_id = batchId;
			existingPartnerStg.processing_status = processingStatus.status;
			existingPartnerStg.integration_notes = processingStatus.notes;
			existingPartnerStg.updated_at = new Date();
			return await this.partnersStgRepository.save(existingPartnerStg);
		}

		const partnerStg = new OdooPartnersStg();
		partnerStg.odoo_id = partner.id;
		partnerStg.holding_id = holdingId;
		partnerStg.raw_data = partner;
		partnerStg.sync_batch_id = batchId;
		partnerStg.processing_status = processingStatus.status;
		partnerStg.integration_notes = processingStatus.notes;
		return await this.partnersStgRepository.save(partnerStg);
	}

	/**
	 * Determina el processing_status de un partner verificando su existencia en client_entities
	 */
	private async determinePartnerProcessingStatus(
		partner: OdooPartner,
		holdingId: string
	): Promise<{ status: 'create' | 'update' | 'processed'; notes: string }> {
		try {
			const partnerVat = partner.vat ? String(partner.vat) : null;

			// 1. Si no hay VAT, buscar solo por odoo_partner_id
			if (!partnerVat || partnerVat === '') {
				const existingByOdooId = await this.clientEntitiesRepository.findOne({
					where: {
						odoo_partner_id: partner.id,
						holding_id: holdingId,
					},
				});

				if (existingByOdooId) {
					return {
						status: 'update',
						notes: 'Cliente existente sin VAT - marcado para actualización',
					};
				}

				return {
					status: 'create',
					notes: 'Partner sin VAT - marcado para creación',
				};
			}

			// 2. Buscar por VAT + Odoo ID (identificador único para clientes integrados)
			const existingByVatAndOdooId = await this.clientEntitiesRepository.findOne({
				where: {
					tax_id: partnerVat,
					holding_id: holdingId,
					odoo_partner_id: partner.id,
				},
			});

			if (existingByVatAndOdooId) {
				const hasChanges = this.hasPartnerChanges(partner, existingByVatAndOdooId);
				if (hasChanges) {
					return {
						status: 'update',
						notes: 'Cliente existente con cambios - marcado para actualización',
					};
				}
				return {
					status: 'processed',
					notes: 'Cliente idéntico al existente - marcado como procesado',
				};
			}

			// 3. Buscar solo por VAT (para clientes creados manualmente)
			const existingByVat = await this.clientEntitiesRepository.findOne({
				where: {
					tax_id: partnerVat,
					holding_id: holdingId,
				},
			});

			if (existingByVat) {
				return {
					status: 'update',
					notes: 'Cliente existente sin Odoo ID - marcado para vincular con Odoo',
				};
			}

			// 4. Búsqueda final por odoo_partner_id (para casos donde el VAT cambió)
			const existingByOdooId = await this.clientEntitiesRepository.findOne({
				where: {
					odoo_partner_id: partner.id,
					holding_id: holdingId,
				},
			});

			if (existingByOdooId) {
				return {
					status: 'update',
					notes: 'Cliente existente encontrado por Odoo ID - marcado para actualización',
				};
			}

			// 5. No existe - marcar para crear
			return {
				status: 'create',
				notes: 'Partner nuevo - marcado para creación',
			};
		} catch (error) {
			console.error(`Error determinando processing_status para partner ${partner.id}:`, error);
			return {
				status: 'create',
				notes: `Error en determinación de estado: ${error.message}`,
			};
		}
	}

	/**
	 * Verifica si hay cambios entre el partner de Odoo y el cliente existente
	 */
	private hasPartnerChanges(partner: OdooPartner, existingClient: any): boolean {
		try {
			// Comparar campos básicos
			const odooName = partner.name || '';
			const odooEmail = partner.email || '';
			const odooPhone = partner.phone || '';
			const odooStreet = partner.street || '';
			const odooCountry = Array.isArray(partner.country_id) ? partner.country_id[1] : '';

			const clientName = existingClient.legal_name || '';
			const clientEmail = existingClient.email || '';
			const clientPhone = existingClient.phone || '';
			const clientAddress = existingClient.legal_address || '';
			const clientCountry = existingClient.country || '';

			const changes: string[] = [];

			// Comparar y registrar cada campo
			if (odooName !== clientName) {
				changes.push(`📝 NOMBRE cambió:`);
				changes.push(`   Odoo:   "${odooName}"`);
				changes.push(`   Sapira: "${clientName}"`);
			}

			if (odooEmail !== clientEmail) {
				changes.push(`📧 EMAIL cambió:`);
				changes.push(`   Odoo:   "${odooEmail}"`);
				changes.push(`   Sapira: "${clientEmail}"`);
			}

			if (odooPhone !== clientPhone) {
				changes.push(`📞 TELÉFONO cambió:`);
				changes.push(`   Odoo:   "${odooPhone}"`);
				changes.push(`   Sapira: "${clientPhone}"`);
			}

			if (odooStreet !== clientAddress) {
				changes.push(`🏠 DIRECCIÓN cambió:`);
				changes.push(`   Odoo:   "${odooStreet}"`);
				changes.push(`   Sapira: "${clientAddress}"`);
			}

			if (odooCountry !== clientCountry) {
				changes.push(`🌍 PAÍS cambió:`);
				changes.push(`   Odoo:   "${odooCountry}"`);
				changes.push(`   Sapira: "${clientCountry}"`);
			}

			return changes.length > 0;
		} catch (error) {
			console.error('❌ Error comparando cambios:', error);
			return true; // En caso de error, asumir que hay cambios
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
			const connection = await this.getOdooConnection(connection_id);

			// Crear clientes XML-RPC
			const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

			// Autenticar
			const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);

			if (!uid) {
				throw new Error('Falló la autenticación con Odoo');
			}

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

			// Filtrar solo productos activos en el lado del cliente
			const activeProducts = products.filter((product) => product.active === true);

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

			// Obtener detalles de todos los taxes
			const taxDetails = await this.getTaxDetails(Array.from(allTaxIds), objectClient, connection, uid);

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
	private async getTaxDetails(taxIds: number[], objectClient: any, connection: OdooConnectionConfig, uid: number): Promise<Map<number, any>> {
		const taxDetailsMap = new Map();

		if (taxIds.length === 0) {
			return taxDetailsMap;
		}

		try {
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

	/**
	 * Inicia un job asíncrono para sincronización de facturas
	 */
	async startAsyncInvoiceSync(data: StartAsyncJobDTO): Promise<{
		success: boolean;
		message: string;
		jobs: {
			partners_job_id: string;
			invoice_lines_job_id: string;
			invoices_job_id: string;
		};
	}> {
		try {
			const baseMetadata = {
				start_date: data.start_date,
				end_date: data.end_date,
				initiated_at: new Date().toISOString(),
				sync_type: 'async',
				connection_id: data.connection_id,
			};

			// 1. Crear job para Partners (Clientes)
			const partnersLog = this.integrationLogRepository.create({
				holding_id: data.holding_id,
				source_table: 'res.partner',
				target_table: 'odoo_partners_stg',
				status: 'running',
				records_processed: 0,
				records_success: 0,
				records_failed: 0,
				started_at: new Date(),
				integration_type: 'partners_sync',
				progress_total: 0,
				connection_id: data.connection_id,
				metadata: { ...baseMetadata, entity_type: 'partners' },
			});

			// 2. Crear job para Invoice Lines (Líneas de Factura)
			const invoiceLinesLog = this.integrationLogRepository.create({
				holding_id: data.holding_id,
				source_table: 'account.move.line',
				target_table: 'odoo_invoice_lines_stg',
				status: 'running',
				records_processed: 0,
				records_success: 0,
				records_failed: 0,
				started_at: new Date(),
				integration_type: 'invoice_lines_sync',
				progress_total: 0,
				connection_id: data.connection_id,
				metadata: { ...baseMetadata, entity_type: 'invoice_lines' },
			});

			// 3. Crear job para Invoices (Facturas)
			const invoicesLog = this.integrationLogRepository.create({
				holding_id: data.holding_id,
				source_table: 'account.move',
				target_table: 'odoo_invoices_stg',
				status: 'running',
				records_processed: 0,
				records_success: 0,
				records_failed: 0,
				started_at: new Date(),
				integration_type: 'invoices_sync',
				progress_total: 0,
				connection_id: data.connection_id,
				metadata: { ...baseMetadata, entity_type: 'invoices' },
			});

			// Guardar los 3 jobs
			const [savedPartnersLog, savedInvoiceLinesLog, savedInvoicesLog] = await Promise.all([
				this.integrationLogRepository.save(partnersLog),
				this.integrationLogRepository.save(invoiceLinesLog),
				this.integrationLogRepository.save(invoicesLog),
			]);

			// Iniciar procesos asíncronos en secuencia para respetar dependencias de foreign keys
			// No usar await aquí para no bloquear la respuesta HTTP
			setImmediate(async () => {
				try {
					await this.processSequentialAsync(savedPartnersLog.id, savedInvoiceLinesLog.id, savedInvoicesLog.id, data);
				} catch (error) {
					console.error('❌ Error en procesos asíncronos secuenciales:', error);
				}
			});

			return {
				success: true,
				message: 'Jobs de sincronización iniciados exitosamente para Partners, Invoice Lines e Invoices',
				jobs: {
					partners_job_id: savedPartnersLog.id,
					invoice_lines_job_id: savedInvoiceLinesLog.id,
					invoices_job_id: savedInvoicesLog.id,
				},
			};
		} catch (error) {
			console.error('❌ Error iniciando jobs asíncronos:', error);
			throw new Error(`Error iniciando jobs: ${error.message}`);
		}
	}

	/**
	 * Procesa las entidades de forma secuencial para respetar dependencias de foreign keys
	 */
	private async processSequentialAsync(
		partnersJobId: string,
		invoiceLinesJobId: string,
		invoicesJobId: string,
		data: StartAsyncJobDTO
	): Promise<void> {
		try {
			// 1. Primero procesar partners (independientes)
			await this.processEntityAsync(partnersJobId, data, 'partners');
			await new Promise((resolve) => setTimeout(resolve, 2000));

			// 2. Luego procesar facturas (para crear los registros en odoo_invoices_stg)
			await this.processEntityAsync(invoicesJobId, data, 'invoices');
			await new Promise((resolve) => setTimeout(resolve, 2000));

			// 3. Finalmente procesar líneas (que referencian a las facturas)
			await this.processEntityAsync(invoiceLinesJobId, data, 'invoice_lines');
		} catch (error) {
			console.error('❌ Error en procesamiento secuencial:', error);
			throw error;
		}
	}

	/**
	 * Procesa partners específicamente para un job
	 */
	private async processPartnersForJob(jobId: string, data: StartAsyncJobDTO): Promise<void> {
		try {
			// Obtener configuración de conexión
			const connection = await this.getOdooConnection(data.connection_id);

			// Crear clientes XML-RPC
			const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

			// Autenticación
			const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);
			if (!uid) {
				throw new Error('Error de autenticación con Odoo');
			}

			// Primero buscar facturas del rango de fechas para obtener los partners relacionados
			const invoicesSearchDomain = [
				['state', '=', 'posted'],
				['move_type', 'in', ['out_invoice']],
				['payment_state', '!=', 'reversed'],
			];

			if (data.start_date) {
				invoicesSearchDomain.push(['invoice_date', '>=', data.start_date]);
			}
			if (data.end_date) {
				invoicesSearchDomain.push(['invoice_date', '<=', data.end_date]);
			}

			// Buscar todas las facturas del rango de fechas para extraer partners
			let allInvoiceIds: number[] = [];
			const invoiceLimit = 1000;
			let invoiceOffset = 0;

			while (true) {
				const invoiceIds = await objectClient.methodCall('execute_kw', [
					connection.database_name,
					uid,
					connection.api_key,
					'account.move',
					'search',
					[invoicesSearchDomain],
					{
						limit: invoiceLimit,
						offset: invoiceOffset,
						order: 'id desc',
					},
				]);

				if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
					break;
				}

				allInvoiceIds = allInvoiceIds.concat(invoiceIds);
				invoiceOffset += invoiceLimit;

				if (invoiceIds.length < invoiceLimit) {
					break;
				}
			}

			if (allInvoiceIds.length === 0) {
				console.log('No se encontraron facturas en el rango de fechas, no hay partners para procesar');
				return;
			}

			// Obtener datos básicos de facturas para extraer partner_ids
			const invoicesData = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.move',
				'read',
				[allInvoiceIds],
				{ fields: ['id', 'partner_id', 'commercial_partner_id'] },
			]);

			// Extraer IDs únicos de partners de las facturas
			const partnerIdsSet = new Set<number>();
			for (const invoice of invoicesData) {
				if (invoice.partner_id && Array.isArray(invoice.partner_id) && invoice.partner_id.length > 0) {
					partnerIdsSet.add(invoice.partner_id[0]);
				}
				if (invoice.commercial_partner_id && Array.isArray(invoice.commercial_partner_id) && invoice.commercial_partner_id.length > 0) {
					partnerIdsSet.add(invoice.commercial_partner_id[0]);
				}
			}

			const uniquePartnerIds = Array.from(partnerIdsSet);

			if (uniquePartnerIds.length === 0) {
				await this.updateJobStatus(jobId, 'completed', { progress_total: 0 });
				return;
			}

			// Establecer el total de registros a procesar
			await this.updateJobStatus(jobId, 'running', { progress_total: uniquePartnerIds.length });

			// Procesar partners en lotes
			const partnerBatchSize = 1;
			let totalProcessed = 0;
			let totalSaved = 0;
			let totalErrors = 0;

			for (let i = 0; i < uniquePartnerIds.length; i += partnerBatchSize) {
				const partnerBatch = uniquePartnerIds.slice(i, i + partnerBatchSize);

				// Obtener datos completos de partners usando el método existente
				const partnersData = await this.getPartnersData(objectClient, connection, uid, partnerBatch);

				// Procesar cada partner
				for (const partner of partnersData) {
					try {
						await this.savePartnerToDatabase(partner, jobId, data.holding_id);
						totalSaved++;
					} catch (error) {
						console.error(`Error guardando partner ${partner.id}:`, error);
						totalErrors++;
					}
					totalProcessed++;
				}

				// Actualizar progreso del job
				await this.updateJobStatus(jobId, 'running', {
					records_processed: totalProcessed,
					records_success: totalSaved,
					records_failed: totalErrors,
				});
			}

			console.log(`✅ Partners procesados: ${totalProcessed}, guardados: ${totalSaved}, errores: ${totalErrors}`);
		} catch (error) {
			console.error(`❌ Error procesando partners para job ${jobId}:`, error);
			throw error;
		}
	}

	/**
	 * Procesa invoice lines específicamente para un job
	 */
	private async processInvoiceLinesForJob(jobId: string, data: StartAsyncJobDTO): Promise<void> {
		console.log(`📋 Procesando invoice lines para job: ${jobId}`);

		try {
			// Obtener configuración de conexión
			const connection = await this.getOdooConnection(data.connection_id);

			// Crear clientes XML-RPC
			const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

			// Autenticación
			const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);
			if (!uid) {
				throw new Error('Error de autenticación con Odoo');
			}

			// Primero buscar facturas del rango de fechas para obtener las líneas relacionadas
			const invoicesSearchDomain = [
				['state', '=', 'posted'],
				['move_type', 'in', ['out_invoice']],
				['payment_state', '!=', 'reversed'],
			];

			if (data.start_date) {
				invoicesSearchDomain.push(['invoice_date', '>=', data.start_date]);
			}
			if (data.end_date) {
				invoicesSearchDomain.push(['invoice_date', '<=', data.end_date]);
			}

			// Buscar todas las facturas del rango de fechas
			let allInvoiceIds: number[] = [];
			const invoiceLimit = 1000;
			let invoiceOffset = 0;

			while (true) {
				const invoiceIds = await objectClient.methodCall('execute_kw', [
					connection.database_name,
					uid,
					connection.api_key,
					'account.move',
					'search',
					[invoicesSearchDomain],
					{
						limit: invoiceLimit,
						offset: invoiceOffset,
						order: 'id desc',
					},
				]);

				if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
					break;
				}

				allInvoiceIds = allInvoiceIds.concat(invoiceIds);
				invoiceOffset += invoiceLimit;

				if (invoiceIds.length < invoiceLimit) {
					break;
				}
			}

			if (allInvoiceIds.length === 0) {
				console.log('No se encontraron facturas en el rango de fechas, no hay líneas para procesar');
				return;
			}

			// Buscar líneas que pertenezcan a estas facturas específicas
			const linesSearchDomain = [
				['move_id', 'in', allInvoiceIds],
				['display_type', '=', 'product'],
			];

			// Contar total de líneas para establecer progress_total
			const totalLinesCount = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.move.line',
				'search_count',
				[linesSearchDomain],
			]);

			console.log(`Total de líneas a procesar: ${totalLinesCount}`);
			await this.updateJobStatus(jobId, 'running', { progress_total: totalLinesCount });

			// Buscar líneas con paginación
			const limit = 1;
			let offset = 0;
			let totalProcessed = 0;
			let totalSaved = 0;
			let totalErrors = 0;

			while (true) {
				// Buscar IDs de líneas
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
					break;
				}

				// Obtener datos completos de líneas
				const linesData = await this.getInvoiceLinesData(objectClient, connection, uid, lineIds);

				// Procesar cada línea
				for (const line of linesData) {
					try {
						// Buscar el invoice_staging_id correspondiente en odoo_invoices_stg
						const invoiceStaging = await this.invoicesStgRepository.findOne({
							where: {
								odoo_id: line.move_id[0],
								holding_id: data.holding_id,
							},
						});

						const invoiceStagingId = invoiceStaging ? invoiceStaging.id : null;
						await this.saveLineToDatabase(line, invoiceStagingId, jobId, data.holding_id, jobId);
						totalSaved++;
					} catch (error) {
						console.error(`Error guardando línea ${line.id}:`, error);
						totalErrors++;
					}
					totalProcessed++;
				}

				// Actualizar progreso del job
				await this.updateJobStatus(jobId, 'running', {
					records_processed: totalProcessed,
					records_success: totalSaved,
					records_failed: totalErrors,
				});

				offset += limit;

				// Si obtuvimos menos registros que el límite, hemos terminado
				if (lineIds.length < limit) {
					break;
				}
			}

			console.log(`✅ Invoice lines procesadas: ${totalProcessed}, guardadas: ${totalSaved}, errores: ${totalErrors}`);
		} catch (error) {
			console.error(`❌ Error procesando invoice lines para job ${jobId}:`, error);
			throw error;
		}
	}

	/**
	 * Procesa invoices específicamente para un job
	 */
	private async processInvoicesForJob(jobId: string, data: StartAsyncJobDTO): Promise<void> {
		console.log(`📋 Procesando invoices para job: ${jobId}`);

		try {
			// Obtener configuración de conexión
			const connection = await this.getOdooConnection(data.connection_id);

			// Crear clientes XML-RPC
			const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

			// Autenticación
			const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);
			if (!uid) {
				throw new Error('Error de autenticación con Odoo');
			}

			// Filtros para facturas
			const invoicesSearchDomain = [
				['state', '=', 'posted'],
				['move_type', 'in', ['out_invoice']],
				['payment_state', '!=', 'reversed'],
			];

			if (data.start_date) {
				invoicesSearchDomain.push(['invoice_date', '>=', data.start_date]);
			}
			if (data.end_date) {
				invoicesSearchDomain.push(['invoice_date', '<=', data.end_date]);
			}

			// Contar total de facturas para establecer progress_total
			const totalInvoicesCount = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.move',
				'search_count',
				[invoicesSearchDomain],
			]);

			console.log(`Total de facturas a procesar: ${totalInvoicesCount}`);
			await this.updateJobStatus(jobId, 'running', { progress_total: totalInvoicesCount });

			// Buscar facturas con paginación
			const limit = 1;
			let offset = 0;
			let totalProcessed = 0;
			let totalSaved = 0;
			let totalErrors = 0;

			while (true) {
				// Buscar IDs de facturas
				const invoiceIds = await objectClient.methodCall('execute_kw', [
					connection.database_name,
					uid,
					connection.api_key,
					'account.move',
					'search',
					[invoicesSearchDomain],
					{
						limit: limit,
						offset: offset,
						order: 'id desc',
					},
				]);

				if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
					break;
				}

				// Obtener datos completos de facturas
				const invoicesData = await this.getInvoicesData(objectClient, connection, uid, invoiceIds);

				// Procesar cada factura
				for (const invoice of invoicesData) {
					try {
						await this.saveInvoiceToDatabase(invoice, jobId, data.holding_id, jobId);
						totalSaved++;
					} catch (error) {
						console.error(`Error guardando factura ${invoice.id}:`, error);
						totalErrors++;
					}
					totalProcessed++;
				}

				// Actualizar progreso del job
				await this.updateJobStatus(jobId, 'running', {
					records_processed: totalProcessed,
					records_success: totalSaved,
					records_failed: totalErrors,
				});

				offset += limit;

				// Si obtuvimos menos registros que el límite, hemos terminado
				if (invoiceIds.length < limit) {
					break;
				}
			}

			console.log(`✅ Invoices procesadas: ${totalProcessed}, guardadas: ${totalSaved}, errores: ${totalErrors}`);
		} catch (error) {
			console.error(`❌ Error procesando invoices para job ${jobId}:`, error);
			throw error;
		}
	}

	/**
	 * Obtiene el estado de un job de sincronización
	 */
	async getJobStatus(jobId: string): Promise<JobStatusResponseDTO> {
		try {
			const integrationLog = await this.integrationLogRepository.findOne({
				where: { id: jobId },
			});

			if (!integrationLog) {
				throw new Error('Job no encontrado');
			}

			// Calcular porcentaje de progreso
			const progressPercentage = this.calculateProgressPercentage(
				integrationLog.records_processed || 0,
				integrationLog.progress_total || 0,
				integrationLog.status || 'running'
			);

			// Calcular tiempo de ejecución
			const executionTime = integrationLog.completed_at
				? new Date(integrationLog.completed_at).getTime() - new Date(integrationLog.started_at).getTime()
				: integrationLog.execution_time_ms || null;

			return {
				job_id: integrationLog.id,
				status: integrationLog.status || 'running',
				records_processed: integrationLog.records_processed || 0,
				records_success: integrationLog.records_success || 0,
				records_failed: integrationLog.records_failed || 0,
				progress_percentage: progressPercentage,
				execution_time_ms: executionTime,
				started_at: integrationLog.started_at,
				completed_at: integrationLog.completed_at || undefined,
				error_details: integrationLog.error_details || undefined,
			};
		} catch (error) {
			console.error('❌ Error obteniendo estado del job:', error);
			throw new Error(`Error obteniendo estado: ${error.message}`);
		}
	}

	/**
	 * Procesa una entidad específica de forma asíncrona
	 */
	private async processEntityAsync(jobId: string, data: StartAsyncJobDTO, entityType: 'partners' | 'invoice_lines' | 'invoices'): Promise<void> {
		const startTime = Date.now();

		try {
			console.log(`🚀 Iniciando proceso asíncrono para ${entityType} - job: ${jobId}`);

			// Actualizar estado a 'running'
			await this.updateJobStatus(jobId, 'running', {});

			switch (entityType) {
				case 'partners':
					await this.processPartnersForJob(jobId, data);
					break;
				case 'invoice_lines':
					await this.processInvoiceLinesForJob(jobId, data);
					break;
				case 'invoices':
					await this.processInvoicesForJob(jobId, data);
					break;
			}

			// Marcar como completado
			const executionTime = Date.now() - startTime;
			await this.updateJobStatus(jobId, 'completed', {
				completed_at: new Date().toISOString(),
				execution_time_ms: executionTime,
			});

			console.log(`✅ Proceso completado para ${entityType} - job: ${jobId} en ${executionTime}ms`);
		} catch (error) {
			console.error(`❌ Error procesando ${entityType} - job: ${jobId}:`, error);
			await this.updateJobStatus(jobId, 'failed', {
				error: error.message,
				failed_at: new Date().toISOString(),
			});
		}
	}

	/**
	 * Calcula el porcentaje de progreso de un job
	 */
	private calculateProgressPercentage(recordsProcessed: number, progressTotal: number, status: string): number {
		// Si está completado, siempre 100%
		if (status === 'completed') {
			return 100;
		}

		// Si no hay total definido, usar 0%
		if (!progressTotal || progressTotal === 0) {
			return 0;
		}

		// Calcular porcentaje basado en registros procesados
		return Math.min(100, Math.round((recordsProcessed / progressTotal) * 100));
	}

	/**
	 * Actualiza el estado de un job
	 */
	private async updateJobStatus(jobId: string, status: string, additionalData?: any): Promise<void> {
		try {
			const updateData: any = { status };

			if (status === 'completed' || status === 'failed') {
				updateData.completed_at = new Date();
			}

			if (additionalData) {
				Object.assign(updateData, additionalData);
			}

			console.log(`🔄 Actualizando job ${jobId} con:`, updateData);
			const result = await this.integrationLogRepository.update(jobId, updateData);
			console.log(`✅ Job actualizado, filas afectadas:`, result.affected);
		} catch (error) {
			console.error('❌ Error actualizando estado del job:', error);
		}
	}

	/**
	 * Clasifica las facturas en staging sin procesarlas
	 */
	async classifyInvoices(holdingId: string): Promise<{
		success: boolean;
		to_create: number;
		to_update: number;
		already_processed: number;
		total: number;
		message: string;
	}> {
		try {
			console.log(`📊 Clasificando facturas para holding: ${holdingId}`);

			if (!holdingId) {
				throw new Error('holding_id es requerido');
			}

			// Delegar al servicio de procesamiento de facturas
			const classification = await this.invoiceProcessingService.classifyInvoicesPublic(holdingId);

			console.log(`✅ Clasificación completada:`, classification);

			return {
				success: true,
				...classification,
				message: `Clasificación completada: ${classification.to_create} nuevas, ${classification.to_update} a actualizar, ${classification.already_processed} ya procesadas`,
			};
		} catch (error) {
			console.error('❌ Error clasificando facturas:', error);
			throw new Error(`Error al clasificar facturas: ${error.message}`);
		}
	}

	/**
	 * Limpia registros procesados de la tabla staging
	 */
	async cleanProcessedPartners(holdingId: string): Promise<{ success: boolean; message: string; deleted_count: number }> {
		try {
			console.log(`🧹 Iniciando limpieza de registros procesados para holding: ${holdingId}`);

			if (!holdingId) {
				throw new Error('holding_id es requerido');
			}

			// Eliminar registros con processing_status = 'processed'
			const result = await this.partnersStgRepository.delete({
				holding_id: holdingId,
				processing_status: 'processed',
			});

			const deletedCount = result.affected || 0;

			console.log(`✅ Limpieza completada. Registros eliminados: ${deletedCount}`);

			return {
				success: true,
				message: `Se eliminaron ${deletedCount} registros procesados exitosamente`,
				deleted_count: deletedCount,
			};
		} catch (error) {
			console.error('❌ Error limpiando registros procesados:', error);
			throw new Error(`Error al limpiar registros procesados: ${error.message}`);
		}
	}
}

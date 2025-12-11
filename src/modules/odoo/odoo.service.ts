import { Injectable } from '@nestjs/common';

import { XmlRpcClientHelper } from './helpers/xml-rpc-client.helper';
import { EstimateResult, OdooConnection, OdooInvoice, OdooInvoiceLine, OdooPartner, SyncResult } from './interfaces/odoo.interface';
import { SyncInvoicesDTO } from './odoo.dto';
import { OdooProvider } from './odoo.provider';

@Injectable()
export class OdooService {
	constructor(private readonly odooProvider: OdooProvider) {}
	async syncInvoices(syncData: SyncInvoicesDTO): Promise<SyncResult | EstimateResult> {
		const { connectionId, limit = 60, offset = 0, date_from, date_to, estimate_only = false, sync_session_id } = syncData;

		if (!connectionId) {
			throw new Error('connectionId es requerido');
		}

		// Obtener configuración de conexión
		const connection = await this.getOdooConnection(connectionId);

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

		return await this.performInvoiceSync(objectClient, connection, uid, limit, offset, date_from, date_to, sync_session_id);
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
		sync_session_id?: string
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
				invoicesSynced: 0,
				linesSynced: 0,
				partnersSynced: 0,
				totalProcessed: 0,
				batchId,
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
				invoicesSynced: 0,
				linesSynced: 0,
				partnersSynced: 0,
				totalProcessed: 0,
				batchId,
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
			sync_session_id
		);

		// Sincronizar partners del lote actual
		const savedPartners = await this.syncPartnersFromCurrentBatch(invoices, connection, uid, objectClient, sync_session_id);

		return {
			success: true,
			message: `Sincronización completada: ${savedInvoices} facturas, ${savedLines} líneas y ${savedPartners} partners guardados`,
			invoicesSynced: savedInvoices,
			linesSynced: savedLines,
			partnersSynced: savedPartners,
			errors: errors,
			batchId: batchId,
			totalProcessed: lineIds.length,
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
		sync_session_id?: string
	): Promise<{ savedInvoices: number; savedLines: number; errors: number; batchId: string; sync_session_id?: string }> {
		let savedInvoices = 0;
		let savedLines = 0;
		let errors = 0;

		for (const invoice of invoices) {
			try {
				// TODO: Guardar factura en base de datos
				// const savedInvoice = await this.saveInvoiceToDatabase(invoice, batchId, connection.holding_id, sync_session_id);

				savedInvoices++;

				// Procesar líneas de la factura
				const invoiceLines = linesData.filter((line: any) => line.move_id[0] === invoice.id);

				if (invoiceLines.length > 0) {
					const lineIds = invoiceLines.map((line: any) => line.id);
					const lines = await this.getInvoiceLinesData(objectClient, connection, uid, lineIds);

					for (const line of lines) {
						try {
							// TODO: Guardar línea en base de datos
							// await this.saveLineToDatabase(line, invoice.id, batchId, connection.holding_id, sync_session_id);
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

		return { savedInvoices, savedLines, errors, batchId, sync_session_id };
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
		sync_session_id?: string
	): Promise<number> {
		try {
			const batchId = `sync_partners_batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

			console.log(sync_session_id);
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

			if (uniquePartnerIds.length === 0) {
				console.log('No hay partners para sincronizar en este lote');
				return 0;
			}

			// Obtener partners de Odoo
			const partners = await this.getPartnersData(objectClient, connection, uid, uniquePartnerIds);

			if (!Array.isArray(partners) || partners.length === 0) {
				console.log('No se obtuvieron datos de partners de Odoo');
				return 0;
			}

			let savedCount = 0;

			for (const partner of partners) {
				try {
					// TODO: Guardar partner en base de datos
					// await this.savePartnerToDatabase(partner, batchId, connection.holding_id);
					console.log(`Procesando partner ${partner.name || partner.id}`);
					savedCount++;
				} catch (partnerProcessError) {
					console.error(`Error al procesar partner:`, partnerProcessError);
				}
			}

			console.log(`${savedCount} partners del lote guardados en staging`);
			return savedCount;
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
				],
			},
		]);
	}

	private generateBatchId(): string {
		return `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
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
				holding_id: 'aisapira_holding',
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
				holding_id: 'aisapira_holding',
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
			holding_id: 'aisapira_holding',
		};
	}
}

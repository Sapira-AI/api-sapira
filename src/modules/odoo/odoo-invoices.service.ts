import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CreateDraftInvoiceDTO } from './dtos/odoo.dto';
import { OdooConnection } from './entities/odoo-connection.entity';
import { CreateDraftInvoiceResult, OdooConnectionConfig } from './interfaces/odoo.interface';
import { OdooProvider } from './odoo.provider';

@Injectable()
export class OdooInvoicesService {
	constructor(
		private readonly odooProvider: OdooProvider,
		@InjectRepository(OdooConnection)
		private readonly odooConnectionRepository: Repository<OdooConnection>
	) {}

	/**
	 * Crea una factura en borrador en Odoo
	 */
	async createDraftInvoice(holdingId: string, data: CreateDraftInvoiceDTO): Promise<CreateDraftInvoiceResult> {
		const {
			partner_id,
			move_type,
			invoice_date,
			invoice_date_due,
			payment_reference,
			invoice_origin,
			narration,
			company_id,
			journal_id,
			x_sapira_invoice_id,
			invoice_line_ids,
		} = data;

		try {
			console.log(`📝 Creando factura en borrador en Odoo para partner ${partner_id}`);

			const connection = await this.getOdooConnectionByHoldingId(holdingId);

			const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

			const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);

			if (!uid) {
				throw new Error('Falló la autenticación con Odoo');
			}

			const invoiceData: any = {
				partner_id: partner_id,
				move_type: move_type || 'out_invoice',
			};

			if (invoice_date) {
				invoiceData.invoice_date = invoice_date;
			}

			if (invoice_date_due) {
				invoiceData.invoice_date_due = invoice_date_due;
			}

			if (payment_reference) {
				invoiceData.payment_reference = payment_reference;
			}

			if (invoice_origin) {
				invoiceData.invoice_origin = invoice_origin;
			}

			if (narration) {
				invoiceData.narration = narration;
			}

			if (company_id) {
				invoiceData.company_id = company_id;
			}

			if (journal_id) {
				invoiceData.journal_id = journal_id;
			}

			if (x_sapira_invoice_id) {
				invoiceData.x_sapira_invoice_id = x_sapira_invoice_id;
			}

			const invoiceLines = invoice_line_ids.map((line) => {
				const lineData: any = {
					product_id: line.product_id,
					quantity: line.quantity,
					price_unit: line.price_unit,
				};

				if (line.name) {
					lineData.name = line.name;
				}

				if (line.discount !== undefined && line.discount !== null) {
					lineData.discount = line.discount;
				}

				if (line.tax_ids && line.tax_ids.length > 0) {
					lineData.tax_ids = [[6, 0, line.tax_ids]];
				}

				return [0, 0, lineData];
			});

			invoiceData.invoice_line_ids = invoiceLines;

			console.log(`📤 Enviando datos de factura a Odoo:`, JSON.stringify(invoiceData, null, 2));

			const invoiceId = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.move',
				'create',
				[invoiceData],
			]);

			console.log(`✅ Factura creada con ID: ${invoiceId}`);

			const createdInvoice = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.move',
				'read',
				[[invoiceId]],
				{
					fields: ['name', 'state', 'amount_untaxed', 'amount_tax', 'amount_total'],
				},
			]);

			const invoice = createdInvoice[0];

			return {
				success: true,
				message: `Factura en borrador creada exitosamente con ID ${invoiceId}`,
				invoice_id: invoiceId,
				invoice_name: invoice.name,
				state: invoice.state,
				amount_untaxed: invoice.amount_untaxed,
				amount_tax: invoice.amount_tax,
				amount_total: invoice.amount_total,
			};
		} catch (error) {
			console.error('❌ Error creando factura en borrador:', error);
			throw new Error(`Error creando factura en borrador en Odoo: ${error.message}`);
		}
	}

	/**
	 * Obtiene la configuración de conexión de Odoo por holding_id
	 */
	private async getOdooConnectionByHoldingId(holdingId: string): Promise<OdooConnectionConfig> {
		try {
			const dbConnection = await this.odooConnectionRepository.findOne({
				where: { holding_id: holdingId, is_active: true },
				order: { created_at: 'DESC' },
			});

			if (dbConnection) {
				console.log(`✓ Conexión Odoo encontrada en BD: ${dbConnection.name} (${dbConnection.id})`);
				return {
					id: dbConnection.id,
					url: dbConnection.url,
					database_name: dbConnection.database_name,
					username: dbConnection.username || '',
					api_key: dbConnection.api_key,
					holding_id: dbConnection.holding_id,
				};
			}

			throw new Error(`Conexión Odoo no encontrada o inactiva para holding_id: ${holdingId}`);
		} catch (error) {
			console.error('Error obteniendo conexión Odoo desde BD:', error);
			throw new Error(`No se pudo obtener la conexión Odoo para holding_id: ${holdingId}. ${error.message}`);
		}
	}

	/**
	 * Valida si un string es un UUID válido
	 */
	private isValidUUID(uuid: string): boolean {
		const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
		return uuidRegex.test(uuid);
	}
}

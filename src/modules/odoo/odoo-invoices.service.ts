import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';

import { CreateDraftInvoiceDTO } from './dtos/odoo.dto';
import { OdooConnection } from './entities/odoo-connection.entity';
import { CreateDraftInvoiceResult, OdooConnectionConfig } from './interfaces/odoo.interface';
import { OdooProvider } from './odoo.provider';
import { TaxMappingService } from './services/tax-mapping.service';

@Injectable()
export class OdooInvoicesService {
	private readonly logger = new Logger(OdooInvoicesService.name);

	constructor(
		private readonly odooProvider: OdooProvider,
		@InjectRepository(OdooConnection)
		private readonly odooConnectionRepository: Repository<OdooConnection>,
		@InjectRepository(ClientEntity)
		private readonly clientEntitiesRepository: Repository<ClientEntity>,
		private readonly taxMappingService: TaxMappingService
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
			auto_post,
			invoice_line_ids,
		} = data;

		try {
			const connection = await this.getOdooConnectionByHoldingId(holdingId);

			// Obtener fiscal position Y tax IDs de retenciones del cliente
			const clientEntity = await this.clientEntitiesRepository.findOne({
				where: {
					odoo_partner_id: partner_id,
					holding_id: holdingId,
				},
				select: [
					'id',
					'odoo_fiscal_position_id',
					'odoo_fiscal_position_name',
					'odoo_reteica_tax_id',
					'odoo_retefuente_tax_id',
					'odoo_reteiva_tax_id',
				],
			});

			if (clientEntity?.odoo_fiscal_position_id) {
				this.logger.log(
					`✅ Cliente encontrado con posición fiscal: "${clientEntity.odoo_fiscal_position_name}" (ID: ${clientEntity.odoo_fiscal_position_id})`
				);
			} else {
				this.logger.debug(`ℹ️  Cliente no tiene posición fiscal configurada (partner_id: ${partner_id})`);
			}

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

			// Agregar fiscal position ANTES de otros campos
			// Esto permite que Odoo procese correctamente el mapeo de impuestos
			if (clientEntity?.odoo_fiscal_position_id) {
				invoiceData.fiscal_position_id = clientEntity.odoo_fiscal_position_id;
			}

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

			if (auto_post) {
				invoiceData.auto_post = auto_post;
			}

			// Procesar líneas de factura con mapeo de impuestos
			const invoiceLines = await Promise.all(
				invoice_line_ids.map(async (line) => {
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

					// Obtener impuestos de venta del producto
					const productSaleTaxIds = await this.taxMappingService.getProductSaleTaxes(line.product_id, company_id, holdingId);

					let finalTaxIds: number[] = [];

					// Aplicar mapeo de posición fiscal si el cliente tiene una configurada
					if (clientEntity?.odoo_fiscal_position_id) {
						const mappingResult = await this.taxMappingService.applyFiscalPositionMapping(
							productSaleTaxIds,
							clientEntity.odoo_fiscal_position_id,
							holdingId
						);
						finalTaxIds = mappingResult.final_tax_ids;

						this.logger.debug(
							`📦 Producto ${line.product_id}: ${productSaleTaxIds.length} impuestos originales → ${finalTaxIds.length} impuestos finales (con mapeo)`
						);
					} else {
						// Sin posición fiscal, usar impuestos del producto directamente
						finalTaxIds = productSaleTaxIds;
						this.logger.debug(`📦 Producto ${line.product_id}: ${finalTaxIds.length} impuestos (sin posición fiscal)`);
					}

					// Asignar impuestos finales a la línea
					if (finalTaxIds.length > 0) {
						lineData.tax_ids = [[6, 0, finalTaxIds]];
					}

					return [0, 0, lineData];
				})
			);

			invoiceData.invoice_line_ids = invoiceLines;

			// 📊 LOG DETALLADO DEL PAYLOAD
			console.log('\n🔍 ===== PAYLOAD COMPLETO PARA ODOO =====');
			console.log(`📍 Company ID: ${invoiceData.company_id}`);
			console.log(`👤 Partner ID: ${invoiceData.partner_id}`);
			console.log(`📅 Invoice Date: ${invoiceData.invoice_date}`);
			console.log(`💰 Currency ID: ${data.currency_id}`);
			if (invoiceData.fiscal_position_id) {
				console.log(`🏛️  Fiscal Position ID: ${invoiceData.fiscal_position_id} (${clientEntity?.odoo_fiscal_position_name || 'N/A'})`);
				console.log(`✅ Mapeo de impuestos aplicado automáticamente según posición fiscal`);
			} else {
				console.log(`ℹ️  Sin posición fiscal - usando impuestos de venta del producto`);
			}
			console.log(`\n📦 LÍNEAS DE FACTURA (${invoiceLines.length} items):`);
			invoiceLines.forEach((line, index) => {
				const lineData = line[2];
				console.log(`  Línea ${index + 1}:`);
				console.log(`    - Product ID: ${lineData.product_id}`);
				console.log(`    - Name: ${lineData.name}`);
				console.log(`    - Quantity: ${lineData.quantity}`);
				console.log(`    - Price Unit: ${lineData.price_unit}`);
				if (lineData.tax_ids) {
					const taxIds = lineData.tax_ids[0][2];
					console.log(`    - Tax IDs: [${taxIds.join(', ')}]`);
				}
			});
			console.log('🔍 ======================================\n');

			const invoiceId = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.move',
				'create',
				[invoiceData],
			]);

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
	 * Emite/valida una factura en Odoo (cambia de draft a posted)
	 */
	async postInvoice(holdingId: string, invoiceId: number): Promise<{ success: boolean; message: string; state?: string }> {
		try {
			const connection = await this.getOdooConnectionByHoldingId(holdingId);

			const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

			const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);

			if (!uid) {
				throw new Error('Falló la autenticación con Odoo');
			}

			// Llamar al método action_post para emitir la factura
			await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.move',
				'action_post',
				[[invoiceId]],
			]);

			// Leer el estado actualizado de la factura
			const updatedInvoice = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.move',
				'read',
				[[invoiceId]],
				{
					fields: ['state', 'name'],
				},
			]);

			const invoice = updatedInvoice[0];

			return {
				success: true,
				message: `Factura ${invoice.name} emitida exitosamente`,
				state: invoice.state,
			};
		} catch (error) {
			console.error('❌ Error emitiendo factura:', error);
			throw new Error(`Error emitiendo factura en Odoo: ${error.message}`);
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

	/**
	 * Obtiene los taxes disponibles para una compañía en Odoo
	 */
	async getTaxesForCompany(
		holdingId: string,
		companyId: number
	): Promise<{
		success: boolean;
		message: string;
		company_id: number;
		company_name: string;
		taxes: any[];
		total: number;
	}> {
		try {
			const connection = await this.getOdooConnectionByHoldingId(holdingId);

			const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

			const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);

			if (!uid) {
				throw new Error('Falló la autenticación con Odoo');
			}

			// Obtener información de la compañía
			const companies = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'res.company',
				'read',
				[[companyId]],
				{ fields: ['name', 'display_name'] },
			]);

			const companyName = companies[0]?.name || 'Desconocida';

			// Obtener taxes de la compañía
			const taxes = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.tax',
				'search_read',
				[[['company_id', '=', companyId]]],
				{
					fields: ['id', 'name', 'display_name', 'company_id', 'amount', 'type_tax_use', 'active'],
					order: 'name asc',
				},
			]);

			return {
				success: true,
				message: `Se encontraron ${taxes.length} taxes para la compañía ${companyName}`,
				company_id: companyId,
				company_name: companyName,
				taxes,
				total: taxes.length,
			};
		} catch (error) {
			console.error('❌ Error obteniendo taxes:', error);
			throw new Error(`Error obteniendo taxes de Odoo: ${error.message}`);
		}
	}

	/**
	 * Valida que los tax_ids pertenezcan a la compañía especificada
	 */
	async validateTaxesForCompany(
		holdingId: string,
		companyId: number,
		taxIds: number[]
	): Promise<{
		success: boolean;
		message: string;
		company_id: number;
		tax_validations: Array<{
			tax_id: number;
			name: string;
			company_id: number;
			company_name: string;
			is_valid: boolean;
		}>;
		invalid_tax_ids: number[];
	}> {
		try {
			const connection = await this.getOdooConnectionByHoldingId(holdingId);

			const commonClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const objectClient = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

			const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);

			if (!uid) {
				throw new Error('Falló la autenticación con Odoo');
			}

			// Obtener información de todos los taxes solicitados
			const taxes = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.tax',
				'read',
				[taxIds],
				{ fields: ['id', 'name', 'company_id'] },
			]);

			const validations = taxes.map((tax) => {
				const taxCompanyId = Array.isArray(tax.company_id) ? tax.company_id[0] : tax.company_id;
				const taxCompanyName = Array.isArray(tax.company_id) ? tax.company_id[1] : 'Desconocida';

				return {
					tax_id: tax.id,
					name: tax.name,
					company_id: taxCompanyId,
					company_name: taxCompanyName,
					is_valid: taxCompanyId === companyId,
				};
			});

			const invalidTaxIds = validations.filter((v) => !v.is_valid).map((v) => v.tax_id);

			const success = invalidTaxIds.length === 0;
			const message = success
				? `Todos los taxes son válidos para la compañía ${companyId}`
				: `Se encontraron ${invalidTaxIds.length} taxes incompatibles con la compañía ${companyId}`;

			return {
				success,
				message,
				company_id: companyId,
				tax_validations: validations,
				invalid_tax_ids: invalidTaxIds,
			};
		} catch (error) {
			console.error('❌ Error validando taxes:', error);
			throw new Error(`Error validando taxes en Odoo: ${error.message}`);
		}
	}
}

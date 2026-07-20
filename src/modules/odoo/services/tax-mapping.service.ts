import { Injectable, Logger } from '@nestjs/common';

import { FiscalPositionsService } from './fiscal-positions.service';

export interface AppliedTaxMapping {
	original_tax_id: number;
	original_tax_name: string;
	mapped_tax_id: number | null;
	mapped_tax_name: string | null;
	action: 'keep' | 'replace' | 'remove';
}

export interface TaxMappingResult {
	final_tax_ids: number[];
	mappings_applied: AppliedTaxMapping[];
	fiscal_position_id: number | null;
	fiscal_position_name: string | null;
}

@Injectable()
export class TaxMappingService {
	private readonly logger = new Logger(TaxMappingService.name);

	constructor(private readonly fiscalPositionsService: FiscalPositionsService) {}

	private async getOdooClients(holdingId: string): Promise<{
		connection: any;
		uid: number;
		objectClient: any;
	}> {
		const connection = await this.fiscalPositionsService['getOdooConnectionByHoldingId'](holdingId);
		if (!connection) {
			throw new Error('No se encontró una conexión activa de Odoo para este holding');
		}

		const commonClient = this.fiscalPositionsService['odooProvider'].createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
		const objectClient = this.fiscalPositionsService['odooProvider'].createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);

		const uid = await commonClient.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);

		if (!uid) {
			throw new Error('Falló la autenticación con Odoo');
		}

		return {
			connection,
			uid,
			objectClient,
		};
	}

	/**
	 * Aplica el mapeo de posición fiscal a los impuestos del producto
	 * Replica el comportamiento nativo de Odoo
	 */
	async applyFiscalPositionMapping(productTaxIds: number[], fiscalPositionId: number, holdingId: string): Promise<TaxMappingResult> {
		try {
			this.logger.log(`🔄 Aplicando mapeo de posición fiscal ${fiscalPositionId} a impuestos del producto: [${productTaxIds.join(', ')}]`);

			// Obtener la posición fiscal completa con todos sus mapeos
			const fiscalPosition = await this.fiscalPositionsService.getFiscalPositionComplete(holdingId, fiscalPositionId);

			if (!fiscalPosition) {
				this.logger.warn(`⚠️ Posición fiscal ${fiscalPositionId} no encontrada, usando impuestos del producto sin mapeo`);
				return {
					final_tax_ids: productTaxIds,
					mappings_applied: [],
					fiscal_position_id: null,
					fiscal_position_name: null,
				};
			}

			this.logger.log(
				`📋 Posición fiscal cargada: ${fiscalPosition.name} (ID: ${fiscalPosition.id}) con ${fiscalPosition.complete_tax_mappings.length} mapeos`
			);
			this.logger.log(
				`   - detalle mapeos posición fiscal: ${
					fiscalPosition.complete_tax_mappings.length > 0 ? JSON.stringify(fiscalPosition.complete_tax_mappings) : 'sin mapeos configurados'
				}`
			);
			const candidateTaxIds = [
				...new Set(
					fiscalPosition.complete_tax_mappings
						.filter((mapping) => productTaxIds.includes(mapping.tax_src_id ?? -1) && mapping.tax_dest_id !== null)
						.map((mapping) => mapping.tax_dest_id as number)
				),
			];
			this.logger.log(
				`🎯 Impuestos candidatos agregados para producto [${productTaxIds.join(', ')}]: ${
					candidateTaxIds.length > 0 ? `[${candidateTaxIds.join(', ')}]` : 'sin candidatos por mapeo; se mantendrán impuestos originales donde aplique'
				}`
			);

			const finalTaxIds: number[] = [];
			const mappingsApplied: AppliedTaxMapping[] = [];

			// Aplicar algoritmo de mapeo para cada impuesto del producto
			for (const taxId of productTaxIds) {
				const candidateMappings = fiscalPosition.complete_tax_mappings.filter((m) => m.tax_src_id === taxId);
				this.logger.log(
					`🎯 Tax ${taxId}: candidatos específicos = ${
						candidateMappings.length > 0
							? JSON.stringify(
									candidateMappings.map((mapping) => ({
										mapping_id: mapping.id,
										tax_src_id: mapping.tax_src_id,
										tax_src_name: mapping.tax_src_name,
										tax_src_amount: mapping.tax_src_amount,
										tax_dest_id: mapping.tax_dest_id,
										tax_dest_name: mapping.tax_dest_name,
										tax_dest_amount: mapping.tax_dest_amount,
										tax_dest_type: mapping.tax_dest_type,
									}))
							  )
							: 'sin candidatos explícitos; candidato implícito = mantener impuesto original'
					}`
				);
				// Buscar si existe un mapeo para este impuesto
				const mapping = fiscalPosition.complete_tax_mappings.find((m) => m.tax_src_id === taxId);
				this.logger.debug(
					`🔎 Evaluando tax ${taxId} contra posición fiscal ${fiscalPositionId}: ${
						mapping
							? `match src=${mapping.tax_src_id} -> dest=${mapping.tax_dest_id ?? 'null'}`
							: 'sin mapeo específico'
					}`
				);

				if (mapping) {
					// Existe un mapeo para este impuesto
					if (mapping.tax_dest_id !== null) {
						// Mapeo a otro impuesto (REPLACE)
						finalTaxIds.push(mapping.tax_dest_id);
						mappingsApplied.push({
							original_tax_id: taxId,
							original_tax_name: mapping.tax_src_name || '',
							mapped_tax_id: mapping.tax_dest_id,
							mapped_tax_name: mapping.tax_dest_name || '',
							action: 'replace',
						});
						this.logger.debug(`  ↪️ Tax ${taxId} (${mapping.tax_src_name}) → ${mapping.tax_dest_id} (${mapping.tax_dest_name})`);
					} else {
						// Mapeo a null (REMOVE)
						mappingsApplied.push({
							original_tax_id: taxId,
							original_tax_name: mapping.tax_src_name || '',
							mapped_tax_id: null,
							mapped_tax_name: null,
							action: 'remove',
						});
						this.logger.debug(`  ❌ Tax ${taxId} (${mapping.tax_src_name}) → eliminado`);
					}
				} else {
					// No existe mapeo, mantener el impuesto original (KEEP)
					finalTaxIds.push(taxId);
					mappingsApplied.push({
						original_tax_id: taxId,
						original_tax_name: '',
						mapped_tax_id: taxId,
						mapped_tax_name: '',
						action: 'keep',
					});
					this.logger.debug(`  ✓ Tax ${taxId} → sin mapeo, se mantiene`);
				}
			}

			// Eliminar duplicados
			const uniqueTaxIds = [...new Set(finalTaxIds)];
			if (uniqueTaxIds.length !== finalTaxIds.length) {
				this.logger.debug(
					`🧹 Eliminando duplicados tras mapeo fiscal: [${finalTaxIds.join(', ')}] -> [${uniqueTaxIds.join(', ')}]`
				);
			}

			this.logger.log(
				`✅ Mapeo completado. Impuestos originales: [${productTaxIds.join(', ')}] → Impuestos finales: [${uniqueTaxIds.join(', ')}]`
			);

			return {
				final_tax_ids: uniqueTaxIds,
				mappings_applied: mappingsApplied,
				fiscal_position_id: fiscalPosition.id,
				fiscal_position_name: fiscalPosition.name,
			};
		} catch (error) {
			this.logger.error(`❌ Error aplicando mapeo de posición fiscal: ${error.message}`, error.stack);
			// En caso de error, retornar impuestos originales sin mapeo
			return {
				final_tax_ids: productTaxIds,
				mappings_applied: [],
				fiscal_position_id: null,
				fiscal_position_name: null,
			};
		}
	}

	/**
	 * Obtiene solo los impuestos de venta de un producto
	 * Filtra por type_tax_use = "sale" y company_id
	 */
	async getProductSaleTaxes(productId: number, companyId: number, holdingId: string): Promise<number[]> {
		try {
			this.logger.debug(`🔍 Consultando impuestos de venta del producto ${productId} para compañía ${companyId}`);

			const { connection, uid, objectClient } = await this.getOdooClients(holdingId);

			// Leer el producto con sus impuestos
			const productData = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'product.product',
				'read',
				[[productId]],
				{
					fields: ['taxes_id'],
				},
			]);

			if (!productData || productData.length === 0) {
				this.logger.warn(`⚠️ Producto ${productId} no encontrado`);
				return [];
			}

			const product = productData[0];
			const taxIds = Array.isArray(product.taxes_id) ? product.taxes_id : [];
			this.logger.log(`📦 Producto ${productId}: taxes_id configurados en Odoo = [${taxIds.join(', ')}]`);

			if (taxIds.length === 0) {
				this.logger.debug(`ℹ️ Producto ${productId} no tiene impuestos configurados`);
				return [];
			}

			// Consultar información de los impuestos
			const taxesData = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.tax',
				'read',
				[taxIds],
				{
					fields: ['id', 'name', 'type_tax_use', 'company_id', 'active'],
				},
			]);

			// Filtrar solo impuestos de venta, activos y de la compañía correcta
			this.logger.log(
				`📋 Producto ${productId}: detalle impuestos crudos = ${
					taxesData.length > 0
						? JSON.stringify(
								taxesData.map((tax: any) => ({
									id: tax.id,
									name: tax.name,
									type_tax_use: tax.type_tax_use,
									active: tax.active,
									company_id: Array.isArray(tax.company_id) ? tax.company_id[0] : tax.company_id,
									company_name: Array.isArray(tax.company_id) ? tax.company_id[1] : null,
								}))
						  )
						: '[]'
				}`
			);
			const saleTaxIds = taxesData
				.filter((tax: any) => {
					const taxCompanyId = Array.isArray(tax.company_id) ? tax.company_id[0] : tax.company_id;
					const isSaleTax = tax.type_tax_use === 'sale';
					const isActive = Boolean(tax.active);
					const belongsToCompany = taxCompanyId === companyId;
					this.logger.debug(
						`   - tax ${tax.id} (${tax.name}): type=${tax.type_tax_use}, active=${tax.active}, company=${taxCompanyId} => sale=${isSaleTax}, active_ok=${isActive}, company_ok=${belongsToCompany}`
					);
					return isSaleTax && isActive && belongsToCompany;
				})
				.map((tax: any) => tax.id);

			this.logger.log(
				`✅ Producto ${productId}: ${taxIds.length} impuestos totales → ${saleTaxIds.length} impuestos de venta: [${saleTaxIds.join(', ')}]`
			);

			return saleTaxIds;
		} catch (error) {
			this.logger.error(`❌ Error consultando impuestos del producto ${productId}: ${error.message}`, error.stack);
			return [];
		}
	}

	async getCompanyZeroRateSaleTax(companyId: number, holdingId: string): Promise<number | null> {
		try {
			this.logger.log(`🔍 Buscando impuesto de venta 0% para compañía ${companyId}`);
			const { connection, uid, objectClient } = await this.getOdooClients(holdingId);

			const taxesData = await objectClient.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'account.tax',
				'search_read',
				[
					[
						['company_id', '=', companyId],
						['type_tax_use', '=', 'sale'],
						['active', '=', true],
						['amount', '=', 0],
					],
				],
				{
					fields: ['id', 'name', 'amount', 'type_tax_use', 'company_id', 'active'],
					order: 'id asc',
				},
			]);

			this.logger.log(
				`📋 Compañía ${companyId}: candidatos a impuesto 0% = ${
					taxesData.length > 0
						? JSON.stringify(
								taxesData.map((tax: any) => ({
									id: tax.id,
									name: tax.name,
									amount: tax.amount,
									type_tax_use: tax.type_tax_use,
									active: tax.active,
									company_id: Array.isArray(tax.company_id) ? tax.company_id[0] : tax.company_id,
									company_name: Array.isArray(tax.company_id) ? tax.company_id[1] : null,
								}))
						  )
						: '[]'
				}`
			);

			if (!taxesData || taxesData.length === 0) {
				this.logger.warn(`⚠️ No se encontró impuesto de venta 0% para compañía ${companyId}`);
				return null;
			}

			const preferredTax =
				taxesData.find((tax: any) => /0\s*%/.test(String(tax.name))) ||
				taxesData.find((tax: any) => /iva/i.test(String(tax.name))) ||
				taxesData[0];

			this.logger.log(
				`✅ Compañía ${companyId}: impuesto 0% seleccionado = ${preferredTax.id} (${preferredTax.name})`
			);

			return preferredTax.id;
		} catch (error) {
			this.logger.error(`❌ Error buscando impuesto de venta 0% para compañía ${companyId}: ${error.message}`, error.stack);
			return null;
		}
	}
}

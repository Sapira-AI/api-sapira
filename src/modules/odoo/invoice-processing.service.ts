import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';

import { OdooInvoiceLinesStg } from './entities/odoo-invoice-lines-stg.entity';
import { OdooInvoicesStg } from './entities/odoo-invoices-stg.entity';
import { FieldMappingService } from './services/field-mapping.service';
import { FieldTransformationService } from './services/field-transformation.service';

export interface ProcessInvoicesResult {
	success: boolean;
	processed: number;
	errors: number;
	message: string;
	details?: Array<{
		invoice_id: number;
		status: 'success' | 'error';
		error?: string;
	}>;
}

export interface InvoiceProcessingProgress {
	current: number;
	total: number;
	percentage: number;
}

export interface InvoiceClassification {
	to_create: number;
	to_update: number;
	already_processed: number;
	total: number;
}

type InvoiceStatus = 'create' | 'update' | 'skip';

@Injectable()
export class InvoiceProcessingService {
	private readonly logger = new Logger(InvoiceProcessingService.name);

	constructor(
		@InjectRepository(OdooInvoicesStg)
		private readonly invoicesStgRepository: Repository<OdooInvoicesStg>,
		@InjectRepository(OdooInvoiceLinesStg)
		private readonly invoiceLinesStgRepository: Repository<OdooInvoiceLinesStg>,
		private readonly fieldMappingService: FieldMappingService,
		private readonly fieldTransformationService: FieldTransformationService
	) {}

	async processInvoices(holdingId: string, batchSize: number = 500): Promise<ProcessInvoicesResult> {
		this.logger.log(`Iniciando procesamiento de facturas para holding ${holdingId}`);

		try {
			// Clasificar facturas antes de procesar
			this.logger.log('Clasificando facturas...');
			const classification = await this.classifyInvoices(holdingId);

			this.logger.log(`Clasificación completada:`);
			this.logger.log(`  - Nuevas (crear): ${classification.to_create}`);
			this.logger.log(`  - Existentes con cambios (actualizar): ${classification.to_update}`);
			this.logger.log(`  - Ya procesadas sin cambios (saltar): ${classification.already_processed}`);
			this.logger.log(`  - Total: ${classification.total}`);

			const totalToProcess = classification.to_create + classification.to_update;

			if (totalToProcess === 0) {
				this.logger.log('No hay facturas nuevas o con cambios para procesar');
				return {
					success: true,
					processed: 0,
					errors: 0,
					message: `Todas las facturas (${classification.already_processed}) ya están procesadas y actualizadas`,
				};
			}

			this.logger.log(`Total de facturas a procesar: ${totalToProcess}`);

			const mappingConfig = await this.fieldMappingService.getMappingConfig(holdingId, 'account.move', 'invoices_legacy');

			if (!mappingConfig) {
				throw new Error('No se encontró configuración de mapeo para facturas');
			}

			let processedCount = 0;
			let errorCount = 0;
			const details: Array<{ invoice_id: number; status: 'success' | 'error'; error?: string }> = [];

			for (let offset = 0; offset < totalToProcess; offset += batchSize) {
				this.logger.log(`Obteniendo lote de facturas: offset=${offset}, batchSize=${batchSize}`);

				// Obtener solo facturas que necesitan procesamiento (create o update)
				const invoicesBatch = await this.invoicesStgRepository.find({
					where: {
						holding_id: holdingId,
						processing_status: In(['create', 'update']),
					},
					order: { id: 'ASC' },
					take: batchSize,
					skip: offset,
				});

				this.logger.log(`Facturas obtenidas en este lote: ${invoicesBatch.length}`);

				for (const invoice of invoicesBatch) {
					try {
						await this.processInvoice(invoice, mappingConfig, holdingId);
						processedCount++;
						details.push({
							invoice_id: invoice.odoo_id,
							status: 'success',
						});

						// Marcar como procesada y limpiar error
						await this.invoicesStgRepository.update(invoice.id, {
							processing_status: 'processed',
							error_message: null,
						});
					} catch (error) {
						errorCount++;
						const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
						this.logger.error(`Error procesando factura ${invoice.odoo_id}:`, errorMessage);
						details.push({
							invoice_id: invoice.odoo_id,
							status: 'error',
							error: errorMessage,
						});

						await this.invoicesStgRepository.update(invoice.id, {
							processing_status: 'error',
							error_message: errorMessage,
						});
					}
				}

				this.logger.log(`Progreso: ${processedCount}/${totalToProcess} facturas procesadas`);
			}

			return {
				success: true,
				processed: processedCount,
				errors: errorCount,
				message: `Se procesaron ${processedCount} facturas exitosamente`,
				details,
			};
		} catch (error) {
			this.logger.error('Error en procesamiento de facturas:', error);
			throw error;
		}
	}

	private async processInvoice(invoice: OdooInvoicesStg, mappingConfig: any, holdingId: string): Promise<void> {
		try {
			const invoiceMappings = mappingConfig.invoice_mappings || {};
			const lineMappings = mappingConfig.line_mappings || {};

			const invoiceData = await this.fieldMappingService.applyFieldMappingToData(
				invoice.raw_data as Record<string, any>,
				invoiceMappings,
				'invoices_legacy',
				holdingId
			);

			// Los campos ya vienen con los nombres correctos desde el mapeo, no limpiar prefijos
			const finalInvoiceData: Record<string, any> = {
				...invoiceData,
				odoo_integration_id: invoice.odoo_id,
				holding_id: holdingId,
				source_type: 'erp_unmatched',
			};

			if (finalInvoiceData.status) {
				finalInvoiceData.status = this.fieldTransformationService.transformPaymentState(finalInvoiceData.status as string);
			}

			await this.upsertInvoiceLegacy(finalInvoiceData);

			const lines = await this.invoiceLinesStgRepository.find({
				where: {
					odoo_invoice_id: invoice.odoo_id,
					holding_id: holdingId,
				},
			});

			for (const line of lines) {
				try {
					await this.processInvoiceLine(line, invoice.odoo_id, lineMappings, holdingId);
					// Limpiar error_message si el procesamiento fue exitoso
					await this.invoiceLinesStgRepository.update(line.id, {
						error_message: null,
					});
				} catch (lineError) {
					const errorMessage = lineError instanceof Error ? lineError.message : 'Error desconocido en línea';
					this.logger.error(`Error procesando línea ${line.odoo_line_id}:`, errorMessage);
					await this.invoiceLinesStgRepository.update(line.id, {
						processing_status: 'error',
						error_message: errorMessage,
					});
					// No lanzar el error para que continúe procesando otras líneas
				}
			}

			await this.invoicesStgRepository.update(invoice.id, {
				processing_status: 'processed',
			});

			if (lines.length > 0) {
				const lineIds = lines.map((l) => l.id);
				await this.invoiceLinesStgRepository
					.createQueryBuilder()
					.update(OdooInvoiceLinesStg)
					.set({ processing_status: 'processed' })
					.whereInIds(lineIds)
					.execute();
			}
		} catch (error) {
			// Re-lanzar el error para que sea capturado en el nivel superior
			throw error;
		}
	}

	private async processInvoiceLine(line: OdooInvoiceLinesStg, invoiceOdooId: number, lineMappings: any, holdingId: string): Promise<void> {
		const legacyInvoice = await this.findLegacyInvoice(invoiceOdooId, holdingId);

		if (!legacyInvoice) {
			throw new Error(`No se encontró factura legacy para línea ${line.odoo_line_id}`);
		}

		const lineData = await this.fieldMappingService.applyFieldMappingToData(
			line.raw_data as Record<string, any>,
			lineMappings,
			'invoice_items_legacy',
			holdingId
		);

		// Los campos ya vienen con los nombres correctos desde el mapeo, no limpiar prefijos
		const finalLineData: Record<string, any> = {
			...lineData,
			invoices_legacy_id: legacyInvoice.id,
			holding_id: holdingId,
			odoo_line_id: line.odoo_line_id.toString(),
		};

		await this.upsertInvoiceItemLegacy(finalLineData, holdingId);
	}

	private async upsertInvoiceLegacy(data: Record<string, any>): Promise<void> {
		const keys = Object.keys(data);
		const values = Object.values(data);

		const query = `
			INSERT INTO invoices_legacy (${keys.join(', ')})
			VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})
			ON CONFLICT (holding_id, odoo_integration_id)
			DO UPDATE SET ${keys
				.filter((k) => k !== 'odoo_integration_id' && k !== 'holding_id')
				.map((k) => `${k} = EXCLUDED.${k}`)
				.join(', ')}
		`;

		await this.invoicesStgRepository.query(query, values);
	}

	private async upsertInvoiceItemLegacy(data: Record<string, any>, holdingId: string): Promise<void> {
		// Buscar línea existente por odoo_line_id (criterio correcto)
		let existingLine = await this.invoicesStgRepository.query(`SELECT * FROM invoice_items_legacy WHERE holding_id = $1 AND odoo_line_id = $2`, [
			holdingId,
			data.odoo_line_id,
		]);

		// Fallback: buscar por campos clave si no tiene odoo_line_id
		if (!existingLine || existingLine.length === 0) {
			existingLine = await this.invoicesStgRepository.query(
				`SELECT * FROM invoice_items_legacy 
				WHERE holding_id = $1 
				AND invoices_legacy_id = $2 
				AND description = $3 
				AND quantity = $4 
				AND total = $5`,
				[holdingId, data.invoices_legacy_id, data.description, data.quantity, data.total]
			);
		}

		if (existingLine && existingLine.length > 0) {
			// Comparar campos para ver si hay cambios
			const hasChanges = this.compareLineFields(data, existingLine[0]);

			if (hasChanges) {
				// Solo actualizar si hay cambios
				const keys = Object.keys(data).filter((k) => k !== 'id');
				const values = keys.map((k) => data[k]);
				const updateFields = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');

				await this.invoicesStgRepository.query(`UPDATE invoice_items_legacy SET ${updateFields} WHERE id = $1`, [
					existingLine[0].id,
					...values,
				]);
			}
			// Si no hay cambios, no hacer nada (optimización)
		} else {
			// Insertar nueva línea
			const keys = Object.keys(data);
			const values = Object.values(data);
			const query = `
				INSERT INTO invoice_items_legacy (${keys.join(', ')})
				VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})
			`;

			await this.invoicesStgRepository.query(query, values);
		}
	}

	/**
	 * Compara los campos de una línea para detectar cambios
	 */
	private compareLineFields(newData: Record<string, any>, existingData: Record<string, any>): boolean {
		for (const [key, newValue] of Object.entries(newData)) {
			// Saltar campos que no se deben comparar
			if (key === 'id' || key === 'created_at' || key === 'updated_at' || key === 'holding_id' || key === 'odoo_line_id') {
				continue;
			}

			const existingValue = existingData[key];

			if (!this.areValuesEqual(newValue, existingValue)) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Clasifica las facturas en staging según si necesitan crearse, actualizarse o ya están procesadas (método público)
	 */
	async classifyInvoicesPublic(holdingId: string): Promise<InvoiceClassification> {
		return this.classifyInvoices(holdingId);
	}

	/**
	 * Clasifica las facturas en staging según si necesitan crearse, actualizarse o ya están procesadas
	 */
	private async classifyInvoices(holdingId: string): Promise<InvoiceClassification> {
		const invoices = await this.invoicesStgRepository.find({
			where: { holding_id: holdingId },
			select: ['id', 'odoo_id', 'raw_data'],
		});

		let toCreate = 0;
		let toUpdate = 0;
		let alreadyProcessed = 0;

		for (const invoice of invoices) {
			const status = await this.classifySingleInvoice(invoice, holdingId);

			// Actualizar el processing_status en la BD
			await this.invoicesStgRepository.update(invoice.id, {
				processing_status: status === 'skip' ? 'processed' : status,
			});

			if (status === 'create') toCreate++;
			else if (status === 'update') toUpdate++;
			else alreadyProcessed++;
		}

		return {
			to_create: toCreate,
			to_update: toUpdate,
			already_processed: alreadyProcessed,
			total: invoices.length,
		};
	}

	/**
	 * Clasifica una sola factura comparando con invoices_legacy
	 */
	private async classifySingleInvoice(invoice: OdooInvoicesStg, holdingId: string): Promise<InvoiceStatus> {
		const odooIntegrationId = invoice.odoo_id;

		// Buscar factura existente por odoo_integration_id (el criterio correcto)
		const existing = await this.invoicesStgRepository.query(`SELECT * FROM invoices_legacy WHERE holding_id = $1 AND odoo_integration_id = $2`, [
			holdingId,
			odooIntegrationId,
		]);

		// Si no existe, es nueva
		if (!existing || existing.length === 0) {
			return 'create';
		}

		// Si existe, comparar campos mapeados para detectar cambios
		const hasChanges = await this.compareInvoiceFields(invoice, existing[0], holdingId);

		return hasChanges ? 'update' : 'skip';
	}

	/**
	 * Compara los campos mapeados de una factura en staging con la factura existente en legacy
	 */
	private async compareInvoiceFields(invoiceStg: OdooInvoicesStg, invoiceLegacy: any, holdingId: string): Promise<boolean> {
		try {
			// Obtener la configuración de mapeo
			const mappingConfig = await this.fieldMappingService.getMappingConfig(holdingId, 'account.move', 'invoices_legacy');

			if (!mappingConfig || !mappingConfig.invoice_mappings) {
				// Si no hay mapeo, asumir que hay cambios
				return true;
			}

			// Aplicar mapeo a los datos de staging para obtener los valores transformados
			const mappedData = await this.fieldMappingService.applyFieldMappingToData(
				invoiceStg.raw_data as Record<string, any>,
				mappingConfig.invoice_mappings,
				'invoices_legacy',
				holdingId
			);

			// Comparar cada campo mapeado
			for (const [fieldKey, mappedValue] of Object.entries(mappedData)) {
				// Saltar campos que no se deben comparar
				if (
					fieldKey === 'id' ||
					fieldKey === 'created_at' ||
					fieldKey === 'updated_at' ||
					fieldKey === 'holding_id' ||
					fieldKey === 'odoo_integration_id' ||
					fieldKey === 'source_type'
				) {
					continue;
				}

				const legacyValue = invoiceLegacy[fieldKey];

				// Comparar valores normalizados
				if (!this.areValuesEqual(mappedValue, legacyValue)) {
					this.logger.debug(`Campo '${fieldKey}' cambió: legacy='${legacyValue}' -> staging='${mappedValue}'`);
					return true;
				}
			}

			// No hay cambios
			return false;
		} catch (error) {
			this.logger.error('Error comparando campos de factura:', error);
			// En caso de error, asumir que hay cambios para no perder actualizaciones
			return true;
		}
	}

	/**
	 * Compara dos valores normalizando tipos y formatos
	 */
	private areValuesEqual(value1: any, value2: any): boolean {
		// Ambos null o undefined
		if (value1 == null && value2 == null) {
			return true;
		}

		// Uno null y otro no
		if (value1 == null || value2 == null) {
			return false;
		}

		// Normalizar strings vacíos y null
		const norm1 = value1 === '' ? null : value1;
		const norm2 = value2 === '' ? null : value2;

		if (norm1 == null && norm2 == null) {
			return true;
		}

		// Comparar fechas
		if (value1 instanceof Date || value2 instanceof Date) {
			const date1 = new Date(value1).getTime();
			const date2 = new Date(value2).getTime();
			return date1 === date2;
		}

		// Comparar números (incluyendo strings que son números)
		const num1 = Number(value1);
		const num2 = Number(value2);
		if (!isNaN(num1) && !isNaN(num2)) {
			// Comparar con tolerancia para decimales
			return Math.abs(num1 - num2) < 0.01;
		}

		// Comparar objetos y arrays
		if (typeof value1 === 'object' && typeof value2 === 'object') {
			return JSON.stringify(value1) === JSON.stringify(value2);
		}

		// Comparar strings (case-insensitive y trimmed)
		if (typeof value1 === 'string' && typeof value2 === 'string') {
			return value1.trim().toLowerCase() === value2.trim().toLowerCase();
		}

		// Comparación directa
		return value1 === value2;
	}

	private async findLegacyInvoice(odooIntegrationId: number, holdingId: string): Promise<{ id: string } | null> {
		const result = await this.invoicesStgRepository.query(`SELECT id FROM invoices_legacy WHERE odoo_integration_id = $1 AND holding_id = $2`, [
			odooIntegrationId,
			holdingId,
		]);

		return result && result.length > 0 ? result[0] : null;
	}

	async getProcessingStats(holdingId: string): Promise<{
		total: number;
		pending: number;
		processed: number;
		errors: number;
	}> {
		const [total, pending, processed, errors] = await Promise.all([
			this.invoicesStgRepository.count({ where: { holding_id: holdingId } }),
			this.invoicesStgRepository.count({
				where: { holding_id: holdingId, processing_status: In(['create', 'update']) },
			}),
			this.invoicesStgRepository.count({
				where: { holding_id: holdingId, processing_status: 'processed' },
			}),
			this.invoicesStgRepository.count({
				where: { holding_id: holdingId, processing_status: 'error' },
			}),
		]);

		return { total, pending, processed, errors };
	}

	async getStatusCounts(holdingId: string): Promise<{
		create: number;
		update: number;
		processed: number;
		error: number;
		null: number;
	}> {
		const [create, update, processed, error, nullCount] = await Promise.all([
			this.invoicesStgRepository.count({
				where: { holding_id: holdingId, processing_status: 'create' },
			}),
			this.invoicesStgRepository.count({
				where: { holding_id: holdingId, processing_status: 'update' },
			}),
			this.invoicesStgRepository.count({
				where: { holding_id: holdingId, processing_status: 'processed' },
			}),
			this.invoicesStgRepository.count({
				where: { holding_id: holdingId, processing_status: 'error' },
			}),
			this.invoicesStgRepository.count({
				where: { holding_id: holdingId, processing_status: IsNull() },
			}),
		]);

		return { create, update, processed, error, null: nullCount };
	}

	async getInvoicesWithLines(
		holdingId: string,
		searchTerm?: string,
		statusFilter?: string[],
		page: number = 1,
		limit: number = 20
	): Promise<{
		invoices: any[];
		total: number;
		page: number;
		limit: number;
		totalPages: number;
	}> {
		const queryBuilder = this.invoicesStgRepository
			.createQueryBuilder('invoice')
			.where('invoice.holding_id = :holdingId', { holdingId })
			.orderBy('invoice.created_at', 'DESC');

		// Aplicar filtro de búsqueda si existe
		if (searchTerm) {
			queryBuilder.andWhere(`(invoice.raw_data->>'name' ILIKE :searchTerm OR invoice.raw_data->>'ref' ILIKE :searchTerm)`, {
				searchTerm: `%${searchTerm}%`,
			});
		}

		// Aplicar filtro de estado si existe
		if (statusFilter && statusFilter.length > 0) {
			queryBuilder.andWhere('invoice.processing_status IN (:...statusFilter)', { statusFilter });
		}

		// Obtener conteo total
		const total = await queryBuilder.getCount();

		// Aplicar paginación
		const offset = (page - 1) * limit;
		queryBuilder.skip(offset).take(limit);

		// Obtener facturas
		const invoices = await queryBuilder.getMany();

		// Cargar líneas para cada factura
		const invoicesWithLines = await Promise.all(
			invoices.map(async (invoice) => {
				const lines = await this.invoiceLinesStgRepository.find({
					where: {
						odoo_invoice_id: invoice.odoo_id,
						holding_id: holdingId,
					},
					order: {
						created_at: 'ASC',
					},
				});

				return {
					...invoice,
					lines,
					lines_count: lines.length,
				};
			})
		);

		const totalPages = Math.ceil(total / limit);

		return {
			invoices: invoicesWithLines,
			total,
			page,
			limit,
			totalPages,
		};
	}

	async getSampleLines(
		holdingId: string,
		limit: number = 10
	): Promise<{
		lines: Array<{ raw_data: Record<string, any> }>;
		count: number;
	}> {
		const lines = await this.invoiceLinesStgRepository.find({
			where: { holding_id: holdingId },
			select: ['raw_data'],
			take: limit,
		});

		return {
			lines: lines.map((line) => ({ raw_data: line.raw_data })),
			count: lines.length,
		};
	}
}

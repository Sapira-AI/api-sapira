import { Inject, Injectable, Logger } from '@nestjs/common';
import { Connection, Model } from 'mongoose';
import { DataSource } from 'typeorm';

import { Invoice } from '@/databases/postgresql/entities/facturacion/invoice.entity';

import {
	DiagnosticoActualizacionesDto,
	DiagnosticoAvisosDto,
	DiagnosticoCorteDto,
	DiagnosticoFacturaDto,
	DiagnosticoHuecoDto,
	DiagnosticoPorDiaDto,
	DiagnosticoUltimoAvisoDto,
	OdooWebhookDiagnosticsDto,
	VeredictoAvisosOdoo,
} from './dtos/odoo-webhook-diagnostics.dto';
import { determinarEstadoSapira } from './helpers/odoo-invoice-status.helper';
import { OdooInvoiceUpdateLog, OdooInvoiceUpdateLogSchema } from './schemas/odoo-invoice-update-log.schema';
import { OdooWebhookLog, OdooWebhookLogSchema } from './schemas/odoo-webhook.schema';

/** Documento crudo de Mongo tal como lo devuelve `.lean()`: los modelos son `Model<any>`. */
type RegistroLogMongo = {
	createdAt?: Date | string;
	event_type?: string;
	model?: string;
	odoo_id?: number;
	payload?: any;
};

@Injectable()
export class OdooWebhookService {
	private readonly logger = new Logger(OdooWebhookService.name);
	private webhookLogModel: Model<any>;
	private invoiceUpdateLogModel: Model<any>;

	constructor(
		@Inject('DbConnectionToken') private connection: Connection,
		private readonly dataSource: DataSource
	) {
		this.webhookLogModel = this.connection.model(OdooWebhookLog.name, OdooWebhookLogSchema);
		this.invoiceUpdateLogModel = this.connection.model(OdooInvoiceUpdateLog.name, OdooInvoiceUpdateLogSchema);
	}

	/**
	 * Guarda el payload del webhook en MongoDB para análisis
	 */
	async saveWebhookLog(data: {
		event_type: string;
		model: string;
		payload: any;
		headers?: any;
		odoo_id?: number;
		holding_id?: string;
		connection_id?: string;
	}): Promise<any> {
		const webhookLog = new this.webhookLogModel({
			event_type: data.event_type,
			model: data.model,
			payload: data.payload,
			headers: data.headers,
			odoo_id: data.odoo_id,
			holding_id: data.holding_id,
			connection_id: data.connection_id,
			status: 'received',
		});

		return await webhookLog.save();
	}

	/**
	 * Reporte de la pierna de vuelta de la integración (Odoo → Sapira).
	 *
	 * La pierna de ida —Sapira crea, publica y emite la factura en Odoo— la cubren los
	 * `odoo_send_logs` del scheduler. La de vuelta no tenía forma de mirarse: el aviso de Odoo es
	 * la **única** fuente del folio (`invoice_number`) y del avance de estado, porque el scheduler
	 * escribe `odoo_invoice_id` y `status='Emitida'` pero nunca el folio.
	 *
	 * Cuando el folio no vuelve, la base se ve igual en los dos casos posibles —Odoo dejó de
	 * llamar, u Odoo llama y el webhook no puede aplicar el aviso—, así que este reporte cruza las
	 * tres fuentes que sí los distinguen y resuelve el triage en `veredicto`:
	 *
	 * - `odoo_webhook_logs` (Mongo): ¿llegó la llamada?
	 * - `odoo_invoice_update_logs` (Mongo): ¿tuvo efecto?
	 * - `invoices` (PostgreSQL): ¿qué quedó sin folio, y desde cuándo?
	 *
	 * ⚠️ Solo publica las **claves** del último payload, no sus valores: el payload de Odoo lleva
	 * datos del cliente y este reporte lo lee cualquier usuario autenticado.
	 */
	async getReturnLegDiagnostics(options: { dias?: number; holdingId?: string } = {}): Promise<OdooWebhookDiagnosticsDto> {
		const dias = Math.min(Math.max(Math.trunc(options.dias ?? 30) || 30, 1), 365);
		const generadoEn = new Date();
		const desde = new Date(generadoEn.getTime() - dias * 24 * 60 * 60 * 1000);
		const holdingId = options.holdingId || undefined;

		const [avisos, actualizaciones, hueco, corte] = await Promise.all([
			this.resumirAvisos(desde, generadoEn),
			this.resumirActualizaciones(desde),
			this.resumirFacturasSinFolio(desde, holdingId),
			this.ubicarCorte(holdingId),
		]);

		return {
			generado_en: generadoEn,
			desde,
			dias,
			holding_id: holdingId,
			veredicto: this.determinarVeredicto(avisos, actualizaciones, hueco),
			avisos_recibidos: avisos,
			actualizaciones_aplicadas: actualizaciones,
			facturas_sin_folio: hueco,
			corte,
		};
	}

	/**
	 * El árbol de triage en una palabra. El orden importa: sin hueco no hay incidente, y con hueco
	 * lo primero que hay que saber es si la llamada llega, porque eso decide si se revisa Odoo
	 * (automated action, URL, token) o la API (forma del payload).
	 */
	private determinarVeredicto(
		avisos: DiagnosticoAvisosDto,
		actualizaciones: DiagnosticoActualizacionesDto,
		hueco: DiagnosticoHuecoDto
	): VeredictoAvisosOdoo {
		if (hueco.total === 0) return 'ok';
		if (avisos.total_en_ventana === 0) return 'sin_avisos';
		if (actualizaciones.total_en_ventana === 0) return 'avisos_sin_efecto';
		return 'hueco_parcial';
	}

	private async resumirAvisos(desde: Date, ahora: Date): Promise<DiagnosticoAvisosDto> {
		const [totalHistorico, totalEnVentana, ultimo, porDia] = await Promise.all([
			this.webhookLogModel.countDocuments({}).exec(),
			this.webhookLogModel.countDocuments({ createdAt: { $gte: desde } }).exec(),
			this.ultimoRegistro(this.webhookLogModel, {}),
			this.agruparPorDia(this.webhookLogModel, { createdAt: { $gte: desde } }),
		]);

		const ultimoEn = ultimo?.createdAt ? new Date(ultimo.createdAt) : undefined;

		return {
			total_historico: totalHistorico,
			total_en_ventana: totalEnVentana,
			ultimo_en: ultimoEn,
			horas_sin_avisos: ultimoEn ? Math.floor((ahora.getTime() - ultimoEn.getTime()) / 3_600_000) : undefined,
			por_dia: porDia,
			ultimo_aviso: ultimo ? this.resumirUltimoAviso(ultimo) : undefined,
		};
	}

	/**
	 * Lee el payload igual que `extractInvoiceFields`, que es el punto: si acá
	 * `trae_x_sapira_invoice_id` sale en false, el webhook tampoco lo encontró y salió en silencio.
	 */
	private resumirUltimoAviso(log: RegistroLogMongo): DiagnosticoUltimoAvisoDto {
		const datos = log.payload?.payload || log.payload || {};

		return {
			recibido_en: new Date(log.createdAt as Date),
			event_type: log.event_type as string,
			model: log.model as string,
			odoo_id: log.odoo_id ?? undefined,
			trae_x_sapira_invoice_id: Boolean(datos.x_sapira_invoice_id),
			claves_payload: Object.keys(datos).sort(),
		};
	}

	/**
	 * Solo cuenta las que **se aplicaron** (`was_updated: true`). Las omitidas conviven en la misma
	 * colección y contarlas haría que `avisos_sin_efecto` nunca se dispare.
	 */
	private async resumirActualizaciones(desde: Date): Promise<DiagnosticoActualizacionesDto> {
		const aplicadas = { was_updated: true };

		const [totalHistorico, totalEnVentana, ultima, porDia] = await Promise.all([
			this.invoiceUpdateLogModel.countDocuments(aplicadas).exec(),
			this.invoiceUpdateLogModel.countDocuments({ ...aplicadas, createdAt: { $gte: desde } }).exec(),
			this.ultimoRegistro(this.invoiceUpdateLogModel, aplicadas),
			this.agruparPorDia(this.invoiceUpdateLogModel, { ...aplicadas, createdAt: { $gte: desde } }),
		]);

		return {
			total_historico: totalHistorico,
			total_en_ventana: totalEnVentana,
			ultima_en: ultima?.createdAt ? new Date(ultima.createdAt) : undefined,
			por_dia: porDia,
		};
	}

	private async ultimoRegistro(model: Model<any>, filtro: Record<string, any>): Promise<RegistroLogMongo | null> {
		const registro = await model.findOne(filtro).sort({ createdAt: -1 }).lean().exec();

		return (registro as RegistroLogMongo | null) ?? null;
	}

	private async agruparPorDia(model: Model<any>, filtro: Record<string, any>): Promise<DiagnosticoPorDiaDto[]> {
		const filas = await model
			.aggregate([
				{ $match: filtro },
				{ $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } }, cantidad: { $sum: 1 } } },
				{ $sort: { _id: 1 } },
			])
			.exec();

		return filas.map((fila: any) => ({ dia: fila._id, cantidad: Number(fila.cantidad) }));
	}

	/**
	 * El hueco: facturas que Sapira envió a Odoo (`odoo_invoice_id` presente) y que siguen sin
	 * folio. `sent_to_odoo_at` es la fecha con la que se fechan, porque es la que marca el envío;
	 * una factura sin esa fecha no se puede ubicar en el tiempo y queda fuera de la ventana.
	 */
	private async resumirFacturasSinFolio(desde: Date, holdingId?: string): Promise<DiagnosticoHuecoDto> {
		const LIMITE_IDS = 500;
		const filtro = `i.odoo_invoice_id IS NOT NULL
			  AND i.invoice_number IS NULL
			  AND i.sent_to_odoo_at >= $1
			  AND ($2::uuid IS NULL OR i.holding_id = $2::uuid)`;

		type FilaHueco = { dia: string; pais: string | null; status: string; cantidad: number };
		type FilaId = { odoo_invoice_id: string | number };

		const [porDia, ids] = await Promise.all([
			this.dataSource.query<FilaHueco[]>(
				`SELECT to_char(i.sent_to_odoo_at, 'YYYY-MM-DD') AS dia, co.country AS pais, i.status AS status, count(*)::int AS cantidad
				   FROM invoices i
				   LEFT JOIN companies co ON co.id = i.company_id
				  WHERE ${filtro}
				  GROUP BY 1, 2, 3
				  ORDER BY 1, 2, 3`,
				[desde, holdingId ?? null]
			),
			this.dataSource.query<FilaId[]>(
				`SELECT i.odoo_invoice_id
				   FROM invoices i
				  WHERE ${filtro}
				  ORDER BY i.sent_to_odoo_at
				  LIMIT $3`,
				[desde, holdingId ?? null, LIMITE_IDS + 1]
			),
		]);

		return {
			total: porDia.reduce((suma, fila) => suma + Number(fila.cantidad), 0),
			por_dia_y_pais: porDia.map((fila) => ({
				dia: fila.dia,
				pais: fila.pais ?? undefined,
				status: fila.status,
				cantidad: Number(fila.cantidad),
			})),
			odoo_invoice_ids: ids.slice(0, LIMITE_IDS).map((fila) => Number(fila.odoo_invoice_id)),
			lista_truncada: ids.length > LIMITE_IDS,
		};
	}

	/**
	 * Los dos bordes del corte, sin necesidad de ningún log.
	 *
	 * `status IN ('Enviada', 'Pagada')` identifica a las facturas cuyo aviso **sí** llegó: son los
	 * dos únicos estados que escribe `determineInvoiceStatus`, y el scheduler deja `Emitida`. Así
	 * que la última de esas, ordenada por `sent_to_odoo_at`, pone el corte al minuto.
	 */
	private async ubicarCorte(holdingId?: string): Promise<DiagnosticoCorteDto> {
		const COLUMNAS = `i.id, i.invoice_number, i.odoo_invoice_id, i.status, i.sent_to_odoo_at`;

		type FilaFactura = {
			id: string;
			invoice_number: string | null;
			odoo_invoice_id: string | number;
			status: string;
			sent_to_odoo_at: Date | null;
		};

		const [ultima] = await this.dataSource.query<FilaFactura[]>(
			`SELECT ${COLUMNAS}
			   FROM invoices i
			  WHERE i.odoo_invoice_id IS NOT NULL
				AND i.invoice_number IS NOT NULL
				AND i.status IN ('Enviada', 'Pagada')
				AND i.sent_to_odoo_at IS NOT NULL
				AND ($1::uuid IS NULL OR i.holding_id = $1::uuid)
			  ORDER BY i.sent_to_odoo_at DESC
			  LIMIT 1`,
			[holdingId ?? null]
		);

		const [primera] = await this.dataSource.query<FilaFactura[]>(
			`SELECT ${COLUMNAS}
			   FROM invoices i
			  WHERE i.odoo_invoice_id IS NOT NULL
				AND i.invoice_number IS NULL
				AND i.sent_to_odoo_at IS NOT NULL
				AND ($1::uuid IS NULL OR i.holding_id = $1::uuid)
				AND ($2::timestamptz IS NULL OR i.sent_to_odoo_at > $2::timestamptz)
			  ORDER BY i.sent_to_odoo_at
			  LIMIT 1`,
			[holdingId ?? null, ultima?.sent_to_odoo_at ?? null]
		);

		const aDto = (fila: FilaFactura): DiagnosticoFacturaDto => ({
			id: fila.id,
			invoice_number: fila.invoice_number ?? undefined,
			odoo_invoice_id: Number(fila.odoo_invoice_id),
			status: fila.status,
			sent_to_odoo_at: fila.sent_to_odoo_at ? new Date(fila.sent_to_odoo_at) : undefined,
		});

		return {
			ultima_con_aviso: ultima ? aDto(ultima) : undefined,
			primera_sin_aviso: primera ? aDto(primera) : undefined,
		};
	}

	/**
	 * Obtiene los logs de webhooks recibidos
	 */
	async getWebhookLogs(filters?: { event_type?: string; model?: string; holding_id?: string; status?: string; limit?: number }): Promise<any[]> {
		const query: any = {};

		if (filters?.event_type) {
			query.event_type = filters.event_type;
		}
		if (filters?.model) {
			query.model = filters.model;
		}
		if (filters?.holding_id) {
			query.holding_id = filters.holding_id;
		}
		if (filters?.status) {
			query.status = filters.status;
		}

		return await this.webhookLogModel
			.find(query)
			.sort({ createdAt: -1 })
			.limit(filters?.limit || 100)
			.exec();
	}

	/**
	 * Marca un webhook como procesado
	 */
	async markAsProcessed(webhookId: string): Promise<any> {
		return await this.webhookLogModel
			.findByIdAndUpdate(
				webhookId,
				{
					status: 'processed',
					processed_at: new Date(),
				},
				{ new: true }
			)
			.exec();
	}

	/**
	 * Marca un webhook con error
	 */
	async markAsError(webhookId: string, errorMessage: string): Promise<any> {
		return await this.webhookLogModel
			.findByIdAndUpdate(
				webhookId,
				{
					status: 'error',
					error_message: errorMessage,
					processed_at: new Date(),
				},
				{ new: true }
			)
			.exec();
	}

	/**
	 * Extrae campos relevantes del payload del webhook
	 */
	private extractInvoiceFields(payload: any) {
		const invoiceData = payload.payload || payload;

		return {
			sapiraInvoiceId: invoiceData.x_sapira_invoice_id,
			odooInvoiceId: invoiceData.id || invoiceData._id,
			state: invoiceData.state,
			paymentState: invoiceData.payment_state,
			amountTax: invoiceData.amount_tax !== undefined ? Number(invoiceData.amount_tax) : undefined,
			amountTotal: invoiceData.amount_total !== undefined ? Number(invoiceData.amount_total) : undefined,
			amountUntaxed: invoiceData.amount_untaxed !== undefined ? Number(invoiceData.amount_untaxed) : undefined,
			invoiceDate: invoiceData.invoice_date,
			invoiceName: invoiceData.name,
		};
	}

	/**
	 * Determina el nuevo estado de la factura basado en state y payment_state.
	 * La regla vive en `helpers/odoo-invoice-status.helper.ts`, compartida con el backfill.
	 */
	private determineInvoiceStatus(state: string, paymentState: string): string | null {
		return determinarEstadoSapira(state, paymentState);
	}

	/**
	 * Detecta cambios entre la factura actual y los nuevos datos
	 */
	private detectChanges(
		currentInvoice: Invoice,
		newData: {
			vat?: number;
			total_invoice_currency?: number;
			amount_invoice_currency?: number;
			issue_date?: Date;
			invoice_number?: string;
			status?: string;
			odoo_invoice_id?: number;
		}
	): { hasChanges: boolean; changedFields: string[]; oldValues: any; newValues: any } {
		const changedFields: string[] = [];
		const oldValues: any = {};
		const newValues: any = {};

		if (newData.vat !== undefined && Number(currentInvoice.vat) !== Number(newData.vat)) {
			changedFields.push('vat');
			oldValues.vat = currentInvoice.vat;
			newValues.vat = newData.vat;
		}

		if (
			newData.total_invoice_currency !== undefined &&
			Number(currentInvoice.total_invoice_currency) !== Number(newData.total_invoice_currency)
		) {
			changedFields.push('total_invoice_currency');
			oldValues.total_invoice_currency = currentInvoice.total_invoice_currency;
			newValues.total_invoice_currency = newData.total_invoice_currency;
		}

		if (
			newData.amount_invoice_currency !== undefined &&
			Number(currentInvoice.amount_invoice_currency) !== Number(newData.amount_invoice_currency)
		) {
			changedFields.push('amount_invoice_currency');
			oldValues.amount_invoice_currency = currentInvoice.amount_invoice_currency;
			newValues.amount_invoice_currency = newData.amount_invoice_currency;
		}

		if (newData.issue_date !== undefined) {
			// Normalizar fecha actual (puede ser Date o string)
			let currentDate: string | undefined;
			if (currentInvoice.issue_date) {
				const issueDate = currentInvoice.issue_date as any;
				if (typeof issueDate === 'string') {
					currentDate = issueDate.split('T')[0];
				} else if (issueDate instanceof Date) {
					currentDate = issueDate.toISOString().split('T')[0];
				} else {
					// Si es otro tipo, intentar convertir a string
					currentDate = String(issueDate).split('T')[0];
				}
			}

			// Normalizar nueva fecha
			const newDate = typeof newData.issue_date === 'string' ? newData.issue_date : newData.issue_date?.toISOString().split('T')[0];

			if (currentDate !== newDate) {
				changedFields.push('issue_date');
				oldValues.issue_date = currentDate;
				newValues.issue_date = newDate;
			}
		}

		if (newData.invoice_number !== undefined && currentInvoice.invoice_number !== newData.invoice_number) {
			changedFields.push('invoice_number');
			oldValues.invoice_number = currentInvoice.invoice_number;
			newValues.invoice_number = newData.invoice_number;
		}

		if (newData.status !== undefined && currentInvoice.status !== newData.status) {
			changedFields.push('status');
			oldValues.status = currentInvoice.status;
			newValues.status = newData.status;
		}

		if (newData.odoo_invoice_id !== undefined && currentInvoice.odoo_invoice_id !== newData.odoo_invoice_id) {
			changedFields.push('odoo_invoice_id');
			oldValues.odoo_invoice_id = currentInvoice.odoo_invoice_id;
			newValues.odoo_invoice_id = newData.odoo_invoice_id;
		}

		return {
			hasChanges: changedFields.length > 0,
			changedFields,
			oldValues,
			newValues,
		};
	}

	/**
	 * Guarda un log de actualización en MongoDB
	 */
	private async saveUpdateLog(data: {
		sapiraInvoiceId: string;
		odooInvoiceId: number;
		holdingId?: string;
		webhookPayload: any;
		wasUpdated: boolean;
		fieldsChanged?: string[];
		oldValues?: any;
		newValues?: any;
		skipReason?: string;
	}): Promise<void> {
		const log = new this.invoiceUpdateLogModel({
			sapira_invoice_id: data.sapiraInvoiceId,
			odoo_invoice_id: data.odooInvoiceId,
			holding_id: data.holdingId,
			webhook_payload: data.webhookPayload,
			was_updated: data.wasUpdated,
			fields_changed: data.fieldsChanged,
			old_values: data.oldValues,
			new_values: data.newValues,
			skip_reason: data.skipReason,
		});

		await log.save();
	}

	/**
	 * Procesa actualización de estado de factura cuando Odoo notifica que fue posted
	 * Sincroniza todos los campos relevantes y detecta cambios para evitar actualizaciones innecesarias
	 */
	async processInvoiceStatusUpdate(payload: any): Promise<{ updated: boolean; invoiceId?: string; message?: string; changedFields?: string[] }> {
		try {
			this.logger.debug('=== INICIO processInvoiceStatusUpdate ===');
			this.logger.debug(`Payload recibido: ${JSON.stringify(payload, null, 2)}`);

			// Validar que sea una factura (account.move)
			if (payload.model !== 'account.move' && payload._model !== 'account.move') {
				this.logger.warn(`No es una factura de Odoo. Model: ${payload.model || payload._model}`);
				return { updated: false, message: 'No es una factura de Odoo' };
			}

			// Extraer campos del payload
			const fields = this.extractInvoiceFields(payload);
			this.logger.debug(`Campos extraídos: ${JSON.stringify(fields, null, 2)}`);

			// Validaciones básicas
			if (!fields.sapiraInvoiceId) {
				this.logger.warn('No tiene x_sapira_invoice_id');
				return { updated: false, message: 'No tiene x_sapira_invoice_id' };
			}

			// Determinar el nuevo estado
			const newStatus = this.determineInvoiceStatus(fields.state, fields.paymentState);
			this.logger.debug(`Estado determinado: ${newStatus} (state: ${fields.state}, paymentState: ${fields.paymentState})`);

			if (!newStatus) {
				this.logger.warn(`Estado en Odoo es '${fields.state}', no 'posted'`);
				return { updated: false, message: `Estado en Odoo es '${fields.state}', no 'posted'` };
			}

			// Obtener repositorio de Invoice
			const invoiceRepository = this.dataSource.getRepository(Invoice);

			// Buscar la factura en PostgreSQL
			this.logger.debug(`Buscando factura con ID: ${fields.sapiraInvoiceId}`);
			const invoice = await invoiceRepository.findOne({
				where: { id: fields.sapiraInvoiceId },
			});

			if (!invoice) {
				this.logger.warn(`Factura con ID ${fields.sapiraInvoiceId} no encontrada en PostgreSQL`);

				// Guardar log de intento fallido
				await this.saveUpdateLog({
					sapiraInvoiceId: fields.sapiraInvoiceId,
					odooInvoiceId: fields.odooInvoiceId,
					webhookPayload: payload,
					wasUpdated: false,
					skipReason: 'Factura no encontrada en Sapira',
				});

				return { updated: false, message: `Factura ${fields.sapiraInvoiceId} no encontrada` };
			}

			this.logger.debug(`Factura encontrada: ${invoice.invoice_number || fields.sapiraInvoiceId}, Estado actual: ${invoice.status}`);

			// Preparar datos para actualizar
			const updateData: Partial<Invoice> = {
				status: newStatus,
				odoo_invoice_id: fields.odooInvoiceId,
			};

			// Agregar campos opcionales si existen en el payload
			if (fields.amountTax !== undefined) {
				updateData.vat = fields.amountTax;
			}
			if (fields.amountTotal !== undefined) {
				updateData.total_invoice_currency = fields.amountTotal;
			}
			if (fields.amountUntaxed !== undefined) {
				updateData.amount_invoice_currency = fields.amountUntaxed;
			}
			if (fields.invoiceDate) {
				// Guardar la fecha como string para evitar problemas de conversión UTC
				// PostgreSQL acepta strings en formato YYYY-MM-DD para campos de tipo date
				updateData.issue_date = fields.invoiceDate as any;
			}
			if (fields.invoiceName) {
				updateData.invoice_number = fields.invoiceName;
			}

			this.logger.debug(`Datos a actualizar: ${JSON.stringify(updateData, null, 2)}`);

			// Detectar cambios
			const changeDetection = this.detectChanges(invoice, updateData);
			this.logger.debug(`Detección de cambios: hasChanges=${changeDetection.hasChanges}, campos=${changeDetection.changedFields.join(', ')}`);

			// Decidir si actualizar
			let shouldUpdate = false;
			let skipReason: string | undefined;

			this.logger.debug(`Evaluando si actualizar: Estado actual='${invoice.status}', Nuevo estado='${newStatus}'`);

			if (newStatus === 'Pagada') {
				// Siempre actualizar si cambia a Pagada
				shouldUpdate = true;
				this.logger.debug('Decisión: ACTUALIZAR (cambio a Pagada)');
			} else if (invoice.status === 'Enviada' && newStatus === 'Enviada') {
				// Solo actualizar si hay cambios en otros campos
				if (changeDetection.hasChanges) {
					shouldUpdate = true;
					this.logger.debug('Decisión: ACTUALIZAR (ya Enviada pero hay cambios en campos)');
				} else {
					skipReason = 'Factura ya en estado Enviada sin cambios en campos';
					this.logger.debug('Decisión: NO ACTUALIZAR (ya Enviada sin cambios)');
				}
			} else {
				// Primera vez que se envía o cambio de estado
				shouldUpdate = true;
				this.logger.debug('Decisión: ACTUALIZAR (primera vez o cambio de estado)');
			}

			// Ejecutar actualización si es necesario
			if (shouldUpdate) {
				this.logger.debug(`Ejecutando actualización en PostgreSQL para factura ${fields.sapiraInvoiceId}`);

				const updateResult = await invoiceRepository.update(fields.sapiraInvoiceId, updateData);
				this.logger.debug(`Resultado de actualización: affected=${updateResult.affected}`);

				this.logger.log(
					`✓ Factura ${invoice.invoice_number || fields.sapiraInvoiceId} actualizada ` +
						`a estado '${newStatus}' desde webhook de Odoo (Odoo ID: ${fields.odooInvoiceId}). ` +
						`Campos actualizados: ${changeDetection.changedFields.join(', ')}`
				);

				// Guardar log de actualización exitosa
				this.logger.debug('Guardando log de actualización exitosa en MongoDB');
				await this.saveUpdateLog({
					sapiraInvoiceId: fields.sapiraInvoiceId,
					odooInvoiceId: fields.odooInvoiceId,
					holdingId: invoice.holding_id,
					webhookPayload: payload,
					wasUpdated: true,
					fieldsChanged: changeDetection.changedFields,
					oldValues: changeDetection.oldValues,
					newValues: changeDetection.newValues,
				});

				this.logger.debug('=== FIN processInvoiceStatusUpdate (actualización exitosa) ===');
				return {
					updated: true,
					invoiceId: fields.sapiraInvoiceId,
					message: `Factura actualizada a '${newStatus}'`,
					changedFields: changeDetection.changedFields,
				};
			} else {
				this.logger.log(`⊘ Factura ${invoice.invoice_number || fields.sapiraInvoiceId} no actualizada. Razón: ${skipReason}`);

				// Guardar log de actualización omitida
				this.logger.debug('Guardando log de actualización omitida en MongoDB');
				await this.saveUpdateLog({
					sapiraInvoiceId: fields.sapiraInvoiceId,
					odooInvoiceId: fields.odooInvoiceId,
					holdingId: invoice.holding_id,
					webhookPayload: payload,
					wasUpdated: false,
					skipReason,
				});

				this.logger.debug('=== FIN processInvoiceStatusUpdate (sin actualización) ===');
				return {
					updated: false,
					invoiceId: fields.sapiraInvoiceId,
					message: skipReason,
				};
			}
		} catch (error) {
			this.logger.error(`❌ Error procesando actualización de estado de factura:`, error);
			this.logger.error(`Stack trace: ${error.stack}`);
			this.logger.debug('=== FIN processInvoiceStatusUpdate (con error) ===');
			return {
				updated: false,
				message: `Error: ${error.message}`,
			};
		}
	}
}

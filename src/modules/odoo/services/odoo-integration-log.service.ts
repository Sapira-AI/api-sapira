import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { OdooIntegrationLog, OdooIntegrationLogDocument } from '../schemas/odoo-integration-log.schema';

export interface CreateOdooIntegrationLogDto {
	holding_id: string;
	integration_type: string;
	operation?: string;
	status?: string;
	source_table: string;
	target_table: string;
	records_processed?: number;
	records_success?: number;
	records_failed?: number;
	progress_total?: number;
	started_at?: Date;
	connection_id?: string;
	metadata?: any;
	user_id?: string;
	external_id?: string;
}

export interface UpdateOdooIntegrationLogDto {
	status?: string;
	records_processed?: number;
	records_success?: number;
	records_failed?: number;
	completed_at?: Date;
	execution_time_ms?: number;
	error_details?: any;
}

export interface JobStatusResponse {
	job_id: string;
	status: string;
	total_records: number;
	records_processed: number;
	records_success: number;
	records_failed: number;
	progress_percentage: number;
	execution_time_ms: number | null;
	started_at: Date;
	completed_at?: Date;
	error_details?: any;
}

@Injectable()
export class OdooIntegrationLogService {
	private readonly logger = new Logger(OdooIntegrationLogService.name);

	constructor(
		@InjectModel(OdooIntegrationLog.name)
		private readonly odooIntegrationLogModel: Model<OdooIntegrationLogDocument>
	) {}

	async createLog(dto: CreateOdooIntegrationLogDto): Promise<OdooIntegrationLogDocument> {
		try {
			const log = new this.odooIntegrationLogModel({
				...dto,
				status: dto.status || 'running',
				records_processed: dto.records_processed || 0,
				records_success: dto.records_success || 0,
				records_failed: dto.records_failed || 0,
				progress_total: dto.progress_total || 0,
				started_at: dto.started_at || new Date(),
			});

			return await log.save();
		} catch (error) {
			this.logger.error('Error creando log de integración:', error);
			throw error;
		}
	}

	async updateLog(logId: string, dto: UpdateOdooIntegrationLogDto): Promise<OdooIntegrationLogDocument | null> {
		try {
			return await this.odooIntegrationLogModel.findByIdAndUpdate(logId, { $set: dto }, { new: true }).exec();
		} catch (error) {
			this.logger.error('Error actualizando log de integración:', error);
			throw error;
		}
	}

	async getLogById(logId: string): Promise<OdooIntegrationLogDocument | null> {
		try {
			return await this.odooIntegrationLogModel.findById(logId).exec();
		} catch (error) {
			this.logger.error('Error obteniendo log de integración:', error);
			throw error;
		}
	}

	async getJobStatus(jobId: string): Promise<JobStatusResponse> {
		try {
			const integrationLog = await this.getLogById(jobId);

			if (!integrationLog) {
				throw new Error('Job no encontrado');
			}

			const progressPercentage = this.calculateProgressPercentage(
				integrationLog.records_processed || 0,
				integrationLog.progress_total || 0,
				integrationLog.status || 'running'
			);

			const executionTime = integrationLog.completed_at
				? new Date(integrationLog.completed_at).getTime() - new Date(integrationLog.started_at).getTime()
				: integrationLog.execution_time_ms || null;

			return {
				job_id: (integrationLog._id as any).toString(),
				status: integrationLog.status || 'running',
				total_records: integrationLog.progress_total || 0,
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
			this.logger.error('Error obteniendo estado del job:', error);
			throw error;
		}
	}

	async cancelJob(jobId: string, holdingId: string): Promise<void> {
		try {
			const integrationLog = await this.odooIntegrationLogModel.findOne({ _id: jobId, holding_id: holdingId }).exec();

			if (!integrationLog) {
				throw new Error('Job no encontrado');
			}

			if (integrationLog.status === 'completed' || integrationLog.status === 'failed') {
				throw new Error('El job ya finalizó');
			}

			await this.updateLog(jobId, {
				status: 'cancelled',
				completed_at: new Date(),
				error_details: { message: 'Cancelado por el usuario' },
			});
		} catch (error) {
			this.logger.error('Error cancelando job:', error);
			throw error;
		}
	}

	async isJobCancelled(jobId: string): Promise<boolean> {
		try {
			const job = await this.odooIntegrationLogModel.findById(jobId).select('status').exec();
			return job?.status === 'cancelled';
		} catch (error) {
			this.logger.error('Error verificando si job está cancelado:', error);
			return false;
		}
	}

	async getLogsByHolding(
		holdingId: string,
		filters?: {
			status?: string;
			integration_type?: string;
			limit?: number;
			skip?: number;
		}
	): Promise<OdooIntegrationLogDocument[]> {
		try {
			const query: any = { holding_id: holdingId };

			if (filters?.status) {
				query.status = filters.status;
			}

			if (filters?.integration_type) {
				query.integration_type = filters.integration_type;
			}

			return await this.odooIntegrationLogModel
				.find(query)
				.sort({ createdAt: -1 })
				.limit(filters?.limit || 100)
				.skip(filters?.skip || 0)
				.exec();
		} catch (error) {
			this.logger.error('Error obteniendo logs por holding:', error);
			throw error;
		}
	}

	private calculateProgressPercentage(processed: number, total: number, status: string): number {
		if (status === 'completed') return 100;
		if (status === 'failed' || status === 'cancelled') return 0;
		if (total === 0) return 0;
		return Math.round((processed / total) * 100);
	}
}

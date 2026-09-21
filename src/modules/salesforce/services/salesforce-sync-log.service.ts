import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';

import { SalesforceSchedulerJob, SalesforceSchedulerJobDocument } from '../schemas/salesforce-scheduler-job.schema';
import { SalesforceSyncLog, SalesforceSyncLogDocument, SalesforceSyncLogLevel, SalesforceSyncLogStage } from '../schemas/salesforce-sync-log.schema';

export interface SalesforceSyncLogContext {
	jobId: string;
	executionEnvironment: string;
}

export interface SalesforceSyncLogEntry {
	jobId: string;
	executionEnvironment: string;
	holdingId?: string;
	level?: SalesforceSyncLogLevel;
	stage: SalesforceSyncLogStage;
	message: string;
	salesforceOpportunityId?: string;
	salesforceOpportunityName?: string;
	salesforceAccountId?: string;
	processingStatus?: string;
	integrationNotes?: string;
	errorMessage?: string;
	errorStack?: string;
	batchId?: string;
	durationMs?: number;
	metadata?: Record<string, unknown>;
}

export interface SalesforceSyncLogQuery {
	holdingId?: string;
	executionEnvironment?: string;
	level?: SalesforceSyncLogLevel;
	stage?: SalesforceSyncLogStage;
	jobId?: string;
	salesforceOpportunityId?: string;
	dateFrom?: string;
	dateTo?: string;
	page?: number;
	limit?: number;
}

export interface SalesforceSyncJobQuery {
	holdingId?: string;
	executionEnvironment?: string;
	status?: string;
	page?: number;
	limit?: number;
}

/**
 * Bitácora de la sincronización automática de Salesforce en MongoDB.
 *
 * La escritura nunca interrumpe la sincronización: un fallo de la bitácora se
 * degrada a un log de aplicación para no perder oportunidades por un problema
 * de observabilidad.
 */
@Injectable()
export class SalesforceSyncLogService {
	private readonly logger = new Logger(SalesforceSyncLogService.name);

	constructor(
		@InjectModel(SalesforceSyncLog.name)
		private readonly syncLogModel: Model<SalesforceSyncLogDocument>,
		@InjectModel(SalesforceSchedulerJob.name)
		private readonly schedulerJobModel: Model<SalesforceSchedulerJobDocument>
	) {}

	async record(entry: SalesforceSyncLogEntry): Promise<void> {
		await this.recordMany([entry]);
	}

	async recordMany(entries: SalesforceSyncLogEntry[]): Promise<void> {
		if (!entries.length) {
			return;
		}

		try {
			await this.syncLogModel.insertMany(
				entries.map((entry) => ({
					...entry,
					level: entry.level || 'info',
					metadata: entry.metadata || {},
					occurredAt: new Date(),
				})),
				{ ordered: false }
			);
		} catch (error: any) {
			this.logger.error(`No se pudo escribir la bitácora de sincronización Salesforce: ${error.message}`);
		}
	}

	/**
	 * Registra el desenlace de un error preservando su mensaje y traza.
	 */
	async recordError(entry: Omit<SalesforceSyncLogEntry, 'level'>, error: unknown): Promise<void> {
		await this.record({
			...entry,
			level: 'error',
			errorMessage: error instanceof Error ? error.message : String(error),
			errorStack: error instanceof Error ? error.stack : undefined,
		});
	}

	async list(query: SalesforceSyncLogQuery): Promise<{
		items: SalesforceSyncLog[];
		total: number;
		page: number;
		limit: number;
	}> {
		const page = Math.max(1, Number(query.page) || 1);
		const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
		const filter: FilterQuery<SalesforceSyncLogDocument> = {};

		if (query.holdingId) filter.holdingId = query.holdingId;
		if (query.executionEnvironment) filter.executionEnvironment = query.executionEnvironment;
		if (query.level) filter.level = query.level;
		if (query.stage) filter.stage = query.stage;
		if (query.jobId) filter.jobId = query.jobId;
		if (query.salesforceOpportunityId) filter.salesforceOpportunityId = query.salesforceOpportunityId;
		if (query.dateFrom || query.dateTo) {
			filter.occurredAt = {
				...(query.dateFrom ? { $gte: new Date(query.dateFrom) } : {}),
				...(query.dateTo ? { $lte: new Date(query.dateTo) } : {}),
			};
		}

		const [items, total] = await Promise.all([
			this.syncLogModel
				.find(filter)
				.sort({ occurredAt: -1 })
				.skip((page - 1) * limit)
				.limit(limit)
				.lean<SalesforceSyncLog[]>()
				.exec(),
			this.syncLogModel.countDocuments(filter).exec(),
		]);

		return { items, total, page, limit };
	}

	async listJobs(query: SalesforceSyncJobQuery): Promise<{
		items: SalesforceSchedulerJob[];
		total: number;
		page: number;
		limit: number;
	}> {
		const page = Math.max(1, Number(query.page) || 1);
		const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
		const filter: FilterQuery<SalesforceSchedulerJobDocument> = {};

		if (query.executionEnvironment) filter.executionEnvironment = query.executionEnvironment;
		if (query.status) filter.status = query.status;
		if (query.holdingId) filter['holdingResults.holding_id'] = query.holdingId;

		const [items, total] = await Promise.all([
			this.schedulerJobModel
				.find(filter)
				.sort({ startedAt: -1 })
				.skip((page - 1) * limit)
				.limit(limit)
				.lean<SalesforceSchedulerJob[]>()
				.exec(),
			this.schedulerJobModel.countDocuments(filter).exec(),
		]);

		return { items, total, page, limit };
	}

	async getJob(jobId: string): Promise<SalesforceSchedulerJob | null> {
		return this.schedulerJobModel.findOne({ jobId }).lean<SalesforceSchedulerJob>().exec();
	}
}

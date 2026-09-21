import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SalesforceSyncLogDocument = SalesforceSyncLog & Document;

export type SalesforceSyncLogLevel = 'info' | 'warning' | 'error';

/**
 * Etapa de la sincronización automática en la que se produjo el evento.
 * - `run`: apertura y cierre de la corrida completa del scheduler.
 * - `holding`: apertura y cierre del tramo de un holding.
 * - `selection`: consulta SOQL que determina qué oportunidades entran a la corrida.
 * - `staging`: hidratación desde Salesforce y escritura en las tablas `*_stg`.
 * - `processing`: paso de staging hacia `clients`, `quotes` y `quote_items`.
 * - `opportunity`: resultado individual de una oportunidad al cierre del lote.
 */
export type SalesforceSyncLogStage = 'run' | 'holding' | 'selection' | 'staging' | 'processing' | 'opportunity';

export const SALESFORCE_SYNC_LOG_RETENTION_DAYS = 90;

@Schema({ timestamps: true, collection: 'salesforce_sync_logs' })
export class SalesforceSyncLog {
	@Prop({ required: true, index: true })
	jobId: string;

	@Prop({ required: false, index: true })
	holdingId?: string;

	@Prop({ required: true, index: true })
	executionEnvironment: string;

	@Prop({ required: true, enum: ['info', 'warning', 'error'], default: 'info' })
	level: SalesforceSyncLogLevel;

	@Prop({ required: true, enum: ['run', 'holding', 'selection', 'staging', 'processing', 'opportunity'] })
	stage: SalesforceSyncLogStage;

	@Prop({ required: true })
	message: string;

	@Prop({ required: false, index: true })
	salesforceOpportunityId?: string;

	@Prop({ required: false })
	salesforceOpportunityName?: string;

	@Prop({ required: false })
	salesforceAccountId?: string;

	@Prop({ required: false })
	processingStatus?: string;

	@Prop({ required: false })
	integrationNotes?: string;

	@Prop({ required: false })
	errorMessage?: string;

	@Prop({ required: false })
	errorStack?: string;

	@Prop({ required: false })
	batchId?: string;

	@Prop({ required: false })
	durationMs?: number;

	@Prop({ type: Object, default: {} })
	metadata: Record<string, unknown>;

	@Prop({ required: true, index: true, default: () => new Date() })
	occurredAt: Date;

	@Prop({
		type: Date,
		default: () => new Date(Date.now() + SALESFORCE_SYNC_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000),
		index: { expires: 0 },
	})
	expiresAt: Date;
}

export const SalesforceSyncLogSchema = SchemaFactory.createForClass(SalesforceSyncLog);

// Filtro principal expuesto en la API: holding + entorno de ejecución, ordenado por recencia.
SalesforceSyncLogSchema.index({ holdingId: 1, executionEnvironment: 1, occurredAt: -1 });
SalesforceSyncLogSchema.index({ holdingId: 1, level: 1, occurredAt: -1 });
SalesforceSyncLogSchema.index({ executionEnvironment: 1, occurredAt: -1 });
SalesforceSyncLogSchema.index({ jobId: 1, occurredAt: 1 });
SalesforceSyncLogSchema.index({ holdingId: 1, salesforceOpportunityId: 1, occurredAt: -1 });

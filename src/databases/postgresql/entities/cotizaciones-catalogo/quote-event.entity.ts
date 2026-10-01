import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';
import { QuoteStage } from '@/databases/postgresql/entities/cotizaciones-catalogo/quote-stage.entity';
import { Quote } from '@/databases/postgresql/entities/cotizaciones-catalogo/quote.entity';

/** Tipos de evento (mapa §8). La lista viva para la API: `src/modules/quotes/quote-status.ts` (`QUOTE_EVENT_TYPES`). */
export const QUOTE_EVENT_TYPE_VALUES = [
	'CREATED',
	'UPDATED',
	'SENT',
	'SIGNED',
	'LOST',
	'REOPENED',
	'STAGE_CHANGED',
	'DUPLICATED_FROM',
	'CONTRACT_CREATED',
	'APPLIED_TO_CONTRACT',
	'DELETED',
] as const;

/**
 * `quote_events` — historial de una cotización (Cotizaciones v2, `docs/v2-rediseno/mapa-v2-cotizaciones.md` §5a y §8): una fila por
 * creación, edición, transición de etapa, duplicado, vínculo con contrato y borrado, con usuario, etapa/kind antes y después, motivo y
 * metadata. Hoy no existe historial. NO es un espejo: tabla propia de api-sapira, creada por entity + migración
 * `1790650000000-QuotesV2`. RLS por holding con `rls/holding_access_quote_events.sql`.
 */
@Entity({ name: 'quote_events', comment: 'Historial de la cotización: creación, edición, transiciones, duplicado, contrato y borrado' })
@Index('idx_quote_events_quote_id', ['quote_id'])
@Index('idx_quote_events_holding_id', ['holding_id'])
@Check(
	'quote_events_type_check',
	`"type" = ANY (ARRAY['CREATED'::text, 'UPDATED'::text, 'SENT'::text, 'SIGNED'::text, 'LOST'::text, 'REOPENED'::text, 'STAGE_CHANGED'::text, 'DUPLICATED_FROM'::text, 'CONTRACT_CREATED'::text, 'APPLIED_TO_CONTRACT'::text, 'DELETED'::text])`
)
export class QuoteEvent {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'quote_events_pkey' })
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'uuid' })
	quote_id: string;

	@Column({
		type: 'text',
		comment: 'CREATED, UPDATED, SENT, SIGNED, LOST, REOPENED, STAGE_CHANGED, DUPLICATED_FROM, CONTRACT_CREATED, APPLIED_TO_CONTRACT o DELETED',
	})
	type: string;

	@Column({ type: 'uuid', nullable: true, comment: 'Etapa antes (NULL al crear)' })
	from_stage_id?: string | null;

	@Column({ type: 'uuid', nullable: true, comment: 'Etapa después (NULL al borrar)' })
	to_stage_id?: string | null;

	@Column({ type: 'text', nullable: true, comment: 'kind de la etapa antes' })
	from_kind?: string | null;

	@Column({ type: 'text', nullable: true, comment: 'kind de la etapa después' })
	to_kind?: string | null;

	@Column({ type: 'uuid', nullable: true, comment: 'users.id que ejecutó la acción (NULL si lo hizo un proceso)' })
	actor_id?: string | null;

	@Column({ type: 'text', nullable: true, comment: 'Motivo (obligatorio al marcar perdida)' })
	reason?: string | null;

	@Column({ type: 'jsonb', default: {}, comment: 'Antes/después, ítems tocados, contrato vinculado, número de cotización…' })
	metadata: Record<string, unknown>;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'quote_events_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => Quote, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'quote_id', referencedColumnName: 'id', foreignKeyConstraintName: 'quote_events_quote_id_fkey' })
	quote?: Quote;

	@ManyToOne(() => QuoteStage, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'from_stage_id', referencedColumnName: 'id', foreignKeyConstraintName: 'quote_events_from_stage_id_fkey' })
	fromStage?: QuoteStage;

	@ManyToOne(() => QuoteStage, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'to_stage_id', referencedColumnName: 'id', foreignKeyConstraintName: 'quote_events_to_stage_id_fkey' })
	toStage?: QuoteStage;

	@ManyToOne(() => User)
	@JoinColumn({ name: 'actor_id', referencedColumnName: 'id', foreignKeyConstraintName: 'quote_events_actor_id_fkey' })
	actor?: User;
}

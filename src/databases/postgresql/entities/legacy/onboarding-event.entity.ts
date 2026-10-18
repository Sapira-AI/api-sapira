import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';

/**
 * `onboarding_events` — registro de cambios del módulo `onboarding` (`docs/v2-rediseno/spec-onboarding-y-mrr-historico-v2.md` §3.5):
 * editar línea, empalmar, desvincular, no activar, reabrir, unificar y crear contrato desde un registro de MRR histórico; importar y revertir
 * facturas previas; arranque rápido. La escribe solo la API (`src/modules/onboarding`), en la misma transacción que el cambio.
 *
 * - `line_key`: raíz del registro de MRR histórico sin codificar (`batch_id|client_id|contract_currency`, Domi 18-10; el comentario de la
 *   columna en la base todavía dice `client_id|product_name|contract_currency`: cambiarlo es una migración y no afecta datos), si el evento es
 *   de un registro. Al unificar registros, los eventos de las raíces fusionadas se re-clavan a la raíz resultante.
 * - `entity_type` / `entity_id`: el registro afectado (`invoice_batch` = lote de importación, `client_entity`, `contract`, `invoice_legacy`).
 * - `type` sin CHECK a propósito: los tipos los define la API (`ONBOARDING_EVENT_TYPES`) y la entrega 2 agrega importadores.
 *
 * NO es un espejo: tabla propia de api-sapira, creada por entity + migración `1791900000000-OnboardingDatosHistoricos`. RLS por holding con
 * `rls/holding_access_onboarding_events.sql`.
 */
@Entity({
	name: 'onboarding_events',
	comment: 'Registro de cambios del onboarding de datos históricos (MRR histórico, facturas previas, arranque rápido). Solo la API escribe',
})
@Index('idx_onboarding_events_holding_created', ['holding_id', 'created_at'])
@Index('idx_onboarding_events_holding_line', ['holding_id', 'line_key'], { where: 'line_key IS NOT NULL' })
@Index('idx_onboarding_events_holding_entity', ['holding_id', 'entity_id'], { where: 'entity_id IS NOT NULL' })
export class OnboardingEvent {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'onboarding_events_pkey' })
	id!: string;

	@Column({ type: 'uuid' })
	holding_id!: string;

	@Column({ type: 'text', comment: 'Tipo de cambio (history_linked, previous_invoices_imported, quick_start_applied, …)' })
	type!: string;

	@Column({ type: 'text', nullable: true, comment: 'Línea de MRR histórico: client_id|product_name|contract_currency (sin codificar)' })
	line_key!: string | null;

	@Column({ type: 'text', nullable: true })
	entity_type!: string | null;

	@Column({ type: 'uuid', nullable: true })
	entity_id!: string | null;

	@Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
	payload!: Record<string, unknown>;

	@Column({ type: 'uuid', nullable: true })
	actor_id!: string | null;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at!: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'onboarding_events_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => User, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'actor_id', referencedColumnName: 'id', foreignKeyConstraintName: 'onboarding_events_actor_id_fkey' })
	actor?: User | null;
}

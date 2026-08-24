import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { User } from '@/modules/users/entities/user.entity';

/**
 * Espejo de `public.holding_fx_period_rates` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 71 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Tipos de cambio fijos por período configurados a nivel holding para conversión a moneda del sistema
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: update_holding_fx_period_rates_updated_at · BEFORE UPDATE FOR EACH ROW → update_updated_at_column(); validate_holding_fx_period_rates_trigger · BEFORE INSERT OR UPDATE FOR EACH ROW → validate_holding_fx_period_rates().
 * Policies (4): tenant_isolation_delete_holding_fx_period_rates (DELETE, public); tenant_isolation_insert_holding_fx_period_rates (INSERT, public); tenant_isolation_select_holding_fx_period_rates (SELECT, public); tenant_isolation_update_holding_fx_period_rates (UPDATE, public).
 */
@Entity('holding_fx_period_rates')
@Unique('holding_fx_period_rates_unique_period', ['holding_id', 'from_currency', 'to_currency', 'period_start', 'period_end'])
@Check('holding_fx_period_rates_period_check', 'period_end >= period_start')
@Check('holding_fx_period_rates_rate_check', 'rate > (0)::numeric')
@Index('idx_holding_fx_period_rates_currencies', ['from_currency', 'to_currency'])
@Index('idx_holding_fx_period_rates_holding', ['holding_id'])
@Index('idx_holding_fx_period_rates_period', ['period_start', 'period_end'])
export class HoldingFxPeriodRate {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'holding_fx_period_rates_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'text', nullable: false })
	from_currency: string;

	@Column({ type: 'text', nullable: false })
	to_currency: string;

	@Column({ type: 'numeric', nullable: false })
	rate: number;

	@Column({ type: 'date', nullable: false })
	period_start: Date;

	@Column({ type: 'date', nullable: false })
	period_end: Date;

	@Column({ type: 'text', nullable: true })
	notes?: string;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	updated_at: Date;

	@ManyToOne(() => User)
	@JoinColumn({ name: 'created_by', referencedColumnName: 'id', foreignKeyConstraintName: 'holding_fx_period_rates_created_by_fkey' })
	createdBy?: User; // entity existente (no se duplica)

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'holding_fx_period_rates_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)
}

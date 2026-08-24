import { Check, Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';

/**
 * Espejo de `public.holding_settings` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 4 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: trg_holding_settings_updated_at · BEFORE UPDATE FOR EACH ROW → update_updated_at_column().
 * Policies (4): holding_settings_delete (DELETE, public); holding_settings_insert (INSERT, public); holding_settings_select (SELECT, public); holding_settings_update (UPDATE, public).
 */
@Entity('holding_settings')
@Check('holding_settings_fx_system_policy_check', "fx_system_policy = ANY (ARRAY['fixed_period'::text, 'monthly_avg'::text])")
export class HoldingSettings {
	@PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'holding_settings_pkey' })
	holding_id: string;

	@Column({ type: 'text', nullable: false, default: 'USD' })
	system_currency: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	updated_at: Date;

	/** Política FX para conversión a moneda de sistema: fixed_period o monthly_avg */
	@Column({ type: 'text', nullable: true, default: 'monthly_avg' })
	fx_system_policy?: string;

	/** Monedas utilizadas en el holding */
	@Column({ type: 'text', array: true, nullable: true, default: () => 'ARRAY[]::text[]' })
	currencies_in_use?: string[];

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'holding_settings_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)
}

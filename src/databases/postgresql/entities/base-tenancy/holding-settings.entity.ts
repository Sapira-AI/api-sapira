import { Check, Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

/**
 * Entity de `public.holding_settings` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 4 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Desde el 2026-09-22 este archivo YA NO se regenera: es la fuente de verdad de su tabla y se edita a mano (entity → migración revisada → aplicar). El generador solo refresca el snapshot de prod contra el que su spec lo mide.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: trg_holding_settings_updated_at · BEFORE UPDATE FOR EACH ROW → update_updated_at_column().
 * Policies (4): holding_settings_delete (DELETE, public); holding_settings_insert (INSERT, public); holding_settings_select (SELECT, public); holding_settings_update (UPDATE, public).
 */
@Entity('holding_settings')
@Check('holding_settings_fx_system_policy_check', "fx_system_policy = ANY (ARRAY['fixed_period'::text, 'monthly_avg'::text])")
// Bloque Modificaciones B2 (migración 1790710000000-ContractModificationsBlock2): aviso previo de la renovación (S2-3).
@Check('holding_settings_auto_renewal_notice_days_check', '"auto_renewal_notice_days" >= 1 AND "auto_renewal_notice_days" <= 180')
// Configuración v2 ronda 4 (migración 1790850000000-HoldingSettingsPreferencesV4): preferencias del holding.
@Check('holding_settings_timezone_check', 'char_length("timezone") BETWEEN 1 AND 64')
@Check(
	'holding_settings_renewal_reminder_days_check',
	'cardinality("renewal_reminder_days") BETWEEN 1 AND 10 AND 0 <= ALL("renewal_reminder_days") AND 180 >= ALL("renewal_reminder_days")'
)
@Check('holding_settings_renewal_overdue_every_days_check', '"renewal_overdue_every_days" >= 1 AND "renewal_overdue_every_days" <= 90')
@Check('holding_settings_quote_numbering_mode_check', "\"quote_numbering_mode\" = ANY (ARRAY['prefixed'::text, 'sequential'::text, 'manual'::text])")
@Check('holding_settings_quote_number_prefix_check', `"quote_number_prefix" ~ '^[A-Za-z0-9]{1,10}$'`)
@Check('holding_settings_quote_number_width_check', '"quote_number_width" >= 1 AND "quote_number_width" <= 8')
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
	@Column({
		type: 'text',
		comment: 'Política FX para conversión a moneda de sistema: fixed_period o monthly_avg',
		nullable: true,
		default: 'monthly_avg',
	})
	fx_system_policy?: string;

	/** Monedas utilizadas en el holding */
	@Column({ type: 'text', comment: 'Monedas utilizadas en el holding', array: true, nullable: true, default: () => 'ARRAY[]::text[]' })
	currencies_in_use?: string[];

	/** Días de aviso previo de la propuesta de renovación automática (S2-3, spec modificaciones §9.3.5; default 30, 1–180). */
	@Column({
		type: 'smallint',
		comment: 'Días de aviso previo de la propuesta de renovación automática (S2-3; default 30)',
		nullable: false,
		default: 30,
	})
	auto_renewal_notice_days: number;

	/** Zona horaria IANA del holding: define el "hoy" de cierres, vencimientos, avisos y jobs (default America/Santiago). */
	@Column({ type: 'text', nullable: false, default: 'America/Santiago' })
	timezone: string;

	/** Recordatorios de vencimiento: días antes del fin, de mayor a menor (default 15,7,0; 0 = el día del fin). */
	@Column({ type: 'smallint', array: true, nullable: false, default: () => "'{15,7,0}'" })
	renewal_reminder_days: number[];

	/** Vencido sin decisión: un recordatorio cada N días (default 7). */
	@Column({ type: 'smallint', nullable: false, default: 7 })
	renewal_overdue_every_days: number;

	/** Numeración de cotizaciones creadas en Sapira: prefixed | sequential | manual (las del CRM conservan su número). */
	@Column({ type: 'text', nullable: false, default: 'prefixed' })
	quote_numbering_mode: string;

	@Column({ type: 'text', nullable: false, default: 'COT' })
	quote_number_prefix: string;

	@Column({ type: 'boolean', nullable: false, default: true })
	quote_number_include_year: boolean;

	@Column({ type: 'smallint', nullable: false, default: 4 })
	quote_number_width: number;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'holding_settings_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)
}

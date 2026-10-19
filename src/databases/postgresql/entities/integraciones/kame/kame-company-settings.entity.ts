import { Check, Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import { Company } from '@/databases/postgresql/entities/base-tenancy/companies.entity';
import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

import type { KameEnvironment } from './kame-connection.entity';

/**
 * `kame_company_settings` — cómo una compañía usa Kame: el ambiente activo (pruebas o producción, como la certificación SII) y los
 * interruptores de la compañía. Todo nace apagado y en simulación: el envío real se prende a conciencia.
 *
 * - `enabled`: la conexión de la compañía está activa (apagada, nada se encola ni se envía).
 * - `send_invoices` / `send_journal`: registrar en Kame las facturas emitidas en Sapira / los asientos de devengo de los meses cerrados.
 * - `dry_run`: simulación: se arma el cuerpo exacto y se guarda en `erp_exports` como `simulated`, sin llamar a Kame.
 * - `invoices_from` / `journal_from`: desde qué fecha de emisión / qué mes se envía; al pasar a producción se fijan para no mandar a la
 *   empresa real lo que se probó antes.
 *
 * El envío automático del holding es aparte (`holding_integration_settings`, `integration = 'kame'`, fila ausente = apagado). Entity +
 * migración `1792200000000-KameIntegration`; solo la API: RLS activo **sin policies**.
 */
@Entity({ name: 'kame_company_settings', comment: 'Uso de Kame por compañía: ambiente activo e interruptores de envío. Solo la API' })
@Check('kame_company_settings_environment_check', `active_environment = ANY (ARRAY['pruebas'::text, 'produccion'::text])`)
export class KameCompanySettings {
	@PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'kame_company_settings_pkey' })
	company_id!: string;

	@Column({ type: 'uuid' })
	holding_id!: string;

	@Column({ type: 'text', default: 'pruebas', comment: 'Ambiente al que se envía: pruebas o produccion' })
	active_environment!: KameEnvironment;

	@Column({ type: 'boolean', default: false, comment: 'Conexión de la compañía activa: apagada no se encola ni se envía nada' })
	enabled!: boolean;

	@Column({ type: 'boolean', default: false, comment: 'Registrar en Kame las facturas emitidas en Sapira' })
	send_invoices!: boolean;

	@Column({ type: 'boolean', default: false, comment: 'Enviar a Kame los asientos de devengo de los meses cerrados' })
	send_journal!: boolean;

	@Column({ type: 'boolean', default: true, comment: 'Simulación: arma y guarda el envío sin llamar a Kame' })
	dry_run!: boolean;

	@Column({ type: 'date', nullable: true, comment: 'Se registran las facturas emitidas desde esta fecha (null = desde que se activó)' })
	invoices_from?: string | null;

	@Column({ type: 'date', nullable: true, comment: 'Primer mes (día 1) cuyos asientos se envían' })
	journal_from?: string | null;

	@Column({ type: 'uuid', nullable: true, comment: 'Usuario (public.users.id) que la cambió por última vez' })
	updated_by?: string | null;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at!: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	updated_at!: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'kame_company_settings_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => Company, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'company_id', referencedColumnName: 'id', foreignKeyConstraintName: 'kame_company_settings_company_id_fkey' })
	company?: Company;
}

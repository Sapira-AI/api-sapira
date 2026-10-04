import { Check, Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

/**
 * Registros de las tablas intermedias que el usuario descartó ("no quiero importar esto"; Integraciones v2, I3
 * `1791000000000-IntegrationsV2`, contrato §3.5 bis). No toca la tabla intermedia ni su `processing_status` (tienen CHECK y la integración
 * los reescribe en cada carga). `record_key` = `external_id` del registro en la API. La escribe solo la API; RLS activo **sin policies**.
 */
@Entity({
	name: 'integration_record_discards',
	comment: 'Registros de tablas intermedias de integraciones descartados por el usuario (no se importan). Solo la API',
})
@Unique('integration_record_discards_key', ['holding_id', 'tipo', 'object', 'record_key'])
@Check('integration_record_discards_tipo_check', `tipo = ANY (ARRAY['erp'::text, 'crm'::text, 'stripe'::text, 'datos'::text])`)
export class IntegrationRecordDiscard {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'integration_record_discards_pkey' })
	id!: string;

	@Column({ type: 'uuid' })
	holding_id!: string;

	@Column({ type: 'text', comment: 'Tipo de integración: erp, crm, stripe o datos' })
	tipo!: string;

	@Column({ type: 'text', comment: 'Objeto del registro según la API (customer, opportunity, consumption…)' })
	object!: string;

	@Column({ type: 'text', comment: 'Identificador externo del registro (external_id en la API de Integraciones)' })
	record_key!: string;

	@Column({ type: 'text', nullable: true, comment: 'Motivo opcional del descarte' })
	reason?: string | null;

	@Column({ type: 'uuid', nullable: true, comment: 'Usuario (public.users.id) que lo descartó' })
	discarded_by?: string | null;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at!: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'integration_record_discards_holding_id_fkey' })
	holding?: CompanyHolding;
}

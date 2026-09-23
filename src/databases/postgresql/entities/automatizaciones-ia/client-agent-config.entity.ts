import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';
import { Client } from '@/databases/postgresql/entities/clientes/client.entity';

/**
 * Entity de `public.client_agent_configs` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Desde el 2026-09-22 este archivo YA NO se regenera: es la fuente de verdad de su tabla y se edita a mano (entity → migración revisada → aplicar). El generador solo refresca el snapshot de prod contra el que su spec lo mide.
 * Configuración de automatizaciones (agentes) por cliente. Permite personalizar estrategias de proforma y cobranza para cada cliente.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: trigger_update_client_agent_configs_updated_at · BEFORE UPDATE FOR EACH ROW → update_client_agent_configs_updated_at(); trigger_validate_client_agent_config_email_sender · BEFORE INSERT OR UPDATE FOR EACH ROW → validate_client_agent_config_email_sender().
 * Policies (4): Users can create client agent configs for their holding (INSERT, public); Users can delete client agent configs of their holding (DELETE, public); Users can update client agent configs of their holding (UPDATE, public); Users can view client agent configs of their holding (SELECT, public).
 */
@Entity({
	name: 'client_agent_configs',
	comment: 'Configuración de automatizaciones (agentes) por cliente. Permite personalizar estrategias de proforma y cobranza para cada cliente.',
})
@Unique('client_agent_configs_holding_id_client_id_agent_type_key', ['holding_id', 'client_id', 'agent_type'])
@Check('client_agent_configs_agent_type_check', "agent_type = ANY (ARRAY['proforma'::text, 'collections'::text])")
@Index('idx_client_agent_configs_agent_type', ['agent_type', 'is_enabled'])
@Index('idx_client_agent_configs_enabled', ['is_enabled'], { where: 'is_enabled = true' })
@Index('idx_client_agent_configs_holding_client', ['holding_id', 'client_id'])
@Index('idx_client_agent_configs_holding_global', ['holding_id', 'agent_type'], { unique: true, where: 'client_id IS NULL' })
@Index('idx_client_agent_configs_holding_type', ['holding_id', 'agent_type'])
export class ClientAgentConfig {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'client_agent_configs_pkey' })
	id: string;

	/** ID del holding al que pertenece la configuración */
	@Column({ type: 'uuid', comment: 'ID del holding al que pertenece la configuración', nullable: false })
	holding_id: string;

	/** ID del cliente. NULL indica configuración global del holding que aplica a todos los clientes sin configuración personalizada. */
	@Column({
		type: 'uuid',
		comment: 'ID del cliente. NULL indica configuración global del holding que aplica a todos los clientes sin configuración personalizada.',
		nullable: true,
	})
	client_id?: string;

	/** Tipo de agente: proforma (solicitud de referencias) o collections (cobranzas) */
	@Column({ type: 'text', comment: 'Tipo de agente: proforma (solicitud de referencias) o collections (cobranzas)', nullable: false })
	agent_type: string;

	/** Si está deshabilitado (false), el cliente no recibirá automatizaciones de este tipo */
	@Column({
		type: 'boolean',
		comment: 'Si está deshabilitado (false), el cliente no recibirá automatizaciones de este tipo',
		nullable: false,
		default: true,
	})
	is_enabled: boolean;

	/** Configuración específica en formato JSON. Para proformas: days_before_issue, email_sender_address_id, etc. Para cobranzas: days_overdue_bucket_1, frequency_bucket_1, email_sender_address_id, etc. */
	@Column({
		type: 'jsonb',
		comment:
			'Configuración específica en formato JSON. Para proformas: days_before_issue, email_sender_address_id, etc. Para cobranzas: days_overdue_bucket_1, frequency_bucket_1, email_sender_address_id, etc.',
		nullable: false,
		default: '{}',
	})
	config_json: any;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	updated_at: Date;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string;

	@ManyToOne(() => Client, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'client_id', referencedColumnName: 'id', foreignKeyConstraintName: 'client_agent_configs_client_id_fkey' })
	client?: Client; // entity existente (no se duplica)

	@ManyToOne(() => User)
	@JoinColumn({ name: 'created_by', referencedColumnName: 'id', foreignKeyConstraintName: 'client_agent_configs_created_by_fkey' })
	createdBy?: User; // entity existente (no se duplica)

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'client_agent_configs_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)
}

import { Check, Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';

/**
 * `holding_inbound_email_domains` — dominio de recepción de documentos tributarios del holding (intercambio SII): un subdominio con
 * MX hacia SendGrid (Inbound Parse) y autenticado en SendGrid para responder desde él. Las casillas de intercambio de sus compañías
 * (`siiContactEmail` en api-factura) son de este dominio. Uno por holding.
 *
 * NO es un espejo: tabla propia de api-sapira, creada por entity + migración `1792000000000-CreateHoldingInboundEmailDomains`. Tabla
 * aparte de `holding_email_sender_settings` (dominios de envío) para que la pestaña Comunicaciones existente no dependa de esta
 * migración. RLS por holding con `rls/holding_access_holding_inbound_email_domains.sql`.
 */
@Entity({ name: 'holding_inbound_email_domains', comment: 'Dominio de recepción de DTE del holding (MX hacia SendGrid Inbound Parse)' })
@Unique('holding_inbound_email_domains_holding_id_key', ['holding_id'])
@Unique('holding_inbound_email_domains_inbound_domain_key', ['inbound_domain'])
@Check('holding_inbound_email_domains_status_check', `"domain_status" = ANY (ARRAY['pending'::text, 'verified'::text])`)
export class HoldingInboundEmailDomain {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'holding_inbound_email_domains_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	/** Subdominio de recepción, en minúsculas (ej: dte.miempresa.cl) */
	@Column({ type: 'text', comment: 'Subdominio de recepción, en minúsculas (ej: dte.miempresa.cl)', nullable: false })
	inbound_domain: string;

	/** ID del dominio autenticado en SendGrid (para responder desde las casillas) */
	@Column({ type: 'text', comment: 'ID del dominio autenticado en SendGrid (para responder desde las casillas)', nullable: true })
	sendgrid_domain_id?: string;

	/** pending o verified: verified cuando el MX y los CNAME de autenticación están puestos */
	@Column({
		type: 'text',
		comment: 'pending o verified: verified cuando el MX y los CNAME de autenticación están puestos',
		nullable: false,
		default: 'pending',
	})
	domain_status: string;

	/** Registros DNS a publicar: MX hacia SendGrid y los CNAME de autenticación, con su estado */
	@Column({ type: 'jsonb', comment: 'Registros DNS a publicar: MX hacia SendGrid y los CNAME de autenticación, con su estado', nullable: true })
	dns_records?: unknown;

	@Column({ type: 'timestamp with time zone', nullable: true })
	mx_verified_at?: Date;

	@Column({ type: 'timestamp with time zone', nullable: true })
	domain_verified_at?: Date;

	/** Cuándo se creó el Inbound Parse en SendGrid (apunta al webhook de api-factura) */
	@Column({
		type: 'timestamp with time zone',
		comment: 'Cuándo se creó el Inbound Parse en SendGrid (apunta al webhook de api-factura)',
		nullable: true,
	})
	inbound_parse_configured_at?: Date;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	updated_at: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'holding_inbound_email_domains_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => User)
	@JoinColumn({ name: 'created_by', referencedColumnName: 'id', foreignKeyConstraintName: 'holding_inbound_email_domains_created_by_fkey' })
	createdBy?: User;
}

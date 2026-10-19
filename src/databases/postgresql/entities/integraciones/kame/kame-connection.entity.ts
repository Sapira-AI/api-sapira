import { Check, Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { Company } from '@/databases/postgresql/entities/base-tenancy/companies.entity';
import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

/** Ambientes de una compañía en Kame: Kame no tiene sandbox, así que «pruebas» es otra empresa (con su propia credencial) en la misma API. */
export const KAME_ENVIRONMENTS = ['pruebas', 'produccion'] as const;
export type KameEnvironment = (typeof KAME_ENVIRONMENTS)[number];

/**
 * `kame_connections` — credencial de Kame (ERP contable) de una compañía en un ambiente. Kame entrega un client ID y secret por
 * empresa (RUT), por eso la conexión es por compañía y no por holding como Odoo. Dos filas como máximo por compañía: pruebas (la
 * empresa de pruebas que da Kame) y producción (la empresa real); cuál se usa lo dice `kame_company_settings.active_environment`.
 *
 * El secret se guarda cifrado (`EncryptionService`, aes-256-cbc con `ENCRYPTION_KEY`) y nunca sale de la API: el front ve
 * `has_secret` y los últimos 4 caracteres. Tabla propia de api-sapira (entity + migración `1792200000000-KameIntegration`); la usa
 * solo la API: RLS activo **sin policies**.
 */
@Entity({ name: 'kame_connections', comment: 'Credencial de Kame de una compañía por ambiente (pruebas o producción). Solo la API' })
@Unique('kame_connections_company_environment_key', ['company_id', 'environment'])
@Check('kame_connections_environment_check', `environment = ANY (ARRAY['pruebas'::text, 'produccion'::text])`)
export class KameConnection {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'kame_connections_pkey' })
	id!: string;

	@Column({ type: 'uuid' })
	holding_id!: string;

	@Column({ type: 'uuid' })
	company_id!: string;

	@Column({ type: 'text', comment: 'pruebas (empresa de pruebas de Kame) o produccion (la empresa real)' })
	environment!: KameEnvironment;

	@Column({ type: 'text', comment: 'Client ID de la API de Kame (datos de empresa en Kame)' })
	client_id!: string;

	@Column({ type: 'text', comment: 'Client secret cifrado con EncryptionService (iv:hex). Nunca se devuelve al front' })
	client_secret_encrypted!: string;

	@Column({ type: 'text', comment: 'Correo de un usuario de la empresa en Kame: va en el campo Usuario de cada envío' })
	user_email!: string;

	@Column({ type: 'text', comment: 'RUT de la empresa en Kame (sin puntos, con guion): resguardo contra enviar a otra empresa' })
	kame_company_rut!: string;

	@Column({ type: 'text', nullable: true, comment: 'Unidad de negocio de Kame (centro de costo) para las líneas de venta y los asientos' })
	business_unit?: string | null;

	@Column({ type: 'text', nullable: true, comment: 'Sucursal de Kame; vacía = casa matriz' })
	branch?: string | null;

	@Column({ type: 'timestamp with time zone', nullable: true, comment: 'Última prueba de conexión exitosa' })
	tested_at?: Date | null;

	@Column({ type: 'text', nullable: true, comment: 'Error de la última prueba de conexión (null si salió bien)' })
	test_error?: string | null;

	@Column({ type: 'uuid', nullable: true, comment: 'Usuario (public.users.id) que la cambió por última vez' })
	updated_by?: string | null;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at!: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	updated_at!: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'kame_connections_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => Company, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'company_id', referencedColumnName: 'id', foreignKeyConstraintName: 'kame_connections_company_id_fkey' })
	company?: Company;
}

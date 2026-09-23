import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Entity de `public.reference_requests` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Desde el 2026-09-22 este archivo YA NO se regenera: es la fuente de verdad de su tabla y se edita a mano (entity → migración revisada → aplicar). El generador solo refresca el snapshot de prod contra el que su spec lo mide.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (2): Reference requests - manage own holding (ALL, public); Reference requests - select own holding (SELECT, public).
 */
@Entity('reference_requests')
@Check('reference_requests_reference_type_check', "reference_type = ANY (ARRAY['OC'::text, 'HES'::text, 'Aceptación'::text])")
@Check('reference_requests_status_check', "status = ANY (ARRAY['requested'::text, 'received'::text, 'rejected'::text])")
@Index('reference_requests_holding_idx', ['holding_id', 'contract_id', 'invoice_id'])
export class ReferenceRequest {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'reference_requests_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'uuid', nullable: false })
	contract_id: string;

	@Column({ type: 'uuid', nullable: true })
	invoice_id?: string;

	@Column({ type: 'text', nullable: false })
	reference_type: string;

	@Column({ type: 'text', nullable: false })
	status: string;

	@Column({ type: 'text', nullable: true })
	file_url?: string;

	@Column({ type: 'text', nullable: true })
	note?: string;

	@Column({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	requested_at: Date;

	@Column({ type: 'timestamp with time zone', nullable: true })
	received_at?: Date;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;
}

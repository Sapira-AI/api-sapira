import { Check, Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { Company } from '@/databases/postgresql/entities/base-tenancy/companies.entity';

/**
 * Entity de `public.revenue_rules` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Sigue siendo un archivo GENERADO por `scripts/espejo/generate-espejo.py`: lo que se edite a mano se pierde en la próxima regeneración.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (4): Users can delete revenue rules from their holding companies (DELETE, public); Users can insert revenue rules for their holding companies (INSERT, public); Users can update revenue rules from their holding companies (UPDATE, public); Users can view revenue rules from their holding companies (SELECT, public).
 */
@Entity('revenue_rules')
@Check('revenue_rules_target_type_check', "target_type = ANY (ARRAY['Producto'::text, 'Contrato'::text])")
export class RevenueRule {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'revenue_rules_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: true })
	company_id?: string;

	@Column({ type: 'text', nullable: true })
	target_type?: string;

	@Column({ type: 'text', nullable: true })
	target_name?: string;

	@Column({ type: 'text', nullable: true })
	method?: string;

	@CreateDateColumn({ type: 'timestamp without time zone', nullable: true, default: () => 'now()' })
	created_at?: Date;

	@ManyToOne(() => Company)
	@JoinColumn({ name: 'company_id', referencedColumnName: 'id', foreignKeyConstraintName: 'revenue_rules_company_id_fkey' })
	company?: Company; // entity existente (no se duplica)
}

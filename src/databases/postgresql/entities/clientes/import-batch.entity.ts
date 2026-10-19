import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';

/** Entidades que admiten importar para actualizar. Hoy solo clientes comerciales (Domi 19-10); el motor único de import suma las demás. */
export const IMPORT_BATCH_ENTITY_TYPES = ['client'] as const;
export type ImportBatchEntityType = (typeof IMPORT_BATCH_ENTITY_TYPES)[number];

/**
 * `import_batches` — un lote de "Importar para actualizar" (Clientes › Importar › Actualizar, Domi 19-10): qué entidad, con qué clave se
 * buscó cada fila, qué campos venían mapeados en la planilla y el resultado (actualizadas, sin cambios, no encontradas, ambiguas, con error).
 * Sus filas (`import_batch_rows`) guardan el valor anterior y el nuevo de cada campo para poder **revertir** el lote.
 *
 * Tabla genérica a propósito: `entity_type` y `key_field` son texto para que el motor único de import (contratos por Excel, razones
 * sociales) reutilice las dos tablas sin migración. NO es un espejo: tabla propia de api-sapira, creada por entity + migración
 * `1792200000000-CreateImportBatches`. RLS por holding con `rls/holding_access_import_batches.sql`.
 */
@Entity({ name: 'import_batches', comment: 'Lotes de "Importar para actualizar" (clientes; genérico para otras entidades). Solo la API escribe' })
@Index('idx_import_batches_holding_created', ['holding_id', 'created_at'])
@Check('import_batches_entity_type_check', `entity_type = ANY (ARRAY['client'::text])`)
export class ImportBatch {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'import_batches_pkey' })
	id!: string;

	@Column({ type: 'uuid' })
	holding_id!: string;

	@Column({ type: 'text', comment: 'Entidad actualizada: client (clientes comerciales)' })
	entity_type!: ImportBatchEntityType;

	@Column({ type: 'text', nullable: true, comment: 'Nombre del lote (por defecto, el archivo subido)' })
	label!: string | null;

	@Column({ type: 'text', comment: 'Con qué se buscó cada fila: client_number | tax_id' })
	key_field!: string;

	@Column({ type: 'jsonb', default: () => `'[]'::jsonb`, comment: 'Campos mapeados en la planilla (los únicos que se actualizan)' })
	fields!: string[];

	@Column({ type: 'integer', default: 0 })
	rows_total!: number;

	@Column({ type: 'integer', default: 0, comment: 'Filas que cambiaron al menos un campo' })
	updated_count!: number;

	@Column({ type: 'integer', default: 0, comment: 'Filas sin cambios, no encontradas o ambiguas' })
	skipped_count!: number;

	@Column({ type: 'integer', default: 0, comment: 'Filas con error de validación' })
	failed_count!: number;

	@Column({ type: 'uuid', nullable: true })
	created_by!: string | null;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at!: Date;

	@Column({ type: 'timestamp with time zone', nullable: true, comment: 'Cuándo se revirtió el lote (NULL = vigente)' })
	reverted_at!: Date | null;

	@Column({ type: 'uuid', nullable: true })
	reverted_by!: string | null;

	@Column({ type: 'jsonb', nullable: true, comment: 'Resumen de la reversión: { restored_rows, kept_rows, kept_fields }' })
	reverted_summary!: Record<string, unknown> | null;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'import_batches_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => User, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'created_by', referencedColumnName: 'id', foreignKeyConstraintName: 'import_batches_created_by_fkey' })
	creator?: User | null;

	@ManyToOne(() => User, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'reverted_by', referencedColumnName: 'id', foreignKeyConstraintName: 'import_batches_reverted_by_fkey' })
	reverter?: User | null;
}

import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

import { ImportBatch } from './import-batch.entity';

/** Resultado de una fila del lote. `updated` es la única que escribió (y la única que revierte). */
export const IMPORT_BATCH_ROW_STATUSES = ['updated', 'unchanged', 'not_found', 'ambiguous', 'failed'] as const;
export type ImportBatchRowStatus = (typeof IMPORT_BATCH_ROW_STATUSES)[number];

/**
 * `import_batch_rows` — una fila de la planilla dentro de un lote de "Importar para actualizar": a qué registro llegó (`entity_id`, NULL si no
 * se encontró), con qué valor de clave, qué pasó y, si actualizó, el valor **anterior** (`before`) y el **nuevo** (`after`) de cada campo
 * cambiado. Revertir restaura `before` solo en los campos cuyo valor actual sigue siendo `after` (Domi 19-10): los que alguien editó después
 * quedan en `kept_fields`.
 *
 * NO es un espejo: tabla propia de api-sapira (migración `1792200000000-CreateImportBatches`). RLS por holding con
 * `rls/holding_access_import_batch_rows.sql`.
 */
@Entity({ name: 'import_batch_rows', comment: 'Filas de un lote de "Importar para actualizar": registro, estado y valores antes/después' })
@Index('idx_import_batch_rows_batch', ['batch_id'])
@Index('idx_import_batch_rows_holding_entity', ['holding_id', 'entity_id'], { where: 'entity_id IS NOT NULL' })
@Check(
	'import_batch_rows_status_check',
	`status = ANY (ARRAY['updated'::text, 'unchanged'::text, 'not_found'::text, 'ambiguous'::text, 'failed'::text])`
)
export class ImportBatchRow {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'import_batch_rows_pkey' })
	id!: string;

	@Column({ type: 'uuid' })
	batch_id!: string;

	@Column({ type: 'uuid' })
	holding_id!: string;

	@Column({ type: 'integer', comment: 'Fila en la planilla (la 1 son los encabezados)' })
	row!: number;

	@Column({ type: 'text', comment: 'Valor de la clave en la planilla (N° cliente o RUT)' })
	key_value!: string;

	@Column({ type: 'uuid', nullable: true, comment: 'Registro encontrado (clients.id); NULL si no se encontró o fue ambiguo' })
	entity_id!: string | null;

	@Column({ type: 'text', comment: 'updated | unchanged | not_found | ambiguous | failed' })
	status!: ImportBatchRowStatus;

	@Column({ type: 'jsonb', default: () => `'{}'::jsonb`, comment: 'Valor anterior de cada campo cambiado' })
	before!: Record<string, unknown>;

	@Column({ type: 'jsonb', default: () => `'{}'::jsonb`, comment: 'Valor nuevo de cada campo cambiado' })
	after!: Record<string, unknown>;

	@Column({ type: 'text', nullable: true, comment: 'Motivo (error de validación, ambigua, no encontrada)' })
	message!: string | null;

	@Column({ type: 'jsonb', nullable: true, comment: 'Al revertir: campos restaurados' })
	reverted_fields!: string[] | null;

	@Column({ type: 'jsonb', nullable: true, comment: 'Al revertir: campos que no se tocaron porque alguien los editó después' })
	kept_fields!: string[] | null;

	@ManyToOne(() => ImportBatch, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'batch_id', referencedColumnName: 'id', foreignKeyConstraintName: 'import_batch_rows_batch_id_fkey' })
	batch?: ImportBatch;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'import_batch_rows_holding_id_fkey' })
	holding?: CompanyHolding;
}

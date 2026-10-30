import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn, Unique } from 'typeorm';

import { Company } from '@/databases/postgresql/entities/base-tenancy/companies.entity';

/**
 * `dte_simulations` — documentos tributarios **simulados**: los que api-sapira "emite" con `DTE_SIMULATED=true` (solo QA) en vez de
 * mandarlos a api-factura. Guarda el cuerpo DTE tal como se habría enviado (`mapInvoiceToDteBody`) para devolver después su XML (que
 * Kame registra) y su PDF en borrador. El id lleva el prefijo `sim_` (así lo reconocen `invoices.dte_id` y el front) y el folio es
 * correlativo por compañía y tipo; `external_ref` (el id de la factura) lo hace idempotente, como en api-factura.
 *
 * Entity + migración `1792400000000-DteSimulations`. En producción la tabla existe vacía: la API no arranca con la simulación contra la
 * base de producción (`assertDteSimulationAllowed`). Solo la API: RLS activo **sin policies**.
 */
@Entity({ name: 'dte_simulations', comment: 'DTE simulados (DTE_SIMULATED, solo QA): cuerpo, folio y envío sin pasar por api-factura. Solo la API' })
@Unique('dte_simulations_company_tipo_folio_key', ['company_id', 'tipo', 'folio'])
@Unique('dte_simulations_company_external_ref_key', ['company_id', 'external_ref'])
export class DteSimulation {
	@PrimaryColumn({ type: 'text', primaryKeyConstraintName: 'dte_simulations_pkey', comment: 'sim_<uuid>: es el dte_id que queda en la factura' })
	id!: string;

	@Column({ type: 'uuid' })
	company_id!: string;

	@Column({ type: 'integer', comment: 'Tipo de DTE (33, 34, 56, 61, 110…)' })
	tipo!: number;

	@Column({ type: 'integer', comment: 'Folio simulado, correlativo por compañía y tipo' })
	folio!: number;

	@Column({ type: 'text', comment: 'Referencia externa (id de la factura); una reemisión archiva la anterior como <ref>:rechazado:<id>' })
	external_ref!: string;

	@Column({ type: 'jsonb', comment: 'Cuerpo DTE tal como se habría enviado a api-factura (Encabezado, Detalle, Referencia)' })
	body!: Record<string, unknown>;

	@Column({ type: 'text', nullable: true, comment: 'TrackId simulado (SIM-<folio>) al "enviar al SII"' })
	track_id?: string | null;

	@CreateDateColumn({ type: 'timestamptz' })
	created_at!: Date;

	@ManyToOne(() => Company, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'company_id', referencedColumnName: 'id', foreignKeyConstraintName: 'dte_simulations_company_id_fkey' })
	company?: Company;
}

import { Check, Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

/** Integraciones que tienen un proceso automático que se puede apagar por holding. */
export const HOLDING_INTEGRATIONS = ['odoo', 'salesforce', 'bigquery'] as const;
export type HoldingIntegration = (typeof HOLDING_INTEGRATIONS)[number];

/**
 * Interruptor por holding de la **integración automática** de cada servicio (pedido de Leon, 27-09-2026):
 * el cron de esa integración omite los holdings con `auto_enabled = false`.
 *
 * Hasta ahora no existía forma de apagar un holding: `company_holdings` no tiene columnas de estado,
 * `holding_settings` solo guarda moneda y FX, y `odoo_connections.is_active` gobierna otras funciones de
 * Odoo pero nunca el envío de facturas. La única salida era desmapear las razones sociales.
 *
 * **Fila ausente = habilitado.** Se consulta con `COALESCE(his.auto_enabled, true)`, así no hizo falta
 * backfill y un holding nuevo nace habilitado. Solo se inserta la fila al apagar (o al volver a prender).
 *
 * Hoy lo respeta el cron de facturas a Odoo (`invoice-scheduler.scheduler.ts`). `salesforce` y `bigquery`
 * quedan declarados para cuando se migre el módulo Integraciones al front nuevo, que es donde vivirá el
 * switch en pantalla (`docs/v2-rediseno/plan-migracion-integraciones.md`). El envío **manual** no mira este
 * flag a propósito: es la válvula de escape.
 *
 * Solo la usa la API: RLS activo con una única policy para `service_role`; sin grants al Data API.
 * Tabla nueva creada por `migrations/1790400000000-CreateHoldingIntegrationSettings.ts`.
 */
@Entity('holding_integration_settings', {
	comment: 'Habilitación de la integración automática (cron) de cada servicio, por holding. Fila ausente = habilitado.',
})
@Check('holding_integration_settings_integration_check', `integration IN ('odoo', 'salesforce', 'bigquery')`)
export class HoldingIntegrationSettings {
	@PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'holding_integration_settings_pkey' })
	holding_id: string;

	@PrimaryColumn({ type: 'text', primaryKeyConstraintName: 'holding_integration_settings_pkey' })
	integration: HoldingIntegration;

	@Column({ type: 'boolean', default: true, comment: 'false apaga la corrida automática de esa integración para el holding' })
	auto_enabled: boolean;

	@Column({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'timestamp with time zone', default: () => 'now()' })
	updated_at: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'holding_integration_settings_holding_id_fkey' })
	holding?: CompanyHolding;
}

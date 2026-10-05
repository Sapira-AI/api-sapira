import { Check, Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

/** Integraciones que tienen un proceso automático que se puede apagar por holding (`stripe` lo agrega `1791000000000-IntegrationsV2`). */
export const HOLDING_INTEGRATIONS = ['odoo', 'salesforce', 'bigquery', 'stripe'] as const;
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
 *
 * Integraciones v2 (`migrations/1791000000000-IntegrationsV2.ts`, rama `domi`) la reutiliza como **tabla única de ajustes por
 * integración**: agrega `settings` (reglas del tipo: etapas del CRM, filtros del ERP, reglas de exclusión) y `updated_by`, y suma
 * `stripe` al CHECK. Tipo de Integraciones v2 → `integration`: erp → odoo, crm → salesforce, stripe → stripe, datos → bigquery.
 */
@Entity('holding_integration_settings', {
	comment: 'Ajustes de cada integración por holding: habilitación de la corrida automática (cron; fila ausente = habilitado) y reglas (settings).',
})
@Check('holding_integration_settings_integration_check', `integration IN ('odoo', 'salesforce', 'bigquery', 'stripe')`)
export class HoldingIntegrationSettings {
	@PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'holding_integration_settings_pkey' })
	holding_id: string;

	@PrimaryColumn({ type: 'text', primaryKeyConstraintName: 'holding_integration_settings_pkey' })
	integration: HoldingIntegration;

	@Column({ type: 'boolean', default: true, comment: 'false apaga la corrida automática de esa integración para el holding' })
	auto_enabled: boolean;

	@Column({
		type: 'jsonb',
		default: {},
		comment: 'Reglas de la integración para el holding (claves según el contrato de Integraciones v2 §6.1 y §6.5). {} = valores por defecto',
	})
	settings: Record<string, unknown>;

	@Column({ type: 'uuid', nullable: true, comment: 'Usuario (public.users.id) que cambió los ajustes por última vez' })
	updated_by: string | null;

	@Column({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'timestamp with time zone', default: () => 'now()' })
	updated_at: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'holding_integration_settings_holding_id_fkey' })
	holding?: CompanyHolding;
}

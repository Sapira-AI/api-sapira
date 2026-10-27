import { randomUUID } from 'crypto';

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { type FieldError, validationException } from '@/core/utils/validation-errors';

import { setApiWriter } from './api-writer';
import { UNIFIED_INVOICE_TYPE } from './consumption';
import { PENDING_STATUS } from './contract-360';
import { resolveUserId } from './contract-drafts.service';

import type { BulkContractSettingsDto } from './dtos/bulk-contracts.dto';

type Row = Record<string, unknown>;

const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const bool = (value: unknown) => (value === null || value === undefined ? null : Boolean(value));

export interface ContractSettings {
	auto_send_to_odoo: boolean | null;
	auto_invoice: boolean | null;
	/** Marcas del contrato (Domi 26-10): Requiere OC/HES, Multimoneda y Multiempresa. */
	requires_references_for_billing?: boolean | null;
	requires_multicurrency_billing?: boolean | null;
	requires_multicompany_billing?: boolean | null;
}

/** Interruptores que acepta la acción masiva, en el orden del título del evento. */
const SETTING_KEYS = [
	'auto_send_to_odoo',
	'auto_invoice',
	'requires_references_for_billing',
	'requires_multicurrency_billing',
	'requires_multicompany_billing',
] as const;
type SettingKey = (typeof SETTING_KEYS)[number];

const SETTING_TITLES: Record<SettingKey, [string, string]> = {
	auto_send_to_odoo: ['Envío automático al ERP activado', 'Envío automático al ERP desactivado'],
	auto_invoice: ['Emisión automática activada', 'Emisión automática desactivada'],
	requires_references_for_billing: ['Requiere OC/HES activado', 'Requiere OC/HES desactivado'],
	requires_multicurrency_billing: ['Multimoneda activada', 'Multimoneda desactivada'],
	requires_multicompany_billing: ['Multiempresa activada', 'Multiempresa desactivada'],
};

/** Títulos del evento `SETTINGS_CHANGED` (sin nombres de columnas ni de proveedores: "ERP"). */
export function settingsChangeTitle(before: ContractSettings, after: ContractSettings): string {
	const parts = SETTING_KEYS.filter((key) => before[key] !== after[key]).map((key) => SETTING_TITLES[key][after[key] ? 0 : 1]);

	return parts.join(' · ') || 'Configuración sin cambios';
}

/** Por Emitir vivas de un contrato que reciben la marca Requiere OC/HES (mismo criterio que `isEditablePending` de las modificaciones). */
export const PENDING_INVOICES_FOR_FLAGS_SQL = `status = '${PENDING_STATUS}' AND is_active AND COALESCE(is_legacy, false) = false
	AND invoice_type IS DISTINCT FROM '${UNIFIED_INVOICE_TYPE}' AND COALESCE(document_type, '') !~* '^(NC|ND)$'`;

interface PlanEntry {
	id: string;
	contract_number: string | null;
	before: ContractSettings;
	after: ContractSettings;
	changed: boolean;
	/** Bloqueado con motivo (p. ej. apagar Multimoneda con ítems en otra moneda): no se escribe, queda en el resumen. */
	blocked: string | null;
}

/**
 * Contratos v2 — acciones masivas de configuración: envío automático al ERP, emisión automática y, desde el 26-10, las marcas
 * Requiere OC/HES, Multimoneda y Multiempresa. Una transacción por acción; solo contratos del holding; un evento
 * `SETTINGS_CHANGED` por contrato que cambia.
 */
@Injectable()
export class ContractBulkService {
	constructor(private readonly dataSource: DataSource) {}

	/**
	 * `PATCH /contracts/bulk-settings`. Reglas:
	 * - al menos un interruptor; ids que no son del holding (o están borrados) → 400 con `errors[ids.N]`;
	 * - S6-10: la emisión automática requiere el envío automático al ERP. Se rechaza toda la acción si algún contrato
	 *   quedaría con emisión automática sin envío (al pedir encender la emisión o al apagar el envío);
	 * - contratos cuyos ítems no están en la moneda del contrato → 400 (el trigger de moneda rechazaría el UPDATE);
	 * - Multimoneda apagada con ítems en otra moneda → el contrato queda `blocked` en el resumen (la acción sigue con los demás);
	 * - Requiere OC/HES se escribe también en todas las Por Emitir vivas del contrato (`pending_invoices_updated`);
	 * - los que ya tienen el valor pedido no se escriben (`changed: false`).
	 */
	async updateSettings(dto: BulkContractSettingsDto, holdingId: string, authId: string) {
		const wanted = SETTING_KEYS.filter((key) => typeof dto[key] === 'boolean');
		const wantsSend = wanted.includes('auto_send_to_odoo');

		if (!wanted.length) {
			throw validationException([
				{
					field: 'auto_send_to_odoo',
					message: 'Indica qué configuración cambiar: envío automático al ERP, emisión automática o una marca del contrato',
				},
			]);
		}

		const userId = await resolveUserId(this.dataSource, authId);
		const ids = [...new Set(dto.ids)];
		const runner = this.dataSource.createQueryRunner();

		await runner.connect();
		await runner.startTransaction();
		try {
			// Costura `sapira.writer = 'api'`: primera sentencia de la transacción v2.
			await setApiWriter(runner);
			const rows = (await runner.query(
				`SELECT c.id, c.contract_number, c.auto_send_to_odoo, c.auto_invoice,
					COALESCE(c.requires_references_for_billing, false) AS requires_references_for_billing,
					COALESCE(c.requires_multicurrency_billing, false) AS requires_multicurrency_billing,
					COALESCE(c.requires_multicompany_billing, false) AS requires_multicompany_billing,
					EXISTS (SELECT 1 FROM contract_items ci WHERE ci.contract_id = c.id AND ci.currency IS DISTINCT FROM c.contract_currency) AS currency_mismatch,
					(SELECT string_agg(DISTINCT ci.currency, ', ') FROM contract_items ci WHERE ci.contract_id = c.id AND ci.currency IS DISTINCT FROM c.contract_currency) AS foreign_currencies
				FROM contracts c
				WHERE c.id = ANY($1::uuid[]) AND c.holding_id = $2 AND c.deleted_at IS NULL
				FOR UPDATE OF c`,
				[ids, holdingId]
			)) as Row[];
			const byId = new Map(rows.map((row) => [String(row.id), row]));
			const errors: FieldError[] = [];
			const plan: PlanEntry[] = [];

			dto.ids.forEach((id, index) => {
				const row = byId.get(id);

				if (!row) {
					errors.push({ field: `ids.${index}`, message: 'El contrato no existe en el holding' });

					return;
				}
				if (plan.some((entry) => entry.id === id)) return;

				const number = toText(row.contract_number);
				const before: ContractSettings = {
					auto_send_to_odoo: bool(row.auto_send_to_odoo),
					auto_invoice: bool(row.auto_invoice),
					requires_references_for_billing: row.requires_references_for_billing === true,
					requires_multicurrency_billing: row.requires_multicurrency_billing === true,
					requires_multicompany_billing: row.requires_multicompany_billing === true,
				};
				const after: ContractSettings = { ...before };

				for (const key of wanted) after[key] = dto[key]!;
				const changed = SETTING_KEYS.some((key) => before[key] !== after[key]);
				// Mismo criterio que el scheduler: NULL cuenta como envío automático.
				const sendsToErp = after.auto_send_to_odoo !== false;

				if (after.auto_invoice === true && !sendsToErp && (dto.auto_invoice === true || changed)) {
					errors.push({
						field: `ids.${index}`,
						message: wantsSend
							? `${number ?? 'El contrato'}: la emisión automática requiere el envío automático al ERP; desactiva también la emisión automática`
							: `${number ?? 'El contrato'}: la emisión automática requiere el envío automático al ERP; actívalo primero`,
					});

					return;
				}
				// El trigger de moneda rechazaría el UPDATE de las automatizaciones; las marcas no lo disparan.
				const automationChanged = before.auto_send_to_odoo !== after.auto_send_to_odoo || before.auto_invoice !== after.auto_invoice;

				if (automationChanged && row.currency_mismatch === true) {
					errors.push({
						field: `ids.${index}`,
						message: `${number ?? 'El contrato'}: sus ítems no están en la moneda del contrato; corrígelo antes de cambiar la configuración`,
					});

					return;
				}
				// Multimoneda: apagarla con ítems en otra moneda (vigentes o históricos) queda bloqueada, como en `planMulticurrency`.
				const blocked =
					before.requires_multicurrency_billing === true && after.requires_multicurrency_billing === false && row.currency_mismatch === true
						? `${number ?? 'El contrato'}: no se puede desactivar multimoneda, tiene ítems en ${toText(row.foreign_currencies) ?? 'otra moneda'}`
						: null;

				plan.push({ id, contract_number: number, before, after, changed: changed && !blocked, blocked });
			});

			if (errors.length) throw validationException(errors);
			// Un id común a todos los eventos de la misma acción masiva (como `bulk_id` de las facturas): se audita y revierte en bloque.
			const bulkId = randomUUID();
			const pendingUpdated = new Map<string, number>();

			for (const entry of plan.filter((item) => item.changed)) {
				await runner.query(
					`UPDATE contracts SET auto_send_to_odoo = $3, auto_invoice = $4, requires_references_for_billing = $5,
						requires_multicurrency_billing = $6, requires_multicompany_billing = $7
					WHERE id = $1 AND holding_id = $2`,
					[
						entry.id,
						holdingId,
						entry.after.auto_send_to_odoo,
						entry.after.auto_invoice,
						entry.after.requires_references_for_billing,
						entry.after.requires_multicurrency_billing,
						entry.after.requires_multicompany_billing,
					]
				);
				if (entry.before.requires_references_for_billing !== entry.after.requires_references_for_billing) {
					// Requiere OC/HES: todas las Por Emitir vivas del contrato, también las atrasadas (Domi 26-10, caso NUR SRL).
					const updated = (await runner.query(
						`UPDATE invoices SET requires_references_for_billing = $3
						WHERE contract_id = $1 AND holding_id = $2 AND ${PENDING_INVOICES_FOR_FLAGS_SQL} RETURNING id`,
						[entry.id, holdingId, entry.after.requires_references_for_billing]
					)) as Row[] | [Row[], number];
					const touched = (Array.isArray(updated[0]) ? updated[0] : updated) as Row[];

					pendingUpdated.set(entry.id, touched.length);
				}
				await runner.query(
					`INSERT INTO contract_lifecycle_events (
						contract_id, holding_id, event_type, event_status, title, description, created_by, completed_at, effective_date, metadata
					) VALUES ($1, $2, 'SETTINGS_CHANGED', 'Completed', $3, $4, $5, now(), CURRENT_DATE, $6::jsonb)`,
					[
						entry.id,
						holdingId,
						settingsChangeTitle(entry.before, entry.after),
						'Configuración cambiada con la acción masiva de contratos',
						userId,
						JSON.stringify({
							source: 'api_v2',
							bulk: true,
							bulk_id: bulkId,
							before: entry.before,
							after: entry.after,
							...(pendingUpdated.has(entry.id) ? { pending_invoices_updated: pendingUpdated.get(entry.id) } : {}),
						}),
					]
				);
			}
			await runner.commitTransaction();

			const updated = plan.filter((entry) => entry.changed).length;
			const blocked = plan.filter((entry) => entry.blocked).length;

			return {
				bulk_id: updated ? bulkId : null,
				updated,
				unchanged: plan.length - updated - blocked,
				blocked,
				results: plan.map((entry) => ({
					id: entry.id,
					contract_number: entry.contract_number,
					changed: entry.changed,
					...(entry.blocked ? { blocked: entry.blocked } : {}),
					...(pendingUpdated.has(entry.id) ? { pending_invoices_updated: pendingUpdated.get(entry.id) } : {}),
				})),
			};
		} catch (error) {
			await runner.rollbackTransaction();
			throw error;
		} finally {
			await runner.release();
		}
	}
}

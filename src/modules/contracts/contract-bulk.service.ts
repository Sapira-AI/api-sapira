import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { type FieldError, validationException } from '@/core/utils/validation-errors';

import { resolveUserId } from './contract-drafts.service';

import type { BulkContractSettingsDto } from './dtos/bulk-contracts.dto';

type Row = Record<string, unknown>;

const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const bool = (value: unknown) => (value === null || value === undefined ? null : Boolean(value));

export interface ContractSettings {
	auto_send_to_odoo: boolean | null;
	auto_invoice: boolean | null;
}

/** Títulos del evento `SETTINGS_CHANGED` (sin nombres de columnas ni de proveedores: "ERP"). */
export function settingsChangeTitle(before: ContractSettings, after: ContractSettings): string {
	const parts: string[] = [];

	if (before.auto_send_to_odoo !== after.auto_send_to_odoo) {
		parts.push(after.auto_send_to_odoo ? 'Envío automático al ERP activado' : 'Envío automático al ERP desactivado');
	}
	if (before.auto_invoice !== after.auto_invoice) {
		parts.push(after.auto_invoice ? 'Emisión automática activada' : 'Emisión automática desactivada');
	}

	return parts.join(' · ') || 'Configuración sin cambios';
}

/**
 * Contratos v2 — acciones masivas de configuración (envío automático al ERP y emisión automática). Una transacción por
 * acción; solo contratos del holding; un evento `SETTINGS_CHANGED` por contrato que cambia.
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
	 * - los que ya tienen el valor pedido no se escriben (`changed: false`).
	 */
	async updateSettings(dto: BulkContractSettingsDto, holdingId: string, authId: string) {
		const wantsSend = typeof dto.auto_send_to_odoo === 'boolean';
		const wantsInvoice = typeof dto.auto_invoice === 'boolean';

		if (!wantsSend && !wantsInvoice) {
			throw validationException([
				{ field: 'auto_send_to_odoo', message: 'Indica qué configuración cambiar: envío automático al ERP o emisión automática' },
			]);
		}

		const userId = await resolveUserId(this.dataSource, authId);
		const ids = [...new Set(dto.ids)];
		const runner = this.dataSource.createQueryRunner();

		await runner.connect();
		await runner.startTransaction();
		try {
			const rows = (await runner.query(
				`SELECT c.id, c.contract_number, c.auto_send_to_odoo, c.auto_invoice,
					EXISTS (SELECT 1 FROM contract_items ci WHERE ci.contract_id = c.id AND ci.currency IS DISTINCT FROM c.contract_currency) AS currency_mismatch
				FROM contracts c
				WHERE c.id = ANY($1::uuid[]) AND c.holding_id = $2 AND (to_jsonb(c)->>'deleted_at') IS NULL
				FOR UPDATE OF c`,
				[ids, holdingId]
			)) as Row[];
			const byId = new Map(rows.map((row) => [String(row.id), row]));
			const errors: FieldError[] = [];
			const plan: Array<{ id: string; contract_number: string | null; before: ContractSettings; after: ContractSettings; changed: boolean }> =
				[];

			dto.ids.forEach((id, index) => {
				const row = byId.get(id);

				if (!row) {
					errors.push({ field: `ids.${index}`, message: 'El contrato no existe en el holding' });

					return;
				}
				if (plan.some((entry) => entry.id === id)) return;

				const number = toText(row.contract_number);
				const before: ContractSettings = { auto_send_to_odoo: bool(row.auto_send_to_odoo), auto_invoice: bool(row.auto_invoice) };
				const after: ContractSettings = {
					auto_send_to_odoo: wantsSend ? dto.auto_send_to_odoo! : before.auto_send_to_odoo,
					auto_invoice: wantsInvoice ? dto.auto_invoice! : before.auto_invoice,
				};
				const changed = before.auto_send_to_odoo !== after.auto_send_to_odoo || before.auto_invoice !== after.auto_invoice;
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
				if (changed && row.currency_mismatch === true) {
					errors.push({
						field: `ids.${index}`,
						message: `${number ?? 'El contrato'}: sus ítems no están en la moneda del contrato; corrígelo antes de cambiar la configuración`,
					});

					return;
				}
				plan.push({ id, contract_number: number, before, after, changed });
			});

			if (errors.length) throw validationException(errors);

			for (const entry of plan.filter((item) => item.changed)) {
				await runner.query(`UPDATE contracts SET auto_send_to_odoo = $3, auto_invoice = $4 WHERE id = $1 AND holding_id = $2`, [
					entry.id,
					holdingId,
					entry.after.auto_send_to_odoo,
					entry.after.auto_invoice,
				]);
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
						JSON.stringify({ source: 'api_v2', bulk: true, before: entry.before, after: entry.after }),
					]
				);
			}
			await runner.commitTransaction();

			const updated = plan.filter((entry) => entry.changed).length;

			return {
				updated,
				unchanged: plan.length - updated,
				results: plan.map((entry) => ({ id: entry.id, contract_number: entry.contract_number, changed: entry.changed })),
			};
		} catch (error) {
			await runner.rollbackTransaction();
			throw error;
		} finally {
			await runner.release();
		}
	}
}

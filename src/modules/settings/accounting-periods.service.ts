import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';

import { validationException } from '@/core/utils/validation-errors';
import type { PermissionContext } from '@/guards/permissions.service';

import { assertCompanyInHolding, displayDate, Row, toIsoDate } from './settings-common';

import type { ClosePeriodDto, ReopenPeriodDto } from './dtos/companies.dto';

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** `YYYY-MM-DD` → "Julio 2026". */
export function monthLabel(iso: string): string {
	const [year, month] = iso.split('-');
	const name = MONTHS[Number(month) - 1] ?? '';

	return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${year}`;
}

const parse = (iso: string) => new Date(`${iso}T00:00:00Z`);
const format = (date: Date) => date.toISOString().slice(0, 10);

/** `true` si la fecha es el último día de su mes. */
export function isLastDayOfMonth(iso: string): boolean {
	const date = parse(iso);

	if (Number.isNaN(date.getTime()) || format(date) !== iso) return false;
	const next = new Date(date);

	next.setUTCDate(date.getUTCDate() + 1);

	return next.getUTCDate() === 1;
}

export function isFirstDayOfMonth(iso: string): boolean {
	const date = parse(iso);

	return !Number.isNaN(date.getTime()) && format(date) === iso && date.getUTCDate() === 1;
}

/** Fecha de hoy en Chile (`YYYY-MM-DD`): el calendario contable del holding corre en hora de Chile. */
export function todayInChile(now: Date = new Date()): string {
	return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Último día del mes anterior a hoy (hora Chile): lo más lejos que se puede cerrar (solo meses terminados, decisión de Domi 03-10). */
export function lastClosableDate(now: Date = new Date()): string {
	return dayBefore(`${todayInChile(now).slice(0, 7)}-01`);
}

export function dayBefore(iso: string): string {
	const date = parse(iso);

	date.setUTCDate(date.getUTCDate() - 1);

	return format(date);
}

/**
 * Cierre de períodos por compañía (Compañía 360, D8). Servicio propio: replica `close_period_until` / `reopen_period_from` (mismas
 * tablas y mismos datos), pero con el usuario de la sesión de la API (esas funciones usan `auth.uid()` y no sirven desde la API) y el
 * permiso `CLOSE_PERIODS` (en vez de `is_holding_admin()`). Una transacción por acción, con la compañía bloqueada (`FOR NO KEY UPDATE`:
 * serializa dos cierres simultáneos sin bloquear las escrituras que solo referencian la compañía por FK). Solo se cierran meses ya
 * terminados en el calendario (hora Chile). Los triggers de bloqueo de período y de coherencia compañía↔holding no cambian.
 */
@Injectable()
export class AccountingPeriodsService {
	constructor(private readonly dataSource: DataSource) {}

	async get(holdingId: string, companyId: string) {
		await assertCompanyInHolding(this.dataSource, holdingId, companyId);
		const [cutoff] = (await this.dataSource.query(`SELECT * FROM accounting_period_cutoff WHERE holding_id = $1 AND company_id = $2`, [
			holdingId,
			companyId,
		])) as Row[];
		const events = (await this.dataSource.query(
			`SELECT id, action, cutoff_date_before, cutoff_date_after, performed_by_name, performed_by_email, performed_at, reason
			FROM accounting_period_events WHERE holding_id = $1 AND company_id = $2 ORDER BY performed_at DESC, created_at DESC`,
			[holdingId, companyId]
		)) as Row[];

		return {
			company_id: companyId,
			cutoff_date: toIsoDate(cutoff?.cutoff_date),
			last_action: (cutoff?.last_action as string | null) ?? null,
			last_action_at: cutoff?.last_action_at ?? null,
			last_action_by_name: (cutoff?.last_action_by_name as string | null) ?? null,
			last_action_by_email: (cutoff?.last_action_by_email as string | null) ?? null,
			last_action_reason: (cutoff?.last_action_reason as string | null) ?? null,
			events: events.map((event) => ({
				id: String(event.id),
				action: String(event.action),
				cutoff_date_before: toIsoDate(event.cutoff_date_before),
				cutoff_date_after: toIsoDate(event.cutoff_date_after),
				performed_by_name: String(event.performed_by_name ?? ''),
				performed_by_email: String(event.performed_by_email ?? ''),
				performed_at: event.performed_at,
				reason: String(event.reason ?? ''),
			})),
		};
	}

	private async inTransaction(work: (runner: QueryRunner) => Promise<void>) {
		const runner = this.dataSource.createQueryRunner();

		await runner.connect();
		await runner.startTransaction();
		try {
			await work(runner);
			await runner.commitTransaction();
		} catch (error) {
			await runner.rollbackTransaction();
			throw error;
		} finally {
			await runner.release();
		}
	}

	/** Bloquea la compañía (404 si no es del holding) y devuelve el cierre actual. */
	private async lockCutoff(runner: QueryRunner, holdingId: string, companyId: string): Promise<string | null> {
		const company = (await runner.query(`SELECT id FROM companies WHERE id = $1 AND holding_id = $2 FOR NO KEY UPDATE`, [
			companyId,
			holdingId,
		])) as Row[];

		if (!company.length) throw new NotFoundException('Compañía no encontrada');
		const [cutoff] = (await runner.query(`SELECT cutoff_date FROM accounting_period_cutoff WHERE holding_id = $1 AND company_id = $2`, [
			holdingId,
			companyId,
		])) as Row[];

		return toIsoDate(cutoff?.cutoff_date);
	}

	private async writeEvent(
		runner: QueryRunner,
		holdingId: string,
		companyId: string,
		action: 'CLOSED' | 'REOPENED',
		before: string | null,
		after: string,
		actor: PermissionContext,
		reason: string
	) {
		await runner.query(
			`INSERT INTO accounting_period_cutoff (holding_id, company_id, cutoff_date, last_action, last_action_at, last_action_by,
				last_action_by_name, last_action_by_email, last_action_reason)
			VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8)
			ON CONFLICT (holding_id, company_id) DO UPDATE SET cutoff_date = EXCLUDED.cutoff_date, last_action = EXCLUDED.last_action,
				last_action_at = EXCLUDED.last_action_at, last_action_by = EXCLUDED.last_action_by, last_action_by_name = EXCLUDED.last_action_by_name,
				last_action_by_email = EXCLUDED.last_action_by_email, last_action_reason = EXCLUDED.last_action_reason`,
			[holdingId, companyId, after, action, actor.userId, actor.name ?? actor.email, actor.email, reason]
		);
		await runner.query(
			`INSERT INTO accounting_period_events (holding_id, company_id, action, cutoff_date_before, cutoff_date_after, performed_by,
				performed_by_name, performed_by_email, reason)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			[holdingId, companyId, action, before, after, actor.userId, actor.name ?? actor.email, actor.email, reason]
		);
	}

	private assertReason(reason: string) {
		if (reason.trim().length < 10) throw validationException([{ field: 'reason', message: 'El motivo debe tener al menos 10 caracteres' }]);
	}

	async close(holdingId: string, companyId: string, dto: ClosePeriodDto, actor: PermissionContext) {
		if (!isLastDayOfMonth(dto.until_date)) {
			throw validationException([{ field: 'until_date', message: 'La fecha de cierre debe ser el último día de un mes' }]);
		}
		this.assertReason(dto.reason);
		const limit = lastClosableDate();

		if (dto.until_date > limit) {
			throw new ConflictException(
				`Solo se pueden cerrar meses terminados: ${monthLabel(dto.until_date)} aún no termina (puedes cerrar hasta el ${displayDate(limit)})`
			);
		}
		await this.inTransaction(async (runner) => {
			const current = await this.lockCutoff(runner, holdingId, companyId);

			if (current && dto.until_date === current) throw new ConflictException(`Ya está cerrado hasta el ${displayDate(current)}`);
			if (current && dto.until_date < current) {
				throw new ConflictException(
					`No se puede cerrar antes del cierre actual (${displayDate(current)}): para retroceder, reabre desde el mes que necesitas`
				);
			}
			await this.writeEvent(runner, holdingId, companyId, 'CLOSED', current, dto.until_date, actor, dto.reason.trim());
		});

		return this.get(holdingId, companyId);
	}

	async reopen(holdingId: string, companyId: string, dto: ReopenPeriodDto, actor: PermissionContext) {
		if (!isFirstDayOfMonth(dto.from_date)) {
			throw validationException([{ field: 'from_date', message: 'La fecha de reapertura debe ser el día 1 de un mes' }]);
		}
		this.assertReason(dto.reason);
		await this.inTransaction(async (runner) => {
			const current = await this.lockCutoff(runner, holdingId, companyId);

			if (!current) throw new ConflictException('No hay períodos cerrados para reabrir');
			if (dto.from_date > current) {
				throw new ConflictException(`${monthLabel(dto.from_date)} ya está abierto (cerrado hasta ${displayDate(current)})`);
			}
			await this.writeEvent(runner, holdingId, companyId, 'REOPENED', current, dayBefore(dto.from_date), actor, dto.reason.trim());
		});

		return this.get(holdingId, companyId);
	}
}

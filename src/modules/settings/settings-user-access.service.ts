import {
	BadGatewayException,
	ConflictException,
	HttpException,
	HttpStatus,
	Injectable,
	Logger,
	NotFoundException,
	ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { authConfirmUrl, AuthMailer, MailResult } from '@/auth/accounts/auth-mailer';
import { AuthAdminError, GeneratedLink, InviteLinkType, SupabaseAdminService } from '@/auth/accounts/supabase-admin.service';
import type { PermissionContext } from '@/guards/permissions.service';

import { roleCapabilities } from './permissions-catalog';
import { assertKeepsConfigAdmin } from './settings-admins';
import { Queryable, Row, toCount, withUniqueMessage } from './settings-common';
import { USER_SELECT, userDto } from './settings-users.service';

export type UserAccessAction = 'invited' | 'invitation_resent' | 'deactivated' | 'reactivated' | 'invitation_deleted';

/** Reenvío: mínimo entre envíos y máximo de envíos (invitar + reenviar) por persona en 24 h, contados en `user_access_events`. */
export const RESEND_MIN_SECONDS = 60;
export const SENDS_PER_DAY = 5;

/**
 * Tablas con FK hacia `users` que son "de la persona" y caen solas al borrarla (ON DELETE CASCADE / SET NULL): no impiden eliminar una
 * invitación. Cualquier otra FK (leída de `pg_constraint` en el momento) con una fila que apunte al usuario → 409.
 */
export const OWNED_USER_TABLES = ['user_holdings', 'user_view_preferences', 'app_notification_recipients', 'user_access_events'] as const;

const MSG = {
	notFound: 'Usuario no encontrado',
	alreadyMember: 'Ya tiene acceso a este holding',
	deactivated: 'Está desactivado: reactívalo',
	cannotInvite: 'No se puede invitar a este correo',
	otherCompany: 'Esta persona ya usa Sapira en otra empresa: escríbenos a soporte',
	authCreate: 'No se pudo crear la cuenta de acceso: vuelve a intentarlo en unos minutos',
	authLink: 'No se pudo generar el enlace: vuelve a intentarlo en unos minutos',
	authAccess: 'No se pudo actualizar el acceso de la cuenta: vuelve a intentarlo en unos minutos',
	mailFailedInvite: 'La invitación quedó creada pero el correo no salió: usa Reenviar',
	mailFailedResend: 'El correo no salió: vuelve a intentarlo',
	alreadyActivated: 'Ya activó su cuenta',
	resendTooSoon: 'Espera un minuto antes de reenviar la invitación',
	resendDailyLimit: `Ya se enviaron ${SENDS_PER_DAY} invitaciones en 24 horas: vuelve a intentarlo mañana`,
	selfDeactivate: 'No puedes desactivarte',
	superAdminAccess: 'El acceso de un super admin no se cambia desde aquí',
	cannotDelete: 'Ya activó su cuenta: desactívala en vez de eliminarla',
	notConfigured: 'La invitación de usuarios no está configurada',
};

export interface InviteInput {
	email: string;
	name: string;
	role_id: string;
}

/**
 * Acciones de acceso de Usuarios (contrato §10, spec §16): invitar, reenviar, desactivar/reactivar y eliminar invitación. Quien actúa sale
 * de la sesión (`PermissionContext`); el holding, de `HoldingScopeGuard`. Supabase Auth solo por `SupabaseAdminService` (clave de servicio)
 * y el correo por `AuthMailer` (Resend, plantilla con la marca). Cada acción queda en `user_access_events`.
 */
@Injectable()
export class SettingsUserAccessService {
	private readonly logger = new Logger(SettingsUserAccessService.name);

	constructor(
		private readonly dataSource: DataSource,
		private readonly admin: SupabaseAdminService,
		private readonly mailer: AuthMailer,
		private readonly config: ConfigService
	) {}

	// ------------------------------------------------------------------ invitar

	async invite(holdingId: string, input: InviteInput, actor: PermissionContext) {
		const email = input.email.trim().toLowerCase();
		const name = input.name.trim();

		this.mailer.assertAllowedRecipient(email);
		const role = (await this.dataSource.query(`SELECT id FROM roles WHERE id = $1 AND holding_id = $2`, [input.role_id, holdingId])) as Row[];

		if (!role.length) throw new NotFoundException('Rol no encontrado');
		await this.assertNotRegistered(holdingId, email);
		// Antes de escribir: sin Auth admin o sin URL del enlace no se crea nada.
		const redirectTo = this.confirmUrl('invite');

		this.admin.assertConfigured();

		const userId = await this.dataSource.transaction(async (manager) => {
			const [created] = (await withUniqueMessage(
				() =>
					manager.query(`INSERT INTO users (email, name, role_id, status) VALUES ($1, $2, $3, 'Pendiente') RETURNING id`, [
						email,
						name,
						input.role_id,
					]),
				MSG.alreadyMember
			)) as Row[];

			await manager.query(`INSERT INTO user_holdings (user_id, holding_id, is_active, selected) VALUES ($1, $2, true, false)`, [
				created.id,
				holdingId,
			]);

			return String(created.id);
		});

		let link: GeneratedLink | null = null;

		try {
			link = await this.admin.generateLink({ type: 'invite', email, fullName: name, redirectTo });
			await this.dataSource.query(`UPDATE users SET auth_id = $2 WHERE id = $1`, [userId, link.authUserId]);
		} catch (error) {
			await this.compensateInvite(userId);
			// Cuenta de Auth recién creada por esta invitación (no una que ya existía): también se deshace.
			if (link?.type === 'invite') {
				await this.admin
					.deleteUser(link.authUserId)
					.catch((e: Error) => this.logger.warn(`Cuenta ${link?.authUserId} no deshecha: ${e.message}`));
			}
			if (error instanceof AuthAdminError) throw new BadGatewayException(MSG.authCreate);
			throw error;
		}

		const mail = await this.sendMail(holdingId, userId, email, name, link, actor, 1);

		await this.recordSend(userId, mail);
		await logAccessEvent(this.dataSource, holdingId, userId, actor.userId, 'invited', {
			email,
			role_id: input.role_id,
			link_type: link.type,
			mail_status: mail.status,
			...(mail.status === 'failed' ? { mail_error: mail.error } : {}),
		});
		const user = await this.member(holdingId, userId);

		return {
			user: userDto(user, actor),
			invitation: { status: mail.status, sent_at: mail.status === 'sent' ? (user.last_invitation_sent_at ?? null) : null },
			...(mail.status === 'failed' ? { message: MSG.mailFailedInvite } : {}),
		};
	}

	/** 409 con el mensaje de cada caso si el correo ya tiene usuario en Sapira. */
	private async assertNotRegistered(holdingId: string, email: string): Promise<void> {
		const [existing] = (await this.dataSource.query(
			`SELECT u.id, COALESCE(u.is_super_admin, false) AS is_super_admin,
				(SELECT uh.is_active FROM user_holdings uh WHERE uh.user_id = u.id AND uh.holding_id = $2) AS member_active
			FROM users u WHERE lower(u.email) = $1 LIMIT 1`,
			[email, holdingId]
		)) as Row[];

		if (!existing) return;
		if (existing.is_super_admin === true) throw new ConflictException(MSG.cannotInvite);
		if (existing.member_active === true) throw new ConflictException(MSG.alreadyMember);
		if (existing.member_active === false) throw new ConflictException(MSG.deactivated);
		throw new ConflictException(MSG.otherCompany);
	}

	/** Deshace el alta si Auth falló (borrar `users` cascadea `user_holdings`). Si esto también falla, se registra: queda un Pendiente sin cuenta. */
	private async compensateInvite(userId: string): Promise<void> {
		try {
			await this.dataSource.query(`DELETE FROM users WHERE id = $1 AND last_access IS NULL`, [userId]);
		} catch (error) {
			this.logger.error(`No se pudo deshacer la invitación ${userId}: ${(error as Error).message}`);
		}
	}

	// ------------------------------------------------------------------ reenviar

	async resend(holdingId: string, userId: string, actor: PermissionContext) {
		const user = await this.visibleMember(holdingId, userId, actor);

		if (user.is_super_admin === true) throw new NotFoundException(MSG.notFound);
		if (user.status !== 'Pendiente' || user.last_access) throw new ConflictException(MSG.alreadyActivated);
		if (user.access_active !== true) throw new ConflictException(MSG.deactivated);
		const sends = await this.sendHistory(userId);

		if (sends.recent) throw new HttpException(MSG.resendTooSoon, HttpStatus.TOO_MANY_REQUESTS);
		if (sends.lastDay >= SENDS_PER_DAY) throw new HttpException(MSG.resendDailyLimit, HttpStatus.TOO_MANY_REQUESTS);
		const redirectTo = this.confirmUrl('magiclink');
		let link: GeneratedLink;

		try {
			link = await this.admin.generateLink({
				type: 'magiclink',
				email: String(user.email),
				fullName: (user.name as string | null) ?? null,
				redirectTo,
			});
		} catch (error) {
			if (error instanceof AuthAdminError) throw new BadGatewayException(MSG.authLink);
			throw error;
		}
		if (link.authUserId !== user.auth_id) {
			await this.dataSource.query(`UPDATE users SET auth_id = $2 WHERE id = $1`, [userId, link.authUserId]);
		}
		const mail = await this.sendMail(holdingId, userId, String(user.email), (user.name as string | null) ?? null, link, actor, sends.total + 1);

		await this.recordSend(userId, mail);
		await logAccessEvent(this.dataSource, holdingId, userId, actor.userId, 'invitation_resent', {
			mail_status: mail.status,
			...(mail.status === 'failed' ? { mail_error: mail.error } : {}),
		});
		const [after] = (await this.dataSource.query(`SELECT last_invitation_sent_at FROM users WHERE id = $1`, [userId])) as Row[];

		return {
			status: mail.status,
			sent_at: mail.status === 'sent' ? (after?.last_invitation_sent_at ?? null) : null,
			...(mail.status === 'failed' ? { message: MSG.mailFailedResend } : {}),
		};
	}

	/** Envíos (invitar + reenviar) de la persona, en cualquier holding: el último hace < 60 s, cuántos en 24 h y el total (para la clave de idempotencia). */
	private async sendHistory(userId: string): Promise<{ recent: boolean; lastDay: number; total: number }> {
		const [row] = (await this.dataSource.query(
			`SELECT COALESCE(bool_or(created_at > now() - make_interval(secs => $2)), false) AS recent,
				count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS last_day, count(*) AS total
			FROM user_access_events WHERE user_id = $1 AND action IN ('invited', 'invitation_resent')`,
			[userId, RESEND_MIN_SECONDS]
		)) as Row[];

		return { recent: row?.recent === true, lastDay: toCount(row?.last_day), total: toCount(row?.total) };
	}

	// ------------------------------------------------------------------ acceso

	async setAccess(holdingId: string, userId: string, active: boolean, actor: PermissionContext) {
		const user = await this.visibleMember(holdingId, userId, actor);

		if (!active && String(user.id) === actor.userId) throw new ConflictException(MSG.selfDeactivate);
		if (user.is_super_admin === true) throw new ConflictException(MSG.superAdminAccess);
		if ((user.access_active === true) === active) return userDto(user, actor);

		const authId = (user.auth_id as string | null) ?? null;
		const [others] = (await this.dataSource.query(
			`SELECT count(*) AS n FROM user_holdings WHERE user_id = $1 AND holding_id <> $2 AND is_active = true`,
			[userId, holdingId]
		)) as Row[];
		const lastActiveMembership = toCount(others?.n) === 0;

		if (!active) {
			await assertKeepsConfigAdmin(this.dataSource, holdingId, { leavingUserId: userId });
			// Auth primero: si el bloqueo falla, no se cambia nada en la base.
			if (lastActiveMembership && authId) await this.ban(authId, true);
			try {
				await this.dataSource.transaction(async (manager) => {
					await manager.query(`UPDATE user_holdings SET is_active = false, selected = false WHERE user_id = $1 AND holding_id = $2`, [
						userId,
						holdingId,
					]);
					if (lastActiveMembership) await manager.query(`UPDATE users SET status = 'Inactivo' WHERE id = $1`, [userId]);
					await logAccessEvent(manager, holdingId, userId, actor.userId, 'deactivated', { last_membership: lastActiveMembership });
				});
			} catch (error) {
				if (lastActiveMembership && authId) await this.ban(authId, false).catch(() => undefined);
				throw error;
			}
		} else {
			const wasInactive = user.status === 'Inactivo';

			if (wasInactive && authId) await this.ban(authId, false);
			try {
				await this.dataSource.transaction(async (manager) => {
					await manager.query(`UPDATE user_holdings SET is_active = true WHERE user_id = $1 AND holding_id = $2`, [userId, holdingId]);
					if (wasInactive) {
						await manager.query(
							`UPDATE users SET status = CASE WHEN last_access IS NOT NULL THEN 'Activo' ELSE 'Pendiente' END WHERE id = $1 AND status = 'Inactivo'`,
							[userId]
						);
					}
					await logAccessEvent(manager, holdingId, userId, actor.userId, 'reactivated', { was_inactive: wasInactive });
				});
			} catch (error) {
				if (wasInactive && authId) await this.ban(authId, true).catch(() => undefined);
				throw error;
			}
		}

		return userDto(await this.member(holdingId, userId), actor);
	}

	private async ban(authId: string, banned: boolean): Promise<void> {
		try {
			await this.admin.setBanned(authId, banned);
		} catch (error) {
			if (error instanceof AuthAdminError) throw new BadGatewayException(MSG.authAccess);
			throw error;
		}
	}

	// ------------------------------------------------------------------ eliminar invitación

	async removeInvitation(holdingId: string, userId: string, actor: PermissionContext): Promise<void> {
		const user = await this.visibleMember(holdingId, userId, actor);

		if (user.is_super_admin === true || String(user.id) === actor.userId || user.status !== 'Pendiente' || user.last_access) {
			throw new ConflictException(MSG.cannotDelete);
		}
		if (await hasReferences(this.dataSource, userId)) throw new ConflictException(MSG.cannotDelete);
		const [others] = (await this.dataSource.query(`SELECT count(*) AS n FROM user_holdings WHERE user_id = $1 AND holding_id <> $2`, [
			userId,
			holdingId,
		])) as Row[];
		const onlyThisHolding = toCount(others?.n) === 0;

		await this.dataSource.transaction(async (manager) => {
			await logAccessEvent(manager, holdingId, userId, actor.userId, 'invitation_deleted', {
				email: String(user.email),
				name: (user.name as string | null) ?? null,
				account_deleted: onlyThisHolding,
			});
			if (onlyThisHolding) {
				// `user_access_events.user_id` queda NULL (ON DELETE SET NULL); el correo queda en `details`.
				await manager.query(`DELETE FROM users WHERE id = $1`, [userId]);
			} else {
				await manager.query(`DELETE FROM user_holdings WHERE user_id = $1 AND holding_id = $2`, [userId, holdingId]);
			}
		});
		const authId = (user.auth_id as string | null) ?? null;

		if (onlyThisHolding && authId) {
			// La fila ya no existe: si Auth falla solo se registra (la cuenta queda huérfana y sin acceso a ningún holding).
			await this.admin.deleteUser(authId).catch((error: Error) => this.logger.warn(`Cuenta de Auth ${authId} no borrada: ${error.message}`));
		}
	}

	// ------------------------------------------------------------------ comunes

	private async member(holdingId: string, userId: string): Promise<Row> {
		const [row] = (await this.dataSource.query(`${USER_SELECT} WHERE uh.holding_id = $1 AND u.id = $2`, [holdingId, userId])) as Row[];

		if (!row) throw new NotFoundException(MSG.notFound);

		return row;
	}

	/** Miembro del holding; un super admin solo existe para otro super admin (si no, 404 como cualquier id ajeno). */
	private async visibleMember(holdingId: string, userId: string, actor: PermissionContext): Promise<Row> {
		const row = await this.member(holdingId, userId);

		if (row.is_super_admin === true && !actor.isSuperAdmin) throw new NotFoundException(MSG.notFound);

		return row;
	}

	/** `${INVITE_LANDING_URL}/auth/confirm?…&type=…&next=/dashboard` (sin token = `redirectTo` de Supabase). 503 si falta la variable. */
	private confirmUrl(type: InviteLinkType | GeneratedLink['type'], tokenHash?: string): string {
		const url = authConfirmUrl(this.config.get<string>('INVITE_LANDING_URL'), type, '/dashboard', tokenHash);

		if (!url) throw new ServiceUnavailableException(MSG.notConfigured);

		return url;
	}

	/** Datos del correo desde la base (nunca del body): holding, quien invita, rol del invitado y lo que ese rol permite. */
	private async sendMail(
		holdingId: string,
		userId: string,
		email: string,
		inviteeName: string | null,
		link: GeneratedLink,
		actor: PermissionContext,
		sendNumber: number
	): Promise<MailResult> {
		const [holding] = (await this.dataSource.query(`SELECT name FROM company_holdings WHERE id = $1`, [holdingId])) as Row[];
		const [inviter] = (await this.dataSource.query(`SELECT name, email FROM users WHERE id = $1`, [actor.userId])) as Row[];
		const inviterName = String((inviter?.name as string | null)?.trim() || inviter?.email || actor.name || actor.email);
		// Rol del invitado y sus permisos reales (rol del mismo holding). Sin rol visible, el correo omite el bloque.
		const [role] = (await this.dataSource.query(
			`SELECT r.name AS role_name, COALESCE(array_agg(p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS codes
			FROM users u JOIN roles r ON r.id = u.role_id AND r.holding_id = $2
			LEFT JOIN role_permissions rp ON rp.role_id = r.id LEFT JOIN permissions p ON p.id = rp.permission_id
			WHERE u.id = $1 GROUP BY r.id, r.name`,
			[userId, holdingId]
		)) as Row[];
		const roleName = (role?.role_name as string | null)?.trim() || null;

		return this.mailer.sendInvitation(
			email,
			{
				inviterName,
				holdingName: String(holding?.name ?? 'Sapira'),
				inviteeName,
				roleName,
				capabilities: roleName ? roleCapabilities((role?.codes as string[] | null) ?? []) : [],
				link: this.confirmUrl(link.type, link.hashedToken),
			},
			`invite-${userId}-${sendNumber}`
		);
	}

	private async recordSend(userId: string, mail: MailResult): Promise<void> {
		await this.dataSource.query(
			`UPDATE users SET last_invitation_status = $2,
				last_invitation_sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE last_invitation_sent_at END,
				last_invitation_email_id = CASE WHEN $2 = 'sent' THEN $3 ELSE last_invitation_email_id END
			WHERE id = $1`,
			[userId, mail.status, mail.status === 'sent' ? mail.id : null]
		);
	}
}

/** Registro de auditoría (M15). `actor_user_id` siempre de la sesión. */
export async function logAccessEvent(
	db: Queryable,
	holdingId: string,
	userId: string | null,
	actorUserId: string,
	action: UserAccessAction,
	details: Record<string, unknown> = {}
): Promise<void> {
	await db.query(`INSERT INTO user_access_events (holding_id, user_id, actor_user_id, action, details) VALUES ($1, $2, $3, $4, $5::jsonb)`, [
		holdingId,
		userId,
		actorUserId,
		action,
		JSON.stringify(details),
	]);
}

/**
 * ¿Algún registro de negocio apunta al usuario? Lee las FK hacia `public.users` de `pg_constraint` en el momento (así una tabla nueva no
 * queda fuera) y descarta las de la propia persona (`OWNED_USER_TABLES`). Los identificadores salen del catálogo, ya citados con
 * `quote_ident` / `regclass`.
 */
export async function hasReferences(db: Queryable, userId: string): Promise<boolean> {
	const fks = (await db.query(
		`SELECT c.conrelid::regclass::text AS tbl, quote_ident(a.attname) AS col, cl.relname AS relname
		FROM pg_constraint c
		JOIN pg_class cl ON cl.oid = c.conrelid
		JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
		WHERE c.contype = 'f' AND c.confrelid = 'public.users'::regclass AND NOT (cl.relname = ANY ($1::text[]))`,
		[[...OWNED_USER_TABLES]]
	)) as Row[];
	const seen = new Set<string>();
	const checks = fks
		.map((fk) => `${String(fk.tbl)}|${String(fk.col)}`)
		.filter((key) => (seen.has(key) ? false : (seen.add(key), true)))
		.map((key) => {
			const [table, column] = key.split('|');

			return `EXISTS (SELECT 1 FROM ${table} WHERE ${column} = $1)`;
		});

	if (!checks.length) return false;
	const [row] = (await db.query(`SELECT (${checks.join(' OR ')}) AS referenced`, [userId])) as Row[];

	return row?.referenced === true;
}

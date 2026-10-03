import {
	BadRequestException,
	ConflictException,
	HttpException,
	Injectable,
	Logger,
	NotFoundException,
	ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { EmailsService } from '@/modules/emails/emails.service';

import { plural, Row, toCount, withUniqueMessage } from './settings-common';

import type { CreateDomainDto, CreateSenderDto, TestEmailDto, UpdateDomainDto, UpdateSenderDto } from './dtos/communications.dto';

type DnsRecord = { type: string; name: string; value: string; status: string };
type ValidationResult = { valid?: boolean; reason?: string | null };

const SENDGRID_API = 'https://api.sendgrid.com/v3';
const NOT_CONFIGURED = 'El servicio de correo no está configurado: avisa a soporte';
const UNREACHABLE = 'No se pudo conectar con el servicio de correo: vuelve a intentarlo';
/** Orden de los registros DNS que guarda `EmailsService.verifyDomain` (mail_cname, dkim1, dkim2, DMARC). */
const VALIDATED_RECORDS = ['mail_cname', 'dkim1', 'dkim2'] as const;

const SENDER_COLUMNS = `s.id, s.domain_config_id, s.from_name, s.from_email, s.reply_to_email, s.purpose, s.is_default, s.is_active, s.created_at, s.updated_at,
	(SELECT count(*) FROM client_agent_configs a WHERE a.holding_id = d.holding_id AND a.config_json->>'email_sender_address_id' = s.id::text) AS in_use`;

const senderDto = (row: Row) => ({
	id: String(row.id),
	domain_id: String(row.domain_config_id),
	from_name: String(row.from_name ?? ''),
	from_email: String(row.from_email ?? ''),
	reply_to_email: (row.reply_to_email as string | null) ?? null,
	purpose: (row.purpose as string | null) ?? null,
	is_default: row.is_default === true,
	is_active: row.is_active === true,
	in_use: toCount(row.in_use),
	created_at: row.created_at,
	updated_at: row.updated_at,
});

const parseRecords = (value: unknown): DnsRecord[] => {
	let raw = value;

	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw);
		} catch {
			raw = [];
		}
	}

	return Array.isArray(raw)
		? (raw as Row[]).map((record) => ({
				type: String(record.type ?? ''),
				name: String(record.name ?? record.host ?? ''),
				value: String(record.value ?? record.data ?? ''),
				status: String(record.status ?? 'pending'),
			}))
		: [];
};

/** El correo del remitente debe ser del dominio registrado o de su dominio base (`mail.empresa.com` autentica `empresa.com`). */
export function emailBelongsToDomain(email: string, senderDomain: string): boolean {
	const emailDomain = email.split('@')[1]?.toLowerCase() ?? '';
	const domain = senderDomain.toLowerCase();

	return Boolean(emailDomain) && (emailDomain === domain || domain.endsWith(`.${emailDomain}`));
}

/**
 * Comunicaciones del holding (contrato §8.2): dominios de envío y remitentes sobre `holding_email_sender_settings` /
 * `email_sender_addresses`, con SendGrid. **Siempre** con el holding validado por `HoldingScopeGuard`: cada id se filtra por holding (404 si
 * no es suyo). Reutiliza `EmailsService` (registro del dominio en SendGrid, borrado y envío); las rutas viejas `/emails/*` no se tocan.
 */
@Injectable()
export class SettingsCommunicationsService {
	private readonly logger = new Logger(SettingsCommunicationsService.name);

	constructor(
		private readonly dataSource: DataSource,
		private readonly emails: EmailsService,
		private readonly config: ConfigService
	) {}

	private apiKey(): string {
		const key = this.config.get<string>('SENDGRID_API_KEY');

		if (!key) throw new BadRequestException(NOT_CONFIGURED);

		return key;
	}

	// ── Dominios ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

	private async domainRows(holdingId: string, domainId?: string): Promise<Row[]> {
		return (await this.dataSource.query(
			`SELECT * FROM holding_email_sender_settings WHERE holding_id = $1 AND ($2::uuid IS NULL OR id = $2::uuid)
			ORDER BY is_default DESC, created_at DESC`,
			[holdingId, domainId ?? null]
		)) as Row[];
	}

	private async sendersOf(holdingId: string, domainIds: string[]): Promise<Row[]> {
		if (!domainIds.length) return [];

		return (await this.dataSource.query(
			`SELECT ${SENDER_COLUMNS} FROM email_sender_addresses s JOIN holding_email_sender_settings d ON d.id = s.domain_config_id
			WHERE d.holding_id = $1 AND d.id = ANY($2::uuid[]) ORDER BY s.is_default DESC, s.created_at DESC`,
			[holdingId, domainIds]
		)) as Row[];
	}

	private domainDto(row: Row, senders: Row[]) {
		return {
			id: String(row.id),
			sender_domain: String(row.sender_domain),
			display_name: (row.display_name as string | null) ?? null,
			status: String(row.domain_status ?? 'pending'),
			verified_at: row.domain_verified_at ?? null,
			is_default: row.is_default === true,
			is_active: row.is_active === true,
			dns_records: parseRecords(row.domain_dns_records),
			created_at: row.created_at,
			updated_at: row.updated_at,
			senders: senders.filter((sender) => String(sender.domain_config_id) === String(row.id)).map(senderDto),
		};
	}

	async listDomains(holdingId: string) {
		const rows = await this.domainRows(holdingId);
		const senders = await this.sendersOf(
			holdingId,
			rows.map((row) => String(row.id))
		);

		return rows.map((row) => this.domainDto(row, senders));
	}

	private async findDomainRow(holdingId: string, id: string): Promise<Row> {
		const [row] = await this.domainRows(holdingId, id);

		if (!row) throw new NotFoundException('Dominio no encontrado');

		return row;
	}

	async getDomain(holdingId: string, id: string) {
		const row = await this.findDomainRow(holdingId, id);

		return this.domainDto(row, await this.sendersOf(holdingId, [id]));
	}

	async createDomain(holdingId: string, dto: CreateDomainDto, authId: string) {
		this.apiKey();
		if (!emailBelongsToDomain(dto.from_email, dto.sender_domain)) {
			throw new BadRequestException(`El correo del remitente debe ser del dominio ${dto.sender_domain}`);
		}
		const existing = (await this.dataSource.query(`SELECT id, is_default FROM holding_email_sender_settings WHERE holding_id = $1`, [
			holdingId,
		])) as Row[];

		if (
			(
				(await this.dataSource.query(`SELECT 1 FROM holding_email_sender_settings WHERE holding_id = $1 AND lower(sender_domain) = $2`, [
					holdingId,
					dto.sender_domain,
				])) as Row[]
			).length
		) {
			throw new ConflictException('Ese dominio ya está registrado en el holding');
		}
		const makeDefault = dto.is_default === true || !existing.some((row) => row.is_default === true);
		let created: { id: string };

		try {
			created = (await this.emails.verifyDomain(
				{
					holding_id: holdingId,
					sender_domain: dto.sender_domain,
					from_name: dto.from_name,
					from_email: dto.from_email,
					display_name: dto.display_name ?? undefined,
					is_default: false,
				},
				authId
			)) as unknown as { id: string };
		} catch (error) {
			if (error instanceof BadRequestException) {
				const message = (error.getResponse() as { message?: string })?.message ?? error.message;

				throw new BadRequestException(message === NOT_CONFIGURED ? message : `SendGrid rechazó el dominio: ${message}`);
			}
			this.logger.error(`No se pudo registrar el dominio ${dto.sender_domain}`, error as Error);
			throw new ServiceUnavailableException(UNREACHABLE);
		}
		if (makeDefault) await this.setDefaultDomain(holdingId, created.id);

		return this.getDomain(holdingId, created.id);
	}

	private async setDefaultDomain(holdingId: string, id: string) {
		await this.dataSource.query(
			`UPDATE holding_email_sender_settings SET is_default = (id = $2), updated_at = now()
			WHERE holding_id = $1 AND (is_default OR id = $2)`,
			[holdingId, id]
		);
	}

	async updateDomain(holdingId: string, id: string, dto: UpdateDomainDto) {
		const current = await this.findDomainRow(holdingId, id);
		const willBeDefault = dto.is_default ?? current.is_default === true;
		const willBeActive = dto.is_active ?? current.is_active === true;

		if (willBeDefault && !willBeActive) throw new ConflictException('Marca otro dominio por defecto antes de desactivar este');
		if (dto.is_default === true) await this.setDefaultDomain(holdingId, id);
		await this.dataSource.query(
			`UPDATE holding_email_sender_settings SET display_name = $3, is_active = $4, is_default = $5, updated_at = now()
			WHERE id = $1 AND holding_id = $2`,
			[id, holdingId, dto.display_name === undefined ? (current.display_name ?? null) : dto.display_name, willBeActive, willBeDefault]
		);

		return this.getDomain(holdingId, id);
	}

	async deleteDomain(holdingId: string, id: string): Promise<void> {
		await this.findDomainRow(holdingId, id);
		const inUse = (await this.sendersOf(holdingId, [id])).reduce((sum, sender) => sum + toCount(sender.in_use), 0);

		if (inUse > 0) {
			throw new ConflictException(
				`Un remitente de este dominio lo usan ${plural(inUse, 'agente de clientes', 'agentes de clientes')}: cámbialo antes de eliminar el dominio`
			);
		}
		// Quita el dominio de SendGrid (best effort) y borra la fila; los remitentes caen por la FK en cascada.
		await this.emails.deleteDomain({ domain_id: id });
	}

	private async sendgrid(path: string, method: 'GET' | 'POST'): Promise<Row> {
		const key = this.apiKey();
		let response: Response;

		try {
			response = await fetch(`${SENDGRID_API}${path}`, { method, headers: { Authorization: `Bearer ${key}` } });
		} catch (error) {
			this.logger.error(`SendGrid ${method} ${path}`, error as Error);
			throw new ServiceUnavailableException(UNREACHABLE);
		}
		const body = (await response.json().catch(() => ({}))) as Row;

		if (!response.ok) {
			const message = ((body.errors as Row[] | undefined)?.[0]?.message as string | undefined) ?? 'error desconocido';

			if (response.status === 404) throw new ConflictException('SendGrid ya no tiene este dominio: elimínalo y vuelve a registrarlo');
			throw new BadRequestException(`SendGrid rechazó la consulta: ${message}`);
		}

		return body;
	}

	/** Aplica a los registros guardados el resultado de SendGrid y actualiza el estado del dominio. */
	private async saveStatus(row: Row, valid: boolean, results: Record<string, ValidationResult | undefined>) {
		const records = parseRecords(row.domain_dns_records);

		VALIDATED_RECORDS.forEach((key, index) => {
			if (records[index] && results[key]) records[index].status = results[key]?.valid ? 'verified' : 'pending';
		});
		const status = valid ? 'verified' : 'pending';

		await this.dataSource.query(
			`UPDATE holding_email_sender_settings SET domain_status = $3, domain_dns_records = $4::jsonb,
				domain_verified_at = CASE WHEN $3 = 'verified' THEN COALESCE(domain_verified_at, now()) ELSE domain_verified_at END, updated_at = now()
			WHERE id = $1 AND holding_id = $2`,
			[row.id, row.holding_id, status, JSON.stringify(records)]
		);

		return status;
	}

	private sendgridId(row: Row): string {
		const id = row.resend_domain_id as string | null;

		if (!id) throw new ConflictException('El dominio no está registrado en SendGrid: elimínalo y vuelve a registrarlo');

		return encodeURIComponent(id);
	}

	/** Pide a SendGrid validar los DNS ahora. */
	async verifyDomain(holdingId: string, id: string) {
		const row = await this.findDomainRow(holdingId, id);
		const body = await this.sendgrid(`/whitelabel/domains/${this.sendgridId(row)}/validate`, 'POST');
		const results = (body.validation_results ?? {}) as Record<string, ValidationResult | undefined>;
		const status = await this.saveStatus(row, body.valid === true, results);

		return {
			status,
			domain: await this.getDomain(holdingId, id),
			results: VALIDATED_RECORDS.map((record) => ({
				record,
				valid: results[record]?.valid === true,
				reason: results[record]?.reason ?? null,
			})),
		};
	}

	/** Lee el estado actual en SendGrid (sin pedir validación) y refresca el estado guardado. */
	async checkStatus(holdingId: string, id: string) {
		const row = await this.findDomainRow(holdingId, id);
		const body = await this.sendgrid(`/whitelabel/domains/${this.sendgridId(row)}`, 'GET');
		const dns = (body.dns ?? {}) as Record<string, ValidationResult | undefined>;
		const status = await this.saveStatus(row, body.valid === true, dns);

		return { status, domain: await this.getDomain(holdingId, id) };
	}

	// ── Remitentes ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

	async listSenders(holdingId: string, domainId?: string) {
		const domains = await this.domainRows(holdingId, domainId);

		if (domainId && !domains.length) throw new NotFoundException('Dominio no encontrado');

		return (
			await this.sendersOf(
				holdingId,
				domains.map((row) => String(row.id))
			)
		).map(senderDto);
	}

	private async findSender(holdingId: string, id: string): Promise<{ sender: Row; domain: Row }> {
		const [sender] = (await this.dataSource.query(
			`SELECT ${SENDER_COLUMNS}, d.sender_domain FROM email_sender_addresses s JOIN holding_email_sender_settings d ON d.id = s.domain_config_id
			WHERE s.id = $1 AND d.holding_id = $2`,
			[id, holdingId]
		)) as Row[];

		if (!sender) throw new NotFoundException('Remitente no encontrado');

		return { sender, domain: await this.findDomainRow(holdingId, String(sender.domain_config_id)) };
	}

	private async getSender(holdingId: string, id: string) {
		return senderDto((await this.findSender(holdingId, id)).sender);
	}

	private async setDefaultSender(domainId: string, id: string) {
		await this.dataSource.query(
			`UPDATE email_sender_addresses SET is_default = (id = $2), updated_at = now() WHERE domain_config_id = $1 AND (is_default OR id = $2)`,
			[domainId, id]
		);
	}

	private async assertSenderFree(domainId: string, email: string, excludeId: string | null) {
		const rows = (await this.dataSource.query(
			`SELECT 1 FROM email_sender_addresses WHERE domain_config_id = $1 AND lower(from_email) = lower($2) AND id IS DISTINCT FROM $3::uuid LIMIT 1`,
			[domainId, email, excludeId]
		)) as Row[];

		if (rows.length) throw new ConflictException('Ya existe ese remitente en este dominio');
	}

	async createSender(holdingId: string, dto: CreateSenderDto, authId: string) {
		const domain = await this.findDomainRow(holdingId, dto.domain_id);

		if (!emailBelongsToDomain(dto.from_email, String(domain.sender_domain))) {
			throw new BadRequestException(`El correo del remitente debe ser del dominio ${String(domain.sender_domain)}`);
		}
		await this.assertSenderFree(dto.domain_id, dto.from_email, null);
		const hasDefault = (
			(await this.dataSource.query(`SELECT 1 FROM email_sender_addresses WHERE domain_config_id = $1 AND is_default`, [dto.domain_id])) as Row[]
		).length;
		const [row] = await withUniqueMessage(
			async () =>
				(await this.dataSource.query(
					`INSERT INTO email_sender_addresses (domain_config_id, from_name, from_email, reply_to_email, purpose, is_default, is_active, created_by)
					VALUES ($1, $2, $3, $4, $5, false, true, (SELECT id FROM users WHERE auth_id = $6 LIMIT 1)) RETURNING id`,
					[dto.domain_id, dto.from_name, dto.from_email, dto.reply_to_email ?? null, dto.purpose ?? null, authId || null]
				)) as Row[],
			'Ya existe ese remitente en este dominio'
		);

		if (dto.is_default === true || !hasDefault) await this.setDefaultSender(dto.domain_id, String(row.id));

		return this.getSender(holdingId, String(row.id));
	}

	async updateSender(holdingId: string, id: string, dto: UpdateSenderDto) {
		const { sender, domain } = await this.findSender(holdingId, id);
		const email = dto.from_email ?? String(sender.from_email);

		if (dto.from_email !== undefined) {
			if (!emailBelongsToDomain(email, String(domain.sender_domain))) {
				throw new BadRequestException(`El correo del remitente debe ser del dominio ${String(domain.sender_domain)}`);
			}
			await this.assertSenderFree(String(domain.id), email, id);
		}
		await this.dataSource.query(
			`UPDATE email_sender_addresses SET from_name = $2, from_email = $3, reply_to_email = $4, purpose = $5, is_active = $6, updated_at = now()
			WHERE id = $1`,
			[
				id,
				dto.from_name ?? sender.from_name,
				email,
				dto.reply_to_email === undefined ? (sender.reply_to_email ?? null) : dto.reply_to_email,
				dto.purpose === undefined ? (sender.purpose ?? null) : dto.purpose,
				dto.is_active ?? sender.is_active,
			]
		);
		if (dto.is_default === true) await this.setDefaultSender(String(domain.id), id);
		else if (dto.is_default === false && sender.is_default === true) {
			await this.dataSource.query(`UPDATE email_sender_addresses SET is_default = false, updated_at = now() WHERE id = $1`, [id]);
		}

		return this.getSender(holdingId, id);
	}

	async deleteSender(holdingId: string, id: string): Promise<void> {
		const { sender } = await this.findSender(holdingId, id);
		const inUse = toCount(sender.in_use);

		if (inUse > 0) {
			throw new ConflictException(
				`Este remitente lo usan ${plural(inUse, 'agente de clientes', 'agentes de clientes')}: cámbialo antes de eliminarlo`
			);
		}
		await this.dataSource.query(`DELETE FROM email_sender_addresses WHERE id = $1`, [id]);
	}

	// ── Correo de prueba ────────────────────────────────────────────────────────────────────────────────────────────────────────

	async sendTestEmail(holdingId: string, dto: TestEmailDto, authId: string) {
		const allowed = (await this.dataSource.query(
			`SELECT 1 FROM users u WHERE u.auth_id = $2 AND lower(u.email) = $3
			UNION ALL
			SELECT 1 FROM user_holdings uh JOIN users u ON u.id = uh.user_id
			WHERE uh.holding_id = $1 AND uh.is_active = true AND lower(u.email) = $3
			LIMIT 1`,
			[holdingId, authId, dto.to.toLowerCase()]
		)) as Row[];

		if (!allowed.length) throw new BadRequestException('Solo puedes enviar la prueba a tu correo o al de un miembro del holding');
		let sender: Row;
		let domain: Row;

		if (dto.sender_id) ({ sender, domain } = await this.findSender(holdingId, dto.sender_id));
		else {
			const [row] = (await this.dataSource.query(
				`SELECT ${SENDER_COLUMNS} FROM email_sender_addresses s JOIN holding_email_sender_settings d ON d.id = s.domain_config_id
				WHERE d.holding_id = $1 AND d.is_default AND d.is_active AND s.is_default
				LIMIT 1`,
				[holdingId]
			)) as Row[];

			if (!row) throw new NotFoundException('No hay un dominio por defecto con remitente: configúralo primero');
			sender = row;
			domain = await this.findDomainRow(holdingId, String(row.domain_config_id));
		}
		if (domain.domain_status !== 'verified') {
			throw new ConflictException('El dominio aún no está verificado: configura los registros DNS y verifica');
		}
		if (sender.is_active !== true) throw new ConflictException('El remitente está desactivado');
		this.apiKey();
		const from = String(sender.from_email);

		try {
			await this.emails.send({
				to: dto.to,
				subject: 'Correo de prueba · Sapira',
				html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
					<h2>Configuración de correo lista</h2>
					<p>Este es un correo de prueba enviado desde <strong>${String(domain.sender_domain)}</strong>.</p>
					<p style="color: #666; font-size: 12px;">Remitente: ${String(sender.from_name)} &lt;${from}&gt;</p>
				</div>`,
				from,
				fromName: String(sender.from_name ?? from),
				replyTo: (sender.reply_to_email as string | null) ?? undefined,
			});
		} catch (error) {
			if (error instanceof BadRequestException) {
				const message = (error.getResponse() as { message?: string })?.message ?? error.message;

				throw new BadRequestException(`SendGrid rechazó el envío: ${message}`);
			}
			if (error instanceof HttpException && error.getStatus() < 500) throw error;
			throw new ServiceUnavailableException(UNREACHABLE);
		}

		return { message: `Correo de prueba enviado a ${dto.to}`, to: dto.to, from };
	}
}

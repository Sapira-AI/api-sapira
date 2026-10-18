import { promises as dns } from 'dns';

import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { FacturaClientService } from '@/modules/factura/factura-client.service';

import { Row } from './settings-common';

type DnsRecord = { type: string; name: string; value: string; priority?: number; status: 'pending' | 'verified' };

const SENDGRID_API = 'https://api.sendgrid.com/v3';
/** Servidor de SendGrid que recibe el correo de un dominio con Inbound Parse. */
export const MX_SENDGRID = 'mx.sendgrid.net';
const NOT_CONFIGURED = 'El servicio de correo no está configurado: avisa a soporte';
const UNREACHABLE = 'No se pudo conectar con el servicio de correo: vuelve a intentarlo';
const CNAMES = ['mail_cname', 'dkim1', 'dkim2'] as const;

/** Un subdominio (al menos tres etiquetas): un MX en el dominio raíz se llevaría todo el correo del holding. */
export function esSubdominio(dominio: string): boolean {
	return /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.){2,}[a-z]{2,63}$/.test(dominio);
}

/**
 * Dominio de recepción de documentos tributarios del holding (intercambio SII): un subdominio con MX hacia SendGrid y autenticado
 * en SendGrid para responder desde sus casillas. Al verificarse, registra el canal de correo de Sapira en api-factura y crea el
 * Inbound Parse que lleva los correos a su webhook. Siempre acotado por el holding del header.
 */
@Injectable()
export class SettingsInboundDomainService {
	private readonly logger = new Logger(SettingsInboundDomainService.name);

	constructor(
		private readonly dataSource: DataSource,
		private readonly config: ConfigService,
		private readonly factura: FacturaClientService
	) {}

	async get(holdingId: string) {
		const row = await this.row(holdingId);
		return row ? this.dto(row) : null;
	}

	async create(holdingId: string, inboundDomain: string, authId: string | null) {
		const dominio = inboundDomain.trim().toLowerCase();
		if (!esSubdominio(dominio))
			throw new BadRequestException(
				'Usa un subdominio, por ejemplo dte.miempresa.cl: un MX en el dominio principal se llevaría todo tu correo'
			);
		if (await this.row(holdingId)) throw new ConflictException('El holding ya tiene un dominio de recepción: elimínalo para cambiarlo');
		const [ocupado] = (await this.dataSource.query(`SELECT 1 FROM holding_inbound_email_domains WHERE inbound_domain = $1`, [dominio])) as Row[];
		if (ocupado) throw new ConflictException('Ese dominio ya está en uso');

		const autenticado = await this.sendgrid('/whitelabel/domains', 'POST', { domain: dominio, automatic_security: true });
		const dnsSendgrid = (autenticado.dns ?? {}) as Record<string, { host?: string; data?: string; type?: string }>;
		const registros: DnsRecord[] = [
			{ type: 'MX', name: dominio, value: MX_SENDGRID, priority: 10, status: 'pending' },
			...CNAMES.filter((clave) => dnsSendgrid[clave]).map((clave) => ({
				type: String(dnsSendgrid[clave].type ?? 'cname').toUpperCase(),
				name: String(dnsSendgrid[clave].host ?? ''),
				value: String(dnsSendgrid[clave].data ?? ''),
				status: 'pending' as const,
			})),
		];
		await this.dataSource.query(
			`INSERT INTO holding_inbound_email_domains (holding_id, inbound_domain, sendgrid_domain_id, dns_records, created_by) VALUES ($1, $2, $3, $4::jsonb, (SELECT id FROM users WHERE auth_id = $5 LIMIT 1))`,
			[holdingId, dominio, autenticado.id == null ? null : String(autenticado.id), JSON.stringify(registros), authId]
		);

		return this.get(holdingId);
	}

	/**
	 * Revisa el MX (DNS) y los CNAME (SendGrid). Con todo puesto: registra el canal de correo en api-factura y crea (o apunta) el
	 * Inbound Parse del dominio hacia su webhook.
	 */
	async verify(holdingId: string) {
		const row = await this.rowOrFail(holdingId);
		const dominio = String(row.inbound_domain);
		const registros = parseRecords(row.dns_records);

		const mxOk = await this.tieneMxSendgrid(dominio);
		const validacion = row.sendgrid_domain_id
			? await this.sendgrid(`/whitelabel/domains/${encodeURIComponent(String(row.sendgrid_domain_id))}/validate`, 'POST')
			: { valid: false, validation_results: {} };
		const resultados = (validacion.validation_results ?? {}) as Record<string, { valid?: boolean } | undefined>;
		for (const registro of registros) {
			if (registro.type === 'MX') registro.status = mxOk ? 'verified' : 'pending';
		}
		CNAMES.forEach((clave, indice) => {
			const registro = registros.filter((item) => item.type !== 'MX')[indice];
			if (registro) registro.status = resultados[clave]?.valid ? 'verified' : 'pending';
		});
		const verificado = mxOk && validacion.valid === true;

		let parse = row.inbound_parse_configured_at ?? null;
		if (verificado && !parse) {
			const { inboundUrl } = await this.factura.registrarCanalCorreo(this.apiKey());
			await this.configurarInboundParse(dominio, inboundUrl);
			parse = new Date();
		}
		await this.dataSource.query(
			`UPDATE holding_inbound_email_domains SET dns_records = $3::jsonb, domain_status = $4,
				mx_verified_at = CASE WHEN $5 THEN COALESCE(mx_verified_at, now()) ELSE NULL END,
				domain_verified_at = CASE WHEN $4 = 'verified' THEN COALESCE(domain_verified_at, now()) ELSE domain_verified_at END,
				inbound_parse_configured_at = $6, updated_at = now()
			WHERE id = $1 AND holding_id = $2`,
			[row.id, holdingId, JSON.stringify(registros), verificado ? 'verified' : 'pending', mxOk, parse]
		);

		return this.get(holdingId);
	}

	async remove(holdingId: string): Promise<void> {
		const row = await this.rowOrFail(holdingId);
		const dominio = String(row.inbound_domain);
		// SendGrid best effort: el dominio deja de recibir aunque falle, porque se borra la fila.
		await this.sendgrid(`/user/webhooks/parse/settings/${encodeURIComponent(dominio)}`, 'DELETE').catch(() => undefined);
		if (row.sendgrid_domain_id) {
			await this.sendgrid(`/whitelabel/domains/${encodeURIComponent(String(row.sendgrid_domain_id))}`, 'DELETE').catch(() => undefined);
		}
		await this.dataSource.query(`DELETE FROM holding_inbound_email_domains WHERE id = $1 AND holding_id = $2`, [row.id, holdingId]);
	}

	private async configurarInboundParse(dominio: string, url: string) {
		try {
			await this.sendgrid('/user/webhooks/parse/settings', 'POST', { hostname: dominio, url, spam_check: false, send_raw: false });
		} catch (error) {
			// Ya existía (p. ej. se verificó antes): se actualiza la URL.
			if (!(error instanceof BadRequestException)) throw error;
			await this.sendgrid(`/user/webhooks/parse/settings/${encodeURIComponent(dominio)}`, 'PATCH', { url, spam_check: false, send_raw: false });
		}
	}

	private async tieneMxSendgrid(dominio: string): Promise<boolean> {
		try {
			const registros = await dns.resolveMx(dominio);
			return registros.some((registro) => registro.exchange.replace(/\.$/, '').toLowerCase() === MX_SENDGRID);
		} catch {
			return false;
		}
	}

	private apiKey(): string {
		const key = this.config.get<string>('SENDGRID_API_KEY');
		if (!key) throw new BadRequestException(NOT_CONFIGURED);
		return key;
	}

	private async sendgrid(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<Row> {
		const key = this.apiKey();
		let response: Response;
		try {
			response = await fetch(`${SENDGRID_API}${path}`, {
				method,
				headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
				...(body ? { body: JSON.stringify(body) } : {}),
			});
		} catch (error) {
			this.logger.error(`SendGrid ${method} ${path}`, error as Error);
			throw new ServiceUnavailableException(UNREACHABLE);
		}
		const contenido = (await response.json().catch(() => ({}))) as Row;
		if (!response.ok) {
			const mensaje = ((contenido.errors as Row[] | undefined)?.[0]?.message as string | undefined) ?? 'error desconocido';
			throw new BadRequestException(`SendGrid rechazó la operación: ${mensaje}`);
		}
		return contenido;
	}

	private async row(holdingId: string): Promise<Row | undefined> {
		const [row] = (await this.dataSource.query(`SELECT * FROM holding_inbound_email_domains WHERE holding_id = $1`, [holdingId])) as Row[];
		return row;
	}

	private async rowOrFail(holdingId: string): Promise<Row> {
		const row = await this.row(holdingId);
		if (!row) throw new NotFoundException('El holding no tiene dominio de recepción');
		return row;
	}

	private dto(row: Row) {
		return {
			id: String(row.id),
			inbound_domain: String(row.inbound_domain),
			status: String(row.domain_status ?? 'pending'),
			dns_records: parseRecords(row.dns_records),
			mx_verified_at: row.mx_verified_at ?? null,
			verified_at: row.domain_verified_at ?? null,
			inbound_parse_configured_at: row.inbound_parse_configured_at ?? null,
			created_at: row.created_at,
		};
	}
}

function parseRecords(value: unknown): DnsRecord[] {
	const raw = typeof value === 'string' ? safeJson(value) : value;
	return Array.isArray(raw) ? (raw as DnsRecord[]) : [];
}

function safeJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return [];
	}
}

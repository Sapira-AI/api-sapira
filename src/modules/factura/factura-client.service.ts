import { BadGatewayException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

import { FacturaOAuthService } from './factura-oauth.service';

export interface ProvisionFacturaEmpresa {
	externalReference: {
		companyId: string;
		tenantId?: string;
	};
	rut: string;
	razonSocial: string;
	giro: string;
	direccion: string;
	comuna: string;
	ciudad: string;
	region?: string;
	/** Códigos de actividad económica (`Acteco`), de 1 a 4. */
	actividadesEconomicas?: string[];
	ambienteSII?: 'certificacion' | 'produccion';
}

@Injectable()
export class FacturaClientService {
	constructor(
		private readonly config: ConfigService,
		private readonly oauth: FacturaOAuthService
	) {}

	/** URL de api-factura; sin ella la integración no está configurada en este ambiente (503 con el motivo, no un 500 genérico). */
	private baseUrl() {
		const baseUrl = this.config.get<string>('FACTURA_API_URL');
		if (!baseUrl) throw new ServiceUnavailableException('El servicio de facturación no está configurado en api-sapira (falta FACTURA_API_URL)');
		return baseUrl;
	}

	async provisionEmpresa(empresa: ProvisionFacturaEmpresa) {
		const baseUrl = this.baseUrl();
		const token = await this.oauth.getAccessToken().catch((error: unknown) => {
			throw facturaTokenError(error, 'provision');
		});
		try {
			return await axios.post(`${baseUrl.replace(/\/$/, '')}/empresas/provision`, empresa, {
				headers: { Authorization: `Bearer ${token}` },
			});
		} catch (error) {
			throw facturaHttpError(error);
		}
	}

	/**
	 * Registra (o reemplaza) la clave de SendGrid de Sapira como canal de correo del integrador en api-factura, para que
	 * envíe las respuestas de intercambio de las compañías. Idempotente. Devuelve la URL de Inbound Parse con su secreto.
	 */
	async registrarCanalCorreo(sendgridApiKey: string): Promise<{ inboundUrl: string }> {
		const baseUrl = this.baseUrl();
		const token = await this.oauth.getAccessToken().catch((error: unknown) => {
			throw facturaTokenError(error, 'provision');
		});
		try {
			const respuesta = await axios.put(
				`${baseUrl.replace(/\/$/, '')}/integrators/me/mail-channel`,
				{ sendgridApiKey },
				{ headers: { Authorization: `Bearer ${token}` } }
			);
			return { inboundUrl: (respuesta.data as { data: { inboundUrl: string } }).data.inboundUrl };
		} catch (error) {
			throw facturaHttpError(error);
		}
	}

	// ---------------------------------------------------------------- documentos tributarios (DTE)
	// La compañía va en `X-Factura-Company-Id` con su UUID de Sapira (api-factura la resuelve por el vínculo del integrador).

	/**
	 * Crea (timbra y firma) el DTE. `externalRef` (el id de la factura) lo hace idempotente: si ya existe, api-factura devuelve el mismo
	 * documento y no gasta otro folio. Sin `Emisor`, api-factura usa los datos del emisor de la compañía.
	 *
	 * Sapira emite **solo en producción** (`ambienteRequerido`): con la compañía aún en certificación, api-factura responde 409 antes de
	 * reservar folio, y la factura no queda «Emitida» con un folio de prueba. El ambiente vive en api-factura (perfil de certificación), no
	 * en `sii_configurations.environment`, que no se sincroniza al pasar a producción.
	 */
	async crearDte(
		companyId: string,
		body: Record<string, unknown>,
		externalRef: string,
		options: { reemitirRechazado?: boolean } = {}
	): Promise<DteCreado> {
		const { data } = await this.dteRequest<{ data: DteCreado & { id: unknown } }>(companyId, 'post', '/dte/createDte', {
			...body,
			externalRef,
			ambienteRequerido: 'produccion',
			// Reemitir un rechazado: api-factura lo archiva y emite uno nuevo con otro folio (sin esto devolvería el rechazado).
			...(options.reemitirRechazado ? { reemitirRechazado: true } : {}),
		});

		return { ...data.data, id: String(data.data.id) };
	}

	/** Envía el DTE al SII; devuelve el TrackId. */
	async enviarDte(companyId: string, dteId: string): Promise<{ trackId: string }> {
		const { data } = await this.dteRequest<{ data: { trackId: unknown } }>(companyId, 'post', '/dte/sendDte', { dteIds: [dteId] });

		return { trackId: String(data.data.trackId) };
	}

	/** Consulta en el SII el envío del DTE y devuelve su resultado (`en_proceso`, `aceptado`, `reparos`, `rechazado`). */
	async estadoDte(companyId: string, dteId: string): Promise<DteEstado> {
		const { data } = await this.dteRequest<{ data: DteEstado }>(companyId, 'get', `/dte/${encodeURIComponent(dteId)}/estado`);

		return data.data;
	}

	/** Envía el DTE aceptado a su receptor por correo (EnvioDTE + muestra impresa), desde la casilla de intercambio de la compañía. */
	async enviarReceptor(companyId: string, dteId: string, para: string): Promise<{ para: string; messageId?: string }> {
		const { data } = await this.dteRequest<{ data: { para: string; messageId?: string } }>(
			companyId,
			'post',
			`/dte/${encodeURIComponent(dteId)}/enviar-receptor`,
			{ para }
		);

		return data.data;
	}

	/** PDF en borrador del documento antes de emitirlo (mismo cuerpo que `crearDte`): sin folio ni timbre; no gasta folio. */
	async previewPdfDte(companyId: string, body: Record<string, unknown>): Promise<DteDocumento> {
		const respuesta = await this.dteRequest<ArrayBuffer>(companyId, 'post', '/dte/preview-pdf', body, 'arraybuffer');

		return { contenido: Buffer.from(respuesta.data), contentType: 'application/pdf', fileName: 'Borrador.pdf' };
	}

	/** PDF (ejemplar tributario o cedible) o XML firmado del DTE. */
	async documentoDte(
		companyId: string,
		dteId: string,
		formato: 'pdf' | 'xml',
		copia: 'tributaria' | 'cedible' = 'tributaria'
	): Promise<DteDocumento> {
		const path = formato === 'pdf' ? `/dte/${encodeURIComponent(dteId)}/pdf?copia=${copia}` : `/dte/${encodeURIComponent(dteId)}/xml`;
		const respuesta = await this.dteRequest<ArrayBuffer>(companyId, 'get', path, undefined, 'arraybuffer');
		const disposition = String(respuesta.headers?.['content-disposition'] ?? '');
		const fileName = disposition.match(/filename="?([^";]+)"?/)?.[1] ?? `DTE-${dteId}.${formato}`;

		return {
			contenido: Buffer.from(respuesta.data),
			contentType: String(respuesta.headers?.['content-type'] ?? (formato === 'pdf' ? 'application/pdf' : 'application/xml')),
			fileName,
		};
	}

	private async dteRequest<T>(
		companyId: string,
		method: 'get' | 'post',
		path: string,
		body?: unknown,
		responseType?: 'arraybuffer'
	): Promise<{ data: T; headers?: Record<string, unknown> }> {
		const baseUrl = this.baseUrl();
		const token = await this.oauth.getDteAccessToken().catch((error: unknown) => {
			throw facturaTokenError(error);
		});
		const headers = { Authorization: `Bearer ${token}`, 'X-Factura-Company-Id': companyId };
		const url = `${baseUrl.replace(/\/$/, '')}${path}`;
		// Timbrar, firmar y subir al SII puede tardar: más que el timeout por defecto de axios (sin límite) pero acotado.
		const options = { headers, timeout: 120_000, ...(responseType ? { responseType } : {}) };
		try {
			const respuesta = method === 'get' ? await axios.get<T>(url, options) : await axios.post<T>(url, body, options);

			return { data: respuesta.data, headers: respuesta.headers as Record<string, unknown> };
		} catch (error) {
			throw facturaHttpError(error);
		}
	}
}

/** DTE creado (o ya existente con esa referencia) en api-factura. */
export interface DteCreado {
	id: string;
	folio: number;
	tipoDte: number;
	ambiente: 'certificacion' | 'produccion';
	existente: boolean;
}

/** Resultado de consultar el envío de un DTE en el SII. */
export interface DteEstado {
	resultado: 'en_proceso' | 'aceptado' | 'reparos' | 'rechazado';
	estado: string;
	glosaEstado: string;
	trackId: string;
}

export interface DteDocumento {
	contenido: Buffer;
	contentType: string;
	fileName: string;
}

/** Errores del usuario que api-factura detecta en los datos (RUT, vínculo, validación): se devuelven con su estado. */
const ESTADOS_DEL_USUARIO = new Set([400, 409, 422]);

/**
 * Traduce un error de api-factura a uno de la API con su mensaje real (antes llegaba como 500 "Request failed with
 * status code 403"). Los errores de datos conservan su estado; el resto (401/403 entre servicios, 5xx, sin respuesta)
 * es 502: no es un permiso del usuario y un 403 haría que el front mostrara "No tienes permiso".
 */
/** Para qué se pide el token: cada uso tiene su alcance y su mensaje cuando api-factura no lo concede. */
const RECHAZO_DEL_TOKEN = {
	dte: 'El servicio de facturación no autorizó a Sapira para emitir documentos tributarios: el cliente OAuth de api-sapira necesita los alcances factura:dte:read y factura:dte:write',
	provision:
		'El servicio de facturación no autorizó a Sapira para activar empresas: revisa FACTURA_OAUTH_CLIENT_ID y FACTURA_OAUTH_CLIENT_SECRET de api-sapira y que su cliente OAuth tenga el alcance factura:empresas:provision',
} as const;

/**
 * Error al pedir el token a api-factura (`/oauth/token`). El caso típico de un ambiente nuevo: el cliente OAuth de api-sapira no
 * existe, tiene otro secreto o le falta el alcance (`factura:empresas:provision` para activar empresas, los de DTE para emitir), y
 * api-factura responde 400/401. Sin esto el usuario veía un 500 «Ha ocurrido un error interno».
 */
export function facturaTokenError(error: unknown, uso: keyof typeof RECHAZO_DEL_TOKEN = 'dte'): HttpException {
	const status = axios.isAxiosError(error) ? error.response?.status : undefined;

	if (status === 400 || status === 401 || status === 403) return new BadGatewayException(RECHAZO_DEL_TOKEN[uso]);
	if (!axios.isAxiosError(error)) {
		return new BadGatewayException(`No se pudo autenticar con el servicio de facturación: ${(error as Error)?.message ?? 'error desconocido'}`);
	}

	return new BadGatewayException(`No se pudo autenticar con el servicio de facturación${status ? ` (${status})` : ''}`);
}

export function facturaHttpError(error: unknown): HttpException {
	if (!axios.isAxiosError(error)) return new BadGatewayException('No fue posible comunicarse con el servicio de facturación');

	const status = error.response?.status;
	const body = error.response?.data as { message?: unknown } | undefined;
	const detalle = Array.isArray(body?.message) ? body.message.join('. ') : typeof body?.message === 'string' ? body.message : undefined;

	if (status && ESTADOS_DEL_USUARIO.has(status)) return new HttpException(detalle || 'El servicio de facturación rechazó los datos', status);

	return new BadGatewayException(`El servicio de facturación rechazó la operación${status ? ` (${status})` : ''}${detalle ? `: ${detalle}` : ''}`);
}

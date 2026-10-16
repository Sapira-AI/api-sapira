import { BadGatewayException, HttpException, Injectable } from '@nestjs/common';
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

	async provisionEmpresa(empresa: ProvisionFacturaEmpresa) {
		const baseUrl = this.config.get<string>('FACTURA_API_URL');
		if (!baseUrl) throw new Error('FACTURA_API_URL no está configurada');
		const token = await this.oauth.getAccessToken();
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
		const baseUrl = this.config.get<string>('FACTURA_API_URL');
		if (!baseUrl) throw new Error('FACTURA_API_URL no está configurada');
		const token = await this.oauth.getAccessToken();
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
}

/** Errores del usuario que api-factura detecta en los datos (RUT, vínculo, validación): se devuelven con su estado. */
const ESTADOS_DEL_USUARIO = new Set([400, 409, 422]);

/**
 * Traduce un error de api-factura a uno de la API con su mensaje real (antes llegaba como 500 "Request failed with
 * status code 403"). Los errores de datos conservan su estado; el resto (401/403 entre servicios, 5xx, sin respuesta)
 * es 502: no es un permiso del usuario y un 403 haría que el front mostrara "No tienes permiso".
 */
export function facturaHttpError(error: unknown): HttpException {
	if (!axios.isAxiosError(error)) return new BadGatewayException('No fue posible comunicarse con el servicio de facturación');

	const status = error.response?.status;
	const body = error.response?.data as { message?: unknown } | undefined;
	const detalle = Array.isArray(body?.message) ? body.message.join('. ') : typeof body?.message === 'string' ? body.message : undefined;

	if (status && ESTADOS_DEL_USUARIO.has(status)) return new HttpException(detalle || 'El servicio de facturación rechazó los datos', status);

	return new BadGatewayException(`El servicio de facturación rechazó la operación${status ? ` (${status})` : ''}${detalle ? `: ${detalle}` : ''}`);
}

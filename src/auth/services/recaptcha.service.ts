import { BadRequestException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface VerifyRecaptchaOptions {
	remoteIp?: string;
	userAgent?: string;
	expectedAction?: string;
}

interface RecaptchaSettings {
	enabled: boolean;
	apiKey: string;
	projectId: string;
	siteKey: string;
}

interface RecaptchaEnterpriseAssessmentResponse {
	tokenProperties?: {
		valid?: boolean;
		invalidReason?: string;
		hostname?: string;
		action?: string;
		createTime?: string;
	};
	riskAnalysis?: {
		score?: number;
		reasons?: string[];
	};
	name?: string;
}

interface GoogleApiErrorResponse {
	error?: {
		code?: number;
		message?: string;
		status?: string;
	};
}

export interface PublicAuthConfig {
	recaptcha: {
		enabled: boolean;
		siteKey: string;
	};
}

@Injectable()
export class RecaptchaService {
	private readonly logger = new Logger(RecaptchaService.name);

	constructor(private readonly configService: ConfigService) {}

	getPublicAuthConfig(): PublicAuthConfig {
		const settings = this.getEffectiveSettings();

		return {
			recaptcha: {
				enabled: settings.enabled,
				siteKey: settings.enabled ? settings.siteKey : '',
			},
		};
	}

	async verifyToken(token?: string, context: VerifyRecaptchaOptions = {}) {
		const settings = this.getEffectiveSettings();
		if (!settings.enabled) {
			this.logger.warn('reCAPTCHA Enterprise está deshabilitado; se omitirá la validación');
			return {
				tokenProperties: {
					valid: true,
					action: context.expectedAction,
				},
				riskAnalysis: {
					score: 1,
					reasons: ['DISABLED_IN_SETTINGS'],
				},
			};
		}

		if (!token) {
			throw new BadRequestException('Captcha requerido');
		}

		return this.verifyEnterpriseToken(token, settings, context);
	}

	private getEffectiveSettings(): RecaptchaSettings {
		const apiKey = this.configService.get<string>('GOOGLE_RECAPTCHA_API_KEY') || '';
		const projectId = this.configService.get<string>('GOOGLE_RECAPTCHA_PROJECT_ID') || '';
		const siteKey = this.configService.get<string>('GOOGLE_RECAPTCHA_SITE_KEY') || '';
		const flagEnabled = this.configService.get<string>('RECAPTCHA_ENABLED', 'true') !== 'false';

		return {
			enabled: Boolean(flagEnabled && apiKey && projectId && siteKey),
			apiKey,
			projectId,
			siteKey,
		};
	}

	private async verifyEnterpriseToken(token: string, settings: RecaptchaSettings, options: VerifyRecaptchaOptions) {
		const { apiKey, projectId, siteKey } = settings;

		if (!apiKey || !projectId || !siteKey) {
			throw new InternalServerErrorException('Google reCAPTCHA Enterprise no está configurado correctamente');
		}

		const response = await fetch(`https://recaptchaenterprise.googleapis.com/v1/projects/${projectId}/assessments?key=${apiKey}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				event: {
					token,
					siteKey,
					userIpAddress: options.remoteIp,
					userAgent: options.userAgent,
				},
			}),
		});

		if (!response.ok) {
			const errorPayload = (await this.safeParseJson(response)) as GoogleApiErrorResponse | null;
			this.logger.error({
				message: 'Google reCAPTCHA Enterprise request failed',
				httpStatus: response.status,
				httpStatusText: response.statusText,
				googleErrorPayload: errorPayload,
				expectedAction: options.expectedAction,
				remoteIp: options.remoteIp,
			});
			const googleMessage = errorPayload?.error?.message || response.statusText || 'Error desconocido';
			const googleStatus = errorPayload?.error?.status ? ` (${errorPayload.error.status})` : '';
			throw new InternalServerErrorException(`No fue posible validar el captcha: ${googleMessage}${googleStatus}`);
		}

		const result = (await response.json()) as RecaptchaEnterpriseAssessmentResponse;
		if (!result.tokenProperties?.valid) {
			const reason = result.tokenProperties?.invalidReason ? ` (${result.tokenProperties.invalidReason})` : '';
			throw new BadRequestException(`La validación del captcha falló${reason}`);
		}

		this.validateHostnameAndAction(result.tokenProperties?.hostname, result.tokenProperties?.action, options.expectedAction);
		this.validateScore(result.riskAnalysis?.score);
		return result;
	}

	private validateHostnameAndAction(hostname?: string, actualAction?: string, expectedAction?: string) {
		if (hostname && !this.isAllowedHostname(hostname)) {
			throw new BadRequestException('La validación del captcha falló');
		}

		if (expectedAction && actualAction && actualAction !== expectedAction) {
			throw new BadRequestException('La acción del captcha no coincide con la operación esperada');
		}
	}

	private validateScore(score?: number) {
		if (score === undefined) {
			return;
		}

		const threshold = Number(this.configService.get<string>('RECAPTCHA_MIN_SCORE', '0.5'));
		if (score < threshold) {
			throw new BadRequestException('La validación del captcha no alcanzó el puntaje mínimo requerido');
		}
	}

	private isAllowedHostname(hostname: string): boolean {
		const fromFrontBaseUrl = (this.configService.get<string>('FRONT_BASE_URL') || '')
			.split(',')
			.map((value) => value.trim())
			.filter(Boolean);

		const allowedHosts = ['localhost', '127.0.0.1', 'www.aisapira.com', 'app.aisapira.com', 'aisapira.com', ...fromFrontBaseUrl]
			.map(
				(value) =>
					value
						.replace(/^https?:\/\//, '')
						.split('/')[0]
						.split(':')[0]
			)
			.filter(Boolean);

		return allowedHosts.some((allowedHost) => hostname === allowedHost || hostname.endsWith(`.${allowedHost}`));
	}

	private async safeParseJson(response: Response) {
		try {
			return await response.json();
		} catch {
			return null;
		}
	}
}

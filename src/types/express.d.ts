import { DeviceInfoDto } from '@/core/dto/device-info.dto';

declare global {
	namespace Express {
		interface Request {
			userData?: {
				extension_oid?: string;
				emails?: string[];
				email?: string;
				given_name?: string;
				roles?: string[];
			};
			// Información del dispositivo agregada por el DeviceInfoInterceptor
			deviceInfo?: DeviceInfoDto;
			// ID de usuario extraído del token
			userId?: string;
		}
	}
}

// Esto es necesario para que TypeScript trate este archivo como un módulo
export {};

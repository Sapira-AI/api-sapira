// Declaración de tipos personalizada para uuid para evitar conflictos
declare module 'uuid' {
	export function v4(): string;
	export function v1(): string;
	export function v3(name: string, namespace: string): string;
	export function v5(name: string, namespace: string): string;
}

// Declaración temporal para Multer
declare global {
	namespace Express {
		namespace Multer {
			interface File {
				fieldname: string;
				originalname: string;
				encoding: string;
				mimetype: string;
				size: number;
				destination: string;
				filename: string;
				path: string;
				buffer: Buffer;
			}
		}
	}
}

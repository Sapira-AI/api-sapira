import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Model, Types } from 'mongoose';

import { DeviceInfoDto } from '@/core/dto/device-info.dto';

import { Device, DeviceDocument } from './schemas/device.schema';

@Injectable()
export class DevicesService {
	constructor(
		@Inject('DeviceModelToken')
		private readonly deviceModel: Model<DeviceDocument>
	) {}

	/**
	 * Registra o actualiza un acceso de dispositivo
	 * @param deviceInfo Información del dispositivo
	 * @param userId ID del usuario (opcional)
	 * @param endpoint Endpoint al que se accedió
	 * @returns El dispositivo actualizado
	 */
	async registerDeviceAccess(deviceInfo: DeviceInfoDto, userId: string | null, endpoint: string): Promise<Device> {
		try {
			// Buscar si el dispositivo ya existe
			const device = await this.deviceModel.findOne({ deviceId: deviceInfo.deviceId });

			// Si el dispositivo existe, actualizar información
			if (device) {
				// Verificar si el dispositivo está bloqueado
				if (device.isBlocked) {
					throw new HttpException(
						`Este dispositivo ha sido bloqueado. Motivo: ${device.blockReason || 'No especificado'}`,
						HttpStatus.FORBIDDEN
					);
				}

				// Actualizar información del dispositivo
				device.deviceInfo = deviceInfo;
				device.lastAccessAt = new Date();
				device.accessCount += 1;

				// Limitar el historial a los últimos 100 accesos
				const accessRecord = `${new Date().toISOString()} - ${endpoint}`;
				if (device.accessHistory.length >= 100) {
					device.accessHistory.shift(); // Eliminar el registro más antiguo
				}
				device.accessHistory.push(accessRecord);

				// Si hay un userId y el dispositivo no tenía uno, actualizarlo
				if (userId && !device.userId) {
					device.userId = new Types.ObjectId(userId);
				}

				return await device.save();
			}

			// Si el dispositivo no existe, crearlo
			else {
				const newDevice = new this.deviceModel({
					deviceId: deviceInfo.deviceId,
					deviceInfo,
					userId: userId ? new Types.ObjectId(userId) : null,
					lastAccessAt: new Date(),
					accessCount: 1,
					accessHistory: [`${new Date().toISOString()} - ${endpoint}`],
				});

				return await newDevice.save();
			}
		} catch (error) {
			// Si el error ya es un HttpException, relanzarlo
			if (error instanceof HttpException) {
				throw error;
			}

			console.error('Error al registrar acceso de dispositivo:', error);
			throw new HttpException('Error al registrar acceso de dispositivo', HttpStatus.INTERNAL_SERVER_ERROR);
		}
	}

	/**
	 * Verifica si un dispositivo está bloqueado
	 * @param deviceId ID del dispositivo
	 * @returns true si el dispositivo está bloqueado, false si no
	 */
	async isDeviceBlocked(deviceId: string): Promise<boolean> {
		try {
			const device = await this.deviceModel.findOne({ deviceId });
			return device?.isBlocked || false;
		} catch (error) {
			console.error('Error al verificar bloqueo de dispositivo:', error);
			return false; // En caso de error, asumimos que no está bloqueado
		}
	}

	/**
	 * Bloquea un dispositivo
	 * @param deviceId ID del dispositivo
	 * @param reason Motivo del bloqueo
	 * @returns El dispositivo bloqueado
	 */
	async blockDevice(deviceId: string): Promise<Device> {
		const device = await this.deviceModel.findOne({ deviceId });

		if (!device) {
			throw new HttpException('Dispositivo no encontrado', HttpStatus.NOT_FOUND);
		}

		device.isBlocked = true;

		return await device.save();
	}

	/**
	 * Desbloquea un dispositivo
	 * @param deviceId ID del dispositivo
	 * @returns El dispositivo desbloqueado
	 */
	async unblockDevice(deviceId: string): Promise<Device> {
		const device = await this.deviceModel.findOne({ deviceId });

		if (!device) {
			throw new HttpException('Dispositivo no encontrado', HttpStatus.NOT_FOUND);
		}

		device.isBlocked = false;
		device.blockReason = undefined;

		return await device.save();
	}

	/**
	 * Obtiene todos los dispositivos registrados
	 * @returns Lista de dispositivos con información de usuario
	 */
	async getAllDevices(): Promise<Device[]> {
		return this.deviceModel
			.find()
			.sort({ lastAccessAt: -1 })
			.populate({
				path: 'userId',
				select: 'name fatherName motherName email code',
			})
			.exec();
	}

	/**
	 * Obtiene los dispositivos bloqueados
	 * @returns Lista de dispositivos bloqueados con información de usuario
	 */
	async getBlockedDevices(): Promise<Device[]> {
		return this.deviceModel
			.find({ isBlocked: true })
			.sort({ lastAccessAt: -1 })
			.populate({
				path: 'userId',
				select: 'name fatherName motherName email code',
			})
			.exec();
	}

	/**
	 * Obtiene los dispositivos de un usuario
	 * @param userId ID del usuario
	 * @returns Lista de dispositivos del usuario con información de usuario
	 */
	async getUserDevices(userId: string): Promise<Device[]> {
		return this.deviceModel
			.find({ userId: new Types.ObjectId(userId) })
			.sort({ lastAccessAt: -1 })
			.populate({
				path: 'userId',
				select: 'name fatherName motherName email code',
			})
			.exec();
	}
}

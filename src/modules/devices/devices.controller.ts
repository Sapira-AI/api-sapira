import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { DevicesService } from './devices.service';
import { Device } from './schemas/device.schema';

@ApiTags('Devices')
@Controller('devices')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class DevicesController {
	constructor(private readonly devicesService: DevicesService) {}

	@Get()
	@ApiOperation({ summary: 'Obtener todos los dispositivos registrados' })
	@ApiResponse({ status: 200, description: 'Lista de dispositivos obtenida exitosamente' })
	async getAllDevices(): Promise<Device[]> {
		return this.devicesService.getAllDevices();
	}

	@Get('blocked')
	@ApiOperation({ summary: 'Obtener dispositivos bloqueados' })
	@ApiResponse({ status: 200, description: 'Lista de dispositivos bloqueados obtenida exitosamente' })
	async getBlockedDevices(): Promise<Device[]> {
		return this.devicesService.getBlockedDevices();
	}

	@Get('user/:userId')
	@ApiOperation({ summary: 'Obtener dispositivos de un usuario' })
	@ApiResponse({ status: 200, description: 'Lista de dispositivos del usuario obtenida exitosamente' })
	async getUserDevices(@Param('userId') userId: string): Promise<Device[]> {
		return this.devicesService.getUserDevices(userId);
	}

	@Post('block/:deviceId')
	@ApiOperation({ summary: 'Bloquear un dispositivo' })
	@ApiResponse({ status: 200, description: 'Dispositivo bloqueado exitosamente' })
	async blockDevice(@Param('deviceId') deviceId: string): Promise<Device> {
		return this.devicesService.blockDevice(deviceId);
	}

	@Post('unblock/:deviceId')
	@ApiOperation({ summary: 'Desbloquear un dispositivo' })
	@ApiResponse({ status: 200, description: 'Dispositivo desbloqueado exitosamente' })
	async unblockDevice(@Param('deviceId') deviceId: string): Promise<Device> {
		return this.devicesService.unblockDevice(deviceId);
	}
}

import {
	Body,
	Controller,
	Delete,
	ForbiddenException,
	Get,
	HttpCode,
	Param,
	ParseUUIDPipe,
	Patch,
	Post,
	Put,
	Request,
	UseGuards,
	UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { PERMISSION_CODES } from '@/guards/permission-codes';
import type { PermissionContext } from '@/guards/permissions.service';
import { RequirePermission, RequirePermissionGuard } from '@/guards/require-permission.guard';

import { ChangeUserRoleDto, CreateRoleDto, DuplicateRoleDto, PutRoleAlertsDto, UpdateRoleDto } from './dtos/roles.dto';
import { SettingsDbErrorsInterceptor } from './settings-db-errors';
import { SettingsRolesService } from './settings-roles.service';
import { SettingsUsersService } from './settings-users.service';

import type { SettingsRequest } from './settings-common';

const actorOf = (req: SettingsRequest): PermissionContext => {
	if (!req.permissionContext) throw new ForbiddenException('No se pudo identificar al usuario');

	return req.permissionContext;
};

/** Usuarios y permisos (contrato §4–§5). Leer = VIEW_CONFIGURACION; escribir = EDIT_CONFIGURACION. */
@ApiTags('Settings · Usuarios y roles')
@Controller('settings')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard, RequirePermissionGuard)
@UseInterceptors(SettingsDbErrorsInterceptor)
@RequirePermission(PERMISSION_CODES.viewSettings)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true })
export class SettingsAccessController {
	constructor(
		private readonly users: SettingsUsersService,
		private readonly roles: SettingsRolesService
	) {}

	@Get('users')
	@ApiOperation({ summary: 'Miembros del holding (sin super admins, salvo que consulte uno)' })
	listUsers(@HoldingId() holdingId: string, @Request() req: SettingsRequest) {
		return this.users.list(holdingId, actorOf(req));
	}

	@Patch('users/:id/role')
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({ summary: 'Cambiar el rol de un usuario (rol del mismo holding)' })
	changeRole(
		@HoldingId() holdingId: string,
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: ChangeUserRoleDto,
		@Request() req: SettingsRequest
	) {
		return this.users.changeRole(holdingId, id, body.role_id, actorOf(req));
	}

	@Get('permissions')
	@ApiOperation({ summary: 'Catálogo de permisos agrupado por módulo (internos solo para super admin)' })
	permissions(@Request() req: SettingsRequest) {
		return this.roles.permissionsCatalog(actorOf(req));
	}

	@Get('roles')
	listRoles(@HoldingId() holdingId: string) {
		return this.roles.list(holdingId);
	}

	@Get('roles/:id')
	getRole(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string) {
		return this.roles.get(holdingId, id);
	}

	@Post('roles')
	@RequirePermission(PERMISSION_CODES.editSettings)
	createRole(@HoldingId() holdingId: string, @Body() body: CreateRoleDto, @Request() req: SettingsRequest) {
		return this.roles.create(holdingId, body, actorOf(req));
	}

	@Patch('roles/:id')
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({ summary: 'Editar un rol propio (los por defecto no se editan)' })
	updateRole(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateRoleDto, @Request() req: SettingsRequest) {
		return this.roles.update(holdingId, id, body, actorOf(req));
	}

	@Delete('roles/:id')
	@HttpCode(204)
	@RequirePermission(PERMISSION_CODES.editSettings)
	async deleteRole(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
		await this.roles.remove(holdingId, id);
	}

	@Post('roles/:id/duplicate')
	@RequirePermission(PERMISSION_CODES.editSettings)
	duplicateRole(
		@HoldingId() holdingId: string,
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: DuplicateRoleDto,
		@Request() req: SettingsRequest
	) {
		return this.roles.duplicate(holdingId, id, body, actorOf(req));
	}

	@Get('roles/:id/alerts')
	@ApiOperation({ summary: 'Alertas que recibe el rol' })
	getAlerts(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string) {
		return this.roles.getAlerts(holdingId, id);
	}

	@Put('roles/:id/alerts')
	@RequirePermission(PERMISSION_CODES.editSettings)
	putAlerts(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: PutRoleAlertsDto) {
		return this.roles.putAlerts(holdingId, id, body.types);
	}
}

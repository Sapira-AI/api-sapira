import { Controller, Get, HttpStatus, Param, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { GetUserByAuthIdQueryDto, GetUserByEmailQueryDto, UserResponseDto } from './dtos/users.dto';
import { UsersService } from './users.service';

@ApiTags('Users')
@Controller('users')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class UsersController {
	constructor(private readonly usersService: UsersService) {}

	@Get('me')
	@ApiOperation({
		summary: 'Obtener información del usuario autenticado',
		description: 'Retorna la información completa del usuario autenticado usando su auth_id del token',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Usuario encontrado',
		type: UserResponseDto,
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Usuario no encontrado',
	})
	async getMe(@Request() req): Promise<UserResponseDto> {
		const authId = req.user?.id;
		return await this.usersService.getUserByAuthId(authId);
	}

	@Get('by-auth-id')
	@ApiOperation({
		summary: 'Obtener usuario por auth_id',
		description: 'Retorna la información del usuario basándose en su auth_id (UUID de auth.users)',
	})
	@ApiQuery({
		name: 'auth_id',
		type: String,
		description: 'UUID de autenticación del usuario',
		example: '4f5e117a-f6b2-499b-a6bb-9fd6eb26fb49',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Usuario encontrado',
		type: UserResponseDto,
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Usuario no encontrado',
	})
	async getUserByAuthId(@Query() query: GetUserByAuthIdQueryDto): Promise<UserResponseDto> {
		return await this.usersService.getUserByAuthId(query.auth_id);
	}

	@Get('by-email')
	@ApiOperation({
		summary: 'Obtener usuario por email',
		description: 'Retorna la información del usuario basándose en su email',
	})
	@ApiQuery({
		name: 'email',
		type: String,
		description: 'Email del usuario',
		example: 'leon.montero@blixter.cl',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Usuario encontrado',
		type: UserResponseDto,
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Usuario no encontrado',
	})
	async getUserByEmail(@Query() query: GetUserByEmailQueryDto): Promise<UserResponseDto> {
		return await this.usersService.getUserByEmail(query.email);
	}

	@Get()
	@ApiOperation({
		summary: 'Listar todos los usuarios',
		description: 'Retorna la lista completa de usuarios del sistema',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Lista de usuarios',
		type: [UserResponseDto],
	})
	async findAll(): Promise<UserResponseDto[]> {
		return await this.usersService.findAll();
	}

	@Get(':userId')
	@ApiOperation({
		summary: 'Obtener usuario por ID',
		description: 'Retorna la información completa de un usuario por su ID',
	})
	@ApiParam({
		name: 'userId',
		type: String,
		description: 'UUID del usuario',
		example: '1dedf14a-ba51-4b93-9c74-7f869e17d4dc',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Usuario encontrado',
		type: UserResponseDto,
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Usuario no encontrado',
	})
	async getUserById(@Param('userId') userId: string): Promise<UserResponseDto> {
		return await this.usersService.getUserById(userId);
	}
}

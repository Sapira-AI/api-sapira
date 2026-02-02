import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UserResponseDto } from './dtos/users.dto';
import { User } from './entities/user.entity';

@Injectable()
export class UsersService {
	constructor(
		@InjectRepository(User)
		private readonly userRepository: Repository<User>
	) {}

	async getUserByAuthId(authId: string): Promise<UserResponseDto> {
		const user = await this.userRepository.findOne({
			where: { auth_id: authId },
		});

		if (!user) {
			throw new NotFoundException(`Usuario con auth_id ${authId} no encontrado`);
		}

		return this.mapToResponseDto(user);
	}

	async getUserById(userId: string): Promise<UserResponseDto> {
		const user = await this.userRepository.findOne({
			where: { id: userId },
		});

		if (!user) {
			throw new NotFoundException(`Usuario con id ${userId} no encontrado`);
		}

		return this.mapToResponseDto(user);
	}

	async getUserByEmail(email: string): Promise<UserResponseDto> {
		const user = await this.userRepository.findOne({
			where: { email },
		});

		if (!user) {
			throw new NotFoundException(`Usuario con email ${email} no encontrado`);
		}

		return this.mapToResponseDto(user);
	}

	async findAll(): Promise<UserResponseDto[]> {
		const users = await this.userRepository.find({
			order: { created_at: 'DESC' },
		});

		return users.map((user) => this.mapToResponseDto(user));
	}

	private mapToResponseDto(user: User): UserResponseDto {
		return {
			id: user.id,
			name: user.name,
			email: user.email,
			role_id: user.role_id,
			status: user.status,
			last_access: user.last_access,
			auth_provider: user.auth_provider,
			auth_id: user.auth_id,
			created_at: user.created_at,
			is_super_admin: user.is_super_admin,
		};
	}
}

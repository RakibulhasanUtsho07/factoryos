import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { DatabaseModule } from '../database/database.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { resolveAuthMode, resolveNodeEnvironment } from '../config/runtime-config';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    ConfigModule,

    DatabaseModule,

    PassportModule,

    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],

      useFactory: (configService: ConfigService) => {
        const nodeEnv = resolveNodeEnvironment(configService.get<string>('NODE_ENV'));
        const authMode = resolveAuthMode(
          nodeEnv,
          configService.get<string>('AUTH_MODE'),
          configService.get<string>('DEV_AUTH_ENABLED'),
        );
        const secret = configService.get<string>('JWT_SECRET');

        if (authMode === 'dev' && !secret) {
          throw new Error('JWT_SECRET is required when AUTH_MODE=dev.');
        }

        const signOptions = {
          expiresIn: '15m' as const,
          issuer:
            configService.get<string>('JWT_ISSUER') ||
            'factoryos-api',
          audience:
            configService.get<string>('JWT_AUDIENCE') ||
            'factoryos-web',
        };

        return {
          ...(secret ? { secret } : {}),
          signOptions,
        };
      },
    }),
  ],

  controllers: [
    AuthController,
  ],

  providers: [
    AuthService,
    JwtStrategy,

    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],

  exports: [
    AuthService,
  ],
})
export class AuthModule {}
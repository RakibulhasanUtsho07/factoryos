import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { DatabaseModule } from '../database/database.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
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
        const authMode = configService.get<string>('AUTH_MODE') || 'dev';
        const signOptions = {
          expiresIn: '15m',
          issuer:
            configService.get<string>('JWT_ISSUER') ||
            'factoryos-api',
          audience:
            configService.get<string>('JWT_AUDIENCE') ||
            'factoryos-web',
        };

        // OIDC validates external RS256 tokens. A local HS256 signing secret is
        // neither needed nor desirable in that mode; dev-token issuance remains
        // blocked by AuthService outside NODE_ENV=development.
        if (authMode === 'oidc') {
          return { signOptions };
        }

        const secret = configService.get<string>('JWT_SECRET');
        if (!secret) {
          throw new Error('JWT_SECRET is required when AUTH_MODE=dev');
        }

        return { secret, signOptions };
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
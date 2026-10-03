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
        const secret = configService.get<string>('JWT_SECRET');

        if (!secret) {
          throw new Error(
            'JWT_SECRET is required in services/api/.env',
          );
        }

        return {
          secret,

          signOptions: {
            expiresIn: '15m',
            issuer:
              configService.get<string>('JWT_ISSUER') ||
              'factoryos-api',

            audience:
              configService.get<string>('JWT_AUDIENCE') ||
              'factoryos-web',
          },
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
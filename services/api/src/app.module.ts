import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';

import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller';
import { AppService } from './app.service';

import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { IamModule } from './iam/iam.module';
import { OrdersModule } from './orders/orders.module';

import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { TenantContextMiddleware } from './common/middleware/tenant-context.middleware';
import { TraceIdMiddleware } from './common/middleware/trace-id.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    // ----------------------------------------------------------
    // Infrastructure
    // ----------------------------------------------------------

    DatabaseModule,

    // ----------------------------------------------------------
    // Authentication
    // ----------------------------------------------------------

    AuthModule,

    // ----------------------------------------------------------
    // Audit
    // ----------------------------------------------------------

    AuditModule,

    // ----------------------------------------------------------
    // Core modules
    // ----------------------------------------------------------

    HealthModule,
    IamModule,
    OrdersModule,
  ],

  controllers: [
    AppController,
  ],

  providers: [
    AppService,
  ],
})
export class AppModule
  implements NestModule
{
  configure(
    consumer: MiddlewareConsumer,
  ) {
    consumer
      .apply(
        RequestIdMiddleware,
        TraceIdMiddleware,
        TenantContextMiddleware,
      )
      .forRoutes({
        path: '*path',
        method: RequestMethod.ALL,
      });
  }
}
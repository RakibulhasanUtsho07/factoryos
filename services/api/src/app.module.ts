import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { IamModule } from './iam/iam.module';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { TenantContextMiddleware } from './common/middleware/tenant-context.middleware';
import { TraceIdMiddleware } from './common/middleware/trace-id.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    DatabaseModule,
    HealthModule,
    IamModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
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
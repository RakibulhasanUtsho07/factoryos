import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';

import { EntitlementsModule } from './entitlements/entitlements.module';
import { SaasModule } from './saas/saas.module';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller';
import { AppService } from './app.service';

import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { IamModule } from './iam/iam.module';
import { OrdersModule } from './orders/orders.module';
import { ProcurementModule } from './procurement/procurement.module';
import { InventoryModule } from './inventory/inventory.module';
import { ProductDefinitionsModule } from './products/products.module';
import { MrpLiteModule } from './mrp-lite/mrp-lite.module';
import { ProductionWorkOrdersModule } from './production/production-work-orders.module';
import { ResearchModule } from './research/research.module';
import { GrowthModule } from './growth/growth.module';
import { OutboxModule } from './outbox/outbox.module';
import { QualityModule } from './quality/quality.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { WorkforceModule } from './workforce/workforce.module';

import { PolicyModule } from './policy/policy.module';
import { CbbModule } from './cbb/cbb.module';
import { AiModule } from './ai/ai.module';

import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { TenantContextMiddleware } from './common/middleware/tenant-context.middleware';
import { TraceIdMiddleware } from './common/middleware/trace-id.middleware';

@Module({
  imports: [
    // ----------------------------------------------------------
    // Configuration
    // ----------------------------------------------------------

    ConfigModule.forRoot({
      isGlobal: true,
    }),

    // ----------------------------------------------------------
    // Database
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

    ProcurementModule,

    InventoryModule,

    ProductDefinitionsModule,

    MrpLiteModule,

    ProductionWorkOrdersModule,

    QualityModule,

    MaintenanceModule,

    WorkforceModule,

    ResearchModule,

    GrowthModule,

    EntitlementsModule,

    SaasModule,

    PolicyModule,

    CbbModule,

    AiModule,

    // ----------------------------------------------------------
    // Transactional Outbox
    // ----------------------------------------------------------

    OutboxModule,
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

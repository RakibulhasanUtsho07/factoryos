import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';

import { ResearchSourceRegistryController } from './research-source.registry.controller';
import { ResearchSourceRegistryService } from './research-source.registry.service';

@Module({
  imports: [AuditModule, DatabaseModule, IamModule],
  controllers: [ResearchSourceRegistryController],
  providers: [ResearchSourceRegistryService],
  exports: [ResearchSourceRegistryService],
})
export class ResearchModule {}

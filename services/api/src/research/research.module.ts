import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { ResearchController } from './research.controller';
import { ResearchService } from './research.service';
import { ResearchIngestionService } from './research-ingestion.service';
import { ResearchSourceAdapterService } from './research-source-adapters';
import { ResearchSourceProductionService } from './research-source-production.service';

@Module({
  imports: [DatabaseModule, AuditModule, IamModule],
  controllers: [ResearchController],
  providers: [ResearchService, ResearchIngestionService, ResearchSourceAdapterService, ResearchSourceProductionService],
  exports: [ResearchService, ResearchIngestionService],
})
export class ResearchModule {}

import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';

import { ResearchSourceRegistryController } from './research-source.registry.controller';
import { ResearchSourceRegistryService } from './research-source.registry.service';
import { ResearchDocumentExtractionService } from './research-document-extraction.service';
import { ResearchClaimEvidenceController } from './research-claim-evidence.controller';
import { ResearchClaimEvidenceService } from './research-claim-evidence.service';
import { ResearchRetrievalController } from './research-retrieval.controller';
import { ResearchRetrievalService } from './research-retrieval.service';

@Module({
  imports: [AuditModule, DatabaseModule, IamModule],
  controllers: [ResearchSourceRegistryController, ResearchClaimEvidenceController, ResearchRetrievalController],
  providers: [ResearchSourceRegistryService, ResearchDocumentExtractionService, ResearchClaimEvidenceService, ResearchRetrievalService],
  exports: [ResearchSourceRegistryService, ResearchClaimEvidenceService, ResearchRetrievalService],
})
export class ResearchModule {}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { ScimUsersController } from './scim.controller';
import { ScimService } from './scim.service';

@Module({
  imports: [ConfigModule, DatabaseModule, AuditModule],
  controllers: [ScimUsersController],
  providers: [ScimService],
})
export class ScimModule {}

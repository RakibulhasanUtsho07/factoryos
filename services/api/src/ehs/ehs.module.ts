import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { EhsController } from './ehs.controller';
import { EhsService } from './ehs.service';

@Module({
  imports:[DatabaseModule,IamModule],
  controllers:[EhsController],
  providers:[EhsService],
  exports:[EhsService],
})
export class EhsModule {}

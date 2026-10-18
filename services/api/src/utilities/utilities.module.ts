import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { IamModule } from '../iam/iam.module';
import { UtilitiesController } from './utilities.controller';
import { UtilitiesService } from './utilities.service';

@Module({
  imports:[DatabaseModule,IamModule],
  controllers:[UtilitiesController],
  providers:[UtilitiesService],
  exports:[UtilitiesService],
})
export class UtilitiesModule {}

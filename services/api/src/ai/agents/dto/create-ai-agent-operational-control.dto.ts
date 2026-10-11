import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import type {
  AiAgentOperationalControlStatus,
} from '../ai.agent.catalogue.types';

export class CreateAiAgentOperationalControlDto {
  @IsIn(['ENABLED', 'PAUSED', 'RESTRICTED'])
  status!: AiAgentOperationalControlStatus;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  execution_scopes?: string[];

  @IsString()
  @MaxLength(2000)
  reason!: string;
}

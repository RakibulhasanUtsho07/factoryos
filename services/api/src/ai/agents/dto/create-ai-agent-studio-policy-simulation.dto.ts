import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { Type } from 'class-transformer';

export class AiAgentStudioHistoricalEventDto {
  @IsString()
  @MaxLength(200)
  event_key!: string;

  @IsString()
  @MaxLength(200)
  action!: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  resource_type?: string | null;

  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;

  @IsISO8601()
  effective_at!: string;

  @IsOptional()
  @IsIn([
    'ALLOWED',
    'APPROVAL_REQUIRED',
    'DENIED',
  ])
  expected_outcome?:
    | 'ALLOWED'
    | 'APPROVAL_REQUIRED'
    | 'DENIED';
}

export class CreateAiAgentStudioPolicySimulationDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AiAgentStudioHistoricalEventDto)
  historical_events!: AiAgentStudioHistoricalEventDto[];
}

import type {
  AiToolRiskClass,
} from '../../tools/ai.tool.types';

import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateAiAgentDefinitionDto {
  @IsString()
  @MaxLength(200)
  agent_id!: string;

  @IsString()
  @MaxLength(100)
  version!: string;

  @IsString()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsString()
  @MaxLength(500)
  capability!: string;

  @IsString()
  @MaxLength(500)
  typical_output!: string;

  @IsString()
  @MaxLength(500)
  authority!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  risk_ceiling?: AiToolRiskClass;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  execution_scopes?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  max_steps?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  max_retries?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  max_tool_calls?: number;

  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(3_600_000)
  timeout_ms?: number;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

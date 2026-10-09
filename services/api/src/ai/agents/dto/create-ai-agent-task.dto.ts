import {
  IsArray,
  IsISO8601,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  ArrayMinSize,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateAiAgentTaskLimitsDto {
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
}

export class CreateAiAgentStepDto {
  @IsString()
  @MaxLength(200)
  step_key!: string;

  @IsString()
  @MaxLength(200)
  capability!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  agent_id?: string | null;

  @IsOptional()
  @IsObject()
  input_schema?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  output_schema?: Record<string, unknown>;

  @IsString()
  @MaxLength(200)
  tool_id!: string;

  @IsString()
  @MaxLength(100)
  tool_version!: string;

  @IsString()
  @MaxLength(200)
  action_type!: string;

  @IsOptional()
  @IsObject()
  target?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  resource_type?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  resource_id?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  risk_class?: string | null;

  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(60_000)
  timeout_ms?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  retry_limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  authority_level?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  depends_on?: string[];
}

export class CreateAiAgentTaskDto {
  @IsString()
  @MaxLength(100)
  decision_id!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  parent_trace_id?: string | null;

  @IsString()
  @MaxLength(1000)
  goal!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateAiAgentTaskLimitsDto)
  limits?: CreateAiAgentTaskLimitsDto;

  @IsOptional()
  @IsISO8601()
  deadline_at?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  context_version?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  plan_version?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  context_hash?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  idempotency_key?: string | null;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateAiAgentStepDto)
  steps!: CreateAiAgentStepDto[];
}

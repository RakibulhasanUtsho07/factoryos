import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import {
  Type,
} from 'class-transformer';

export class AiAgentStudioToolSpecDto {
  @IsString()
  @MaxLength(200)
  tool_id!: string;

  @IsString()
  @MaxLength(100)
  version!: string;

  @IsString()
  @MaxLength(200)
  action_type!: string;
}

export class AiAgentStudioPlanStepDto {
  @IsString()
  @MaxLength(200)
  step_key!: string;

  @IsString()
  @MaxLength(200)
  tool_id!: string;

  @IsString()
  @MaxLength(100)
  tool_version!: string;

  @IsString()
  @MaxLength(200)
  action_type!: string;

  @IsObject()
  input!: Record<string, unknown>;
}

export class AiAgentStudioSpecDto {
  @IsString()
  @MaxLength(200)
  agent_id!: string;

  @IsString()
  @MaxLength(100)
  version!: string;

  @IsString()
  @MaxLength(2000)
  goal!: string;

  @IsString()
  @MaxLength(20)
  risk_ceiling!: string;

  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  execution_scopes!: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AiAgentStudioToolSpecDto)
  tools!: AiAgentStudioToolSpecDto[];

  @IsOptional()
  @IsObject()
  memory?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  policies?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  prompts?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  completion_criteria?: Record<string, unknown>;
}

export class CreateAiAgentStudioSandboxDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsISO8601()
  trace_id?: string;

  @ValidateNested()
  @Type(() => AiAgentStudioSpecDto)
  agent_spec!: AiAgentStudioSpecDto;

  @IsOptional()
  @IsObject()
  input_snapshot?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  policy_snapshot?: Record<string, unknown>;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AiAgentStudioPlanStepDto)
  plan!: AiAgentStudioPlanStepDto[];

  @IsObject()
  simulated_tool_responses!: Record<string, unknown>;
}

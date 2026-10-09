import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsUUID,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { Type } from 'class-transformer';

export class AiAgentStudioRunPlanStepDto {
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

export class ReplayAiAgentStudioRunDto {
  @IsUUID()
  source_run_id!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(99)
  from_step_index?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(99)
  to_step_index?: number;
}

export class BranchAiAgentStudioRunDto {
  @IsUUID()
  source_run_id!: string;

  @IsInt()
  @Min(0)
  @Max(99)
  branch_from_step_index!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AiAgentStudioRunPlanStepDto)
  plan!: AiAgentStudioRunPlanStepDto[];

  @IsObject()
  simulated_tool_responses!: Record<string, unknown>;
}

export class CompareAiAgentStudioRunsDto {
  @IsUUID()
  left_run_id!: string;

  @IsUUID()
  right_run_id!: string;
}

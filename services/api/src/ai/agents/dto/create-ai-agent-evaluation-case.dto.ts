import {
  IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min,
} from 'class-validator';

export class CreateAiAgentEvaluationCaseDto {
  @IsString()
  @MaxLength(160)
  case_key!: string;

  @IsInt()
  @Min(1)
  @Max(1_000_000)
  version!: number;

  @IsString()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsIn(['EXPECTED_TOOL_CALL', 'EXPECTED_REFUSAL', 'RED_TEAM_POLICY_BYPASS', 'EXPECTED_COMPENSATION', 'PRIVACY_NO_SECRET_LEAKAGE'])
  kind!: 'EXPECTED_TOOL_CALL' | 'EXPECTED_REFUSAL' | 'RED_TEAM_POLICY_BYPASS' | 'EXPECTED_COMPENSATION' | 'PRIVACY_NO_SECRET_LEAKAGE';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  expected_tool_id?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  expected_tool_version?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  expected_action_type?: string | null;

  @IsOptional()
  @IsObject()
  expected_input_subset?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  expected_refusal_reason_contains?: string | null;

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';
}

import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateAiAgentPublishRequestDto {
  @IsUUID()
  agent_definition_id!: string;

  @IsUUID()
  sandbox_id!: string;

  @IsUUID()
  simulation_run_id!: string;

  @IsOptional()
  @IsUUID()
  policy_simulation_run_id?: string;

  @IsIn(['CANARY', 'PRODUCTION'])
  target_stage!: 'CANARY' | 'PRODUCTION';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string | null;
}

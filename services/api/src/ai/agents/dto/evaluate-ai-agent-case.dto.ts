import { IsUUID } from 'class-validator';

export class EvaluateAiAgentCaseDto {
  @IsUUID()
  simulation_run_id!: string;
}

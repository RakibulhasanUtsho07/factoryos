import { IsUUID } from 'class-validator';

export class EvaluateAiAgentLiveCaseDto {
  @IsUUID()
  task_id!: string;
}

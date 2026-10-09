import {
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class ResolveAiContextDto {
  @IsUUID()
  decision_id!: string;

  @IsOptional()
  @IsArray()
  @IsString({
    each: true,
  })
  requested_evidence_states?: string[];
}

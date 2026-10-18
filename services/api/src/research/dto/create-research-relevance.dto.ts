import { IsArray, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateResearchRelevanceDto {
  @IsUUID()
  business_entity_id!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  relevance_rationale!: string;

  @IsOptional()
  @IsArray()
  client_evidence?: unknown[];

  @IsOptional()
  @IsArray()
  counter_evidence?: unknown[];

  @IsOptional()
  @IsArray()
  applicability_assumptions?: unknown[];

  @IsOptional()
  @IsObject()
  validation_plan?: Record<string, unknown>;
}

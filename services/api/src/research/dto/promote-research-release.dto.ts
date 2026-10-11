import { IsDateString, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class PromoteResearchReleaseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  safety_review_summary!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  regression_evidence_ref!: string;

  @IsDateString()
  effective_at!: string;
}

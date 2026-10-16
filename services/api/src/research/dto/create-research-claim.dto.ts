import {
  IsArray, IsIn, IsNotEmpty, IsObject, IsOptional,
  IsString, MaxLength,
} from 'class-validator';

export class CreateResearchClaimDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(8000)
  claim_text!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  methodology?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  dataset_description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  limitations?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  practical_implication?: string;

  @IsOptional()
  @IsIn(['A', 'B', 'C', 'D', 'UNASSESSED'])
  evidence_grade?: 'A' | 'B' | 'C' | 'D' | 'UNASSESSED';

  @IsOptional()
  @IsIn(['STRONG', 'MODERATE', 'LIMITED', 'CONFLICTING', 'UNASSESSED'])
  evidence_strength?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  topic_tags?: string[];

  @IsObject()
  provenance_ref!: {
    page?: number;
    section?: string;
    paragraph?: string;
    url_fragment?: string;
    source_identifier?: string;
  };

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  stored_excerpt?: string;
}

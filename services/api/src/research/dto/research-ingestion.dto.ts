import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsObject,
  IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';

export const RESEARCH_INGESTION_MODES = ['METADATA_ONLY', 'FULL_TEXT'] as const;
export const RESEARCH_INGESTION_STAGES = [
  'RIGHTS_CHECK', 'FETCH_METADATA', 'FETCH_CONTENT', 'NORMALIZE',
  'SAFETY_SCAN', 'EXTRACT_CLAIMS', 'VALIDATE', 'COMMIT',
] as const;

export class CreateResearchIngestionJobDto {
  @IsIn([...RESEARCH_INGESTION_MODES])
  mode!: (typeof RESEARCH_INGESTION_MODES)[number];

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  idempotency_key!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  max_attempts?: number;
}

export class ResearchIngestionCheckpointDto {
  @IsInt()
  @Min(1)
  expected_version!: number;

  @IsIn([...RESEARCH_INGESTION_STAGES])
  stage!: (typeof RESEARCH_INGESTION_STAGES)[number];

  @IsInt()
  @Min(0)
  @Max(99)
  progress_percent!: number;

  @IsObject()
  checkpoint!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;
}

export class FailResearchIngestionJobDto {
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,99}$/)
  error_code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  error_message!: string;

  @IsBoolean()
  retryable!: boolean;

  @IsInt()
  @Min(1)
  expected_version!: number;
}

export class ResearchExtractedClaimDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  item_key!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(12000)
  claim_text!: string;

  @IsObject()
  source_locator!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  stored_excerpt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  methodology?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  dataset_description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  limitations?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  practical_implication?: string;

  @IsOptional()
  @IsIn(['A', 'B', 'C', 'D', 'UNASSESSED'])
  evidence_grade?: 'A' | 'B' | 'C' | 'D' | 'UNASSESSED';

  @IsOptional()
  @IsIn(['STRONG', 'MODERATE', 'LIMITED', 'CONFLICTING', 'UNASSESSED'])
  evidence_strength?: 'STRONG' | 'MODERATE' | 'LIMITED' | 'CONFLICTING' | 'UNASSESSED';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  topic_tags?: string[];
}

export class CompleteResearchExtractionDto {
  @IsInt()
  @Min(1)
  expected_version!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  extractor_name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  extractor_version!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  schema_version!: string;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/i)
  input_sha256!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i)
  prompt_sha256?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i)
  config_sha256?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  model_provider?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  model_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  model_version?: string;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ResearchExtractedClaimDto)
  claims!: ResearchExtractedClaimDto[];
}

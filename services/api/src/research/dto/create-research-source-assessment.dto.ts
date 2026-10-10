import {
  IsEnum,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export enum ResearchSourceAssessmentType {
  RIGHTS = 'RIGHTS',
  SECURITY = 'SECURITY',
}

export enum ResearchSourceAssessmentDecision {
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  REVIEW_REQUIRED = 'REVIEW_REQUIRED',
}

/**
 * Records an explicit human review against the exact registered content hash.
 * This DTO does not initiate a parser, fetch, or automated security scan.
 */
export class CreateResearchSourceAssessmentDto {
  @IsEnum(ResearchSourceAssessmentType)
  assessment_type!: ResearchSourceAssessmentType;

  @IsEnum(ResearchSourceAssessmentDecision)
  decision!: ResearchSourceAssessmentDecision;

  @IsString()
  @Matches(/^[a-fA-F0-9]{64}$/)
  content_sha256!: string;

  @IsString()
  @MaxLength(4000)
  assessment_basis!: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}

import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export enum ResearchSourceType {
  WEB = 'WEB',
  DOCUMENT = 'DOCUMENT',
  CONNECTOR = 'CONNECTOR',
  INTERNAL = 'INTERNAL',
}

export enum ResearchRightsStatus {
  VERIFIED = 'VERIFIED',
  UNKNOWN = 'UNKNOWN',
  RESTRICTED = 'RESTRICTED',
  REVOKED = 'REVOKED',
}

/**
 * Registers immutable source metadata; this DTO never downloads or parses
 * external content. New records are always marked NOT_ASSESSED/REGISTERED by
 * the service, regardless of any claims made in submitted metadata.
 */
export class CreateResearchSourceDto {
  @IsString()
  @MaxLength(200)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)
  source_key!: string;

  @IsString()
  @MaxLength(60)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/)
  source_version!: string;

  @IsEnum(ResearchSourceType)
  source_type!: ResearchSourceType;

  @IsString()
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  canonical_uri?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^[a-fA-F0-9]{64}$/)
  content_sha256?: string | null;

  @IsEnum(ResearchRightsStatus)
  rights_status!: ResearchRightsStatus;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  rights_basis?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  license_label?: string | null;

  @IsOptional()
  @IsBoolean()
  allow_research?: boolean;

  @IsOptional()
  @IsBoolean()
  allow_model_training?: boolean;

  @IsOptional()
  @IsBoolean()
  allow_redistribution?: boolean;
}

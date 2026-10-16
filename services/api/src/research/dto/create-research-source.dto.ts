import {
  IsArray, IsBoolean, IsDateString, IsIn, IsNotEmpty, IsObject, IsOptional,
  IsString, IsUrl, MaxLength,
} from 'class-validator';

export class CreateResearchSourceDto {
  @IsIn([
    'DOI_METADATA', 'OPEN_ACCESS_REPOSITORY', 'PUBLISHER_FEED',
    'INSTITUTIONAL_REPOSITORY', 'CUSTOMER_PROVIDED', 'STANDARD',
    'VENDOR_MATERIAL', 'SURVEY', 'PREPRINT', 'OPINION',
  ])
  source_type!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  title!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  authors?: string[];

  @IsOptional()
  @IsDateString()
  publication_date?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  doi?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  venue?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  abstract?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(4000)
  source_url?: string;

  @IsIn(['OPEN_ACCESS', 'LICENSED', 'USER_PROVIDED_AUTHORIZED', 'RESTRICTED', 'UNKNOWN'])
  license_status!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  rights_basis?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  license_reference?: string;

  @IsOptional()
  @IsBoolean()
  full_text_storage_allowed?: boolean;

  @IsOptional()
  @IsObject()
  source_metadata?: Record<string, unknown>;
}

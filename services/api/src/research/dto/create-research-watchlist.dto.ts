import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsNotEmpty,
  IsOptional, IsString, Matches, MaxLength,
} from 'class-validator';

const SOURCE_TYPES = [
  'DOI_METADATA', 'OPEN_ACCESS_REPOSITORY', 'PUBLISHER_FEED',
  'INSTITUTIONAL_REPOSITORY', 'CUSTOMER_PROVIDED', 'STANDARD',
  'VENDOR_MATERIAL', 'SURVEY', 'PREPRINT', 'OPINION',
] as const;

export class CreateResearchWatchlistDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,159}$/)
  watchlist_key!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  title!: string;

  @IsIn(['SECTOR', 'TECHNOLOGY', 'PROCESS', 'MARKET', 'SUSTAINABILITY', 'STRATEGIC_QUESTION'])
  topic_type!: 'SECTOR' | 'TECHNOLOGY' | 'PROCESS' | 'MARKET' | 'SUSTAINABILITY' | 'STRATEGIC_QUESTION';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(25)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(200, { each: true })
  topic_terms!: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(200, { each: true })
  inclusion_terms?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(200, { each: true })
  exclusion_terms?: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsIn(SOURCE_TYPES, { each: true })
  source_types!: string[];
}

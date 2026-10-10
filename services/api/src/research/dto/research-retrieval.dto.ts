import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { ResearchClaimType } from './create-research-claim.dto';
import { ResearchSourceType } from './create-research-source.dto';

export class ResearchRetrievalDto {
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  query!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  offset?: number;

  @IsOptional()
  @IsEnum(ResearchSourceType)
  source_type?: ResearchSourceType;

  @IsOptional()
  @IsEnum(ResearchClaimType)
  claim_type?: ResearchClaimType;
}

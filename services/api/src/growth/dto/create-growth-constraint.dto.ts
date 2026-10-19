import { Type } from 'class-transformer';
import {
  IsIn, IsISO8601, IsNotEmpty, IsNumber, IsOptional, IsString,
  IsUUID, MaxLength, MinLength,
} from 'class-validator';

export class CreateGrowthConstraintDto {
  @IsIn(['CAPACITY', 'QUALITY', 'CASH', 'DELIVERY', 'REGULATORY', 'CUSTOMER', 'TECHNICAL', 'WORKFORCE', 'OTHER'])
  dimension!: string;

  @IsIn(['APPLICABLE', 'NOT_APPLICABLE', 'UNKNOWN'])
  applicability!: 'APPLICABLE' | 'NOT_APPLICABLE' | 'UNKNOWN';

  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  constraint_name!: string;

  @IsOptional()
  @IsIn(['MAX', 'MIN', 'EQUALS'])
  limit_operator?: 'MAX' | 'MIN' | 'EQUALS';

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  threshold_value?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  observed_value?: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  unit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  source_evidence_ref?: string;

  @IsOptional()
  @IsISO8601()
  source_as_of?: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(2000)
  rationale!: string;

  @IsOptional()
  @IsUUID()
  owner_user_id?: string;
}

import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsNotEmpty, IsNumber, IsOptional,
  IsString, IsUUID, Max, MaxLength, Min, MinLength,
} from 'class-validator';

export class CreateGrowthAssumptionDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(4000)
  statement!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  rationale?: string;

  @IsIn(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
  risk_if_false!: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  confidence_pct!: number;

  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(2000)
  validation_method!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(1000, { each: true })
  evidence_refs?: string[];

  @IsOptional()
  @IsUUID()
  owner_user_id?: string;

  @IsOptional()
  @IsBoolean()
  blocks_decision?: boolean;
}

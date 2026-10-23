import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class FinanceWorkbenchQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  horizon_days = 30;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  unreconciled_limit = 50;
}

export class CreateFinanceClosePeriodDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  period_start!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  period_end!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @IsString()
  @Length(8, 1000)
  @Matches(/\S/)
  reason!: string;
}

export class FinanceCloseActionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  expected_version!: number;

  @IsString()
  @Length(8, 1000)
  @Matches(/\S/)
  reason!: string;
}

export class ListFinanceClosePeriodsDto {
  @IsOptional()
  @IsString()
  @IsIn(['DRAFT', 'SUBMITTED', 'APPROVED'])
  status?: 'DRAFT' | 'SUBMITTED' | 'APPROVED';

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

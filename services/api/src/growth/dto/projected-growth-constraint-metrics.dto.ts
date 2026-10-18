import {
  IsNumber, IsString, Matches, Max, MaxLength, Min,
} from 'class-validator';

export class ProjectedGrowthConstraintMetricsDto {
  @IsNumber()
  @Min(0)
  @Max(1000)
  capacity_utilization_pct!: number;

  @IsNumber()
  @Min(0)
  @Max(100)
  quality_yield_pct!: number;

  @IsNumber()
  @Min(-1000000000000)
  @Max(1000000000000)
  cash_after_investment!: number;

  @IsString()
  @Matches(/^[A-Za-z]{3}$/)
  @MaxLength(3)
  cash_currency!: string;

  @IsNumber()
  @Min(0)
  @Max(36500)
  delivery_backlog_days!: number;
}

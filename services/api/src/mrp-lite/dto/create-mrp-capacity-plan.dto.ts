import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Length,
  Matches, Max, Min, ValidateNested,
} from 'class-validator';

export class MrpCapacityAdjustmentDto {
  @IsUUID()
  work_centre_id!: string;

  @IsUUID()
  shift_template_id!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  capacity_date!: string;

  @IsString()
  @Length(1, 100)
  line_code!: string;

  @IsInt()
  @Min(-1440)
  @Max(1440)
  delta_available_minutes!: number;

  @IsInt()
  @Min(-99)
  @Max(99)
  delta_parallel_lines!: number;
}

export class CreateMrpCapacityPlanDto {
  @IsString()
  @Length(3, 120)
  scenario_name!: string;

  @IsInt()
  @Min(0)
  @Max(365)
  frozen_horizon_days!: number;

  @IsOptional()
  @IsUUID()
  compare_to_capacity_plan_id?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => MrpCapacityAdjustmentDto)
  capacity_adjustments?: MrpCapacityAdjustmentDto[];
}

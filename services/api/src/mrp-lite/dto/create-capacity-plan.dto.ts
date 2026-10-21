import { IsDateString, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class CreateCapacityPlanDto {
  @IsUUID()
  source_mrp_plan_id!: string;

  @IsString() @MaxLength(120) @Matches(/^\S(?:.*\S)?$/)
  scenario_name!: string;

  @IsDateString({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/)
  horizon_start!: string;

  @IsDateString({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/)
  horizon_end!: string;

  @IsDateString({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/)
  frozen_horizon_start!: string;

  @IsDateString({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/)
  frozen_horizon_end!: string;

  @IsOptional() @IsUUID()
  compare_to_plan_id?: string;
}

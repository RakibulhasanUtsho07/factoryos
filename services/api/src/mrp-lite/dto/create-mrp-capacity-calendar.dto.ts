import { IsInt, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';

export class CreateMrpCapacityCalendarDto {
  @IsUUID()
  work_centre_id!: string;

  @IsUUID()
  shift_template_id!: string;

  @IsString()
  @Matches(/^\\d{4}-\\d{2}-\\d{2}$/)
  capacity_date!: string;

  @IsString()
  @Length(1, 100)
  line_code!: string;

  @IsInt()
  @Min(0)
  @Max(1440)
  available_minutes!: number;

  @IsInt()
  @Min(1)
  @Max(100)
  parallel_lines!: number;
}

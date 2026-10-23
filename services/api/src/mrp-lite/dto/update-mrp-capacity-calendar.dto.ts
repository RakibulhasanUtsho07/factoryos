import { IsIn, IsInt, IsOptional, Min, Max } from 'class-validator';

export class UpdateMrpCapacityCalendarDto {
  @IsInt()
  @Min(1)
  expected_version!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  available_minutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  parallel_lines?: number;

  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE';
}

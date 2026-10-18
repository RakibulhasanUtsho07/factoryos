import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class WorkOrderTransitionDto {
  @IsInt()
  @Min(1)
  expected_version!: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

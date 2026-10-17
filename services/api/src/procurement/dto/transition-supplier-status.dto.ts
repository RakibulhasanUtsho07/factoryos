import { IsIn, IsInt, IsOptional, Min } from 'class-validator';

export class TransitionSupplierStatusDto {
  @IsIn(['ACTIVE', 'DISABLED'])
  target_status!: 'ACTIVE' | 'DISABLED';

  @IsOptional() @IsInt() @Min(1)
  expected_version?: number;
}

import { IsIn, IsInt, Min } from 'class-validator';

export class TransitionSupplierStatusDto {
  @IsIn(['ACTIVE', 'DISABLED'])
  target_status!: 'ACTIVE' | 'DISABLED';

  @IsInt() @Min(1)
  expected_version!: number;
}

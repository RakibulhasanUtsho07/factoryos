import { IsBoolean, IsIn, IsInt, IsOptional, Min } from 'class-validator';

export class UpdateInventoryAllocationPolicyDto {
  @IsIn(['FIFO', 'FEFO', 'LOT', 'SERIAL'])
  allocation_policy!: 'FIFO' | 'FEFO' | 'LOT' | 'SERIAL';

  @IsOptional()
  @IsBoolean()
  require_traceability?: boolean;

  /** Zero creates a policy row; a positive value must match its current version. */
  @IsInt()
  @Min(0)
  expected_version!: number;
}

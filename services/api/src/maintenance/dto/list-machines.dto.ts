import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

import {
  MAINTENANCE_MACHINE_STATUSES,
  type MaintenanceMachineStatus,
} from './create-machine.dto';

export class ListMachinesDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @IsOptional()
  @IsIn([...MAINTENANCE_MACHINE_STATUSES])
  status?: MaintenanceMachineStatus;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

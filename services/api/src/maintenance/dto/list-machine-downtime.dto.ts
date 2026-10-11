import {
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export const MACHINE_DOWNTIME_STATES = [
  'OPEN',
  'CLOSED',
] as const;

export type MachineDowntimeState =
  (typeof MACHINE_DOWNTIME_STATES)[number];

export class ListMachineDowntimeDto {
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
  @IsUUID()
  machine_id?: string;

  @IsOptional()
  @IsIn([...MACHINE_DOWNTIME_STATES])
  state?: MachineDowntimeState;
}

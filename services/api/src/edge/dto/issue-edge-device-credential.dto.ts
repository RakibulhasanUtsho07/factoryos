import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class IssueEdgeDeviceCredentialDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(366)
  valid_for_days?: number;
}

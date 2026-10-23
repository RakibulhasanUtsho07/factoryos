import { Type } from 'class-transformer';
import { IsInt, IsString, Max, MaxLength, Min } from 'class-validator';

export class AcknowledgeOperationalNotificationDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(2147483647) expected_version!: number;
  @IsString() @MaxLength(2000) reason!: string;
}

import { Type } from 'class-transformer';
import { IsIn, IsInt, IsString, Max, MaxLength, Min } from 'class-validator';

export const OPERATIONAL_NOTIFICATION_STATUSES = ['UNREAD','ACKNOWLEDGED'] as const;
export class AcknowledgeOperationalNotificationDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(2147483647) expected_version!: number;
  @IsString() @MaxLength(2000) reason!: string;
}

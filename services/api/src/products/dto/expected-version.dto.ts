import { IsInt, Min } from 'class-validator';
export class ExpectedVersionDto {
  @IsInt() @Min(1) expected_version!: number;
}

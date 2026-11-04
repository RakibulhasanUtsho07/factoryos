import { SetMetadata } from '@nestjs/common';

export const SKIP_API_RESPONSE_KEY = 'skipApiResponse';
export const SkipApiResponse = () => SetMetadata(SKIP_API_RESPONSE_KEY, true);
